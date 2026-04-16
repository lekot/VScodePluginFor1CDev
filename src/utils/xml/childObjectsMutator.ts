/**
 * Builders for Designer {@link MetaDataObject} ChildObjects children beyond Attribute/TabularSection
 * (EnumValue, Dimension, Resource). Used by xmlChildObjectsMutations / elementOperations.
 */
import { MetadataType } from '../../models/treeNode';
import { generateSimpleUuid } from './xmlHelpers';

function ruSynonymItem(content: string): Record<string, unknown> {
  return {
    'v8:item': [
      {
        'v8:lang': [{ '#text': 'ru' }],
        'v8:content': [{ '#text': content }],
      },
    ],
  };
}

function stringTypeBlock(): Record<string, unknown> {
  return {
    Type: [
      {
        'v8:Type': [{ '#text': 'xs:string' }],
        'v8:StringQualifiers': [
          {
            'v8:Length': [{ '#text': '150' }],
            'v8:AllowedLength': [{ '#text': 'Variable' }],
          },
        ],
      },
    ],
  };
}

function decimalTypeBlock(fractionDigits: '2' | '3' = '3'): Record<string, unknown> {
  return {
    Type: [
      {
        'v8:Type': [{ '#text': 'xs:decimal' }],
        'v8:NumberQualifiers': [
          {
            'v8:Digits': [{ '#text': '15' }],
            'v8:FractionDigits': [{ '#text': fractionDigits }],
            'v8:AllowedSign': [{ '#text': 'Any' }],
          },
        ],
      },
    ],
  };
}

/** Minimal EnumValue block for Enum.xml ChildObjects (Designer). */
export function buildDesignerEnumValueBlock(elementName: string): Record<string, unknown> {
  const uuid = generateSimpleUuid();
  return {
    EnumValue: {
      '@_uuid': uuid,
      Properties: {
        Name: elementName,
        Synonym: [ruSynonymItem(elementName)],
        Comment: '',
      },
    },
  };
}

function commonDimensionProps(
  elementName: string,
  extra: Record<string, unknown>
): Record<string, unknown> {
  return {
    Name: elementName,
    Synonym: [ruSynonymItem(elementName)],
    Comment: '',
    ...stringTypeBlock(),
    PasswordMode: false,
    Format: '',
    EditFormat: '',
    ToolTip: '',
    MarkNegatives: false,
    Mask: '',
    MultiLine: false,
    ExtendedEdit: false,
    MinValue: { '@_xsi:nil': 'true' },
    MaxValue: { '@_xsi:nil': 'true' },
    FillChecking: 'DontCheck',
    ChoiceFoldersAndItems: 'Items',
    ChoiceParameterLinks: '',
    ChoiceParameters: '',
    QuickChoice: 'Auto',
    CreateOnInput: 'Auto',
    ChoiceForm: '',
    LinkByType: '',
    ChoiceHistoryOnInput: 'Auto',
    ...extra,
  };
}

/** Dimension for InformationRegister (and similar non-accumulation registers). */
function buildInformationRegisterDimensionProperties(
  elementName: string,
  isMaster: boolean
): Record<string, unknown> {
  return commonDimensionProps(elementName, {
    FillFromFillingValue: false,
    FillValue: { '@_xsi:nil': 'true' },
    Master: isMaster,
    MainFilter: isMaster,
    DenyIncompleteValues: false,
    Indexing: 'DontIndex',
    FullTextSearch: 'Use',
    DataHistory: 'Use',
    TypeReductionMode: 'TransformValues',
  });
}

/** Dimension for AccumulationRegister. */
function buildAccumulationRegisterDimensionProperties(elementName: string): Record<string, unknown> {
  return commonDimensionProps(elementName, {
    DenyIncompleteValues: false,
    Indexing: 'DontIndex',
    FullTextSearch: 'Use',
    UseInTotals: true,
  });
}

/** Dimension for AccountingRegister (Balance / AccountingFlag required). */
function buildAccountingRegisterDimensionProperties(
  elementName: string,
  isFirst: boolean
): Record<string, unknown> {
  return commonDimensionProps(elementName, {
    Balance: isFirst,
    AccountingFlag: '',
    DenyIncompleteValues: false,
    Indexing: 'DontIndex',
    FullTextSearch: 'Use',
  });
}

/** Dimension for CalculationRegister (BaseDimension / ScheduleLink). */
function buildCalculationRegisterDimensionProperties(
  elementName: string,
  isBase: boolean
): Record<string, unknown> {
  return commonDimensionProps(elementName, {
    DenyIncompleteValues: true,
    BaseDimension: isBase,
    ScheduleLink: '',
    Indexing: 'DontIndex',
    FullTextSearch: 'Use',
  });
}

export function buildDesignerDimensionBlock(
  elementName: string,
  parentRootType: MetadataType | undefined,
  isPrimaryDimension: boolean
): Record<string, unknown> {
  const uuid = generateSimpleUuid();
  let props: Record<string, unknown>;
  switch (parentRootType) {
    case MetadataType.AccumulationRegister:
      props = buildAccumulationRegisterDimensionProperties(elementName);
      break;
    case MetadataType.AccountingRegister:
      props = buildAccountingRegisterDimensionProperties(elementName, isPrimaryDimension);
      break;
    case MetadataType.CalculationRegister:
      props = buildCalculationRegisterDimensionProperties(elementName, isPrimaryDimension);
      break;
    case MetadataType.InformationRegister:
    default:
      props = buildInformationRegisterDimensionProperties(elementName, isPrimaryDimension);
      break;
  }
  return {
    Dimension: {
      '@_uuid': uuid,
      Properties: props,
    },
  };
}

function commonResourceProps(
  elementName: string,
  fractionDigits: '2' | '3',
  extra: Record<string, unknown>
): Record<string, unknown> {
  return {
    Name: elementName,
    Synonym: [ruSynonymItem(elementName)],
    Comment: '',
    ...decimalTypeBlock(fractionDigits),
    PasswordMode: false,
    Format: '',
    EditFormat: '',
    ToolTip: '',
    MarkNegatives: false,
    Mask: '',
    MultiLine: false,
    ExtendedEdit: false,
    MinValue: { '@_xsi:nil': 'true' },
    MaxValue: { '@_xsi:nil': 'true' },
    FillChecking: 'DontCheck',
    ChoiceFoldersAndItems: 'Items',
    ChoiceParameterLinks: '',
    ChoiceParameters: '',
    QuickChoice: 'Auto',
    CreateOnInput: 'Auto',
    ChoiceForm: '',
    LinkByType: '',
    ChoiceHistoryOnInput: 'Auto',
    ...extra,
  };
}

/** Resource for InformationRegister. */
function buildInformationRegisterResourceProperties(elementName: string): Record<string, unknown> {
  return commonResourceProps(elementName, '3', {
    FillFromFillingValue: false,
    FillValue: { '@_xsi:nil': 'true' },
    Indexing: 'DontIndex',
    FullTextSearch: 'Use',
    DataHistory: 'Use',
  });
}

/** Resource for AccumulationRegister (no DataHistory / FillFromFillingValue on resource in template). */
function buildAccumulationRegisterResourceProperties(elementName: string): Record<string, unknown> {
  return commonResourceProps(elementName, '3', {
    FullTextSearch: 'Use',
  });
}

/** Resource for CalculationRegister (Designer sample: 2 fraction digits, no balance flags). */
function buildCalculationRegisterResourceProperties(elementName: string): Record<string, unknown> {
  return commonResourceProps(elementName, '2', {
    FullTextSearch: 'Use',
  });
}

/**
 * Resource for AccountingRegister (Balance / flags; ExtDimensionAccountingFlag references the chart).
 */
function buildAccountingRegisterResourceProperties(
  elementName: string,
  registerName: string
): Record<string, unknown> {
  const extFlag = registerName.trim()
    ? `ChartOfAccounts.${registerName}.ExtDimensionAccountingFlag.Суммовой`
    : '';
  return commonResourceProps(elementName, '2', {
    Balance: true,
    AccountingFlag: '',
    ExtDimensionAccountingFlag: extFlag,
    FullTextSearch: 'Use',
  });
}

export function buildDesignerResourceBlock(
  elementName: string,
  parentRootType: MetadataType | undefined,
  registerObjectName?: string
): Record<string, unknown> {
  const uuid = generateSimpleUuid();
  let props: Record<string, unknown>;
  switch (parentRootType) {
    case MetadataType.AccumulationRegister:
      props = buildAccumulationRegisterResourceProperties(elementName);
      break;
    case MetadataType.AccountingRegister:
      props = buildAccountingRegisterResourceProperties(elementName, registerObjectName ?? '');
      break;
    case MetadataType.CalculationRegister:
      props = buildCalculationRegisterResourceProperties(elementName);
      break;
    case MetadataType.InformationRegister:
    default:
      props = buildInformationRegisterResourceProperties(elementName);
      break;
  }
  return {
    Resource: {
      '@_uuid': uuid,
      Properties: props,
    },
  };
}
