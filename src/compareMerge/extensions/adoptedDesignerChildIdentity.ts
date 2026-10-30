import { elementChildren, type XmlElement } from '../xml/xmlDom';
import {
  attach,
  attribute,
  cloneWithNamespaces,
  direct as xmlDirect,
  expandedName,
  makeElement,
  makeTextElement,
  prefixForNamespace,
  remove,
  replace,
  setAttribute,
} from './adoptedDesignerXml';

const MDCLASSES_NAMESPACE = 'http://v8.1c.ru/8.3/MDClasses';
const READABLE_NAMESPACE = 'http://v8.1c.ru/8.3/xcf/readable';
const LOCAL_UUID = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu;

export interface AdoptedDesignerChildUuidRequirement {
  readonly mapKey: string;
  readonly parentScope: string;
  readonly type: string;
  readonly anchorUuid: string;
}

export type AdoptedDesignerChildUuidRequirementsResult =
  | { readonly ok: true; readonly requirements: readonly AdoptedDesignerChildUuidRequirement[] }
  | { readonly ok: false; readonly reason: string };

export interface AdoptedChildUuidAllocationInput {
  readonly adoptedChildUuidByAnchor?: ReadonlyMap<string, string>;
  readonly targetChildUuids: Set<string>;
}

export function adoptedChildUuidMapKey(parentScope: string, type: string, baseAnchorUuid: string): string {
  return `${normalizeAdoptedIdentity(parentScope)}\0${normalizeAdoptedIdentity(type)}\0${normalizeAdoptedIdentity(baseAnchorUuid)}`;
}

export function normalizeAdoptedIdentity(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('en-US');
}

/** Appends requirements for proven base children that have no matching physical overlay. */
export function collectMissingAdoptedDesignerChildUuids(
  baseParent: XmlElement,
  physicalParent: XmlElement | undefined,
  parentScope: string,
  requirements: AdoptedDesignerChildUuidRequirement[],
  seen: Set<string>,
): void {
  const baseContainers = metadataDirect(baseParent, 'ChildObjects');
  const physicalContainers = physicalParent ? metadataDirect(physicalParent, 'ChildObjects') : [];
  if (baseContainers.length > 1 || physicalContainers.length > 1) {
    throw new Error('ChildObjects повторяется; adopted child UUID requirements неоднозначны.');
  }
  const baseChildren = baseContainers[0] ? elementChildren(baseContainers[0]).filter(isMetadataElement) : [];
  const physicalChildren = physicalContainers[0] ? elementChildren(physicalContainers[0]).filter(isMetadataElement) : [];
  const baseKeys = new Set<string>();
  for (const baseChild of baseChildren) {
    const type = baseChild.localName;
    const anchorUuid = attribute(baseChild, 'uuid');
    const baseProperties = metadataDirect(baseChild, 'Properties');
    const name = baseProperties.length === 1 ? metadataChildText(baseProperties[0]!, 'Name') : undefined;
    if (!anchorUuid || baseProperties.length !== 1 || !name) { continue; }
    const baseKey = adoptedChildUuidMapKey(parentScope, type, anchorUuid);
    if (baseKeys.has(baseKey)) { throw new Error(`Base child anchor ${type}/${anchorUuid} повторяется.`); }
    baseKeys.add(baseKey);

    const sameAnchor = physicalChildren.filter((candidate) => candidate.localName === type
      && same(metadataChildText(metadataDirect(candidate, 'Properties')[0] ?? candidate, 'ExtendedConfigurationObject'), anchorUuid));
    let physicalOverlay: XmlElement | undefined;
    if (sameAnchor.length === 1) {
      const candidate = sameAnchor[0]!;
      const candidateProperties = metadataDirect(candidate, 'Properties');
      if (candidateProperties.length === 1 && isAdopted(candidate)
        && !same(attribute(candidate, 'uuid'), anchorUuid)
        && same(metadataChildText(candidateProperties[0]!, 'Name'), name)) {
        physicalOverlay = candidate;
      }
    } else if (sameAnchor.length === 0) {
      const sameName = physicalChildren.some((candidate) => candidate.localName === type
        && same(metadataChildText(metadataDirect(candidate, 'Properties')[0] ?? candidate, 'Name'), name));
      if (!sameName) {
        const mapKey = adoptedChildUuidMapKey(parentScope, type, anchorUuid);
        if (seen.has(mapKey)) { throw new Error(`UUID allocation requirement ${type}/${anchorUuid} повторяется.`); }
        seen.add(mapKey);
        requirements.push({ mapKey, parentScope, type, anchorUuid });
      }
    }
    collectMissingAdoptedDesignerChildUuids(baseChild, physicalOverlay, `uuid=${normalizeAdoptedIdentity(anchorUuid)}`, requirements, seen);
  }
}

export function allocateAdoptedChildUuid(
  input: AdoptedChildUuidAllocationInput,
  ownerScope: string,
  base: XmlElement,
): { readonly ok: true; readonly uuid: string } | { readonly ok: false; readonly reason: string } {
  const type = base.localName;
  const anchorUuid = attribute(base, 'uuid');
  if (!anchorUuid) { return { ok: false, reason: `У ${type} отсутствует anchor UUID для локальной allocation.` }; }
  const key = adoptedChildUuidMapKey(ownerScope, type, anchorUuid);
  const uuid = input.adoptedChildUuidByAnchor?.get(key);
  if (!uuid) { return { ok: false, reason: `Для ${type} anchor=${anchorUuid} не передан предварительно выделенный локальный UUID child.` }; }
  if (!LOCAL_UUID.test(uuid) || /^0{8}(?:-0{4}){3}-0{12}$/u.test(uuid)) {
    return { ok: false, reason: `Предварительно выделенный UUID ${uuid} для ${type} имеет неправильный формат.` };
  }
  const normalized = normalizeAdoptedIdentity(uuid);
  if (same(uuid, anchorUuid)) { return { ok: false, reason: `Локальный UUID ${uuid} совпадает с CF anchor для ${type}.` }; }
  if (input.targetChildUuids.has(normalized)) { return { ok: false, reason: `Локальный UUID ${uuid} конфликтует с UUID target root/child.` }; }
  input.targetChildUuids.add(normalized);
  return { ok: true, uuid };
}

/** Creates the smallest valid adopted shell; inherited payload stays in the CF base. */
export function createNewAdoptedChildOverlay(base: XmlElement, localUuid: string): XmlElement {
  const result = cloneWithNamespaces(base);
  const properties = exactlyOne(result, 'Properties');
  const names = metadataDirect(properties, 'Name');
  if (names.length !== 1) { throw new Error(`Новый adopted child ${base.localName} требует единственный metadata Name.`); }
  for (const child of elementChildren(properties)) {
    if (!isMetadataElement(child)) { throw new Error(`Новый adopted child ${base.localName} содержит неизвестное свойство namespace=${expandedName(child)}.`); }
    if (child !== names[0]) { remove(properties, child); }
  }

  for (const child of elementChildren(result)) {
    if (!isMetadataElement(child)) { throw new Error(`Новый adopted child ${base.localName} содержит unknown structural namespace=${expandedName(child)}.`); }
    if (!['Properties', 'InternalInfo', 'ChildObjects'].includes(child.localName)) {
      throw new Error(`Новый adopted child ${base.localName} содержит неподдерживаемую структуру ${child.localName}.`);
    }
  }

  const internalInfos = metadataDirect(result, 'InternalInfo');
  if (internalInfos.length > 1) { throw new Error(`Новый adopted child ${base.localName} содержит повторный InternalInfo.`); }
  const internalInfo = internalInfos[0] ?? makeElement(qualifiedNameForNamespace(result, 'InternalInfo'));
  if (!internalInfos[0]) { attach(result, internalInfo); }
  for (const child of elementChildren(internalInfo)) {
    if (namespaceOf(child) !== READABLE_NAMESPACE || child.localName !== 'GeneratedType') {
      throw new Error(`Новый adopted child ${base.localName} содержит неподдерживаемый InternalInfo/${child.localName}.`);
    }
  }

  const childContainers = metadataDirect(result, 'ChildObjects');
  if (childContainers.length > 1) { throw new Error(`Новый adopted child ${base.localName} содержит повторный ChildObjects.`); }
  if (childContainers[0]) {
    for (const child of elementChildren(childContainers[0])) {
      if (!isMetadataElement(child)) { throw new Error(`Новый adopted child ${base.localName} содержит unknown nested ChildObjects namespace.`); }
      remove(childContainers[0]!, child);
    }
  }
  const propertiesNode = exactlyOne(result, 'Properties');
  const structuralOrder = [internalInfo, propertiesNode, ...(childContainers[0] ? [childContainers[0]] : [])];
  let structuralIndex = 0;
  result.children = result.children.map((child) => child.kind === 'element' ? structuralOrder[structuralIndex++]! : child);
  setAttribute(result, 'uuid', localUuid);
  return result;
}

export function setAdoptedChildOwnership(target: XmlElement, base: XmlElement, previous: XmlElement): void {
  const properties = exactlyOne(target, 'Properties');
  const baseProperties = exactlyOne(base, 'Properties');
  const uuid = attribute(previous, 'uuid');
  const anchor = attribute(base, 'uuid');
  if (!uuid || !anchor || same(uuid, anchor)) {
    throw new Error('Adopted child overlay must preserve its non-base local UUID and exact CF anchor.');
  }
  setAttribute(target, 'uuid', uuid);
  replaceMetadata(properties, makeTextElement(qualifiedNameForNamespace(properties, 'ObjectBelonging'), 'Adopted'));
  replaceMetadata(properties, makeTextElement(qualifiedNameForNamespace(properties, 'ExtendedConfigurationObject'), attribute(base, 'uuid') ?? ''));
  // Ensure the base's own Properties shape was not silently replaced by an overlay shell.
  if (!metadataChildText(baseProperties, 'Name')) { throw new Error('CF adopted child anchor has no metadata Name.'); }
}

export function ensureAdoptedChildComment(target: XmlElement, base: XmlElement): void {
  const comments = metadataDirect(target, 'Comment');
  if (comments.length > 1) { throw new Error('Adopted child Comment repeats.'); }
  if (comments.length === 1) { return; }
  const baseComments = metadataDirect(base, 'Comment');
  if (baseComments.length > 1) { throw new Error('Base child Comment repeats.'); }
  const comment = baseComments[0] ? cloneWithNamespaces(baseComments[0]!) : makeTextElement(qualifiedNameForNamespace(target, 'Comment'), '');
  replaceMetadata(target, comment);
}

function replaceMetadata(parent: XmlElement, replacement: XmlElement): void {
  const existing = metadataDirect(parent, replacement.localName);
  if (existing.length > 1) { throw new Error(`Metadata XML contains duplicate ${replacement.localName} nodes.`); }
  if (existing[0]) { replace(parent, existing[0], replacement); }
  else { attach(parent, replacement); }
}

function exactlyOne(parent: XmlElement, name: string): XmlElement {
  const matches = metadataDirect(parent, name);
  if (matches.length !== 1) { throw new Error(`Нужен единственный metadata ${name}.`); }
  return matches[0]!;
}

function metadataDirect(parent: XmlElement, name: string): XmlElement[] {
  return xmlDirect(parent, name).filter((child) => namespaceOf(child) === MDCLASSES_NAMESPACE);
}

function metadataChildText(parent: XmlElement, name: string): string | undefined {
  const matches = metadataDirect(parent, name);
  if (matches.length !== 1) { return undefined; }
  return matches[0]!.children.filter((child) => child.kind === 'text').map((child) => child.text).join('').trim();
}

function isMetadataElement(element: XmlElement): boolean {
  return namespaceOf(element) === MDCLASSES_NAMESPACE;
}

function namespaceOf(element: XmlElement): string | undefined {
  const name = expandedName(element);
  if (!name.startsWith('{')) { return undefined; }
  return name.slice(1, name.indexOf('}'));
}

function qualifiedNameForNamespace(parent: XmlElement, localName: string): string {
  if (!parent.name.includes(':') && namespaceOf(parent) === MDCLASSES_NAMESPACE) { return localName; }
  return `${prefixForNamespace(parent, MDCLASSES_NAMESPACE, 'md')}:${localName}`;
}

function isAdopted(element: XmlElement): boolean {
  const properties = metadataDirect(element, 'Properties');
  return properties.length === 1 && metadataChildText(properties[0]!, 'ObjectBelonging') === 'Adopted';
}

function same(left: string | undefined, right: string | undefined): boolean {
  return left?.normalize('NFC').toLocaleLowerCase('en-US') === right?.normalize('NFC').toLocaleLowerCase('en-US');
}
