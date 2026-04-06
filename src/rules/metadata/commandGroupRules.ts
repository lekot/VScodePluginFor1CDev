// src/rules/metadata/commandGroupRules.ts
// Rules for CommandGroup metadata object (Designer format).
import { MetadataObjectRules } from '../types';

export const commandGroupRules: MetadataObjectRules = {
    rootTag: 'CommandGroup',
    namespaces: {
        'xmlns': 'http://v8.1c.ru/8.3/MDClasses',
        'xmlns:v8': 'http://v8.1c.ru/8.1/data/core',
    },
    hasChildObjects: false,
    properties: {
        category: { type: 'SystemEnumeration', order: 1, xml: 'Category', yaml: 'Категория', defaultValueXML: 'ActionsPanel', typeSE: 'CommandGroupCategory' },
        comment: { type: 'string', order: 2, xml: 'Comment', yaml: 'Комментарий', defaultValueXML: '' },
        name: { type: 'string', order: 3, xml: 'Name', yaml: 'Имя', required: true },
        representation: { type: 'SystemEnumeration', order: 4, xml: 'Representation', yaml: 'Отображение', defaultValueXML: 'Picture', typeSE: 'ButtonRepresentation' },
        synonym: { type: 'I8nText', order: 5, xml: 'Synonym', yaml: 'Синоним' },
    },
};
