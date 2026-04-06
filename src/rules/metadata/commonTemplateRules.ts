// src/rules/metadata/commonTemplateRules.ts
// Rules for CommonTemplate metadata object (Designer format).
import { MetadataObjectRules } from '../types';

export const commonTemplateRules: MetadataObjectRules = {
    rootTag: 'CommonTemplate',
    namespaces: {
        'xmlns': 'http://v8.1c.ru/8.3/MDClasses',
        'xmlns:v8': 'http://v8.1c.ru/8.1/data/core',
    },
    hasChildObjects: false,
    properties: {
        comment: { type: 'string', order: 1, xml: 'Comment', yaml: 'Комментарий', defaultValueXML: '' },
        name: { type: 'string', order: 2, xml: 'Name', yaml: 'Имя', required: true },
        synonym: { type: 'I8nText', order: 3, xml: 'Synonym', yaml: 'Синоним' },
        templateType: { type: 'SystemEnumeration', order: 4, xml: 'TemplateType', yaml: 'ТипМакета', defaultValueXML: 'SpreadsheetDocument', typeSE: 'TemplateType' },
    },
};
