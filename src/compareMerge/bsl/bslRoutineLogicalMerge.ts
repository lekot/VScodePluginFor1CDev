import type { BslRoutineInfo } from '../../bsl/bslRoutineTypes';
import {
  detectEol,
  extractRangeText,
  hashText,
  materialBetweenAnchors,
  scanBslRoutineLogicalOutline,
} from './bslRoutineLogicalScanner';
import type {
  BslRoutineLogicalAnchor,
  BslRoutineLogicalManualDiagnostic,
  BslRoutineLogicalMergePlan,
  BslRoutineLogicalMergePlanInput,
  BslRoutineLogicalNode,
  BslRoutineLogicalOperation,
  BslRoutineLogicalRoutineProvenance,
  BslRoutineLogicalScanResult,
  BslRoutineLogicalSection,
  BslRoutineLogicalSnapshot,
} from './bslRoutineMergePlanTypes';

interface InsertionCandidate {
  sectionId: string;
  parentPath: string;
  insertIndex: number;
  insertedNodes: BslRoutineLogicalNode[];
  before?: BslRoutineLogicalNode;
  after?: BslRoutineLogicalNode;
}

export function createBslRoutineLogicalMergePlan(
  input: BslRoutineLogicalMergePlanInput
): BslRoutineLogicalMergePlan {
  const routine = routineProvenance(input.current.routine);
  const baseScan = scan(input.base);
  const currentScan = scan(input.current);
  const incomingScan = scan(input.incoming);
  const diagnostics: BslRoutineLogicalManualDiagnostic[] = [];

  collectScannerDiagnostics(baseScan, diagnostics);
  collectScannerDiagnostics(currentScan, diagnostics);
  collectScannerDiagnostics(incomingScan, diagnostics);

  if (!sameRoutine(input.base.routine, input.incoming.routine)) {
    diagnostics.push({
      reason: 'routine-identity-changed',
      message: 'Incoming routine identity does not match base routine.',
    });
  }
  if (!sameRoutine(input.base.routine, input.current.routine)) {
    diagnostics.push({
      reason: 'routine-identity-changed',
      message: 'Current routine identity does not match base routine.',
    });
  }

  const candidates = diagnostics.length === 0 ? findInsertionCandidates(baseScan, incomingScan, diagnostics) : [];
  const operations: BslRoutineLogicalOperation[] = [];

  if (diagnostics.length === 0 && candidates.length === 0) {
    diagnostics.push({
      reason: 'no-logical-insertion',
      message: 'No supported logical insertion was found.',
    });
  }

  for (const candidate of candidates) {
    const operation = createOperation(input, routine, candidate, baseScan, currentScan);
    if ('diagnostic' in operation) {
      diagnostics.push(operation.diagnostic);
    } else {
      operations.push(operation);
    }
  }

  return {
    kind: 'logicalRoutineMergePlan',
    status: diagnostics.length === 0 && operations.length > 0 ? 'auto' : 'manual',
    moduleId: input.moduleId,
    routine,
    eol: detectEol(input.current.source),
    operations: diagnostics.length === 0 ? operations : [],
    diagnostics,
  };
}

export function routineProvenance(routine: BslRoutineInfo): BslRoutineLogicalRoutineProvenance {
  return {
    normalizedName: routine.normalizedName,
    kind: routine.kind,
    signatureHash: hashText(`${routine.parameterText}:${routine.exported}`),
    directivesHash: hashText(routine.directives.join('\n')),
    exported: routine.exported,
  };
}

function scan(snapshot: BslRoutineLogicalSnapshot): BslRoutineLogicalScanResult {
  return scanBslRoutineLogicalOutline({
    source: snapshot.source,
    routine: snapshot.routine,
  });
}

function collectScannerDiagnostics(
  scanResult: BslRoutineLogicalScanResult,
  diagnostics: BslRoutineLogicalManualDiagnostic[]
): void {
  for (const diagnostic of scanResult.diagnostics) {
    diagnostics.push({
      reason: 'scanner-diagnostic',
      message: diagnostic.message,
      range: diagnostic.range,
    });
  }
}

function findInsertionCandidates(
  baseScan: BslRoutineLogicalScanResult,
  incomingScan: BslRoutineLogicalScanResult,
  diagnostics: BslRoutineLogicalManualDiagnostic[]
): InsertionCandidate[] {
  const candidates: InsertionCandidate[] = [];

  const sectionId = baseScan.outline.rootSectionId;
  const baseSection = baseScan.outline.sections[sectionId];
  const incomingSection = incomingScan.outline.sections[sectionId];
  if (!incomingSection) {
    diagnostics.push({
      reason: 'changed-existing-node',
      message: `Logical section "${sectionId}" changed or disappeared.`,
    });
    return candidates;
  }

  const sectionCandidate = diffSectionForInsertion(baseSection, incomingSection);
  if (sectionCandidate === 'changed') {
    diagnostics.push({
      reason: 'changed-existing-node',
      message: `Logical section "${sectionId}" contains edits to existing logic.`,
    });
    return candidates;
  }
  if (sectionCandidate) {
    candidates.push(sectionCandidate);
  }

  return candidates;
}

function diffSectionForInsertion(
  baseSection: BslRoutineLogicalSection,
  incomingSection: BslRoutineLogicalSection
): InsertionCandidate | 'changed' | undefined {
  const baseNodes = baseSection.nodes;
  const incomingNodes = incomingSection.nodes;
  let prefix = 0;
  while (
    prefix < baseNodes.length &&
    prefix < incomingNodes.length &&
    sameNodeIdentity(baseNodes[prefix], incomingNodes[prefix])
  ) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < baseNodes.length - prefix &&
    suffix < incomingNodes.length - prefix &&
    sameNodeIdentity(
      baseNodes[baseNodes.length - 1 - suffix],
      incomingNodes[incomingNodes.length - 1 - suffix]
    )
  ) {
    suffix++;
  }

  if (prefix === baseNodes.length && prefix === incomingNodes.length) {
    return undefined;
  }
  if (incomingNodes.length <= baseNodes.length) {
    return 'changed';
  }
  if (prefix + suffix !== baseNodes.length) {
    return 'changed';
  }

  const insertedNodes = incomingNodes.slice(prefix, incomingNodes.length - suffix);
  if (insertedNodes.length === 0) {
    return undefined;
  }
  return {
    sectionId: baseSection.id,
    parentPath: baseSection.parentPath,
    insertIndex: prefix,
    insertedNodes,
    before: prefix > 0 ? baseNodes[prefix - 1] : undefined,
    after: prefix < baseNodes.length ? baseNodes[prefix] : undefined,
  };
}

function createOperation(
  input: BslRoutineLogicalMergePlanInput,
  routine: BslRoutineLogicalRoutineProvenance,
  candidate: InsertionCandidate,
  baseScan: BslRoutineLogicalScanResult,
  currentScan: BslRoutineLogicalScanResult
):
  | BslRoutineLogicalOperation
  | {
      diagnostic: BslRoutineLogicalManualDiagnostic;
    } {
  const unsupported = candidate.insertedNodes.find((node) => node.kind === 'statementGroup');
  if (unsupported) {
    return {
      diagnostic: {
        reason: 'unsupported-inserted-node',
        message: 'Only inserted supported blocks can be merged automatically.',
        range: unsupported.range,
      },
    };
  }

  const startAnchor = candidate.before
    ? nodeAnchor(candidate.before)
    : sentinelAnchor(candidate.parentPath, candidate.sectionId, 'section-start');
  const endAnchor = candidate.after
    ? nodeAnchor(candidate.after)
    : sentinelAnchor(candidate.parentPath, candidate.sectionId, 'section-end');

  if (startAnchor.kind === 'node' && startAnchor.nodeKind === 'statementGroup') {
    return statementGroupAnchorDiagnostic(candidate.before);
  }
  if (endAnchor.kind === 'node' && endAnchor.nodeKind === 'statementGroup') {
    return statementGroupAnchorDiagnostic(candidate.after);
  }
  if (
    (startAnchor.kind === 'node' && !isAnchorUnique(baseScan, startAnchor)) ||
    (endAnchor.kind === 'node' && !isAnchorUnique(baseScan, endAnchor))
  ) {
    return {
      diagnostic: {
        reason: 'ambiguous-anchor',
        message: 'Neighboring logical anchor is not unique in its section.',
      },
    };
  }
  if (
    (startAnchor.kind === 'node' && !matchingAnchorExists(currentScan, startAnchor)) ||
    (endAnchor.kind === 'node' && !matchingAnchorExists(currentScan, endAnchor))
  ) {
    return {
      diagnostic: {
        reason: 'anchor-changed',
        message: 'Current target no longer contains the planned anchor.',
      },
    };
  }

  const interval = intervalMaterialFor(input.current, currentScan, startAnchor, endAnchor);
  if ('diagnostic' in interval) {
    return interval;
  }
  const baseInterval = intervalMaterialFor(input.base, baseScan, startAnchor, endAnchor);
  if ('diagnostic' in baseInterval) {
    return baseInterval;
  }
  if (hashText(interval.material) !== hashText(baseInterval.material)) {
    return {
      diagnostic: {
        reason: 'interval-material-changed',
        message: 'Current target interval between anchors changed.',
      },
    };
  }

  const firstNode = candidate.insertedNodes[0];
  const lastNode = candidate.insertedNodes[candidate.insertedNodes.length - 1];
  const sourceRange = {
    startLine: firstNode.range.startLine,
    startColumn: firstNode.range.startColumn,
    endLine: lastNode.range.endLine,
    endColumn: lastNode.range.endColumn,
  };
  const sourceText = extractRangeText(input.incoming.source, sourceRange);

  return {
    kind: 'insertBlock',
    moduleId: input.moduleId,
    routine,
    parentPath: candidate.parentPath,
    sectionId: candidate.sectionId,
    startAnchor,
    endAnchor,
    sourceRange,
    sourceText,
    sourceTextHash: hashText(sourceText),
    targetIntervalMaterialHash: hashText(baseInterval.material),
    eol: detectEol(input.current.source),
  };
}

function statementGroupAnchorDiagnostic(
  node: BslRoutineLogicalNode | undefined
): { diagnostic: BslRoutineLogicalManualDiagnostic } {
  return {
    diagnostic: {
      reason: 'statement-group-anchor',
      message: 'Statement groups are not safe neighboring anchors for automatic logical merge.',
      range: node?.range,
    },
  };
}

function sameRoutine(left: BslRoutineInfo, right: BslRoutineInfo): boolean {
  return (
    left.normalizedName === right.normalizedName &&
    left.kind === right.kind &&
    left.parameterText === right.parameterText &&
    left.exported === right.exported &&
    left.directives.join('\n') === right.directives.join('\n')
  );
}

function sameNodeIdentity(left: BslRoutineLogicalNode, right: BslRoutineLogicalNode): boolean {
  return left.kind === right.kind && left.textHash === right.textHash;
}

function nodeAnchor(node: BslRoutineLogicalNode): BslRoutineLogicalAnchor {
  return {
    kind: 'node',
    nodeKind: node.kind,
    path: node.path,
    parentPath: node.parentPath,
    sectionId: node.sectionId,
    textHash: node.textHash,
    shapeHash: node.shapeHash,
  };
}

function sentinelAnchor(
  parentPath: string,
  sectionId: string,
  sentinel: 'section-start' | 'section-end'
): BslRoutineLogicalAnchor {
  return {
    kind: 'sentinel',
    parentPath,
    sectionId,
    sentinel,
  };
}

function isAnchorUnique(
  scanResult: BslRoutineLogicalScanResult,
  anchor: Extract<BslRoutineLogicalAnchor, { kind: 'node' }>
): boolean {
  const section = scanResult.outline.sections[anchor.sectionId];
  return (
    section.nodes.filter(
      (node) => node.kind === anchor.nodeKind && node.textHash === anchor.textHash
    ).length === 1
  );
}

function matchingAnchorExists(
  scanResult: BslRoutineLogicalScanResult,
  anchor: Extract<BslRoutineLogicalAnchor, { kind: 'node' }>
): boolean {
  const node = scanResult.outline.nodesByPath[anchor.path];
  return (
    node !== undefined &&
    node.kind === anchor.nodeKind &&
    node.textHash === anchor.textHash &&
    node.shapeHash === anchor.shapeHash &&
    node.parentPath === anchor.parentPath &&
    node.sectionId === anchor.sectionId
  );
}

function intervalMaterialFor(
  snapshot: BslRoutineLogicalSnapshot,
  scanResult: BslRoutineLogicalScanResult,
  startAnchor: BslRoutineLogicalAnchor,
  endAnchor: BslRoutineLogicalAnchor
): { material: string } | { diagnostic: BslRoutineLogicalManualDiagnostic } {
  const startLine = anchorEndLine(scanResult, startAnchor);
  const endLine = anchorStartLine(snapshot.routine, scanResult, endAnchor);
  if (startLine === undefined || endLine === undefined) {
    return {
      diagnostic: {
        reason: 'missing-anchor',
        message: 'Cannot resolve planned anchor in current outline.',
      },
    };
  }
  if (startLine > endLine + 1) {
    return {
      diagnostic: {
        reason: 'anchor-order-changed',
        message: 'Planned anchors are no longer in the expected order.',
      },
    };
  }
  return {
    material: materialBetweenAnchors(snapshot.source, snapshot.routine, startLine + 1, endLine - 1),
  };
}

function anchorEndLine(
  scanResult: BslRoutineLogicalScanResult,
  anchor: BslRoutineLogicalAnchor
): number | undefined {
  if (anchor.kind === 'sentinel') {
    return anchor.sentinel === 'section-start'
      ? scanResult.outline.sections[anchor.sectionId]?.startLine - 1
      : scanResult.outline.sections[anchor.sectionId]?.endLine;
  }
  return scanResult.outline.nodesByPath[anchor.path]?.range.endLine;
}

function anchorStartLine(
  routine: BslRoutineInfo,
  scanResult: BslRoutineLogicalScanResult,
  anchor: BslRoutineLogicalAnchor
): number | undefined {
  if (anchor.kind === 'sentinel') {
    return anchor.sentinel === 'section-start'
      ? scanResult.outline.sections[anchor.sectionId]?.startLine
      : routine.range.endLine;
  }
  return scanResult.outline.nodesByPath[anchor.path]?.range.startLine;
}
