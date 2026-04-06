// src/rules/index.ts
import { MetadataRulesRegistry } from './MetadataRulesRegistry';
import { MetadataConverter } from './MetadataConverter';
import { createDefaultConverterRegistry } from './converters';
import { commonModuleRules, subsystemRules, enumRules, catalogRules, documentRules } from './metadata';

const converterRegistry = createDefaultConverterRegistry();

export const rulesRegistry = new MetadataRulesRegistry();
rulesRegistry.register(commonModuleRules);
rulesRegistry.register(subsystemRules);
rulesRegistry.register(enumRules);
rulesRegistry.register(catalogRules);
rulesRegistry.register(documentRules);

export const metadataConverter = new MetadataConverter(converterRegistry);
