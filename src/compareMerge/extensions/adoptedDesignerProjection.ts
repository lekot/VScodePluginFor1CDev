import {
  cloneXmlElement,
  elementChildren,
  parseXmlDocument,
  serializeXmlDocument,
  type XmlDocument,
  type XmlElement,
} from '../xml/xmlDom';
import {
  allocateAdoptedChildUuid,
  collectMissingAdoptedDesignerChildUuids,
  createNewAdoptedChildOverlay,
  ensureAdoptedChildComment,
  normalizeAdoptedIdentity,
  setAdoptedChildOwnership,
  type AdoptedDesignerChildUuidRequirement,
  type AdoptedDesignerChildUuidRequirementsResult,
} from './adoptedDesignerChildIdentity';
import {
  createAdoptedDesignerTypeIdResolver,
  type AdoptedDesignerTypeIdReferenceDescriptor,
} from './adoptedDesignerTypeId';
import { projectAdoptedProperties } from './adoptedDesignerLogicalProperties';
import { projectAdoptedDesignerChildren } from './adoptedDesignerChildProjection';
import {
  encodeAdoptedMetadataOrder,
  hasAdoptedMetadataOrderChange,
} from './adoptedDesignerOrder';
import {
  collectBaseFormRegistrations,
  encodeOwnFormRegistrations,
  ownFormRegistrationNames,
  projectOwnFormRegistrations,
  selectedNewFormRegistrationNames,
  type AdoptedDesignerOwnFormRegistrations,
  type FormRegistrationRecord,
} from './adoptedDesignerFormRegistrations';
export { adoptedChildUuidMapKey } from './adoptedDesignerChildIdentity';
export type { AdoptedDesignerChildUuidRequirement, AdoptedDesignerChildUuidRequirementsResult } from './adoptedDesignerChildIdentity';
import {
  attach,
  attribute,
  cloneWithNamespaces,
  makeElement,
  makeTextElement,
  prefixForNamespace,
  remove,
  replace,
  setAttribute,
  sameElement,
} from './adoptedDesignerXml';
import type { MergeFileWitness } from '../merge/mergePreview';
import {
  addIssue,
  allMetadataChildren,
  childIdentity,
  childIsAdopted,
  childText,
  collectForeignStructureIssues,
  direct,
  errorMessage,
  exactlyOne,
  identityXmlEqual,
  inMetadataNamespace,
  metadataChildName,
  metadataRoot,
  physicalChildMapsTo,
  rootKey,
  same,
  sameGeneratedTypes,
  singleDirect,
} from './adoptedDesignerMetadataXml';

export type { AdoptedDesignerTypeIdReferenceDescriptor } from './adoptedDesignerTypeId';
export type { AdoptedDesignerOwnFormRegistrations } from './adoptedDesignerFormRegistrations';

export interface AdoptedDesignerIdentity {
  readonly ownership: 'own' | 'adopted';
  readonly type: string;
  readonly name: string;
  readonly uuid: string;
  /** For adopted objects, the UUID in the proven own base. */
  readonly sourceUuid?: string;
}

export type AdoptedDesignerDirection = 'adopted-to-cf' | 'cf-to-adopted' | 'adopted-to-adopted';

export interface AdoptedDesignerProjectionIssue {
  readonly side: 'target' | 'source';
  readonly identityKey: string;
  readonly propertyName?: string;
  readonly reason: string;
  readonly orderOnly?: boolean;
  readonly orderScopePointer?: string;
  readonly orderElementKind?: string;
}

export interface AdoptedDesignerProjectionInput {
  readonly direction: AdoptedDesignerDirection;
  readonly targetXml: Buffer;
  readonly sourceXml: Buffer;
  readonly baseXml: Buffer;
  readonly targetIdentity: AdoptedDesignerIdentity;
  readonly sourceIdentity: AdoptedDesignerIdentity;
  readonly baseIdentity: AdoptedDesignerIdentity;
  readonly formatVersion: string;
  /** Local UUIDs preallocated once by the host for new CFE child overlays. */
  readonly adoptedChildUuidByAnchor?: ReadonlyMap<string, string>;
  /** Captured own/base metadata descriptors needed to normalize native ExtendedProperty TypeIds. */
  readonly typeIdReferenceDescriptors?: readonly AdoptedDesignerTypeIdReferenceDescriptor[];
  /** Host-validated own Form package registrations outside the captured base. */
  readonly ownFormRegistrations?: AdoptedDesignerOwnFormRegistrations;
}

export type AdoptedDesignerProjectionResult =
  | {
    readonly ok: true;
    readonly targetXml: Buffer;
    readonly sourceXml: Buffer;
    readonly issues: readonly AdoptedDesignerProjectionIssue[];
    readonly usedDescriptorWitnesses: readonly MergeFileWitness[];
  }
  | { readonly ok: false; readonly reason: string };

export interface AdoptedDesignerMaterializationInput extends AdoptedDesignerProjectionInput {
  readonly mergedLogicalTarget: Buffer;
}

export type AdoptedDesignerMaterializationResult =
  | { readonly ok: true; readonly content: Buffer; readonly issues: readonly AdoptedDesignerProjectionIssue[]; readonly usedDescriptorWitnesses: readonly MergeFileWitness[] }
  | { readonly ok: false; readonly reason: string };

const OWNERSHIP_MARKERS = new Set(['ObjectBelonging', 'ExtendedConfigurationObject']);
const PROPERTY_STATES = new Set(['Notify', 'MultiState', 'Extended']);
const LINKED_PROPERTIES = new Set(['Module', 'ObjectModule', 'ManagerModule', 'RecordSetModule', 'ValueManagerModule']);
const SUPPORTED_FORMATS = new Set(['2.17', '2.18', '2.19', '2.20', '2.21']);
const MDCLASSES_NAMESPACE = 'http://v8.1c.ru/8.3/MDClasses';

export function isSupportedAdoptedDesignerDirection(value: unknown): value is AdoptedDesignerDirection {
  return value === 'adopted-to-cf' || value === 'cf-to-adopted' || value === 'adopted-to-adopted';
}

/** Creates logical own descriptors from captured CF/CFE artifacts over one exact own base. */
export function projectAdoptedDesignerPair(input: AdoptedDesignerProjectionInput): AdoptedDesignerProjectionResult {
  try {
    assertProjectionContract(input);
    const target = parseDescriptor(input.targetXml, input.formatVersion, input.targetIdentity);
    const source = parseDescriptor(input.sourceXml, input.formatVersion, input.sourceIdentity);
    const base = parseDescriptor(input.baseXml, input.formatVersion, input.baseIdentity);
    const targetFormNames = ownFormRegistrationNames(input.ownFormRegistrations, 'target');
    const sourceFormNames = ownFormRegistrationNames(input.ownFormRegistrations, 'source');
    const baseForms = collectBaseFormRegistrations(metadataRoot(base, input.baseIdentity.type));
    if (!baseForms.ok) { return baseForms; }
    const targetIsAdopted = input.direction !== 'adopted-to-cf';
    const sourceIsAdopted = input.direction !== 'cf-to-adopted';
    const issues: AdoptedDesignerProjectionIssue[] = [];
    const typeIdResolver = createAdoptedDesignerTypeIdResolver(input.formatVersion, input.typeIdReferenceDescriptors);
    collectForeignStructureIssues(target, input.targetIdentity, 'target', issues);
    collectForeignStructureIssues(source, input.sourceIdentity, 'source', issues);
    const logicalTarget = targetIsAdopted
      ? projectAdoptedDocument(target, base, input.targetIdentity, 'target', input.formatVersion, issues, typeIdResolver, baseForms.registrations, targetFormNames)
      : projectOwnDocument(target, input.targetIdentity, 'target', issues, baseForms.registrations, targetFormNames);
    const logicalSource = sourceIsAdopted
      ? projectAdoptedDocument(source, base, input.sourceIdentity, 'source', input.formatVersion, issues, typeIdResolver, baseForms.registrations, sourceFormNames)
      : projectOwnDocument(source, input.sourceIdentity, 'source', issues, baseForms.registrations, sourceFormNames);
    return {
      ok: true,
      targetXml: Buffer.from(serializeXmlDocument(logicalTarget), 'utf8'),
      sourceXml: Buffer.from(serializeXmlDocument(logicalSource), 'utf8'),
      issues,
      usedDescriptorWitnesses: typeIdResolver.usedDescriptorWitnesses(),
    };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

/** Lists target-CFE local UUIDs the host must preallocate before a selected child edit can be materialized. */
export function collectAdoptedDesignerChildUuidRequirements(
  input: AdoptedDesignerProjectionInput,
): AdoptedDesignerChildUuidRequirementsResult {
  try {
    assertProjectionContract(input);
    if (input.direction === 'adopted-to-cf') { return { ok: true, requirements: [] }; }
    const target = parseDescriptor(input.targetXml, input.formatVersion, input.targetIdentity);
    const base = parseDescriptor(input.baseXml, input.formatVersion, input.baseIdentity);
    const requirements: AdoptedDesignerChildUuidRequirement[] = [];
    const seen = new Set<string>();
    collectMissingAdoptedDesignerChildUuids(
      metadataRoot(base, input.baseIdentity.type),
      metadataRoot(target, input.targetIdentity.type),
      rootKey(input.targetIdentity),
      requirements,
      seen,
    );
    return { ok: true, requirements };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

/** Encodes selected logical descriptor edits into the actual target ownership shape. */
export function materializeAdoptedDesignerTarget(
  input: AdoptedDesignerMaterializationInput,
): AdoptedDesignerMaterializationResult {
  const projection = projectAdoptedDesignerPair(input);
  if (!projection.ok) { return projection; }
  try {
    const targetIsAdopted = input.direction !== 'adopted-to-cf';
    const targetIdentity = input.targetIdentity;
    const merged = parseXmlDocument(input.mergedLogicalTarget.toString('utf8'));
    const mergedRoot = metadataRoot(merged, targetIdentity.type);
    assertLogicalIdentity(mergedRoot, input.baseIdentity);
    if (!targetIsAdopted) {
      const original = parseDescriptor(input.targetXml, input.formatVersion, targetIdentity);
      const initialLogical = parseDescriptor(projection.targetXml, input.formatVersion, targetIdentity);
      const base = parseDescriptor(input.baseXml, input.formatVersion, input.baseIdentity);
      const physicalFormCheck = { ...original, root: cloneXmlElement(original.root) };
      const formError = encodeOwnFormRegistrations({
        physicalRoot: metadataRoot(physicalFormCheck, targetIdentity.type),
        baseRoot: metadataRoot(base, input.baseIdentity.type),
        initialRoot: metadataRoot(initialLogical, targetIdentity.type),
        selectedRoot: mergedRoot,
        sourceAllowedNames: ownFormRegistrationNames(input.ownFormRegistrations, 'source'),
        targetOwnership: targetIdentity.ownership,
      });
      if (formError) { return { ok: false, reason: formError }; }
      preserveMetadataIdentity(original, merged, input.targetIdentity.type);
      stripOwnershipMarkersFromPromotedNodes(mergedRoot);
      return {
        ok: true,
        content: Buffer.from(serializeXmlDocument(merged), 'utf8'),
        issues: projection.issues,
        usedDescriptorWitnesses: projection.usedDescriptorWitnesses,
      };
    }

    const base = parseDescriptor(input.baseXml, input.formatVersion, input.baseIdentity);
    const physical = parseDescriptor(input.targetXml, input.formatVersion, targetIdentity);
    const initialLogical = parseDescriptor(projection.targetXml, input.formatVersion, {
      ...targetIdentity, ownership: 'own', uuid: input.baseIdentity.uuid, sourceUuid: undefined,
    });
    const mergedIdentityError = assertCompatibleLogicalTarget(initialLogical, merged, input.baseIdentity);
    if (mergedIdentityError) { return { ok: false, reason: mergedIdentityError }; }
    const issues = [...projection.issues];
    const physicalRoot = metadataRoot(physical, targetIdentity.type);
    const baseRoot = metadataRoot(base, input.baseIdentity.type);
    const initialRoot = metadataRoot(initialLogical, targetIdentity.type);
    const selectedRoot = metadataRoot(merged, targetIdentity.type);
    const targetChildUuids = new Set([targetIdentity.uuid, ...allMetadataChildren(physicalRoot)
      .map((child) => attribute(child, 'uuid')).filter((uuid): uuid is string => Boolean(uuid))]
      .map(normalizeAdoptedIdentity));
    const encodeError = encodeAdoptedRoot({
      physicalRoot,
      baseRoot,
      initialRoot,
      selectedRoot,
      side: 'target',
      issues,
      adoptedChildUuidByAnchor: input.adoptedChildUuidByAnchor,
      sourceAllowedFormNames: ownFormRegistrationNames(input.ownFormRegistrations, 'source'),
      targetChildUuids,
      ownerScope: rootKey(targetIdentity),
    });
    if (encodeError) { return { ok: false, reason: encodeError }; }
    preserveRootIdentity(physicalRoot, targetIdentity, targetIdentity.type);
    const content = Buffer.from(serializeXmlDocument(physical), 'utf8');
    const roundTripRegistrations = input.ownFormRegistrations === undefined
      ? undefined
      : {
        target: [...ownFormRegistrationNames(input.ownFormRegistrations, 'target'), ...selectedNewFormRegistrationNames(initialRoot, selectedRoot)],
        source: [...ownFormRegistrationNames(input.ownFormRegistrations, 'source')],
      };
    const roundTrip = projectAdoptedDesignerPair({
      ...input,
      targetXml: content,
      ...(roundTripRegistrations ? { ownFormRegistrations: roundTripRegistrations } : {}),
    });
    if (!roundTrip.ok) { return { ok: false, reason: `Материализованный target нельзя повторно спроецировать: ${roundTrip.reason}` }; }
    const roundTripDocument = parseXmlDocument(roundTrip.targetXml.toString('utf8'));
    if (!sameElement(metadataRoot(roundTripDocument, targetIdentity.type), mergedRoot)) {
      return { ok: false, reason: 'Материализованный adopted target после повторной projection не совпадает с выбранным logical target.' };
    }
    return { ok: true, content, issues, usedDescriptorWitnesses: projection.usedDescriptorWitnesses };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

function assertProjectionContract(input: AdoptedDesignerProjectionInput): void {
  if (!isSupportedAdoptedDesignerDirection(input.direction)) { throw new Error('Направление adopted projection не поддерживается.'); }
  if (!SUPPORTED_FORMATS.has(input.formatVersion)) {
    throw new Error(`Формат Designer ${input.formatVersion} не поддержан adopted projection.`);
  }
  if (input.baseIdentity.ownership !== 'own') {
    throw new Error('Базовая identity должна принадлежать собственному объекту CF.');
  }
  const targetAdopted = input.direction !== 'adopted-to-cf';
  const sourceAdopted = input.direction !== 'cf-to-adopted';
  if (input.targetIdentity.ownership !== (targetAdopted ? 'adopted' : 'own')
    || input.sourceIdentity.ownership !== (sourceAdopted ? 'adopted' : 'own')) {
    throw new Error('Направление переноса не совпадает с ownership target/source.');
  }
  const identities = [input.targetIdentity, input.sourceIdentity];
  ownFormRegistrationNames(input.ownFormRegistrations, 'target');
  ownFormRegistrationNames(input.ownFormRegistrations, 'source');
  if (identities.some((identity) => !same(identity.type, input.baseIdentity.type) || !same(identity.name, input.baseIdentity.name))
    || (targetAdopted && !same(input.targetIdentity.sourceUuid, input.baseIdentity.uuid))
    || (sourceAdopted && !same(input.sourceIdentity.sourceUuid, input.baseIdentity.uuid))
    || (!targetAdopted && !same(input.targetIdentity.uuid, input.baseIdentity.uuid))
    || (!sourceAdopted && !same(input.sourceIdentity.uuid, input.baseIdentity.uuid))) {
    throw new Error('Identity target/source не совпадают с точным собственным base anchor.');
  }
}

function parseDescriptor(xml: Buffer, formatVersion: string, identity: AdoptedDesignerIdentity): XmlDocument {
  const document = parseXmlDocument(xml.toString('utf8'));
  const meta = document.root;
  if (meta.localName !== 'MetaDataObject' || !inMetadataNamespace(meta)) { throw new Error('Descriptor должен иметь корень MetaDataObject в namespace MDClasses.'); }
  if (attribute(meta, 'version') !== formatVersion) { throw new Error('Версия descriptor не совпадает с подтверждённой версией Designer.'); }
  const root = metadataRoot(document, identity.type);
  const uuid = attribute(root, 'uuid');
  const properties = exactlyOne(root, 'Properties', 'В descriptor должен быть единственный Properties.');
  const name = childText(properties, 'Name');
  if (!same(uuid, identity.uuid) || !same(name, identity.name)) {
    throw new Error('Identity descriptor не совпадает с подтверждённой мета-информацией.');
  }
  const belonging = childText(properties, 'ObjectBelonging');
  const sourceUuid = childText(properties, 'ExtendedConfigurationObject');
  if (identity.ownership === 'own') {
    if (belonging !== undefined || sourceUuid !== undefined) { throw new Error('Собственный descriptor содержит adopted ownership markers.'); }
  } else if (belonging !== 'Adopted' || !same(sourceUuid, identity.sourceUuid)) {
    throw new Error('Adopted descriptor не содержит ожидаемые ObjectBelonging/ExtendedConfigurationObject anchors.');
  }
  return document;
}

function projectAdoptedDocument(
  adopted: XmlDocument,
  base: XmlDocument,
  identity: AdoptedDesignerIdentity,
  side: 'target' | 'source',
  formatVersion: string,
  issues: AdoptedDesignerProjectionIssue[],
  typeIdResolver: ReturnType<typeof createAdoptedDesignerTypeIdResolver>,
  baseFormRegistrations: readonly FormRegistrationRecord[],
  allowedFormNames: readonly string[],
): XmlDocument {
  const result = { ...base, root: cloneXmlElement(base.root) };
  const baseRoot = metadataRoot(result, identity.type);
  const adoptedRoot = metadataRoot(adopted, identity.type);
  const baseProperties = exactlyOne(baseRoot, 'Properties', 'В base descriptor отсутствует единственный Properties.');
  const adoptedProperties = exactlyOne(adoptedRoot, 'Properties', 'В adopted descriptor отсутствует единственный Properties.');
  projectAdoptedProperties({
    target: baseProperties,
    overlay: adoptedProperties,
    states: stateMap(adoptedRoot, side, rootKey(identity), issues),
    side,
    ownerKey: rootKey(identity),
    formatVersion,
    issues,
    typeIdResolver,
  });
  const formError = projectOwnFormRegistrations({
    physicalRoot: adoptedRoot,
    logicalRoot: baseRoot,
    baseRegistrations: baseFormRegistrations,
    allowedNames: allowedFormNames,
    ownership: identity.ownership,
    side,
    ownerKey: rootKey(identity),
    issues,
  });
  if (formError) { throw new Error(formError); }
  projectAdoptedDesignerChildren({
    adoptedParent: adoptedRoot,
    logicalParent: baseRoot,
    baseOrderParent: metadataRoot(base, identity.type),
    side,
    formatVersion,
    issues,
    parentKey: rootKey(identity),
    typeIdResolver,
    stateMap,
  });
  // The materialized logical view always carries base UUID and GeneratedType identities.
  return result;
}

function projectOwnDocument(
  physical: XmlDocument,
  identity: AdoptedDesignerIdentity,
  side: 'target' | 'source',
  issues: AdoptedDesignerProjectionIssue[],
  baseFormRegistrations: readonly FormRegistrationRecord[],
  allowedFormNames: readonly string[],
): XmlDocument {
  const result = { ...physical, root: cloneXmlElement(physical.root) };
  const formError = projectOwnFormRegistrations({
    physicalRoot: metadataRoot(physical, identity.type),
    logicalRoot: metadataRoot(result, identity.type),
    baseRegistrations: baseFormRegistrations,
    allowedNames: allowedFormNames,
    ownership: identity.ownership,
    side,
    ownerKey: rootKey(identity),
    issues,
  });
  if (formError) { throw new Error(formError); }
  return result;
}

function encodeAdoptedRoot(input: {
  physicalRoot: XmlElement;
  baseRoot: XmlElement;
  initialRoot: XmlElement;
  selectedRoot: XmlElement;
  side: 'target';
  issues: AdoptedDesignerProjectionIssue[];
  adoptedChildUuidByAnchor?: ReadonlyMap<string, string>;
  sourceAllowedFormNames: readonly string[];
  targetChildUuids: Set<string>;
  ownerScope: string;
}): string | undefined {
  const physicalProperties = exactlyOne(input.physicalRoot, 'Properties', 'Целевой adopted descriptor отсутствует Properties.');
  const baseProperties = exactlyOne(input.baseRoot, 'Properties', 'В base descriptor отсутствует Properties.');
  const initialProperties = exactlyOne(input.initialRoot, 'Properties', 'В логическом target отсутствует Properties.');
  const selectedProperties = exactlyOne(input.selectedRoot, 'Properties', 'В результате merge отсутствует Properties.');
  const selectedNames = new Set([...elementChildren(initialProperties), ...elementChildren(selectedProperties)].map(({ localName: name }) => name));
  const states = stateMap(input.physicalRoot);
  for (const property of selectedNames) {
    if (OWNERSHIP_MARKERS.has(property) || property === 'Name') { continue; }
    const before = singleDirect(initialProperties, property);
    const after = singleDirect(selectedProperties, property);
    if (before.duplicate || after.duplicate) { return `Невозможно кодировать повторяющееся свойство ${property}.`; }
    if (sameElement(before.node, after.node)) { continue; }
    const baseNode = singleDirect(baseProperties, property);
    const physicalNode = singleDirect(physicalProperties, property);
    if (baseNode.duplicate || physicalNode.duplicate) { return `Невозможно кодировать повторяющееся свойство ${property} в adopted target.`; }
    if (states.get(property) === INVALID_PROPERTY_STATE || states.get('*') === INVALID_PROPERTY_STATE) {
      return `PropertyState для ${property} malformed or ambiguous in adopted target.`;
    }
    if (LINKED_PROPERTIES.has(property) || states.get(property) === 'Extended') {
      return `Свойство ${property} связано с sidecar и должно кодироваться linked-artifact orchestration.`;
    }
    if (sameElement(baseNode.node, after.node)) {
      if (physicalNode.node) { remove(physicalProperties, physicalNode.node); }
      removePropertyState(input.physicalRoot, property);
      continue;
    }
    if (!after.node) { return `Удаление свойства ${property} невозможно представить adopted overlay.`; }
    replaceOrAppendMetadata(physicalProperties, cloneWithNamespaces(after.node));
    setPropertyState(input.physicalRoot, property, 'Notify');
  }
  const childError = encodeChildObjects(input);
  return childError;
}

function encodeChildObjects(input: {
  physicalRoot: XmlElement;
  baseRoot: XmlElement;
  initialRoot: XmlElement;
  selectedRoot: XmlElement;
  side: 'target';
  issues: AdoptedDesignerProjectionIssue[];
  adoptedChildUuidByAnchor?: ReadonlyMap<string, string>;
  sourceAllowedFormNames: readonly string[];
  targetChildUuids: Set<string>;
  ownerScope: string;
}): string | undefined {
  const formError = encodeOwnFormRegistrations({
    physicalRoot: input.physicalRoot,
    baseRoot: input.baseRoot,
    initialRoot: input.initialRoot,
    selectedRoot: input.selectedRoot,
    sourceAllowedNames: input.sourceAllowedFormNames,
    targetOwnership: 'adopted',
  });
  if (formError) { return formError; }
  const orderError = encodeAdoptedMetadataOrder({
    baseParent: input.baseRoot,
    physicalParent: input.physicalRoot,
    initialParent: input.initialRoot,
    selectedParent: input.selectedRoot,
    ownerScope: input.ownerScope,
    adoptedChildUuidByAnchor: input.adoptedChildUuidByAnchor,
    targetChildUuids: input.targetChildUuids,
    issues: input.issues,
  });
  if (orderError) { return orderError; }
  const physicalContainer = direct(input.physicalRoot, 'ChildObjects')[0];
  const baseContainer = direct(input.baseRoot, 'ChildObjects')[0];
  const initialContainer = direct(input.initialRoot, 'ChildObjects')[0];
  const selectedContainer = direct(input.selectedRoot, 'ChildObjects')[0];
  const isInlineChild = (child: XmlElement) => child.localName !== 'Form';
  if (!baseContainer && selectedContainer && elementChildren(selectedContainer).some(isInlineChild)) {
    return 'Target base descriptor lacks ChildObjects required to encode selected child edits.';
  }
  if (!physicalContainer) {
    if (selectedContainer && elementChildren(selectedContainer).some(isInlineChild)) {
      return 'Target adopted descriptor lacks ChildObjects required to encode selected child edits.';
    }
    return undefined;
  }
  const baseChildren = (baseContainer ? elementChildren(baseContainer) : []).filter(isInlineChild);
  const beforeChildren = (initialContainer ? elementChildren(initialContainer) : []).filter(isInlineChild);
  const selectedChildren = (selectedContainer ? elementChildren(selectedContainer) : []).filter(isInlineChild);
  const physicalChildren = elementChildren(physicalContainer).filter(isInlineChild);
  const ids = new Set<string>();
  for (const child of baseChildren) {
    const uuid = attribute(child, 'uuid');
    if (uuid) { ids.add(uuid.toLowerCase()); }
  }
  const allKeys = new Set([...beforeChildren, ...selectedChildren].map((child) => childIdentity(child)));
  for (const key of allKeys) {
    const before = beforeChildren.find((child) => childIdentity(child) === key);
    const selected = selectedChildren.find((child) => childIdentity(child) === key);
    if (sameElement(before, selected)) { continue; }
    const base = baseChildren.find((child) => childIdentity(child) === key);
    const physical = physicalChildren.find((child) => physicalChildMapsTo(child, base));
    if (base) {
      if (!selected) {
        return `Удаление унаследованного child ${key} невозможно выразить adopted overlay.`;
      }
      let encoded: XmlElement;
      if (!physical) {
        if (sameElement(base, selected)) { continue; }
        const allocated = allocateAdoptedChildUuid(input, input.ownerScope, base);
        if (!allocated.ok) { return allocated.reason; }
        encoded = createNewAdoptedChildOverlay(base, allocated.uuid);
        setAdoptedChildOwnership(encoded, base, encoded);
      } else {
        if (!childIsAdopted(physical)) { return `Child ${key} с CF anchor не имеет корректного ObjectBelonging=Adopted в target CFE.`; }
        encoded = cloneWithNamespaces(physical);
        setAdoptedChildOwnership(encoded, base, physical);
      }
      const baseProperties = direct(base, 'Properties')[0];
      const selectedProperties = direct(selected, 'Properties')[0];
      const encodedProperties = direct(encoded, 'Properties')[0];
      if (!baseProperties || !selectedProperties || !encodedProperties) { return `Child ${key} lacks Properties.`; }
      const propertyError = encodeProperties(encoded, baseProperties, direct(before ?? base, 'Properties')[0] ?? baseProperties, selectedProperties, encodedProperties);
      if (propertyError) { return propertyError; }
      if (!physical) { ensureAdoptedChildComment(encodedProperties, baseProperties); }
      const nestedError = encodeNestedChildChanges(encoded, base, before ?? base, selected, `uuid=${attribute(base, 'uuid') ?? ''}`, input);
      if (nestedError) { return nestedError; }
      if (physical) { replace(physicalContainer, physical, encoded); }
      else { attach(physicalContainer, encoded); }
      continue;
    }
    if (physical && !childIsAdopted(physical)) {
      if (!selected) { remove(physicalContainer, physical); }
      else { replace(physicalContainer, physical, cloneWithNamespaces(selected)); }
      continue;
    }
    if (before) {
      // A logical child without a base anchor must be a CFE-owned child.
      if (selected && !physical) { attach(physicalContainer, cloneWithNamespaces(selected)); }
      continue;
    }
    if (selected) {
      const uuid = attribute(selected, 'uuid');
      if (uuid && ids.has(uuid.toLowerCase())) { return `Собственный child UUID ${uuid} конфликтует с UUID базового child.`; }
      const name = childText(direct(selected, 'Properties')[0] ?? selected, 'Name');
      if (name && physicalChildren.some((candidate) => candidate.localName === selected.localName
        && same(childText(direct(candidate, 'Properties')[0] ?? candidate, 'Name'), name))) {
        return `Собственный child ${selected.localName}.${name} конфликтует по имени в целевом реестре.`;
      }
      attach(physicalContainer, cloneWithNamespaces(selected));
    }
  }
  return undefined;
}

function encodeNestedChildChanges(
  physical: XmlElement,
  base: XmlElement,
  before: XmlElement,
  selected: XmlElement,
  ownerScope: string,
  allocation: {
    adoptedChildUuidByAnchor?: ReadonlyMap<string, string>;
    targetChildUuids: Set<string>;
    issues: AdoptedDesignerProjectionIssue[];
  },
): string | undefined {
  const baseContainers = direct(base, 'ChildObjects');
  const beforeContainers = direct(before, 'ChildObjects');
  const selectedContainers = direct(selected, 'ChildObjects');
  const physicalContainers = direct(physical, 'ChildObjects');
  if (baseContainers.length > 1 || beforeContainers.length > 1 || selectedContainers.length > 1 || physicalContainers.length > 1) {
    return 'Повторный nested ChildObjects нельзя безопасно кодировать в adopted overlay.';
  }
  const baseNested = baseContainers[0];
  const beforeNested = beforeContainers[0];
  const selectedNested = selectedContainers[0];
  const orderChanged = Boolean(beforeNested && selectedNested
    && hasAdoptedMetadataOrderChange(beforeNested, selectedNested));
  if (!baseNested && !beforeNested && !selectedNested) { return undefined; }
  if (baseNested && !selectedNested && elementChildren(baseNested).some((child) => inMetadataNamespace(child))) {
    return 'Удаление унаследованного nested ChildObjects невозможно представить в adopted overlay.';
  }
  const baseChildren = baseNested ? elementChildren(baseNested).filter(inMetadataNamespace) : [];
  const beforeChildren = beforeNested ? elementChildren(beforeNested).filter(inMetadataNamespace) : baseChildren;
  const selectedChildren = selectedNested ? elementChildren(selectedNested).filter(inMetadataNamespace) : [];
  const physicalChildren = physicalContainers[0] ? elementChildren(physicalContainers[0]).filter(inMetadataNamespace) : [];
  const baseByKey = indexNestedChildren(baseChildren, 'base');
  const beforeByKey = indexNestedChildren(beforeChildren, 'initial logical target');
  const selectedByKey = indexNestedChildren(selectedChildren, 'selected logical target');
  const physicalOwnByKey = new Map<string, XmlElement>();
  for (const child of physicalChildren) {
    if (childIsAdopted(child) || childText(direct(child, 'Properties')[0] ?? child, 'ExtendedConfigurationObject') !== undefined) { continue; }
    const key = childIdentity(child);
    if (physicalOwnByKey.has(key)) { return `Nested own child identity ${key} repeats in the physical overlay.`; }
    physicalOwnByKey.set(key, child);
  }
  const inheritedChanged = baseChildren.some((baseChild) => {
    const key = childIdentity(baseChild);
    const beforeChild = beforeByKey.get(key) ?? baseChild;
    return !sameElement(beforeChild, selectedByKey.get(key));
  });
  const ownKeys = new Set([...beforeByKey.keys(), ...selectedByKey.keys()]);
  const ownChanged = [...ownKeys].some((key) => !baseByKey.has(key)
    && !sameElement(beforeByKey.get(key), selectedByKey.get(key)));
  let physicalNested = physicalContainers[0];
  const requiresNestedWrite = inheritedChanged || ownChanged || orderChanged;
  if (!physicalNested && requiresNestedWrite) {
    const prefix = prefixForNamespace(physical, MDCLASSES_NAMESPACE, 'md');
    physicalNested = makeElement(`${prefix}:ChildObjects`);
    attach(physical, physicalNested);
  }
  if (!physicalNested) { return undefined; }
  const orderError = encodeAdoptedMetadataOrder({
    baseParent: base,
    physicalParent: physical,
    initialParent: before,
    selectedParent: selected,
    ownerScope,
    adoptedChildUuidByAnchor: allocation.adoptedChildUuidByAnchor,
    targetChildUuids: allocation.targetChildUuids,
    issues: allocation.issues,
  });
  if (orderError) { return orderError; }
  for (const baseChild of baseChildren) {
    const key = childIdentity(baseChild);
    const beforeChild = beforeByKey.get(key) ?? baseChild;
    const selectedChild = selectedByKey.get(key);
    if (sameElement(beforeChild, selectedChild)) { continue; }
    if (!selectedChild) { return `Удаление вложенного унаследованного child ${key} невозможно выразить.`; }
    const overlay = elementChildren(physicalNested).find((candidate) => physicalChildMapsTo(candidate, baseChild));
    if (!overlay && sameElement(baseChild, selectedChild)) { continue; }
    let encoded: XmlElement;
    if (!overlay) {
      const allocated = allocateAdoptedChildUuid(allocation, ownerScope, baseChild);
      if (!allocated.ok) { return allocated.reason; }
      encoded = createNewAdoptedChildOverlay(baseChild, allocated.uuid);
      setAdoptedChildOwnership(encoded, baseChild, encoded);
    } else {
      if (!childIsAdopted(overlay)) { return `Nested child ${key} с CF anchor не имеет корректного ObjectBelonging=Adopted в target CFE.`; }
      encoded = cloneWithNamespaces(overlay);
      setAdoptedChildOwnership(encoded, baseChild, overlay);
    }
    const baseProperties = direct(baseChild, 'Properties')[0];
    const selectedProperties = direct(selectedChild, 'Properties')[0];
    const encodedProperties = direct(encoded, 'Properties')[0];
    if (!baseProperties || !selectedProperties || !encodedProperties) { return `Nested child ${key} lacks Properties.`; }
    const propertyError = encodeProperties(encoded, baseProperties, direct(beforeChild, 'Properties')[0] ?? baseProperties, selectedProperties, encodedProperties);
    if (propertyError) { return propertyError; }
    if (!overlay) { ensureAdoptedChildComment(encodedProperties, baseProperties); }
    const nestedError = encodeNestedChildChanges(
      encoded,
      baseChild,
      beforeChild,
      selectedChild,
      `uuid=${attribute(baseChild, 'uuid') ?? ''}`,
      allocation,
    );
    if (nestedError) { return nestedError; }
    if (overlay) { replace(physicalNested, overlay, encoded); }
    else { attach(physicalNested, encoded); }
  }
  const physicalOwnedChildren = elementChildren(physicalNested).filter((child) => inMetadataNamespace(child)
    && !childIsAdopted(child)
    && childText(direct(child, 'Properties')[0] ?? child, 'ExtendedConfigurationObject') === undefined);
  const baseUuids = new Set([attribute(base, 'uuid'), ...allMetadataChildren(base).map((child) => attribute(child, 'uuid'))]
    .filter((uuid): uuid is string => Boolean(uuid)).map(normalizeAdoptedIdentity));
  const nestedOwnKeys = new Set([...beforeByKey.keys(), ...selectedByKey.keys()]);
  for (const key of nestedOwnKeys) {
    if (baseByKey.has(key)) { continue; }
    const beforeChild = beforeByKey.get(key);
    const selectedChild = selectedByKey.get(key);
    if (sameElement(beforeChild, selectedChild)) { continue; }
    const physicalChild = physicalOwnByKey.get(key);
    if (!selectedChild) {
      if (physicalChild) { remove(physicalNested, physicalChild); }
      continue;
    }
    if (beforeChild) {
      if (physicalChild && sameElement(physicalChild, selectedChild)) { continue; }
      return `Изменение существующего собственного nested child ${key} требует отдельного property-aware кодирования.`;
    }
    if (physicalChild) {
      if (sameElement(physicalChild, selectedChild)) { continue; }
      return `Новый nested own child ${key} конфликтует с физическим child target.`;
    }
    const properties = direct(selectedChild, 'Properties');
    const uuid = attribute(selectedChild, 'uuid');
    const name = properties.length === 1 ? childText(properties[0]!, 'Name') : undefined;
    if (!uuid || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu.test(uuid) || !name) {
      return `Новый nested own child ${key} требует корректные UUID, Properties и Name.`;
    }
    if (childText(properties[0]!, 'ObjectBelonging') !== undefined
      || childText(properties[0]!, 'ExtendedConfigurationObject') !== undefined) {
      return `Новый nested child ${key} содержит adopted markers без точного base anchor.`;
    }
    const normalizedUuid = normalizeAdoptedIdentity(uuid);
    if (allocation.targetChildUuids.has(normalizedUuid) || baseUuids.has(normalizedUuid)) {
      return `UUID нового nested own child ${uuid} конфликтует с уже зарегистрированным target/base child.`;
    }
    const nameCollision = [...baseChildren, ...physicalOwnedChildren, ...selectedChildren].some((candidate) => {
      if (candidate === selectedChild || childIdentity(candidate) === key || candidate.localName !== selectedChild.localName) { return false; }
      return same(metadataChildName(candidate), name);
    });
    if (nameCollision) { return `Имя нового nested own child ${selectedChild.localName}.${name} конфликтует с уже зарегистрированным child.`; }
    attach(physicalNested, cloneWithNamespaces(selectedChild));
    allocation.targetChildUuids.add(normalizedUuid);
  }
  return undefined;
}

function indexNestedChildren(children: readonly XmlElement[], label: string): Map<string, XmlElement> {
  const result = new Map<string, XmlElement>();
  for (const child of children) {
    const key = childIdentity(child);
    if (result.has(key)) { throw new Error(`Nested child identity ${key} repeats in ${label}.`); }
    result.set(key, child);
  }
  return result;
}

function encodeProperties(owner: XmlElement, base: XmlElement, before: XmlElement, selected: XmlElement, physical: XmlElement): string | undefined {
  const names = new Set([...elementChildren(before), ...elementChildren(selected)].map(({ localName: name }) => name));
  const states = stateMap(owner);
  for (const name of names) {
    if (OWNERSHIP_MARKERS.has(name) || name === 'Name') { continue; }
    const previous = singleDirect(before, name);
    const baseValue = singleDirect(base, name);
    const after = singleDirect(selected, name);
    const current = singleDirect(physical, name);
    if (previous.duplicate || baseValue.duplicate || after.duplicate || current.duplicate) { return `Свойство ${name} повторяется и не может быть записано в adopted overlay.`; }
    if (sameElement(previous.node, after.node)) { continue; }
    if (states.get(name) === INVALID_PROPERTY_STATE || states.get('*') === INVALID_PROPERTY_STATE) {
      return `PropertyState для ${name} malformed or ambiguous in adopted child.`;
    }
    if (sameElement(baseValue.node, after.node)) {
      if (current.node) { remove(physical, current.node); }
      removePropertyState(owner, name);
      continue;
    }
    if (LINKED_PROPERTIES.has(name) || states.get(name) === 'Extended') {
      return `Изменение ${name} требует согласованного linked artifact.`;
    }
    if (!after.node) { return `Удаление свойства ${name} невозможно выразить в adopted overlay.`; }
    replaceOrAppendMetadata(physical, cloneWithNamespaces(after.node));
    setPropertyState(owner, name, 'Notify');
  }
  return undefined;
}

const INVALID_PROPERTY_STATE = '\u0000invalid';

function stateMap(
  owner: XmlElement,
  side?: 'target' | 'source',
  ownerKey?: string,
  issues?: AdoptedDesignerProjectionIssue[],
): Map<string, string> {
  const result = new Map<string, string>();
  const internalInfos = direct(owner, 'InternalInfo');
  if (internalInfos.length > 1) {
    result.set('*', INVALID_PROPERTY_STATE);
    report(undefined, 'InternalInfo repeats; PropertyState values are ambiguous.');
    return result;
  }
  const internalInfo = internalInfos[0];
  if (!internalInfo) { return result; }
  for (const propertyState of direct(internalInfo, 'PropertyState')) {
    const property = childText(propertyState, 'Property');
    const state = childText(propertyState, 'State');
    if (!property || !state || !PROPERTY_STATES.has(state) || result.has(property)) {
      if (property) { result.set(property, INVALID_PROPERTY_STATE); }
      const reason = property && result.has(property) && result.get(property) === INVALID_PROPERTY_STATE && state && PROPERTY_STATES.has(state)
        ? `Several PropertyState records exist for ${property}.`
        : `PropertyState record is malformed or has an unknown state${state ? `=${state}` : ''}.`;
      report(property, reason);
      continue;
    }
    result.set(property, state);
  }
  return result;

  function report(property: string | undefined, reason: string): void {
    if (side && ownerKey && issues) { addIssue(issues, side, ownerKey, property, reason); }
  }
}

function setPropertyState(owner: XmlElement, property: string, state: string): void {
  const internalInfos = direct(owner, 'InternalInfo');
  if (internalInfos.length > 1) { throw new Error('Выбранное свойство нельзя записать: в adopted-объекте несколько элементов MD InternalInfo.'); }
  const internalInfo = internalInfos[0] ?? createInternalInfoBeforeProperties(owner);
  removePropertyState(owner, property);
  const statePrefix = safePrefixForNamespace(internalInfo, 'http://v8.1c.ru/8.3/xcf/readable', 'xr');
  const entry = makeElement(`${statePrefix}:PropertyState`);
  attach(entry, makeTextElement(`${statePrefix}:Property`, property));
  attach(entry, makeTextElement(`${statePrefix}:State`, state));
  attach(internalInfo, entry);
}

function createInternalInfoBeforeProperties(owner: XmlElement): XmlElement {
  const properties = direct(owner, 'Properties');
  if (properties.length !== 1) { throw new Error('Нельзя создать MD InternalInfo без единственного элемента MD Properties.'); }
  const prefix = safePrefixForNamespace(owner, MDCLASSES_NAMESPACE, 'md');
  const internalInfo = makeElement(`${prefix}:InternalInfo`);
  const index = owner.children.indexOf(properties[0]!);
  if (index < 0) { throw new Error('Не удалось вставить MD InternalInfo перед элементом Properties.'); }
  internalInfo.parent = owner;
  owner.children.splice(index, 0, internalInfo);
  return internalInfo;
}

function safePrefixForNamespace(element: XmlElement, uri: string, fallback: string): string {
  const declarations = new Map<string, string>();
  let current: XmlElement | undefined = element;
  while (current) {
    for (const attribute of current.attributes) {
      if (!attribute.name.startsWith('xmlns:')) { continue; }
      const prefix = attribute.name.slice('xmlns:'.length);
      if (!declarations.has(prefix)) { declarations.set(prefix, attribute.value); }
    }
    current = current.parent;
  }
  const existing = [...declarations].find(([, namespace]) => namespace === uri)?.[0];
  if (existing) { return existing; }
  let candidate = fallback;
  let suffix = 1;
  while (declarations.has(candidate)) { candidate = `${fallback}${suffix++}`; }
  return prefixForNamespace(element, uri, candidate);
}

function removePropertyState(owner: XmlElement, property: string): void {
  const internalInfos = direct(owner, 'InternalInfo');
  if (internalInfos.length > 1) { throw new Error('Cannot edit ambiguous InternalInfo PropertyState records.'); }
  const internalInfo = internalInfos[0];
  if (!internalInfo) { return; }
  for (const state of direct(internalInfo, 'PropertyState')) {
    if (childText(state, 'Property') === property) { remove(internalInfo, state); }
  }
}

function replaceOrAppendMetadata(parent: XmlElement, replacement: XmlElement): void {
  const existing = direct(parent, replacement.localName);
  if (existing.length > 1) { throw new Error(`Metadata XML contains duplicate ${replacement.localName} nodes.`); }
  if (existing[0]) { replace(parent, existing[0], replacement); }
  else { attach(parent, replacement); }
}

function stripOwnershipMarkersFromPromotedNodes(root: XmlElement): void {
  const properties = direct(root, 'Properties')[0];
  if (properties) {
    for (const marker of [...elementChildren(properties)]) {
      if (OWNERSHIP_MARKERS.has(marker.localName) && inMetadataNamespace(marker)) { remove(properties, marker); }
    }
  }
  for (const childObjects of direct(root, 'ChildObjects')) {
    for (const child of elementChildren(childObjects)) {
      const childProperties = direct(child, 'Properties')[0];
      if (childProperties) {
        for (const marker of [...elementChildren(childProperties)]) {
          if (OWNERSHIP_MARKERS.has(marker.localName) && inMetadataNamespace(marker)) { remove(childProperties, marker); }
        }
      }
      stripOwnershipMarkersFromPromotedNodes(child);
    }
  }
}

function preserveMetadataIdentity(original: XmlDocument, merged: XmlDocument, metadataType: string): void {
  const before = metadataRoot(original, metadataType);
  const after = metadataRoot(merged, metadataType);
  const uuid = attribute(before, 'uuid');
  if (!same(attribute(after, 'uuid'), uuid)) { throw new Error('Выбранный merge изменил target root UUID.'); }
  const beforeInfo = direct(before, 'InternalInfo')[0];
  const afterInfo = direct(after, 'InternalInfo')[0];
  if (beforeInfo && afterInfo && !identityXmlEqual(beforeInfo, afterInfo)) {
    // PropertyState belongs to the extension overlay and is stripped from the CF projection.
    throw new Error('Выбранный merge изменил target root InternalInfo/GeneratedType identity.');
  }
}

function assertCompatibleLogicalTarget(before: XmlDocument, merged: XmlDocument, identity: AdoptedDesignerIdentity): string | undefined {
  const beforeRoot = metadataRoot(before, identity.type);
  const afterRoot = metadataRoot(merged, identity.type);
  if (!same(attribute(afterRoot, 'uuid'), identity.uuid) && !same(attribute(afterRoot, 'uuid'), identity.sourceUuid)) {
    return 'Выбранный merge изменил logical adopted root UUID.';
  }
  const originalChildren = new Map(allMetadataChildren(beforeRoot).map((child) => [childIdentity(child), child]));
  const mergedChildren = allMetadataChildren(afterRoot);
  for (const child of mergedChildren) {
    const key = childIdentity(child);
    const previous = originalChildren.get(key);
    if (previous && !same(attribute(previous, 'uuid'), attribute(child, 'uuid'))) {
      return `Выбранный merge изменил identity UUID у ${key}.`;
    }
    if (previous && !same(metadataChildName(previous), metadataChildName(child))) {
      return `Выбранный merge изменил identity Name у ${key}.`;
    }
    if (previous && !sameGeneratedTypes(previous, child)) {
      return `Выбранный merge изменил GeneratedType identity у ${key}.`;
    }
    if (!previous && metadataChildName(child)) {
      const replacedIdentity = [...originalChildren.entries()].find(([originalKey, original]) => originalKey !== key
        && original.localName === child.localName && same(metadataChildName(original), metadataChildName(child)));
      if (replacedIdentity) { return `Выбранный merge изменил UUID identity child ${child.localName}.${metadataChildName(child)}.`; }
    }
  }
  return undefined;
}

function preserveRootIdentity(root: XmlElement, identity: AdoptedDesignerIdentity, metadataType: string): void {
  const uuid = identity.uuid;
  const metadata = root.parent;
  if (!metadata || metadata.localName !== 'MetaDataObject') { throw new Error('Target root has no MetaDataObject parent.'); }
  const current = attribute(root, 'uuid');
  if (!same(current, uuid)) { setAttribute(root, 'uuid', uuid); }
  if (metadataType !== identity.type) { throw new Error('Target root type changed while materializing adopted descriptor.'); }
}

function assertLogicalIdentity(root: XmlElement, identity: AdoptedDesignerIdentity): void {
  if (root.localName !== identity.type || !same(childText(direct(root, 'Properties')[0] ?? root, 'Name'), identity.name)) {
    throw new Error('Merged logical descriptor changed metadata type/name.');
  }
}
