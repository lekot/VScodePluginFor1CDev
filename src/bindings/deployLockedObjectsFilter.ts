import type { ConfigurationId } from '../services/configurationSession/types';
import type { LockedObjectRef } from '../services/ibcmd/ibcmdLockedObjectsParser';
import type { SupportApplicationFacade } from '../support/supportApplicationServiceRegistry';
import type {
  MasterSupportSnapshot,
  MetadataUniverseEntry,
  SupportStatusResult,
} from '../support/supportTypes';
import { MetadataTypeMapper } from '../utils/metadataTypeMapper';

export const SUPPORT_MASTER_DEPLOY_PATH = 'Ext/ParentConfigurations.bin';

export type DeploySupportPreflightErrorCode =
  | 'SUPPORT_FILE_INVALID'
  | 'SUPPORT_FORMAT_UNSUPPORTED'
  | 'SUPPORT_MASTER_RECOVERY_REQUIRED'
  | 'SUPPORT_OBJECT_UNIVERSE_INCOMPLETE'
  | 'SUPPORT_MANAGED_FULL_DEPLOY_UNSAFE'
  | 'SUPPORT_OPERATION_FAILED';

export interface DeploySupportPlannerRequest {
  readonly configurationId: ConfigurationId;
  readonly mode: 'full' | 'files';
  readonly relativeFiles: readonly string[];
}

interface DeploySupportFilesPlan {
  readonly relativeFiles: readonly string[];
  readonly skippedLockedFiles: readonly string[];
  /** The support property is never sent to `ibcmd config import files`. */
  readonly supportFileRouted: boolean;
}

export type DeploySupportPreflight =
  | DeploySupportFilesPlan & {
      readonly kind: 'ready';
      readonly generationId: string;
      readonly status: SupportStatusResult;
      readonly lockedSupportSubjectIds: readonly string[];
    }
  | DeploySupportFilesPlan & {
      readonly kind: 'unmanaged';
      readonly reason: 'missing' | 'empty';
      readonly status: SupportStatusResult;
    }
  | {
      readonly kind: 'unknown';
      readonly errorCode: DeploySupportPreflightErrorCode;
      readonly diagnostics: readonly string[];
    }
  | {
      readonly kind: 'fullDeployUnsafe';
      readonly errorCode: 'SUPPORT_MANAGED_FULL_DEPLOY_UNSAFE';
      readonly diagnostics: readonly string[];
      readonly generationId: string;
    };

/**
 * Shared proactive deploy planner for UI and Agent paths.
 *
 * This is deliberately a facade-only consumer: deploy never reads or parses
 * `ParentConfigurations.bin` directly.
 */
export class DeployLockedObjectsPlanner {
  constructor(private readonly facade: Pick<SupportApplicationFacade, 'getStatus'>) {}

  async plan(request: DeploySupportPlannerRequest): Promise<DeploySupportPreflight> {
    let outcome;
    try {
      outcome = await this.facade.getStatus({
        configurationId: request.configurationId,
      });
    } catch {
      return operationFailed('Support status facade failed before deploy.');
    }
    if (outcome.status !== 'available') {
      return operationFailed(`Support status is unavailable: ${outcome.errorCode}.`);
    }

    const routed = extractSupportMasterFile(request.relativeFiles);
    const master = outcome.master;
    if (master.kind === 'unknown') {
      return {
        kind: 'unknown',
        errorCode: master.errorCode,
        diagnostics: [...master.diagnostics],
      };
    }
    if (master.kind === 'unmanaged') {
      return {
        kind: 'unmanaged',
        reason: master.reason,
        status: outcome,
        relativeFiles: routed.relativeFiles,
        skippedLockedFiles: [],
        supportFileRouted: routed.supportFileRouted,
      };
    }
    if (request.mode === 'full') {
      return {
        kind: 'fullDeployUnsafe',
        errorCode: 'SUPPORT_MANAGED_FULL_DEPLOY_UNSAFE',
        diagnostics: [
          'Full-directory deploy is unsafe for a managed configuration; use file deploy with support routing.',
        ],
        generationId: master.snapshot.generationId,
      };
    }
    const metadataUniverse = outcome.metadataUniverse;
    if (!metadataUniverse) {
      return operationFailed('Metadata universe is unavailable for managed support deploy.');
    }

    const filtered = filterFilesByMasterLocks(
      routed.relativeFiles,
      master.snapshot,
      metadataUniverse.entries,
    );
    if (filtered.mappingDiagnostics.length > 0) {
      return {
        kind: 'unknown',
        errorCode: 'SUPPORT_OBJECT_UNIVERSE_INCOMPLETE',
        diagnostics: filtered.mappingDiagnostics,
      };
    }
    return {
      kind: 'ready',
      generationId: master.snapshot.generationId,
      status: outcome,
      relativeFiles: filtered.kept,
      skippedLockedFiles: filtered.filtered,
      supportFileRouted: routed.supportFileRouted,
      lockedSupportSubjectIds: filtered.lockedSupportSubjectIds,
    };
  }
}

export interface LockedObjectsFilterResult {
  readonly kept: string[];
  readonly filtered: string[];
}

export interface MasterLockedObjectsFilterResult extends LockedObjectsFilterResult {
  readonly lockedSupportSubjectIds: string[];
  readonly mappingDiagnostics: string[];
}

/**
 * Proactive file filtering from the immutable master snapshot and its exact
 * metadata-universe mapping.
 */
export function filterFilesByMasterLocks(
  relativeFiles: readonly string[],
  snapshot: MasterSupportSnapshot,
  universe: readonly MetadataUniverseEntry[],
): MasterLockedObjectsFilterResult {
  const lockedSupportSubjectIds = new Set(
    [...snapshot.objectModes.values()]
      .filter((state) => state.locked)
      .map((state) => state.objectId.toLocaleLowerCase()),
  );
  if (lockedSupportSubjectIds.size === 0) {
    return {
      kept: [...relativeFiles],
      filtered: [],
      lockedSupportSubjectIds: [],
      mappingDiagnostics: [],
    };
  }

  const mappedSubjectIds = new Set<string>();
  const mappingDiagnostics: string[] = [];
  const lockedPaths = new Map<string, LockedMetadataPath>();
  for (const entry of universe) {
    const subjectId = entry.supportSubjectUuid.toLocaleLowerCase();
    if (!lockedSupportSubjectIds.has(subjectId)) {
      continue;
    }
    mappedSubjectIds.add(subjectId);
    const parsed = parseUniverseMetadataPath(entry.relativeMetadataPath);
    if (!parsed) {
      mappingDiagnostics.push(
        `Locked support subject ${entry.supportSubjectUuid} has invalid metadata path: ${entry.relativeMetadataPath}.`,
      );
      continue;
    }
    const key = `${parsed.physicalPath}\0${parsed.includesOwnedSubtree ? 'owner' : 'fragment'}`;
    lockedPaths.set(key, parsed);
  }
  for (const subjectId of lockedSupportSubjectIds) {
    if (!mappedSubjectIds.has(subjectId)) {
      mappingDiagnostics.push(`Locked support subject ${subjectId} is absent from metadata universe.`);
    }
  }
  if (mappingDiagnostics.length > 0) {
    return {
      kept: [],
      filtered: [],
      lockedSupportSubjectIds: [...lockedSupportSubjectIds].sort(),
      mappingDiagnostics,
    };
  }

  const kept: string[] = [];
  const filtered: string[] = [];
  for (const file of relativeFiles) {
    const normalizedFile = normalizeRelativePath(file);
    if ([...lockedPaths.values()].some((lockedPath) =>
      lockedPath.includesOwnedSubtree
        ? belongsToMetadataPath(normalizedFile, lockedPath.physicalPath)
        : normalizedFile === lockedPath.physicalPath)) {
      filtered.push(file);
    } else {
      kept.push(file);
    }
  }
  return {
    kept,
    filtered,
    lockedSupportSubjectIds: [...lockedSupportSubjectIds].sort(),
    mappingDiagnostics: [],
  };
}

export function extractSupportMasterFile(relativeFiles: readonly string[]): {
  readonly relativeFiles: string[];
  readonly supportFileRouted: boolean;
} {
  const supportPath = normalizeRelativePath(SUPPORT_MASTER_DEPLOY_PATH);
  const kept = relativeFiles.filter((file) => normalizeRelativePath(file) !== supportPath);
  return {
    relativeFiles: kept,
    supportFileRouted: kept.length !== relativeFiles.length,
  };
}

/**
 * Reactive stderr-based filtering retained only as a drift fallback after a
 * proactive facade preflight.
 */
export function filterOutLockedObjectFiles(
  relativeFiles: readonly string[],
  locked: readonly LockedObjectRef[],
): LockedObjectsFilterResult {
  if (locked.length === 0) {
    return { kept: [...relativeFiles], filtered: [] };
  }

  const prefixes = locked
    .map(folderPrefixForLocked)
    .filter((prefix): prefix is string => prefix !== null)
    .map(normalizeRelativePath);
  const kept: string[] = [];
  const filtered: string[] = [];

  for (const file of relativeFiles) {
    const normalizedFile = normalizeRelativePath(file);
    const isLocked = prefixes.some((prefix) =>
      normalizedFile === `${prefix}.xml` || normalizedFile.startsWith(`${prefix}/`));
    (isLocked ? filtered : kept).push(file);
  }

  return { kept, filtered };
}

function extractMetadataStem(metadataPath: string): string {
  return metadataPath.toLocaleLowerCase().endsWith('.xml')
    ? metadataPath.slice(0, -4)
    : metadataPath;
}

function belongsToMetadataPath(relativeFile: string, metadataPath: string): boolean {
  if (relativeFile === metadataPath) {
    return true;
  }
  const stem = extractMetadataStem(metadataPath);
  return relativeFile.startsWith(`${stem}/`);
}

interface LockedMetadataPath {
  readonly physicalPath: string;
  readonly includesOwnedSubtree: boolean;
}

function parseUniverseMetadataPath(relativeMetadataPath: string): LockedMetadataPath | undefined {
  const value = relativeMetadataPath.trim().replace(/\\/g, '/');
  const fragmentIndex = value.indexOf('#');
  const hasFragment = fragmentIndex >= 0;
  if (
    !value
    || value.startsWith('/')
    || /^[a-z]:/i.test(value)
    || (hasFragment && (
      fragmentIndex === value.length - 1
      || value.indexOf('#', fragmentIndex + 1) >= 0
    ))
  ) {
    return undefined;
  }
  const physicalPath = hasFragment ? value.slice(0, fragmentIndex) : value;
  const segments = physicalPath.split('/');
  if (
    segments.some((segment) => !segment || segment === '.' || segment === '..')
    || !physicalPath.toLocaleLowerCase().endsWith('.xml')
  ) {
    return undefined;
  }
  return {
    physicalPath: normalizeRelativePath(physicalPath),
    includesOwnedSubtree: !hasFragment,
  };
}

function normalizeRelativePath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+/g, '/')
    .toLocaleLowerCase();
}

function folderPrefixForLocked(locked: LockedObjectRef): string | null {
  if (!locked.kind) {
    return null;
  }
  const metaType = MetadataTypeMapper.map(locked.kind);
  const folder = MetadataTypeMapper.getDesignerFolderIdForMetadataType(metaType)
    ?? `${locked.kind}s`;
  return `${folder}/${locked.name}`;
}

function operationFailed(diagnostic: string): DeploySupportPreflight {
  return {
    kind: 'unknown',
    errorCode: 'SUPPORT_OPERATION_FAILED',
    diagnostics: [diagnostic],
  };
}
