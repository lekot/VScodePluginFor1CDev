import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

import type { MergeFileWitness } from '../merge/mergePreview';
import { elementChildren, parseXmlDocument, textContent } from '../xml/xmlDom';
import { namespaceUriForName } from './semanticXml/semanticXmlIdentity';
import type { AdapterCompareInput, ConfigurationInventory } from './mergeAdapter';

const MDCLASSES_NAMESPACE = 'http://v8.1c.ru/8.3/MDClasses';

export interface MetadataReferenceContextInput {
  inventory: ConfigurationInventory;
  sourceId: string;
  readTextFile?: (filePath: string) => Promise<string>;
}

export interface MetadataReferenceContext {
  availableMetadataReferences?: readonly string[];
  configurationName?: string;
  ownerDescriptorVersions?: { target: string; incoming: string };
  witnesses: readonly MergeFileWitness[];
}

export function attachMetadataReferenceContext(
  input: AdapterCompareInput,
  context: MetadataReferenceContext
): void {
  input.semanticValidationContext = context.availableMetadataReferences === undefined && !context.configurationName && !context.ownerDescriptorVersions
    ? undefined
    : {
        ...(context.availableMetadataReferences === undefined ? {} : { availableMetadataReferences: context.availableMetadataReferences }),
        ...(context.configurationName ? { configurationName: context.configurationName } : {}),
        ...(context.ownerDescriptorVersions ? { ownerDescriptorVersions: { ...context.ownerDescriptorVersions } } : {}),
      };
  input.semanticContextWitnesses = context.witnesses;
}

/** Captures root registrations once and only advertises references backed by indexed descriptors. */
export async function buildMetadataReferenceContext(
  input: MetadataReferenceContextInput
): Promise<MetadataReferenceContext> {
  const configurationPath = path.join(input.inventory.rootPath, 'Configuration.xml');
  let source: string;
  try {
    source = await (input.readTextFile ?? ((filePath) => fs.readFile(filePath, 'utf8')))(configurationPath);
  } catch {
    return { witnesses: [] };
  }

  let snapshot: RootConfigurationSnapshot;
  try {
    snapshot = readRootRegistrations(source);
  } catch {
    return { witnesses: [] };
  }

  const indexedObjects = new Map<string, { qualifiedName: string; hasDescriptorWitness: boolean }[]>();
  for (const object of input.inventory.objects) {
    const artifacts = input.inventory.artifactsByObjectId.get(object.objectId) ?? [];
    const descriptor = artifacts.find((artifact) => artifact.kind === 'metadataXml' && samePath(artifact.filePath, object.descriptorPath));
    if (!descriptor || !isSha256(descriptor.contentHash)) {
      continue;
    }
    const key = normalizedName(object.qualifiedName);
    indexedObjects.set(key, [...(indexedObjects.get(key) ?? []), { qualifiedName: object.qualifiedName, hasDescriptorWitness: true }]);
  }

  const availableMetadataReferences = [...new Set(snapshot.registrations.flatMap((qualifiedName) => {
    const indexed = indexedObjects.get(normalizedName(qualifiedName));
    return indexed?.length === 1 && indexed[0].hasDescriptorWitness ? [indexed[0].qualifiedName] : [];
  }))].sort((left, right) => left.localeCompare(right));

  return {
    ...(snapshot.configurationName ? { configurationName: snapshot.configurationName } : {}),
    availableMetadataReferences,
    witnesses: [{
      sourceId: input.sourceId,
      relativePath: 'Configuration.xml',
      expectedHash: createHash('sha256').update(Buffer.from(source, 'utf8')).digest('hex'),
      kind: 'file',
    }],
  };
}

interface RootConfigurationSnapshot {
  configurationName?: string;
  registrations: string[];
}

function readRootRegistrations(source: string): RootConfigurationSnapshot {
  const document = parseXmlDocument(source);
  if (document.root.localName !== 'MetaDataObject' || namespaceUriForName(document.root) !== MDCLASSES_NAMESPACE) {
    throw new Error('Unsupported root');
  }
  const configurations = directMetadataChildren(document.root, 'Configuration');
  if (configurations.length !== 1) {
    throw new Error('Missing or ambiguous Configuration');
  }
  const properties = directMetadataChildren(configurations[0]!, 'Properties');
  const names = properties.length === 1
    ? directMetadataChildren(properties[0]!, 'Name')
    : [];
  const configurationName = properties.length === 1 && names.length === 1
    ? textContent(names[0]!).trim() || undefined
    : undefined;
  const childObjects = directMetadataChildren(configurations[0]!, 'ChildObjects');
  if (childObjects.length > 1) {
    throw new Error('Ambiguous ChildObjects');
  }
  if (childObjects.length === 0) {
    return { ...(configurationName ? { configurationName } : {}), registrations: [] };
  }
  const registrations: string[] = [];
  for (const child of elementChildren(childObjects[0]!)) {
    if (namespaceUriForName(child) !== MDCLASSES_NAMESPACE) {continue;}
    const name = textContent(child).trim();
    if (!name) {
      continue;
    }
    registrations.push(`${child.localName}.${name}`);
  }
  return { ...(configurationName ? { configurationName } : {}), registrations };
}

function directMetadataChildren(parent: import('../xml/xmlDom').XmlElement, name: string): import('../xml/xmlDom').XmlElement[] {
  return elementChildren(parent).filter((element) =>
    element.localName === name && namespaceUriForName(element) === MDCLASSES_NAMESPACE);
}

function normalizedName(value: string): string {
  return value.trim().normalize('NFC').toLowerCase();
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return (process.platform === 'win32' ? normalizedLeft.toLowerCase() : normalizedLeft) ===
    (process.platform === 'win32' ? normalizedRight.toLowerCase() : normalizedRight);
}

function isSha256(value: string): boolean {
  return /^sha256:[\da-f]{64}$/iu.test(value) || /^[\da-f]{64}$/iu.test(value);
}
