// src/rules/metadata/subsystemRules.ts
// Rules for Subsystem metadata object (Designer format).
import { MetadataObjectRules } from '../types';

export const subsystemRules: MetadataObjectRules = {
    rootTag: 'Subsystem',
    namespaces: {
        'xmlns': 'http://v8.1c.ru/8.3/MDClasses',
        'xmlns:v8': 'http://v8.1c.ru/8.1/data/core',
        'xmlns:xr': 'http://v8.1c.ru/8.3/xcf/readable',
        'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
    },
    hasChildObjects: true,
    properties: {
        comment: { type: 'string', order: 1, xml: 'Comment', yaml: 'Комментарий', defaultValueXML: '' },
        content: { type: 'InternalInfo', order: 2, xml: 'Content', defaultValueXML: '' },
        explanation: { type: 'string', order: 3, xml: 'Explanation', defaultValueXML: '' },
        includeHelpInContents: { type: 'boolean', order: 4, xml: 'IncludeHelpInContents', defaultValueXML: false },
        includeInCommandInterface: { type: 'boolean', order: 5, xml: 'IncludeInCommandInterface', yaml: 'ВключатьВКомандныйИнтерфейс', defaultValueXML: true },
        name: { type: 'string', order: 6, xml: 'Name', yaml: 'Имя', required: true },
        synonym: { type: 'I8nText', order: 7, xml: 'Synonym', yaml: 'Синоним' },
        useOneCommand: { type: 'boolean', order: 8, xml: 'UseOneCommand', defaultValueXML: false },
    },
};
