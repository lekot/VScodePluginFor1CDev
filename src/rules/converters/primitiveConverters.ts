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
    toYaml(_irValue: unknown, _rule: MetadataPropertyRule, _context: ConversionContext): undefined {
        return undefined;
    },
    fromYaml(yamlValue: unknown, _rule: MetadataPropertyRule, _context: ConversionContext): unknown {
        return yamlValue;
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
    toYaml(_irValue: unknown, _rule: MetadataPropertyRule, _context: ConversionContext): undefined {
        return undefined;
    },
    fromYaml(yamlValue: unknown, _rule: MetadataPropertyRule, _context: ConversionContext): unknown {
        return yamlValue;
    },
};

export const booleanConverter: IPropertyConverter = {
    fromXml(xmlValue: unknown, _rule: MetadataPropertyRule, _context: ConversionContext): unknown {
        return xmlValue === 'true' || xmlValue === true;
    },
    toXml(irValue: unknown, _rule: MetadataPropertyRule, _context: ConversionContext): unknown {
        return irValue ? 'true' : 'false';
    },
    toYaml(_irValue: unknown, _rule: MetadataPropertyRule, _context: ConversionContext): undefined {
        return undefined;
    },
    fromYaml(yamlValue: unknown, _rule: MetadataPropertyRule, _context: ConversionContext): unknown {
        return yamlValue;
    },
};
