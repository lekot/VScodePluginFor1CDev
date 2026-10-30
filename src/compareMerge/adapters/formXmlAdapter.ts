import * as path from 'path';

import type { AdapterCompareInput, AdapterCompareResult, MergeAdapter } from './mergeAdapter';
import { buildXmlAdapterResult } from './semanticXml/semanticXmlAdapter';
import { SHARED_FORM_VALUE_STRUCTURES } from './semanticXml/semanticXmlPolicy';

const FORM_GROUPS = new Set(['Attributes', 'Commands', 'Parameters', 'ChildItems', 'Events']);
const FORM_ITEMS = new Set([
  'Item', 'Attribute', 'Command', 'Parameter', 'InputField', 'Table', 'UsualGroup', 'Button',
  'LabelField', 'Decoration', 'CheckBoxField', 'RadioButtonField', 'LabelDecoration', 'PictureField',
  'PictureDecoration', 'CalendarField', 'CommandBar', 'ButtonGroup', 'Popup',
  'Pages', 'Page', 'PageItem', 'Column', 'SearchStringAddition', 'SearchControlAddition', 'AutoCommandBar',
]);
const FORM_COMPLEX_ELEMENTS = new Set([
  'Form', 'ChildItems', 'Attributes', 'Commands', 'Parameters', 'Item', 'UsualGroup', 'Table', 'InputField',
  'Button', 'LabelField', 'Decoration', 'CheckBoxField', 'RadioButtonField', 'Pages', 'Page', 'Columns',
  'AutoCommandBar', 'CommandBar', 'ButtonGroup', 'Popup', 'PictureDecoration', 'CalendarField',
  'ContextMenu', 'ExtendedTooltip', 'Properties', 'Events', 'Attribute', 'Command', 'Parameter',
  'Title', 'Presentation', 'Picture', 'Representation',
]);

export const formXmlAdapter: MergeAdapter = {
  kind: 'formXml',
  async compare(input: AdapterCompareInput): Promise<AdapterCompareResult> {
    return buildXmlAdapterResult(input, {
      adapterKind: 'formXml',
      rootLabel: 'Form XML',
      rootKind: 'formXml',
      nodeIdPrefix: 'formXml',
      targetFilePath: input.artifactPaths?.left ?? formPath(input),
      sourceFilePath: input.artifactPaths?.right ?? formSourcePath(input),
      semanticKind: 'formXml',
      elementKind: ({ element }) => {
        const name = localName(element.name);
        if (FORM_GROUPS.has(name)) {
          return 'formGroup';
        }
        if (FORM_ITEMS.has(name)) {
          return 'formItem';
        }
        return 'xmlElement';
      },
      knownComplexElement: ({ element }) => {
        const name = localName(element.name);
        return FORM_COMPLEX_ELEMENTS.has(name) || SHARED_FORM_VALUE_STRUCTURES.has(name);
      },
    });
  },
};

function formPath(input: AdapterCompareInput): string {
  const leftContainer = input.match.left?.containerPath;
  const rightContainer = input.match.right?.containerPath;
  return path.join(leftContainer ?? rightContainer ?? '', 'Ext', 'Form.xml');
}

function formSourcePath(input: AdapterCompareInput): string | undefined {
  const container = input.match.right?.containerPath;
  return container ? path.join(container, 'Ext', 'Form.xml') : undefined;
}

function localName(name: string): string {
  return name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name;
}
