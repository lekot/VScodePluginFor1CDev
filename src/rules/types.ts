// src/rules/types.ts
// Rules Engine — контракты типов. Только типы и интерфейсы, без реализации.

// ─── 3.1 Rule Engine ──────────────────────────────────────────────────────────

export type PropertyRuleType =
    | 'string'
    | 'number'
    | 'boolean'
    | 'I8nText'
    | 'SystemEnumeration'
    | 'MetadataAttributes'
    | 'MetadataTabularSections'
    | 'MetadataValueCollection'
    | 'StandardAttributeDescriptions'
    | 'TypeDescription'
    | 'InternalInfo';

export interface MetadataPropertyRule {
    readonly type: PropertyRuleType;
    /** Путь XML-родителей, например ['Catalog', 'Properties']. */
    readonly xmlParents?: readonly string[];
    /** Имя тега в XML; если не задано — capitalize(key). */
    readonly xml?: string;
    /** Ключ в YAML (русское имя); undefined = не выгружать в YAML. */
    readonly yaml?: string;
    readonly defaultValueXML?: unknown;
    readonly defaultValue?: unknown;
    readonly required?: boolean;
    /** Порядок при сериализации в XML. */
    readonly order?: number;
    readonly forReferenceOnly?: boolean;
    /** Для SystemEnumeration. */
    readonly typeSE?: string;
    /** Для StandardAttributeDescriptions. */
    readonly standardAttributeNames?: readonly string[];
    /** Для InternalInfo. */
    readonly internalInfoItems?: readonly { name: string; category: string }[];
}

export interface MetadataObjectRules {
    readonly rootTag: string;
    readonly properties: Readonly<Record<string, MetadataPropertyRule>>;
}

// ─── 3.2 Internal Representation (IR) ────────────────────────────────────────

export interface MetadataIR {
    readonly objectType: string;
    readonly name: string;
    readonly uuid: string;
    readonly properties: Record<string, unknown>;
    readonly children: Record<string, MetadataIR[]>;
    /**
     * Теги XML, не покрытые правилами — сохраняются при xmlToIr
     * и прокидываются обратно при irToXml. Обеспечивает round-trip без потерь.
     */
    readonly _unknown?: Record<string, unknown>;
}

// ─── 3.3 Converters ───────────────────────────────────────────────────────────

export interface ConversionContext {
    readonly objectName: string;
    readonly objectType: string;
    readonly defaultLanguage: string;
}

export interface IPropertyConverter {
    fromXml(xmlValue: unknown, rule: MetadataPropertyRule, context: ConversionContext): unknown;
    toXml(irValue: unknown, rule: MetadataPropertyRule, context: ConversionContext): unknown;
    /** undefined = пропустить в YAML (значение равно дефолту). */
    toYaml(irValue: unknown, rule: MetadataPropertyRule, context: ConversionContext): unknown | undefined;
    fromYaml(yamlValue: unknown, rule: MetadataPropertyRule, context: ConversionContext): unknown;
}

export interface IPropertyConverterRegistry {
    get(type: PropertyRuleType): IPropertyConverter;
    register(type: PropertyRuleType, converter: IPropertyConverter): void;
}

// ─── 3.4 Metadata Converter ───────────────────────────────────────────────────

export interface IMetadataConverter {
    xmlToIr(xmlContent: string, rules: MetadataObjectRules): MetadataIR;
    irToXml(ir: MetadataIR, rules: MetadataObjectRules): string;
    irToYaml(ir: MetadataIR, rules: MetadataObjectRules): string;
    yamlToIr(yamlContent: string, rules: MetadataObjectRules): MetadataIR;
    /** Создаёт IR с дефолтными значениями из rules. */
    createDefaultIR(rules: MetadataObjectRules, params: { name: string; uuid: string }): MetadataIR;
    /**
     * Мержит пользовательские свойства поверх IR.
     * Используется агентом: createDefaultIR → mergeProperties(ir, params.properties).
     */
    mergeProperties(ir: MetadataIR, overrides: Record<string, unknown>): MetadataIR;
}

// ─── 3.5 Rules Registry ───────────────────────────────────────────────────────

export interface IMetadataRulesRegistry {
    get(rootTag: string): MetadataObjectRules | undefined;
    allRootTags(): readonly string[];
    register(rules: MetadataObjectRules): void;
}
