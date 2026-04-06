// src/rules/metadata/scheduledJobRules.ts
// Rules for ScheduledJob metadata object (Designer format).
import { MetadataObjectRules } from '../types';

export const scheduledJobRules: MetadataObjectRules = {
    rootTag: 'ScheduledJob',
    namespaces: {
        'xmlns': 'http://v8.1c.ru/8.3/MDClasses',
        'xmlns:v8': 'http://v8.1c.ru/8.1/data/core',
    },
    hasChildObjects: false,
    properties: {
        comment: { type: 'string', order: 1, xml: 'Comment', yaml: 'Комментарий', defaultValueXML: '' },
        description: { type: 'string', order: 2, xml: 'Description', yaml: 'Описание', defaultValueXML: '' },
        key: { type: 'string', order: 3, xml: 'Key', yaml: 'Ключ', defaultValueXML: '' },
        methodName: { type: 'string', order: 4, xml: 'MethodName', yaml: 'ИмяМетода', defaultValueXML: '' },
        name: { type: 'string', order: 5, xml: 'Name', yaml: 'Имя', required: true },
        predefined: { type: 'boolean', order: 6, xml: 'Predefined', yaml: 'Предопределённый', defaultValueXML: false },
        restartCountOnFailure: { type: 'number', order: 7, xml: 'RestartCountOnFailure', yaml: 'КоличествоПовторовПриАварийномЗавершении', defaultValueXML: 3 },
        restartIntervalOnFailure: { type: 'number', order: 8, xml: 'RestartIntervalOnFailure', yaml: 'ИнтервалПовтораПриАварийномЗавершении', defaultValueXML: 10 },
        synonym: { type: 'I8nText', order: 9, xml: 'Synonym', yaml: 'Синоним' },
        use: { type: 'boolean', order: 10, xml: 'Use', yaml: 'Использование', defaultValueXML: false },
    },
};
