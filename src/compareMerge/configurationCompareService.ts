import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import { pathToFileURL } from 'url';

import {
  buildBslModuleIndex,
  indexBslModuleSource,
  type BslModuleIndexEntry,
  type BslModuleDiagnostic,
} from './bsl/bslModuleIndexer';
import { createBslRoutineLogicalMergePlan } from './bsl/bslRoutineLogicalMerge';
import { hashText, scanBslRoutineLogicalOutline, splitSourceLines } from './bsl/bslRoutineLogicalScanner';
import { diffBslModules, type BslRoutineDiffItem } from './bsl/bslRoutineDiff';
import type {
  BslRoutineLogicalAnchor,
  BslRoutineLogicalMergePlan,
  BslRoutineLogicalSnapshot,
} from './bsl/bslRoutineMergePlanTypes';
import type { BslRoutineInfo, BslTextRange } from '../bsl/bslRoutineTypes';
import {
  ConfigurationCompareWorkspace,
  type ConfigurationCompareWorkspaceState,
  type ExecutableCandidateFactory,
} from './configurationCompareWorkspace';
import { metadataXmlAdapter } from './adapters/xmlMetadataAdapter';
import { formXmlAdapter } from './adapters/formXmlAdapter';
import { predefinedXmlAdapter } from './adapters/predefinedXmlAdapter';
import { fileObjectAdapter } from './adapters/fileObjectAdapter';
import type {
  AdapterCompareInput,
  AdapterCompareResult,
  ArtifactKind,
  CompareJoinStrategy,
  MetadataObjectMatch,
} from './adapters/mergeAdapter';
import { CompareSession } from './domain/compareSession';
import type { CompareMessage } from './domain/compareContracts';
import { buildConfigurationInventory } from './inventory/configurationInventory';
import type { ArtifactUnit, ConfigurationInventory, MetadataObjectUnit } from './inventory/configurationInventory';
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
  backupRootPath: string;
  createdAt?: Date;
}

export interface ConfigurationCompareResult {
  session: CompareSession;
  projection: CompareTreeProjection;
  workspace: ConfigurationCompareWorkspace;
}

export async function buildConfigurationCompare(
  input: ConfigurationCompareInput
): Promise<ConfigurationCompareResult> {
  const state = await buildConfigurationCompareState(input);
  const workspace = new ConfigurationCompareWorkspace({
    ...state,
    leftRootPath: path.normalize(input.leftRootPath),
    rightRootPath: path.normalize(input.rightRootPath),
    createdAt: input.createdAt,
    backupRootPath: input.backupRootPath,
    refreshWorkspace: (strategy) => buildConfigurationCompareState(input, strategy),
  });

  return {
    session: state.session,
    projection: state.projection,
    workspace,
  };
}

async function buildConfigurationCompareState(
  input: ConfigurationCompareInput,
  strategy: CompareJoinStrategy = 'right'
): Promise<ConfigurationCompareWorkspaceState> {
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
        rootUri: pathToFileURL(leftRootPath).toString(),
        targetWorkspaceRoot: leftRootPath,
        writable: true,
      },
      {
        sourceId: RIGHT_SOURCE_ID,
        side: 'right',
        kind: 'file',
        displayName: path.basename(rightRootPath) || rightRootPath,
        rootUri: pathToFileURL(rightRootPath).toString(),
        writable: false,
      },
    ],
  });

  const [
    leftMetadata,
    rightMetadata,
    leftInventory,
    rightInventory,
    leftBslFiles,
    rightBslFiles,
  ] = await Promise.all([
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
    buildConfigurationInventory(leftRootPath),
    buildConfigurationInventory(rightRootPath),
    collectBslFileSources(leftRootPath),
    collectBslFileSources(rightRootPath),
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
        filePath: filePath.filePath,
        configRoots: [leftRootPath],
        source: filePath.source,
      }))
    ),
    buildBslModuleIndex(
      rightBslFiles.map((filePath) => ({
        sourceId: RIGHT_SOURCE_ID,
        side: 'right' as const,
        filePath: filePath.filePath,
        configRoots: [rightRootPath],
        source: filePath.source,
      }))
    ),
  ]);

  const leftSnapshotId = `configuration-compare-${createdAt.getTime()}-left`;
  const rightSnapshotId = `configuration-compare-${createdAt.getTime()}-right`;
  session.registerSnapshot({
    snapshotId: leftSnapshotId,
    sourceId: LEFT_SOURCE_ID,
    snapshotRoot: pathToFileURL(leftRootPath).toString(),
    origin: pathToFileURL(leftRootPath).toString(),
    createdAt: createdAt.toISOString(),
    retentionUntil: createdAt.toISOString(),
    sourceRevision: `files:${hashFileSources(leftBslFiles)}`,
    readOnly: false,
    cleanupPolicy: 'manual',
    contentHash: hashFileSources(leftBslFiles),
  });
  session.registerSnapshot({
    snapshotId: rightSnapshotId,
    sourceId: RIGHT_SOURCE_ID,
    snapshotRoot: pathToFileURL(rightRootPath).toString(),
    origin: pathToFileURL(rightRootPath).toString(),
    createdAt: createdAt.toISOString(),
    retentionUntil: createdAt.toISOString(),
    sourceRevision: `files:${hashFileSources(rightBslFiles)}`,
    readOnly: true,
    cleanupPolicy: 'manual',
    contentHash: hashFileSources(rightBslFiles),
  });

  const bsl = buildBslProjectionInputs({
    leftModules: leftBsl.modules,
    rightModules: rightBsl.modules,
    leftSources: sourceMap(leftBslFiles),
    rightSources: sourceMap(rightBslFiles),
    session,
    rightSnapshotId,
  });
  const adapterResults = await buildAdapterCompareResults({
    strategy,
    leftInventory,
    rightInventory,
    metadata,
    session,
  });
  const candidateFactories = new Map<string, ExecutableCandidateFactory>(bsl.candidateFactories);
  for (const result of adapterResults) {
    result.candidateFactories.forEach((factory, nodeId) => candidateFactories.set(nodeId, factory));
  }
  const projection = buildCompareTreeProjection({
    metadata,
    bsl: [
      ...bsl.items,
      { diagnostics: leftBsl.diagnostics.filter((diagnostic) => !bsl.matchedDiagnostics.has(diagnostic)) },
      { diagnostics: rightBsl.diagnostics.filter((diagnostic) => !bsl.matchedDiagnostics.has(diagnostic)) },
    ],
    adapterResults,
    messages: session.state.messages,
  });

  return { session, projection, candidateFactories };
}

async function buildAdapterCompareResults(input: {
  strategy: CompareJoinStrategy;
  leftInventory: ConfigurationInventory;
  rightInventory: ConfigurationInventory;
  metadata: ReturnType<typeof matchMetadataIdentities>;
  session: CompareSession;
}): Promise<AdapterCompareResult[]> {
  const results: AdapterCompareResult[] = [];
  const matches = buildMetadataObjectMatches(input);

  for (const match of matches) {
    results.push(
      await fileObjectAdapter.compare({
        strategy: input.strategy,
        leftInventory: input.leftInventory,
        rightInventory: input.rightInventory,
        match,
        session: input.session,
        snapshots: { left: '', right: '' },
      })
    );

    if (!match.left || !match.right) {
      continue;
    }

    for (const artifactKind of ['metadataXml', 'formXml', 'predefinedXml'] as const) {
      const artifactPair = findArtifactPair(input.leftInventory, input.rightInventory, match, artifactKind);
      if (!artifactPair || artifactPair.left.contentHash === artifactPair.right.contentHash) {
        continue;
      }

      results.push(await compareXmlArtifact(input, match, artifactPair, artifactKind));
    }
  }

  return results.filter((result) => result.nodes.length > 0 || result.diagnostics.length > 0);
}

function buildMetadataObjectMatches(input: {
  leftInventory: ConfigurationInventory;
  rightInventory: ConfigurationInventory;
  metadata: ReturnType<typeof matchMetadataIdentities>;
}): MetadataObjectMatch[] {
  const matches: MetadataObjectMatch[] = [
    ...input.metadata.matches.map((identity) => ({
      left: findInventoryObjectByDescriptor(input.leftInventory, identity.left.filePath),
      right: findInventoryObjectByDescriptor(input.rightInventory, identity.right.filePath),
      identity,
      leftIdentity: identity.left,
      rightIdentity: identity.right,
    })),
    ...input.metadata.unmatchedLeft.map((identity) => ({
      left: findInventoryObjectByDescriptor(input.leftInventory, identity.filePath),
      leftIdentity: identity,
    })),
    ...input.metadata.unmatchedRight.map((identity) => ({
      right: findInventoryObjectByDescriptor(input.rightInventory, identity.filePath),
      rightIdentity: identity,
    })),
  ];

  return matches.filter((match) => match.left || match.right);
}

async function compareXmlArtifact(
  input: {
    strategy: CompareJoinStrategy;
    leftInventory: ConfigurationInventory;
    rightInventory: ConfigurationInventory;
    session: CompareSession;
  },
  match: MetadataObjectMatch,
  artifactPair: { left: ArtifactUnit; right: ArtifactUnit },
  artifactKind: 'metadataXml' | 'formXml' | 'predefinedXml'
): Promise<AdapterCompareResult> {
  const adapterInput: AdapterCompareInput = {
    strategy: input.strategy,
    leftInventory: input.leftInventory,
    rightInventory: input.rightInventory,
    match,
    session: input.session,
    snapshots: {
      left: await fs.readFile(artifactPair.left.filePath, 'utf-8'),
      right: await fs.readFile(artifactPair.right.filePath, 'utf-8'),
    },
  };

  switch (artifactKind) {
    case 'metadataXml':
      return metadataXmlAdapter.compare(adapterInput);
    case 'formXml':
      return formXmlAdapter.compare(adapterInput);
    case 'predefinedXml':
      return predefinedXmlAdapter.compare(adapterInput);
  }
}

function findArtifactPair(
  leftInventory: ConfigurationInventory,
  rightInventory: ConfigurationInventory,
  match: MetadataObjectMatch,
  kind: ArtifactKind
): { left: ArtifactUnit; right: ArtifactUnit } | undefined {
  const left = match.left ? findArtifact(leftInventory, match.left, kind) : undefined;
  const right = match.right ? findArtifact(rightInventory, match.right, kind) : undefined;
  return left && right ? { left, right } : undefined;
}

function findArtifact(
  inventory: ConfigurationInventory,
  object: MetadataObjectUnit,
  kind: ArtifactKind
): ArtifactUnit | undefined {
  return inventory.artifactsByObjectId.get(object.objectId)?.find((artifact) => artifact.kind === kind);
}

function findInventoryObjectByDescriptor(
  inventory: ConfigurationInventory,
  descriptorPath: string
): MetadataObjectUnit | undefined {
  const normalizedDescriptorPath = path.normalize(descriptorPath).toLowerCase();
  return inventory.objects.find(
    (object) => object.descriptorPath.toLowerCase() === normalizedDescriptorPath
  );
}

interface BslFileSource {
  filePath: string;
  source: string;
}

async function collectBslFileSources(rootPath: string): Promise<BslFileSource[]> {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  const files: BslFileSource[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectBslFileSources(entryPath)));
    } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.bsl') {
      files.push({
        filePath: entryPath,
        source: await fs.readFile(entryPath, 'utf-8'),
      });
    }
  }

  return files.sort((left, right) => left.filePath.localeCompare(right.filePath));
}

function buildBslProjectionInputs(input: {
  leftModules: readonly BslModuleIndexEntry[];
  rightModules: readonly BslModuleIndexEntry[];
  leftSources: ReadonlyMap<string, string>;
  rightSources: ReadonlyMap<string, string>;
  session: CompareSession;
  rightSnapshotId: string;
}): {
  items: BslRoutineDiffProjectionInput[];
  matchedDiagnostics: Set<BslModuleDiagnostic>;
  candidateFactories: Map<string, ExecutableCandidateFactory>;
} {
  const leftByModuleId = groupModulesById(input.leftModules);
  const rightByModuleId = groupModulesById(input.rightModules);
  const moduleIds = new Set([...leftByModuleId.keys(), ...rightByModuleId.keys()]);
  const projections: BslRoutineDiffProjectionInput[] = [];
  const matchedDiagnostics = new Set<BslModuleDiagnostic>();
  const candidateFactories = new Map<string, ExecutableCandidateFactory>();

  for (const moduleId of [...moduleIds].sort()) {
    const leftMatches = leftByModuleId.get(moduleId) ?? [];
    const rightMatches = rightByModuleId.get(moduleId) ?? [];

    if (leftMatches.length === 1 && rightMatches.length === 1) {
      const left = leftMatches[0];
      const right = rightMatches[0];
      const candidateFactoriesForModule = new Map<string, ExecutableCandidateFactory>();
      registerExecutableRoutineCandidates({
        left,
        right,
        leftSource: input.leftSources.get(left.identity.filePath),
        rightSource: input.rightSources.get(right.identity.filePath),
        rightSnapshotId: input.rightSnapshotId,
        candidateFactories: candidateFactoriesForModule,
      });
      candidateFactoriesForModule.forEach((factory, nodeId) => candidateFactories.set(nodeId, factory));
      projections.push({
        diff: diffBslModules({ left, right }),
        targetFilePath: left.identity.filePath,
        mergeableRoutineIds: [...candidateFactoriesForModule.keys()],
      });
      left.diagnostics.forEach((diagnostic) => matchedDiagnostics.add(diagnostic));
      right.diagnostics.forEach((diagnostic) => matchedDiagnostics.add(diagnostic));
      continue;
    }

    addUnmatchedBslMessage(input.session, moduleId, leftMatches, rightMatches);
  }

  return { items: projections, matchedDiagnostics, candidateFactories };
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

function registerExecutableRoutineCandidates(input: {
  left: BslModuleIndexEntry;
  right: BslModuleIndexEntry;
  leftSource: string | undefined;
  rightSource: string | undefined;
  rightSnapshotId: string;
  candidateFactories: Map<string, ExecutableCandidateFactory>;
}): void {
  const diff = diffBslModules({ left: input.left, right: input.right });
  const blockingDiagnostics = [
    ...input.left.diagnostics,
    ...input.right.diagnostics,
    ...diff.diagnostics,
  ].filter((diagnostic) => diagnostic.blocking);

  if (blockingDiagnostics.length > 0 || !input.leftSource || !input.rightSource) {
    return;
  }

  for (const routine of diff.routines) {
    const nodeId = `bsl:routine:${diff.moduleId}:${routine.normalizedName}`;
    if (routine.status === 'added' && routine.right) {
      registerAddedRoutineCandidate({
        left: input.left,
        rightSource: input.rightSource,
        rightSnapshotId: input.rightSnapshotId,
        candidateFactories: input.candidateFactories,
        nodeId,
        routine: routine.right,
      });
      continue;
    }
    if (routine.status === 'deleted' && routine.left) {
      registerDeletedRoutineCandidate({
        left: input.left,
        rightSnapshotId: input.rightSnapshotId,
        candidateFactories: input.candidateFactories,
        nodeId,
        routine: routine.left,
      });
      continue;
    }
    if (!isExecutableRoutineDiff(routine)) {
      continue;
    }

    const base: BslRoutineLogicalSnapshot = {
      source: input.leftSource,
      routine: routine.left,
    };
    const incoming: BslRoutineLogicalSnapshot = {
      source: input.rightSource,
      routine: routine.right,
    };
    const plan = createBslRoutineLogicalMergePlan({
      moduleId: diff.moduleId,
      base,
      current: base,
      incoming,
    });
    if (plan.status !== 'auto') {
      continue;
    }
    input.candidateFactories.set(nodeId, async () => {
      const currentTargetSource = await fs.readFile(input.left.identity.filePath, 'utf-8');
      const current = currentSnapshotFor({
        moduleId: diff.moduleId,
        identity: input.left.identity,
        source: currentTargetSource,
        routine,
      });
      if (!current) {
        return {
          ok: false,
          diagnostics: [
            previewDiagnostic(
              'MERGE_LOGICAL_GUARD_BLOCKED',
              RIGHT_SOURCE_ID,
              nodeId,
              input.left.identity.filePath,
              'Текущую версию целевой процедуры не удалось разобрать перед preview.'
            ),
          ],
        };
      }
      const currentGuard = createBslRoutineLogicalMergePlan({
        moduleId: diff.moduleId,
        base,
        current,
        incoming,
      });
      if (currentGuard.status !== 'auto') {
        return {
          ok: false,
          diagnostics: currentGuard.diagnostics.map((item) =>
            previewDiagnostic(
              'MERGE_LOGICAL_GUARD_BLOCKED',
              RIGHT_SOURCE_ID,
              nodeId,
              input.left.identity.filePath,
              item.message
            )
          ),
        };
      }
      const plannedNextSource = applyLogicalInsertBlocks(current, plan);
      if (!plannedNextSource) {
        return {
          ok: false,
          diagnostics: [
            previewDiagnostic(
              'MERGE_LOGICAL_GUARD_BLOCKED',
              RIGHT_SOURCE_ID,
              nodeId,
              input.left.identity.filePath,
              'Logical insert anchor cannot be resolved for preview.'
            ),
          ],
        };
      }
      return {
        ok: true,
        candidate: {
          kind: 'bslLogicalRoutineMerge',
          sourceId: RIGHT_SOURCE_ID,
          snapshotId: input.rightSnapshotId,
          nodeId,
          targetUri: pathToFileURL(input.left.identity.filePath).toString(),
          expectedOldHash: hashText(currentTargetSource),
          newHash: hashText(plannedNextSource),
          logicalRoutine: {
            moduleId: diff.moduleId,
            current,
            plan,
          },
        },
      };
    });
  }
}

function registerAddedRoutineCandidate(input: {
  left: BslModuleIndexEntry;
  rightSource: string;
  rightSnapshotId: string;
  candidateFactories: Map<string, ExecutableCandidateFactory>;
  nodeId: string;
  routine: BslRoutineInfo;
}): void {
  const sourceText = sourceTextForRange(input.rightSource, input.routine.range);
  if (!sourceText) {
    return;
  }

  input.candidateFactories.set(input.nodeId, async () => {
    const currentTargetSource = await fs.readFile(input.left.identity.filePath, 'utf-8');
    const current = indexBslModuleSource({
      identity: input.left.identity,
      source: currentTargetSource,
    });
    if (current.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
      return routineGuardDiagnostic(
        input.nodeId,
        input.left.identity.filePath,
        'Current target BSL module cannot be parsed before preview.'
      );
    }
    if (current.routines.some((routine) => sameRoutineIdentity(routine, input.routine))) {
      return routineGuardDiagnostic(
        input.nodeId,
        input.left.identity.filePath,
        'Current target BSL module already contains this routine.'
      );
    }

    const targetUri = pathToFileURL(input.left.identity.filePath).toString();
    const expectedOldHash = hashText(currentTargetSource);
    const plannedNextSource = applyRoutineInsertPreview(currentTargetSource, sourceText);
    const newHash = hashText(plannedNextSource);
    return {
      ok: true,
      candidate: {
        kind: 'bslRoutineInsert',
        sourceId: RIGHT_SOURCE_ID,
        snapshotId: input.rightSnapshotId,
        nodeId: input.nodeId,
        targetUri,
        expectedOldHash,
        newHash,
        bslRoutine: {
          kind: 'insertRoutine',
          targetPath: targetUri,
          expectedOldHash,
          newHash,
          routine: routineIdentity(input.routine),
          sourceText,
          sourceRange: input.routine.range,
        },
      },
    };
  });
}

function registerDeletedRoutineCandidate(input: {
  left: BslModuleIndexEntry;
  rightSnapshotId: string;
  candidateFactories: Map<string, ExecutableCandidateFactory>;
  nodeId: string;
  routine: BslRoutineInfo;
}): void {
  input.candidateFactories.set(input.nodeId, async () => {
    const currentTargetSource = await fs.readFile(input.left.identity.filePath, 'utf-8');
    const current = indexBslModuleSource({
      identity: input.left.identity,
      source: currentTargetSource,
    });
    if (current.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
      return routineGuardDiagnostic(
        input.nodeId,
        input.left.identity.filePath,
        'Current target BSL module cannot be parsed before preview.'
      );
    }

    const currentRoutine = current.routines.find((routine) =>
      sameRoutineIdentity(routine, input.routine)
    );
    const sourceText = currentRoutine
      ? sourceTextForRange(currentTargetSource, currentRoutine.range)
      : undefined;
    const plannedNextSource = currentRoutine
      ? applyRoutineDeletePreview(currentTargetSource, currentRoutine.range)
      : undefined;
    if (!currentRoutine || !sourceText || plannedNextSource === undefined) {
      return routineGuardDiagnostic(
        input.nodeId,
        input.left.identity.filePath,
        'Current target BSL routine cannot be resolved before preview.'
      );
    }

    const targetUri = pathToFileURL(input.left.identity.filePath).toString();
    const expectedOldHash = hashText(currentTargetSource);
    const newHash = hashText(plannedNextSource);
    return {
      ok: true,
      candidate: {
        kind: 'bslRoutineDelete',
        sourceId: RIGHT_SOURCE_ID,
        snapshotId: input.rightSnapshotId,
        nodeId: input.nodeId,
        targetUri,
        expectedOldHash,
        newHash,
        bslRoutine: {
          kind: 'deleteRoutine',
          targetPath: targetUri,
          expectedOldHash,
          newHash,
          routine: routineIdentity(currentRoutine),
          sourceText,
          targetRange: currentRoutine.range,
        },
      },
    };
  });
}

function routineGuardDiagnostic(
  nodeId: string,
  filePath: string,
  suggestedAction: string
): ReturnType<ExecutableCandidateFactory> {
  return Promise.resolve({
    ok: false,
    diagnostics: [
      previewDiagnostic(
        'MERGE_BSL_ROUTINE_GUARD_BLOCKED',
        RIGHT_SOURCE_ID,
        nodeId,
        filePath,
        suggestedAction
      ),
    ],
  });
}

function currentSnapshotFor(input: {
  moduleId: string;
  identity: BslModuleIndexEntry['identity'];
  source: string;
  routine: BslRoutineDiffItem;
}): BslRoutineLogicalSnapshot | undefined {
  const indexed = indexBslModuleSource({
    identity: input.identity,
    source: input.source,
  });
  if (indexed.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    return undefined;
  }

  const routine = indexed.routines.find(
    (candidate) =>
      candidate.normalizedName === input.routine.normalizedName &&
      candidate.kind === input.routine.left?.kind &&
      candidate.exported === input.routine.left?.exported
  );
  return routine
    ? {
        source: input.source,
        routine,
      }
    : undefined;
}

function applyLogicalInsertBlocks(
  current: BslRoutineLogicalSnapshot,
  plan: BslRoutineLogicalMergePlan
): string | undefined {
  const scan = scanBslRoutineLogicalOutline(current);
  const eol = scan.eol;
  const insertions: { offset: number; text: string }[] = [];

  for (const operation of plan.operations) {
    if (operation.kind !== 'insertBlock') {
      return undefined;
    }

    const afterLine = anchorEndLine(scan, operation.startAnchor);
    if (afterLine === undefined) {
      return undefined;
    }

    const offset = offsetAfterLine(current.source, afterLine);
    if (offset === undefined) {
      return undefined;
    }

    insertions.push({
      offset,
      text: ensureTrailingEol(normalizeEol(operation.sourceText, eol), eol),
    });
  }

  let nextSource = current.source;
  insertions.sort((left, right) => right.offset - left.offset);
  for (const insertion of insertions) {
    nextSource =
      nextSource.slice(0, insertion.offset) + insertion.text + nextSource.slice(insertion.offset);
  }

  return nextSource;
}

function anchorEndLine(
  scanResult: ReturnType<typeof scanBslRoutineLogicalOutline>,
  anchor: BslRoutineLogicalAnchor
): number | undefined {
  if (anchor.kind === 'sentinel') {
    const section = scanResult.outline.sections[anchor.sectionId];
    return anchor.sentinel === 'section-start' ? section?.startLine - 1 : section?.endLine;
  }

  return scanResult.outline.nodesByPath[anchor.path]?.range.endLine;
}

function normalizeEol(text: string, eol: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, eol);
}

function ensureTrailingEol(text: string, eol: string): string {
  return text.endsWith(eol) ? text : `${text}${eol}`;
}

function offsetAfterLine(source: string, lineNumber: number): number | undefined {
  if (lineNumber === 0) {
    return 0;
  }

  const lines = splitSourceLines(source);
  if (lineNumber < 0 || lineNumber > lines.length) {
    return undefined;
  }

  return lines
    .slice(0, lineNumber)
    .reduce((offset, line) => offset + line.text.length + line.eol.length, 0);
}

function sourceTextForRange(source: string, range: BslTextRange): string | undefined {
  const offsetRange = offsetRangeFor(source, range);
  return offsetRange ? source.slice(offsetRange.start, offsetRange.end) : undefined;
}

function applyRoutineInsertPreview(source: string, routineSourceText: string): string {
  const eol = detectEol(source) ?? detectEol(routineSourceText) ?? '\n';
  const currentText = trimTrailingLineBreaks(source);
  const routineText = normalizeEol(trimTrailingLineBreaks(routineSourceText), eol);
  return currentText.length === 0 ? routineText : `${currentText}${eol}${routineText}`;
}

function applyRoutineDeletePreview(source: string, range: BslTextRange): string | undefined {
  const offsetRange = offsetRangeFor(source, range);
  if (!offsetRange) {
    return undefined;
  }

  const adjustedStart =
    offsetRange.end === source.length
      ? removePrecedingEolStart(source, offsetRange.start)
      : offsetRange.start;
  return source.slice(0, adjustedStart) + source.slice(offsetRange.end);
}

function routineIdentity(routine: BslRoutineInfo): {
  name: string;
  normalizedName: string;
  kind: BslRoutineInfo['kind'];
  exported: boolean;
} {
  return {
    name: routine.name,
    normalizedName: routine.normalizedName,
    kind: routine.kind,
    exported: routine.exported,
  };
}

function sameRoutineIdentity(left: BslRoutineInfo, right: BslRoutineInfo): boolean {
  return (
    left.normalizedName === right.normalizedName &&
    left.kind === right.kind &&
    left.exported === right.exported
  );
}

function offsetRangeFor(
  source: string,
  range: BslTextRange
): { start: number; end: number } | undefined {
  const start = offsetForPosition(source, range.startLine, range.startColumn);
  const end = offsetForPosition(source, range.endLine, range.endColumn);
  return start === undefined || end === undefined || end < start ? undefined : { start, end };
}

function offsetForPosition(
  source: string,
  lineNumber: number,
  columnNumber: number
): number | undefined {
  if (lineNumber < 1 || columnNumber < 1) {
    return undefined;
  }

  const lines = splitSourceLines(source);
  const line = lines[lineNumber - 1];
  if (!line || columnNumber > line.text.length + 1) {
    return undefined;
  }

  const lineStart = lines
    .slice(0, lineNumber - 1)
    .reduce((offset, line) => offset + line.text.length + line.eol.length, 0);
  return lineStart + columnNumber - 1;
}

function removePrecedingEolStart(source: string, start: number): number {
  if (start >= 2 && source.slice(start - 2, start) === '\r\n') {
    return start - 2;
  }
  if (start >= 1 && (source[start - 1] === '\n' || source[start - 1] === '\r')) {
    return start - 1;
  }

  return start;
}

function detectEol(source: string): string | undefined {
  const crlf = source.indexOf('\r\n');
  if (crlf >= 0) {
    return '\r\n';
  }
  const lf = source.indexOf('\n');
  if (lf >= 0) {
    return '\n';
  }
  const cr = source.indexOf('\r');
  return cr >= 0 ? '\r' : undefined;
}

function trimTrailingLineBreaks(source: string): string {
  return source.replace(/(?:\r\n|\r|\n)+$/g, '');
}

function isExecutableRoutineDiff(
  routine: BslRoutineDiffItem
): routine is BslRoutineDiffItem & Required<Pick<BslRoutineDiffItem, 'left' | 'right'>> {
  return routine.status === 'changed' && Boolean(routine.left && routine.right);
}

function sourceMap(files: readonly BslFileSource[]): Map<string, string> {
  return new Map(files.map((file) => [file.filePath, file.source]));
}

function hashFileSources(files: readonly BslFileSource[]): string {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(path.normalize(file.filePath).replace(/\\/g, '/'));
    hash.update('\0');
    hash.update(hashText(file.source));
    hash.update('\0');
  }

  return hash.digest('hex');
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

function previewDiagnostic(
  code: string,
  sourceId: string,
  nodeId: string,
  diagnosticPath: string,
  suggestedAction: string
): CompareMessage {
  return {
    severity: 'error',
    code,
    phase: 'preview',
    sourceId,
    nodeId,
    path: diagnosticPath,
    blocking: true,
    suggestedAction,
  };
}
