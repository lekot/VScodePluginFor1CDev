// src/rules/metadata/accumulationRegisterRules.ts
// Rules for AccumulationRegister metadata object (Designer format).
import { MetadataObjectRules } from '../types';

export const accumulationRegisterRules: MetadataObjectRules = {
    rootTag: 'AccumulationRegister',
    namespaces: {
        'xmlns': 'http://v8.1c.ru/8.3/MDClasses',
        'xmlns:v8': 'http://v8.1c.ru/8.1/data/core',
        'xmlns:xr': 'http://v8.1c.ru/8.3/xcf/readable',
        'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
    },
    hasChildObjects: true,
    properties: {
        auxiliaryListForm: { type: 'string', order: 1, xml: 'AuxiliaryListForm', defaultValueXML: '' },
        comment: { type: 'string', order: 2, xml: 'Comment', yaml: 'Комментарий', defaultValueXML: '' },
        dataLockControlMode: { type: 'SystemEnumeration', order: 3, xml: 'DataLockControlMode', defaultValueXML: 'Managed', typeSE: 'DataLockControlMode' },
        defaultListForm: { type: 'string', order: 4, xml: 'DefaultListForm', defaultValueXML: '' },
        enableTotalsSplitting: { type: 'boolean', order: 5, xml: 'EnableTotalsSplitting', yaml: 'РазделениеИтогов', defaultValueXML: true },
        explanation: { type: 'string', order: 6, xml: 'Explanation', defaultValueXML: '' },
        extendedListPresentation: { type: 'I8nText', order: 7, xml: 'ExtendedListPresentation', defaultValueXML: '{Synonym_ru}' },
        fullTextSearch: { type: 'SystemEnumeration', order: 8, xml: 'FullTextSearch', defaultValueXML: 'DontUse', typeSE: 'FullTextSearch' },
        includeHelpInContents: { type: 'boolean', order: 9, xml: 'IncludeHelpInContents', defaultValueXML: false },
        listPresentation: { type: 'I8nText', order: 10, xml: 'ListPresentation', defaultValueXML: '{Synonym_ru}' },
        name: { type: 'string', order: 11, xml: 'Name', yaml: 'Имя', required: true },
        registerType: { type: 'SystemEnumeration', order: 12, xml: 'RegisterType', yaml: 'ВидРегистра', defaultValueXML: 'Balance', typeSE: 'AccumulationRegisterType' },
        standardAttributes: { type: 'StandardAttributeDescriptions', order: 13, xml: 'StandardAttributes', defaultValueXML: undefined },
        synonym: { type: 'I8nText', order: 14, xml: 'Synonym', yaml: 'Синоним' },
        useStandardCommands: { type: 'boolean', order: 15, xml: 'UseStandardCommands', defaultValueXML: true },
    },
};
