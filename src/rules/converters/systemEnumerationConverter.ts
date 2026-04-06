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
        return String(irValue);
    },
    toYaml(_irValue: unknown, _rule: MetadataPropertyRule, _context: ConversionContext): undefined {
        return undefined;
    },
    fromYaml(yamlValue: unknown, _rule: MetadataPropertyRule, _context: ConversionContext): unknown {
        return yamlValue;
    },
};
