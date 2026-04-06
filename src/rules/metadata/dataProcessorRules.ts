// src/rules/metadata/dataProcessorRules.ts
// Rules for DataProcessor metadata object (Designer format).
import { MetadataObjectRules } from '../types';

export const dataProcessorRules: MetadataObjectRules = {
    rootTag: 'DataProcessor',
    namespaces: {
        'xmlns': 'http://v8.1c.ru/8.3/MDClasses',
        'xmlns:v8': 'http://v8.1c.ru/8.1/data/core',
    },
    hasChildObjects: true,
    properties: {
        auxiliaryForm: { type: 'string', order: 1, xml: 'AuxiliaryForm', defaultValueXML: '' },
        comment: { type: 'string', order: 2, xml: 'Comment', yaml: 'Комментарий', defaultValueXML: '' },
        defaultForm: { type: 'string', order: 3, xml: 'DefaultForm', defaultValueXML: '' },
        explanation: { type: 'string', order: 4, xml: 'Explanation', defaultValueXML: '' },
        extendedPresentation: { type: 'string', order: 5, xml: 'ExtendedPresentation', defaultValueXML: '' },
        includeHelpInContents: { type: 'boolean', order: 6, xml: 'IncludeHelpInContents', defaultValueXML: false },
        name: { type: 'string', order: 7, xml: 'Name', yaml: 'Имя', required: true },
        synonym: { type: 'I8nText', order: 8, xml: 'Synonym', yaml: 'Синоним' },
        useStandardCommands: { type: 'boolean', order: 9, xml: 'UseStandardCommands', defaultValueXML: true },
    },
};
