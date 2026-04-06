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
    fromYaml(_yamlValue: unknown, _rule: MetadataPropertyRule, _context: ConversionContext): unknown {
        throw new Error('Not supported for StandardAttributeDescriptions');
    },
};
