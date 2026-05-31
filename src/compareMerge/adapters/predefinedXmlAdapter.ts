import * as path from 'path';

import type { AdapterCompareInput, AdapterCompareResult, MergeAdapter } from './mergeAdapter';
import { buildXmlAdapterResult } from './xmlMetadataAdapter';

export const predefinedXmlAdapter: MergeAdapter = {
  kind: 'predefinedXml',
  async compare(input: AdapterCompareInput): Promise<AdapterCompareResult> {
    return buildXmlAdapterResult(input, {
      adapterKind: 'predefinedXml',
      rootLabel: 'Predefined XML',
      rootKind: 'predefinedXml',
      nodeIdPrefix: 'predefinedXml',
      targetFilePath: predefinedPath(input),
      elementKind: ({ element }) => (element.name === 'Item' ? 'predefinedItem' : 'xmlElement'),
    });
  },
};

function predefinedPath(input: AdapterCompareInput): string {
  const leftContainer = input.match.left?.containerPath;
  const rightContainer = input.match.right?.containerPath;
  return path.join(leftContainer ?? rightContainer ?? '', 'Ext', 'Predefined.xml');
}
