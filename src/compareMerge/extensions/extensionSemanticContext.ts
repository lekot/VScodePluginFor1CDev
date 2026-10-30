import { createHash } from 'crypto';
import * as path from 'path';

import type { AdapterCompareInput } from '../adapters/mergeAdapter';
import { elementChildren, parseXmlDocument, textContent } from '../xml/xmlDom';
import { namespaceUriForName } from '../adapters/semanticXml/semanticXmlIdentity';
import { captureMergePath } from '../merge/mergeSnapshot';
import type { ExtensionIndexedObject, ExtensionMetadataIndex } from './extensionMetadataIndex';
import type { ExtensionSemanticSelection, ExtensionTransferRow } from './extensionTransfer';

const MDCLASSES_NAMESPACE = 'http://v8.1c.ru/8.3/MDClasses';

export interface ExtensionSemanticReferenceContext {
  readonly validationContext: AdapterCompareInput['semanticValidationContext'];
  readonly referenceWitnesses: NonNullable<AdapterCompareInput['semanticMetadataReferenceWitnesses']>;
  readonly contextWitnesses: NonNullable<AdapterCompareInput['semanticContextWitnesses']>;
}

interface DescriptorVersionCapture {
  readonly version: string;
  readonly metadataType: string;
  readonly name: string;
  readonly uuid: string;
  readonly witness: NonNullable<AdapterCompareInput['semanticContextWitnesses']>[number];
}

/** Captures only target-accessible references and the exact owner descriptors used to validate a DCS. */
export async function buildExtensionSemanticReferenceContext(input: {
  readonly row: ExtensionTransferRow;
  readonly kind: ExtensionSemanticSelection['kind'];
  readonly targetRelativePath: string;
  readonly sourceRelativePath: string;
}): Promise<ExtensionSemanticReferenceContext> {
  const { row, kind } = input;
  const target = row.targetRoot;
  const provenBase = row.semanticAction === 'overlay-adopted'
    ? row.targetBase
    : row.sameProvenBase === true ? row.targetBase : undefined;
  const indexes = [target, provenBase]
    .filter((index): index is ExtensionMetadataIndex => Boolean(index))
    .filter((index, position, all) => all.findIndex((candidate) => candidate.sourceId === index.sourceId) === position);
  const references = new Map<string, string>();
  const referenceWitnesses: Array<NonNullable<AdapterCompareInput['semanticMetadataReferenceWitnesses']>[number]> = [];
  const witnessed = new Set<string>();
  for (const index of indexes) {
    for (const object of index.objects) {
      if (!object.descriptorRelativePath || !object.descriptorHash) {continue;}
      const key = object.qualifiedName.normalize('NFC').toLowerCase();
      if (!references.has(key)) {references.set(key, object.qualifiedName);}
      const witnessKey = `${index.sourceId}\u0000${object.descriptorRelativePath}`;
      if (witnessed.has(witnessKey)) {continue;}
      witnessed.add(witnessKey);
      referenceWitnesses.push({
        qualifiedName: object.qualifiedName,
        witness: {
          sourceId: index.sourceId,
          relativePath: object.descriptorRelativePath,
          expectedHash: normalizeHash(object.descriptorHash),
          kind: 'file',
        },
      });
    }
  }

  const contextWitnesses: Array<NonNullable<AdapterCompareInput['semanticContextWitnesses']>[number]> = provenBase?.configurationHash
    ? [{ sourceId: provenBase.sourceId, relativePath: 'Configuration.xml', expectedHash: normalizeHash(provenBase.configurationHash), kind: 'file' }]
    : [];
  if (target.configurationHash) {
    contextWitnesses.push({ sourceId: target.sourceId, relativePath: 'Configuration.xml', expectedHash: normalizeHash(target.configurationHash), kind: 'file' });
  }
  if (row.semanticAction && row.incomingRoot.configurationHash) {
    contextWitnesses.push({ sourceId: row.incomingRoot.sourceId, relativePath: 'Configuration.xml', expectedHash: normalizeHash(row.incomingRoot.configurationHash), kind: 'file' });
  }

  let ownerDescriptorVersions: { target: string; incoming: string } | undefined;
  if (kind === 'dcsXml') {
    const [targetDescriptor, incomingDescriptor] = await Promise.all([
      captureDcsOwnerDescriptor(row.targetRoot, row.target, input.targetRelativePath),
      captureDcsOwnerDescriptor(row.incomingRoot, row.incoming, input.sourceRelativePath),
    ]);
    if (targetDescriptor && incomingDescriptor && sameDescriptorIdentity(targetDescriptor, incomingDescriptor)) {
      ownerDescriptorVersions = { target: targetDescriptor.version, incoming: incomingDescriptor.version };
      contextWitnesses.push(targetDescriptor.witness, incomingDescriptor.witness);
    }
  }

  return {
    validationContext: target.hasConfigurationXml && target.configurationHash
      ? {
        availableMetadataReferences: [...references.values()],
        ...(target.configurationName ? { configurationName: target.configurationName } : {}),
        ...(ownerDescriptorVersions ? { ownerDescriptorVersions } : {}),
      }
      : undefined,
    referenceWitnesses,
    contextWitnesses,
  };
}

async function captureDcsOwnerDescriptor(
  root: ExtensionMetadataIndex,
  object: ExtensionIndexedObject | undefined,
  dcsRelativePath: string,
): Promise<DescriptorVersionCapture | undefined> {
  if (!object) {return undefined;}
  const relative = ownerRelativePath(object, dcsRelativePath);
  if (relative === 'Ext/Template.xml') {
    return captureIndexedRootDescriptor(object);
  }

  const nested = nestedTemplateDescriptor(relative);
  if (!nested || !object.descriptorContent || !object.descriptorRelativePath) {return undefined;}
  if (!hasNestedRegistration(object, nested.metadataType, nested.name)) {return undefined;}
  const descriptorRelativePath = normalizeRelativePath(path.posix.join(
    normalizeRelativePath(object.sidecarRelativePath ?? ''),
    nested.descriptorRelativePath,
  ));
  const indexed = object.sidecarFiles.filter((file) => normalizeRelativePath(file.relativePath) === descriptorRelativePath);
  if (indexed.length !== 1 || !isSha256(indexed[0]!.hash)) {return undefined;}
  const sourceRoot = path.resolve(root.canonicalRootPath ?? root.rootPath);
  const absoluteDescriptorPath = path.resolve(sourceRoot, descriptorRelativePath);
  const relativeToRoot = path.relative(sourceRoot, absoluteDescriptorPath);
  if (!relativeToRoot || relativeToRoot === '..' || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) {return undefined;}
  const captured = await captureMergePath(absoluteDescriptorPath, { retainContent: true });
  if (captured.state !== 'file' || captured.contentBase64 === undefined
    || normalizeHash(captured.hash) !== normalizeHash(indexed[0]!.hash)) {return undefined;}
  const content = Buffer.from(captured.contentBase64, 'base64');
  const contentHash = createHash('sha256').update(content).digest('hex');
  if (contentHash !== normalizeHash(indexed[0]!.hash)) {return undefined;}
  return descriptorVersionCapture(content, {
    sourceId: object.sourceId,
    relativePath: descriptorRelativePath,
    expectedHash: contentHash,
    kind: 'file',
  }, nested.metadataType, nested.name);
}

function captureIndexedRootDescriptor(object: ExtensionIndexedObject): DescriptorVersionCapture | undefined {
  if (!object.descriptorContent || !object.descriptorHash || !object.descriptorRelativePath) {return undefined;}
  const expectedHash = createHash('sha256').update(object.descriptorContent).digest('hex');
  if (expectedHash !== normalizeHash(object.descriptorHash)) {return undefined;}
  return descriptorVersionCapture(object.descriptorContent, {
    sourceId: object.sourceId,
    relativePath: object.descriptorRelativePath,
    expectedHash,
    kind: 'file',
  }, object.descriptorRootTag ?? object.metadataType, object.name, object.identity?.uuid);
}

function descriptorVersionCapture(
  bytes: Buffer,
  witness: NonNullable<AdapterCompareInput['semanticContextWitnesses']>[number],
  expectedType: string,
  expectedName: string,
  expectedUuid?: string,
): DescriptorVersionCapture | undefined {
  try {
    const root = parseXmlDocument(bytes.toString('utf8')).root;
    const metadata = root.localName === 'MetaDataObject' ? elementChildren(root) : [];
    if (namespaceUriForName(root) !== MDCLASSES_NAMESPACE || metadata.length !== 1
      || metadata[0]!.localName !== expectedType || namespaceUriForName(metadata[0]!) !== MDCLASSES_NAMESPACE) {return undefined;}
    const properties = directMetadata(metadata[0]!, 'Properties');
    const names = properties.length === 1 ? directMetadata(properties[0]!, 'Name') : [];
    if (names.length !== 1 || textContent(names[0]!).trim().normalize('NFC') !== expectedName.normalize('NFC')) {return undefined;}
    const uuid = metadata[0]!.attributes.filter((attribute) => attribute.name === 'uuid');
    if (uuid.length !== 1 || !isUuid(uuid[0]!.value)
      || expectedUuid && uuid[0]!.value.toLowerCase() !== expectedUuid.toLowerCase()) {return undefined;}
    const versions = root.attributes.filter((attribute) => attribute.name === 'version');
    if (versions.length !== 1 || !versions[0]!.value.trim()) {return undefined;}
    return {
      version: versions[0]!.value.trim(),
      metadataType: expectedType,
      name: expectedName,
      uuid: uuid[0]!.value.toLowerCase(),
      witness,
    };
  } catch {
    return undefined;
  }
}

function hasNestedRegistration(object: ExtensionIndexedObject, metadataType: string, name: string): boolean {
  try {
    const root = parseXmlDocument(object.descriptorContent!.toString('utf8')).root;
    const metadata = root.localName === 'MetaDataObject' ? elementChildren(root) : [];
    const expectedType = object.descriptorRootTag ?? object.metadataType;
    if (namespaceUriForName(root) !== MDCLASSES_NAMESPACE || metadata.length !== 1
      || metadata[0]!.localName !== expectedType || namespaceUriForName(metadata[0]!) !== MDCLASSES_NAMESPACE) {return false;}
    const childObjects = directMetadata(metadata[0]!, 'ChildObjects');
    if (childObjects.length !== 1) {return false;}
    return elementChildren(childObjects[0]!).filter((child) =>
      child.localName === metadataType && namespaceUriForName(child) === MDCLASSES_NAMESPACE
        && textContent(child).trim().normalize('NFC') === name.normalize('NFC'),
    ).length === 1;
  } catch {
    return false;
  }
}

function nestedTemplateDescriptor(relativeDcsPath: string): {
  readonly metadataType: 'Template' | 'CommonTemplate';
  readonly name: string;
  readonly descriptorRelativePath: string;
} | undefined {
  const segments = relativeDcsPath.split('/');
  if (segments.length !== 4 || segments[2] !== 'Ext' || segments[3] !== 'Template.xml') {return undefined;}
  const collection = segments[0];
  const name = segments[1];
  if (!name || (collection !== 'Templates' && collection !== 'CommonTemplates')) {return undefined;}
  return {
    metadataType: collection === 'Templates' ? 'Template' : 'CommonTemplate',
    name,
    descriptorRelativePath: `${collection}/${name}.xml`,
  };
}

function directMetadata(parent: import('../xml/xmlDom').XmlElement, localName: string) {
  return elementChildren(parent).filter((child) => child.localName === localName && namespaceUriForName(child) === MDCLASSES_NAMESPACE);
}

function sameDescriptorIdentity(left: DescriptorVersionCapture, right: DescriptorVersionCapture): boolean {
  return left.metadataType === right.metadataType
    && left.name.normalize('NFC').toLowerCase() === right.name.normalize('NFC').toLowerCase()
    && left.uuid === right.uuid;
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/gu, '/').replace(/^\.\//u, '').replace(/\/+$/u, '');
}

function ownerRelativePath(object: ExtensionIndexedObject, value: string): string {
  const candidate = normalizeRelativePath(value);
  const prefix = normalizeRelativePath(object.sidecarRelativePath ?? '');
  const normalizeCase = (item: string) => process.platform === 'win32' ? item.toLocaleLowerCase('en-US') : item;
  return prefix && normalizeCase(candidate).startsWith(`${normalizeCase(prefix)}/`)
    ? candidate.slice(prefix.length + 1)
    : candidate;
}

function normalizeHash(value: string): string {
  return value.replace(/^sha256:/iu, '').toLowerCase();
}

function isSha256(value: string): boolean {
  return /^[\da-f]{64}$/iu.test(normalizeHash(value));
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
    && value.toLowerCase() !== '00000000-0000-0000-0000-000000000000';
}
