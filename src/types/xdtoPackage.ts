export type XdtoDiagnosticSeverity = 'warning' | 'error';

export interface XdtoDiagnostic {
  severity: XdtoDiagnosticSeverity;
  code: string;
  message: string;
}

export type XdtoRawNode = Record<string, unknown>;

export interface XdtoUnknownNode {
  name: string;
  localName: string;
  raw: unknown;
}

export interface XdtoImport {
  namespace?: string;
  schemaLocation?: string;
  raw: XdtoRawNode;
}

export interface XdtoProperty {
  name: string;
  type?: string;
  minOccurs?: string;
  maxOccurs?: string;
  lowerBound?: string;
  upperBound?: string;
  form?: string;
  use?: string;
  raw: XdtoRawNode;
  unknownNodes: XdtoUnknownNode[];
}

export interface XdtoTypeDefinition {
  name: string;
  baseType?: string;
  properties: XdtoProperty[];
  attributes: XdtoProperty[];
  raw: XdtoRawNode;
  unknownNodes: XdtoUnknownNode[];
}

export interface XdtoPackageModel {
  targetNamespace?: string;
  imports: XdtoImport[];
  valueTypes: XdtoTypeDefinition[];
  objectTypes: XdtoTypeDefinition[];
  rootProperties: XdtoProperty[];
  diagnostics: XdtoDiagnostic[];
  rawRoot?: XdtoRawNode;
  unknownNodes: XdtoUnknownNode[];
}
