// src/rules/converters/systemEnumerationConverter.ts
import { ConversionContext, IPropertyConverter, MetadataPropertyRule } from '../types';

export const systemEnumerationConverter: IPropertyConverter = {
    fromXml(xmlValue: unknown, _rule: MetadataPropertyRule, _context: ConversionContext): unknown {
        if (xmlValue === null || xmlValue === undefined) {
            return '';
        }
        return String(xmlValue);
    },
    toXml(irValue: unknown, _rule: MetadataPropertyRule, _context: ConversionContext): unknown {
        if (irValue === null || irValue === undefined) { return ''; }
        return String(irValue);
    },
    toYaml(irValue: unknown, rule: MetadataPropertyRule, _context: ConversionContext): unknown | undefined {
        const def = rule.defaultValue ?? rule.defaultValueXML ?? '';
        if (irValue === def) { return undefined; }
        return String(irValue ?? '');
    },
    fromYaml(yamlValue: unknown, _rule: MetadataPropertyRule, _context: ConversionContext): unknown {
        return String(yamlValue ?? '');
    },
};
