// src/rules/metadata/documentJournalRules.ts
// Rules for DocumentJournal metadata object (Designer format).
import { MetadataObjectRules } from '../types';

export const documentJournalRules: MetadataObjectRules = {
    rootTag: 'DocumentJournal',
    namespaces: {
        'xmlns': 'http://v8.1c.ru/8.3/MDClasses',
        'xmlns:v8': 'http://v8.1c.ru/8.1/data/core',
        'xmlns:xr': 'http://v8.1c.ru/8.3/xcf/readable',
        'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
    },
    hasChildObjects: true,
    properties: {
        auxiliaryForm: { type: 'string', order: 1, xml: 'AuxiliaryForm', defaultValueXML: '' },
        comment: { type: 'string', order: 2, xml: 'Comment', yaml: 'Комментарий', defaultValueXML: '' },
        defaultForm: { type: 'string', order: 3, xml: 'DefaultForm', defaultValueXML: '' },
        explanation: { type: 'string', order: 4, xml: 'Explanation', defaultValueXML: '' },
        extendedListPresentation: { type: 'I8nText', order: 5, xml: 'ExtendedListPresentation', defaultValueXML: '{Synonym_ru}' },
        listPresentation: { type: 'I8nText', order: 6, xml: 'ListPresentation', defaultValueXML: '{Synonym_ru}' },
        name: { type: 'string', order: 7, xml: 'Name', yaml: 'Имя', required: true },
        registeredDocuments: { type: 'InternalInfo', order: 8, xml: 'RegisteredDocuments', defaultValueXML: {} },
        synonym: { type: 'I8nText', order: 9, xml: 'Synonym', yaml: 'Синоним' },
        useStandardCommands: { type: 'boolean', order: 10, xml: 'UseStandardCommands', defaultValueXML: true },
    },
};
