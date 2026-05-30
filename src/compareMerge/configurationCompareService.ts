import * as fs from 'fs/promises';
import * as path from 'path';

import {
  buildBslModuleIndex,
  type BslModuleIndexEntry,
  type BslModuleDiagnostic,
} from './bsl/bslModuleIndexer';
import { diffBslModules } from './bsl/bslRoutineDiff';
import { CompareSession } from './domain/compareSession';
import type { CompareMessage } from './domain/compareContracts';
import { indexMetadataFolder } from './metadata/metadataIndexer';
import { matchMetadataIdentities } from './metadata/metadataMatcher';
import {
  buildCompareTreeProjection,
  type CompareTreeProjection,
  type BslRoutineDiffProjectionInput,
} from './projection/compareTreeProjection';

const LEFT_SOURCE_ID = 'left-source';
const RIGHT_SOURCE_ID = 'right-source';

export interface ConfigurationCompareInput {
  leftRootPath: string;
  rightRootPath: string;
  createdAt?: Date;
}

export interface ConfigurationCompareResult {
  session: CompareSession;
  projection: CompareTreeProjection;
}

export async function buildConfigurationCompare(
  input: ConfigurationCompareInput
): Promise<ConfigurationCompareResult> {
  const leftRootPath = path.normalize(input.leftRootPath);
  const rightRootPath = path.normalize(input.rightRootPath);
  const createdAt = input.createdAt ?? new Date();
  const session = CompareSession.create({
    sessionId: `configuration-compare-${createdAt.getTime()}`,
    createdAt: createdAt.toISOString(),
    sources: [
      {
        sourceId: LEFT_SOURCE_ID,
        side: 'left',
        kind: 'workspace',
        displayName: path.basename(leftRootPath) || leftRootPath,
        rootUri: leftRootPath,
        targetWorkspaceRoot: leftRootPath,
        writable: true,
      },
      {
        sourceId: RIGHT_SOURCE_ID,
        side: 'right',
        kind: 'file',
        displayName: path.basename(rightRootPath) || rightRootPath,
        rootUri: rightRootPath,
        writable: false,
      },
    ],
  });

  const [leftMetadata, rightMetadata, leftBslFiles, rightBslFiles] = await Promise.all([
    indexMetadataFolder({
      sourceId: LEFT_SOURCE_ID,
      side: 'left',
      folderPath: leftRootPath,
    }),
    indexMetadataFolder({
      sourceId: RIGHT_SOURCE_ID,
      side: 'right',
      folderPath: rightRootPath,
    }),
    collectBslFiles(leftRootPath),
    collectBslFiles(rightRootPath),
  ]);

  const metadata = matchMetadataIdentities({
    left: leftMetadata,
    right: rightMetadata,
  });
  const [leftBsl, rightBsl] = await Promise.all([
    buildBslModuleIndex(
      leftBslFiles.map((filePath) => ({
        sourceId: LEFT_SOURCE_ID,
        side: 'left' as const,
        filePath,
        configRoots: [leftRootPath],
      }))
    ),
    buildBslModuleIndex(
      rightBslFiles.map((filePath) => ({
        sourceId: RIGHT_SOURCE_ID,
        side: 'right' as const,
        filePath,
        configRoots: [rightRootPath],
      }))
    ),
  ]);

  const bsl = buildBslProjectionInputs(leftBsl.modules, rightBsl.modules, session);
  const projection = buildCompareTreeProjection({
    metadata,
    bsl: [
      ...bsl.items,
      { diagnostics: leftBsl.diagnostics.filter((diagnostic) => !bsl.matchedDiagnostics.has(diagnostic)) },
      { diagnostics: rightBsl.diagnostics.filter((diagnostic) => !bsl.matchedDiagnostics.has(diagnostic)) },
    ],
    messages: session.state.messages,
  });

  return { session, projection };
}

async function collectBslFiles(rootPath: string): Promise<string[]> {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectBslFiles(entryPath)));
    } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.bsl') {
      files.push(entryPath);
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

function buildBslProjectionInputs(
  leftModules: readonly BslModuleIndexEntry[],
  rightModules: readonly BslModuleIndexEntry[],
  session: CompareSession
): {
  items: BslRoutineDiffProjectionInput[];
  matchedDiagnostics: Set<BslModuleDiagnostic>;
} {
  const leftByModuleId = groupModulesById(leftModules);
  const rightByModuleId = groupModulesById(rightModules);
  const moduleIds = new Set([...leftByModuleId.keys(), ...rightByModuleId.keys()]);
  const projections: BslRoutineDiffProjectionInput[] = [];
  const matchedDiagnostics = new Set<BslModuleDiagnostic>();

  for (const moduleId of [...moduleIds].sort()) {
    const leftMatches = leftByModuleId.get(moduleId) ?? [];
    const rightMatches = rightByModuleId.get(moduleId) ?? [];

    if (leftMatches.length === 1 && rightMatches.length === 1) {
      const left = leftMatches[0];
      const right = rightMatches[0];
      projections.push({
        diff: diffBslModules({ left, right }),
        targetFilePath: left.identity.filePath,
      });
      left.diagnostics.forEach((diagnostic) => matchedDiagnostics.add(diagnostic));
      right.diagnostics.forEach((diagnostic) => matchedDiagnostics.add(diagnostic));
      continue;
    }

    addUnmatchedBslMessage(session, moduleId, leftMatches, rightMatches);
  }

  return { items: projections, matchedDiagnostics };
}

function groupModulesById(
  modules: readonly BslModuleIndexEntry[]
): Map<string, BslModuleIndexEntry[]> {
  const grouped = new Map<string, BslModuleIndexEntry[]>();
  for (const module of modules) {
    const items = grouped.get(module.identity.moduleId);
    if (items) {
      items.push(module);
    } else {
      grouped.set(module.identity.moduleId, [module]);
    }
  }

  return grouped;
}

function addUnmatchedBslMessage(
  session: CompareSession,
  moduleId: string,
  leftMatches: readonly BslModuleIndexEntry[],
  rightMatches: readonly BslModuleIndexEntry[]
): void {
  const message = createUnmatchedBslMessage(moduleId, leftMatches, rightMatches);
  session.addMessage(message);
}

function createUnmatchedBslMessage(
  moduleId: string,
  leftMatches: readonly BslModuleIndexEntry[],
  rightMatches: readonly BslModuleIndexEntry[]
): CompareMessage {
  const side = leftMatches.length > 0 ? 'left' : 'right';
  const sourceId = side === 'left' ? LEFT_SOURCE_ID : RIGHT_SOURCE_ID;
  const pathSource = leftMatches[0] ?? rightMatches[0];
  const code =
    leftMatches.length === 0
      ? 'BSL_MODULE_RIGHT_ONLY'
      : rightMatches.length === 0
        ? 'BSL_MODULE_LEFT_ONLY'
        : 'BSL_MODULE_AMBIGUOUS';
  const suggestedAction =
    code === 'BSL_MODULE_AMBIGUOUS'
      ? `BSL module ${moduleId} has ambiguous matches.`
      : `BSL module ${moduleId} has no matching module on the other side.`;

  return {
    severity: code === 'BSL_MODULE_AMBIGUOUS' ? 'error' : 'warning',
    code,
    phase: 'compare',
    sourceId,
    nodeId: moduleId,
    path: pathSource?.identity.filePath,
    blocking: code === 'BSL_MODULE_AMBIGUOUS',
    suggestedAction,
  };
}
