// src/rules/metadata/informationRegisterRules.ts
// Rules for InformationRegister metadata object (Designer format).
import { MetadataObjectRules } from '../types';

export const informationRegisterRules: MetadataObjectRules = {
    rootTag: 'InformationRegister',
    namespaces: {
        'xmlns': 'http://v8.1c.ru/8.3/MDClasses',
        'xmlns:v8': 'http://v8.1c.ru/8.1/data/core',
        'xmlns:xr': 'http://v8.1c.ru/8.3/xcf/readable',
        'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
    },
    hasChildObjects: true,
    properties: {
        auxiliaryListForm: { type: 'string', order: 1, xml: 'AuxiliaryListForm', defaultValueXML: '' },
        auxiliaryRecordForm: { type: 'string', order: 2, xml: 'AuxiliaryRecordForm', defaultValueXML: '' },
        comment: { type: 'string', order: 3, xml: 'Comment', yaml: 'Комментарий', defaultValueXML: '' },
        dataHistory: { type: 'SystemEnumeration', order: 4, xml: 'DataHistory', defaultValueXML: 'DontUse', typeSE: 'DataHistory' },
        dataLockControlMode: { type: 'SystemEnumeration', order: 5, xml: 'DataLockControlMode', defaultValueXML: 'Managed', typeSE: 'DataLockControlMode' },
        defaultListForm: { type: 'string', order: 6, xml: 'DefaultListForm', defaultValueXML: '' },
        defaultRecordForm: { type: 'string', order: 7, xml: 'DefaultRecordForm', defaultValueXML: '' },
        editType: { type: 'SystemEnumeration', order: 8, xml: 'EditType', defaultValueXML: 'InDialog', typeSE: 'EditType' },
        enableTotalsSliceFirst: { type: 'boolean', order: 9, xml: 'EnableTotalsSliceFirst', yaml: 'РазрешитьИтогиСрезПервых', defaultValueXML: false },
        enableTotalsSliceLast: { type: 'boolean', order: 10, xml: 'EnableTotalsSliceLast', yaml: 'РазрешитьИтогиСрезПоследних', defaultValueXML: false },
        executeAfterWriteDataHistoryVersionProcessing: { type: 'boolean', order: 11, xml: 'ExecuteAfterWriteDataHistoryVersionProcessing', defaultValueXML: false },
        explanation: { type: 'string', order: 12, xml: 'Explanation', defaultValueXML: '' },
        extendedListPresentation: { type: 'I8nText', order: 13, xml: 'ExtendedListPresentation', defaultValueXML: '{Synonym_ru}' },
        extendedRecordPresentation: { type: 'string', order: 14, xml: 'ExtendedRecordPresentation', defaultValueXML: '' },
        fullTextSearch: { type: 'SystemEnumeration', order: 15, xml: 'FullTextSearch', defaultValueXML: 'DontUse', typeSE: 'FullTextSearch' },
        includeHelpInContents: { type: 'boolean', order: 16, xml: 'IncludeHelpInContents', defaultValueXML: false },
        informationRegisterPeriodicity: { type: 'SystemEnumeration', order: 17, xml: 'InformationRegisterPeriodicity', yaml: 'Периодичность', defaultValueXML: 'Nonperiodical', typeSE: 'InformationRegisterPeriodicity' },
        listPresentation: { type: 'I8nText', order: 18, xml: 'ListPresentation', defaultValueXML: '{Synonym_ru}' },
        mainFilterOnPeriod: { type: 'boolean', order: 19, xml: 'MainFilterOnPeriod', yaml: 'ОсновнойОтборПоПериоду', defaultValueXML: false },
        name: { type: 'string', order: 20, xml: 'Name', yaml: 'Имя', required: true },
        recordPresentation: { type: 'string', order: 21, xml: 'RecordPresentation', defaultValueXML: '' },
        standardAttributes: { type: 'StandardAttributeDescriptions', order: 22, xml: 'StandardAttributes', defaultValueXML: undefined },
        synonym: { type: 'I8nText', order: 23, xml: 'Synonym', yaml: 'Синоним' },
        updateDataHistoryImmediatelyAfterWrite: { type: 'boolean', order: 24, xml: 'UpdateDataHistoryImmediatelyAfterWrite', defaultValueXML: false },
        useStandardCommands: { type: 'boolean', order: 25, xml: 'UseStandardCommands', defaultValueXML: true },
        writeMode: { type: 'SystemEnumeration', order: 26, xml: 'WriteMode', yaml: 'РежимЗаписи', defaultValueXML: 'Independent', typeSE: 'RegisterWriteMode' },
    },
};
