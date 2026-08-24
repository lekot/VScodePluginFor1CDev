import { XMLParser } from 'fast-xml-parser';
import { CfeFormError, type CfeFormCallType, type CfeFormFormatVersion } from './formTypes';

export type CfeFormXmlNode = CfeFormXmlElement | CfeFormXmlText | CfeFormXmlComment;

export interface CfeFormXmlElement {
  readonly kind: 'element';
  name: string;
  attributes: Record<string, string>;
  children: CfeFormXmlNode[];
}

export interface CfeFormXmlText {
  readonly kind: 'text';
  text: string;
}

export interface CfeFormXmlComment {
  readonly kind: 'comment';
  text: string;
}

export interface CfeFormXmlDocument {
  root: CfeFormXmlElement;
}

const PARSER_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  commentPropName: '#comment',
  preserveOrder: true,
  ignoreDeclaration: false,
  trimValues: false,
  processEntities: true,
} as const;

const parser = new XMLParser(PARSER_OPTIONS);

/** Parses XML into a deliberately small ordered tree used only by the CFE form domain. */
export function parseCfeFormXml(xml: string): CfeFormXmlDocument {
  const document = parseCfeOrderedXml(xml, 'Form');
  return document;
}

/** Parses a small ordered XML document; metadata wrappers share the same lossless ordering model. */
export function parseCfeOrderedXml(xml: string, expectedRootName?: string): CfeFormXmlDocument {
  let parsed: unknown;
  try {
    parsed = parser.parse(xml);
  } catch (error) {
    throw new CfeFormError('CFE_OWNERSHIP_INVALID', `Не удалось разобрать Form.xml: ${message(error)}`);
  }
  const roots = Array.isArray(parsed) ? parsed : [parsed];
  for (const candidate of roots) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      continue;
    }
    const record = candidate as Record<string, unknown>;
    for (const [name, content] of Object.entries(record)) {
      if (name === ':@' || name.startsWith('?') || name.startsWith('#')) {
        continue;
      }
      if (expectedRootName !== undefined && localName(name) !== expectedRootName) {
        continue;
      }
      return { root: toElement(name, content, record) };
    }
  }
  throw new CfeFormError(
    'CFE_OWNERSHIP_INVALID',
    expectedRootName === 'Form'
      ? 'В Form.xml отсутствует корневой элемент Form.'
      : 'XML-документ не содержит ожидаемого корневого элемента.',
  );
}

/** Serializes an ordered CFE form tree with a deterministic Designer-compatible UTF-8 document shape. */
export function serializeCfeFormXml(document: CfeFormXmlDocument): string {
  return `\uFEFF<?xml version="1.0" encoding="UTF-8"?>\r\n${serializeElement(document.root, 0)}\r\n`;
}

export function createXmlElement(
  name: string,
  attributes: Record<string, string> = {},
  children: CfeFormXmlNode[] = [],
): CfeFormXmlElement {
  return { kind: 'element', name, attributes: { ...attributes }, children };
}

export function createXmlText(text: string): CfeFormXmlText {
  return { kind: 'text', text };
}

export function cloneXmlElement(element: CfeFormXmlElement): CfeFormXmlElement {
  return {
    kind: 'element',
    name: element.name,
    attributes: { ...element.attributes },
    children: element.children.map(cloneXmlNode),
  };
}

export function directChildren(element: CfeFormXmlElement, name?: string): CfeFormXmlElement[] {
  return element.children.filter((child): child is CfeFormXmlElement => (
    child.kind === 'element' && (name === undefined || localName(child.name) === name)
  ));
}

export function firstDirectChild(element: CfeFormXmlElement, name: string): CfeFormXmlElement | undefined {
  return directChildren(element, name)[0];
}

export function findNamedElement(
  element: CfeFormXmlElement,
  name: string,
): CfeFormXmlElement | undefined {
  if (element.attributes.name === name) {
    return element;
  }
  for (const child of directChildren(element)) {
    const found = findNamedElement(child, name);
    if (found) {
      return found;
    }
  }
  return undefined;
}

export function findElementsByLocalName(
  element: CfeFormXmlElement,
  name: string,
): CfeFormXmlElement[] {
  const found: CfeFormXmlElement[] = [];
  visitElements(element, (candidate) => {
    if (localName(candidate.name) === name) {
      found.push(candidate);
    }
  });
  return found;
}

export function textContent(element: CfeFormXmlElement): string {
  return element.children
    .filter((child): child is CfeFormXmlText => child.kind === 'text')
    .map((child) => child.text)
    .join('')
    .trim();
}

export function setTextContent(element: CfeFormXmlElement, text: string): void {
  element.children = [createXmlText(text)];
}

export function upsertTextElement(
  parent: CfeFormXmlElement,
  name: string,
  text: string,
): CfeFormXmlElement {
  const existing = firstDirectChild(parent, name);
  if (existing) {
    setTextContent(existing, text);
    return existing;
  }
  const created = createXmlElement(name, {}, [createXmlText(text)]);
  parent.children.push(created);
  return created;
}

export function removeDirectChildren(parent: CfeFormXmlElement, name: string): void {
  parent.children = parent.children.filter((child) => child.kind !== 'element' || localName(child.name) !== name);
}

export function ensureSectionBefore(
  form: CfeFormXmlElement,
  sectionName: string,
  beforeName: string,
): CfeFormXmlElement {
  return ensureSectionBeforeAny(form, sectionName, [beforeName]);
}

export function ensureSectionBeforeAny(
  form: CfeFormXmlElement,
  sectionName: string,
  beforeNames: readonly string[],
): CfeFormXmlElement {
  const existing = firstDirectChild(form, sectionName);
  if (existing) {
    return existing;
  }
  const section = createXmlElement(sectionName);
  const before = new Set(beforeNames);
  const index = form.children.findIndex((child) => child.kind === 'element' && before.has(localName(child.name)));
  if (index === -1) {
    form.children.push(section);
  } else {
    form.children.splice(index, 0, section);
  }
  return section;
}

/** Keeps the platform-required form shape: Part1 first, BaseForm exactly once and last. */
export function ensureBaseFormLast(form: CfeFormXmlElement, version: CfeFormFormatVersion): CfeFormXmlElement {
  const bases = directChildren(form, 'BaseForm');
  if (bases.length > 1) {
    throw new CfeFormError('CFE_OWNERSHIP_INVALID', 'Заимствованная форма содержит несколько BaseForm.');
  }
  let base = bases[0];
  if (!base) {
    base = createXmlElement('BaseForm', { version });
  }
  base.attributes.version = version;
  form.children = form.children.filter((child) => child !== base && (child.kind !== 'element' || localName(child.name) !== 'BaseForm'));
  form.children.push(base);
  return base;
}

/** Removes parts which must never be copied into the BaseForm section. */
export function stripBaseFormMutations(base: CfeFormXmlElement): void {
  removeDirectChildren(base, 'Events');
  removeDirectChildren(base, 'Commands');
  removeDirectChildren(base, 'Parameters');
  removeDirectChildren(base, 'CommandInterface');
}

/**
 * Removes source element events and bindings that cannot be represented in the
 * extension. A DataPath rooted at a proven borrowed main attribute is retained;
 * `Items.*` stays forbidden because it is not a UUID-resolved CFE binding.
 */
export function sanitizeBorrowedBasePart(
  element: CfeFormXmlElement,
  allowedDataPathRoots: ReadonlySet<string> = new Set<string>(),
): void {
  for (const child of directChildren(element)) {
    if (localName(child.name) === 'Events') {
      element.children = element.children.filter((candidate) => candidate !== child);
      continue;
    }
    if (localName(child.name) === 'TypeLink' && hasItemsDataPath(child)) {
      element.children = element.children.filter((candidate) => candidate !== child);
      continue;
    }
    if (
      (localName(child.name) === 'DataPath' || localName(child.name) === 'TitleDataPath')
      && !isRetainedDataPath(textContent(child), allowedDataPathRoots)
    ) {
      element.children = element.children.filter((candidate) => candidate !== child);
      continue;
    }
    sanitizeBorrowedBasePart(child, allowedDataPathRoots);
  }
}

export function appendOrVerifyEvent(
  parent: CfeFormXmlElement,
  eventName: string,
  handler: string,
  callType: CfeFormCallType,
): 'added' | 'unchanged' {
  const events = localName(parent.name) === 'Form'
    ? ensureSectionBeforeAny(parent, 'Events', ['ChildItems', 'Attributes', 'Commands', 'Parameters', 'CommandInterface', 'BaseForm'])
    : ensureSectionBefore(parent, 'Events', 'ChildItems');
  for (const event of directChildren(events, 'Event')) {
    if (event.attributes.name !== eventName || event.attributes.callType !== callType) {
      continue;
    }
    if (textContent(event) === handler) {
      return 'unchanged';
    }
    throw new CfeFormError('CFE_VALIDATION_FAILED', `Событие «${eventName}» с callType=${callType} уже связано с другим обработчиком.`);
  }
  events.children.push(createXmlElement('Event', { name: eventName, callType }, [createXmlText(handler)]));
  return 'added';
}

export function appendOrVerifyAction(
  command: CfeFormXmlElement,
  handler: string,
  callType: CfeFormCallType,
): 'added' | 'unchanged' {
  for (const action of directChildren(command, 'Action')) {
    if (action.attributes.callType !== callType) {
      continue;
    }
    if (textContent(action) === handler) {
      return 'unchanged';
    }
    throw new CfeFormError('CFE_VALIDATION_FAILED', `Команда «${command.attributes.name ?? ''}» уже имеет другое действие с callType=${callType}.`);
  }
  command.children.push(createXmlElement('Action', { callType }, [createXmlText(handler)]));
  return 'added';
}

/** Allocates extension-owned IDs monotonically without touching or reusing base IDs. */
export function allocateExtensionFormId(form: CfeFormXmlElement): string {
  let largest = 999_999;
  visitElements(form, (element) => {
    const value = element.attributes.id;
    if (value === undefined || !/^\d+$/u.test(value)) {
      return;
    }
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed >= 1_000_000) {
      largest = Math.max(largest, parsed);
    }
  });
  if (largest >= Number.MAX_SAFE_INTEGER) {
    throw new CfeFormError('CFE_FORM_ID_EXHAUSTED', 'Исчерпан диапазон идентификаторов элементов формы CFE.');
  }
  return String(largest + 1);
}

export function localName(name: string): string {
  const separator = name.lastIndexOf(':');
  return separator === -1 ? name : name.slice(separator + 1);
}

function toElement(name: string, content: unknown, wrapper: Record<string, unknown>): CfeFormXmlElement {
  return {
    kind: 'element',
    name,
    attributes: attributesFrom(wrapper[':@']),
    children: toNodes(content),
  };
}

function toNodes(value: unknown): CfeFormXmlNode[] {
  const items = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const nodes: CfeFormXmlNode[] = [];
  for (const item of items) {
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      nodes.push(createXmlText(String(item)));
      continue;
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    for (const [name, content] of Object.entries(record)) {
      if (name === ':@' || name.startsWith('?')) {
        continue;
      }
      if (name === '#text' || name === '#cdata') {
        nodes.push(createXmlText(String(content ?? '')));
        continue;
      }
      if (name === '#comment') {
        nodes.push({ kind: 'comment', text: String(content ?? '') });
        continue;
      }
      if (name.startsWith('#')) {
        continue;
      }
      nodes.push(toElement(name, content, record));
    }
  }
  return nodes;
}

function attributesFrom(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const attributes: Record<string, string> = {};
  for (const [name, content] of Object.entries(value as Record<string, unknown>)) {
    const normalized = name.startsWith('@_') ? name.slice(2) : name;
    attributes[normalized] = String(content);
  }
  return attributes;
}

function cloneXmlNode(node: CfeFormXmlNode): CfeFormXmlNode {
  switch (node.kind) {
    case 'element': return cloneXmlElement(node);
    case 'text': return createXmlText(node.text);
    case 'comment': return { kind: 'comment', text: node.text };
  }
}

function serializeElement(element: CfeFormXmlElement, depth: number): string {
  const indent = '\t'.repeat(depth);
  const attributes = Object.entries(element.attributes)
    .map(([name, value]) => ` ${name}="${escapeXml(value)}"`)
    .join('');
  const semanticChildren = element.children.filter((child) => child.kind !== 'text' || child.text.trim() !== '');
  if (semanticChildren.length === 0) {
    return `${indent}<${element.name}${attributes}/>`;
  }
  if (semanticChildren.every((child) => child.kind === 'text')) {
    return `${indent}<${element.name}${attributes}>${semanticChildren.map((child) => escapeXml((child as CfeFormXmlText).text)).join('')}</${element.name}>`;
  }
  const lines = [`${indent}<${element.name}${attributes}>`];
  for (const child of semanticChildren) {
    if (child.kind === 'element') {
      lines.push(serializeElement(child, depth + 1));
    } else if (child.kind === 'comment') {
      lines.push(`${'\t'.repeat(depth + 1)}<!--${child.text}-->`);
    } else {
      lines.push(`${'\t'.repeat(depth + 1)}${escapeXml(child.text)}`);
    }
  }
  lines.push(`${indent}</${element.name}>`);
  return lines.join('\r\n');
}

function visitElements(element: CfeFormXmlElement, visit: (candidate: CfeFormXmlElement) => void): void {
  visit(element);
  for (const child of directChildren(element)) {
    visitElements(child, visit);
  }
}

function hasItemsDataPath(typeLink: CfeFormXmlElement): boolean {
  return findElementsByLocalName(typeLink, 'DataPath')
    .some((dataPath) => /^Items\./u.test(textContent(dataPath)));
}

function isRetainedDataPath(value: string, allowedRoots: ReadonlySet<string>): boolean {
  if (!value || /^Items(?:\.|$)/u.test(value)) {
    return false;
  }
  const root = value.split('.', 1)[0] ?? '';
  return allowedRoots.has(root);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
