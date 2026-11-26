import * as path from 'path';

import { parseBslRoutines } from '../bsl/routineRangeProvider';
import type { CompareMessage } from './domain/compareContracts';
import type { MergeCandidate } from './merge/mergePreview';
import { parseXmlDocument, elementChildren, textContent, type XmlElement } from './xml/xmlDom';
import { namespaceUriForName } from './adapters/semanticXml/semanticXmlIdentity';
import { blocked, LINKED_FORM_REFERENCE_PROPERTIES, normalizeAbsolutePath, normalizePath } from './linkedDesignerUtils';
import type { LinkedDesignerMaterializerContext, LinkedDesignerPackageRecipe, LinkedFormReferenceOwnerReference, LinkedFormReferenceOwnerState } from './linkedDesignerTypes';

const MDCLASSES_NAMESPACE = 'http://v8.1c.ru/8.3/MDClasses';
const LOGFORM_NAMESPACE = 'http://v8.1c.ru/8.3/xcf/logform';

export function parseLinkedFormReferenceOwnerState(
  reference: LinkedFormReferenceOwnerReference,
  xml: string,
): LinkedFormReferenceOwnerState | undefined {
  const root = tryParseXml(xml);
  const owner = root && metadataOwner(root);
  if (!owner || owner.localName !== reference.metadataType) {return undefined;}
  const properties = directInOwnerNamespace(owner, 'Properties');
  const ownerNamespace = normalizedMetadataNamespace(owner);
  const names = properties && elementChildren(properties).filter((child) => child.localName === 'Name'
    && normalizedMetadataNamespace(child) === ownerNamespace);
  const descriptorName = names?.length === 1 ? textContent(names[0]!).trim() : undefined;
  if (!descriptorName || canonicalQualifiedName(descriptorName) !== canonicalQualifiedName(reference.qualifiedName.split('.').pop() ?? '')) {return undefined;}
  return {
    ...reference,
    baselineReferences: readDefaultFormReferences(root).map((item) => ({
      propertyName: detachText(item.propertyName),
      value: detachText(item.value),
    })),
    baselineRegisteredForms: readRegistrationNames(root, 'Form').map(detachText),
  };
}

export async function validateFinalLinkedDesignerState(
  input: LinkedDesignerMaterializerContext,
  selectedPackages: ReadonlyMap<string, LinkedDesignerPackageRecipe>,
  selectedCandidates: readonly MergeCandidate[],
  finalBslOutputs: ReadonlyMap<string, string>,
  finalXmlOutputs: ReadonlyMap<string, string>,
  capturedOwnerStates: readonly LinkedFormReferenceOwnerState[] = [],
): Promise<CompareMessage[]> {
  const diagnostics = validateSelectedDefaultFormDependencies(input, selectedPackages, selectedCandidates);
  const formState = buildFinalFormValidationState(input, selectedPackages, finalXmlOutputs);
  diagnostics.push(...formState.diagnostics);
  diagnostics.push(...validateFinalFormHandlers(input, selectedCandidates, finalBslOutputs, formState));
  if (input.formReferenceOwnerReferences === undefined) {
    diagnostics.push(...validateLegacyFormReferenceOwners(input, selectedPackages, formState.deletedForms, formState.finalForms, finalXmlOutputs));
  } else {
    diagnostics.push(...validateCapturedFormReferenceOwners(input, capturedOwnerStates, formState.deletedForms, formState.finalForms, finalXmlOutputs));
  }
  return diagnostics;
}

interface FinalFormValidationState {
  readonly deletedForms: ReadonlySet<string>;
  readonly finalForms: ReadonlyMap<string, FinalFormSnapshot>;
  readonly copiedFormModules: ReadonlyMap<string, string>;
  readonly diagnostics: readonly CompareMessage[];
}

function validateSelectedDefaultFormDependencies(
  input: LinkedDesignerMaterializerContext,
  selectedPackages: ReadonlyMap<string, LinkedDesignerPackageRecipe>,
  selectedCandidates: readonly MergeCandidate[],
): CompareMessage[] {
  const selectedPackageIds = new Set([...selectedPackages.values()].map((recipe) => recipe.packageId));
  const diagnostics: CompareMessage[] = [];
  const selectedIds = new Set(selectedCandidates.map((candidate) => candidate.nodeId));
  for (const nodeId of selectedIds) {
    const dependency = input.defaultFormDependencies?.get(nodeId);
    if (dependency && !dependency.targetFormComplete && (!dependency.packageId || !selectedPackageIds.has(dependency.packageId))) {
      diagnostics.push(blocked('DefaultObjectForm нельзя применить без полной целевой формы или выбранного linked Form-пакета.', input.sourceId, nodeId));
    }
  }
  return diagnostics;
}

function buildFinalFormValidationState(
  input: LinkedDesignerMaterializerContext,
  selectedPackages: ReadonlyMap<string, LinkedDesignerPackageRecipe>,
  finalXmlOutputs: ReadonlyMap<string, string>,
): FinalFormValidationState {
  const deletedForms = collectDeletedForms(selectedPackages);
  const finalForms = buildExistingFinalForms(input, deletedForms, finalXmlOutputs);
  const copied = addCopiedFinalForms(input, selectedPackages, finalForms);
  return { deletedForms, finalForms, copiedFormModules: copied.modules, diagnostics: copied.diagnostics };
}

function collectDeletedForms(packages: ReadonlyMap<string, LinkedDesignerPackageRecipe>): Set<string> {
  return new Set([...packages.values()]
    .filter((recipe) => recipe.kind === 'Form' && recipe.action === 'delete')
    .map((recipe) => canonicalQualifiedName(recipe.qualifiedName)));
}

function buildExistingFinalForms(
  input: LinkedDesignerMaterializerContext,
  deletedForms: ReadonlySet<string>,
  finalXmlOutputs: ReadonlyMap<string, string>,
): Map<string, FinalFormSnapshot> {
  const finalForms = new Map<string, FinalFormSnapshot>();
  for (const snapshot of input.formXmlSnapshots ?? []) {
    const key = canonicalQualifiedName(snapshot.qualifiedName);
    if (deletedForms.has(key)) {continue;}
    const outputPath = normalizeAbsolutePath(path.join(input.targetRootPath, snapshot.targetRelativePath));
    finalForms.set(key, {
      qualifiedName: snapshot.qualifiedName,
      moduleId: snapshot.moduleId,
      xml: finalXmlOutputs.get(outputPath) ?? snapshot.targetContent,
      baselineXml: snapshot.targetContent,
      isNew: false,
    });
  }
  return finalForms;
}

function addCopiedFinalForms(
  input: LinkedDesignerMaterializerContext,
  selectedPackages: ReadonlyMap<string, LinkedDesignerPackageRecipe>,
  finalForms: Map<string, FinalFormSnapshot>,
): { readonly modules: Map<string, string>; readonly diagnostics: CompareMessage[] } {
  const modules = new Map<string, string>();
  const diagnostics: CompareMessage[] = [];
  for (const recipe of selectedPackages.values()) {
    if (recipe.kind !== 'Form' || recipe.action !== 'copy') {continue;}
    const formXml = recipe.members.find((member) => /\/Ext\/Form\.xml$/iu.test(normalizePath(member.targetRelativePath)));
    if (!formXml?.content) {
      diagnostics.push(blocked(`Добавляемый Form-пакет ${recipe.qualifiedName} не содержит захваченный Form.xml.`, input.sourceId, recipe.registrationNodeId));
      continue;
    }
    const moduleId = `${recipe.qualifiedName}.FormModule`;
    finalForms.set(canonicalQualifiedName(recipe.qualifiedName), {
      qualifiedName: recipe.qualifiedName,
      moduleId,
      xml: formXml.content.toString('utf8'),
      isNew: true,
    });
    const module = recipe.members.find((member) => /\/Ext\/Form\/Module\.bsl$/iu.test(normalizePath(member.targetRelativePath)));
    if (module?.content) {modules.set(moduleId, module.content.toString('utf8'));}
  }
  return { modules, diagnostics };
}

function validateFinalFormHandlers(
  input: LinkedDesignerMaterializerContext,
  selectedCandidates: readonly MergeCandidate[],
  finalBslOutputs: ReadonlyMap<string, string>,
  state: FinalFormValidationState,
): CompareMessage[] {
  const changedBslNodeIds = selectedCandidates.filter((candidate) => candidate.bslRoutine || candidate.logicalRoutine).map((candidate) => candidate.nodeId);
  const diagnostics: CompareMessage[] = [];
  if (changedBslNodeIds.length > 0 && (input.formXmlSnapshotIssues?.length ?? 0) > 0) {
    diagnostics.push(blocked(
      `Нельзя проверить итоговые ссылки обработчиков: не удалось захватить Form.xml (${input.formXmlSnapshotIssues![0]}).`,
      input.targetSourceId,
      changedBslNodeIds[0],
    ));
  }
  for (const form of state.finalForms.values()) {
    diagnostics.push(...validateFormHandlers(input, form, changedBslNodeIds, finalBslOutputs, state.copiedFormModules));
  }
  return diagnostics;
}

function validateFormHandlers(
  input: LinkedDesignerMaterializerContext,
  form: FinalFormSnapshot,
  changedBslNodeIds: readonly string[],
  finalBslOutputs: ReadonlyMap<string, string>,
  copiedFormModules: ReadonlyMap<string, string>,
): CompareMessage[] {
  const handlers = readEventHandlers(form.xml);
  if (!handlers) {return [blocked(`Итоговый Form.xml ${form.qualifiedName} не удалось разобрать для проверки обработчиков.`, input.targetSourceId, changedBslNodeIds[0])];}
  const module = findModule(input, form.moduleId);
  const modulePath = module && normalizeAbsolutePath(path.join(input.targetRootPath, module.targetRelativePath));
  const finalModuleText = (modulePath && finalBslOutputs.get(modulePath))
    ?? copiedFormModules.get(form.moduleId)
    ?? module?.targetContent;
  const finalRoutineSet = parseRoutineSet(finalModuleText);
  const baselineRoutineSet = parseRoutineSet(module?.targetContent);
  const baselineHandlers = form.isNew ? new Set<string>() : readEventHandlers(form.baselineXml ?? '') ?? new Set<string>();
  return [...handlers].flatMap((handler) => validateSingleHandler(input, form, handler, finalRoutineSet, baselineRoutineSet, baselineHandlers, changedBslNodeIds));
}

function validateSingleHandler(
  input: LinkedDesignerMaterializerContext,
  form: FinalFormSnapshot,
  handler: string,
  finalRoutineSet: ReadonlySet<string>,
  baselineRoutineSet: ReadonlySet<string>,
  baselineHandlers: ReadonlySet<string>,
  changedBslNodeIds: readonly string[],
): CompareMessage[] {
  const name = handler.trim().toLocaleLowerCase('en-US');
  if (finalRoutineSet.has(name)) {return [];}
  const wasAlreadyUnresolved = !form.isNew && baselineHandlers.has(handler) && !baselineRoutineSet.has(name);
  return wasAlreadyUnresolved ? [] : [blocked(
    `Итоговый Form ${form.qualifiedName} ссылается на обработчик ${handler}, которого нет в целевом BSL module.`,
    input.targetSourceId,
    changedBslNodeIds[0] ?? findEventCandidateId(input, handler),
  )];
}

function validateLegacyFormReferenceOwners(
  input: LinkedDesignerMaterializerContext,
  selectedPackages: ReadonlyMap<string, LinkedDesignerPackageRecipe>,
  deletedForms: ReadonlySet<string>,
  finalForms: ReadonlyMap<string, FinalFormSnapshot>,
  finalXmlOutputs: ReadonlyMap<string, string>,
): CompareMessage[] {
  const owners = new Map<string, { readonly ownerName: string; readonly targetRelativePath: string; readonly targetHash: string; readonly targetContent: string }>();
  for (const snapshot of input.formReferenceOwnerSnapshots ?? []) {
    owners.set(canonicalQualifiedName(snapshot.qualifiedName), { ...snapshot, ownerName: snapshot.qualifiedName });
  }
  for (const recipe of selectedPackages.values()) {
    if (recipe.ownerQualifiedName && recipe.ownerDescriptorSnapshot) {
      owners.set(canonicalQualifiedName(recipe.ownerQualifiedName), { ...recipe.ownerDescriptorSnapshot, ownerName: recipe.ownerQualifiedName });
    }
  }
  if (deletedForms.size > 0 && (input.formReferenceOwnerSnapshotIssues?.length ?? 0) > 0) {
    return [blocked(
      `Нельзя проверить ссылки владельцев на удаляемые формы: не удалось захватить descriptor (${input.formReferenceOwnerSnapshotIssues![0]}).`,
      input.targetSourceId,
      [...selectedPackages.values()].find((recipe) => recipe.action === 'delete' && recipe.kind === 'Form')?.registrationNodeId,
    )];
  }
  const baselineFormCounts = countBaselineForms(input);
  return [...owners.values()].flatMap((snapshot) => {
    const pathKey = normalizeAbsolutePath(path.join(input.targetRootPath, snapshot.targetRelativePath));
    const finalOwnerXml = finalXmlOutputs.get(pathKey) ?? snapshot.targetContent;
    const finalRoot = tryParseXml(finalOwnerXml);
    const baselineRoot = tryParseXml(snapshot.targetContent);
    if (!finalRoot || !baselineRoot) {
      return [blocked(`Итоговый descriptor владельца ${snapshot.ownerName} не удалось разобрать для проверки DefaultObjectForm.`, input.targetSourceId)];
    }
    return validateOwnerReferences({
      targetSourceId: input.targetSourceId,
      ownerName: snapshot.ownerName,
      finalReferences: readDefaultFormReferences(finalRoot),
      finalRegisteredForms: readRegistrationNames(finalRoot, 'Form'),
      baselineReferences: readDefaultFormReferences(baselineRoot),
      baselineRegisteredForms: readRegistrationNames(baselineRoot, 'Form'),
      deletedForms,
      finalForms,
      baselineFormCounts,
    });
  });
}

function validateCapturedFormReferenceOwners(
  input: LinkedDesignerMaterializerContext,
  states: readonly LinkedFormReferenceOwnerState[],
  deletedForms: ReadonlySet<string>,
  finalForms: ReadonlyMap<string, FinalFormSnapshot>,
  finalXmlOutputs: ReadonlyMap<string, string>,
): CompareMessage[] {
  const baselineFormCounts = countBaselineForms(input);
  return states.flatMap((state) => {
    const outputPath = normalizeAbsolutePath(path.join(input.targetRootPath, state.targetRelativePath));
    const finalXml = finalXmlOutputs.get(outputPath);
    const finalRoot = finalXml === undefined ? undefined : tryParseXml(finalXml);
    if (finalXml !== undefined && !finalRoot) {
      return [blocked(`Итоговый descriptor владельца ${state.qualifiedName} не удалось разобрать для проверки DefaultObjectForm.`, input.targetSourceId)];
    }
    return validateOwnerReferences({
      targetSourceId: input.targetSourceId,
      ownerName: state.qualifiedName,
      finalReferences: finalRoot ? readDefaultFormReferences(finalRoot) : state.baselineReferences,
      finalRegisteredForms: finalRoot ? readRegistrationNames(finalRoot, 'Form') : state.baselineRegisteredForms,
      baselineReferences: state.baselineReferences,
      baselineRegisteredForms: state.baselineRegisteredForms,
      deletedForms,
      finalForms,
      baselineFormCounts,
    });
  });
}

interface OwnerReferenceValidationInput {
  readonly targetSourceId: string;
  readonly ownerName: string;
  readonly finalReferences: readonly { readonly propertyName: string; readonly value: string }[];
  readonly finalRegisteredForms: readonly string[];
  readonly baselineReferences: readonly { readonly propertyName: string; readonly value: string }[];
  readonly baselineRegisteredForms: readonly string[];
  readonly deletedForms: ReadonlySet<string>;
  readonly finalForms: ReadonlyMap<string, FinalFormSnapshot>;
  readonly baselineFormCounts: ReadonlyMap<string, number>;
}

function validateOwnerReferences(input: OwnerReferenceValidationInput): CompareMessage[] {
  const diagnostics: CompareMessage[] = [];
  for (const reference of input.finalReferences) {
    const value = reference.value.trim();
    if (!value) {continue;}
    const resolved = resolveFinalFormReference(value, input.ownerName);
    const formExists = input.finalForms.has(canonicalQualifiedName(resolved));
    const localRegistration = nestedFormName(resolved, input.ownerName);
    const registered = localRegistration === undefined || matchingNames(input.finalRegisteredForms, localRegistration) === 1;
    const wasPresent = input.baselineReferences.some((baseline) => baseline.propertyName === reference.propertyName && baseline.value.trim() === value);
    const baselineResolved = resolveFinalFormReference(value, input.ownerName);
    const baselineFormExists = input.deletedForms.has(canonicalQualifiedName(baselineResolved))
      || input.baselineFormCounts.get(canonicalQualifiedName(baselineResolved)) === 1;
    const baselineLocalRegistration = nestedFormName(baselineResolved, input.ownerName);
    const baselineRegistered = baselineLocalRegistration === undefined || matchingNames(input.baselineRegisteredForms, baselineLocalRegistration) === 1;
    const wasAlreadyUnresolved = wasPresent && (!baselineFormExists || !baselineRegistered);
    if (!formExists || !registered) {
      if (!wasAlreadyUnresolved) {diagnostics.push(blocked(`${reference.propertyName} ${value} не разрешается в одну полную целевую форму.`, input.targetSourceId));}
    }
  }
  return diagnostics;
}

function countBaselineForms(input: LinkedDesignerMaterializerContext): Map<string, number> {
  const counts = new Map<string, number>();
  for (const form of input.formXmlSnapshots ?? []) {
    const key = canonicalQualifiedName(form.qualifiedName);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function matchingNames(names: readonly string[], target: string): number {
  const key = canonicalQualifiedName(target);
  return names.filter((name) => canonicalQualifiedName(name) === key).length;
}

function findModule(input: LinkedDesignerMaterializerContext, moduleId: string) {
  const modules = new Map<string, NonNullable<LinkedDesignerMaterializerContext['formModules']>[number]>();
  for (const item of [...(input.formModules ?? []), ...(input.modulesByTargetPath?.values() ?? [])]) {
    modules.set(normalizePath(item.targetRelativePath), item);
  }
  const matches = [...modules.values()].filter((item) => item.moduleId === moduleId);
  return matches.length === 1 ? matches[0] : undefined;
}

function parseRoutineSet(source: string | undefined): Set<string> {
  if (source === undefined) {return new Set();}
  const parsed = parseBslRoutines(source);
  if (parsed.diagnostics.some((item) => item.severity === 'error')) {return new Set();}
  const counts = new Map<string, number>();
  for (const routine of parsed.routines) {counts.set(routine.normalizedName, (counts.get(routine.normalizedName) ?? 0) + 1);}
  return new Set([...counts].filter(([, count]) => count === 1).map(([name]) => name));
}

function readEventHandlers(xml: string): Set<string> | undefined {
  const root = tryParseXml(xml);
  if (!root || root.localName !== 'Form' || namespaceUriForName(root) !== LOGFORM_NAMESPACE) {return undefined;}
  const events: XmlElement[] = [];
  const visit = (element: XmlElement): void => {
    if (element !== root && element.localName === 'BaseForm') {return;}
    if (namespaceUriForName(element) !== LOGFORM_NAMESPACE) {return;}
    if (element.localName === 'Event' && element.parent?.localName === 'Events'
      && namespaceUriForName(element.parent) === LOGFORM_NAMESPACE) {
      events.push(element);
      return;
    }
    for (const child of elementChildren(element)) {visit(child);}
  };
  visit(root);
  return new Set(events.map((element) => textContent(element).trim()).filter(Boolean));
}

function readDefaultFormReferences(root: XmlElement): Array<{ propertyName: string; value: string }> {
  const owner = metadataOwner(root);
  const properties = owner && directInOwnerNamespace(owner, 'Properties');
  const ownerNamespace = owner && normalizedMetadataNamespace(owner);
  return properties
    ? elementChildren(properties).filter((child) => LINKED_FORM_REFERENCE_PROPERTIES.includes(child.localName as typeof LINKED_FORM_REFERENCE_PROPERTIES[number])
      && normalizedMetadataNamespace(child) === ownerNamespace).map((child) => ({ propertyName: child.localName, value: textContent(child).trim() }))
    : [];
}

function readRegistrationNames(root: XmlElement, kind: 'Form'): string[] {
  const owner = metadataOwner(root);
  const childObjects = owner && directInOwnerNamespace(owner, 'ChildObjects');
  const ownerNamespace = owner && normalizedMetadataNamespace(owner);
  return childObjects
    ? elementChildren(childObjects).filter((child) => child.localName === kind
      && normalizedMetadataNamespace(child) === ownerNamespace).map((child) => textContent(child).trim())
    : [];
}

function findEventCandidateId(input: LinkedDesignerMaterializerContext, handler: string): string | undefined {
  return [...(input.eventRoutineDependencies ?? [])].find(([, value]) => value.handlerName === handler)?.[0];
}

function metadataOwner(root: XmlElement): XmlElement | undefined {
  const rootNamespace = normalizedMetadataNamespace(root);
  if (root.localName !== 'MetaDataObject' || !isSupportedMetadataNamespace(rootNamespace)) {return undefined;}
  const owners = elementChildren(root);
  if (owners.length !== 1) {return undefined;}
  const owner = owners[0]!;
  const ownerNamespace = normalizedMetadataNamespace(owner);
  return isSupportedMetadataNamespace(ownerNamespace) && ownerNamespace === rootNamespace ? owner : undefined;
}

function directInOwnerNamespace(owner: XmlElement, localName: string): XmlElement | undefined {
  const ownerNamespace = normalizedMetadataNamespace(owner);
  const matches = elementChildren(owner).filter((child) => child.localName === localName
    && normalizedMetadataNamespace(child) === ownerNamespace);
  return matches.length === 1 ? matches[0] : undefined;
}

function normalizedMetadataNamespace(element: XmlElement): string {
  return namespaceUriForName(element) ?? '';
}

function isSupportedMetadataNamespace(namespace: string): boolean {
  return namespace === '' || namespace === MDCLASSES_NAMESPACE;
}

function tryParseXml(xml: string): XmlElement | undefined {
  try {return parseXmlDocument(xml).root;} catch {return undefined;}
}

function resolveFinalFormReference(value: string, ownerName: string): string {
  const normalized = value.normalize('NFC');
  if (normalized.includes('.')) {return normalized;}
  return `${ownerName}.Form.${normalized}`;
}

function nestedFormName(qualifiedName: string, ownerName: string): string | undefined {
  const prefix = `${ownerName}.Form.`;
  if (!canonicalQualifiedName(qualifiedName).startsWith(canonicalQualifiedName(prefix))) {return undefined;}
  const nested = qualifiedName.slice(prefix.length);
  return nested && !nested.includes('.') ? nested : undefined;
}

function canonicalQualifiedName(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('en-US');
}

function detachText(value: string): string {
  return Buffer.from(value, 'utf8').toString('utf8');
}

interface FinalFormSnapshot {
  readonly qualifiedName: string;
  readonly moduleId: string;
  readonly xml: string;
  readonly baselineXml?: string;
  readonly isNew: boolean;
}
