// src/rules/metadata/documentNumeratorRules.ts
// Rules for DocumentNumerator metadata object (Designer format).
import { MetadataObjectRules } from '../types';

export const documentNumeratorRules: MetadataObjectRules = {
    rootTag: 'DocumentNumerator',
    namespaces: {
        'xmlns': 'http://v8.1c.ru/8.3/MDClasses',
        'xmlns:v8': 'http://v8.1c.ru/8.1/data/core',
    },
    hasChildObjects: false,
    properties: {
        comment: { type: 'string', order: 1, xml: 'Comment', yaml: 'Комментарий', defaultValueXML: '' },
        name: { type: 'string', order: 2, xml: 'Name', yaml: 'Имя', required: true },
        numberType: { type: 'SystemEnumeration', order: 3, xml: 'NumberType', yaml: 'ТипНомера', defaultValueXML: 'String', typeSE: 'NumberType' },
        synonym: { type: 'I8nText', order: 4, xml: 'Synonym', yaml: 'Синоним' },
    },
};
