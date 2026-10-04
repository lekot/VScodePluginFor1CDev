/**
 * Named inline ChildObjects confirmed by the 1C metadata XML spec or checked-in configuration samples.
 * Root types not listed here remain represented by their existing dedicated tree sections.
 */
export const INLINE_METADATA_CHILD_TYPES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  ExternalDataSource: ['Table', 'Function'],
  Table: ['Field'],
  HTTPService: ['URLTemplate'],
  URLTemplate: ['Method'],
  WebService: ['Operation'],
  Operation: ['Parameter'],
  IntegrationService: ['IntegrationServiceChannel'],
  Task: ['AddressingAttribute'],
  ChartOfAccounts: ['AccountingFlag', 'ExtDimensionAccountingFlag'],
  DocumentJournal: ['Column'],
  Sequence: ['Dimension'],
});
