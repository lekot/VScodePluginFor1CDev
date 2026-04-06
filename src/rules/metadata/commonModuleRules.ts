// src/rules/metadata/commonModuleRules.ts
// Rules for CommonModule metadata object (Designer format).
import { MetadataObjectRules } from '../types';

export const commonModuleRules: MetadataObjectRules = {
    rootTag: 'CommonModule',
    namespaces: {
        'xmlns': 'http://v8.1c.ru/8.3/MDClasses',
        'xmlns:v8': 'http://v8.1c.ru/8.1/data/core',
    },
    hasChildObjects: false,
    properties: {
        clientManagedApplication: { type: 'boolean', order: 1, xml: 'ClientManagedApplication', yaml: 'КлиентУправляемоеПриложение', defaultValueXML: true },
        clientOrdinaryApplication: { type: 'boolean', order: 2, xml: 'ClientOrdinaryApplication', yaml: 'КлиентОбычноеПриложение', defaultValueXML: true },
        comment: { type: 'string', order: 3, xml: 'Comment', yaml: 'Комментарий', defaultValueXML: '' },
        externalConnection: { type: 'boolean', order: 4, xml: 'ExternalConnection', yaml: 'ВнешнееСоединение', defaultValueXML: false },
        global: { type: 'boolean', order: 5, xml: 'Global', yaml: 'Глобальный', defaultValueXML: false },
        name: { type: 'string', order: 6, xml: 'Name', yaml: 'Имя', required: true },
        privileged: { type: 'boolean', order: 7, xml: 'Privileged', yaml: 'Привилегированный', defaultValueXML: false },
        returnValuesReuse: { type: 'SystemEnumeration', order: 8, xml: 'ReturnValuesReuse', yaml: 'ПовторноеИспользованиеВозвращаемыхЗначений', defaultValueXML: 'DontUse', typeSE: 'ReturnValuesReuseMode' },
        server: { type: 'boolean', order: 9, xml: 'Server', yaml: 'Сервер', defaultValueXML: false },
        serverCall: { type: 'boolean', order: 10, xml: 'ServerCall', yaml: 'ВызовСервера', defaultValueXML: false },
        synonym: { type: 'I8nText', order: 11, xml: 'Synonym', yaml: 'Синоним' },
    },
};
