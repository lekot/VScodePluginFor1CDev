// src/rules/metadata/eventSubscriptionRules.ts
// Rules for EventSubscription metadata object (Designer format).
import { MetadataObjectRules } from '../types';

export const eventSubscriptionRules: MetadataObjectRules = {
    rootTag: 'EventSubscription',
    namespaces: {
        'xmlns': 'http://v8.1c.ru/8.3/MDClasses',
        'xmlns:v8': 'http://v8.1c.ru/8.1/data/core',
    },
    hasChildObjects: false,
    properties: {
        comment: { type: 'string', order: 1, xml: 'Comment', yaml: 'Комментарий', defaultValueXML: '' },
        event: { type: 'SystemEnumeration', order: 2, xml: 'Event', yaml: 'Событие', defaultValueXML: 'BeforeWrite', typeSE: 'EventSubscriptionEvent' },
        handler: { type: 'string', order: 3, xml: 'Handler', yaml: 'Обработчик', defaultValueXML: '' },
        name: { type: 'string', order: 4, xml: 'Name', yaml: 'Имя', required: true },
        source: { type: 'TypeDescription', order: 5, xml: 'Source', defaultValueXML: {} },
        synonym: { type: 'I8nText', order: 6, xml: 'Synonym', yaml: 'Синоним' },
    },
};
