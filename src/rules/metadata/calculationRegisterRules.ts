// src/rules/metadata/calculationRegisterRules.ts
// Rules for CalculationRegister metadata object (Designer format).
import { MetadataObjectRules } from '../types';

export const calculationRegisterRules: MetadataObjectRules = {
    rootTag: 'CalculationRegister',
    namespaces: {
        'xmlns': 'http://v8.1c.ru/8.3/MDClasses',
        'xmlns:v8': 'http://v8.1c.ru/8.1/data/core',
        'xmlns:xr': 'http://v8.1c.ru/8.3/xcf/readable',
        'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
    },
    hasChildObjects: true,
    properties: {
        actionPeriod: { type: 'boolean', order: 1, xml: 'ActionPeriod', yaml: 'ПериодДействия', defaultValueXML: true },
        auxiliaryListForm: { type: 'string', order: 2, xml: 'AuxiliaryListForm', defaultValueXML: '' },
        basePeriod: { type: 'boolean', order: 3, xml: 'BasePeriod', yaml: 'БазовыйПериод', defaultValueXML: true },
        chartOfCalculationTypes: { type: 'string', order: 4, xml: 'ChartOfCalculationTypes', yaml: 'ПланВидовРасчета', defaultValueXML: '' },
        comment: { type: 'string', order: 5, xml: 'Comment', yaml: 'Комментарий', defaultValueXML: '' },
        dataLockControlMode: { type: 'SystemEnumeration', order: 6, xml: 'DataLockControlMode', defaultValueXML: 'Managed', typeSE: 'DataLockControlMode' },
        defaultListForm: { type: 'string', order: 7, xml: 'DefaultListForm', defaultValueXML: '' },
        explanation: { type: 'string', order: 8, xml: 'Explanation', defaultValueXML: '' },
        extendedListPresentation: { type: 'I8nText', order: 9, xml: 'ExtendedListPresentation', defaultValueXML: '{Synonym_ru}' },
        fullTextSearch: { type: 'SystemEnumeration', order: 10, xml: 'FullTextSearch', defaultValueXML: 'DontUse', typeSE: 'FullTextSearch' },
        includeHelpInContents: { type: 'boolean', order: 11, xml: 'IncludeHelpInContents', defaultValueXML: false },
        listPresentation: { type: 'I8nText', order: 12, xml: 'ListPresentation', defaultValueXML: '{Synonym_ru}' },
        name: { type: 'string', order: 13, xml: 'Name', yaml: 'Имя', required: true },
        periodicity: { type: 'SystemEnumeration', order: 14, xml: 'Periodicity', yaml: 'Периодичность', defaultValueXML: 'Month', typeSE: 'CalculationRegisterPeriodicity' },
        schedule: { type: 'string', order: 15, xml: 'Schedule', defaultValueXML: '' },
        scheduleDate: { type: 'string', order: 16, xml: 'ScheduleDate', defaultValueXML: '' },
        scheduleValue: { type: 'string', order: 17, xml: 'ScheduleValue', defaultValueXML: '' },
        synonym: { type: 'I8nText', order: 18, xml: 'Synonym', yaml: 'Синоним' },
        useStandardCommands: { type: 'boolean', order: 19, xml: 'UseStandardCommands', defaultValueXML: true },
    },
};
