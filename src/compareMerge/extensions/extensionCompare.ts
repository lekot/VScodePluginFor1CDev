import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { pathToFileURL } from 'url';

import type { CompareMessage, CompareSide, CompareSnapshot, CompareSource } from '../domain/compareContracts';
import { CompareSession } from '../domain/compareSession';
import type { CompareTreeNode, CompareTreeStats, CompareTreeStatus } from '../compareTreeTypes';
import type { CompareTreeProjection } from '../projection/compareTreeProjection';
import type { CompareCancellationToken } from '../compareCancellation';
import { throwIfCompareCancelled } from '../compareCancellation';
import type { CompareJoinStrategy, ConfigurationCompareInfo, ConfigurationCompareWorkspaceState } from '../configurationCompareWorkspace';
import { indexExtensionMetadataRoot, SUPPORTED_EXTENSION_FORMATS, type ExtensionIndexDiagnostic, type ExtensionMetadataIndex } from './extensionMetadataIndex';
import { analyzeExtensionTransfers, materializeExtensionSelection, type ExtensionTransferRow } from './extensionTransfer';
import { projectExtensionSemanticNodes } from './extensionSemanticProjection';

const LEFT_SOURCE_ID = 'left-source';
const RIGHT_SOURCE_ID = 'right-source';

export interface ExtensionCompareInput {
  readonly leftRootPath: string;
  readonly rightRootPath: string;
  readonly createdAt?: Date;
  readonly cancellation?: CompareCancellationToken;
  readonly extensionBaseRoots?: Readonly<Partial<Record<CompareSide, string>>>;
}

/** Returns undefined when there is no CFE marker or explicit manifest relation to handle. */
export async function tryBuildExtensionCompareState(
  input: ExtensionCompareInput,
  strategy: CompareJoinStrategy,
): Promise<ConfigurationCompareWorkspaceState | undefined> {
  void strategy;
  throwIfCompareCancelled(input.cancellation);

  const leftRootPath = path.resolve(input.leftRootPath);
  const rightRootPath = path.resolve(input.rightRootPath);
  const createdAt = input.createdAt ?? new Date();
  const explicitLeftBasePath = input.extensionBaseRoots?.left;
  const explicitRightBasePath = input.extensionBaseRoots?.right;

  const [left, right] = await Promise.all([
    indexExtensionMetadataRoot({ rootPath: leftRootPath, sourceId: LEFT_SOURCE_ID, side: 'left', cancellation: input.cancellation }),
    indexExtensionMetadataRoot({ rootPath: rightRootPath, sourceId: RIGHT_SOURCE_ID, side: 'right', cancellation: input.cancellation }),
  ]);
  throwIfCompareCancelled(input.cancellation);

  // The ordinary CF compare route remains authoritative until a CFE marker or explicit
  // manifest relation identifies extension semantics. Legacy roots can be partial Designer
  // fixtures, so one missing Configuration.xml does not by itself imply malformed CFE.
  const anyCfeEvidence = left.cfeMarkerSeen || right.cfeMarkerSeen || Boolean(explicitLeftBasePath) || Boolean(explicitRightBasePath);
  if (!anyCfeEvidence) {return undefined;}

  const baseIndexes: Partial<Record<CompareSide, ExtensionMetadataIndex>> = {};
  const baseInputs = [
    { side: 'left' as const, pathValue: explicitLeftBasePath, sourceId: 'left-base-source' },
    { side: 'right' as const, pathValue: explicitRightBasePath, sourceId: 'right-base-source' },
  ].filter((item): item is { side: CompareSide; pathValue: string; sourceId: string } => Boolean(item.pathValue));

  for (const item of baseInputs) {
    throwIfCompareCancelled(input.cancellation);
    const normalizedPath = path.resolve(item.pathValue);
    const base = await indexExtensionMetadataRoot({
      rootPath: normalizedPath,
      sourceId: item.sourceId,
      side: item.side,
      cancellation: input.cancellation,
    });
    baseIndexes[item.side] = base;
  }

  const leftExplicitBase = baseIndexes.left;
  const rightExplicitBase = baseIndexes.right;
  const targetBase = left.rootKind === 'cfe'
    ? leftExplicitBase ?? (right.rootKind === 'cf' ? right : undefined)
    : undefined;
  const incomingBase = right.rootKind === 'cfe'
    ? rightExplicitBase ?? (left.rootKind === 'cf' ? left : undefined)
    : undefined;
  const targetBaseIsIncoming = Boolean(targetBase && sameCanonicalRoot(targetBase, right));
  const incomingBaseIsTarget = Boolean(incomingBase && sameCanonicalRoot(incomingBase, left));

  const diagnostics: CompareMessage[] = [];
  let globalBlockReason: string | undefined;
  const setGlobalBlock = (reason: string): void => {
    globalBlockReason ??= reason;
  };

  if (rootsOverlap(left, right)) {
    setGlobalBlock('Корни сравнения совпадают или вложены друг в друга; перенос заблокирован.');
  }
  if (left.rootKind === 'unknown' || right.rootKind === 'unknown') {
    setGlobalBlock('Тип одного из корней не подтверждён по корректному Configuration.xml.');
  }
  if (left.rootKind === 'cf' && explicitLeftBasePath) {
    setGlobalBlock('Manifest связывает левый корень с base, но сам корень распознан как CF.');
  }
  if (right.rootKind === 'cf' && explicitRightBasePath) {
    setGlobalBlock('Manifest связывает правый корень с base, но сам корень распознан как CF.');
  }
  for (const [side, index] of [['left', left], ['right', right]] as const) {
    if (!index.hasConfigurationXml || !index.configurationHash) {
      setGlobalBlock(`У ${side === 'left' ? 'целевого' : 'входящего'} корня отсутствует проверяемый Configuration.xml.`);
    }
    if (!index.formatVersion || !SUPPORTED_EXTENSION_FORMATS.has(index.formatVersion)) {
      setGlobalBlock(`Формат ${side === 'left' ? 'целевого' : 'входящего'} корня не поддерживается; допустимы Designer XML 2.17–2.21.`);
    }
    if (index.rootKind === 'cfe') {
      if (index.objectBelonging !== 'Adopted') {
        setGlobalBlock(`У ${side === 'left' ? 'целевого' : 'входящего'} CFE отсутствует корректный ObjectBelonging=Adopted.`);
      }
      if (!index.purpose || !['Customization', 'Patch', 'AddOn'].includes(index.purpose)) {
        setGlobalBlock(`У ${side === 'left' ? 'целевого' : 'входящего'} CFE отсутствует поддерживаемое назначение.`);
      }
    }
  }
  if (left.formatVersion && right.formatVersion && left.formatVersion !== right.formatVersion) {
    setGlobalBlock('Версии форматов входящего и целевого корней различаются.');
  }

  for (const [side, extensionRoot, base] of [
    ['left', left, leftExplicitBase],
    ['right', right, rightExplicitBase],
  ] as const) {
    if (!base) {continue;}
    if (extensionRoot.rootKind !== 'cfe') {
      setGlobalBlock(`Явная base relation для стороны ${side} не подтверждена CFE identity этого корня.`);
    }
    if (base.rootKind !== 'cf' || !base.hasConfigurationXml || !base.configurationHash) {
      setGlobalBlock(`Явный base root для стороны ${side} не является корректной CF конфигурацией.`);
    }
    if (!base.formatVersion || !SUPPORTED_EXTENSION_FORMATS.has(base.formatVersion)) {
      setGlobalBlock(`Формат base root для стороны ${side} не поддерживается.`);
    }
    if (extensionRoot.formatVersion && base.formatVersion && extensionRoot.formatVersion !== base.formatVersion) {
      setGlobalBlock(`Версия явного base root для стороны ${side} не совпадает с версией CFE.`);
    }
  }

  for (const index of [left, right, ...Object.values(baseIndexes).filter(isDefined)]) {
    for (const item of index.diagnostics) {
      const message = indexDiagnosticMessage(item);
      const sourceId = index.sourceId;
      const compareMessage: CompareMessage = {
        severity: 'error',
        code: item.code,
        phase: 'compare',
        sourceId,
        path: item.relativePath,
        blocking: true,
        suggestedAction: message,
      };
      diagnostics.push(compareMessage);
      // Root identity and malformed XML invalidate the whole interpretation. Per-object
      // duplicate/descriptor diagnostics remain visible on their rows without disabling peers.
      if (!item.qualifiedName && isRootWideDiagnostic(item)) {setGlobalBlock(message);}
    }
  }

  if (globalBlockReason) {
    diagnostics.push(blockingDiagnostic(globalBlockReason, LEFT_SOURCE_ID));
  }

  const sessionId = `extension-compare-${createdAt.getTime()}-${randomUUID()}`;
  const sources: CompareSource[] = [
    comparisonSource(left, 'left', true),
    comparisonSource(right, 'right', false),
  ];
  for (const item of baseInputs) {
    const index = baseIndexes[item.side];
    if (index) {sources.push(baseSource(index, item.side));}
  }
  const session = CompareSession.create({ sessionId, createdAt: createdAt.toISOString(), sources });
  const leftSnapshotId = `${sessionId}-left`;
  const rightSnapshotId = `${sessionId}-right`;
  session.registerSnapshot(createSnapshot(left, leftSnapshotId, createdAt, false));
  session.registerSnapshot(createSnapshot(right, rightSnapshotId, createdAt, true));
  for (const message of diagnostics) {session.addMessage(message);}

  const analysis = await analyzeExtensionTransfers({
    target: left,
    incoming: right,
    targetBase,
    incomingBase,
    targetBaseIsIncoming,
    incomingBaseIsTarget,
    globalBlockReason,
  });
  throwIfCompareCancelled(input.cancellation);

  const semanticProjection = await projectExtensionSemanticNodes({
    target: left,
    incoming: right,
    rows: analysis.rows,
    session,
    leftSnapshotId,
    rightSnapshotId,
    globalBlockReason,
    cancellation: input.cancellation,
  });
  const semanticDiagnostics = semanticProjection.diagnostics.map(redactSemanticDiagnostic);
  for (const message of semanticDiagnostics) {session.addMessage(message);}

  const rootDiagnostics = collectVisibleDiagnostics([left, right, ...Object.values(baseIndexes).filter(isDefined)]);
  const projection = buildExtensionProjection(semanticProjection.nodes, rootDiagnostics, semanticProjection.rootPurposeNode, semanticDiagnostics);
  const comparisonInfo: ConfigurationCompareInfo = {
    mode: 'extension',
    targetLabel: safeBasename(leftRootPath),
    sourceLabel: safeBasename(rightRootPath),
    limitations: [
      'Поддерживается Designer XML 2.17–2.21; корневые типы определяются общим реестром метаданных (46 типов).',
      'Переносятся только явно выбранные объекты; отсутствие объекта не означает удаление.',
      'Динамические ссылки BSL и фактический эффект прав/RLS не доказываются; структурные ссылки Rights проверяются по цели, доказанной базе и выбранным объектам.',
    ],
  };

  const rows: readonly ExtensionTransferRow[] = analysis.rows;
  return {
    session,
    projection,
    candidateFactories: new Map(),
    mergeableNodeIds: [...analysis.mergeableNodeIds, ...semanticProjection.mergeableNodeIds.filter((id) => !analysis.mergeableNodeIds.includes(id))],
    comparisonInfo,
    materializeSelection: (nodeIds) => materializeExtensionSelection({
      target: left,
      incoming: right,
      rows,
      session,
      semanticSelections: semanticProjection.selections,
      linkedDesignerPackages: semanticProjection.linkedDesignerPackages,
      linkedRoutineSelections: semanticProjection.linkedRoutineSelections,
      linkedFormModules: semanticProjection.linkedFormModules,
      linkedEventDependencies: semanticProjection.linkedEventDependencies,
      rootPurposeSelection: semanticProjection.rootPurposeSelection,
      leftSnapshotId,
      rightSnapshotId,
      cancellation: input.cancellation,
    }, nodeIds),
  };
}

function comparisonSource(index: ExtensionMetadataIndex, side: CompareSide, writable: boolean): CompareSource {
  const root = index.canonicalRootPath ?? path.resolve(index.rootPath);
  return {
    sourceId: index.sourceId,
    side,
    role: 'comparison',
    kind: side === 'left' ? 'workspace' : 'file',
    displayName: safeBasename(root),
    rootUri: pathToFileURL(root).toString(),
    ...(side === 'left' ? { targetWorkspaceRoot: root } : {}),
    writable,
  };
}

function baseSource(index: ExtensionMetadataIndex, side: CompareSide): CompareSource {
  const root = index.canonicalRootPath ?? path.resolve(index.rootPath);
  return {
    sourceId: index.sourceId,
    side,
    role: 'base',
    kind: 'file',
    displayName: safeBasename(root),
    rootUri: pathToFileURL(root).toString(),
    writable: false,
  };
}

function createSnapshot(index: ExtensionMetadataIndex, snapshotId: string, createdAt: Date, readOnly: boolean): CompareSnapshot {
  const contentHash = hashIndex(index);
  const root = index.canonicalRootPath ?? path.resolve(index.rootPath);
  return {
    snapshotId,
    sourceId: index.sourceId,
    snapshotRoot: pathToFileURL(root).toString(),
    origin: pathToFileURL(root).toString(),
    createdAt: createdAt.toISOString(),
    retentionUntil: createdAt.toISOString(),
    sourceRevision: `files:${contentHash}`,
    readOnly,
    cleanupPolicy: 'manual',
    contentHash,
  };
}

function hashIndex(index: ExtensionMetadataIndex): string {
  const hash = createHash('sha256');
  hash.update(index.configurationHash ?? 'missing');
  for (const object of [...index.objects].sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName))) {
    hash.update(`\n${object.qualifiedName}\0${object.descriptorHash ?? 'missing'}`);
    if (object.sidecarSnapshot?.state === 'directory') {hash.update(object.sidecarSnapshot.mergeHash);}
    else {hash.update('missing-sidecar');}
  }
  return hash.digest('hex');
}

function buildExtensionProjection(
  objectNodes: readonly CompareTreeNode[],
  diagnostics: readonly { readonly sourceId: string; readonly diagnostic: ExtensionIndexDiagnostic }[],
  rootPurposeNode?: CompareTreeNode,
  semanticDiagnostics: readonly CompareMessage[] = [],
): CompareTreeProjection {
  const groups: CompareTreeNode[] = [];
  if (rootPurposeNode) {groups.push(branch('extensionRootProperties', 'Свойства расширения', 'extensionRootPropertyGroup', [rootPurposeNode]));}
  if (objectNodes.length > 0) {groups.push(branch('extensionObjects', 'Объекты', 'extensionObjectGroup', [...objectNodes]));}
  if (diagnostics.length > 0 || semanticDiagnostics.length > 0) {
    const diagnosticNodes = [
      ...diagnostics.map(({ sourceId, diagnostic }, index) => diagnosticNode(sourceId, diagnostic, index)),
      ...semanticDiagnostics.map((message, index) => semanticDiagnosticNode(message, index)),
    ];
    groups.push(branch('extensionDiagnostics', 'Диагностика', 'extensionDiagnosticGroup', diagnosticNodes));
  }
  const root = branch('configCompare', 'Сравнение расширений конфигурации', 'configCompare', groups);
  const stats: CompareTreeStats = { total: 0, different: 0, mergeable: 0 };
  const visit = (node: CompareTreeNode): void => {
    if (node !== root) {stats.total += 1;}
    if (node.status !== 'equal' && (node.children.length === 0 || node.mergeable === false)) {stats.different += 1;}
    if (node.mergeable) {stats.mergeable += 1;}
    for (const child of node.children) {visit(child);}
  };
  visit(root);
  return { root, stats };
}

function diagnosticNode(sourceId: string, diagnostic: ExtensionIndexDiagnostic, index: number): CompareTreeNode {
  const safeMessage = indexDiagnosticMessage(diagnostic);
  const status: CompareTreeStatus = 'changed';
  return {
    id: `extension:diagnostic:${sourceId}:${diagnostic.code}:${index}`,
    label: diagnostic.code,
    kind: 'diagnostic',
    status,
    leftValue: diagnostic.relativePath ?? '',
    rightValue: safeMessage,
    mergeable: false,
    ...(diagnostic.qualifiedName ? { payloadRef: `extension:${diagnostic.qualifiedName}` } : {}),
    conflict: { kind: 'unsupported', blocking: true, message: safeMessage },
    mergeState: { state: 'blocked', reason: safeMessage },
    children: [],
  };
}

function semanticDiagnosticNode(message: CompareMessage, index: number): CompareTreeNode {
  const safeMessage = message.suggestedAction ?? message.code;
  return {
    id: `extension:diagnostic:semantic:${message.sourceId}:${message.code}:${index}`,
    label: message.code,
    kind: 'diagnostic',
    status: 'changed',
    leftValue: message.path,
    rightValue: safeMessage,
    mergeable: false,
    ...(message.nodeId ? { payloadRef: message.nodeId } : {}),
    conflict: { kind: 'unsupported', blocking: true, message: safeMessage },
    mergeState: { state: 'blocked', reason: safeMessage },
    children: [],
  };
}

function branch(id: string, label: string, kind: string, children: CompareTreeNode[]): CompareTreeNode {
  return {
    id,
    label,
    kind,
    status: children.some((child) => child.status !== 'equal') ? 'changed' : 'equal',
    children,
  };
}

function collectVisibleDiagnostics(indexes: readonly ExtensionMetadataIndex[]): { sourceId: string; diagnostic: ExtensionIndexDiagnostic }[] {
  return indexes.flatMap((index) => index.diagnostics.map((diagnostic) => ({ sourceId: index.sourceId, diagnostic })));
}

function blockingDiagnostic(message: string, sourceId: string): CompareMessage {
  return {
    severity: 'error',
    code: 'EXTENSION_ROOT_BLOCKED',
    phase: 'compare',
    sourceId,
    blocking: true,
    suggestedAction: message,
  };
}

function isRootWideDiagnostic(diagnostic: ExtensionIndexDiagnostic): boolean {
  return diagnostic.code.startsWith('EXTENSION_ROOT_')
    || diagnostic.code.startsWith('EXTENSION_CONFIGURATION_')
    || diagnostic.code === 'EXTENSION_REGISTRATION_INVALID';
}

function indexDiagnosticMessage(diagnostic: ExtensionIndexDiagnostic): string {
  return redactMachinePaths(diagnostic.message);
}

function redactSemanticDiagnostic(message: CompareMessage): CompareMessage {
  const redact = (value: string | undefined): string | undefined => value?.replace(/(?:[A-Za-z]:\\|\\\\|\/)[^\s"'<>]*/gu, '[путь]');
  return {
    ...message,
    ...(message.path ? { path: redact(message.path) } : {}),
    ...(message.suggestedAction ? { suggestedAction: redact(message.suggestedAction) } : {}),
  };
}

function redactMachinePaths(value: string): string {
  return value.replace(/(?:[A-Za-z]:\\|\\\\|\/)[^\s"'<>]*/gu, '[путь]');
}

function rootsOverlap(left: ExtensionMetadataIndex, right: ExtensionMetadataIndex): boolean {
  const leftPath = left.canonicalRootPath ?? path.resolve(left.rootPath);
  const rightPath = right.canonicalRootPath ?? path.resolve(right.rootPath);
  return pathContains(leftPath, rightPath) || pathContains(rightPath, leftPath);
}

function pathContains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function sameCanonicalRoot(left: ExtensionMetadataIndex, right: ExtensionMetadataIndex): boolean {
  const leftPath = left.canonicalRootPath;
  const rightPath = right.canonicalRootPath;
  return Boolean(leftPath && rightPath && normalizeComparisonPath(leftPath) === normalizeComparisonPath(rightPath));
}

function normalizeComparisonPath(value: string): string {
  const normalized = path.resolve(value).replace(/[\\/]+$/u, '');
  return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized;
}

function safeBasename(rootPath: string): string {
  return path.basename(rootPath) || 'корень';
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
