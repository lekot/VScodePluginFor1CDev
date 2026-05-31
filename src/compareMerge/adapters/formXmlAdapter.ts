import * as path from 'path';

import type { AdapterCompareInput, AdapterCompareResult, MergeAdapter } from './mergeAdapter';
import { buildXmlAdapterResult } from './xmlMetadataAdapter';

const FORM_GROUPS = new Set(['Attributes', 'Commands', 'Parameters', 'ChildItems', 'Events']);

export const formXmlAdapter: MergeAdapter = {
  kind: 'formXml',
  async compare(input: AdapterCompareInput): Promise<AdapterCompareResult> {
    return buildXmlAdapterResult(input, {
      adapterKind: 'formXml',
      rootLabel: 'Form XML',
      rootKind: 'formXml',
      nodeIdPrefix: 'formXml',
      targetFilePath: formPath(input),
      elementKind: ({ element }) => {
        if (FORM_GROUPS.has(element.name)) {
          return 'formGroup';
        }
        if (element.name === 'Item' || element.name === 'Attribute' || element.name === 'Command') {
          return 'formItem';
        }
        return 'xmlElement';
      },
    });
  },
};

function formPath(input: AdapterCompareInput): string {
  const leftContainer = input.match.left?.containerPath;
  const rightContainer = input.match.right?.containerPath;
  return path.join(leftContainer ?? rightContainer ?? '', 'Ext', 'Form.xml');
}
