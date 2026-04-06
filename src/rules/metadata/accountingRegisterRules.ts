// src/rules/metadata/accountingRegisterRules.ts
// Rules for AccountingRegister metadata object (Designer format).
import { MetadataObjectRules } from '../types';

export const accountingRegisterRules: MetadataObjectRules = {
    rootTag: 'AccountingRegister',
    namespaces: {
        'xmlns': 'http://v8.1c.ru/8.3/MDClasses',
        'xmlns:v8': 'http://v8.1c.ru/8.1/data/core',
        'xmlns:xr': 'http://v8.1c.ru/8.3/xcf/readable',
        'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
    },
    hasChildObjects: true,
    properties: {
        auxiliaryListForm: { type: 'string', order: 1, xml: 'AuxiliaryListForm', defaultValueXML: '' },
        chartOfAccounts: { type: 'string', order: 2, xml: 'ChartOfAccounts', yaml: 'ПланСчетов', defaultValueXML: '' },
        comment: { type: 'string', order: 3, xml: 'Comment', yaml: 'Комментарий', defaultValueXML: '' },
        correspondence: { type: 'boolean', order: 4, xml: 'Correspondence', yaml: 'Корреспонденция', defaultValueXML: true },
        dataLockControlMode: { type: 'SystemEnumeration', order: 5, xml: 'DataLockControlMode', defaultValueXML: 'Managed', typeSE: 'DataLockControlMode' },
        defaultListForm: { type: 'string', order: 6, xml: 'DefaultListForm', defaultValueXML: '' },
        explanation: { type: 'string', order: 7, xml: 'Explanation', defaultValueXML: '' },
        extendedListPresentation: { type: 'I8nText', order: 8, xml: 'ExtendedListPresentation', defaultValueXML: '{Synonym_ru}' },
        fullTextSearch: { type: 'SystemEnumeration', order: 9, xml: 'FullTextSearch', defaultValueXML: 'DontUse', typeSE: 'FullTextSearch' },
        includeHelpInContents: { type: 'boolean', order: 10, xml: 'IncludeHelpInContents', defaultValueXML: false },
        listPresentation: { type: 'I8nText', order: 11, xml: 'ListPresentation', defaultValueXML: '{Synonym_ru}' },
        name: { type: 'string', order: 12, xml: 'Name', yaml: 'Имя', required: true },
        periodAdjustmentLength: { type: 'number', order: 13, xml: 'PeriodAdjustmentLength', yaml: 'ДлинаПериодаКорректировки', defaultValueXML: 3 },
        synonym: { type: 'I8nText', order: 14, xml: 'Synonym', yaml: 'Синоним' },
        useStandardCommands: { type: 'boolean', order: 15, xml: 'UseStandardCommands', defaultValueXML: true },
    },
};
