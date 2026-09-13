export type QueryMetadataNodeType =
  | 'category'
  | 'table'
  | 'virtualTable'
  | 'tabularSection'
  | 'field'
  | 'tempTable';

export interface VirtualTableParamDefinition {
  name: string; // e.g. "Период", "Условие", "НачалоПериода", "КонецПериода", "Периодичность"
  description: string;
  defaultValue?: string;
}

export interface QueryMetadataNode {
  id: string; // уникальный путь: "Catalog.Номенклатура", "Catalog.Номенклатура.Code"
  name: string; // "Номенклатура"
  fullName: string; // "Справочник.Номенклатура" или "РегистрНакопления.ОстаткиНоменклатуры.Остатки"
  label: string; // "Номенклатура"
  synonym?: string;
  nodeType: QueryMetadataNodeType;
  dataType?: string;
  isVirtual?: boolean;
  params?: VirtualTableParamDefinition[];
  children?: QueryMetadataNode[];
  hasChildren?: boolean;
  parentTableFullName?: string; // "Справочник.Номенклатура"
  parentTableName?: string;     // "Номенклатура"
  fieldName?: string;           // "Код", "Ссылка"
}

export interface TempTableDefinition {
  name: string;
  fields: { name: string; alias?: string; dataType?: string }[];
}
