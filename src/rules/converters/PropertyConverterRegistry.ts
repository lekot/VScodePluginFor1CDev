// src/rules/converters/PropertyConverterRegistry.ts
import {
    IPropertyConverter,
    IPropertyConverterRegistry,
    PropertyRuleType,
} from '../types';

export class PropertyConverterRegistry implements IPropertyConverterRegistry {
    private readonly converters = new Map<PropertyRuleType, IPropertyConverter>();

    get(type: PropertyRuleType): IPropertyConverter {
        const converter = this.converters.get(type);
        if (!converter) {
            throw new Error(`Unknown converter type: ${type}`);
        }
        return converter;
    }

    register(type: PropertyRuleType, converter: IPropertyConverter): void {
        this.converters.set(type, converter);
    }
}
