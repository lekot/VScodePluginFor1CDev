// src/rules/metadata/languageRules.ts
// Rules for Language metadata object (Designer format).
import { MetadataObjectRules } from '../types';

export const languageRules: MetadataObjectRules = {
    rootTag: 'Language',
    namespaces: {
        'xmlns': 'http://v8.1c.ru/8.3/MDClasses',
        'xmlns:v8': 'http://v8.1c.ru/8.1/data/core',
    },
    hasChildObjects: false,
    properties: {
        languageCode: { type: 'string', order: 1, xml: 'LanguageCode', yaml: 'КодЯзыка', defaultValueXML: 'ru' },
        comment: { type: 'string', order: 2, xml: 'Comment', yaml: 'Комментарий', defaultValueXML: '' },
        name: { type: 'string', order: 3, xml: 'Name', yaml: 'Имя', required: true },
        synonym: { type: 'I8nText', order: 4, xml: 'Synonym', yaml: 'Синоним' },
    },
};
