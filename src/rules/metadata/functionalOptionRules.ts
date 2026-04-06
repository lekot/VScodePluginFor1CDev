// src/rules/metadata/functionalOptionRules.ts
// Rules for FunctionalOption metadata object (Designer format).
import { MetadataObjectRules } from '../types';

export const functionalOptionRules: MetadataObjectRules = {
    rootTag: 'FunctionalOption',
    namespaces: {
        'xmlns': 'http://v8.1c.ru/8.3/MDClasses',
        'xmlns:v8': 'http://v8.1c.ru/8.1/data/core',
    },
    hasChildObjects: false,
    properties: {
        comment: { type: 'string', order: 1, xml: 'Comment', yaml: 'Комментарий', defaultValueXML: '' },
        location: { type: 'string', order: 2, xml: 'Location', defaultValueXML: '' },
        name: { type: 'string', order: 3, xml: 'Name', yaml: 'Имя', required: true },
        privilegedGetMode: { type: 'boolean', order: 4, xml: 'PrivilegedGetMode', yaml: 'ПривилегированныйРежимПолучения', defaultValueXML: false },
        synonym: { type: 'I8nText', order: 5, xml: 'Synonym', yaml: 'Синоним' },
    },
};
