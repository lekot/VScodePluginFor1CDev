// src/rules/converters/primitiveConverters.ts
import { ConversionContext, IPropertyConverter, MetadataPropertyRule } from '../types';

export const stringConverter: IPropertyConverter = {
    fromXml(xmlValue: unknown, _rule: MetadataPropertyRule, _context: ConversionContext): unknown {
        if (xmlValue === undefined || xmlValue === null) {
            return '';
        }
        return String(xmlValue);
    },
    toXml(irValue: unknown, _rule: MetadataPropertyRule, _context: ConversionContext): unknown {
        return String(irValue ?? '');
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

export const numberConverter: IPropertyConverter = {
    fromXml(xmlValue: unknown, _rule: MetadataPropertyRule, _context: ConversionContext): unknown {
        const n = Number(xmlValue);
        return isNaN(n) ? 0 : n;
    },
    toXml(irValue: unknown, _rule: MetadataPropertyRule, _context: ConversionContext): unknown {
        if (irValue === null || irValue === undefined) { return 0; }
        const n = Number(irValue);
        return isNaN(n) ? 0 : n;
    },
    toYaml(irValue: unknown, rule: MetadataPropertyRule, _context: ConversionContext): unknown | undefined {
        const def = rule.defaultValue ?? rule.defaultValueXML ?? 0;
        const n = (irValue === null || irValue === undefined) ? 0 : Number(irValue);
        if (n === def) { return undefined; }
        return n;
    },
    fromYaml(yamlValue: unknown, _rule: MetadataPropertyRule, _context: ConversionContext): unknown {
        const n = Number(yamlValue ?? 0);
        return isNaN(n) ? 0 : n;
    },
};

export const booleanConverter: IPropertyConverter = {
    fromXml(xmlValue: unknown, _rule: MetadataPropertyRule, _context: ConversionContext): unknown {
        return xmlValue === 'true' || xmlValue === true;
    },
    toXml(irValue: unknown, _rule: MetadataPropertyRule, _context: ConversionContext): unknown {
        return irValue ? 'true' : 'false';
    },
    toYaml(irValue: unknown, rule: MetadataPropertyRule, _context: ConversionContext): unknown | undefined {
        const def = rule.defaultValue ?? rule.defaultValueXML ?? false;
        const b = Boolean(irValue);
        if (b === def) { return undefined; }
        return b;
    },
    fromYaml(yamlValue: unknown, _rule: MetadataPropertyRule, _context: ConversionContext): unknown {
        return Boolean(yamlValue);
    },
};
