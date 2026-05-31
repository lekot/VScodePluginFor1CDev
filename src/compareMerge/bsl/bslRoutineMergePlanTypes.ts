import type { BslRoutineInfo, BslRoutineKind, BslTextRange } from '../../bsl/bslRoutineTypes';

export type BslRoutineLogicalNodeKind = 'if' | 'loop' | 'try' | 'statementGroup';
export type BslRoutineLogicalDiagnosticCode =
  | 'preprocessor-directive'
  | 'one-line-block'
  | 'compound-statement'
  | 'unmatched-block-end'
  | 'unclosed-block'
  | 'unsupported-control-flow';

export type BslRoutineLogicalManualReason =
  | 'scanner-diagnostic'
  | 'changed-existing-node'
  | 'unsupported-inserted-node'
  | 'ambiguous-anchor'
  | 'statement-group-anchor'
  | 'anchor-changed'
  | 'interval-material-changed'
  | 'routine-identity-changed'
  | 'module-identity-changed'
  | 'plan-not-executable'
  | 'operation-provenance-changed'
  | 'operation-anchor-mismatch'
  | 'operation-source-text-changed'
  | 'missing-section'
  | 'missing-anchor'
  | 'invalid-anchor'
  | 'anchor-order-changed'
  | 'no-logical-insertion';

export type BslRoutineLogicalSentinelKind = 'section-start' | 'section-end';
export type BslRoutineLogicalMergePlanStatus = 'auto' | 'manual';

export interface BslRoutineLogicalDiagnostic {
  code: BslRoutineLogicalDiagnosticCode;
  message: string;
  range: BslTextRange;
}

export interface BslRoutineLogicalSectionRef {
  id: string;
  kind: string;
}

export interface BslRoutineLogicalNode {
  kind: BslRoutineLogicalNodeKind;
  path: string;
  parentPath: string;
  sectionId: string;
  range: BslTextRange;
  text: string;
  textHash: string;
  shapeHash: string;
  sections: BslRoutineLogicalSectionRef[];
}

export interface BslRoutineLogicalSection {
  id: string;
  parentPath: string;
  kind: string;
  startLine: number;
  endLine: number;
  nodes: BslRoutineLogicalNode[];
}

export interface BslRoutineLogicalOutline {
  rootSectionId: string;
  routinePath: string;
  sections: Record<string, BslRoutineLogicalSection>;
  nodesByPath: Record<string, BslRoutineLogicalNode>;
}

export interface BslRoutineLogicalScanResult {
  outline: BslRoutineLogicalOutline;
  diagnostics: BslRoutineLogicalDiagnostic[];
  canAutoMerge: boolean;
  eol: string;
}

export interface BslRoutineLogicalSnapshot {
  source: string;
  routine: BslRoutineInfo;
}

export interface BslRoutineLogicalRoutineProvenance {
  normalizedName: string;
  kind: BslRoutineKind;
  signatureHash: string;
  directivesHash: string;
  exported: boolean;
}

export interface BslRoutineLogicalAnchorBase {
  parentPath: string;
  sectionId: string;
}

export interface BslRoutineLogicalNodeAnchor extends BslRoutineLogicalAnchorBase {
  kind: 'node';
  nodeKind: BslRoutineLogicalNodeKind;
  path: string;
  textHash: string;
  shapeHash: string;
}

export interface BslRoutineLogicalSentinelAnchor extends BslRoutineLogicalAnchorBase {
  kind: 'sentinel';
  sentinel: BslRoutineLogicalSentinelKind;
}

export type BslRoutineLogicalAnchor =
  | BslRoutineLogicalNodeAnchor
  | BslRoutineLogicalSentinelAnchor;

export interface BslRoutineLogicalOperation {
  kind: 'insertBlock';
  moduleId: string;
  routine: BslRoutineLogicalRoutineProvenance;
  parentPath: string;
  sectionId: string;
  startAnchor: BslRoutineLogicalAnchor;
  endAnchor: BslRoutineLogicalAnchor;
  sourceRange: BslTextRange;
  sourceText: string;
  sourceTextHash: string;
  targetIntervalMaterialHash: string;
  eol: string;
}

export interface BslRoutineLogicalManualDiagnostic {
  reason: BslRoutineLogicalManualReason;
  message: string;
  range?: BslTextRange;
}

export interface BslRoutineLogicalMergePlan {
  kind: 'logicalRoutineMergePlan';
  status: BslRoutineLogicalMergePlanStatus;
  moduleId: string;
  routine: BslRoutineLogicalRoutineProvenance;
  eol: string;
  operations: BslRoutineLogicalOperation[];
  diagnostics: BslRoutineLogicalManualDiagnostic[];
}

export interface BslRoutineLogicalMergePlanInput {
  moduleId: string;
  base: BslRoutineLogicalSnapshot;
  current: BslRoutineLogicalSnapshot;
  incoming: BslRoutineLogicalSnapshot;
}

export interface BslRoutineLogicalGuardInput {
  moduleId: string;
  current: BslRoutineLogicalSnapshot;
}

export interface BslRoutineLogicalGuardResult {
  ok: boolean;
  diagnostics: BslRoutineLogicalManualDiagnostic[];
}
