import * as path from 'path';

import { parseBslRoutines } from '../bsl/routineRangeProvider';
import type { CompareMessage } from './domain/compareContracts';
import type { MergeCandidate } from './merge/mergePreview';
import { parseXmlDocument, elementChildren, textContent, type XmlElement } from './xml/xmlDom';
import { namespaceUriForName } from './adapters/semanticXml/semanticXmlIdentity';
import { blocked, LINKED_FORM_REFERENCE_PROPERTIES, normalizeAbsolutePath, normalizePath } from './linkedDesignerUtils';
import type { LinkedDesignerMaterializerContext, LinkedDesignerPackageRecipe } from './linkedDesignerTypes';

const MDCLASSES_NAMESPACE = 'http://v8.1c.ru/8.3/MDClasses';
const LOGFORM_NAMESPACE = 'http://v8.1c.ru/8.3/xcf/logform';

export async function validateFinalLinkedDesignerState(
  input: LinkedDesignerMaterializerContext,
  selectedPackages: ReadonlyMap<string, LinkedDesignerPackageRecipe>,
  selectedCandidates: readonly MergeCandidate[],
  finalBslOutputs: ReadonlyMap<string, string>,
  finalXmlOutputs: ReadonlyMap<string, string>,
): Promise<CompareMessage[]> {
  const diagnostics: CompareMessage[] = [];
  const selectedPackageIds = new Set([...selectedPackages.values()].map((recipe) => recipe.packageId));
  const selectedIds = new Set(selectedCandidates.map((candidate) => candidate.nodeId));
  const changedBslNodeIds = selectedCandidates.filter((candidate) => candidate.bslRoutine || candidate.logicalRoutine).map((candidate) => candidate.nodeId);

  for (const nodeId of selectedIds) {
    const dependency = input.defaultFormDependencies?.get(nodeId);
    if (dependency && !dependency.targetFormComplete && (!dependency.packageId || !selectedPackageIds.has(dependency.packageId))) {
      diagnostics.push(blocked('DefaultObjectForm нельзя применить без полной целевой формы или выбранного linked Form-пакета.', input.sourceId, nodeId));
    }
  }

  const deletedForms = new Set([...selectedPackages.values()]
    .filter((recipe) => recipe.kind === 'Form' && recipe.action === 'delete')
    .map((recipe) => canonicalQualifiedName(recipe.qualifiedName)));
  const copiedForms = [...selectedPackages.values()].filter((recipe) => recipe.kind === 'Form' && recipe.action === 'copy');
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
  const copiedFormModules = new Map<string, string>();
  for (const recipe of copiedForms) {
    const formXml = recipe.members.find((member) => /\/Ext\/Form\.xml$/iu.test(normalizePath(member.targetRelativePath)));
    if (!formXml?.content) {
      diagnostics.push(blocked(`Добавляемый Form-пакет ${recipe.qualifiedName} не содержит захваченный Form.xml.`, input.sourceId, recipe.registrationNodeId));
      continue;
    }
    const qualifiedName = canonicalQualifiedName(recipe.qualifiedName);
    const moduleId = `${recipe.qualifiedName}.FormModule`;
    finalForms.set(qualifiedName, {
      qualifiedName: recipe.qualifiedName,
      moduleId,
      xml: formXml.content.toString('utf8'),
      isNew: true,
    });
    const module = recipe.members.find((member) => /\/Ext\/Form\/Module\.bsl$/iu.test(normalizePath(member.targetRelativePath)));
    if (module?.content) {copiedFormModules.set(moduleId, module.content.toString('utf8'));}
  }

  if (changedBslNodeIds.length > 0 && (input.formXmlSnapshotIssues?.length ?? 0) > 0) {
    diagnostics.push(blocked(
      `Нельзя проверить итоговые ссылки обработчиков: не удалось захватить Form.xml (${input.formXmlSnapshotIssues![0]}).`,
      input.targetSourceId,
      changedBslNodeIds[0],
    ));
  }

  for (const form of finalForms.values()) {
    const finalHandlers = readEventHandlers(form.xml);
    if (!finalHandlers) {
      diagnostics.push(blocked(`Итоговый Form.xml ${form.qualifiedName} не удалось разобрать для проверки обработчиков.`, input.targetSourceId, changedBslNodeIds[0]));
      continue;
    }
    const module = findModule(input, form.moduleId);
    const modulePath = module && normalizeAbsolutePath(path.join(input.targetRootPath, module.targetRelativePath));
    const finalModuleText = (modulePath && finalBslOutputs.get(modulePath))
      ?? copiedFormModules.get(form.moduleId)
      ?? module?.targetContent;
    const finalRoutineSet = parseRoutineSet(finalModuleText);
    const baselineModuleText = module?.targetContent;
    const baselineRoutineSet = parseRoutineSet(baselineModuleText);
    const baselineHandlers = form.isNew ? new Set<string>() : readEventHandlers(form.baselineXml ?? '') ?? new Set<string>();
    for (const handler of finalHandlers) {
      const name = handler.trim().toLocaleLowerCase('en-US');
      if (finalRoutineSet.has(name)) {continue;}
      const wasAlreadyUnresolved = !form.isNew && baselineHandlers.has(handler)
        && !baselineRoutineSet.has(name);
      if (!wasAlreadyUnresolved) {
        diagnostics.push(blocked(
          `Итоговый Form ${form.qualifiedName} ссылается на обработчик ${handler}, которого нет в целевом BSL module.`,
          input.targetSourceId,
          changedBslNodeIds[0] ?? findEventCandidateId(input, handler),
        ));
      }
    }
  }

  const owners = new Map<string, { targetRelativePath: string; targetHash: string; targetContent: string }>();
  for (const snapshot of input.formReferenceOwnerSnapshots ?? []) {
    owners.set(canonicalQualifiedName(snapshot.qualifiedName), snapshot);
  }
  for (const recipe of selectedPackages.values()) {
    if (recipe.ownerQualifiedName && recipe.ownerDescriptorSnapshot) {
      owners.set(canonicalQualifiedName(recipe.ownerQualifiedName), recipe.ownerDescriptorSnapshot);
    }
  }
  if (deletedForms.size > 0 && (input.formReferenceOwnerSnapshotIssues?.length ?? 0) > 0) {
    diagnostics.push(blocked(
      `Нельзя проверить ссылки владельцев на удаляемые формы: не удалось захватить descriptor (${input.formReferenceOwnerSnapshotIssues![0]}).`,
      input.targetSourceId,
      [...selectedPackages.values()].find((recipe) => recipe.action === 'delete' && recipe.kind === 'Form')?.registrationNodeId,
    ));
  }
  for (const [ownerName, snapshot] of owners) {
    if (!snapshot) {continue;}
    const outputPath = normalizeAbsolutePath(path.join(input.targetRootPath, snapshot.targetRelativePath));
    const finalOwnerXml = finalXmlOutputs.get(outputPath) ?? snapshot.targetContent;
    const root = tryParseXml(finalOwnerXml);
    if (!root) {
      diagnostics.push(blocked(`Итоговый descriptor владельца ${ownerName} не удалось разобрать для проверки DefaultObjectForm.`, input.targetSourceId));
      continue;
    }
    const defaultValues = readDefaultFormReferences(root);
    const baselineRoot = tryParseXml(snapshot.targetContent);
    const baselineValues = baselineRoot ? readDefaultFormReferences(baselineRoot) : [];
    for (const reference of defaultValues) {
      const value = reference.value.trim();
      if (!value) {continue;}
      const resolved = resolveFinalFormReference(value, ownerName);
      const formMatches = [...finalForms.values()].filter((form) => canonicalQualifiedName(form.qualifiedName) === canonicalQualifiedName(resolved));
      const localRegistration = nestedFormName(resolved, ownerName);
      const registered = localRegistration === undefined || readRegistrationNames(root, 'Form').filter((name) =>
        canonicalQualifiedName(name) === canonicalQualifiedName(localRegistration)
      ).length === 1;
      const isComplete = formMatches.length === 1 && registered;
      const wasPresent = baselineValues.some((baselineValue) =>
        baselineValue.propertyName === reference.propertyName && baselineValue.value.trim() === value
      );
      const baselineResolved = baselineRoot ? resolveFinalFormReference(value, ownerName) : '';
      const baselineFormExists = (input.formXmlSnapshots ?? []).filter((form) =>
        canonicalQualifiedName(form.qualifiedName) === canonicalQualifiedName(baselineResolved)
      ).length === 1;
      const baselineLocalRegistration = nestedFormName(baselineResolved, ownerName);
      const baselineRegistered = baselineLocalRegistration === undefined || Boolean(baselineRoot && readRegistrationNames(baselineRoot, 'Form').filter((name) =>
        canonicalQualifiedName(name) === canonicalQualifiedName(baselineLocalRegistration)
      ).length === 1);
      const wasAlreadyUnresolved = wasPresent && (!baselineFormExists || !baselineRegistered);
      if (!isComplete && !wasAlreadyUnresolved) {
        diagnostics.push(blocked(`${reference.propertyName} ${value} не разрешается в одну полную целевую форму.`, input.targetSourceId));
      }
    }
  }
  return diagnostics;
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
  const ownerNamespace = owner && namespaceUriForName(owner);
  return properties
    ? elementChildren(properties).filter((child) => LINKED_FORM_REFERENCE_PROPERTIES.includes(child.localName as typeof LINKED_FORM_REFERENCE_PROPERTIES[number])
      && namespaceUriForName(child) === ownerNamespace).map((child) => ({ propertyName: child.localName, value: textContent(child).trim() }))
    : [];
}

function readRegistrationNames(root: XmlElement, kind: 'Form'): string[] {
  const owner = metadataOwner(root);
  const childObjects = owner && directInOwnerNamespace(owner, 'ChildObjects');
  const ownerNamespace = owner && namespaceUriForName(owner);
  return childObjects
    ? elementChildren(childObjects).filter((child) => child.localName === kind
      && namespaceUriForName(child) === ownerNamespace).map((child) => textContent(child).trim())
    : [];
}

function findEventCandidateId(input: LinkedDesignerMaterializerContext, handler: string): string | undefined {
  return [...(input.eventRoutineDependencies ?? [])].find(([, value]) => value.handlerName === handler)?.[0];
}

function metadataOwner(root: XmlElement): XmlElement | undefined {
  if (root.localName !== 'MetaDataObject' || namespaceUriForName(root) !== MDCLASSES_NAMESPACE) {return undefined;}
  const owners = elementChildren(root);
  return owners.length === 1 && namespaceUriForName(owners[0]!) === MDCLASSES_NAMESPACE ? owners[0] : undefined;
}

function directInOwnerNamespace(owner: XmlElement, localName: string): XmlElement | undefined {
  const ownerNamespace = namespaceUriForName(owner);
  const matches = elementChildren(owner).filter((child) => child.localName === localName
    && namespaceUriForName(child) === ownerNamespace);
  return matches.length === 1 ? matches[0] : undefined;
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

interface FinalFormSnapshot {
  readonly qualifiedName: string;
  readonly moduleId: string;
  readonly xml: string;
  readonly baselineXml?: string;
  readonly isNew: boolean;
}
