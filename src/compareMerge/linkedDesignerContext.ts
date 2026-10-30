import * as path from 'path';
import { createHash } from 'crypto';

import { parseBslRoutines } from '../bsl/routineRangeProvider';
import type { CompareTreeNode } from './compareTreeTypes';
import type { BslModuleIndexEntry } from './bsl/bslModuleIndexer';
import type { MetadataObjectMatch, AdapterCompareInput, ExecutableCandidateFactory } from './adapters/mergeAdapter';
import type { ConfigurationInventory } from './inventory/configurationInventory';
import type { LinkedDesignerPackageRecipe, LinkedFormModuleSnapshot, LinkedDefaultFormDependency } from './linkedDesignerMaterializer';
import type { MatchResult } from './domain/compareContracts';
import type { MetadataIdentity } from './domain/compareContracts';
import type { CompareJoinStrategy } from './configurationCompareWorkspace';
import type { MergeFileWitness } from './merge/mergePreview';
import { captureMergePath, mergeSnapshotHash } from './merge/mergeSnapshot';
import { elementChildren, parseXmlDocument, textContent, type XmlElement } from './xml/xmlDom';
import { namespaceUriForName } from './adapters/semanticXml/semanticXmlIdentity';
import { LINKED_FORM_REFERENCE_PROPERTIES, stripHash } from './linkedDesignerUtils';

const MDCLASSES_NAMESPACE = 'http://v8.1c.ru/8.3/MDClasses';
const LOGFORM_NAMESPACE = 'http://v8.1c.ru/8.3/xcf/logform';

export function buildLinkedModuleSnapshots(input: {
  readonly leftModules: readonly BslModuleIndexEntry[];
  readonly rightModules: readonly BslModuleIndexEntry[];
  readonly leftSources: ReadonlyMap<string, string>;
  readonly rightSources: ReadonlyMap<string, string>;
  readonly leftRootPath: string;
  readonly rightRootPath: string;
  readonly leftInventory: ConfigurationInventory;
  readonly rightInventory: ConfigurationInventory;
  readonly routineCandidateFactories: ReadonlyMap<string, ExecutableCandidateFactory>;
}): LinkedFormModuleSnapshot[] {
  const leftById = groupModulesById(input.leftModules);
  const rightById = groupModulesById(input.rightModules);
  const result: LinkedFormModuleSnapshot[] = [];
  for (const [moduleId, leftEntries] of leftById) {
    const rightEntries = rightById.get(moduleId) ?? [];
    if (leftEntries.length !== 1 || rightEntries.length !== 1) {continue;}
    const left = leftEntries[0]!;
    const right = rightEntries[0]!;
    const targetContent = input.leftSources.get(left.identity.filePath);
    const sourceContent = input.rightSources.get(right.identity.filePath);
    if (targetContent === undefined || sourceContent === undefined) {continue;}
    const prefix = `bsl:routine:${moduleId}:`;
    const routineCandidateIds = new Map<string, string>();
    for (const candidateId of input.routineCandidateFactories.keys()) {
      if (candidateId.startsWith(prefix)) {
        routineCandidateIds.set(candidateId.slice(prefix.length).toLocaleLowerCase('en-US'), candidateId);
      }
    }
    result.push({
      moduleId,
      targetRelativePath: path.relative(input.leftRootPath, left.identity.filePath).split(path.sep).join('/'),
      sourceRelativePath: path.relative(input.rightRootPath, right.identity.filePath).split(path.sep).join('/'),
      targetHash: rawModuleHash(input.leftInventory, left.identity.filePath, targetContent),
      sourceHash: rawModuleHash(input.rightInventory, right.identity.filePath, sourceContent),
      targetContent,
      sourceContent,
      routineCandidateIds,
    });
  }
  return result;
}

function rawModuleHash(inventory: ConfigurationInventory, filePath: string, content: string): string {
  const artifact = [...inventory.artifactsByObjectId.values()].flat().find((item) =>
    item.kind === 'bslModule' && pathKey(item.filePath) === pathKey(filePath));
  if (artifact?.contentHash) {return stripHash(artifact.contentHash);}
  // Read sources preserve BOM and line endings; routine logic continues to use hashText separately.
  return createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
}

export function mapLinkedModulesByTargetPath(
  targetRootPath: string,
  modules: readonly LinkedFormModuleSnapshot[],
): ReadonlyMap<string, LinkedFormModuleSnapshot> {
  return new Map(modules.map((module) => [pathKey(path.join(targetRootPath, module.targetRelativePath)), module]));
}

/** Pins selected routine changes to the exact target Form.xml snapshots associated with their module. */
export function attachFormHandlerReferenceWitnesses(input: {
  readonly candidateFactories: Map<string, ExecutableCandidateFactory>;
  readonly formXmlSnapshots: readonly import('./linkedDesignerTypes').LinkedFormXmlSnapshot[];
  readonly modules: readonly LinkedFormModuleSnapshot[];
  readonly targetSourceId: string;
  readonly targetRootPath: string;
}): void {
  const modules = new Map(input.modules.map((module) => [module.moduleId, module]));
  const byNodeId = new Map<string, MergeFileWitness[]>();
  for (const form of input.formXmlSnapshots) {
    const module = modules.get(form.moduleId);
    if (!module) {continue;}
    const witness: MergeFileWitness = {
      sourceId: input.targetSourceId,
      relativePath: form.targetRelativePath.replace(/\\/gu, '/'),
      expectedHash: stripHash(form.targetHash),
      kind: 'file',
    };
    for (const nodeId of module.routineCandidateIds.values()) {
      byNodeId.set(nodeId, [...(byNodeId.get(nodeId) ?? []), witness]);
    }
  }
  for (const [nodeId, witnesses] of byNodeId) {
    const factory = input.candidateFactories.get(nodeId);
    if (!factory) {continue;}
    input.candidateFactories.set(nodeId, async () => {
      for (const witness of witnesses) {
        let currentHash: string;
        try {
          const current = await captureMergePath(path.resolve(input.targetRootPath, ...witness.relativePath.split('/')), { retainContent: false });
          currentHash = current.state === 'missing' ? 'missing' : mergeSnapshotHash(current);
        } catch {
          return {
            ok: false,
            diagnostics: [{
              severity: 'error', code: 'MERGE_PLAN_CONFLICT', phase: 'preview',
              sourceId: witness.sourceId, path: witness.relativePath, nodeId, blocking: true,
              suggestedAction: 'Не удалось проверить связанный Form.xml. Повторите сравнение.',
            }],
          };
        }
        if (currentHash !== witness.expectedHash) {
          return {
            ok: false,
            diagnostics: [{
              severity: 'error', code: 'MERGE_PLAN_CONFLICT', phase: 'preview',
              sourceId: witness.sourceId, path: witness.relativePath, nodeId, blocking: true,
              suggestedAction: 'Связанный Form.xml изменился после сравнения. Повторите сравнение.',
            }],
          };
        }
      }
      const result = await factory();
      if (!result.ok) {return result;}
      const combined = new Map<string, MergeFileWitness>();
      for (const witness of [...(result.candidate.sourceWitnesses ?? []), ...witnesses]) {
        const key = `${witness.sourceId}\\0${witness.relativePath.replace(/\\/gu, '/')}`;
        const previous = combined.get(key);
        if (previous && (previous.expectedHash !== witness.expectedHash || previous.kind !== witness.kind)) {
          return {
            ok: false,
            diagnostics: [{
              severity: 'error', code: 'MERGE_PLAN_CONFLICT', phase: 'preview',
              sourceId: witness.sourceId, path: witness.relativePath, nodeId, blocking: true,
              suggestedAction: 'Снимок Form.xml для выбранного обработчика неоднозначен; повторите сравнение.',
            }],
          };
        }
        combined.set(key, witness);
      }
      return { ok: true, candidate: { ...result.candidate, sourceWitnesses: [...combined.values()] } };
    });
  }
}

export function buildFormXmlModulePathMap(
  metadata: MatchResult,
  modules: readonly LinkedFormModuleSnapshot[],
  inventory: ConfigurationInventory,
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const match of metadata.matches) {
    if ((match.left.metadataType !== 'Form' && match.left.metadataType !== 'CommonForm')
      || match.left.metadataType !== match.right.metadataType) {continue;}
    const module = findFormModuleSnapshot(match.left.qualifiedName, modules);
    const object = inventory.objects.find((candidate) => candidate.qualifiedName === match.left.qualifiedName && candidate.metadataType === match.left.metadataType);
    if (!module || !object) {continue;}
    for (const artifact of inventory.artifactsByObjectId.get(object.objectId) ?? []) {
      if (artifact.kind === 'formXml') {result.set(pathKey(artifact.filePath), module.moduleId);}
    }
  }
  return result;
}

/** Keeps normal directional inventory scope and adds only unmatched Designer package descriptors. */
export function linkedDesignerDescriptorScope(
  metadata: MatchResult,
  strategy: CompareJoinStrategy,
): { left?: ReadonlySet<string>; right?: ReadonlySet<string> } {
  const matchedLeft = new Set(metadata.matches.map((match) => path.normalize(match.left.filePath)));
  const matchedRight = new Set(metadata.matches.map((match) => path.normalize(match.right.filePath)));
  const unmatchedLeft = metadata.unmatchedLeft.filter(isFileBackedDesignerIdentity);
  const unmatchedRight = metadata.unmatchedRight.filter(isFileBackedDesignerIdentity);
  const rightOwners = linkedOwnerDescriptors(metadata, unmatchedRight);
  const leftOwners = linkedOwnerDescriptors(metadata, unmatchedLeft);
  const collisionLeft = unmatchedRight.flatMap((right) => unmatchedLeft
    .filter((left) => normalizeMetadataName(left.qualifiedName) === normalizeMetadataName(right.qualifiedName))
    .map((left) => path.normalize(left.filePath)));
  const collisionRight = unmatchedLeft.flatMap((left) => unmatchedRight
    .filter((right) => normalizeMetadataName(left.qualifiedName) === normalizeMetadataName(right.qualifiedName))
    .map((right) => path.normalize(right.filePath)));
  if (strategy === 'full') {
    return {
      left: new Set([...matchedLeft, ...unmatchedLeft.map((item) => path.normalize(item.filePath))]),
      right: new Set([...matchedRight, ...unmatchedRight.map((item) => path.normalize(item.filePath))]),
    };
  }
  if (strategy === 'right') {
    return { left: new Set([...matchedLeft, ...collisionLeft, ...rightOwners.map((item) => item.left)]), right: undefined };
  }
  return { left: undefined, right: new Set([...matchedRight, ...collisionRight, ...leftOwners.map((item) => item.right)]) };
}

function linkedOwnerDescriptors(metadata: MatchResult, identities: readonly MetadataIdentity[]): Array<{ left: string; right: string }> {
  return identities.flatMap((identity) => {
    if (identity.metadataType.startsWith('Common')) {return [];}
    const ownerName = nestedOwnerQualifiedName(identity);
    const owner = ownerName && metadata.matches.find((match) =>
      normalizeMetadataName(match.left.qualifiedName) === normalizeMetadataName(ownerName)
      && normalizeMetadataName(match.right.qualifiedName) === normalizeMetadataName(ownerName));
    return owner ? [{ left: path.normalize(owner.left.filePath), right: path.normalize(owner.right.filePath) }] : [];
  });
}

function isFileBackedDesignerIdentity(identity: MetadataIdentity): boolean {
  return ['Form', 'Template', 'Command', 'CommonForm', 'CommonTemplate', 'CommonCommand'].includes(identity.metadataType);
}

function nestedOwnerQualifiedName(identity: MetadataIdentity): string | undefined {
  const parts = identity.qualifiedName.split('.');
  const typeIndex = parts.lastIndexOf(identity.metadataType);
  return typeIndex >= 2 && typeIndex === parts.length - 2 ? parts.slice(0, typeIndex).join('.') : undefined;
}

function normalizeMetadataName(value: string): string {return value.normalize('NFC').toLocaleLowerCase('en-US');}

export function buildLinkedDesignerAdapterContext(input: {
  readonly match: MetadataObjectMatch;
  readonly artifactKind: 'metadataXml' | 'formXml' | 'predefinedXml' | 'roleRightsXml' | 'dcsXml';
  /** The Form/CommonForm owning this Form.xml artifact; match may refer to its parent object. */
  readonly formQualifiedName?: string;
  readonly leftSnapshot: string;
  readonly rightSnapshot: string;
  readonly leftInventory: ConfigurationInventory;
  readonly packages: readonly LinkedDesignerPackageRecipe[];
  readonly modules: readonly LinkedFormModuleSnapshot[];
}): NonNullable<AdapterCompareInput['linkedDesignerContext']> {
  const ownerQualifiedName = input.match.right?.qualifiedName ?? input.match.left?.qualifiedName ?? '';
  const registrations = input.artifactKind === 'metadataXml'
    ? input.packages
      .filter((recipe) => recipe.ownerQualifiedName === ownerQualifiedName && !recipe.rootRegistration)
      .map((recipe) => ({ kind: recipe.kind, name: finalName(recipe.qualifiedName), packageId: recipe.packageId }))
    : [];
  const defaultObjectForms: Array<{
    propertyName: string;
    value: string;
    targetFormComplete: boolean;
    packageId?: string;
    targetWitnesses?: readonly import('./merge/mergePreview').MergeFileWitness[];
  }> = [];
  if (input.artifactKind === 'metadataXml' && input.match.right) {
    for (const propertyName of LINKED_FORM_REFERENCE_PROPERTIES) {
      for (const rawValue of metadataValues(input.rightSnapshot, propertyName, input.match.right)) {
        const value = rawValue.trim();
        if (!value) {continue;}
        const resolution = resolveFormReference(value, ownerQualifiedName, input.leftSnapshot, input.match.left, input.leftInventory, 'left-source');
        const recipe = input.packages.find((candidate) => candidate.kind === 'Form' && candidate.action === 'copy'
          && normalizeMetadataName(candidate.qualifiedName) === normalizeMetadataName(resolution.qualifiedName));
        defaultObjectForms.push({
          propertyName,
          value,
          targetFormComplete: resolution.targetFormComplete,
          ...(recipe ? { packageId: recipe.packageId } : {}),
          ...(resolution.targetWitnesses.length ? { targetWitnesses: resolution.targetWitnesses } : {}),
        });
      }
    }
  }

  let formEventHandlers: Array<{ name: string; targetHasHandler: boolean; incomingRoutineNodeId?: string; targetWitnesses?: readonly import('./merge/mergePreview').MergeFileWitness[] }> = [];
  if (input.artifactKind === 'formXml' && input.match.right) {
    const module = findFormModuleSnapshot(input.formQualifiedName ?? input.match.right.qualifiedName, input.modules);
    if (module && (module.targetContent !== undefined || module.targetMissing === true)) {
      const incoming = module.sourceContent === undefined ? undefined : parseBslRoutines(module.sourceContent);
      const target = parseBslRoutines(module.targetContent ?? '');
      const names = [...new Set(xmlEventHandlers(input.rightSnapshot))];
      formEventHandlers = names.map((name) => {
        const normalized = name.trim().toLocaleLowerCase('en-US');
        const sourceMatches = incoming?.routines.filter((routine) => routine.normalizedName === normalized) ?? [];
        const targetMatches = target.routines.filter((routine) => routine.normalizedName === normalized);
        const candidateId = sourceMatches.length === 1 && !incoming?.diagnostics.some((item) => item.severity === 'error')
          ? module.routineCandidateIds.get(normalized) : undefined;
        return {
          name,
          targetHasHandler: module.targetMissing !== true && !target.diagnostics.some((item) => item.severity === 'error') && targetMatches.length === 1,
          ...(candidateId ? { incomingRoutineNodeId: candidateId } : {}),
          ...(module.targetHash && module.targetMissing !== true ? { targetWitnesses: [{
            sourceId: 'left-source',
            relativePath: module.targetRelativePath,
            expectedHash: module.targetHash,
            kind: 'file' as const,
          }] } : {}),
        };
      });
    }
  }
  return { registrations, defaultObjectForms, formEventHandlers };
}

export function collectDefaultFormDependencies(
  nodes: readonly CompareTreeNode[],
  capabilities: NonNullable<AdapterCompareInput['linkedDesignerContext']>['defaultObjectForms'],
  output: Map<string, LinkedDefaultFormDependency>,
): void {
  const byValue = new Map(capabilities.map((item) => [`${item.propertyName}\0${item.value.trim()}`, item]));
  for (const node of flattenCompareNodes(nodes)) {
    const propertyName = linkedFormReferenceProperty(node.payloadRef ?? '');
    if (!node.mergeable || node.status === 'leftOnly' || !propertyName) {continue;}
    const value = node.rightValue?.trim() ?? '';
    if (!value) {continue;}
    const capability = byValue.get(`${propertyName}\0${value}`);
    if (!capability) {continue;}
    output.set(node.id, {
      targetFormComplete: capability.targetFormComplete,
      ...(capability.packageId ? { packageId: capability.packageId } : {}),
      ...(capability.targetWitnesses?.length ? { targetWitnesses: capability.targetWitnesses } : {}),
    });
  }
}

export function collectEventRoutineDependencies(
  nodes: readonly CompareTreeNode[],
  capabilities: NonNullable<AdapterCompareInput['linkedDesignerContext']>['formEventHandlers'],
  module: LinkedFormModuleSnapshot,
  output: Map<string, { moduleId: string; handlerName: string; targetHasHandler: boolean; incomingRoutineNodeId?: string; targetWitnesses?: readonly import('./merge/mergePreview').MergeFileWitness[] }>,
): void {
  const byName = new Map(capabilities.map((item) => [item.name.trim(), item]));
  for (const node of flattenCompareNodes(nodes)) {
    if (!node.mergeable) {continue;}
    if (node.status === 'leftOnly' || !/Event(?:%5B|\[|%2F|\/)/iu.test(node.payloadRef ?? '')) {continue;}
    const value = node.rightValue?.trim() ?? '';
    const handlerName = parseEventNodeValue(value) ?? value;
    const capability = byName.get(handlerName);
    if (!capability) {continue;}
    output.set(node.id, {
      moduleId: module.moduleId,
      handlerName: capability.name,
      targetHasHandler: capability.targetHasHandler,
      ...(capability.incomingRoutineNodeId ? { incomingRoutineNodeId: capability.incomingRoutineNodeId } : {}),
      ...(capability.targetWitnesses?.length ? { targetWitnesses: capability.targetWitnesses } : {}),
    });
  }
}

export function formXmlReferencesHandler(xml: string, handlerName: string): boolean {
  const expected = handlerName.trim().toLocaleLowerCase('en-US');
  return Boolean(expected) && xmlEventHandlers(xml).some((name) => name.trim().toLocaleLowerCase('en-US') === expected);
}

export function findFormModuleSnapshot(
  qualifiedName: string,
  modules: readonly LinkedFormModuleSnapshot[],
): LinkedFormModuleSnapshot | undefined {
  const matches = modules.filter((module) => module.moduleId === canonicalFormModuleId(qualifiedName));
  return matches.length === 1 ? matches[0] : undefined;
}

/** Canonical BSL module identity for either a nested Form or a root CommonForm. */
export function canonicalFormModuleId(formQualifiedName: string): string {
  return `${formQualifiedName}.FormModule`;
}

function groupModulesById(modules: readonly BslModuleIndexEntry[]): Map<string, BslModuleIndexEntry[]> {
  const grouped = new Map<string, BslModuleIndexEntry[]>();
  for (const module of modules) {grouped.set(module.identity.moduleId, [...(grouped.get(module.identity.moduleId) ?? []), module]);}
  return grouped;
}

function targetHasCompleteNestedForm(
  ownerXml: string,
  ownerQualifiedName: string,
  formName: string,
  expectedOwner: MetadataObjectMatch['left'],
  inventory: ConfigurationInventory,
  sourceId: string,
): { targetFormComplete: boolean; targetWitnesses: import('./merge/mergePreview').MergeFileWitness[] } {
  if (!expectedOwner || !nestedRegistrationValues(ownerXml, 'Form', expectedOwner).some((name) => normalizeMetadataName(name) === normalizeMetadataName(formName))) {
    return { targetFormComplete: false, targetWitnesses: [] };
  }
  return completeFormIdentity(`${ownerQualifiedName}.Form.${formName}`, inventory, sourceId);
}

function resolveFormReference(
  reference: string,
  ownerQualifiedName: string,
  ownerXml: string,
  expectedOwner: MetadataObjectMatch['left'],
  inventory: ConfigurationInventory,
  sourceId: string,
): { qualifiedName: string; targetFormComplete: boolean; targetWitnesses: import('./merge/mergePreview').MergeFileWitness[] } {
  const value = reference.trim().normalize('NFC');
  const nestedPrefix = `${ownerQualifiedName}.Form.`;
  const qualifiedName = value.includes('.') ? value : `${nestedPrefix}${value}`;
  const normalizedName = normalizeMetadataName(qualifiedName);
  const normalizedPrefix = normalizeMetadataName(nestedPrefix);
  if (normalizedName.startsWith(normalizedPrefix)) {
    const nestedName = qualifiedName.slice(nestedPrefix.length);
    if (!nestedName || nestedName.includes('.')) {return { qualifiedName, targetFormComplete: false, targetWitnesses: [] };}
    const result = targetHasCompleteNestedForm(ownerXml, ownerQualifiedName, nestedName, expectedOwner, inventory, sourceId);
    return { qualifiedName, ...result };
  }
  const result = completeFormIdentity(qualifiedName, inventory, sourceId);
  return { qualifiedName, ...result };
}

function completeFormIdentity(
  qualifiedName: string,
  inventory: ConfigurationInventory,
  sourceId: string,
): { targetFormComplete: boolean; targetWitnesses: import('./merge/mergePreview').MergeFileWitness[] } {
  const objects = inventory.objects.filter((object) =>
    (object.metadataType === 'Form' || object.metadataType === 'CommonForm')
    && normalizeMetadataName(object.qualifiedName) === normalizeMetadataName(qualifiedName));
  if (objects.length !== 1) {return { targetFormComplete: false, targetWitnesses: [] };}
  const object = objects[0]!;
  const artifacts = inventory.artifactsByObjectId.get(object.objectId) ?? [];
  const descriptors = artifacts.filter((artifact) => artifact.kind === 'metadataXml' && pathKey(artifact.filePath) === pathKey(object.descriptorPath));
  if (descriptors.length !== 1) {return { targetFormComplete: false, targetWitnesses: [] };}
  const descriptor = descriptors[0]!;
  const descriptorRelativePath = path.relative(inventory.rootPath, descriptor.filePath).split(path.sep).join('/');
  const requiredBodyPath = `${descriptorRelativePath.replace(/\.xml$/iu, '')}/Ext/Form.xml`;
  const bodies = artifacts.filter((artifact) => artifact.kind === 'formXml' && pathKey(artifact.relativePath) === pathKey(requiredBodyPath));
  if (bodies.length !== 1) {return { targetFormComplete: false, targetWitnesses: [] };}
  return {
    targetFormComplete: true,
    targetWitnesses: [descriptor, bodies[0]!].map((artifact) => ({
      sourceId,
      relativePath: artifact.relativePath.replace(/\\/gu, '/'),
      expectedHash: stripHash(artifact.contentHash),
      kind: 'file' as const,
    })),
  };
}

function metadataValues(xml: string, childName: string, expectedOwner: MetadataObjectMatch['right']): string[] {
  const root = tryParseXml(xml);
  const owner = root && expectedOwner && metadataOwner(root, expectedOwner);
  const properties = owner && directXmlChild(owner, 'Properties');
  return properties ? directXmlChildren(properties, childName).map((element) => textContent(element)) : [];
}

function nestedRegistrationValues(xml: string, kind: 'Form' | 'Template' | 'Command', expectedOwner: MetadataObjectMatch['left']): string[] {
  const root = tryParseXml(xml);
  const owner = root && metadataOwner(root, expectedOwner);
  const childObjects = owner && directXmlChild(owner, 'ChildObjects');
  return childObjects ? directXmlChildren(childObjects, kind).map((element) => textContent(element).trim()) : [];
}

function xmlEventHandlers(xml: string): string[] {
  const root = tryParseXml(xml);
  if (!root || root.localName !== 'Form' || namespaceUriForName(root) !== LOGFORM_NAMESPACE) {return [];}
  const handlers: string[] = [];
  const visit = (element: XmlElement): void => {
    if (element !== root && element.localName === 'BaseForm') {return;}
    if (namespaceUriForName(element) !== LOGFORM_NAMESPACE) {return;}
    if (element.localName === 'Event' && element.parent?.localName === 'Events'
      && namespaceUriForName(element.parent) === LOGFORM_NAMESPACE) {
      const value = textContent(element).trim();
      if (value) {handlers.push(value);}
      return;
    }
    for (const child of elementChildren(element)) {visit(child);}
  };
  visit(root);
  return handlers;
}

function tryParseXml(xml: string): XmlElement | undefined {
  try {return parseXmlDocument(xml).root;} catch {return undefined;}
}

function metadataOwner(root: XmlElement, expectedOwner: MetadataObjectMatch['left']): XmlElement | undefined {
  if (!expectedOwner || root.localName !== 'MetaDataObject' || namespaceUriForName(root) !== MDCLASSES_NAMESPACE) {return undefined;}
  const owners = elementChildren(root);
  if (owners.length !== 1 || namespaceUriForName(owners[0]!) !== MDCLASSES_NAMESPACE
    || owners[0]!.localName !== expectedOwner.metadataType) {return undefined;}
  const properties = directXmlChild(owners[0]!, 'Properties');
  const names = properties && directXmlChildren(properties, 'Name');
  const expectedName = expectedOwner.qualifiedName.split('.').pop() ?? expectedOwner.qualifiedName;
  if (!names || names.length !== 1 || textContent(names[0]!).trim().normalize('NFC') !== expectedName.normalize('NFC')) {return undefined;}
  const uuid = owners[0]!.attributes.find((attribute) => attribute.name === 'uuid')?.value;
  if (!expectedOwner.uuid || uuid?.toLocaleLowerCase('en-US') !== expectedOwner.uuid.toLocaleLowerCase('en-US')) {return undefined;}
  return owners[0];
}

function directXmlChild(root: XmlElement, name: string): XmlElement | undefined {
  const namespace = namespaceUriForName(root);
  const matches = elementChildren(root).filter((child) => child.localName === name
    && namespaceUriForName(child) === namespace);
  return matches.length === 1 ? matches[0] : undefined;
}

function directXmlChildren(root: XmlElement, name: string): XmlElement[] {
  const namespace = namespaceUriForName(root);
  return elementChildren(root).filter((child) => child.localName === name
    && namespaceUriForName(child) === namespace);
}

function parseEventNodeValue(value: string): string | undefined {
  if (!value.startsWith('<')) {return undefined;}
  const root = tryParseXml(value);
  return root?.localName === 'Event' && namespaceUriForName(root) === LOGFORM_NAMESPACE ? textContent(root).trim() : undefined;
}

function linkedFormReferenceProperty(payloadRef: string): string | undefined {
  const decoded = payloadRef.split('/').map((segment) => {
    try {return decodeURIComponent(segment);} catch {return segment;}
  });
  return LINKED_FORM_REFERENCE_PROPERTIES.find((propertyName) => decoded.some((segment) =>
    segment === propertyName || segment.startsWith(`${propertyName}[`)));
}

function flattenCompareNodes(nodes: readonly CompareTreeNode[]): CompareTreeNode[] {
  return nodes.flatMap((node) => [node, ...flattenCompareNodes(node.children)]);
}

function finalName(qualifiedName: string): string {
  return qualifiedName.split('.').pop() ?? qualifiedName;
}

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
}
