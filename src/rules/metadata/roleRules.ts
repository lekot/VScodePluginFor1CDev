// src/rules/metadata/roleRules.ts
// Rules for Role metadata object (Designer format).
import { MetadataObjectRules } from '../types';

export const roleRules: MetadataObjectRules = {
    rootTag: 'Role',
    namespaces: {
        'xmlns': 'http://v8.1c.ru/8.3/MDClasses',
        'xmlns:v8': 'http://v8.1c.ru/8.1/data/core',
    },
    hasChildObjects: false,
    properties: {
        comment: { type: 'string', order: 1, xml: 'Comment', yaml: 'Комментарий', defaultValueXML: '' },
        name: { type: 'string', order: 2, xml: 'Name', yaml: 'Имя', required: true },
        synonym: { type: 'I8nText', order: 3, xml: 'Synonym', yaml: 'Синоним' },
    },
};
