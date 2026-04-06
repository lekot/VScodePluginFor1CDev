// src/rules/metadata/settingsStorageRules.ts
// Rules for SettingsStorage metadata object (Designer format).
import { MetadataObjectRules } from '../types';

export const settingsStorageRules: MetadataObjectRules = {
    rootTag: 'SettingsStorage',
    namespaces: {
        'xmlns': 'http://v8.1c.ru/8.3/MDClasses',
        'xmlns:v8': 'http://v8.1c.ru/8.1/data/core',
    },
    hasChildObjects: true,
    properties: {
        auxiliaryLoadForm: { type: 'string', order: 1, xml: 'AuxiliaryLoadForm', defaultValueXML: '' },
        auxiliarySaveForm: { type: 'string', order: 2, xml: 'AuxiliarySaveForm', defaultValueXML: '' },
        comment: { type: 'string', order: 3, xml: 'Comment', yaml: 'Комментарий', defaultValueXML: '' },
        defaultLoadForm: { type: 'string', order: 4, xml: 'DefaultLoadForm', defaultValueXML: '' },
        defaultSaveForm: { type: 'string', order: 5, xml: 'DefaultSaveForm', defaultValueXML: '' },
        name: { type: 'string', order: 6, xml: 'Name', yaml: 'Имя', required: true },
        synonym: { type: 'I8nText', order: 7, xml: 'Synonym', yaml: 'Синоним' },
    },
};
