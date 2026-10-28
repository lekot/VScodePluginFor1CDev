import * as path from 'path';

import type { AdapterCompareInput, AdapterCompareResult, MergeAdapter } from './mergeAdapter';
import { buildXmlAdapterResult } from './semanticXml/semanticXmlAdapter';

export const predefinedXmlAdapter: MergeAdapter = {
  kind: 'predefinedXml',
  async compare(input: AdapterCompareInput): Promise<AdapterCompareResult> {
    return buildXmlAdapterResult(input, {
      adapterKind: 'predefinedXml',
      rootLabel: 'Predefined XML',
      rootKind: 'predefinedXml',
      nodeIdPrefix: 'predefinedXml',
      targetFilePath: input.artifactPaths?.left ?? predefinedPath(input),
      sourceFilePath: input.artifactPaths?.right ?? predefinedSourcePath(input),
      semanticKind: 'predefinedXml',
      elementKind: ({ element }) => (localName(element.name) === 'Item' ? 'predefinedItem' : 'xmlElement'),
      knownComplexElement: ({ element }) => ['PredefinedData', 'Item'].includes(localName(element.name)),
    });
  },
};

function predefinedPath(input: AdapterCompareInput): string {
  const leftContainer = input.match.left?.containerPath;
  const rightContainer = input.match.right?.containerPath;
  return path.join(leftContainer ?? rightContainer ?? '', 'Ext', 'Predefined.xml');
}

function predefinedSourcePath(input: AdapterCompareInput): string | undefined {
  const container = input.match.right?.containerPath;
  return container ? path.join(container, 'Ext', 'Predefined.xml') : undefined;
}

function localName(name: string): string {
  return name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name;
}
