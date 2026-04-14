// src/rules/metadata/commonFormRules.ts
// Rules for CommonForm metadata object (Designer format).
import { MetadataObjectRules } from '../types';

export const commonFormRules: MetadataObjectRules = {
    rootTag: 'CommonForm',
    namespaces: {
        'xmlns': 'http://v8.1c.ru/8.3/MDClasses',
        'xmlns:v8': 'http://v8.1c.ru/8.1/data/core',
    },
    hasChildObjects: false,
    properties: {
        comment: { type: 'string', order: 1, xml: 'Comment', yaml: 'Комментарий', defaultValueXML: '' },
        formType: { type: 'SystemEnumeration', order: 2, xml: 'FormType', yaml: 'ТипФормы', defaultValueXML: 'Managed', typeSE: 'FormType' },
        name: { type: 'string', order: 3, xml: 'Name', yaml: 'Имя', required: true },
        synonym: { type: 'I8nText', order: 4, xml: 'Synonym', yaml: 'Синоним' },
    },
};
