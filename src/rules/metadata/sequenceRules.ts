// Rules for Sequence metadata object (Designer format).
import { MetadataObjectRules } from '../types';

export const sequenceRules: MetadataObjectRules = {
    rootTag: 'Sequence',
    namespaces: {
        'xmlns': 'http://v8.1c.ru/8.3/MDClasses',
        'xmlns:v8': 'http://v8.1c.ru/8.1/data/core',
        'xmlns:xr': 'http://v8.1c.ru/8.3/xcf/readable',
        'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
    },
    hasChildObjects: true,
    properties: {
        comment: { type: 'string', order: 1, xml: 'Comment', yaml: 'Комментарий', defaultValueXML: '' },
        documents: { type: 'MetadataValueCollection', order: 2, xml: 'Documents', yaml: 'Документы', defaultValueXML: {} },
        moveBoundaryOnPosting: { type: 'SystemEnumeration', order: 3, xml: 'MoveBoundaryOnPosting', yaml: 'ПеремещениеГраницыПриПроведении', defaultValueXML: 'DontMove', typeSE: 'MoveBoundaryOnPosting' },
        name: { type: 'string', order: 4, xml: 'Name', yaml: 'Имя', required: true },
        synonym: { type: 'I8nText', order: 5, xml: 'Synonym', yaml: 'Синоним' },
    },
};
