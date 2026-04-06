// src/rules/MetadataConverter.ts
import { xmlParser, xmlBuilder } from '../utils/xml/xmlCore';
import {
    IMetadataConverter,
    IPropertyConverterRegistry,
    MetadataIR,
    MetadataObjectRules,
    MetadataPropertyRule,
    ConversionContext,
} from './types';

function capitalize(str: string): string {
    if (!str) { return str; }
    return str.charAt(0).toUpperCase() + str.slice(1);
}

function getDefaultForType(rule: MetadataPropertyRule): unknown {
    if (rule.defaultValueXML !== undefined) {
        return rule.defaultValueXML;
    }
    switch (rule.type) {
        case 'string': return '';
        case 'number': return 0;
        case 'boolean': return false;
        case 'I8nText': return '';
        default: return undefined;
    }
}

export class MetadataConverter implements IMetadataConverter {
    constructor(private readonly converterRegistry: IPropertyConverterRegistry) {}

    createDefaultIR(rules: MetadataObjectRules, params: { name: string; uuid: string }): MetadataIR {
        const properties: Record<string, unknown> = {};
        for (const [key, rule] of Object.entries(rules.properties)) {
            if (rule.forReferenceOnly) { continue; }
            properties[key] = getDefaultForType(rule);
        }
        return {
            objectType: rules.rootTag,
            name: params.name,
            uuid: params.uuid,
            properties,
            children: {},
        };
    }

    mergeProperties(ir: MetadataIR, overrides: Record<string, unknown>): MetadataIR {
        return {
            ...ir,
            properties: { ...ir.properties, ...overrides },
        };
    }

    irToXml(ir: MetadataIR, rules: MetadataObjectRules): string {
        const context: ConversionContext = {
            objectName: ir.name,
            objectType: ir.objectType,
            defaultLanguage: 'ru',
        };

        // Sort property keys by order, undefined order goes last
        const sortedKeys = Object.keys(rules.properties).sort((a, b) => {
            const orderA = rules.properties[a].order ?? Number.MAX_SAFE_INTEGER;
            const orderB = rules.properties[b].order ?? Number.MAX_SAFE_INTEGER;
            return orderA - orderB;
        });

        const propertiesObj: Record<string, unknown> = {};
        for (const key of sortedKeys) {
            const rule = rules.properties[key];
            if (rule.forReferenceOnly) { continue; }
            const value = ir.properties[key];
            const converter = this.converterRegistry.get(rule.type);
            const xmlValue = converter.toXml(value, rule, context);
            const xmlTag = rule.xml ?? capitalize(key);
            propertiesObj[xmlTag] = xmlValue;
        }

        // Merge _unknown into Properties if present
        if (ir._unknown) {
            for (const [tag, val] of Object.entries(ir._unknown)) {
                if (!(tag in propertiesObj)) {
                    propertiesObj[tag] = val;
                }
            }
        }

        const obj = {
            '?xml': { '@_version': '1.0', '@_encoding': 'UTF-8' },
            MetaDataObject: {
                '@_xmlns': 'http://v8.1c.ru/8.3/MDClasses',
                '@_xmlns:v8': 'http://v8.1c.ru/8.1/data/core',
                '@_xmlns:xr': 'http://v8.1c.ru/8.3/xcf/readable',
                '@_xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
                [rules.rootTag]: {
                    '@_uuid': ir.uuid,
                    Properties: propertiesObj,
                    ChildObjects: '',
                },
            },
        };

        return xmlBuilder.build(obj) as string;
    }

    xmlToIr(xmlContent: string, rules: MetadataObjectRules): MetadataIR {
        const parsed = xmlParser.parse(xmlContent) as Record<string, unknown>;
        const metaDataObject = parsed['MetaDataObject'] as Record<string, unknown> | undefined;
        if (!metaDataObject) {
            throw new Error('xmlToIr: missing MetaDataObject root element');
        }

        const rootElement = metaDataObject[rules.rootTag] as Record<string, unknown> | undefined;
        if (!rootElement) {
            throw new Error(`xmlToIr: missing ${rules.rootTag} inside MetaDataObject`);
        }

        const uuid = (rootElement['@_uuid'] as string | undefined) ?? '';
        const propertiesNode = (rootElement['Properties'] as Record<string, unknown> | undefined) ?? {};

        const context: ConversionContext = {
            objectName: '',
            objectType: rules.rootTag,
            defaultLanguage: 'ru',
        };

        const properties: Record<string, unknown> = {};
        const knownXmlTags = new Set<string>();

        for (const [key, rule] of Object.entries(rules.properties)) {
            if (rule.forReferenceOnly) { continue; }
            const xmlTag = rule.xml ?? capitalize(key);
            knownXmlTags.add(xmlTag);
            const xmlValue = propertiesNode[xmlTag];
            const converter = this.converterRegistry.get(rule.type);
            properties[key] = converter.fromXml(xmlValue, rule, context);
        }

        // Collect unknown tags
        const _unknown: Record<string, unknown> = {};
        for (const [tag, val] of Object.entries(propertiesNode)) {
            if (!knownXmlTags.has(tag)) {
                _unknown[tag] = val;
            }
        }

        // Try to extract name from properties (Name key)
        const name = (properties['name'] as string | undefined) ?? (properties['Name'] as string | undefined) ?? '';

        return {
            objectType: rules.rootTag,
            name,
            uuid,
            properties,
            children: {},
            ...(Object.keys(_unknown).length > 0 ? { _unknown } : {}),
        };
    }

    irToYaml(_ir: MetadataIR, _rules: MetadataObjectRules): string {
        throw new Error('YAML support not implemented (Phase 2)');
    }

    yamlToIr(_yamlContent: string, _rules: MetadataObjectRules): MetadataIR {
        throw new Error('YAML support not implemented (Phase 2)');
    }
}
