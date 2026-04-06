// src/rules/metadata/integrationServiceRules.ts
// Rules for IntegrationService metadata object (Designer format).
import { MetadataObjectRules } from '../types';

export const integrationServiceRules: MetadataObjectRules = {
    rootTag: 'IntegrationService',
    namespaces: {
        'xmlns': 'http://v8.1c.ru/8.3/MDClasses',
        'xmlns:v8': 'http://v8.1c.ru/8.1/data/core',
    },
    hasChildObjects: true,
    properties: {
        comment: { type: 'string', order: 1, xml: 'Comment', yaml: 'Комментарий', defaultValueXML: '' },
        externalIntegrationServiceAddress: { type: 'string', order: 2, xml: 'ExternalIntegrationServiceAddress', yaml: 'АдресВнешнегоИнтеграционногоСервиса', defaultValueXML: 'http://localhost' },
        name: { type: 'string', order: 3, xml: 'Name', yaml: 'Имя', required: true },
        synonym: { type: 'I8nText', order: 4, xml: 'Synonym', yaml: 'Синоним' },
    },
};
