import { createHash } from 'crypto';

import { getExplicitGeneratedTypeSpecs } from '../../utils/xml/metadataGeneratedTypeSchema';
import type { MergeFileWitness } from '../merge/mergePreview';
import { elementChildren, parseXmlDocument, textContent, type XmlElement } from '../xml/xmlDom';
import type { AdoptedDesignerIdentity } from './adoptedDesignerProjection';

const MDCLASSES_NAMESPACE = 'http://v8.1c.ru/8.3/MDClasses';
const READABLE_NAMESPACE = 'http://v8.1c.ru/8.3/xcf/readable';
const UUID_PATTERN = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu;

export interface AdoptedDesignerTypeIdReferenceDescriptor {
  readonly descriptorXml: Buffer;
  readonly identity: AdoptedDesignerIdentity;
  /** The capture host proves whether this descriptor belongs to an own package or its exact base. */
  readonly provenance: 'own' | 'proven-base';
  readonly sourceId: string;
  readonly relativePath: string;
  readonly expectedHash: string;
}

export interface AdoptedDesignerTypeIdResolution {
  readonly qualifiedName?: string;
  readonly reason?: string;
}

export interface AdoptedDesignerTypeIdResolver {
  resolve(typeId: string): AdoptedDesignerTypeIdResolution;
  usedDescriptorWitnesses(): readonly MergeFileWitness[];
}

interface Candidate {
  readonly input: AdoptedDesignerTypeIdReferenceDescriptor;
  readonly root: XmlElement;
  readonly generatedType: XmlElement;
  readonly typeId: string;
  readonly ownerName?: string;
  readonly profileName?: string;
}

/** Resolves only TypeIds actually selected for flattening; unused context is not a transfer dependency. */
export function createAdoptedDesignerTypeIdResolver(
  formatVersion: string,
  descriptors: readonly AdoptedDesignerTypeIdReferenceDescriptor[] = [],
): AdoptedDesignerTypeIdResolver {
  const byTypeId = new Map<string, Candidate[]>();
  for (const input of descriptors) {
    for (const candidate of candidatesFrom(input)) {
      const key = candidate.typeId.toLowerCase();
      const current = byTypeId.get(key) ?? [];
      current.push(candidate);
      byTypeId.set(key, current);
    }
  }
  const used = new Map<string, MergeFileWitness>();
  return {
    resolve(typeId): AdoptedDesignerTypeIdResolution {
      const normalized = typeId.trim();
      if (!UUID_PATTERN.test(normalized)) { return { reason: `TypeId=${normalized || '(empty)'} имеет неверный формат: ожидался UUID.` }; }
      const matches = byTypeId.get(normalized.toLowerCase()) ?? [];
      if (matches.length === 0) { return { reason: `Для TypeId=${normalized} не найден захваченный GeneratedType собственного объекта или доказанной базовой конфигурации.` }; }
      if (matches.length !== 1) { return { reason: `TypeId=${normalized} неоднозначен: UUID используется в нескольких захваченных GeneratedType.` }; }
      const candidate = matches[0]!;
      const validation = validateCandidate(candidate, normalized, formatVersion);
      if (validation.reason) { return { reason: validation.reason }; }
      const witness: MergeFileWitness = {
        sourceId: candidate.input.sourceId,
        relativePath: candidate.input.relativePath,
        expectedHash: normalizeHash(candidate.input.expectedHash),
        kind: 'file',
      };
      used.set(`${witness.sourceId}\0${witness.relativePath}\0${witness.expectedHash}`, witness);
      return { qualifiedName: `cfg:${candidate.profileName}` };
    },
    usedDescriptorWitnesses(): readonly MergeFileWitness[] { return [...used.values()]; },
  };
}

function candidatesFrom(input: AdoptedDesignerTypeIdReferenceDescriptor): Candidate[] {
  let root: XmlElement;
  try {
    const document = parseXmlDocument(input.descriptorXml.toString('utf8'));
    const metadataRoot = document.root;
    if (expandedName(metadataRoot) !== `{${MDCLASSES_NAMESPACE}}MetaDataObject`) { return []; }
    const objects = elementChildren(metadataRoot).filter((element) => namespaceUri(element) === MDCLASSES_NAMESPACE);
    if (objects.length !== 1) { return []; }
    root = objects[0]!;
  } catch {
    return [];
  }

  const ownerName = uniqueDirectText(root, 'Properties', MDCLASSES_NAMESPACE, 'Name');
  const internalInfo = directIn(root, 'InternalInfo', MDCLASSES_NAMESPACE);
  const generatedTypes = internalInfo.length === 1
    ? elementChildren(internalInfo[0]!).filter((element) => element.localName === 'GeneratedType' && namespaceUri(element) === READABLE_NAMESPACE)
    : [];
  const candidates: Candidate[] = [];
  for (const generatedType of generatedTypes) {
    const typeIds = directIn(generatedType, 'TypeId', READABLE_NAMESPACE);
    for (const typeIdNode of typeIds) {
      const typeId = textContent(typeIdNode).trim();
      if (UUID_PATTERN.test(typeId)) {
        candidates.push({
          input,
          root,
          generatedType,
          typeId,
          ownerName,
          profileName: profileNameFor(root.localName, ownerName, generatedType),
        });
      }
    }
  }
  return candidates;
}

function validateCandidate(candidate: Candidate, requestedTypeId: string, formatVersion: string): { reason?: string } {
  const { input, root, generatedType } = candidate;
  if (input.provenance !== 'own' && input.provenance !== 'proven-base') {
    return { reason: `Для TypeId=${requestedTypeId} descriptor не подтверждён как собственный объект или объект доказанной базовой конфигурации.` };
  }
  if (input.identity.ownership !== 'own' || input.identity.type !== root.localName
    || !UUID_PATTERN.test(input.identity.uuid) || normalizeUuid(attribute(root, 'uuid') ?? '') !== normalizeUuid(input.identity.uuid)
    || !candidate.ownerName || candidate.ownerName !== input.identity.name) {
    return { reason: `Корень descriptor для TypeId=${requestedTypeId} не совпадает с захваченной identity собственного объекта.` };
  }
  if (!candidate.profileName) {
    return { reason: `Имя/category GeneratedType для TypeId=${requestedTypeId} не соответствует явному профилю ${root.localName}.${candidate.ownerName ?? '(неизвестно)'}.` };
  }
  if (!safeRelativePath(input.relativePath) || !input.sourceId.trim()) {
    return { reason: `Witness для TypeId=${requestedTypeId} требует безопасный относительный путь и sourceId.` };
  }
  if (!/^(?:sha256:)?[\da-f]{64}$/iu.test(input.expectedHash)) {
    return { reason: `Witness descriptor для TypeId=${requestedTypeId} должен содержать SHA-256.` };
  }
  const expected = normalizeHash(input.expectedHash);
  const actual = createHash('sha256').update(input.descriptorXml).digest('hex');
  if (expected !== actual) { return { reason: `SHA-256 захваченного descriptor для TypeId=${requestedTypeId} не совпадает с witness.` }; }
  const metadataObject = root.parent;
  const properties = directIn(root, 'Properties', MDCLASSES_NAMESPACE);
  const ownershipMarkers = properties.length === 1 ? sameLocalDirect(properties[0]!, 'ObjectBelonging') : [];
  const baseAnchors = properties.length === 1 ? sameLocalDirect(properties[0]!, 'ExtendedConfigurationObject') : [];
  const belongingValues = ownershipMarkers.filter((element) => namespaceUri(element) === MDCLASSES_NAMESPACE);
  const hasValidOwnMarker = ownershipMarkers.length === 0
    || (ownershipMarkers.length === 1 && belongingValues.length === 1 && textContent(belongingValues[0]!).trim() === 'Own');
  if (!metadataObject || expandedName(metadataObject) !== `{${MDCLASSES_NAMESPACE}}MetaDataObject`
    || attribute(metadataObject, 'version') !== formatVersion || properties.length !== 1
    || !hasValidOwnMarker || baseAnchors.length > 0) {
    return { reason: `Descriptor для TypeId=${requestedTypeId} не является корректным захваченным собственным объектом Designer.` };
  }
  if (directIn(root, 'InternalInfo', MDCLASSES_NAMESPACE).length !== 1
    || namespaceUri(generatedType) !== READABLE_NAMESPACE
    || directIn(generatedType, 'TypeId', READABLE_NAMESPACE).length !== 1
    || textContent(directIn(generatedType, 'TypeId', READABLE_NAMESPACE)[0]!).trim().toLowerCase() !== requestedTypeId.toLowerCase()) {
    return { reason: `GeneratedType witness для TypeId=${requestedTypeId} повреждён или использует подменённый namespace.` };
  }
  return {};
}

function profileNameFor(rootType: string, ownerName: string | undefined, generatedType: XmlElement): string | undefined {
  if (!ownerName) { return undefined; }
  const name = attribute(generatedType, 'name');
  const category = attribute(generatedType, 'category');
  return (getExplicitGeneratedTypeSpecs(rootType) ?? []).some((profile) =>
    profile.category === category && `${profile.namePrefix}.${ownerName}` === name,
  ) ? name : undefined;
}

function uniqueDirectText(parent: XmlElement, containerName: string, namespace: string, fieldName: string): string | undefined {
  const containers = directIn(parent, containerName, namespace);
  if (containers.length !== 1) { return undefined; }
  const fields = directIn(containers[0]!, fieldName, namespace);
  return fields.length === 1 ? textContent(fields[0]!).trim() : undefined;
}

function directIn(parent: XmlElement, name: string, namespace: string): XmlElement[] {
  return elementChildren(parent).filter((element) => element.localName === name && namespaceUri(element) === namespace);
}

function sameLocalDirect(parent: XmlElement, name: string): XmlElement[] {
  return elementChildren(parent).filter((element) => element.localName === name);
}

function namespaceUri(element: XmlElement): string | undefined {
  const colon = element.name.indexOf(':');
  const prefix = colon < 0 ? '' : element.name.slice(0, colon);
  const declarationName = prefix ? `xmlns:${prefix}` : 'xmlns';
  let current: XmlElement | undefined = element;
  while (current) {
    const declaration = current.attributes.find((item) => item.name === declarationName);
    if (declaration) { return declaration.value || undefined; }
    current = current.parent;
  }
  return undefined;
}

function expandedName(element: XmlElement): string {
  const namespace = namespaceUri(element);
  return namespace ? `{${namespace}}${element.localName}` : element.localName;
}

function attribute(element: XmlElement, name: string): string | undefined {
  return element.attributes.find((item) => item.name === name)?.value;
}

function normalizeUuid(value: string): string { return value.toLowerCase(); }

function normalizeHash(value: string): string { return value.replace(/^sha256:/iu, '').toLowerCase(); }

function safeRelativePath(value: string): boolean {
  return Boolean(value) && value.trim() === value && !value.includes('\\') && !value.includes('\0') && !value.includes(':')
    && !value.startsWith('/') && !/^[a-z]:/iu.test(value)
    && value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..' && segment.toLowerCase() !== '.cdt-journal');
}
