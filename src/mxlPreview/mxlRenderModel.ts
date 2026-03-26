export type MxlDiagnosticLevel = 'warning' | 'error';

export interface MxlDiagnostic {
  level: MxlDiagnosticLevel;
  code: string;
  message: string;
  path?: string;
}

export interface MxlCellStyle {
  fontFamily?: string;
  fontSizePt?: number;
  bold?: boolean;
  italic?: boolean;
  horizontalAlign?: string;
  verticalAlign?: string;
  backgroundColor?: string;
  border?: string;
}

export interface MxlRenderCell {
  row: number;
  col: number;
  text: string;
  rowspan: number;
  colspan: number;
  style?: MxlCellStyle;
}

export interface MxlRenderTable {
  rowCount: number;
  colCount: number;
  cells: MxlRenderCell[];
}

export interface MxlRenderModel {
  version: 'v1';
  tables: MxlRenderTable[];
  diagnostics: MxlDiagnostic[];
}
