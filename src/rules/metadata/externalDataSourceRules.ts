// src/rules/metadata/externalDataSourceRules.ts
// Rules for ExternalDataSource metadata object (Designer format).
import { MetadataObjectRules } from '../types';

export const externalDataSourceRules: MetadataObjectRules = {
    rootTag: 'ExternalDataSource',
    namespaces: {
        'xmlns': 'http://v8.1c.ru/8.3/MDClasses',
        'xmlns:v8': 'http://v8.1c.ru/8.1/data/core',
    },
    hasChildObjects: true,
    properties: {
        comment: { type: 'string', order: 1, xml: 'Comment', yaml: 'Комментарий', defaultValueXML: '' },
        dataLockControlMode: { type: 'SystemEnumeration', order: 2, xml: 'DataLockControlMode', yaml: 'РежимУправленияБлокировкойДанных', defaultValueXML: 'Automatic', typeSE: 'DefaultDataLockControlMode' },
        name: { type: 'string', order: 3, xml: 'Name', yaml: 'Имя', required: true },
        synonym: { type: 'I8nText', order: 4, xml: 'Synonym', yaml: 'Синоним' },
    },
};
