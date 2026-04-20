// src/rules/metadata/commonCommandRules.ts
// Rules for CommonCommand metadata object (Designer format).
import { MetadataObjectRules } from '../types';

export const commonCommandRules: MetadataObjectRules = {
    rootTag: 'CommonCommand',
    namespaces: {
        'xmlns': 'http://v8.1c.ru/8.3/MDClasses',
        'xmlns:v8': 'http://v8.1c.ru/8.1/data/core',
    },
    hasChildObjects: false,
    properties: {
        comment: { type: 'string', order: 1, xml: 'Comment', yaml: 'Комментарий', defaultValueXML: '' },
        group: { type: 'string', order: 2, xml: 'Group', defaultValueXML: '' },
        name: { type: 'string', order: 3, xml: 'Name', yaml: 'Имя', required: true },
        representation: { type: 'SystemEnumeration', order: 4, xml: 'Representation', yaml: 'Отображение', defaultValueXML: 'Picture', typeSE: 'ButtonRepresentation' },
        synonym: { type: 'I8nText', order: 5, xml: 'Synonym', yaml: 'Синоним' },
        toolTip: { type: 'I8nText', order: 6, xml: 'ToolTip', yaml: 'Подсказка', defaultValueXML: '' },
        picture: { type: 'InternalInfo', order: 7, xml: 'Picture', defaultValueXML: {} },
        shortcut: { type: 'InternalInfo', order: 8, xml: 'Shortcut', defaultValueXML: {} },
        includeHelpInContents: { type: 'boolean', order: 9, xml: 'IncludeHelpInContents', defaultValueXML: false },
        commandParameterType: { type: 'InternalInfo', order: 10, xml: 'CommandParameterType', defaultValueXML: {} },
        parameterUseMode: { type: 'SystemEnumeration', order: 11, xml: 'ParameterUseMode', typeSE: 'CommandParameterUseMode', defaultValueXML: 'Single' },
        modifiesData: { type: 'boolean', order: 12, xml: 'ModifiesData', defaultValueXML: false },
        onMainServerUnavailableBehavior: { type: 'SystemEnumeration', order: 13, xml: 'OnMainServerUnavalableBehavior', typeSE: 'OnMainServerUnavailableBehavior', defaultValueXML: 'Auto' },
    },
};
