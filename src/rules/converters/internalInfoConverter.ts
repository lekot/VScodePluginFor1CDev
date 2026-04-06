// src/rules/converters/internalInfoConverter.ts
import { ConversionContext, IPropertyConverter, MetadataPropertyRule } from '../types';

export const internalInfoConverter: IPropertyConverter = {
    fromXml(xmlValue: unknown, _rule: MetadataPropertyRule, _context: ConversionContext): unknown {
        return xmlValue;
    },
    toXml(irValue: unknown, _rule: MetadataPropertyRule, _context: ConversionContext): unknown {
        return irValue;
    },
    toYaml(_irValue: unknown, _rule: MetadataPropertyRule, _context: ConversionContext): undefined {
        return undefined;
    },
    fromYaml(yamlValue: unknown, _rule: MetadataPropertyRule, _context: ConversionContext): unknown {
        return yamlValue;
    },
};
