import type { BindingLookupDiagnostic, BindingManager } from '../bindings/bindingManager';
import {
  resolveInfobaseCanonicalIdentity,
  type FileInfobaseCanonicalIdentity,
  type InfobaseCanonicalIdentity,
} from '../infobases/infobaseCanonicalIdentity';
import type { InfobaseStorageService } from '../infobases/infobaseStorageService';
import type { InfobaseEntry } from '../infobases/models/infobaseEntry';

export interface ReadySupportTarget {
  readonly canonicalTargetId: string;
  readonly infobaseIds: readonly string[];
  readonly state: 'ready';
  readonly entry: InfobaseEntry;
  readonly identity: FileInfobaseCanonicalIdentity;
}

export interface UnsupportedSupportTarget {
  readonly canonicalTargetId: string;
  readonly infobaseIds: readonly string[];
  readonly state: 'targetUnsupported';
  readonly errorCode: string;
}

export type SupportBindingPreflightResult =
  | { readonly accepted: true; readonly scope: 'masterOnly'; readonly targets: readonly [] }
  | {
      readonly accepted: true;
      readonly scope: 'replicated';
      readonly targets: readonly [ReadySupportTarget, ...ReadySupportTarget[]];
    }
  | {
      readonly accepted: false;
      readonly reason: 'bindingInvalid';
      readonly errorCode: 'SUPPORT_BINDING_INVALID';
      readonly diagnostics: readonly string[];
    }
  | {
      readonly accepted: false;
      readonly reason: 'targetUnsupported';
      readonly errorCode: 'SUPPORT_TARGET_UNSUPPORTED';
      readonly readyTargets: readonly ReadySupportTarget[];
      readonly unsupportedTargets: readonly [UnsupportedSupportTarget, ...UnsupportedSupportTarget[]];
    };

export interface SupportBindingSelector {
  readonly workspaceFolderName: string;
  readonly configRelativePath: string;
  readonly ibcmdExtensionName?: string;
}

export interface SupportBindingResolverDeps {
  readonly bindingManager: Pick<BindingManager, 'getDiagnostic'>;
  readonly infobaseStorage: Pick<InfobaseStorageService, 'load'>;
  readonly resolveCanonicalIdentity?: (entry: InfobaseEntry) => Promise<InfobaseCanonicalIdentity>;
}

interface MutableReadyTarget {
  readonly canonicalTargetId: string;
  readonly infobaseIds: string[];
  readonly state: 'ready';
  readonly entry: InfobaseEntry;
  readonly identity: FileInfobaseCanonicalIdentity;
}

function bindingInvalid(diagnostics: readonly string[]): SupportBindingPreflightResult {
  return {
    accepted: false,
    reason: 'bindingInvalid',
    errorCode: 'SUPPORT_BINDING_INVALID',
    diagnostics,
  };
}

function bindingReadFailure(read: Extract<BindingLookupDiagnostic, { kind: 'invalid' }>): SupportBindingPreflightResult {
  return bindingInvalid(read.diagnostics);
}

/** Resolves the complete support replica set. `massDeployment` is intentionally irrelevant here. */
export class SupportBindingResolver {
  private readonly resolveIdentity: (entry: InfobaseEntry) => Promise<InfobaseCanonicalIdentity>;

  constructor(private readonly deps: SupportBindingResolverDeps) {
    this.resolveIdentity = deps.resolveCanonicalIdentity ?? resolveInfobaseCanonicalIdentity;
  }

  async resolve(selector: SupportBindingSelector): Promise<SupportBindingPreflightResult> {
    const read = await this.deps.bindingManager.getDiagnostic(
      selector.workspaceFolderName,
      selector.configRelativePath,
      selector.ibcmdExtensionName,
    );
    if (read.kind === 'absent') {
      return { accepted: true, scope: 'masterOnly', targets: [] };
    }
    if (read.kind === 'invalid') {
      return bindingReadFailure(read);
    }
    if (read.binding.infobaseIds.length === 0) {
      return bindingInvalid(['Для заданной привязки не выбрана ни одна информационная база.']);
    }

    const catalog = await this.deps.infobaseStorage.load();
    const byId = new Map(catalog.map((entry) => [entry.id, entry] as const));
    const missingIds = read.binding.infobaseIds.filter((id) => !byId.has(id));
    if (missingIds.length > 0) {
      return bindingInvalid(
        missingIds.map((id) => `Информационная база из привязки не найдена в каталоге: ${id}.`),
      );
    }

    const readyByIdentity = new Map<string, MutableReadyTarget>();
    const unsupportedByIdentity = new Map<string, UnsupportedSupportTarget>();
    for (const infobaseId of read.binding.infobaseIds) {
      const entry = byId.get(infobaseId)!;
      const identity = await this.resolveIdentity(entry);
      if (
        identity.kind !== 'file'
        || identity.connectionKind !== 'databasePath'
        || !identity.exists
      ) {
        const errorCode = identity.kind === 'file'
          ? 'SUPPORT_FILE_TARGET_UNAVAILABLE'
          : 'SUPPORT_TARGET_TYPE_UNSUPPORTED';
        const existing = unsupportedByIdentity.get(identity.canonicalTargetId);
        const aliases = existing ? [...existing.infobaseIds] : [];
        if (!aliases.includes(infobaseId)) {
          aliases.push(infobaseId);
        }
        unsupportedByIdentity.set(identity.canonicalTargetId, {
          canonicalTargetId: identity.canonicalTargetId,
          infobaseIds: aliases,
          state: 'targetUnsupported',
          errorCode,
        });
        continue;
      }

      const existing = readyByIdentity.get(identity.canonicalTargetId);
      if (existing) {
        if (!existing.infobaseIds.includes(infobaseId)) {
          existing.infobaseIds.push(infobaseId);
        }
        continue;
      }
      readyByIdentity.set(identity.canonicalTargetId, {
        canonicalTargetId: identity.canonicalTargetId,
        infobaseIds: [infobaseId],
        state: 'ready',
        entry,
        identity,
      });
    }

    const readyTargets = [...readyByIdentity.values()];
    const unsupportedTargets = [...unsupportedByIdentity.values()];
    if (unsupportedTargets.length > 0) {
      return {
        accepted: false,
        reason: 'targetUnsupported',
        errorCode: 'SUPPORT_TARGET_UNSUPPORTED',
        readyTargets,
        unsupportedTargets: unsupportedTargets as [UnsupportedSupportTarget, ...UnsupportedSupportTarget[]],
      };
    }
    const firstReadyTarget = readyTargets[0];
    if (!firstReadyTarget) {
      return bindingInvalid(['Привязка не содержит разрешимой целевой информационной базы.']);
    }
    return {
      accepted: true,
      scope: 'replicated',
      targets: [firstReadyTarget, ...readyTargets.slice(1)],
    };
  }

  preflight(selector: SupportBindingSelector): Promise<SupportBindingPreflightResult> {
    return this.resolve(selector);
  }
}
