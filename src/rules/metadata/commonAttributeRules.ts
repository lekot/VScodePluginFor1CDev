// src/rules/metadata/commonAttributeRules.ts
// Rules for CommonAttribute metadata object (Designer format).
import { MetadataObjectRules } from '../types';

export const commonAttributeRules: MetadataObjectRules = {
    rootTag: 'CommonAttribute',
    namespaces: {
        'xmlns': 'http://v8.1c.ru/8.3/MDClasses',
        'xmlns:v8': 'http://v8.1c.ru/8.1/data/core',
        'xmlns:xr': 'http://v8.1c.ru/8.3/xcf/readable',
        'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
    },
    hasChildObjects: false,
    properties: {
        comment: { type: 'string', order: 1, xml: 'Comment', yaml: 'Комментарий', defaultValueXML: '' },
        name: { type: 'string', order: 2, xml: 'Name', yaml: 'Имя', required: true },
        synonym: { type: 'I8nText', order: 3, xml: 'Synonym', yaml: 'Синоним' },
        type: { type: 'InternalInfo', order: 4, xml: 'Type', defaultValueXML: {} },
    },
};
