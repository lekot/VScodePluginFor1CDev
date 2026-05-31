import { createHash } from 'crypto';
import * as path from 'path';
import { pathToFileURL } from 'url';

import { XMLParser } from 'fast-xml-parser';

import type { CompareTreeNode, CompareTreeStatus } from '../compareTreeTypes';
import type { CompareMessage } from '../domain/compareContracts';
import type { MergeCandidate } from '../merge/mergePreview';
import { applyXmlPatch as applyDomXmlPatch } from '../xml/xmlPatch';
import type {
  AdapterCompareInput,
  AdapterCompareResult,
  ExecutableCandidateFactory,
  MergeAdapter,
  MetadataObjectUnit,
  XmlPatchPayload,
} from './mergeAdapter';

const RIGHT_SOURCE_ID = 'right-source';
const ATTRIBUTE_PREFIX = '@_';
const TEXT_NODE = '#text';

export interface XmlElementNode {
  name: string;
  attributes: Readonly<Record<string, string>>;
  children: readonly XmlElementNode[];
  text?: string;
}

export interface XmlAdapterProjectionOptions {
  adapterKind: string;
  rootLabel: string;
  rootKind: string;
  nodeIdPrefix: string;
  targetFilePath: string;
  elementKind?: (input: XmlElementKindInput) => string;
}

export interface XmlElementKindInput {
  element: XmlElementNode;
  parent?: XmlElementNode;
  depth: number;
}

interface XmlCompareContext {
  input: AdapterCompareInput;
  options: XmlAdapterProjectionOptions;
  expectedOldHash: string;
  incomingHash: string;
  sourceId: string;
  snapshotId: string;
  candidateFactories: Map<string, ExecutableCandidateFactory>;
}

interface XmlCompareLocation {
  pointer: string;
  displayPath: string;
  identityKey?: string;
}

interface PlannedXmlMergeCandidate extends MergeCandidate {
  xmlPatch: XmlPatchPayload;
}

export const metadataXmlAdapter: MergeAdapter = {
  kind: 'metadataXml',
  async compare(input: AdapterCompareInput): Promise<AdapterCompareResult> {
    return buildXmlAdapterResult(input, {
      adapterKind: 'metadataXml',
      rootLabel: 'Descriptor XML',
      rootKind: 'metadataXml',
      nodeIdPrefix: 'metadataXml',
      targetFilePath: targetDescriptorPath(input.match.left, input.match.right),
    });
  },
};

export function buildXmlAdapterResult(
  input: AdapterCompareInput,
  options: XmlAdapterProjectionOptions
): AdapterCompareResult {
  const candidateFactories = new Map<string, ExecutableCandidateFactory>();
  const diagnostics: CompareMessage[] = [];
  const parsed = parsePair(input, options.adapterKind, diagnostics);
  if (!parsed) {
    return { nodes: [], candidateFactories, diagnostics };
  }

  const context: XmlCompareContext = {
    input,
    options,
    expectedOldHash: hashText(input.snapshots.left),
    incomingHash: hashText(input.snapshots.right),
    sourceId: rightSourceId(input),
    snapshotId: rightSnapshotId(input),
    candidateFactories,
  };
  const rootLocation = locationForRoot(parsed.left, parsed.right);
  const children = compareChildren(parsed.left, parsed.right, rootLocation, context, 1);
  const root = branchNode({
    id: `${options.nodeIdPrefix}:root`,
    label: options.rootLabel,
    kind: options.rootKind,
    children,
  });

  return {
    nodes: children.length === 0 ? [] : [root],
    candidateFactories,
    diagnostics,
  };
}

export function parseXmlDocument(source: string): XmlElementNode {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: ATTRIBUTE_PREFIX,
    textNodeName: TEXT_NODE,
    trimValues: true,
    parseTagValue: false,
    parseAttributeValue: false,
  });
  const parsed = parser.parse(source) as unknown;
  if (!isRecord(parsed)) {
    throw new Error('XML document root is not an element.');
  }

  const rootName = Object.keys(parsed).find((key) => key !== '?xml');
  if (!rootName) {
    throw new Error('XML document root is missing.');
  }

  return convertElement(rootName, parsed[rootName])[0]!;
}

export function childText(element: XmlElementNode | undefined, childName: string): string | undefined {
  return element?.children.find((child) => localName(child.name) === childName)?.text;
}

export function elementDisplayName(element: XmlElementNode): string {
  return (
    childText(element, 'Name') ??
    element.children
      .find((child) => localName(child.name) === 'Properties')
      ?.children.find((child) => localName(child.name) === 'Name')?.text ??
    element.attributes.id ??
    element.attributes.uuid ??
    element.name
  );
}

function parsePair(
  input: AdapterCompareInput,
  adapterKind: string,
  diagnostics: CompareMessage[]
): { left: XmlElementNode; right: XmlElementNode } | undefined {
  try {
    return {
      left: parseXmlDocument(input.snapshots.left),
      right: parseXmlDocument(input.snapshots.right),
    };
  } catch (error) {
    diagnostics.push({
      severity: 'error',
      code: 'XML_ADAPTER_PARSE_FAILED',
      phase: 'compare',
      sourceId: RIGHT_SOURCE_ID,
      blocking: true,
      suggestedAction: `${adapterKind}: ${error instanceof Error ? error.message : String(error)}`,
    });
    return undefined;
  }
}

function compareChildren(
  leftParent: XmlElementNode,
  rightParent: XmlElementNode,
  parentLocation: XmlCompareLocation,
  context: XmlCompareContext,
  depth: number
): CompareTreeNode[] {
  const children: CompareTreeNode[] = [
    ...compareAttributes(leftParent, rightParent, parentLocation, context),
  ];
  const leftChildren = indexChildren(leftParent.children);
  const rightChildren = indexChildren(rightParent.children);
  const keys = [...new Set([...leftChildren.keys(), ...rightChildren.keys()])].sort();

  for (const key of keys) {
    const left = leftChildren.get(key);
    const right = rightChildren.get(key);
    const node = compareElement(left, right, parentLocation, context, depth);
    if (node) {
      children.push(node);
    }
  }

  return children;
}

function compareElement(
  left: XmlElementNode | undefined,
  right: XmlElementNode | undefined,
  parentLocation: XmlCompareLocation,
  context: XmlCompareContext,
  depth: number
): CompareTreeNode | undefined {
  const element = right ?? left;
  if (!element) {
    return undefined;
  }

  const status = elementStatus(left, right);
  if (!shouldShowStatus(status, context.input.strategy)) {
    return undefined;
  }

  const location = childLocation(parentLocation, element);
  if (isPropertyLeaf(left, right)) {
    return propertyNode({
      element,
      leftValue: left?.text ?? '',
      rightValue: right?.text ?? '',
      status,
      location,
      context,
    });
  }

  if (!left || !right) {
    return subtreeNode({
      element,
      status: left ? 'leftOnly' : 'rightOnly',
      location,
      context,
      depth,
    });
  }

  const children = compareChildren(left, right, location, context, depth + 1);
  if (children.length === 0) {
    return undefined;
  }

  return branchNode({
    id: `${context.options.nodeIdPrefix}:element:${encodeId(location.pointer)}`,
    label: elementDisplayName(element),
    kind: elementKind(context, element, depth),
    children,
  });
}

function compareAttributes(
  left: XmlElementNode,
  right: XmlElementNode,
  parentLocation: XmlCompareLocation,
  context: XmlCompareContext
): CompareTreeNode[] {
  const names = [...new Set([...Object.keys(left.attributes), ...Object.keys(right.attributes)])].sort();
  return names
    .map((name) => {
      const leftValue = left.attributes[name];
      const rightValue = right.attributes[name];
      if (leftValue === rightValue) {
        return undefined;
      }
      const status: CompareTreeStatus =
        leftValue === undefined ? 'rightOnly' : rightValue === undefined ? 'leftOnly' : 'changed';
      if (!shouldShowStatus(status, context.input.strategy)) {
        return undefined;
      }

      return propertyNode({
        element: {
          name: `@${name}`,
          attributes: {},
          children: [],
          text: rightValue ?? leftValue ?? '',
        },
        leftValue: leftValue ?? '',
        rightValue: rightValue ?? '',
        status,
        location: {
          pointer: `${parentLocation.pointer}/@${escapePointer(name)}`,
          displayPath: `${parentLocation.displayPath}/@${name}`,
          identityKey: parentLocation.identityKey,
        },
        context,
      });
    })
    .filter((node): node is CompareTreeNode => Boolean(node));
}

function propertyNode(input: {
  element: XmlElementNode;
  leftValue: string;
  rightValue: string;
  status: CompareTreeStatus;
  location: XmlCompareLocation;
  context: XmlCompareContext;
}): CompareTreeNode {
  const nodeId = `${input.context.options.nodeIdPrefix}:property:${encodeId(input.location.pointer)}`;
  const patch = xmlPatch(input);
  input.context.candidateFactories.set(nodeId, xmlCandidateFactory(input.context, nodeId, patch));

  return {
    id: nodeId,
    label: input.element.name,
    kind: 'xmlProperty',
    status: input.status,
    leftValue: input.leftValue,
    rightValue: input.rightValue,
    mergeable: true,
    destructive: input.status === 'leftOnly',
    payloadRef: `xmlPatch:${input.location.pointer}`,
    mergeState: {
      state: 'ready',
      targetFilePath: input.context.options.targetFilePath,
    },
    children: [],
  };
}

function subtreeNode(input: {
  element: XmlElementNode;
  status: 'leftOnly' | 'rightOnly';
  location: XmlCompareLocation;
  context: XmlCompareContext;
  depth: number;
}): CompareTreeNode {
  const nodeId = `${input.context.options.nodeIdPrefix}:element:${encodeId(input.location.pointer)}`;
  const patch = xmlPatch({
    element: input.element,
    rightValue: input.status === 'rightOnly' ? input.element.text ?? '' : '',
    status: input.status,
    location: input.location,
    context: input.context,
  });
  input.context.candidateFactories.set(nodeId, xmlCandidateFactory(input.context, nodeId, patch));

  return {
    id: nodeId,
    label: elementDisplayName(input.element),
    kind: elementKind(input.context, input.element, input.depth),
    status: input.status,
    mergeable: true,
    destructive: input.status === 'leftOnly',
    payloadRef: `xmlPatch:${input.location.pointer}`,
    mergeState: {
      state: 'ready',
      targetFilePath: input.context.options.targetFilePath,
    },
    children: [],
  };
}

function xmlPatch(input: {
  element: XmlElementNode;
  rightValue: string;
  status: CompareTreeStatus;
  location: XmlCompareLocation;
  context: XmlCompareContext;
}): XmlPatchPayload {
  const kind =
    input.status === 'rightOnly'
      ? 'insertNode'
      : input.status === 'leftOnly'
        ? 'deleteNode'
        : 'replaceNode';
  const replacementXml =
    kind === 'deleteNode'
      ? undefined
      : isAttributeLocation(input.location.pointer)
        ? input.rightValue
        : serializeElement(input.element, input.rightValue);
  const target = {
    filePath: targetUri(input.context.options.targetFilePath),
    pointer: input.location.pointer,
    displayPath: input.location.displayPath,
    identityKey: input.location.identityKey,
  };
  const nextSource = applyDomXmlPatch(input.context.input.snapshots.left, {
    kind,
    target,
    expectedOldHash: input.context.expectedOldHash,
    newHash: '',
    replacementXml,
  });

  return {
    kind,
    target,
    expectedOldHash: input.context.expectedOldHash,
    newHash: hashText(nextSource),
    replacementXml,
  };
}

function elementKind(context: XmlCompareContext, element: XmlElementNode, depth: number): string {
  return context.options.elementKind?.({ element, parent: undefined, depth }) ?? 'xmlElement';
}

function isAttributeLocation(pointer: string): boolean {
  return pointer.split('/').pop()?.startsWith('@') ?? false;
}

function xmlCandidateFactory(
  context: XmlCompareContext,
  nodeId: string,
  patch: XmlPatchPayload
): ExecutableCandidateFactory {
  return async () => {
    const candidate: PlannedXmlMergeCandidate = {
      kind: xmlCandidateKind(patch.kind),
      sourceId: context.sourceId,
      snapshotId: context.snapshotId,
      nodeId,
      targetUri: targetUri(context.options.targetFilePath),
      expectedOldHash: patch.expectedOldHash,
      newHash: patch.newHash,
      xmlPatch: patch,
    };
    return { ok: true, candidate };
  };
}

function xmlCandidateKind(kind: XmlPatchPayload['kind']): PlannedXmlMergeCandidate['kind'] {
  switch (kind) {
    case 'replaceNode':
      return 'xmlNodeReplace';
    case 'insertNode':
      return 'xmlNodeInsert';
    case 'deleteNode':
      return 'xmlNodeDelete';
  }
}

function branchNode(input: {
  id: string;
  label: string;
  kind: string;
  children: CompareTreeNode[];
}): CompareTreeNode {
  return {
    id: input.id,
    label: input.label,
    kind: input.kind,
    status: input.children.some((child) => child.status !== 'equal') ? 'changed' : 'equal',
    children: input.children,
  };
}

function indexChildren(children: readonly XmlElementNode[]): Map<string, XmlElementNode> {
  const counts = new Map<string, number>();
  const indexed = new Map<string, XmlElementNode>();
  children.forEach((child, index) => {
    const baseKey = `${localName(child.name)}:${identityKey(child, index)}`;
    const count = counts.get(baseKey) ?? 0;
    counts.set(baseKey, count + 1);
    indexed.set(count === 0 ? baseKey : `${baseKey}:${count}`, child);
  });
  return indexed;
}

function identityKey(element: XmlElementNode, ordinal: number): string {
  return (
    element.attributes.uuid ??
    element.attributes.UUID ??
    element.attributes.id ??
    element.attributes.ID ??
    childText(element, 'Name') ??
    element.children.find((child) => child.name === 'Properties')?.children.find((child) => child.name === 'Name')
      ?.text ??
    `${element.name}[${ordinal}]`
  );
}

function locationForRoot(left: XmlElementNode, right: XmlElementNode): XmlCompareLocation {
  const root = right ?? left;
  return {
    pointer: `/${escapePointer(localName(root.name))}[0]`,
    displayPath: root.name,
    identityKey: elementDisplayName(root),
  };
}

function childLocation(
  parentLocation: XmlCompareLocation,
  element: XmlElementNode
): XmlCompareLocation {
  const identity = selectorForElement(element);
  return {
    pointer: `${parentLocation.pointer}/${escapePointer(localName(element.name))}[${escapePointer(identity)}]`,
    displayPath: `${parentLocation.displayPath}/${element.name}[${identity}]`,
    identityKey: identity,
  };
}

function elementStatus(
  left: XmlElementNode | undefined,
  right: XmlElementNode | undefined
): CompareTreeStatus {
  if (!left) {
    return 'rightOnly';
  }
  if (!right) {
    return 'leftOnly';
  }
  return 'changed';
}

function shouldShowStatus(status: CompareTreeStatus, strategy: AdapterCompareInput['strategy']): boolean {
  if (status === 'equal') {
    return false;
  }
  if (status === 'changed') {
    return true;
  }
  if (strategy === 'full') {
    return status === 'rightOnly' || status === 'leftOnly';
  }
  return strategy === 'left' ? status === 'leftOnly' : status === 'rightOnly';
}

function isPropertyLeaf(
  left: XmlElementNode | undefined,
  right: XmlElementNode | undefined
): boolean {
  const leftIsLeaf = !left || left.children.length === 0;
  const rightIsLeaf = !right || right.children.length === 0;
  if (!leftIsLeaf || !rightIsLeaf) {
    return false;
  }

  return (left?.text ?? '') !== (right?.text ?? '');
}

function convertElement(name: string, value: unknown): XmlElementNode[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => convertElement(name, item));
  }
  if (!isRecord(value)) {
    return [
      {
        name,
        attributes: {},
        children: [],
        text: normalizeText(value),
      },
    ];
  }

  const attributes: Record<string, string> = {};
  const children: XmlElementNode[] = [];
  let text: string | undefined;
  for (const [key, childValue] of Object.entries(value)) {
    if (key.startsWith(ATTRIBUTE_PREFIX)) {
      attributes[key.slice(ATTRIBUTE_PREFIX.length)] = normalizeText(childValue);
    } else if (key === TEXT_NODE) {
      text = normalizeText(childValue);
    } else {
      children.push(...convertElement(key, childValue));
    }
  }

  return [
    {
      name,
      attributes,
      children,
      text: children.length === 0 ? text : undefined,
    },
  ];
}

function serializeElement(element: XmlElementNode, value: string): string {
  const attributes = Object.entries(element.attributes)
    .map(([name, attributeValue]) => ` ${name}="${escapeXml(attributeValue)}"`)
    .join('');
  if (element.children.length === 0) {
    return `<${element.name}${attributes}>${escapeXml(value)}</${element.name}>`;
  }
  return `<${element.name}${attributes}>${element.children.map((child) => serializeElement(child, child.text ?? '')).join('')}</${element.name}>`;
}

function targetDescriptorPath(
  left: MetadataObjectUnit | undefined,
  right: MetadataObjectUnit | undefined
): string {
  return left?.descriptorPath ?? right?.descriptorPath ?? 'unknown.xml';
}

function rightSourceId(input: AdapterCompareInput): string {
  return input.session.state.sources.find((source) => source.side === 'right')?.sourceId ?? RIGHT_SOURCE_ID;
}

function rightSnapshotId(input: AdapterCompareInput): string {
  const rightSource = input.session.state.sources.find((source) => source.side === 'right');
  return rightSource?.snapshotId ?? input.session.state.snapshots.find((snapshot) => snapshot.readOnly)?.snapshotId ?? 'snapshot-right';
}

function targetUri(filePath: string): string {
  return path.isAbsolute(filePath) ? pathToFileURL(filePath).toString() : filePath;
}

function hashText(value: string): string {
  return createHash('sha256').update(value.replace(/\r\n/g, '\n').replace(/\r/g, '\n')).digest('hex');
}

function selectorForElement(element: XmlElementNode): string {
  const uuid = element.attributes.uuid ?? element.attributes.UUID;
  if (uuid) {
    return `uuid=${uuid}`;
  }
  const id = element.attributes.id ?? element.attributes.ID;
  if (id) {
    return `id=${id}`;
  }
  const attributeName = element.attributes.Name;
  if (attributeName) {
    return `Name=${attributeName}`;
  }
  const directName = childText(element, 'Name');
  if (directName) {
    return `Name=${directName}`;
  }
  const propertiesName = element.children
    .find((child) => localName(child.name) === 'Properties')
    ?.children.find((child) => localName(child.name) === 'Name')?.text;
  if (propertiesName) {
    return `Properties.Name=${propertiesName}`;
  }

  return '0';
}

function normalizeText(value: unknown): string {
  return String(value ?? '').trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function encodeId(value: string): string {
  return encodeURIComponent(value);
}

function escapePointer(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function localName(name: string): string {
  return name.includes(':') ? name.split(':').pop() ?? name : name;
}
