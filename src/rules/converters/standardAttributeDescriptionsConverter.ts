// src/rules/converters/standardAttributeDescriptionsConverter.ts
import { ConversionContext, IPropertyConverter, MetadataPropertyRule } from '../types';

export const standardAttributeDescriptionsConverter: IPropertyConverter = {
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
