// src/rules/converters/index.ts
import { IPropertyConverterRegistry } from '../types';
import { PropertyConverterRegistry } from './PropertyConverterRegistry';
import { booleanConverter, numberConverter, stringConverter } from './primitiveConverters';
import { i8nTextConverter } from './i8nTextConverter';
import { systemEnumerationConverter } from './systemEnumerationConverter';
import { internalInfoConverter } from './internalInfoConverter';
import { standardAttributeDescriptionsConverter } from './standardAttributeDescriptionsConverter';

export { PropertyConverterRegistry } from './PropertyConverterRegistry';
export { stringConverter, numberConverter, booleanConverter } from './primitiveConverters';
export { i8nTextConverter } from './i8nTextConverter';
export { systemEnumerationConverter } from './systemEnumerationConverter';
export { internalInfoConverter } from './internalInfoConverter';
export { standardAttributeDescriptionsConverter } from './standardAttributeDescriptionsConverter';

export function createDefaultConverterRegistry(): IPropertyConverterRegistry {
    const registry = new PropertyConverterRegistry();

    registry.register('string', stringConverter);
    registry.register('number', numberConverter);
    registry.register('boolean', booleanConverter);
    registry.register('I8nText', i8nTextConverter);
    registry.register('SystemEnumeration', systemEnumerationConverter);
    registry.register('InternalInfo', internalInfoConverter);
    registry.register('StandardAttributeDescriptions', standardAttributeDescriptionsConverter);
    // Raw pass-through converters for complex types not yet decomposed
    registry.register('TypeDescription', internalInfoConverter);
    registry.register('MetadataAttributes', internalInfoConverter);
    registry.register('MetadataTabularSections', internalInfoConverter);
    registry.register('MetadataValueCollection', internalInfoConverter);

    return registry;
}
