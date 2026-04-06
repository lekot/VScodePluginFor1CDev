// src/rules/converters/i8nTextConverter.ts
import { ConversionContext, IPropertyConverter, MetadataPropertyRule } from '../types';

interface V8Item {
    'v8:lang': string;
    'v8:content': string;
}

export const i8nTextConverter: IPropertyConverter = {
    fromXml(xmlValue: unknown, _rule: MetadataPropertyRule, context: ConversionContext): unknown {
        if (xmlValue === null || xmlValue === undefined) {
            return '';
        }

        const obj = xmlValue as Record<string, unknown>;
        const raw = obj['v8:item'];

        if (raw === null || raw === undefined) {
            return '';
        }

        const items: V8Item[] = Array.isArray(raw) ? raw as V8Item[] : [raw as V8Item];

        if (items.length === 1 && items[0]['v8:lang'] === context.defaultLanguage) {
            return items[0]['v8:content'] ?? '';
        }

        const result: Record<string, string> = {};
        for (const item of items) {
            result[item['v8:lang']] = item['v8:content'] ?? '';
        }
        return result;
    },

    toXml(irValue: unknown, _rule: MetadataPropertyRule, context: ConversionContext): unknown {
        if (irValue === null || irValue === undefined) {
            return {};
        }

        if (typeof irValue === 'string') {
            if (irValue === '') {
                return {};
            }
            return {
                'v8:item': {
                    'v8:lang': context.defaultLanguage,
                    'v8:content': irValue,
                },
            };
        }

        if (typeof irValue === 'object') {
            const entries = Object.entries(irValue as Record<string, string>);
            if (entries.length === 0) {
                return {};
            }
            return {
                'v8:item': entries.map(([lang, content]) => ({
                    'v8:lang': lang,
                    'v8:content': content,
                })),
            };
        }

        return {};
    },

    toYaml(irValue: unknown, rule: MetadataPropertyRule, _context: ConversionContext): unknown | undefined {
        if (typeof irValue === 'string') {
            if (irValue === '') { return undefined; }
            const def = rule.defaultValue ?? rule.defaultValueXML;
            if (irValue === def) { return undefined; }
            return irValue;
        }
        if (typeof irValue === 'object' && irValue !== null) {
            if (Object.keys(irValue as Record<string, string>).length === 0) { return undefined; }
            return irValue;
        }
        return undefined;
    },

    fromYaml(yamlValue: unknown, _rule: MetadataPropertyRule, _context: ConversionContext): unknown {
        if (typeof yamlValue === 'string') { return yamlValue; }
        if (typeof yamlValue === 'object' && yamlValue !== null) {
            return yamlValue as Record<string, string>;
        }
        return '';
    },
};
