// src/rules/metadata/commonCommandRules.ts
// Rules for CommonCommand metadata object (Designer format).
import { MetadataObjectRules } from '../types';

export const commonCommandRules: MetadataObjectRules = {
    rootTag: 'CommonCommand',
    namespaces: {
        'xmlns': 'http://v8.1c.ru/8.3/MDClasses',
        'xmlns:v8': 'http://v8.1c.ru/8.1/data/core',
    },
    hasChildObjects: false,
    properties: {
        comment: { type: 'string', order: 1, xml: 'Comment', yaml: 'Комментарий', defaultValueXML: '' },
        group: { type: 'string', order: 2, xml: 'Group', defaultValueXML: '' },
        name: { type: 'string', order: 3, xml: 'Name', yaml: 'Имя', required: true },
        representation: { type: 'SystemEnumeration', order: 4, xml: 'Representation', yaml: 'Отображение', defaultValueXML: 'Picture', typeSE: 'ButtonRepresentation' },
        synonym: { type: 'I8nText', order: 5, xml: 'Synonym', yaml: 'Синоним' },
        toolTip: { type: 'I8nText', order: 6, xml: 'ToolTip', yaml: 'Подсказка', defaultValueXML: '' },
    },
};
