// src/rules/metadata/reportRules.ts
// Rules for Report metadata object (Designer format).
import { MetadataObjectRules } from '../types';

export const reportRules: MetadataObjectRules = {
    rootTag: 'Report',
    namespaces: {
        'xmlns': 'http://v8.1c.ru/8.3/MDClasses',
        'xmlns:v8': 'http://v8.1c.ru/8.1/data/core',
    },
    hasChildObjects: true,
    properties: {
        auxiliaryForm: { type: 'string', order: 1, xml: 'AuxiliaryForm', defaultValueXML: '' },
        auxiliarySettingsForm: { type: 'string', order: 2, xml: 'AuxiliarySettingsForm', defaultValueXML: '' },
        comment: { type: 'string', order: 3, xml: 'Comment', yaml: 'Комментарий', defaultValueXML: '' },
        defaultForm: { type: 'string', order: 4, xml: 'DefaultForm', defaultValueXML: '' },
        defaultSettingsForm: { type: 'string', order: 5, xml: 'DefaultSettingsForm', defaultValueXML: '' },
        defaultVariantForm: { type: 'string', order: 6, xml: 'DefaultVariantForm', defaultValueXML: '' },
        explanation: { type: 'string', order: 7, xml: 'Explanation', defaultValueXML: '' },
        extendedPresentation: { type: 'string', order: 8, xml: 'ExtendedPresentation', defaultValueXML: '' },
        includeHelpInContents: { type: 'boolean', order: 9, xml: 'IncludeHelpInContents', defaultValueXML: false },
        mainDataCompositionSchema: { type: 'string', order: 10, xml: 'MainDataCompositionSchema', defaultValueXML: '' },
        name: { type: 'string', order: 11, xml: 'Name', yaml: 'Имя', required: true },
        settingsStorage: { type: 'string', order: 12, xml: 'SettingsStorage', defaultValueXML: '' },
        synonym: { type: 'I8nText', order: 13, xml: 'Synonym', yaml: 'Синоним' },
        useStandardCommands: { type: 'boolean', order: 14, xml: 'UseStandardCommands', defaultValueXML: true },
        variantsStorage: { type: 'string', order: 15, xml: 'VariantsStorage', defaultValueXML: '' },
    },
};
