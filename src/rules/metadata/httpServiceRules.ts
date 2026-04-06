// src/rules/metadata/httpServiceRules.ts
// Rules for HTTPService metadata object (Designer format).
import { MetadataObjectRules } from '../types';

export const httpServiceRules: MetadataObjectRules = {
    rootTag: 'HTTPService',
    namespaces: {
        'xmlns': 'http://v8.1c.ru/8.3/MDClasses',
        'xmlns:v8': 'http://v8.1c.ru/8.1/data/core',
    },
    hasChildObjects: true,
    properties: {
        comment: { type: 'string', order: 1, xml: 'Comment', yaml: 'Комментарий', defaultValueXML: '' },
        name: { type: 'string', order: 2, xml: 'Name', yaml: 'Имя', required: true },
        reuseSessions: { type: 'SystemEnumeration', order: 3, xml: 'ReuseSessions', yaml: 'ПовторноеИспользованиеСеансов', defaultValueXML: 'AutoUse', typeSE: 'ReuseSessions' },
        rootURL: { type: 'string', order: 4, xml: 'RootURL', yaml: 'КорневойURL', defaultValueXML: 'edi' },
        sessionMaxAge: { type: 'number', order: 5, xml: 'SessionMaxAge', yaml: 'МаксимальноеВремяЖизниСеанса', defaultValueXML: 20 },
        synonym: { type: 'I8nText', order: 6, xml: 'Synonym', yaml: 'Синоним' },
    },
};
