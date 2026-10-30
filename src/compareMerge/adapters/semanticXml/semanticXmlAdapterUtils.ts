import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import type { CompareTreeStatus } from '../../compareTreeTypes';
import type { AdapterCompareInput, MetadataObjectUnit } from '../mergeAdapter';
import { getXmlElementIdentityKey } from '../../xml/xmlDom';
import { localXmlName as localName, semanticXmlIdentityKey } from './semanticXmlIdentity';
import type { IndexedChild, XmlElementNode } from './semanticXmlAdapter';
import type { SemanticXmlKind } from './semanticXmlValidator';

export function hasReorder(left: readonly IndexedChild[], right: readonly IndexedChild[]): boolean {
  const leftCommon = left.map((item) => item.key).filter((key) => right.some((candidate) => candidate.key === key));
  const rightCommon = right.map((item) => item.key).filter((key) => left.some((candidate) => candidate.key === key));
  return leftCommon.length > 1 && leftCommon.some((key, index) => key !== rightCommon[index]);
}

export function indexChildren(children: readonly XmlElementNode[], parent: XmlElementNode, kind: SemanticXmlKind): {
  map: Map<string, IndexedChild>;
  ordered: IndexedChild[];
} {
  const ordinals = new Map<string, number>();
  const map = new Map<string, IndexedChild>();
  const ordered: IndexedChild[] = [];
  for (const element of children) {
    const name = localName(element.name);
    const position = ordinals.get(name) ?? 0;
    ordinals.set(name, position + 1);
    const identity = semanticXmlIdentityKey(element.dom, parent.dom, kind);
    const addressIdentity = getXmlElementIdentityKey(element.dom);
    const childSelector = addressIdentity ?? String(position);
    const key = name + ':' + (identity ?? '#' + position);
    const item = {
      element,
      selector: childSelector,
      key,
      position: element.parent?.dom.children.indexOf(element.dom) ?? position,
    };
    map.set(key, item);
    ordered.push(item);
  }
  return { map, ordered };
}

export function isPropertyLeaf(left?: XmlElementNode, right?: XmlElementNode): boolean {
  return Boolean(
    (!left || left.children.length === 0) &&
    (!right || right.children.length === 0) &&
    (left?.text ?? '') !== (right?.text ?? '')
  );
}

export function shouldShowStatus(status: CompareTreeStatus, strategy: AdapterCompareInput['strategy']): boolean {
  if (status === 'changed') {
    return true;
  }
  if (strategy === 'full') {
    return status === 'rightOnly' || status === 'leftOnly';
  }
  return strategy === 'left' ? status === 'leftOnly' : status === 'rightOnly';
}

export function rightSourceId(input: AdapterCompareInput): string {
  return input.session.state.sources.find((source) => source.side === 'right')?.sourceId ?? 'right-source';
}

export function rightSnapshotId(input: AdapterCompareInput): string {
  const source = input.session.state.sources.find((entry) => entry.side === 'right');
  return source?.snapshotId ??
    input.session.state.snapshots.find((snapshot) => snapshot.readOnly)?.snapshotId ??
    'snapshot-right';
}

export function targetDescriptorPath(left: MetadataObjectUnit | undefined, right: MetadataObjectUnit | undefined): string {
  return left?.descriptorPath ?? right?.descriptorPath ?? 'unknown.xml';
}

export function stableNodePrefix(prefix: string, filePath: string): string {
  return prefix + ':' + encodeURIComponent(path.resolve(localFilePath(filePath)).replace(/\\/g, '/'));
}

export function targetUri(filePath: string): string {
  const normalized = localFilePath(filePath);
  return path.isAbsolute(normalized) ? pathToFileURL(normalized).toString() : normalized;
}

export function localFilePath(value: string): string {
  return value.startsWith('file:') ? fileURLToPath(value) : value;
}

export function semanticKind(adapterKind: string): SemanticXmlKind {
  return adapterKind === 'formXml' || adapterKind === 'predefinedXml' || adapterKind === 'roleRightsXml' || adapterKind === 'dcsXml'
    ? adapterKind
    : 'metadataXml';
}
