// src/rules/metadata/xdtoPackageRules.ts
// Rules for XDTOPackage metadata object (Designer format).
import { MetadataObjectRules } from '../types';

export const xdtoPackageRules: MetadataObjectRules = {
    rootTag: 'XDTOPackage',
    namespaces: {
        'xmlns': 'http://v8.1c.ru/8.3/MDClasses',
        'xmlns:v8': 'http://v8.1c.ru/8.1/data/core',
    },
    hasChildObjects: false,
    properties: {
        comment: { type: 'string', order: 1, xml: 'Comment', yaml: 'Комментарий', defaultValueXML: '' },
        name: { type: 'string', order: 2, xml: 'Name', yaml: 'Имя', required: true },
        namespace: { type: 'string', order: 3, xml: 'Namespace', yaml: 'Пространствоимён', defaultValueXML: '' },
        synonym: { type: 'I8nText', order: 4, xml: 'Synonym', yaml: 'Синоним' },
    },
};
