// src/rules/metadata/exchangePlanRules.ts
// Rules for ExchangePlan metadata object (Designer format).
import { MetadataObjectRules } from '../types';

export const exchangePlanRules: MetadataObjectRules = {
    rootTag: 'ExchangePlan',
    namespaces: {
        'xmlns': 'http://v8.1c.ru/8.3/MDClasses',
        'xmlns:v8': 'http://v8.1c.ru/8.1/data/core',
        'xmlns:xr': 'http://v8.1c.ru/8.3/xcf/readable',
        'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
    },
    hasChildObjects: true,
    properties: {
        codeLength: { type: 'number', order: 1, xml: 'CodeLength', yaml: 'ДлинаКода', defaultValueXML: 9 },
        comment: { type: 'string', order: 2, xml: 'Comment', yaml: 'Комментарий', defaultValueXML: '' },
        descriptionLength: { type: 'number', order: 3, xml: 'DescriptionLength', yaml: 'ДлинаНаименования', defaultValueXML: 100 },
        distributedInfoBase: { type: 'boolean', order: 4, xml: 'DistributedInfoBase', yaml: 'РаспределённаяИнформационнаяБаза', defaultValueXML: false },
        includeConfigurationExtensions: { type: 'boolean', order: 5, xml: 'IncludeConfigurationExtensions', yaml: 'ВключатьРасширенияКонфигурации', defaultValueXML: false },
        name: { type: 'string', order: 6, xml: 'Name', yaml: 'Имя', required: true },
        synonym: { type: 'I8nText', order: 7, xml: 'Synonym', yaml: 'Синоним' },
        useStandardCommands: { type: 'boolean', order: 8, xml: 'UseStandardCommands', defaultValueXML: true },
    },
};
