// src/agent/types.ts
// Agent API — публичные типы для команд агента. Без зависимостей от vscode.

export interface AgentResult<T = void> {
    success: boolean;
    data?: T;
    error?: string;
}

export interface CreateObjectParams {
    /** Тип объекта: 'Catalog', 'Document', 'Enum', 'CommonModule', 'Subsystem' */
    type: string;
    name: string;
    synonym?: string;
    properties?: Record<string, unknown>;
}

export interface GetYamlParams {
    /** Путь вида 'Catalog.Товары' */
    path: string;
}

export interface ListObjectsParams {
    /** Если не задан — все типы */
    type?: string;
}

export interface ObjectInfo {
    type: string;
    name: string;
    filePath: string;
}

export interface ResolvedAgentPath {
    /** Root metadata tag, e.g. 'Catalog', 'ChartOfAccounts' */
    rootTag: string;
    /** Object name, e.g. 'Товары' */
    objectName: string;
    /** Absolute path to the object XML file */
    filePath: string;
    /** For 4-segment and 6-segment paths: the nested element type, e.g. 'Attribute' */
    nestedType?: string;
    /** For 4-segment and 6-segment paths: the nested element name */
    nestedName?: string;
    /** For 6-segment paths: the tabular section name */
    tabularSection?: string;
}

export interface AddAttributeParams {
    /** Agent path, e.g. 'Catalog.Товары' */
    path: string;
    name: string;
}

export interface AddTabularSectionParams {
    /** Agent path, e.g. 'Catalog.Товары' */
    path: string;
    name: string;
}

export interface AddTabularSectionColumnParams {
    /** Agent path, e.g. 'Catalog.Товары.TabularSection.Состав' */
    path: string;
    name: string;
}

export interface DeleteAttributeParams {
    /** Agent path to attribute, e.g. 'Catalog.Товары.Attribute.Цена' */
    path: string;
}

export interface DeleteTabularSectionParams {
    /** Agent path to tabular section, e.g. 'Catalog.Товары.TabularSection.Состав' */
    path: string;
}

export interface DeleteObjectParams {
    /** Agent path, e.g. 'Catalog.Товары' */
    path: string;
}

export interface RenameObjectParams {
    /** Agent path, e.g. 'Catalog.Товары' */
    path: string;
    newName: string;
}

export interface GetPropertiesParams {
    /** Agent path, e.g. 'Catalog.Товары' */
    path: string;
}

export interface SetPropertiesParams {
    /** Agent path, e.g. 'Catalog.Товары' */
    path: string;
    properties: Record<string, unknown>;
}

export interface GetTypeParams {
    /** Agent path, e.g. 'DefinedType.ТипНоменклатуры' or 'Catalog.Товары.Attribute.Цена' */
    path: string;
}

export interface SetTypeParams {
    /** Agent path, e.g. 'DefinedType.ТипНоменклатуры' or 'Catalog.Товары.Attribute.Цена' */
    path: string;
    /** Array of type strings, e.g. ['xs:string', 'cfg:CatalogRef.Товары'] */
    types: string[];
}

export interface GetTypeResult {
    /** Array of type strings, e.g. ['xs:string', 'cfg:CatalogRef.Товары'] */
    types: string[];
    /** Raw XML of the Type element */
    rawXml: string;
}

export interface CotPathParams {
    /** Agent path: 'ChartOfCharacteristicTypes.Name' or plain 'Name' */
    path: string;
}

export interface PredefinedCotPathParams {
    /** Agent path: 'ChartOfCharacteristicTypes.Name' or plain 'Name' */
    path: string;
    predefinedName: string;
}

export interface SetPredefinedCotTypeParams {
    /** Agent path: 'ChartOfCharacteristicTypes.Name' or plain 'Name' */
    path: string;
    predefinedName: string;
    types: string[];
}
