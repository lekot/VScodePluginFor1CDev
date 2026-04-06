// src/rules/metadata/webServiceRules.ts
// Rules for WebService metadata object (Designer format).
import { MetadataObjectRules } from '../types';

export const webServiceRules: MetadataObjectRules = {
    rootTag: 'WebService',
    namespaces: {
        'xmlns': 'http://v8.1c.ru/8.3/MDClasses',
        'xmlns:v8': 'http://v8.1c.ru/8.1/data/core',
        'xmlns:xr': 'http://v8.1c.ru/8.3/xcf/readable',
        'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
    },
    hasChildObjects: true,
    properties: {
        comment: { type: 'string', order: 1, xml: 'Comment', yaml: 'Комментарий', defaultValueXML: '' },
        descriptorFileName: { type: 'string', order: 2, xml: 'DescriptorFileName', yaml: 'ИмяФайлаДескриптора', defaultValueXML: '' },
        name: { type: 'string', order: 3, xml: 'Name', yaml: 'Имя', required: true },
        namespace: { type: 'string', order: 4, xml: 'Namespace', yaml: 'Пространствоимён', defaultValueXML: 'http://localhost/placeholder' },
        reuseSessions: { type: 'SystemEnumeration', order: 5, xml: 'ReuseSessions', yaml: 'ПовторноеИспользованиеСеансов', defaultValueXML: 'DontUse', typeSE: 'WSServiceSessionReuseMode' },
        sessionMaxAge: { type: 'number', order: 6, xml: 'SessionMaxAge', yaml: 'МаксимальныйВозрастСеанса', defaultValueXML: 20 },
        synonym: { type: 'I8nText', order: 7, xml: 'Synonym', yaml: 'Синоним' },
        xdtoPackages: { type: 'string', order: 8, xml: 'XDTOPackages', yaml: 'ПакетыXDTO', defaultValueXML: '' },
    },
};
