// src/rules/metadata/enumRules.ts
// Rules for Enum metadata object (Designer format).
import { MetadataObjectRules } from '../types';

export const enumRules: MetadataObjectRules = {
    rootTag: 'Enum',
    namespaces: {
        'xmlns': 'http://v8.1c.ru/8.3/MDClasses',
        'xmlns:v8': 'http://v8.1c.ru/8.1/data/core',
        'xmlns:xr': 'http://v8.1c.ru/8.3/xcf/readable',
        'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
    },
    hasChildObjects: true,
    properties: {
        auxiliaryChoiceForm: { type: 'string', order: 1, xml: 'AuxiliaryChoiceForm', defaultValueXML: '' },
        auxiliaryListForm: { type: 'string', order: 2, xml: 'AuxiliaryListForm', defaultValueXML: '' },
        characteristics: { type: 'string', order: 3, xml: 'Characteristics', defaultValueXML: '' },
        choiceHistoryOnInput: { type: 'SystemEnumeration', order: 4, xml: 'ChoiceHistoryOnInput', defaultValueXML: 'Auto', typeSE: 'ChoiceHistoryOnInput' },
        choiceMode: { type: 'SystemEnumeration', order: 5, xml: 'ChoiceMode', defaultValueXML: 'BothWays', typeSE: 'ChoiceMode' },
        comment: { type: 'string', order: 6, xml: 'Comment', defaultValueXML: '' },
        defaultChoiceForm: { type: 'string', order: 7, xml: 'DefaultChoiceForm', defaultValueXML: '' },
        defaultListForm: { type: 'string', order: 8, xml: 'DefaultListForm', defaultValueXML: '' },
        explanation: { type: 'string', order: 9, xml: 'Explanation', defaultValueXML: '' },
        extendedListPresentation: { type: 'string', order: 10, xml: 'ExtendedListPresentation', defaultValueXML: '' },
        listPresentation: { type: 'string', order: 11, xml: 'ListPresentation', defaultValueXML: '' },
        name: { type: 'string', order: 12, xml: 'Name', required: true },
        quickChoice: { type: 'boolean', order: 13, xml: 'QuickChoice', defaultValueXML: true },
        standardAttributes: { type: 'StandardAttributeDescriptions', order: 14, xml: 'StandardAttributes', defaultValueXML: undefined },
        synonym: { type: 'I8nText', order: 15, xml: 'Synonym' },
        useStandardCommands: { type: 'boolean', order: 16, xml: 'UseStandardCommands', defaultValueXML: false },
    },
};
