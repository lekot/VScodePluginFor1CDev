// src/rules/metadata/commonPictureRules.ts
// Rules for CommonPicture metadata object (Designer format).
import { MetadataObjectRules } from '../types';

export const commonPictureRules: MetadataObjectRules = {
    rootTag: 'CommonPicture',
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
