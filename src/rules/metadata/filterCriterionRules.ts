// src/rules/metadata/filterCriterionRules.ts
// Rules for FilterCriterion metadata object (Designer format).
import { MetadataObjectRules } from '../types';

export const filterCriterionRules: MetadataObjectRules = {
    rootTag: 'FilterCriterion',
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
        content: { type: 'InternalInfo', order: 3, xml: 'Content', defaultValueXML: {} },
        defaultForm: { type: 'string', order: 4, xml: 'DefaultForm', defaultValueXML: '' },
        explanation: { type: 'string', order: 5, xml: 'Explanation', defaultValueXML: '' },
        extendedListPresentation: { type: 'I8nText', order: 6, xml: 'ExtendedListPresentation', defaultValueXML: '{Synonym_ru}' },
        listPresentation: { type: 'I8nText', order: 7, xml: 'ListPresentation', defaultValueXML: '{Synonym_ru}' },
        name: { type: 'string', order: 8, xml: 'Name', yaml: 'Имя', required: true },
        synonym: { type: 'I8nText', order: 9, xml: 'Synonym', yaml: 'Синоним' },
        type: { type: 'TypeDescription', order: 10, xml: 'Type', defaultValueXML: undefined },
        useStandardCommands: { type: 'boolean', order: 11, xml: 'UseStandardCommands', defaultValueXML: false },
    },
};
