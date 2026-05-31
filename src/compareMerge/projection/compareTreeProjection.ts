import type { BslModuleDiagnostic } from '../bsl/bslModuleIndexer';
import type { BslRoutineDiffResult, BslRoutineDiffStatus } from '../bsl/bslRoutineDiff';
import type {
  CompareMessage,
  IdentityConflict,
  MatchResult,
  MetadataIdentity,
  MetadataMatchDiagnostic,
} from '../domain/compareContracts';
import type {
  CompareTreeMergeState,
  CompareTreeNode,
  CompareTreeStats,
  CompareTreeStatus,
} from '../compareTreeTypes';
import type { AdapterCompareResult } from '../adapters/mergeAdapter';

export interface CompareTreeProjection {
  root: CompareTreeNode;
  stats: CompareTreeStats;
}

export interface BslRoutineDiffProjectionInput {
  diff?: BslRoutineDiffResult;
  diagnostics?: readonly BslModuleDiagnostic[];
  targetFilePath?: string;
  targetAmbiguous?: boolean;
  mergeableRoutineIds?: readonly string[];
}

export interface CompareTreeProjectionInput {
  metadata?: MatchResult;
  bsl?: readonly BslRoutineDiffProjectionInput[];
  adapterResults?: readonly AdapterCompareResult[];
  messages?: readonly CompareMessage[];
}

type DiagnosticSource = 'message' | 'metadata' | 'bsl';

interface DiagnosticProjectionInput {
  source: DiagnosticSource;
  code: string;
  message: string;
  blocking: boolean;
  status?: CompareTreeStatus;
  path?: string;
  payloadRef: string;
  context?: string;
  stableKey?: string;
}

export function buildCompareTreeProjection(input: CompareTreeProjectionInput): CompareTreeProjection {
  const adapterDiagnostics = (input.adapterResults ?? []).flatMap((result) => result.diagnostics);
  const children = [
    projectMetadata(input.metadata),
    projectBsl(input.bsl ?? []),
    projectAdapters(input.adapterResults ?? []),
    projectMessages([...(input.messages ?? []), ...adapterDiagnostics]),
  ].filter((node): node is CompareTreeNode => Boolean(node));
  const root = branchNode('configCompare', 'Configuration compare', 'configCompare', children);

  return {
    root,
    stats: collectStats(root),
  };
}

function projectAdapters(results: readonly AdapterCompareResult[]): CompareTreeNode | undefined {
  const children = results.flatMap((result) => result.nodes);
  return children.length === 0
    ? undefined
    : branchNode('adapterChanges', 'Adapter changes', 'adapterGroup', children);
}

function projectMetadata(metadata: MatchResult | undefined): CompareTreeNode | undefined {
  if (!metadata) {
    return undefined;
  }

  const children: CompareTreeNode[] = [
    ...metadata.matches.map(projectMetadataMatch),
    ...metadata.conflicts.map(projectIdentityConflict),
    ...metadata.diagnostics.map(projectMetadataDiagnostic),
    ...metadata.unmatchedLeft.map((identity, index) => projectUnmatchedMetadata(identity, 'leftOnly', index)),
    ...metadata.unmatchedRight.map((identity, index) =>
      projectUnmatchedMetadata(identity, 'rightOnly', index)
    ),
  ];

  return children.length === 0
    ? undefined
    : branchNode('metadata', 'Metadata', 'metadataGroup', children);
}

function projectMetadataMatch(match: MatchResult['matches'][number]): CompareTreeNode {
  const status: CompareTreeStatus =
    match.left.qualifiedName === match.right.qualifiedName ? 'equal' : 'changed';
  return leafNode({
    id: `metadata:match:${encodeId(match.left.qualifiedName)}`,
    label: match.right.qualifiedName,
    kind: 'metadataMatch',
    status,
    leftValue: match.left.filePath,
    rightValue: match.right.filePath,
    mergeable: false,
    payloadRef: `metadataMatch:${match.left.qualifiedName}`,
    mergeState:
      status === 'equal'
        ? undefined
        : {
            state: 'readOnly',
            reason: 'Metadata identity match is read-only in this merge mode.',
          },
  });
}

function projectIdentityConflict(conflict: IdentityConflict): CompareTreeNode {
  const stableKey = stableIdentityConflictKey(conflict);
  const idSuffix = stableKey ? encodeId(stableKey) : encodeId(conflict.kind);
  return leafNode({
    id: `metadata:conflict:${conflict.kind}:${idSuffix}`,
    label: conflict.qualifiedName ?? conflict.uuid ?? conflict.kind,
    kind: 'metadataConflict',
    status: 'changed',
    leftValue: identitySummary(conflict.left ?? conflict.identities.find((item) => item.side === 'left')),
    rightValue: identitySummary(
      conflict.right ?? conflict.identities.find((item) => item.side === 'right')
    ),
    mergeable: false,
    payloadRef: stableKey ? `identityConflict:${stableKey}` : `identityConflict:${conflict.kind}`,
    conflict: {
      kind: conflict.kind,
      blocking: conflict.blocking,
      message: conflict.message,
    },
    mergeState: {
      state: 'identityConflict',
      reason: conflict.message,
    },
  });
}

function projectMetadataDiagnostic(
  diagnostic: MetadataMatchDiagnostic,
  index: number
): CompareTreeNode {
  const stableKey = stableDiagnosticKey([
    ['sourceId', diagnostic.sourceId],
    ['side', diagnostic.side],
    ['path', diagnostic.path],
    ['phase', diagnostic.phase],
    ['code', diagnostic.code],
    ['identities', metadataDiagnosticIdentitiesContext(diagnostic.identities)],
  ]);
  return diagnosticNode({
    source: 'metadata',
    code: diagnostic.code,
    message: diagnostic.message,
    blocking: diagnostic.blocking,
    path: diagnostic.path,
    payloadRef: stableKey
      ? `metadataDiagnostic:${stableKey}`
      : `metadataDiagnostic:${diagnostic.code}:${index}`,
    stableKey,
  });
}

function projectUnmatchedMetadata(
  identity: MetadataIdentity,
  status: 'leftOnly' | 'rightOnly',
  index: number
): CompareTreeNode {
  return leafNode({
    id: `metadata:${status}:${encodeId(identity.qualifiedName)}:${index}`,
    label: identity.qualifiedName,
    kind: 'metadataObject',
    status,
    leftValue: status === 'leftOnly' ? identity.filePath : '',
    rightValue: status === 'rightOnly' ? identity.filePath : '',
    mergeable: false,
    payloadRef: `metadata:${identity.sourceId}:${identity.qualifiedName}`,
    mergeState: {
      state: 'blocked',
      reason: 'Structural metadata merge is not supported in this merge mode.',
    },
  });
}

function projectBsl(items: readonly BslRoutineDiffProjectionInput[]): CompareTreeNode | undefined {
  const children: CompareTreeNode[] = [];

  items.forEach((item) => {
    if (item.diff) {
      children.push(projectBslDiff(item));
    }
    if (item.diagnostics) {
      children.push(...item.diagnostics.map((diagnostic) => projectBslDiagnostic(diagnostic)));
    }
  });

  return children.length === 0 ? undefined : branchNode('bsl', 'BSL routines', 'bslGroup', children);
}

function projectBslDiff(input: BslRoutineDiffProjectionInput): CompareTreeNode {
  const diff = requireDiff(input);
  const mergeableRoutineIds = input.mergeableRoutineIds
    ? new Set(input.mergeableRoutineIds)
    : undefined;
  const blockingDiagnostics = [
    ...(input.diagnostics ?? []),
    ...diff.diagnostics,
  ].filter((diagnostic) => diagnostic.blocking);
  const moduleChildren: CompareTreeNode[] = [
    ...diff.routines.map((routine) => {
      const mergeState = createBslMergeState(input, blockingDiagnostics);
      const nodeId = `bsl:routine:${diff.moduleId}:${routine.normalizedName}`;
      const mergeable = isBslRoutineMergeable(routine.status, mergeState, nodeId, mergeableRoutineIds);
      return leafNode({
        id: nodeId,
        label: routine.name,
        kind: 'bslRoutine',
        status: routineStatus(routine.status),
        leftValue: routine.left ? routineSummary(routine.left.kind, routine.leftIndex) : '',
        rightValue: routine.right ? routineSummary(routine.right.kind, routine.rightIndex) : '',
        mergeable,
        payloadRef: `bslRoutine:${diff.moduleId}:${routine.normalizedName}`,
        mergeState: mergeable ? mergeState : nonMergeableState(mergeState, routine.status),
      });
    }),
    ...diff.diagnostics.map((diagnostic) => projectBslDiagnostic(diagnostic)),
  ];

  return branchNode(
    `bsl:module:${diff.moduleId}`,
    diff.leftIdentity.displayName || diff.rightIdentity.displayName || diff.moduleId,
    'bslModule',
    moduleChildren
  );
}

function projectMessages(messages: readonly CompareMessage[]): CompareTreeNode | undefined {
  const children = messages.map((message, index) =>
    projectCompareMessage(message, index)
  );

  return children.length === 0
    ? undefined
    : branchNode('diagnostics', 'Diagnostics', 'diagnosticsGroup', children);
}

function projectCompareMessage(message: CompareMessage, index: number): CompareTreeNode {
  const stableKey = stableDiagnosticKey([
    ['sourceId', message.sourceId],
    ['path', message.path],
    ['nodeId', message.nodeId],
    ['phase', message.phase],
    ['code', message.code],
  ]);
  return diagnosticNode({
    source: 'message',
    code: message.code,
    message: message.suggestedAction ?? message.path ?? message.code,
    blocking: message.blocking,
    status: compareMessageStatus(message),
    path: message.path,
    payloadRef: stableKey ? `message:${stableKey}` : `message:${message.code}:${index}`,
    stableKey,
  });
}

function projectBslDiagnostic(diagnostic: BslModuleDiagnostic): CompareTreeNode {
  const stableKey = stableDiagnosticKey([
    ['sourceId', diagnostic.sourceId],
    ['side', diagnostic.side],
    ['moduleId', diagnostic.moduleId],
    ['filePath', diagnostic.filePath],
    ['routineName', diagnostic.routineName],
    ['range', bslRangeContext(diagnostic.range)],
    ['code', diagnostic.code],
    ['messageHash', hashStableMessage(diagnostic.message)],
  ]);
  return diagnosticNode({
    source: 'bsl',
    code: diagnostic.code,
    message: diagnostic.message,
    blocking: diagnostic.blocking,
    path: diagnostic.filePath,
    payloadRef: stableKey
      ? `bslDiagnostic:${stableKey}`
      : `bslDiagnostic:${diagnostic.code}:${hashStableMessage(diagnostic.message)}`,
    stableKey,
  });
}

function diagnosticNode(input: DiagnosticProjectionInput): CompareTreeNode {
  const idSuffix = input.stableKey
    ? encodeId(input.stableKey)
    : input.context
    ? `${encodeId(input.context)}:${diagnosticIndex(input.payloadRef)}`
    : diagnosticIndex(input.payloadRef);
  return leafNode({
    id: `diagnostic:${input.source}:${input.code}:${idSuffix}`,
    label: input.code,
    kind: 'diagnostic',
    status: input.status ?? (input.blocking ? 'changed' : 'equal'),
    leftValue: input.path ?? '',
    rightValue: input.message,
    mergeable: false,
    payloadRef: input.payloadRef,
    mergeState: input.blocking
      ? {
          state: 'blocked',
          reason: input.message,
        }
      : undefined,
  });
}

function compareMessageStatus(message: CompareMessage): CompareTreeStatus {
  switch (message.code) {
    case 'BSL_MODULE_LEFT_ONLY':
      return 'leftOnly';
    case 'BSL_MODULE_RIGHT_ONLY':
      return 'rightOnly';
    default:
      return message.blocking ? 'changed' : 'equal';
  }
}

function createBslMergeState(
  input: BslRoutineDiffProjectionInput,
  blockingDiagnostics: readonly BslModuleDiagnostic[]
): CompareTreeMergeState {
  if (blockingDiagnostics.length > 0) {
    return {
      state: 'blocked',
      reason: blockingDiagnostics.map((diagnostic) => diagnostic.message).join('\n'),
    };
  }
  if (!input.targetFilePath) {
    return {
      state: 'blocked',
      reason: 'Target BSL module file is not resolved.',
    };
  }
  if (input.targetAmbiguous) {
    return {
      state: 'blocked',
      reason: 'Target BSL module file is ambiguous.',
    };
  }

  return {
    state: 'ready',
    targetFilePath: input.targetFilePath,
  };
}

function isBslRoutineMergeable(
  status: BslRoutineDiffStatus,
  mergeState: CompareTreeMergeState,
  nodeId: string,
  mergeableRoutineIds: ReadonlySet<string> | undefined
): boolean {
  if (mergeableRoutineIds) {
    return mergeState.state === 'ready' && mergeableRoutineIds.has(nodeId);
  }

  return status === 'changed' && mergeState.state === 'ready';
}

function nonMergeableState(
  mergeState: CompareTreeMergeState,
  status?: BslRoutineDiffStatus
): CompareTreeMergeState | undefined {
  if (mergeState.state !== 'ready') {
    return mergeState;
  }
  if (status === 'added' || status === 'deleted' || status === 'reordered') {
    return {
      state: 'readOnly',
      reason: 'Structural BSL routine changes are visible but require manual merge in this mode.',
      targetFilePath: mergeState.targetFilePath,
    };
  }

  return undefined;
}

function routineStatus(status: BslRoutineDiffStatus): CompareTreeStatus {
  switch (status) {
    case 'added':
      return 'rightOnly';
    case 'deleted':
      return 'leftOnly';
    case 'changed':
    case 'reordered':
      return 'changed';
    case 'unchanged':
      return 'equal';
    default:
      return assertNever(status);
  }
}

function routineSummary(kind: string, index: number | undefined): string {
  return index === undefined ? kind : `${kind} #${index + 1}`;
}

function leafNode(input: Omit<CompareTreeNode, 'children'>): CompareTreeNode {
  return {
    ...input,
    children: [],
  };
}

function branchNode(
  id: string,
  label: string,
  kind: string,
  children: CompareTreeNode[]
): CompareTreeNode {
  return {
    id,
    label,
    kind,
    status: summarizeChildren(children),
    children,
  };
}

function summarizeChildren(children: readonly CompareTreeNode[]): CompareTreeStatus {
  return children.some((child) => child.status !== 'equal') ? 'changed' : 'equal';
}

function collectStats(root: CompareTreeNode): CompareTreeStats {
  const stats: CompareTreeStats = { total: 0, different: 0, mergeable: 0 };
  visit(root, (node) => {
    if (node.id !== root.id) {
      stats.total += 1;
    }
    if (node.status !== 'equal' && (node.children.length === 0 || node.mergeable === false)) {
      stats.different += 1;
    }
    if (node.mergeable) {
      stats.mergeable += 1;
    }
  });
  return stats;
}

function visit(node: CompareTreeNode, callback: (node: CompareTreeNode) => void): void {
  callback(node);
  for (const child of node.children) {
    visit(child, callback);
  }
}

function identitySummary(identity: MetadataIdentity | undefined): string {
  if (!identity) {
    return '';
  }
  return [identity.qualifiedName, identity.uuid].filter(Boolean).join(' ');
}

function stableIdentityConflictKey(conflict: IdentityConflict): string {
  const conflictContext = stableDiagnosticKey([
    ['kind', conflict.kind],
    ['side', conflict.side],
    ['sourceId', conflict.sourceId],
    ['metadataType', conflict.metadataType],
    ['qualifiedName', conflict.qualifiedName],
    ['uuid', conflict.uuid],
  ]);
  const identityContexts = [
    conflict.left,
    conflict.right,
    ...conflict.identities,
  ]
    .map(identityConflictContext)
    .filter((part): part is string => Boolean(part));
  return [
    conflictContext,
    ...[...new Set(identityContexts)].sort().map((context) => `identity:${context}`),
  ]
    .filter(Boolean)
    .join(';');
}

function identityConflictContext(identity: MetadataIdentity | undefined): string | undefined {
  if (!identity) {
    return undefined;
  }
  return stableDiagnosticKey([
    ['side', identity.side],
    ['sourceId', identity.sourceId],
    ['qualifiedName', identity.qualifiedName],
    ['uuid', identity.uuid],
  ]);
}

function metadataDiagnosticIdentitiesContext(identities: readonly MetadataIdentity[]): string | undefined {
  if (identities.length === 0) {
    return undefined;
  }
  return [...identities]
    .map((identity) =>
      stableDiagnosticKey([
        ['sourceId', identity.sourceId],
        ['side', identity.side],
        ['path', identity.filePath],
        ['qualifiedName', identity.qualifiedName],
        ['uuid', identity.uuid],
      ])
    )
    .sort()
    .join(',');
}

function bslRangeContext(range: BslModuleDiagnostic['range']): string | undefined {
  if (!range) {
    return undefined;
  }
  return `${range.startLine}:${range.startColumn}-${range.endLine}:${range.endColumn}`;
}

function hashStableMessage(message: string): string {
  const normalized = normalizeStableIdPart(message).replace(/\s+/g, ' ');
  let hash = 2166136261;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function stableDiagnosticKey(parts: ReadonlyArray<readonly [string, string | undefined]>): string {
  return parts
    .filter((part): part is readonly [string, string] => Boolean(part[1]))
    .map(([name, value]) => `${name}=${encodeId(normalizeStableIdPart(value))}`)
    .join(';');
}

function normalizeStableIdPart(value: string): string {
  return value.trim().replace(/\\/g, '/');
}

function diagnosticIndex(payloadRef: string): string {
  return payloadRef.slice(payloadRef.lastIndexOf(':') + 1);
}

function encodeId(value: string): string {
  return encodeURIComponent(value);
}

function requireDiff(input: BslRoutineDiffProjectionInput): BslRoutineDiffResult {
  if (!input.diff) {
    throw new Error('BSL routine diff projection requires diff.');
  }
  return input.diff;
}

function assertNever(value: never): never {
  throw new Error(`Unexpected BSL routine diff status: ${String(value)}`);
}
