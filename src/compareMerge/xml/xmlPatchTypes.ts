/** Closed, DOM-validated ordering profiles accepted by semantic XML patches. */
export type XmlOrderScope =
  | {
      kind: 'metadataChildObjects';
      elementKind:
        | 'EnumValue'
        | 'Attribute'
        | 'TabularSection'
        | 'Dimension'
        | 'Resource'
        | 'AddressingAttribute'
        | 'AccountingFlag'
        | 'ExtDimensionAccountingFlag'
        | 'URLTemplate'
        | 'Method'
        | 'Operation'
        | 'Parameter';
    }
  | {
      kind: 'formSection';
      section: 'Attributes' | 'Commands' | 'Parameters';
    };
