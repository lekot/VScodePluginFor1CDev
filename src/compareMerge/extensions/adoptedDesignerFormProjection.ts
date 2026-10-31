import { createHash } from 'crypto';

import type { MergeFileWitness } from '../merge/mergePreview';
import { cloneXmlElement, elementChildren, parseXmlDocument, serializeXmlDocument, type XmlDocument, type XmlElement } from '../xml/xmlDom';
import {
  isSupportedAdoptedDesignerDirection,
  type AdoptedDesignerDirection,
  type AdoptedDesignerIdentity,
  type AdoptedDesignerProjectionIssue,
} from './adoptedDesignerProjection';

export interface AdoptedDesignerFormProjectionInput {
  readonly direction: AdoptedDesignerDirection;
  readonly targetXml: Buffer;
  readonly sourceXml: Buffer;
  readonly baseXml: Buffer;
  readonly targetIdentity: AdoptedDesignerIdentity;
  readonly sourceIdentity: AdoptedDesignerIdentity;
  readonly baseIdentity: AdoptedDesignerIdentity;
  readonly baseFormSourceId: string;
  readonly baseFormRelativePath: string;
  readonly baseFormHash: string;
  readonly formatVersion: string;
}

export type AdoptedDesignerFormProjectionResult =
  | {
    readonly ok: true;
    readonly targetXml: Buffer;
    readonly sourceXml: Buffer;
    readonly baseFormWitness: MergeFileWitness;
    readonly issues: readonly AdoptedDesignerProjectionIssue[];
  }
  | { readonly ok: false; readonly reason: string };

export interface AdoptedDesignerFormMaterializationInput extends AdoptedDesignerFormProjectionInput {
  readonly mergedLogicalTarget: Buffer;
}

export type AdoptedDesignerFormMaterializationResult =
  | { readonly ok: true; readonly content: Buffer; readonly baseFormWitness: MergeFileWitness; readonly issues: readonly AdoptedDesignerProjectionIssue[] }
  | { readonly ok: false; readonly reason: string };

const SUPPORTED_FORMATS = new Set(['2.17', '2.18', '2.19', '2.20', '2.21']);
const LOGFORM_NAMESPACE = 'http://v8.1c.ru/8.3/xcf/logform';

/** Removes adopted BaseForm wrappers independently after validating each against the captured base form. */
export function projectAdoptedDesignerFormPair(input: AdoptedDesignerFormProjectionInput): AdoptedDesignerFormProjectionResult {
  try {
    assertContract(input);
    const target = parseForm(input.targetXml, input.formatVersion);
    const source = parseForm(input.sourceXml, input.formatVersion);
    const base = parseForm(input.baseXml, input.formatVersion);
    const targetAdopted = input.direction !== 'adopted-to-cf';
    const sourceAdopted = input.direction !== 'cf-to-adopted';
    if (direct(base.root, 'BaseForm').length > 0) {
      throw new Error('Собственная Form.xml или captured CF base не должна содержать BaseForm.');
    }
    const baseRoot = base.root;
    const baseItems = buildBaseItemMap(baseRoot);
    const issues: AdoptedDesignerProjectionIssue[] = [];
    collectForeignBaseFormIssues(target.root, input.targetIdentity, 'target', issues);
    collectForeignBaseFormIssues(source.root, input.sourceIdentity, 'source', issues);
    projectSideBaseForm(target.root, targetAdopted, 'target', input.formatVersion, baseItems, issues);
    projectSideBaseForm(source.root, sourceAdopted, 'source', input.formatVersion, baseItems, issues);
    const witness = baseFormWitness(input);
    return {
      ok: true,
      targetXml: Buffer.from(serializeXmlDocument(target), 'utf8'),
      sourceXml: Buffer.from(serializeXmlDocument(source), 'utf8'),
      baseFormWitness: witness,
      issues,
    };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

/** Restores the actual target CFE BaseForm after semantic edits to its logical main Form tree. */
export function materializeAdoptedDesignerFormTarget(
  input: AdoptedDesignerFormMaterializationInput,
): AdoptedDesignerFormMaterializationResult {
  const projection = projectAdoptedDesignerFormPair(input);
  if (!projection.ok) { return projection; }
  try {
    const targetAdopted = input.direction !== 'adopted-to-cf';
    const physicalTarget = parseForm(input.targetXml, input.formatVersion);
    const merged = parseForm(input.mergedLogicalTarget, input.formatVersion);
    const mergedBases = direct(merged.root, 'BaseForm');
    if (mergedBases.length > 0) { return { ok: false, reason: 'Логический merged Form.xml неожиданно содержит BaseForm.' }; }
    const issues = [...projection.issues];
    const base = parseForm(input.baseXml, input.formatVersion);
    const baseItems = buildBaseItemMap(base.root);
    validateMainItemIdentities(merged.root, baseItems, 'target', issues);
    const changedIdentityIssue = compareFormOwnershipIdentities(physicalTarget.root, merged.root, baseItems, targetAdopted);
    if (changedIdentityIssue) { return { ok: false, reason: changedIdentityIssue }; }
    if (targetAdopted) {
      const targetBases = direct(physicalTarget.root, 'BaseForm');
      if (targetBases.length !== 1 || lastElement(physicalTarget.root) !== targetBases[0]) {
        return { ok: false, reason: 'Целевой CFE BaseForm изменился после projection или не имеет ожидаемой формы.' };
      }
      const preserved = cloneXmlElement(targetBases[0]!);
      preserved.parent = merged.root;
      merged.root.children.push(preserved);
    }
    return {
      ok: true,
      content: Buffer.from(serializeXmlDocument(merged), 'utf8'),
      baseFormWitness: projection.baseFormWitness,
      issues,
    };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

function assertContract(input: AdoptedDesignerFormProjectionInput): void {
  if (!isSupportedAdoptedDesignerDirection(input.direction)) { throw new Error('Направление adopted Form.xml не поддерживается.'); }
  if (!SUPPORTED_FORMATS.has(input.formatVersion)) { throw new Error(`Формат Designer ${input.formatVersion} не поддержан для adopted Form.xml.`); }
  if (input.baseIdentity.ownership !== 'own' || !isFormMetadataKind(input.baseIdentity.type)) { throw new Error('Base form identity должна быть собственным объектом Form или CommonForm.'); }
  const targetAdopted = input.direction !== 'adopted-to-cf';
  const sourceAdopted = input.direction !== 'cf-to-adopted';
  if (input.targetIdentity.ownership !== (targetAdopted ? 'adopted' : 'own')
    || input.sourceIdentity.ownership !== (sourceAdopted ? 'adopted' : 'own')
    || ![input.targetIdentity, input.sourceIdentity].every((identity) => identity.type === input.baseIdentity.type && same(identity.name, input.baseIdentity.name))
    || (targetAdopted && !same(input.targetIdentity.sourceUuid, input.baseIdentity.uuid))
    || (sourceAdopted && !same(input.sourceIdentity.sourceUuid, input.baseIdentity.uuid))
    || (!targetAdopted && !same(input.targetIdentity.uuid, input.baseIdentity.uuid))
    || (!sourceAdopted && !same(input.sourceIdentity.uuid, input.baseIdentity.uuid))) {
    throw new Error('Identity target/source Form не совпадает с точным base Form anchor.');
  }
  if (!input.baseFormSourceId.trim() || !safeRelativePath(input.baseFormRelativePath)) {
    throw new Error('Witness базовой Form.xml требует sourceId и безопасный относительный путь.');
  }
  if (!/^(?:sha256:)?[\da-f]{64}$/iu.test(input.baseFormHash)) { throw new Error('Witness базовой Form.xml должен содержать SHA-256.'); }
  const expected = input.baseFormHash.replace(/^sha256:/iu, '').toLowerCase();
  const actual = createHash('sha256').update(input.baseXml).digest('hex');
  if (expected !== actual) { throw new Error('Хеш захваченной базовой Form.xml не совпадает с переданным witness.'); }
}

function isFormMetadataKind(type: string): boolean { return type === 'Form' || type === 'CommonForm'; }

function projectSideBaseForm(
  root: XmlElement,
  adopted: boolean,
  side: 'target' | 'source',
  formatVersion: string,
  baseItems: Map<string, XmlElement>,
  issues: AdoptedDesignerProjectionIssue[],
): void {
  const bases = direct(root, 'BaseForm');
  if (!adopted) {
    if (bases.length > 0) { throw new Error('Собственная Form.xml или captured CF base не должна содержать BaseForm.'); }
    return;
  }
  if (bases.length !== 1 || lastElement(root) !== bases[0]) {
    throw new Error('Заимствованная Form.xml должна содержать ровно один прямой BaseForm последним элементом.');
  }
  if (attribute(bases[0]!, 'version') !== formatVersion) {
    throw new Error('Версия BaseForm не совпадает с версией формы.');
  }
  validateBaseFormItems(bases[0]!, baseItems, side, issues);
  validateMainItemIdentities(root, baseItems, side, issues);
  remove(root, bases[0]!);
}

function parseForm(xml: Buffer, version: string): XmlDocument {
  const document = parseXmlDocument(xml.toString('utf8'));
  const root = document.root;
  if (root.localName !== 'Form') { throw new Error('Ожидался корневой элемент Form.'); }
  if (attribute(root, 'version') !== version) { throw new Error('Версия Form.xml не совпадает с подтверждённой версией Designer.'); }
  const namespace = namespaceUri(root, false);
  if (namespace !== LOGFORM_NAMESPACE) { throw new Error('Form.xml использует неожиданный XML namespace.'); }
  return document;
}

function buildBaseItemMap(root: XmlElement): Map<string, XmlElement> {
  const result = new Map<string, XmlElement>();
  const seenIds = new Set<string>();
  for (const element of mainDescendants(root)) {
    if (element === root) { continue; }
    const id = attribute(element, 'id');
    if (id === undefined) { continue; }
    const scopeKey = `${formItemScope(element)}\0${id}`;
    const key = formItemIdentity(element, id);
    if (seenIds.has(scopeKey)) {
      throw new Error(`Base Form содержит повторяющийся element id=${id}; semantic mapping неоднозначен.`);
    }
    seenIds.add(scopeKey);
    result.set(key, element);
  }
  return result;
}

function validateBaseFormItems(
  baseForm: XmlElement,
  baseItems: ReadonlyMap<string, XmlElement>,
  side: 'target' | 'source',
  issues: AdoptedDesignerProjectionIssue[],
): void {
  const seen = new Set<string>();
  const baseByScopeAndId = new Map<string, string>();
  for (const identity of baseItems.keys()) {
    const [scope, id] = identity.split('\0');
    if (scope !== undefined && id !== undefined) { baseByScopeAndId.set(`${scope}\0${id}`, identity); }
  }
  for (const element of descendants(baseForm)) {
    if (element === baseForm) { continue; }
    const id = attribute(element, 'id');
    if (id === undefined) { continue; }
    const scopeKey = `${formItemScope(element, true)}\0${id}`;
    const identity = formItemIdentity(element, id, true);
    if (seen.has(scopeKey)) {
      issues.push({ side, identityKey: `id=${id}`, reason: 'BaseForm содержит повторяющийся element identity.' });
      continue;
    }
    seen.add(scopeKey);
    const currentIdentity = baseByScopeAndId.get(`${formItemScope(element, true)}\0${id}`);
    if (currentIdentity && currentIdentity !== identity) {
      issues.push({ side, identityKey: `id=${id}`, reason: 'BaseForm повторно использует captured base element id для другого expanded element name.' });
    }
  }
}

function validateMainItemIdentities(
  root: XmlElement,
  baseItems: ReadonlyMap<string, XmlElement>,
  side: 'target' | 'source',
  issues: AdoptedDesignerProjectionIssue[],
): void {
  const ids = new Map<string, XmlElement>();
  const baseByScopeAndId = new Map<string, string>();
  for (const [identity, base] of baseItems) {
    const baseId = attribute(base, 'id');
    if (baseId !== undefined) { baseByScopeAndId.set(`${formItemScope(base)}\0${baseId}`, identity); }
  }
  for (const element of mainDescendants(root)) {
    if (element === root) { continue; }
    const id = attribute(element, 'id');
    if (id === undefined) { continue; }
    const scopeKey = `${formItemScope(element)}\0${id}`;
    const existing = ids.get(scopeKey);
    if (existing) {
      issues.push({ side, identityKey: `id=${id}`, reason: 'Main Form содержит повторяющийся element id.' });
      continue;
    }
    ids.set(scopeKey, element);
    const baseIdentity = baseByScopeAndId.get(scopeKey);
    if (baseIdentity && baseIdentity !== formItemIdentity(element, id)) {
      issues.push({ side, identityKey: `id=${id}`, reason: 'Main Form переиспользует base id для другого expanded element name.' });
    }
  }
}

function compareFormOwnershipIdentities(
  before: XmlElement,
  merged: XmlElement,
  baseItems: ReadonlyMap<string, XmlElement>,
  targetAdopted: boolean,
): string | undefined {
  const beforeItems = elementsByIdentity(before);
  const mergedItems = elementsByIdentity(merged);
  for (const [identity, element] of beforeItems) {
    const base = baseItems.get(identity);
    const after = mergedItems.get(identity);
    if (!after && targetAdopted && base) {
      return `Выбранное изменение удаляет унаследованный BaseForm element ${identity}; CFE overlay не может доказать такую операцию.`;
    }
    if (after && !same(attribute(element, 'id'), attribute(after, 'id'))) {
      return `Выбранное изменение меняет target Form element id у ${identity}.`;
    }
  }
  return undefined;
}

function elementsByIdentity(root: XmlElement): Map<string, XmlElement> {
  const result = new Map<string, XmlElement>();
  for (const element of mainDescendants(root)) {
    if (element === root) { continue; }
    const id = attribute(element, 'id');
    if (id !== undefined) { result.set(formItemIdentity(element, id), element); }
  }
  return result;
}

function formItemIdentity(element: XmlElement, id: string, normalizeBaseForm = false): string {
  return `${formItemScope(element, normalizeBaseForm)}\0${id}\0${expandedName(element)}`;
}

function formItemScope(element: XmlElement, normalizeBaseForm = false): string {
  let current: XmlElement | undefined = element.parent;
  let inBaseForm = false;
  let scope = 'Form';
  while (current) {
    if (isFormElement(current, 'BaseForm')) { inBaseForm = true; }
    if (scope === 'Form' && ['ChildItems', 'Attributes', 'Commands', 'Parameters'].some((name) => isFormElement(current!, name))) {
      scope = current.localName;
    }
    current = current.parent;
  }
  return inBaseForm && !normalizeBaseForm ? `BaseForm/${scope}` : scope;
}

function expandedName(element: XmlElement): string {
  const uri = namespaceUri(element, false);
  return uri ? `{${uri}}${element.localName}` : element.localName;
}

function namespaceUri(element: XmlElement, attributeName: boolean): string | undefined {
  const colon = element.name.indexOf(':');
  const prefix = colon < 0 ? '' : element.name.slice(0, colon);
  if (attributeName && !prefix) { return undefined; }
  const declarationName = prefix ? `xmlns:${prefix}` : 'xmlns';
  let current: XmlElement | undefined = element;
  while (current) {
    const declaration = current.attributes.find((item) => item.name === declarationName);
    if (declaration) { return declaration.value || undefined; }
    current = current.parent;
  }
  return undefined;
}

function baseFormWitness(input: AdoptedDesignerFormProjectionInput): MergeFileWitness {
  return {
    sourceId: input.baseFormSourceId,
    relativePath: input.baseFormRelativePath.replace(/\\/gu, '/'),
    expectedHash: input.baseFormHash.replace(/^sha256:/iu, '').toLowerCase(),
    kind: 'file',
  };
}

function safeRelativePath(value: string): boolean {
  const normalized = value.replace(/\\/gu, '/');
  return normalized.length > 0 && !normalized.startsWith('/') && !/^[a-z]:/iu.test(normalized)
    && !normalized.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}

function lastElement(parent: XmlElement): XmlElement | undefined {
  const children = elementChildren(parent);
  return children[children.length - 1];
}

function direct(parent: XmlElement, name: string): XmlElement[] {
  return elementChildren(parent).filter((child) => child.localName === name && namespaceUri(child, false) === LOGFORM_NAMESPACE);
}

function isFormElement(element: XmlElement, name: string): boolean {
  return element.localName === name && namespaceUri(element, false) === LOGFORM_NAMESPACE;
}

function collectForeignBaseFormIssues(
  root: XmlElement,
  identity: AdoptedDesignerIdentity,
  side: 'target' | 'source',
  issues: AdoptedDesignerProjectionIssue[],
): void {
  for (const candidate of elementChildren(root)) {
    if (candidate.localName === 'BaseForm' && !isFormElement(candidate, 'BaseForm')) {
      issues.push({ side, identityKey: `root=${identity.type}.${identity.name}`, reason: 'BaseForm lookalike uses a foreign XML namespace and is not treated as a borrowed base snapshot.' });
    }
  }
}

function attribute(element: XmlElement, name: string): string | undefined {
  return element.attributes.find((item) => item.name === name)?.value;
}

function remove(parent: XmlElement, child: XmlElement): void {
  parent.children = parent.children.filter((candidate) => candidate !== child);
}

function descendants(root: XmlElement): XmlElement[] {
  const result: XmlElement[] = [];
  const visit = (element: XmlElement) => { result.push(element); for (const child of elementChildren(element)) { visit(child); } };
  visit(root);
  return result;
}

function mainDescendants(root: XmlElement): XmlElement[] {
  const result: XmlElement[] = [];
  const visit = (element: XmlElement) => {
    result.push(element);
    for (const child of elementChildren(element)) {
      if (!isFormElement(child, 'BaseForm')) { visit(child); }
    }
  };
  visit(root);
  return result;
}

function same(left: string | undefined, right: string | undefined): boolean {
  return left?.normalize('NFC').toLocaleLowerCase('en-US') === right?.normalize('NFC').toLocaleLowerCase('en-US');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
