// src/agent/types.ts
// Agent API — публичные типы для команд агента. Без зависимостей от vscode.

export interface AgentResult<T = void> {
    success: boolean;
    data?: T;
    error?: string;
    code?: string;
    configurationId?: string;
    operationId?: string;
    snapshotVersion?: number;
}

export interface ConfigurationScopedParams {
    /** Exact configuration selector. Optional only for a single compatible configuration. */
    configurationId?: string;
}

export interface CreateObjectParams extends ConfigurationScopedParams {
    /** Тип объекта: 'Catalog', 'Document', 'Enum', 'CommonModule', 'Subsystem' */
    type: string;
    name: string;
    synonym?: string;
    properties?: Record<string, unknown>;
}

export interface GetYamlParams extends ConfigurationScopedParams {
    /** Путь вида 'Catalog.Товары' */
    path: string;
}

export interface ListObjectsParams extends ConfigurationScopedParams {
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

export interface AddAttributeParams extends ConfigurationScopedParams {
    /** Agent path, e.g. 'Catalog.Товары' */
    path: string;
    name: string;
}

export interface AddTabularSectionParams extends ConfigurationScopedParams {
    /** Agent path, e.g. 'Catalog.Товары' */
    path: string;
    name: string;
}

export interface AddTabularSectionColumnParams extends ConfigurationScopedParams {
    /** Agent path, e.g. 'Catalog.Товары.TabularSection.Состав' */
    path: string;
    name: string;
}

export interface DeleteAttributeParams extends ConfigurationScopedParams {
    /** Agent path to attribute, e.g. 'Catalog.Товары.Attribute.Цена' */
    path: string;
}

export interface DeleteTabularSectionParams extends ConfigurationScopedParams {
    /** Agent path to tabular section, e.g. 'Catalog.Товары.TabularSection.Состав' */
    path: string;
}

export interface DeleteObjectParams extends ConfigurationScopedParams {
    /** Agent path, e.g. 'Catalog.Товары' */
    path: string;
}

export interface RenameObjectParams extends ConfigurationScopedParams {
    /** Agent path, e.g. 'Catalog.Товары' */
    path: string;
    newName: string;
}

export interface GetPropertiesParams extends ConfigurationScopedParams {
    /** Agent path, e.g. 'Catalog.Товары' */
    path: string;
}

export interface SetPropertiesParams extends ConfigurationScopedParams {
    /** Agent path, e.g. 'Catalog.Товары' */
    path: string;
    properties: Record<string, unknown>;
}

export interface GetTypeParams extends ConfigurationScopedParams {
    /** Agent path, e.g. 'DefinedType.ТипНоменклатуры' or 'Catalog.Товары.Attribute.Цена' */
    path: string;
}

export interface SetTypeParams extends ConfigurationScopedParams {
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

export interface CotPathParams extends ConfigurationScopedParams {
    /** Agent path: 'ChartOfCharacteristicTypes.Name' or plain 'Name' */
    path: string;
}

export interface PredefinedCotPathParams extends ConfigurationScopedParams {
    /** Agent path: 'ChartOfCharacteristicTypes.Name' or plain 'Name' */
    path: string;
    predefinedName: string;
}

export interface SetPredefinedCotTypeParams extends ConfigurationScopedParams {
    /** Agent path: 'ChartOfCharacteristicTypes.Name' or plain 'Name' */
    path: string;
    predefinedName: string;
    types: string[];
}
