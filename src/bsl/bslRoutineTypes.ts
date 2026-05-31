export type BslRoutineKind = 'procedure' | 'function';

export type BslRoutineDiagnosticCode =
  | 'duplicate-routine'
  | 'nested-routine'
  | 'unexpected-end'
  | 'unclosed-routine';

export type BslRoutineDiagnosticSeverity = 'warning' | 'error';

export interface BslTextRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface BslRoutineInfo {
  name: string;
  normalizedName: string;
  kind: BslRoutineKind;
  range: BslTextRange;
  signatureRange: BslTextRange;
  bodyRange: BslTextRange;
  bodyHash: string;
  exported: boolean;
  directives: string[];
  parameterText: string;
}

export interface BslRoutineDiagnostic {
  code: BslRoutineDiagnosticCode;
  severity: BslRoutineDiagnosticSeverity;
  message: string;
  range: BslTextRange;
  routineName?: string;
}

export interface BslRoutineParseResult {
  routines: BslRoutineInfo[];
  diagnostics: BslRoutineDiagnostic[];
}
