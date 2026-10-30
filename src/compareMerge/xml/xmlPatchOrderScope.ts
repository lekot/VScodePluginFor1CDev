import { getMetadataTypeDescriptorByRootTag } from '../../constants/metadataTypeDescriptors';
import { elementChildren, getXmlElementIdentityKey, type XmlElement } from './xmlDom';
import type { XmlOrderScope } from './xmlPatchTypes';

export const MDCLASSES_ORDER_NAMESPACE = 'http://v8.1c.ru/8.3/MDClasses';
export const LOGFORM_ORDER_NAMESPACE = 'http://v8.1c.ru/8.3/xcf/logform';

const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;
const METADATA_ORDER_KINDS = new Set([
  'EnumValue', 'Attribute', 'TabularSection', 'Dimension', 'Resource', 'AddressingAttribute',
  'AccountingFlag', 'ExtDimensionAccountingFlag', 'URLTemplate', 'Method', 'Operation', 'Parameter',
]);
const FORM_SECTION_CHILDREN: Readonly<Record<string, string>> = {
  Attributes: 'Attribute',
  Commands: 'Command',
  Parameters: 'Parameter',
};

/** Rejects extra or malformed fields even when a caller bypasses TypeScript. */
export function isXmlOrderScope(value: unknown): value is XmlOrderScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {return false;}
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === 'metadataChildObjects') {
    return Object.keys(candidate).length === 2 && Object.keys(candidate).every((key) => key === 'kind' || key === 'elementKind') &&
      typeof candidate.elementKind === 'string' && METADATA_ORDER_KINDS.has(candidate.elementKind);
  }
  if (candidate.kind === 'formSection') {
    return Object.keys(candidate).length === 2 && Object.keys(candidate).every((key) => key === 'kind' || key === 'section') &&
      typeof candidate.section === 'string' && Object.prototype.hasOwnProperty.call(FORM_SECTION_CHILDREN, candidate.section);
  }
  return false;
}

/** Shared allowlist for the adapter projection and runtime patch validator. */
export function supportsMetadataOrderScope(container: XmlElement, elementKind: string): boolean {
  const owner = container.parent;
  const root = owner ? metadataRootOf(owner) : undefined;
  if (!owner || !root || root.localName !== 'MetaDataObject' || !hasNamespace(root, MDCLASSES_ORDER_NAMESPACE) ||
      container.localName !== 'ChildObjects' || !hasNamespace(container, MDCLASSES_ORDER_NAMESPACE) ||
      !METADATA_ORDER_KINDS.has(elementKind) || !isSafeMetadataOwner(root, owner) || uniqueChildObjects(owner) !== container) {
    return false;
  }
  if (metadataSchemaRank(container, elementKind) === undefined || !hasSafeMetadataCollectionShape(container, elementKind)) {return false;}
  if (owner.parent === root) {
    if (elementKind === 'EnumValue') {return owner.localName === 'Enum';}
    if (owner.localName === 'InformationRegister' || owner.localName === 'AccumulationRegister') {
      return ['Dimension', 'Resource'].includes(elementKind) || rootDescriptorAllows(owner.localName, elementKind);
    }
    if (owner.localName === 'Task' && elementKind === 'AddressingAttribute') {return true;}
    if (owner.localName === 'ChartOfAccounts' && ['AccountingFlag', 'ExtDimensionAccountingFlag'].includes(elementKind)) {return true;}
    if (owner.localName === 'HTTPService' && elementKind === 'URLTemplate') {return true;}
    if (owner.localName === 'WebService' && elementKind === 'Operation') {return true;}
    return rootDescriptorAllows(owner.localName, elementKind);
  }
  if (owner.localName === 'TabularSection' && elementKind === 'Attribute') {return true;}
  if (owner.localName === 'URLTemplate' && elementKind === 'Method') {return true;}
  if (owner.localName === 'Operation' && elementKind === 'Parameter') {return true;}
  return false;
}

export function supportsFormSectionOrderScope(
  root: XmlElement,
  parent: XmlElement,
  section: string,
  childKind: string,
): boolean {
  if (root.localName !== 'Form' || !hasNamespace(root, LOGFORM_ORDER_NAMESPACE) ||
      parent.parent !== root || parent.localName !== section || FORM_SECTION_CHILDREN[section] !== childKind ||
      !hasNamespace(parent, LOGFORM_ORDER_NAMESPACE) || hasDirectBaseForm(root) ||
      !uniqueFormSection(root, section)) {return false;}
  return true;
}

/** Stable identities are deliberately narrower than the generic address fallback. */
export function scopedOrderIdentity(element: XmlElement, scope: XmlOrderScope): string | undefined {
  if (scope.kind === 'metadataChildObjects') {
    if (element.localName !== scope.elementKind || !hasNamespace(element, MDCLASSES_ORDER_NAMESPACE)) {return undefined;}
    const uuid = metadataUuid(element);
    return uuid && UUID_PATTERN.test(uuid) ? `uuid=${uuid.toLowerCase()}` : undefined;
  }
  const childKind = FORM_SECTION_CHILDREN[scope.section];
  if (element.localName !== childKind || !hasNamespace(element, LOGFORM_ORDER_NAMESPACE)) {return undefined;}
  const identity = getXmlElementIdentityKey(element);
  if (!identity || (!identity.startsWith('id=') && !identity.startsWith('name='))) {return undefined;}
  return identity;
}

/** A rank exists only for schema-ordered neighbors used by this closed profile. */
export function metadataAppendRank(container: XmlElement, elementKind: string): number | undefined {
  if (!supportsMetadataOrderScope(container, elementKind)) {return undefined;}
  return metadataSchemaRank(container, elementKind);
}

/** Finds the first final later-kind sibling; caller attaches higher-rank placements first. */
export function metadataAppendBoundary(container: XmlElement, elementKind: string): XmlElement | undefined {
  const rank = metadataAppendRank(container, elementKind);
  if (rank === undefined) {throw new Error('XML metadata order scope has no verified schema rank');}
  const owner = container.parent!;
  const root = metadataRootOf(owner)!;
  const children = elementChildren(container);
  const ranks = children.map((child) => {
    const childRank = metadataAppendRankForExisting(container, root, child.localName);
    if (childRank === undefined || !hasNamespace(child, MDCLASSES_ORDER_NAMESPACE)) {
      throw new Error('XML metadata order append cannot cross an unknown or foreign ChildObjects sibling');
    }
    return childRank;
  });
  const laterIndex = ranks.findIndex((childRank) => childRank > rank);
  if (laterIndex >= 0) {return children[laterIndex];}
  return undefined;
}

function metadataAppendRankForExisting(container: XmlElement, root: XmlElement, childKind: string): number | undefined {
  if (metadataRootOf(container.parent!) !== root) {return undefined;}
  return metadataSchemaRank(container, childKind);
}

function metadataSchemaRank(container: XmlElement, elementKind: string): number | undefined {
  const owner = container.parent;
  const root = owner ? metadataRootOf(owner) : undefined;
  const ownerPath = owner && root ? metadataOwnerPath(root, owner) : undefined;
  const rootKind = ownerPath?.[0]?.localName;
  if (!owner || !root || !ownerPath || !rootKind) {return undefined;}
  if (ownerPath.length === 1) {
    const index = rootMetadataOrder(rootKind).indexOf(elementKind);
    return index < 0 ? undefined : index * 10;
  }
  if (ownerPath.length === 2 && rootKind === 'HTTPService' && owner.localName === 'URLTemplate') {
    return elementKind === 'Method' ? 0 : undefined;
  }
  if (ownerPath.length === 2 && rootKind === 'WebService' && owner.localName === 'Operation') {
    return elementKind === 'Parameter' ? 0 : undefined;
  }
  if (ownerPath.length === 2 && owner.localName === 'TabularSection') {
    return elementKind === 'Attribute' ? 0 : undefined;
  }
  return undefined;
}

function hasSafeMetadataCollectionShape(container: XmlElement, orderedKind: string): boolean {
  const identities = new Set<string>();
  for (const child of elementChildren(container)) {
    if (!hasNamespace(child, MDCLASSES_ORDER_NAMESPACE) || metadataSchemaRank(container, child.localName) === undefined) {return false;}
    if (child.localName === orderedKind) {
      const identity = metadataUuid(child);
      if (!identity || identities.has(identity)) {return false;}
      identities.add(identity);
    }
  }
  return true;
}

function rootMetadataOrder(rootKind: string): string[] {
  const descriptor = getMetadataTypeDescriptorByRootTag(rootKind);
  const supportsGeneric = (kind: 'Attribute' | 'TabularSection'): boolean =>
    Boolean(descriptor?.structure.hasChildObjects && descriptor.genericRootChildObjectKinds.includes(kind));
  if (rootKind === 'InformationRegister' || rootKind === 'AccumulationRegister') {
    return ['Dimension', 'Resource', ...(supportsGeneric('Attribute') ? ['Attribute'] : []), ...(supportsGeneric('TabularSection') ? ['TabularSection'] : []), 'Form', 'Template', 'Command', 'Picture'];
  }
  if (rootKind === 'AccountingRegister' || rootKind === 'CalculationRegister') {
    return ['Dimension', 'Resource', ...(supportsGeneric('Attribute') ? ['Attribute'] : []), ...(supportsGeneric('TabularSection') ? ['TabularSection'] : []), 'Form', 'Template', 'Command', 'Picture'];
  }
  if (rootKind === 'ChartOfAccounts') {
    return ['Dimension', 'AccountingFlag', 'ExtDimensionAccountingFlag', ...(supportsGeneric('Attribute') ? ['Attribute'] : []), ...(supportsGeneric('TabularSection') ? ['TabularSection'] : []), 'Form', 'Template', 'Command', 'Picture'];
  }
  if (rootKind === 'Task') {
    return ['AddressingAttribute', ...(supportsGeneric('Attribute') ? ['Attribute'] : []), ...(supportsGeneric('TabularSection') ? ['TabularSection'] : []), 'Form', 'Template', 'Command', 'Picture'];
  }
  if (rootKind === 'HTTPService') {return ['URLTemplate', 'Form', 'Template', 'Command'];}
  if (rootKind === 'WebService') {return ['Operation', 'Form', 'Template', 'Command'];}
  if (rootKind === 'Enum') {return ['EnumValue'];}
  if (!descriptor?.structure.hasChildObjects) {return [];}
  const supported = new Set(descriptor.genericRootChildObjectKinds);
  return ['Attribute', 'TabularSection'].filter((kind) => supported.has(kind as 'Attribute' | 'TabularSection'))
    .concat(['Form', 'Template', 'Command', 'Picture']);
}

function rootDescriptorAllows(owner: string, childKind: string): boolean {
  const descriptor = getMetadataTypeDescriptorByRootTag(owner);
  return Boolean(descriptor?.structure.hasChildObjects &&
    descriptor.genericRootChildObjectKinds.includes(childKind as 'Attribute' | 'TabularSection'));
}

function isSafeMetadataOwner(root: XmlElement, owner: XmlElement): boolean {
  if (!hasNamespace(owner, MDCLASSES_ORDER_NAMESPACE) || !ownerIdentityUnique(root, owner)) {return false;}
  const path = metadataOwnerPath(root, owner);
  if (!path || path.length === 0) {return false;}
  const rootOwner = path[0]!;
  if (rootOwner.parent !== root || !getMetadataTypeDescriptorByRootTag(rootOwner.localName)?.structure.hasChildObjects) {return false;}
  if (path.length > 1 && !isSupportedNestedOwner(path)) {return false;}
  return path.every((entry, index) => isOwnMetadataOwner(root, entry) &&
    (index === 0 ? entry.parent === root : uniqueChildObjects(path[index - 1]!) === entry.parent));
}

function isOwnMetadataOwner(root: XmlElement, owner: XmlElement): boolean {
  if (!hasNamespace(owner, MDCLASSES_ORDER_NAMESPACE) || !ownerIdentityUnique(root, owner)) {return false;}
  const propertyGroups = elementChildren(owner).filter((child) => child.localName === 'Properties');
  if (propertyGroups.length !== 1 || !hasNamespace(propertyGroups[0]!, MDCLASSES_ORDER_NAMESPACE)) {return false;}
  const properties = propertyGroups[0]!;
  const belongingNodes = elementChildren(properties).filter((child) => child.localName === 'ObjectBelonging');
  const extendedNodes = elementChildren(properties).filter((child) => child.localName === 'ExtendedConfigurationObject');
  if (belongingNodes.length > 1 || extendedNodes.length > 0 ||
      belongingNodes.some((child) => !hasNamespace(child, MDCLASSES_ORDER_NAMESPACE))) {return false;}
  if (belongingNodes.length === 0) {return true;}
  return directText(properties, 'ObjectBelonging') === 'Own';
}

function isSupportedNestedOwner(path: readonly XmlElement[]): boolean {
  if (path.length === 2) {
    return (path[0]!.localName === 'Task' && path[1]!.localName === 'AddressingAttribute') ||
      (path[1]!.localName === 'TabularSection' && rootDescriptorAllows(path[0]!.localName, 'TabularSection')) ||
      (path[0]!.localName === 'HTTPService' && path[1]!.localName === 'URLTemplate') ||
      (path[0]!.localName === 'WebService' && path[1]!.localName === 'Operation');
  }
  return path.length === 3 &&
    ((path[0]!.localName === 'HTTPService' && path[1]!.localName === 'URLTemplate' && path[2]!.localName === 'Method') ||
      (path[0]!.localName === 'WebService' && path[1]!.localName === 'Operation' && path[2]!.localName === 'Parameter') ||
      (path[1]!.localName === 'TabularSection' && path[2]!.localName === 'Attribute'));
}

function metadataOwnerPath(root: XmlElement, owner: XmlElement): XmlElement[] | undefined {
  const path: XmlElement[] = [];
  let current: XmlElement | undefined = owner;
  while (current && current !== root) {
    if (current.localName !== 'ChildObjects') {path.unshift(current);}
    current = current.parent;
  }
  if (current !== root || path.length === 0 || path[0]!.parent !== root) {return undefined;}
  return path;
}

function metadataRootOf(owner: XmlElement): XmlElement | undefined {
  let current: XmlElement | undefined = owner;
  while (current && current.localName !== 'MetaDataObject') {current = current.parent;}
  return current;
}

function uniqueChildObjects(owner: XmlElement): XmlElement | undefined {
  const containers = elementChildren(owner).filter((child) => child.localName === 'ChildObjects');
  return containers.length === 1 && hasNamespace(containers[0]!, MDCLASSES_ORDER_NAMESPACE) ? containers[0] : undefined;
}

function ownerIdentityUnique(root: XmlElement, owner: XmlElement): boolean {
  const uuid = metadataUuid(owner);
  if (!uuid) {return false;}
  let count = 0;
  const visit = (element: XmlElement): void => {
    if (element.localName === owner.localName && hasNamespace(element, MDCLASSES_ORDER_NAMESPACE) && metadataUuid(element) === uuid) {count += 1;}
    for (const child of elementChildren(element)) {visit(child);}
  };
  visit(root);
  return count === 1;
}

function metadataUuid(element: XmlElement): string | undefined {
  const uuidAttributes = element.attributes.filter((attribute) => attribute.name === 'uuid' ||
    (attribute.name !== 'xmlns:uuid' && attribute.name.toLowerCase().endsWith(':uuid')));
  if (uuidAttributes.length !== 1 || uuidAttributes[0]!.name !== 'uuid') {return undefined;}
  const uuid = uuidAttributes[0]!.value.trim();
  return uuid && UUID_PATTERN.test(uuid) ? uuid.toLowerCase() : undefined;
}

function uniqueFormSection(root: XmlElement, section: string): boolean {
  const matches = elementChildren(root).filter((child) => child.localName === section);
  return matches.length === 1 && hasNamespace(matches[0]!, LOGFORM_ORDER_NAMESPACE);
}

function hasDirectBaseForm(root: XmlElement): boolean {
  return elementChildren(root).some((child) => child.localName === 'BaseForm');
}

function hasNamespace(element: XmlElement, expected: string): boolean {
  const prefix = element.name.includes(':') ? element.name.slice(0, element.name.indexOf(':')) : '';
  const declarationName = prefix ? `xmlns:${prefix}` : 'xmlns';
  let current: XmlElement | undefined = element;
  while (current) {
    const declaration = current.attributes.find((attribute) => attribute.name === declarationName);
    if (declaration) {return declaration.value === expected;}
    current = current.parent;
  }
  return false;
}

function directText(element: XmlElement, childName: string): string | undefined {
  const matching = elementChildren(element).filter((candidate) => candidate.localName === childName);
  if (matching.length !== 1 || !hasNamespace(matching[0]!, MDCLASSES_ORDER_NAMESPACE)) {return undefined;}
  const value = matching[0]!.children.map((node) => node.kind === 'text' ? node.text : '').join('').trim();
  return value || undefined;
}
