import { elementChildren, type XmlElement } from '../xml/xmlDom';
import {
  cloneWithNamespaces,
  makeElement,
  prefixForNamespace,
  remove,
  stableElement,
} from './adoptedDesignerXml';
import {
  addIssue,
  direct,
  formRegistrationName,
  inMetadataNamespace,
  normalizeFormRegistrationName,
  type MetadataXmlProjectionIssue,
} from './adoptedDesignerMetadataXml';

const MDCLASSES_NAMESPACE = 'http://v8.1c.ru/8.3/MDClasses';
const FORM_FOLLOWING_REGISTRATION_TYPES = new Set(['Template', 'Command']);

export interface AdoptedDesignerOwnFormRegistrations {
  readonly target: readonly string[];
  readonly source: readonly string[];
}

export interface FormRegistrationRecord {
  readonly name: string;
  readonly key: string;
  readonly element: XmlElement;
}

export type BaseFormRegistrationsResult =
  | { readonly ok: true; readonly registrations: readonly FormRegistrationRecord[] }
  | { readonly ok: false; readonly reason: string };

export function snapshotOwnFormRegistrations(
  value: AdoptedDesignerOwnFormRegistrations | undefined,
): AdoptedDesignerOwnFormRegistrations | undefined {
  if (value === undefined) { return undefined; }
  return Object.freeze({
    target: Object.freeze([...value.target]),
    source: Object.freeze([...value.source]),
  });
}

export function ownFormRegistrationNames(
  value: AdoptedDesignerOwnFormRegistrations | undefined,
  side: 'target' | 'source',
): readonly string[] {
  if (value === undefined) { return []; }
  const names = value[side];
  if (!Array.isArray(names)) { throw new Error(`Allowlist ownFormRegistrations.${side} должен быть массивом имён Form.`); }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const name of names) {
    if (typeof name !== 'string' || !name.trim()) {
      throw new Error(`Allowlist ownFormRegistrations.${side} содержит пустое или не-текстовое имя Form.`);
    }
    const key = normalizeFormRegistrationName(name);
    if (seen.has(key)) { throw new Error(`Имя Form ${name} повторяется в allowlist ownFormRegistrations.${side}.`); }
    seen.add(key);
    normalized.push(key);
  }
  return normalized;
}

export function collectBaseFormRegistrations(root: XmlElement): BaseFormRegistrationsResult {
  const containers = direct(root, 'ChildObjects');
  if (containers.length > 1) { return { ok: false, reason: 'В base descriptor повторяется ChildObjects; Form registrations неоднозначны.' }; }
  const registrations: FormRegistrationRecord[] = [];
  const seen = new Set<string>();
  for (const element of containers[0] ? elementChildren(containers[0]) : []) {
    if (element.localName !== 'Form' || !inMetadataNamespace(element)) { continue; }
    const name = formRegistrationName(element);
    if (!name) { return { ok: false, reason: 'Base MDClasses/Form registration должна содержать только непустое plain-text имя.' }; }
    const key = normalizeFormRegistrationName(name);
    if (seen.has(key)) { return { ok: false, reason: `Имя base Form ${name} повторяется после нормализации.` }; }
    seen.add(key);
    registrations.push({ name, key, element });
  }
  return { ok: true, registrations };
}

export function projectOwnFormRegistrations(input: {
  readonly physicalRoot: XmlElement;
  readonly logicalRoot: XmlElement;
  readonly baseRegistrations: readonly FormRegistrationRecord[];
  readonly allowedNames: readonly string[];
  readonly ownership: 'own' | 'adopted';
  readonly side: 'target' | 'source';
  readonly ownerKey: string;
  readonly issues: MetadataXmlProjectionIssue[];
}): string | undefined {
  const physicalContainers = direct(input.physicalRoot, 'ChildObjects');
  if (physicalContainers.length > 1) { return `${input.side} descriptor содержит повторные ChildObjects; Form registrations неоднозначны.`; }
  const physicalContainer = physicalContainers[0];
  const allowed = new Set(ownFormRegistrationNames({ target: [], source: input.allowedNames }, 'source'));
  const baseByKey = new Map(input.baseRegistrations.map((registration) => [registration.key, registration]));
  const desired: XmlElement[] = input.ownership === 'adopted'
    ? input.baseRegistrations.map(({ element }) => element)
    : [];
  const physicalForms = physicalContainer
    ? elementChildren(physicalContainer).filter((element) => element.localName === 'Form')
    : [];
  const validByKey = new Map<string, FormRegistrationRecord[]>();
  const malformed: XmlElement[] = [];
  for (const element of physicalForms) {
    if (!inMetadataNamespace(element)) {
      if (input.side === 'target' || input.ownership === 'own') { desired.push(element); }
      continue;
    }
    const name = formRegistrationName(element);
    if (!name) {
      malformed.push(element);
      addIssue(input.issues, input.side, input.ownerKey, 'ChildObjects', 'MDClasses/Form не является уникальной plain-text registration и остаётся scoped read-only.');
      continue;
    }
    const key = normalizeFormRegistrationName(name);
    const records = validByKey.get(key) ?? [];
    records.push({ name, key, element });
    validByKey.set(key, records);
  }

  for (const name of allowed) {
    if (baseByKey.has(name)) { return `Allowlist ownFormRegistrations.${input.side} содержит унаследованное имя Form ${name}.`; }
    const matches = validByKey.get(name) ?? [];
    if (matches.length === 0) { return `Allowlist ownFormRegistrations.${input.side} ссылается на отсутствующую физическую Form registration ${name}.`; }
  }

  if (input.ownership === 'own') {
    for (const registration of input.baseRegistrations) {
      if (!validByKey.has(registration.key)) {
        addIssue(input.issues, input.side, `form=${registration.key}`, 'ChildObjects', `Own descriptor не содержит base Form ${registration.name}; отсутствие сохраняется как scoped read-only и не синтезируется.`);
      }
    }
  }

  for (const [key, records] of validByKey) {
    if (records.length > 1) {
      addIssue(input.issues, input.side, `form=${key}`, 'ChildObjects', `Form registration ${records[0]!.name} повторяется после нормализации и остаётся scoped read-only.`);
      if (input.ownership === 'own' || (input.side === 'target' && !baseByKey.has(key))) {
        desired.push(...records.map(({ element }) => element));
      }
      continue;
    }
    const record = records[0]!;
    const isBaseRegistration = baseByKey.has(key);
    if (isBaseRegistration && input.ownership === 'adopted') { continue; }
    if (input.side === 'target') {
      desired.push(record.element);
      if (!isBaseRegistration && !allowed.has(key)) {
        addIssue(input.issues, input.side, `form=${key}`, 'ChildObjects', `Target own Form ${record.name} отсутствует в allowlist и сохраняется как read-only registration.`);
      }
    } else {
      desired.push(record.element);
      if (!isBaseRegistration && !allowed.has(key)) {
        addIssue(input.issues, input.side, `form=${key}`, 'ChildObjects', `Source own Form ${record.name} отсутствует в allowlist и видима только как scoped read-only registration.`);
      }
    }
  }
  if (input.side === 'target' || input.ownership === 'own') { desired.push(...malformed); }
  // An own descriptor is already the logical view. Rebuilding its Form list would
  // move captured opaque and malformed nodes during unrelated scalar changes.
  if (input.ownership === 'own') { return undefined; }
  return replaceLogicalFormRegistrations(input.logicalRoot, desired);
}

export function encodeOwnFormRegistrations(input: {
  readonly physicalRoot: XmlElement;
  readonly baseRoot: XmlElement;
  readonly initialRoot: XmlElement;
  readonly selectedRoot: XmlElement;
  readonly sourceAllowedNames: readonly string[];
  readonly targetOwnership: 'own' | 'adopted';
}): string | undefined {
  const base = directFormElements(input.baseRoot);
  const initial = directFormElements(input.initialRoot);
  const selected = directFormElements(input.selectedRoot);
  if (base.error) { return base.error; }
  if (initial.error) { return initial.error; }
  if (selected.error) { return selected.error; }
  const baseNames = indexFormElements(base.elements, 'base');
  if (baseNames.error) { return baseNames.error; }
  const initialNames = indexFormElements(initial.elements, 'initial target');
  const selectedNames = indexFormElements(selected.elements, 'selected target');
  const allowed = new Set(ownFormRegistrationNames({ target: [], source: input.sourceAllowedNames }, 'source'));

  if (initial.hasMalformed || selected.hasMalformed) {
    return sameFormElementSequence(initial.elements, selected.elements)
      ? undefined
      : 'Malformed target Form registration can only remain unchanged during merge.';
  }
  if (initialNames.error) {
    return sameFormElementSequence(initial.elements, selected.elements)
      ? undefined
      : initialNames.error;
  }
  if (selectedNames.error) { return selectedNames.error; }

  const selectedByKey = selectedNames.values;
  const initialByKey = initialNames.values;
  for (const [key, baseElement] of baseNames.values) {
    const selectedElement = selectedByKey.get(key);
    if (input.targetOwnership === 'own') {
      const initialElement = initialByKey.get(key);
      if (!initialElement) {
        if (selectedElement) {
          return `Base Form ${formRegistrationName(baseElement)} отсутствует в текущем own target и не может быть синтезирована без отдельной регистрации.`;
        }
        continue;
      }
      if (!selectedElement || !sameRegistration(initialElement, selectedElement)) {
        return `Удаление или изменение текущей own Form ${formRegistrationName(initialElement)} запрещены.`;
      }
      continue;
    }
    if (!selectedElement || formRegistrationName(selectedElement) !== formRegistrationName(baseElement)) {
      return `Удаление или rename унаследованной Form ${formRegistrationName(baseElement)} запрещены.`;
    }
  }

  for (const [key, initialElement] of initialByKey) {
    if (baseNames.values.has(key)) { continue; }
    const selectedElement = selectedByKey.get(key);
    if (!selectedElement || !sameRegistration(initialElement, selectedElement)) {
      return `Target own Form registration ${formRegistrationName(initialElement)} должна сохраняться без изменений.`;
    }
  }

  const additions: XmlElement[] = [];
  for (const [key, selectedElement] of selectedByKey) {
    if (baseNames.values.has(key) || initialByKey.has(key)) { continue; }
    if (!allowed.has(key)) { return `Новая Form registration ${formRegistrationName(selectedElement)} отсутствует в source allowlist.`; }
    additions.push(selectedElement);
  }

  const physicalContainers = direct(input.physicalRoot, 'ChildObjects');
  if (physicalContainers.length > 1) { return 'Целевой descriptor содержит повторные ChildObjects; Form registration нельзя кодировать.'; }
  let physicalContainer = physicalContainers[0];
  if (additions.length > 0) {
    if (!physicalContainer) { physicalContainer = createChildObjects(input.physicalRoot); }
    const physicalNames = new Set(directFormElements(input.physicalRoot).elements
      .map(formRegistrationName).filter((name): name is string => Boolean(name)).map(normalizeFormRegistrationName));
    for (const addition of additions) {
      const name = formRegistrationName(addition);
      if (!name) { return 'Selected Form registration must be a plain-text MDClasses/Form name.'; }
      const key = normalizeFormRegistrationName(name);
      if (physicalNames.has(key)) { continue; }
      insertFormRegistration(physicalContainer, cloneWithNamespaces(addition));
      physicalNames.add(key);
    }
  }
  // Only normalize the logical sequence when this operation actually added a
  // registration. Scalar-only merges must retain the captured node positions.
  return additions.length > 0
    ? replaceLogicalFormRegistrations(input.selectedRoot, selected.elements)
    : undefined;
}

export function selectedNewFormRegistrationNames(initialRoot: XmlElement, selectedRoot: XmlElement): string[] {
  const initial = directFormElements(initialRoot);
  const selected = directFormElements(selectedRoot);
  if (initial.error || selected.error || initial.hasMalformed || selected.hasMalformed) { return []; }
  const before = new Set(initial.elements.map(formRegistrationName).filter((name): name is string => Boolean(name)).map(normalizeFormRegistrationName));
  return selected.elements.map(formRegistrationName).filter((name): name is string => Boolean(name))
    .filter((name) => !before.has(normalizeFormRegistrationName(name)));
}

function directFormElements(root: XmlElement): { readonly elements: XmlElement[]; readonly hasMalformed: boolean; readonly error?: string } {
  const containers = direct(root, 'ChildObjects');
  if (containers.length > 1) { return { elements: [], hasMalformed: false, error: 'Form registrations cannot be encoded with duplicate ChildObjects.' }; }
  const elements = containers[0]
    ? elementChildren(containers[0]).filter((element) => element.localName === 'Form')
    : [];
  return { elements, hasMalformed: elements.some((element) => !formRegistrationName(element)) };
}

function indexFormElements(elements: readonly XmlElement[], label: string): { readonly values: Map<string, XmlElement>; readonly error?: string } {
  const values = new Map<string, XmlElement>();
  for (const element of elements) {
    const name = formRegistrationName(element);
    if (!name) { continue; }
    const key = normalizeFormRegistrationName(name);
    if (values.has(key)) { return { values, error: `Form registration ${name} repeats in ${label}.` }; }
    values.set(key, element);
  }
  return { values };
}

function replaceLogicalFormRegistrations(root: XmlElement, desired: readonly XmlElement[]): string | undefined {
  const containers = direct(root, 'ChildObjects');
  if (containers.length > 1) { return 'Логический descriptor содержит повторные ChildObjects; Form registrations неоднозначны.'; }
  let container = containers[0];
  if (!container && desired.length === 0) { return undefined; }
  if (!container) { container = createChildObjects(root); }
  for (const element of elementChildren(container)) {
    if (element.localName === 'Form') { remove(container, element); }
  }
  const insertIndex = formInsertionIndex(container);
  for (const [offset, element] of desired.entries()) {
    const clone = cloneWithNamespaces(element);
    clone.parent = container;
    container.children.splice(insertIndex + offset, 0, clone);
  }
  return undefined;
}

function createChildObjects(root: XmlElement): XmlElement {
  const name = `${prefixForNamespace(root, MDCLASSES_NAMESPACE, 'md')}:ChildObjects`;
  const container = makeElement(name);
  const structural = root.children
    .map((child, index) => ({ child, index }))
    .filter(({ child }) => child.kind === 'element' && ['Properties', 'InternalInfo'].includes(child.localName));
  const insertion = structural.length > 0 ? structural[structural.length - 1]!.index + 1
    : root.children.findIndex((child) => child.kind === 'element');
  const index = insertion < 0 ? root.children.length : insertion;
  root.children.splice(index, 0, container);
  container.parent = root;
  return container;
}

function insertFormRegistration(container: XmlElement, registration: XmlElement): void {
  const existing = elementChildren(container).filter((child) => child.localName === 'Form' && inMetadataNamespace(child));
  for (const element of existing) { remove(container, element); }
  let index = formInsertionIndex(container);
  for (const element of [...existing, registration]) {
    element.parent = container;
    container.children.splice(index++, 0, element);
  }
}

function formInsertionIndex(container: XmlElement): number {
  const children = elementChildren(container);
  const boundary = children.find((child) => !inMetadataNamespace(child)
    || FORM_FOLLOWING_REGISTRATION_TYPES.has(child.localName));
  if (boundary) { return container.children.indexOf(boundary); }
  const lastMetadata = children.map((child, index) => ({ child, index })).filter(({ child }) => inMetadataNamespace(child)).pop();
  if (lastMetadata) {
    const element = children[lastMetadata.index]!;
    return container.children.indexOf(element) + 1;
  }
  return container.children.length;
}

function sameRegistration(left: XmlElement, right: XmlElement): boolean {
  return stableElement(left) === stableElement(right);
}

function sameFormElementSequence(left: readonly XmlElement[], right: readonly XmlElement[]): boolean {
  return left.length === right.length && left.every((element, index) => sameRegistration(element, right[index]!));
}
