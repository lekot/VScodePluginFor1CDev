import { createHash } from 'crypto';

import type { MergeFileWitness } from '../merge/mergePreview';
import { elementChildren, parseXmlDocument, textContent, type XmlElement } from '../xml/xmlDom';

const MDCLASSES_NAMESPACE = 'http://v8.1c.ru/8.3/MDClasses';
const UUID_PATTERN = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu;
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

export interface AdoptedUuidRegistryFileCapture {
  readonly sourceId: string;
  readonly relativePath: string;
  readonly expectedHash: string;
  readonly content?: Buffer;
  readonly captureError?: string;
  readonly kind: 'configuration' | 'metadata-descriptor';
  readonly expectedType?: string;
  readonly expectedName?: string;
  readonly expectedUuid?: string;
}

export interface AdoptedUuidRegistryDefinition {
  readonly uuid: string;
  readonly sourceId: string;
  readonly relativePath: string;
  readonly metadataType: string;
  readonly name?: string;
  /** UUID of the metadata descriptor root that owns this definition. */
  readonly ownerRootUuid: string;
  /** Exact metadata ancestry selectors from the descriptor root to this definition. */
  readonly structuralPath: readonly string[];
  readonly ownerKey: string;
  readonly identityKey: string;
  readonly kind: 'configuration' | 'root' | 'child';
}

export interface AdoptedUuidRegistrySide {
  readonly complete: boolean;
  readonly reasons: readonly string[];
  readonly definitionsByUuid: ReadonlyMap<string, readonly AdoptedUuidRegistryDefinition[]>;
  readonly witnesses: readonly MergeFileWitness[];
}

export interface AdoptedDesignerGlobalUuidRegistry {
  readonly target: AdoptedUuidRegistrySide;
  readonly source: AdoptedUuidRegistrySide;
}

export interface NewMetadataChildUuid {
  readonly uuid: string;
  readonly metadataType: string;
  readonly name?: string;
  readonly ownerRootUuid: string;
  readonly identityKey: string;
  /** Address identity selectors from the descriptor root through this child. */
  readonly structuralPath: readonly string[];
  /** Address selectors after replacing validated adopted ancestors with their base anchors. */
  readonly logicalStructuralPath: readonly string[];
  /** False when an adopted ancestor did not resolve uniquely in the proven base descriptor. */
  readonly logicalPathComplete: boolean;
}

export interface RegisteredNestedMetadataDescriptor {
  readonly metadataType: 'Form' | 'Template' | 'Command';
  readonly name: string;
  readonly relativePath: string;
}

/** Builds a compare-global UUID index from already captured bytes and expected raw hashes. */
export function buildAdoptedDesignerGlobalUuidRegistry(input: {
  readonly target: readonly AdoptedUuidRegistryFileCapture[];
  readonly source: readonly AdoptedUuidRegistryFileCapture[];
}): AdoptedDesignerGlobalUuidRegistry {
  return {
    target: buildSide(input.target),
    source: buildSide(input.source),
  };
}

/** Returns own metadata children present in source but absent from the proven base descriptor. */
export function collectNewOwnMetadataChildUuids(input: {
  readonly sourceXml: Buffer;
  readonly baseXml: Buffer;
}):
  | { readonly ok: true; readonly children: readonly NewMetadataChildUuid[]; readonly sourceRootBelonging?: string; readonly sourceRootAnchor?: string }
  | { readonly ok: false; readonly reason: string } {
  try {
    const base = readMetadataDescriptor(input.baseXml);
    if (!base.ok) { return base; }
    const source = readMetadataDescriptor(input.sourceXml, undefined, base.rootObject);
    if (!source.ok) { return source; }
    const baseIdentityKeys = new Set(base.children.map(childIdentityKey));
    return {
      ok: true,
      ...(source.rootBelonging ? { sourceRootBelonging: source.rootBelonging } : {}),
      ...(source.rootAnchor ? { sourceRootAnchor: source.rootAnchor } : {}),
      children: source.children.filter((child) => child.isOwn && !baseIdentityKeys.has(childIdentityKey(child))).map((child) => ({
        uuid: child.uuid,
        metadataType: child.metadataType,
        ...(child.name ? { name: child.name } : {}),
        ownerRootUuid: child.ownerRootUuid,
        identityKey: `uuid=${child.uuid}`,
        structuralPath: child.structuralPath,
        logicalStructuralPath: child.logicalStructuralPath,
        logicalPathComplete: child.logicalPathComplete,
      })),
    };
  } catch (error) {
    return { ok: false, reason: `Не удалось определить новые UUID метаданных: ${errorMessage(error)}` };
  }
}

/** Resolves only descriptor files named by direct MDClasses Form/Template/Command registrations. */
export function registeredNestedMetadataDescriptors(input: {
  readonly descriptorXml: Buffer;
  readonly sidecarRelativePath: string;
}): { readonly ok: true; readonly descriptors: readonly RegisteredNestedMetadataDescriptor[] } | { readonly ok: false; readonly reason: string } {
  try {
    const root = parseXmlDocument(input.descriptorXml.toString('utf8')).root;
    if (expandedName(root) !== `{${MDCLASSES_NAMESPACE}}MetaDataObject`) {
      return { ok: false, reason: 'Корень owner descriptor не является MDClasses/MetaDataObject.' };
    }
    const objects = elementChildren(root).filter((element) => namespaceOf(element) === MDCLASSES_NAMESPACE);
    if (objects.length !== 1) { return { ok: false, reason: 'Owner descriptor не содержит единственный MDClasses root object.' }; }
    const registrations = directChildren(objects[0]!, 'ChildObjects');
    if (registrations.length > 1) { return { ok: false, reason: 'Owner descriptor содержит повторные ChildObjects.' }; }
    const folderByType = new Map([['Form', 'Forms'], ['Template', 'Templates'], ['Command', 'Commands']]);
    const seen = new Set<string>();
    const descriptors: RegisteredNestedMetadataDescriptor[] = [];
    for (const registration of registrations.flatMap(elementChildren)) {
      if (namespaceOf(registration) !== MDCLASSES_NAMESPACE) { continue; }
      const folder = folderByType.get(registration.localName);
      if (!folder) { continue; }
      const name = textContent(registration).trim();
      if (!name || /[\\/\0]/u.test(name) || name === '.' || name === '..' || elementChildren(registration).length > 0) {
        return { ok: false, reason: `Регистрация ${registration.localName} имеет небезопасное или неоднозначное имя.` };
      }
      const key = `${registration.localName}\0${name.normalize('NFC').toLocaleLowerCase('en-US')}`;
      if (seen.has(key)) { return { ok: false, reason: `Регистрация ${registration.localName} ${name} повторяется.` }; }
      seen.add(key);
      const relativePath = [input.sidecarRelativePath.replace(/\\/gu, '/').replace(/\/$/u, ''), folder, `${name}.xml`]
        .filter(Boolean).join('/');
      descriptors.push({ metadataType: registration.localName as RegisteredNestedMetadataDescriptor['metadataType'], name, relativePath });
    }
    return { ok: true, descriptors };
  } catch (error) {
    return { ok: false, reason: `Не удалось разобрать nested metadata registrations: ${errorMessage(error)}` };
  }
}

function buildSide(files: readonly AdoptedUuidRegistryFileCapture[]): AdoptedUuidRegistrySide {
  const definitions = new Map<string, AdoptedUuidRegistryDefinition[]>();
  const reasons: string[] = [];
  const witnesses: MergeFileWitness[] = [];
  const seenPaths = new Set<string>();
  for (const file of files) {
    const key = `${file.sourceId}\0${normalizePath(file.relativePath)}`;
    if (seenPaths.has(key)) {
      reasons.push(`Реестр UUID содержит повторный captured descriptor ${file.relativePath}.`);
      continue;
    }
    seenPaths.add(key);
    if (file.captureError || !file.content) {
      reasons.push(file.captureError ?? `Captured descriptor ${file.relativePath} не содержит bytes.`);
      continue;
    }
    const expectedHash = normalizeHash(file.expectedHash);
    if (!/^[\da-f]{64}$/iu.test(expectedHash) || hash(file.content) !== expectedHash) {
      reasons.push(`Captured descriptor ${file.relativePath} не совпадает с ожидаемым raw SHA-256.`);
      continue;
    }
    witnesses.push({ sourceId: file.sourceId, relativePath: file.relativePath, expectedHash, kind: 'file' });
    const parsed = file.kind === 'configuration'
      ? readConfiguration(file)
      : readMetadataDescriptor(file.content, file);
    if (!parsed.ok) {
      reasons.push(`${file.relativePath}: ${parsed.reason}`);
      continue;
    }
    for (const definition of parsed.definitions) {
      const values = definitions.get(definition.uuid) ?? [];
      values.push({
        ...definition,
        sourceId: file.sourceId,
        relativePath: file.relativePath,
        ownerKey: `${file.sourceId}\0${normalizePath(file.relativePath)}`,
      });
      definitions.set(definition.uuid, values);
    }
  }
  return {
    complete: reasons.length === 0 && files.length > 0,
    reasons,
    definitionsByUuid: definitions,
    witnesses,
  };
}

function readConfiguration(file: AdoptedUuidRegistryFileCapture):
  | { readonly ok: true; readonly definitions: readonly Omit<AdoptedUuidRegistryDefinition, 'sourceId' | 'relativePath' | 'ownerKey'>[] }
  | { readonly ok: false; readonly reason: string } {
  try {
    const root = parseXmlDocument(file.content!.toString('utf8')).root;
    if (expandedName(root) !== `{${MDCLASSES_NAMESPACE}}MetaDataObject`) {
      return { ok: false, reason: 'Корень Configuration.xml не является MDClasses/MetaDataObject.' };
    }
    const configs = directChildren(root, 'Configuration');
    if (configs.length !== 1) { return { ok: false, reason: 'Configuration.xml не содержит единственный MDClasses/Configuration.' }; }
    const configuration = configs[0]!;
    const uuid = unqualifiedAttribute(configuration, 'uuid');
    if (!uuid || !isUsableUuid(uuid)) { return { ok: false, reason: 'Configuration.xml не содержит корректный Configuration UUID.' }; }
    if (file.expectedUuid && normalizeUuid(file.expectedUuid) !== normalizeUuid(uuid)) {
      return { ok: false, reason: 'Configuration UUID не совпадает с захваченным индексом.' };
    }
    const name = directText(configuration, 'Properties', 'Name');
    if (file.expectedName && name !== file.expectedName) {
      return { ok: false, reason: 'Имя Configuration не совпадает с захваченным индексом.' };
    }
    return {
      ok: true,
      definitions: [{
        uuid: normalizeUuid(uuid),
        metadataType: 'Configuration',
        ...(name ? { name } : {}),
        ownerRootUuid: normalizeUuid(uuid),
        structuralPath: [`configuration-root={${MDCLASSES_NAMESPACE}}Configuration;name=${(name ?? '').trim().normalize('NFC').toLocaleLowerCase('en-US')}`],
        identityKey: `uuid=${normalizeUuid(uuid)}`,
        kind: 'configuration',
      }],
    };
  } catch (error) {
    return { ok: false, reason: `Не удалось разобрать Configuration.xml: ${errorMessage(error)}` };
  }
}

function readMetadataDescriptor(content: Buffer, expected?: AdoptedUuidRegistryFileCapture, logicalBaseRoot?: XmlElement):
  | {
    readonly ok: true;
    readonly definitions: readonly Omit<AdoptedUuidRegistryDefinition, 'sourceId' | 'relativePath' | 'ownerKey'>[];
    readonly children: readonly InternalChildUuid[];
    readonly rootObject: XmlElement;
    readonly rootBelonging?: string;
    readonly rootAnchor?: string;
  }
  | { readonly ok: false; readonly reason: string } {
  try {
    const root = parseXmlDocument(content.toString('utf8')).root;
    if (expandedName(root) !== `{${MDCLASSES_NAMESPACE}}MetaDataObject`) {
      return { ok: false, reason: 'Корень дескриптора не является MDClasses/MetaDataObject.' };
    }
    const objects = elementChildren(root).filter((element) => namespaceOf(element) === MDCLASSES_NAMESPACE);
    if (objects.length !== 1) { return { ok: false, reason: 'Дескриптор не содержит единственный MDClasses root object.' }; }
    const metadata = objects[0]!;
    const metadataType = metadata.localName;
    const name = directText(metadata, 'Properties', 'Name');
    const rootBelonging = directText(metadata, 'Properties', 'ObjectBelonging');
    const rootAnchor = directText(metadata, 'Properties', 'ExtendedConfigurationObject');
    const uuid = unqualifiedAttribute(metadata, 'uuid');
    if (!uuid || !isUsableUuid(uuid)) { return { ok: false, reason: 'MDClasses root object не содержит корректный UUID.' }; }
    if (expected?.expectedType && metadataType !== expected.expectedType) {
      return { ok: false, reason: `Root metadata type ${metadataType} не совпадает с регистрацией ${expected.expectedType}.` };
    }
    if (expected?.expectedName && name !== expected.expectedName) {
      return { ok: false, reason: `Root metadata name не совпадает с регистрацией ${expected.expectedName}.` };
    }
    if (expected?.expectedUuid && normalizeUuid(uuid) !== normalizeUuid(expected.expectedUuid)) {
      return { ok: false, reason: 'Root metadata UUID не совпадает с захваченным индексом.' };
    }
    const rootSelector = `metadata-root=${expandedName(metadata)};name=${(name ?? '').trim().normalize('NFC').toLocaleLowerCase('en-US')}`;
    const ownerRootUuid = normalizeUuid(uuid);
    const rootStructuralPath = [rootSelector];
    const children = collectChildDefinitions(metadata, rootStructuralPath, rootStructuralPath, true, ownerRootUuid, logicalBaseRoot);
    if (!children.ok) { return children; }
    return {
      ok: true,
      rootObject: metadata,
      ...(rootBelonging ? { rootBelonging } : {}),
      ...(rootAnchor ? { rootAnchor } : {}),
      definitions: [
        {
          uuid: normalizeUuid(uuid), metadataType, ...(name ? { name } : {}),
          ownerRootUuid,
          structuralPath: rootStructuralPath,
          identityKey: `uuid=${normalizeUuid(uuid)}`, kind: 'root',
        },
        ...children.children.map((child) => ({
          uuid: child.uuid,
          metadataType: child.metadataType,
          ...(child.name ? { name: child.name } : {}),
          ownerRootUuid: child.ownerRootUuid,
          structuralPath: child.structuralPath,
          identityKey: `uuid=${child.uuid}`,
          kind: 'child' as const,
        })),
      ],
      children: children.children,
    };
  } catch (error) {
    return { ok: false, reason: `Не удалось разобрать MDClasses descriptor: ${errorMessage(error)}` };
  }
}

interface InternalChildUuid extends NewMetadataChildUuid {
  readonly isOwn: boolean;
}

function collectChildDefinitions(
  parent: XmlElement,
  parentStructuralPath: readonly string[],
  parentLogicalPath: readonly string[],
  parentLogicalPathComplete: boolean,
  ownerRootUuid: string,
  logicalBaseParent?: XmlElement,
):
  | { readonly ok: true; readonly children: readonly InternalChildUuid[] }
  | { readonly ok: false; readonly reason: string } {
  const childContainers = directChildren(parent, 'ChildObjects');
  if (childContainers.length > 1) { return { ok: false, reason: 'Metadata descriptor содержит повторные ChildObjects.' }; }
  const children: InternalChildUuid[] = [];
  for (const child of childContainers.flatMap(elementChildren)) {
    if (namespaceOf(child) !== MDCLASSES_NAMESPACE) { continue; }
    const uuidValue = unqualifiedAttribute(child, 'uuid');
    if (uuidValue !== undefined) {
      if (!isUsableUuid(uuidValue)) { return { ok: false, reason: `UUID у metadata child ${child.localName} некорректен.` }; }
      const uuid = normalizeUuid(uuidValue);
      const belonging = directText(child, 'Properties', 'ObjectBelonging');
      const anchor = directText(child, 'Properties', 'ExtendedConfigurationObject');
      const name = directText(child, 'Properties', 'Name');
      const structuralPath = [...parentStructuralPath, `uuid=${uuid}`];
      const isAdopted = belonging === 'Adopted' && Boolean(anchor);
      const expectedBaseUuid = isAdopted && anchor && isUsableUuid(anchor) ? anchor : uuid;
      const logicalBaseChild = findLogicalBaseChild(logicalBaseParent, child, expectedBaseUuid, name);
      const logicalPathComplete = parentLogicalPathComplete && (!isAdopted || Boolean(logicalBaseChild));
      const logicalUuid = isAdopted && logicalBaseChild ? expectedBaseUuid : uuid;
      const logicalStructuralPath = [...parentLogicalPath, `uuid=${normalizeUuid(logicalUuid)}`];
      children.push({
        uuid,
        metadataType: child.localName,
        ...(name ? { name } : {}),
        ownerRootUuid,
        identityKey: `uuid=${uuid}`,
        structuralPath,
        logicalStructuralPath,
        logicalPathComplete,
        isOwn: (belonging === undefined || belonging === 'Own') && !anchor,
      });
      const descendants = collectChildDefinitions(
        child, structuralPath, logicalStructuralPath, logicalPathComplete, ownerRootUuid, logicalBaseChild,
      );
      if (!descendants.ok) { return descendants; }
      children.push(...descendants.children);
      continue;
    }
    const descendants = collectChildDefinitions(
      child, parentStructuralPath, parentLogicalPath, parentLogicalPathComplete, ownerRootUuid, logicalBaseParent,
    );
    if (!descendants.ok) { return descendants; }
    children.push(...descendants.children);
  }
  return { ok: true, children };
}

function childIdentityKey(child: Pick<NewMetadataChildUuid, 'metadataType' | 'name' | 'uuid' | 'ownerRootUuid' | 'structuralPath'>): string {
  return [
    child.metadataType,
    (child.name ?? '').trim().normalize('NFC').toLocaleLowerCase('en-US'),
    normalizeUuid(child.uuid),
    normalizeUuid(child.ownerRootUuid),
    child.structuralPath.map((selector) => selector.toLocaleLowerCase('en-US')).join('/'),
  ].join('\0');
}

export function sameAdoptedUuidIdentity(
  left: Pick<NewMetadataChildUuid, 'metadataType' | 'name' | 'uuid' | 'ownerRootUuid' | 'structuralPath'>,
  right: Pick<AdoptedUuidRegistryDefinition, 'metadataType' | 'name' | 'uuid' | 'ownerRootUuid' | 'structuralPath'>,
): boolean {
  return childIdentityKey(left) === childIdentityKey(right);
}

/** Matches a physical source child against its logical owner after the row's exact base proof. */
export function sameAdoptedUuidIdentityAtProvenOwner(
  left: NewMetadataChildUuid,
  right: Pick<AdoptedUuidRegistryDefinition, 'metadataType' | 'name' | 'uuid' | 'ownerRootUuid' | 'structuralPath'>,
  provenOwnerRootUuid: string,
): boolean {
  if (!left.logicalPathComplete) { return false; }
  return childIdentityKey({
    ...left,
    ownerRootUuid: normalizeUuid(provenOwnerRootUuid),
    structuralPath: left.logicalStructuralPath,
  }) === childIdentityKey(right);
}

function findLogicalBaseChild(
  baseParent: XmlElement | undefined,
  sourceChild: XmlElement,
  expectedUuid: string,
  sourceName: string | undefined,
): XmlElement | undefined {
  if (!baseParent || !isUsableUuid(expectedUuid) || !sourceName) { return undefined; }
  const matches = directChildren(baseParent, 'ChildObjects').flatMap(elementChildren).filter((candidate) =>
    namespaceOf(candidate) === MDCLASSES_NAMESPACE
      && candidate.localName === sourceChild.localName
      && normalizeUuid(unqualifiedAttribute(candidate, 'uuid') ?? '') === normalizeUuid(expectedUuid)
      && directText(candidate, 'Properties', 'Name') === sourceName,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function directText(parent: XmlElement, parentName: string, childName: string): string | undefined {
  const containers = directChildren(parent, parentName);
  if (containers.length !== 1) { return undefined; }
  const children = directChildren(containers[0]!, childName);
  return children.length === 1 ? textContent(children[0]!).trim() : undefined;
}

function directChildren(parent: XmlElement, name: string): XmlElement[] {
  return elementChildren(parent).filter((child) => child.localName === name && namespaceOf(child) === MDCLASSES_NAMESPACE);
}

function namespaceOf(element: XmlElement): string | undefined {
  const prefix = element.name.includes(':') ? element.name.slice(0, element.name.indexOf(':')) : '';
  const declaration = prefix ? `xmlns:${prefix}` : 'xmlns';
  let current: XmlElement | undefined = element;
  while (current) {
    const found = current.attributes.find((attribute) => attribute.name === declaration);
    if (found) { return found.value || undefined; }
    current = current.parent;
  }
  return undefined;
}

function expandedName(element: XmlElement): string { return `{${namespaceOf(element) ?? ''}}${element.localName}`; }

function unqualifiedAttribute(element: XmlElement, name: string): string | undefined {
  return element.attributes.find((attribute) => attribute.name === name)?.value;
}

function isUsableUuid(value: string): boolean {
  return UUID_PATTERN.test(value) && normalizeUuid(value) !== ZERO_UUID;
}

function normalizeUuid(value: string): string { return value.toLowerCase(); }
function normalizeHash(value: string): string { return value.replace(/^sha256:/iu, '').toLowerCase(); }
function normalizePath(value: string): string { return value.replace(/\\/gu, '/').replace(/^\.\//u, ''); }
function hash(content: Buffer): string { return createHash('sha256').update(content).digest('hex'); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
