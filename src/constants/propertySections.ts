/**
 * Configuration of property sections per metadata type for the Properties panel.
 * Sections define grouping and order of properties; properties not in any section go to "Прочее".
 */
import { MetadataType } from '../models/treeNode';

export interface PropertySection {
  title: string;
  propertyNames: string[];
}

/** Section title for properties not listed in any type-specific section */
export const OTHER_SECTION_TITLE = 'Прочее';

/** Default section when no type-specific config: all properties in one block */
export const DEFAULT_SECTION_TITLE = 'Свойства';

const CATALOG_SECTIONS: PropertySection[] = [
  {
    title: 'Основные',
    propertyNames: ['Name', 'Synonym', 'Comment'],
  },
  {
    title: 'Иерархия',
    propertyNames: [
      'Hierarchical',
      'HierarchyType',
      'LimitLevelCount',
      'LevelCount',
      'FoldersOnTop',
      'UseStandardCommands',
      'Owners',
      'SubordinationUse',
    ],
  },
  {
    title: 'Нумерация и коды',
    propertyNames: [
      'CodeLength',
      'DescriptionLength',
      'CodeType',
      'CodeAllowedLength',
      'CodeSeries',
      'CheckUnique',
      'Autonumbering',
      'DefaultPresentation',
    ],
  },
  {
    title: 'Формы и представления',
    propertyNames: [
      'DefaultObjectForm',
      'DefaultFolderForm',
      'DefaultListForm',
      'DefaultChoiceForm',
      'DefaultFolderChoiceForm',
      'AuxiliaryObjectForm',
      'AuxiliaryFolderForm',
      'AuxiliaryListForm',
      'AuxiliaryChoiceForm',
      'AuxiliaryFolderChoiceForm',
      'ObjectPresentation',
      'ExtendedObjectPresentation',
      'ListPresentation',
      'ExtendedListPresentation',
      'Explanation',
    ],
  },
  {
    title: 'Поведение и блокировки',
    propertyNames: [
      'Characteristics',
      'PredefinedDataUpdate',
      'EditType',
      'QuickChoice',
      'ChoiceMode',
      'InputByString',
      'SearchStringModeOnInputByString',
      'FullTextSearchOnInputByString',
      'ChoiceDataGetModeOnInputByString',
      'IncludeHelpInContents',
      'BasedOn',
      'DataLockFields',
      'DataLockControlMode',
      'FullTextSearch',
      'CreateOnInput',
      'ChoiceHistoryOnInput',
      'DataHistory',
      'UpdateDataHistoryImmediatelyAfterWrite',
      'ExecuteAfterWriteDataHistoryVersionProcessing',
    ],
  },
];

const DOCUMENT_SECTIONS: PropertySection[] = [
  {
    title: 'Основные',
    propertyNames: ['Name', 'Synonym', 'Comment'],
  },
  {
    title: 'Нумерация',
    propertyNames: [
      'NumberType',
      'NumberLength',
      'NumberAllowedLength',
      'NumberPeriodicity',
      'CheckUnique',
      'Autonumbering',
    ],
  },
  {
    title: 'Формы и представления',
    propertyNames: [
      'DefaultObjectForm',
      'DefaultListForm',
      'DefaultChoiceForm',
      'AuxiliaryObjectForm',
      'AuxiliaryListForm',
      'AuxiliaryChoiceForm',
    ],
  },
  {
    title: 'Поведение и блокировки',
    propertyNames: [
      'BasedOn',
      'DataLockControlMode',
      'CreateOnInput',
      'ChoiceHistoryOnInput',
    ],
  },
];

const REGISTER_SECTIONS: PropertySection[] = [
  {
    title: 'Основные',
    propertyNames: ['Name', 'Synonym', 'Comment'],
  },
  {
    title: 'Регистр',
    propertyNames: [
      'MainMode',
      'Periodicity',
      'WriteMode',
      'UseStandardCommands',
      'DataLockControlMode',
      'FullTextSearch',
    ],
  },
];

const ATTRIBUTE_SECTIONS: PropertySection[] = [
  {
    title: 'Основные',
    propertyNames: ['Name', 'Synonym', 'Comment', 'Type'],
  },
  {
    title: 'Отображение и ввод',
    propertyNames: [
      'PasswordMode',
      'Format',
      'EditFormat',
      'ToolTip',
      'Mask',
      'MultiLine',
      'ExtendedEdit',
      'MarkNegatives',
      'MinValue',
      'MaxValue',
    ],
  },
  {
    title: 'Заполнение и выбор',
    propertyNames: [
      'FillFromFillingValue',
      'FillValue',
      'FillChecking',
      'ChoiceFoldersAndItems',
      'ChoiceParameterLinks',
      'QuickChoice',
      'CreateOnInput',
      'ChoiceForm',
      'LinkByType',
      'ChoiceHistoryOnInput',
    ],
  },
  {
    title: 'Индексирование и поиск',
    propertyNames: ['Indexing', 'FullTextSearch', 'DataHistory'],
  },
];

const TABULAR_SECTION_SECTIONS: PropertySection[] = [
  {
    title: 'Основные',
    propertyNames: ['Name', 'Synonym', 'Comment'],
  },
];

/** Map MetadataType to optional list of sections; empty or missing = use default (one "Свойства" block) */
const SECTIONS_BY_TYPE: Partial<Record<MetadataType, PropertySection[]>> = {
  [MetadataType.Catalog]: CATALOG_SECTIONS,
  [MetadataType.Document]: DOCUMENT_SECTIONS,
  [MetadataType.InformationRegister]: REGISTER_SECTIONS,
  [MetadataType.AccumulationRegister]: REGISTER_SECTIONS,
  [MetadataType.AccountingRegister]: REGISTER_SECTIONS,
  [MetadataType.CalculationRegister]: REGISTER_SECTIONS,
  [MetadataType.Attribute]: ATTRIBUTE_SECTIONS,
  [MetadataType.TabularSection]: TABULAR_SECTION_SECTIONS,
};

/**
 * Returns ordered sections for the given metadata type.
 * If type has no config or config is empty, returns one section with title DEFAULT_SECTION_TITLE and no propertyNames
 * (all properties will be rendered in that single block or in "Прочее" depending on implementation).
 */
export function getPropertySectionsForType(metadataType: MetadataType): PropertySection[] {
  const sections = SECTIONS_BY_TYPE[metadataType];
  if (sections && sections.length > 0) {
    return sections;
  }
  return [{ title: DEFAULT_SECTION_TITLE, propertyNames: [] }];
}

/**
 * Returns set of property names that are explicitly listed in any section for the type.
 * Used to determine which properties go to "Прочее".
 */
export function getKnownPropertyNamesForType(metadataType: MetadataType): Set<string> {
  const sections = SECTIONS_BY_TYPE[metadataType];
  if (!sections || sections.length === 0) {
    return new Set();
  }
  const set = new Set<string>();
  for (const sec of sections) {
    for (const name of sec.propertyNames) {
      set.add(name);
    }
  }
  return set;
}
