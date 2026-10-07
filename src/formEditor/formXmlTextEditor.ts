/**
 * Source-preserving edits for managed form XML.
 *
 * The source-offset scanner and splice approach is adapted from BslEdit
 * v2.0.0, `packages/1c-preview-core/browser/form-edit.js` (MIT). Form element
 * structure follows cc-1c-skills (MIT, Nick Shirokov,
 * https://github.com/Nikolay-Shirokov/cc-1c-skills).
 */

import { XMLValidator } from 'fast-xml-parser';
import { createHash } from 'crypto';
import type { FormAttribute, FormChildItem, FormCommand, FormEventItem, FormModel } from './formModel';

export interface FormXmlSelector {
  id?: string;
  name?: string;
}

export type FormXmlEdit =
  | { type: 'setProperties'; element: FormXmlSelector; properties: Record<string, unknown> }
  | { type: 'setElementIdentity'; element: FormXmlSelector; name?: string; id?: string }
  | { type: 'setElementEvents'; element: FormXmlSelector; events: Record<string, string> }
  | { type: 'setFormEvents'; events: FormEventItem[] }
  | { type: 'addElement'; parent?: FormXmlSelector; index: number; item: FormChildItem }
  | { type: 'moveElement'; element: FormXmlSelector; parent?: FormXmlSelector; index: number }
  | { type: 'removeElement'; element: FormXmlSelector }
  | {
      type: 'setAttribute';
      action: 'upsert' | 'remove';
      selector?: FormXmlSelector;
      name?: string;
      id?: string;
      properties?: Record<string, unknown>;
    }
  | {
      type: 'setCommand';
      action: 'upsert' | 'remove';
      selector?: FormXmlSelector;
      name?: string;
      id?: string;
      properties?: Record<string, unknown>;
    };

/** Captured raw source and semantic baseline for a single open form document. */
export interface FormXmlSourceSnapshot {
  source: Buffer;
  text: string;
  sha256: string;
  baseline: FormModel;
}

interface AttributeSpan {
  name: string;
  value: string;
  valueStart: number;
  valueEnd: number;
  quote: '"' | "'";
}

interface XmlNode {
  tag: string;
  localName: string;
  attributes: Map<string, AttributeSpan>;
  start: number;
  openEnd: number;
  closeStart: number;
  end: number;
  selfClosing: boolean;
  parent?: XmlNode;
  children: XmlNode[];
}

interface XmlDocument {
  root: XmlNode;
  nodes: XmlNode[];
}

const STRUCTURAL_ITEM_NODES = new Set([
  'ContextMenu', 'ExtendedTooltip', 'AutoCommandBar', 'SearchStringAddition',
  'ViewStatusAddition', 'SearchControlAddition', 'Events', 'ChildItems',
]);

const FORM_SECTION_ORDER = [
  'Title', 'AutoTitle', 'CommandBarLocation', 'CommandSet', 'WindowOpeningMode',
  'AutoCommandBar', 'ChildItems', 'Events', 'Attributes', 'Commands', 'Parameters',
  'CommandInterface', 'BaseForm',
];

const COMPANIONS: Readonly<Record<string, readonly string[]>> = {
  InputField: ['ContextMenu', 'ExtendedTooltip'],
  CheckBoxField: ['ContextMenu', 'ExtendedTooltip'],
  RadioButtonField: ['ContextMenu', 'ExtendedTooltip'],
  LabelField: ['ContextMenu', 'ExtendedTooltip'],
  LabelDecoration: ['ContextMenu', 'ExtendedTooltip'],
  PictureField: ['ContextMenu', 'ExtendedTooltip'],
  PictureDecoration: ['ContextMenu', 'ExtendedTooltip'],
  CalendarField: ['ContextMenu', 'ExtendedTooltip'],
  TextDocumentField: ['ContextMenu', 'ExtendedTooltip'],
  SpreadSheetDocumentField: ['ContextMenu', 'ExtendedTooltip'],
  FormattedDocumentField: ['ContextMenu', 'ExtendedTooltip'],
  ChartField: ['ContextMenu', 'ExtendedTooltip'],
  Table: ['ContextMenu', 'AutoCommandBar', 'ExtendedTooltip', 'SearchStringAddition', 'ViewStatusAddition', 'SearchControlAddition'],
  UsualGroup: ['ExtendedTooltip'],
  ColumnGroup: ['ExtendedTooltip'],
  Pages: ['ExtendedTooltip'],
  Page: ['ExtendedTooltip'],
  Button: ['ExtendedTooltip'],
  ButtonGroup: ['ExtendedTooltip'],
  Popup: ['ExtendedTooltip'],
  CommandBar: ['ExtendedTooltip'],
};

const COMPANION_SUFFIX_RU: Readonly<Record<string, string>> = {
  ContextMenu: 'КонтекстноеМеню',
  ExtendedTooltip: 'РасширеннаяПодсказка',
  AutoCommandBar: 'КоманднаяПанель',
  SearchStringAddition: 'СтрокаПоиска',
  ViewStatusAddition: 'СостояниеПросмотра',
  SearchControlAddition: 'УправлениеПоиском',
};

const COMPANION_SUFFIX_EN: Readonly<Record<string, string>> = {
  ContextMenu: 'ContextMenu',
  ExtendedTooltip: 'ExtendedTooltip',
  AutoCommandBar: 'CommandBar',
  SearchStringAddition: 'SearchString',
  ViewStatusAddition: 'ViewStatus',
  SearchControlAddition: 'SearchControl',
};

export class FormXmlEditError extends Error {
  readonly code = 'FORM_XML_EDIT_UNSUPPORTED';

  constructor(message: string) {
    super(message);
    this.name = 'FormXmlEditError';
  }
}

/** Hash the raw bytes supplied by the caller, retaining UTF-8 BOM and CRLF. */
export function createFormXmlSourceSnapshot(source: Buffer, baseline: FormModel): FormXmlSourceSnapshot {
  const text = source.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(source)) {
    throw new FormXmlEditError('Form.xml не является корректным UTF-8; сохранение остановлено без изменения файла.');
  }
  const copy = Buffer.from(source);
  return {
    source: copy,
    text,
    sha256: sha256(copy),
    baseline: cloneFormModel(baseline),
  };
}

/**
 * Calculate deterministic source edits between a loaded baseline and the current UI model.
 * Raw top-level sections that are not modeled as editable form operations fail closed.
 */
export function diffFormModels(baseline: FormModel, current: FormModel): FormXmlEdit[] {
  assertUnchangedUnsupportedFields(baseline, current);
  const edits: FormXmlEdit[] = [];

  edits.push(...diffMembers(baseline.attributes ?? [], current.attributes ?? [], 'setAttribute'));
  edits.push(...diffMembers(baseline.commands ?? [], current.commands ?? [], 'setCommand'));

  if (!deepEqual(baseline.formEvents ?? [], current.formEvents ?? [])) {
    edits.push({ type: 'setFormEvents', events: cloneValue(current.formEvents ?? []) });
  }

  const oldItems = flattenItems(baseline.childItemsRoot ?? []);
  const newItems = flattenItems(current.childItemsRoot ?? []);
  const matches = matchItems(oldItems, newItems);
  const oldMatched = new Set(matches.map((pair) => pair.oldItem));
  const newMatched = new Set(matches.map((pair) => pair.newItem));
  const oldForNew = new Map(matches.map((pair) => [pair.newItem, pair.oldItem]));
  const newForOld = new Map(matches.map((pair) => [pair.oldItem, pair.newItem]));

  for (const { oldItem, newItem } of matches) {
    const selector = selectorFor(oldItem);
    const properties = diffProperties(oldItem.properties ?? {}, newItem.properties ?? {});
    if (Object.keys(properties).length > 0) {
      edits.push({ type: 'setProperties', element: selector, properties });
    }
    if (!deepEqual(oldItem.events ?? {}, newItem.events ?? {})) {
      edits.push({ type: 'setElementEvents', element: selector, events: cloneValue(newItem.events ?? {}) });
    }
    if (oldItem.name !== newItem.name || oldItem.id !== newItem.id) {
      edits.push({ type: 'setElementIdentity', element: selector, name: newItem.name, id: newItem.id });
    }
  }

  // Delete only removed roots. Descendants are included in their ancestor's source span.
  const removed = oldItems.filter((item) => !oldMatched.has(item.item));
  const removedSet = new Set(removed.map((item) => item.item));
  const removedRoots = [...removed]
    .filter((item) => !item.parent || !removedSet.has(item.parent))
    .sort((a, b) => b.depth - a.depth || b.index - a.index);

  // Add only new roots. New descendants are serialized with the root; existing descendants
  // are moved into place in the next step.
  const newItemSet = new Set(newItems.filter((item) => !newMatched.has(item.item)).map((item) => item.item));
  for (const item of newItems.filter((entry) => !newMatched.has(entry.item))) {
    if (item.parent && newItemSet.has(item.parent)) { continue; }
    const subtree = cloneItemWithNewDescendantsOnly(item.item, newMatched);
    edits.push({
      type: 'addElement',
      parent: item.parent ? selectorFor(item.parent) : undefined,
      index: item.index,
      item: subtree,
    });
  }

  // Create destinations before moving survivors out of ancestors slated for deletion.
  // These temporary root moves prevent deleting a removed ancestor from deleting a child
  // that has been reparented in the current model.
  for (const item of newItems) {
    if (!newMatched.has(item.item)) { continue; }
    const oldItem = oldForNew.get(item.item);
    if (!oldItem) { continue; }
    const oldEntry = oldItems.find((entry) => entry.item === oldItem);
    let ancestor = oldEntry?.parent;
    let escapesRemovedAncestor = false;
    while (ancestor) {
      if (removedSet.has(ancestor)) { escapesRemovedAncestor = true; break; }
      ancestor = oldItems.find((entry) => entry.item === ancestor)?.parent;
    }
    if (escapesRemovedAncestor) {
      edits.push({ type: 'moveElement', element: selectorFor(item.item), index: Number.MAX_SAFE_INTEGER });
    }
  }
  for (const item of removedRoots) {
    edits.push({ type: 'removeElement', element: selectorFor(item.item) });
  }

  // Reparent surviving nodes after removals, so target indexes are calculated against the
  // final set of siblings.
  for (const item of newItems) {
    if (!newMatched.has(item.item)) { continue; }
    const oldItem = oldForNew.get(item.item);
    if (!oldItem) { continue; }
    const oldParent = oldItems.find((entry) => entry.item === oldItem)?.parent;
    const parentHadBaseline = item.parent === undefined || oldForNew.has(item.parent);
    const targetOldParent = item.parent ? oldForNew.get(item.parent) : undefined;
    const changedParent = !parentHadBaseline || oldParent !== targetOldParent;
    if (changedParent) {
      edits.push({
        type: 'moveElement',
        element: selectorFor(item.item),
        parent: item.parent ? selectorFor(item.parent) : undefined,
        index: item.index,
      });
    }
  }

  // Preserve the existing sequence unless the relative order of surviving siblings changed.
  const parentItems = new Set<FormChildItem | undefined>(newItems.map((entry) => entry.parent));
  for (const parent of parentItems) {
    if (parent && !oldForNew.has(parent)) { continue; }
    const targetOldParent = parent ? oldForNew.get(parent) : undefined;
    const oldOrder = oldItems
      .filter((entry) => entry.parent === targetOldParent)
      .map((entry) => newForOld.get(entry.item))
      .filter((item): item is FormChildItem => Boolean(item))
      .filter((item) => newItems.find((entry) => entry.item === item)?.parent === parent);
    const newOrder = newItems
      .filter((entry) => entry.parent === parent && newMatched.has(entry.item))
      .filter((entry) => {
        const oldItem = oldForNew.get(entry.item);
        return Boolean(oldItem) && oldItems.find((oldEntry) => oldEntry.item === oldItem)?.parent === targetOldParent;
      })
      .map((entry) => entry.item);
    if (oldOrder.length !== newOrder.length || oldOrder.some((item, index) => item !== newOrder[index])) {
      for (const item of newItems.filter((entry) => entry.parent === parent && newMatched.has(entry.item))) {
        edits.push({
          type: 'moveElement',
          element: selectorFor(item.item),
          parent: parent ? selectorFor(parent) : undefined,
          index: item.index,
        });
      }
    }
  }

  return edits;
}

/** Apply source edits without I/O or VS Code dependencies; final XML is always validated. */
export function applyFormXmlEdits(xml: string, edits: readonly FormXmlEdit[]): string {
  validateXml(xml);
  let output = xml;
  for (const edit of edits) {
    output = applyOneEdit(output, edit);
  }
  validateXml(output);
  return output;
}

function applyOneEdit(xml: string, edit: FormXmlEdit): string {
  switch (edit.type) {
    case 'setProperties':
      return applySetProperties(xml, findFormItem(scanXml(xml), edit.element), edit.properties);
    case 'setElementIdentity':
      return setNodeIdentity(xml, findFormItem(scanXml(xml), edit.element), edit.name, edit.id);
    case 'setElementEvents':
      return setEvents(xml, findFormItem(scanXml(xml), edit.element), edit.events);
    case 'setFormEvents':
      return setEvents(xml, scanXml(xml).root, Object.fromEntries(edit.events.map((event) => [event.name, event.method])));
    case 'addElement':
      return addElement(xml, edit);
    case 'moveElement':
      return moveElement(xml, edit);
    case 'removeElement':
      return removeElement(xml, edit.element);
    case 'setAttribute':
      return applyMemberEdit(xml, 'Attributes', 'Attribute', edit);
    case 'setCommand':
      return applyMemberEdit(xml, 'Commands', 'Command', edit);
  }
}

function scanXml(xml: string): XmlDocument {
  const documentNodes: XmlNode[] = [];
  const stack: XmlNode[] = [];
  let position = 0;
  while (position < xml.length) {
    const opening = xml.indexOf('<', position);
    if (opening < 0) { break; }
    if (xml.startsWith('<!--', opening)) {
      const end = xml.indexOf('-->', opening + 4);
      if (end < 0) { throw malformed('незакрытый комментарий'); }
      position = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', opening)) {
      const end = xml.indexOf(']]>', opening + 9);
      if (end < 0) { throw malformed('незакрытый CDATA'); }
      position = end + 3;
      continue;
    }
    if (xml.startsWith('<?', opening)) {
      const end = xml.indexOf('?>', opening + 2);
      if (end < 0) { throw malformed('незакрытая processing instruction'); }
      position = end + 2;
      continue;
    }
    if (xml.startsWith('<!', opening)) {
      const end = findTagEnd(xml, opening + 2);
      position = end + 1;
      continue;
    }

    const end = findTagEnd(xml, opening + 1);
    const raw = xml.slice(opening, end + 1);
    const closing = /^<\s*\//.test(raw);
    if (closing) {
      const closingMatch = /^<\s*\/\s*([A-Za-z_][\w.:-]*)\s*>$/.exec(raw);
      if (!closingMatch) { throw malformed('некорректный закрывающий тег'); }
      const node = stack.pop();
      if (!node || node.tag !== closingMatch[1]) {
        throw malformed(`закрывающий тег </${closingMatch[1]}> не соответствует открывающему`);
      }
      node.closeStart = opening;
      node.end = end + 1;
      position = end + 1;
      continue;
    }

    const startMatch = /^<\s*([A-Za-z_][\w.:-]*)/.exec(raw);
    if (!startMatch) { throw malformed('некорректный открывающий тег'); }
    const tag = startMatch[1];
    const selfClosing = /\/\s*>$/.test(raw);
    const nameEnd = opening + startMatch[0].length;
    const tagAttrsEnd = end - (selfClosing ? 1 : 0);
    const attributes = parseAttributes(xml, nameEnd, tagAttrsEnd);
    const parent = stack[stack.length - 1];
    const node: XmlNode = {
      tag,
      localName: localName(tag),
      attributes,
      start: opening,
      openEnd: end + 1,
      closeStart: -1,
      end: selfClosing ? end + 1 : -1,
      selfClosing,
      parent,
      children: [],
    };
    if (parent) { parent.children.push(node); } else { documentNodes.push(node); }
    if (!selfClosing) { stack.push(node); }
    position = end + 1;
  }

  if (stack.length > 0) { throw malformed(`не закрыт тег <${stack[stack.length - 1].tag}>`); }
  const root = documentNodes.find((node) => node.localName === 'Form');
  if (!root) { throw malformed('не найден корневой элемент Form'); }
  return { root, nodes: documentNodes };
}

function parseAttributes(xml: string, start: number, end: number): Map<string, AttributeSpan> {
  const attrs = new Map<string, AttributeSpan>();
  let cursor = start;
  while (cursor < end) {
    while (cursor < end && /\s/.test(xml[cursor])) { cursor++; }
    if (cursor >= end || xml[cursor] === '/') { break; }
    const nameStart = cursor;
    while (cursor < end && !/[\s=/>]/.test(xml[cursor])) { cursor++; }
    if (cursor === nameStart) { throw malformed('некорректный атрибут'); }
    const name = xml.slice(nameStart, cursor);
    while (cursor < end && /\s/.test(xml[cursor])) { cursor++; }
    if (xml[cursor] !== '=') { throw malformed(`у атрибута ${name} отсутствует значение`); }
    cursor++;
    while (cursor < end && /\s/.test(xml[cursor])) { cursor++; }
    const quote = xml[cursor];
    if (quote !== '"' && quote !== "'") { throw malformed(`значение атрибута ${name} не заключено в кавычки`); }
    const valueStart = ++cursor;
    while (cursor < end && xml[cursor] !== quote) { cursor++; }
    if (cursor >= end) { throw malformed(`значение атрибута ${name} не закрыто`); }
    const valueEnd = cursor;
    const value = decodeXml(xml.slice(valueStart, valueEnd));
    if (attrs.has(name)) { throw malformed(`повторяется атрибут ${name}`); }
    attrs.set(name, { name, value, valueStart, valueEnd, quote });
    cursor++;
  }
  return attrs;
}

function findTagEnd(xml: string, from: number): number {
  let quote: string | undefined;
  for (let i = from; i < xml.length; i++) {
    const char = xml[i];
    if (quote) {
      if (char === quote) { quote = undefined; }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return i;
    }
  }
  throw malformed('незакрытый тег');
}

function validateXml(xml: string): void {
  const validation = XMLValidator.validate(xml, { allowBooleanAttributes: false });
  if (validation !== true) {
    const message = typeof validation === 'object' && validation.err
      ? `${validation.err.msg} (строка ${validation.err.line}, столбец ${validation.err.col})`
      : 'неизвестная ошибка XML';
    throw malformed(message);
  }
  scanXml(xml);
}

function applySetProperties(xml: string, node: XmlNode, properties: Record<string, unknown>): string {
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    throw new FormXmlEditError('Свойства формы должны быть объектом.');
  }
  for (const [property, value] of Object.entries(properties)) {
    if (!/^[A-Za-z][A-Za-z0-9:._-]*$/.test(property) || STRUCTURAL_ITEM_NODES.has(localName(property))) {
      throw new FormXmlEditError(`Недопустимое свойство формы: ${property}.`);
    }
    const current = scanXml(xml);
    const target = findCurrentNode(current, node);
    const matches = target.children.filter((child) => child.localName === localName(property));
    if (matches.length > 1) {
      throw new FormXmlEditError(`Свойство ${property} встречается несколько раз у «${nodeSelector(target).name ?? target.tag}».`);
    }
    const existing = matches[0];
    if (value === null || value === undefined) {
      if (existing) {
        const span = lineSpan(xml, existing);
        xml = splice(xml, span.start, span.end, '');
      }
      continue;
    }
    const inner = serializePropertyValue(value, xml, target);
    if (existing) {
      const previousInner = xml.slice(existing.openEnd, existing.selfClosing ? existing.end - 2 : existing.closeStart);
      if (previousInner.includes('<!--')) {
        throw new FormXmlEditError(`Свойство ${property} содержит комментарий; изменение остановлено, чтобы не потерять его.`);
      }
      const openTag = xml.slice(existing.start, existing.openEnd);
      const closingTag = existing.selfClosing ? `</${existing.tag}>` : xml.slice(existing.closeStart, existing.end);
      const normalizedOpen = existing.selfClosing ? openTag.replace(/\s*\/\s*>$/, '>') : openTag;
      const replacement = `${normalizedOpen}${inner}${closingTag}`;
      xml = splice(xml, existing.start, existing.end, replacement);
    } else {
      xml = insertProperty(xml, target, property, inner);
    }
  }
  return xml;
}

function serializePropertyValue(value: unknown, xml: string, parent: XmlNode): string {
  if (Array.isArray(value)) {
    if (value.every((entry) => isTextNode(entry))) {
      return value.map((entry) => escapeXmlText(String((entry as Record<string, unknown>)['#text'] ?? ''))).join('');
    }
    const outerIndent = indentOf(xml, parent);
    const propertyIndent = `${outerIndent}\t`;
    const childIndent = `${propertyIndent}\t`;
    const eol = eolOf(xml);
    return `${eol}${value.map((entry) => serializePreserveOrderNode(entry, childIndent, eol)).join('')}${propertyIndent}`;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return escapeXmlText(String(value));
  }
  throw new FormXmlEditError('Составное свойство формы не представлено в поддерживаемом формате; сохранение остановлено.');
}

function insertProperty(xml: string, parent: XmlNode, property: string, inner: string): string {
  const eol = eolOf(xml);
  const propertyIndent = `${indentOf(xml, parent)}\t`;
  const childNodes = parent.children;
  const structure = childNodes.find((node) => STRUCTURAL_ITEM_NODES.has(node.localName));
  const at = structure ? lineSpan(xml, structure).start : lineStart(xml, parent.closeStart);
  const local = localName(property);
  const text = `${propertyIndent}<${property}>${inner}</${property}>${eol}`;
  if (parent.selfClosing) {
    const opening = xml.slice(parent.start, parent.openEnd).replace(/\s*\/\s*>$/, '>');
    return splice(xml, parent.start, parent.end, `${opening}${eol}${text}${indentOf(xml, parent)}</${parent.tag}>`);
  }
  if (local && at === parent.closeStart && !/^[\t ]*$/.test(xml.slice(lineStart(xml, at), at))) {
    return splice(xml, at, at, `${eol}${text}${indentOf(xml, parent)}`);
  }
  return splice(xml, at, at, text);
}

function serializePreserveOrderNode(value: unknown, indent: string, eol: string): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new FormXmlEditError('Составное свойство содержит неподдерживаемый узел.');
  }
  const record = value as Record<string, unknown>;
  if (typeof record['#text'] === 'string' || typeof record['#text'] === 'number' || typeof record['#text'] === 'boolean') {
    return escapeXmlText(String(record['#text']));
  }
  const tag = Object.keys(record).find((key) => key !== ':@' && !key.startsWith('@'));
  if (!tag || !/^[A-Za-z_][\w.:-]*$/.test(tag)) {
    throw new FormXmlEditError('Составное свойство содержит недопустимое имя XML-узла.');
  }
  const attrs = record[':@'] && typeof record[':@'] === 'object'
    ? record[':@'] as Record<string, unknown>
    : {};
  const attrText = Object.entries(attrs)
    .filter(([key, attrValue]) => key.startsWith('@_') && attrValue !== undefined && attrValue !== null)
    .map(([key, attrValue]) => ` ${key.slice(2)}="${escapeXmlAttribute(String(attrValue))}"`)
    .join('');
  const children = record[tag];
  if (!Array.isArray(children) || children.length === 0) {
    return `${indent}<${tag}${attrText}/>${eol}`;
  }
  if (children.every((child) => isTextNode(child))) {
    const text = children.map((child) => escapeXmlText(String((child as Record<string, unknown>)['#text'] ?? ''))).join('');
    return `${indent}<${tag}${attrText}>${text}</${tag}>${eol}`;
  }
  const nested = children.map((child) => serializePreserveOrderNode(child, `${indent}\t`, eol)).join('');
  return `${indent}<${tag}${attrText}>${eol}${nested}${indent}</${tag}>${eol}`;
}

function applyEventsToNode(xml: string, owner: XmlNode, desired: Record<string, string>): string {
  const isRoot = owner.localName === 'Form';
  const ownerSelector = nodeSelector(owner);
  let document = scanXml(xml);
  let currentOwner = isRoot ? document.root : findFormItem(document, ownerSelector);
  const eventContainers = currentOwner.children.filter((node) => node.localName === 'Events');
  if (eventContainers.length > 1) { throw new FormXmlEditError('У элемента несколько секций Events; сохранение остановлено.'); }
  let eventsNode: XmlNode | undefined = eventContainers[0];
  const existing = eventsNode?.children.filter((node) => node.localName === 'Event') ?? [];
  const byName = new Map<string, XmlNode>();
  for (const event of existing) {
    const name = attributeValue(event, 'name');
    if (!name) { throw new FormXmlEditError('Найден Event без атрибута name.'); }
    if (byName.has(name)) { throw new FormXmlEditError(`Событие ${name} повторяется; сохранение остановлено.`); }
    byName.set(name, event);
  }
  for (const name of [...byName.keys()]) {
    if (!(name in desired)) {
      const current = scanXml(xml);
      const currentOwner = isRoot ? current.root : findFormItem(current, ownerSelector);
      const currentEvents = currentOwner.children.find((node) => node.localName === 'Events');
      const event = currentEvents?.children.find((node) => node.localName === 'Event' && attributeValue(node, 'name') === name);
      if (event) {
        const span = lineSpan(xml, event);
        xml = splice(xml, span.start, span.end, '');
      }
      byName.delete(name);
    }
  }

  document = scanXml(xml);
  currentOwner = isRoot ? document.root : findFormItem(document, ownerSelector);
  eventsNode = currentOwner.children.find((node) => node.localName === 'Events');
  if (!eventsNode && Object.keys(desired).length > 0) {
    xml = insertRootOrItemSection(xml, currentOwner, 'Events');
  }

  for (const [name, method] of Object.entries(desired)) {
    if (typeof method !== 'string') { throw new FormXmlEditError(`Обработчик ${name} должен быть строкой.`); }
    const current = scanXml(xml);
    const targetOwner = isRoot ? current.root : findFormItem(current, ownerSelector);
    eventsNode = targetOwner.children.find((node) => node.localName === 'Events');
    const target = eventsNode?.children.find((node) => node.localName === 'Event' && attributeValue(node, 'name') === name);
    if (target) {
      if (target.children.length > 0) { throw new FormXmlEditError(`Содержимое события ${name} не является простым текстом; сохранение остановлено.`); }
      const rawInner = xml.slice(target.openEnd, target.selfClosing ? target.end - 2 : target.closeStart);
      if (decodeXml(rawInner.trim()) === method) { continue; }
      const open = target.selfClosing
        ? xml.slice(target.start, target.openEnd).replace(/\s*\/\s*>$/, '>')
        : xml.slice(target.start, target.openEnd);
      const close = target.selfClosing ? `</${target.tag}>` : xml.slice(target.closeStart, target.end);
      xml = splice(xml, target.start, target.end, `${open}${escapeXmlText(method)}${close}`);
      continue;
    }

    const latest = scanXml(xml);
    const latestOwner = isRoot ? latest.root : findFormItem(latest, ownerSelector);
    eventsNode = latestOwner.children.find((node) => node.localName === 'Events');
    if (!eventsNode) { throw new FormXmlEditError(`Не удалось создать секцию Events для ${isRoot ? 'формы' : 'элемента'}.`); }
    xml = appendElementChild(xml, eventsNode, 'Event', { name }, method);
  }
  return xml;
}

function setEvents(xml: string, owner: XmlNode, desired: Record<string, string>): string {
  return applyEventsToNode(xml, owner, desired);
}

function setNodeIdentity(xml: string, node: XmlNode, name?: string, id?: string): string {
  const stableId = attributeValue(node, 'id');
  const oldName = attributeValue(node, 'name');
  if (name !== undefined) { xml = setNodeAttribute(xml, node, 'name', name); }
  if (id !== undefined) {
    const refreshed = scanXml(xml);
    const target = node.localName === 'Form'
      ? refreshed.root
      : findFormItem(refreshed, stableId ? { id: stableId } : { name: name ?? oldName });
    xml = setNodeAttribute(xml, target, 'id', id);
  }
  return xml;
}

function setNodeAttribute(xml: string, node: XmlNode, attribute: string, value: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new FormXmlEditError(`Атрибут ${attribute} не может быть пустым.`);
  }
  const existing = node.attributes.get(attribute);
  if (existing) {
    return splice(xml, existing.valueStart, existing.valueEnd, escapeXmlAttribute(value, existing.quote));
  }
  const insertion = node.selfClosing ? node.openEnd - 2 : node.openEnd - 1;
  return splice(xml, insertion, insertion, ` ${attribute}="${escapeXmlAttribute(value)}"`);
}

function addElement(xml: string, edit: Extract<FormXmlEdit, { type: 'addElement' }>): string {
  const document = scanXml(xml);
  const parent = edit.parent ? findFormItem(document, edit.parent) : document.root;
  const childItems = parent.children.find((node) => node.localName === 'ChildItems');
  const usedNames = new Set(document.nodes.flatMap((node) => walkNodes(node)).map((node) => attributeValue(node, 'name')).filter((name): name is string => Boolean(name)));
  const usedIds = new Set(document.nodes.flatMap((node) => walkNodes(node)).map((node) => attributeValue(node, 'id')).filter((id): id is string => Boolean(id)));
  const item = edit.item;
  if (!item.name || !item.tag || !item.id) { throw new FormXmlEditError('Новый элемент формы требует tag, name и id.'); }
  if (usedNames.has(item.name)) { throw new FormXmlEditError(`В форме уже есть элемент «${item.name}».`); }
  if (usedIds.has(item.id)) { throw new FormXmlEditError(`ID ${item.id} уже занят в XML; сохранение остановлено, чтобы не создать дубликат.`); }
  const maxId = [...usedIds].reduce((max, id) => /^\d+$/.test(id) ? Math.max(max, Number(id)) : max, 0);
  let nextId = maxId + 1;
  const idAllocator = () => {
    while (usedIds.has(String(nextId))) { nextId++; }
    const id = String(nextId++);
    usedIds.add(id);
    return id;
  };
  const pad = childItems ? `${indentOf(xml, childItems)}\t` : `${indentOf(xml, parent)}\t\t`;
  const chunk = serializeItem(item, pad, eolOf(xml), idAllocator, usedNames, usedIds);
  return insertIntoChildItems(xml, parent, chunk, edit.index);
}

function serializeItem(
  item: FormChildItem,
  indent: string,
  eol: string,
  allocateId: () => string,
  usedNames: Set<string>,
  usedIds: Set<string>,
): string {
  if (!/^[A-Za-z_][\w.:-]*$/.test(item.tag) || !item.name || !item.id) {
    throw new FormXmlEditError('Элемент формы должен содержать допустимые tag, name и id.');
  }
  if (usedNames.has(item.name)) { throw new FormXmlEditError(`В форме уже есть элемент «${item.name}».`); }
  if (usedIds.has(item.id)) { throw new FormXmlEditError(`ID ${item.id} уже занят в XML; сохранение остановлено.`); }
  usedNames.add(item.name);
  usedIds.add(item.id);
  let output = `${indent}<${item.tag} name="${escapeXmlAttribute(item.name)}" id="${escapeXmlAttribute(item.id)}">${eol}`;
  const propertyIndent = `${indent}\t`;
  for (const [property, value] of Object.entries(item.properties ?? {})) {
    if (property === 'name' || property === 'id' || value === null || value === undefined) { continue; }
    if (!/^[A-Za-z][A-Za-z0-9:._-]*$/.test(property) || STRUCTURAL_ITEM_NODES.has(localName(property))) {
      throw new FormXmlEditError(`Недопустимое свойство нового элемента: ${property}.`);
    }
    const content = serializeNewPropertyValue(value, indent, eol);
    output += `${propertyIndent}<${property}>${content}</${property}>${eol}`;
  }

  const suffixes = /[А-Яа-яЁё]/.test(item.name) ? COMPANION_SUFFIX_RU : COMPANION_SUFFIX_EN;
  for (const companion of COMPANIONS[item.tag] ?? []) {
    const name = `${item.name}${suffixes[companion] ?? companion}`;
    if (usedNames.has(name)) { throw new FormXmlEditError(`Составной узел «${name}» уже существует; сохранение остановлено.`); }
    usedNames.add(name);
    output += `${propertyIndent}<${companion} name="${escapeXmlAttribute(name)}" id="${allocateId()}"/>${eol}`;
  }
  const events = item.events ?? {};
  if (Object.keys(events).length > 0) {
    output += `${propertyIndent}<Events>${eol}`;
    for (const [name, method] of Object.entries(events)) {
      output += `${propertyIndent}\t<Event name="${escapeXmlAttribute(name)}">${escapeXmlText(method)}</Event>${eol}`;
    }
    output += `${propertyIndent}</Events>${eol}`;
  }
  if (item.childItems?.length) {
    output += `${propertyIndent}<ChildItems>${eol}`;
    for (const child of item.childItems) {
      output += serializeItem(child, `${propertyIndent}\t`, eol, allocateId, usedNames, usedIds);
    }
    output += `${propertyIndent}</ChildItems>${eol}`;
  }
  return `${output}${indent}</${item.tag}>${eol}`;
}

function insertIntoChildItems(xml: string, parent: XmlNode, chunk: string, index: number): string {
  const eol = eolOf(xml);
  let document = scanXml(xml);
  const isRoot = parent.localName === 'Form';
  let container = isRoot ? document.root : findFormItem(document, nodeSelector(parent));
  let childItems = container.children.find((node) => node.localName === 'ChildItems');
  if (!childItems) {
    const pad = `${indentOf(xml, container)}\t`;
    const adjusted = reindent(chunk, leadingIndent(chunk), `${pad}\t`);
    if (container.selfClosing) {
      const open = xml.slice(container.start, container.openEnd).replace(/\s*\/\s*>$/, '>');
      return splice(xml, container.start, container.end, `${open}${eol}${pad}<ChildItems>${eol}${adjusted}${pad}</ChildItems>${eol}${indentOf(xml, container)}</${container.tag}>`);
    }
    const at = isRoot ? formChildItemsInsertionPoint(xml, container) : lineStart(xml, container.closeStart);
    const section = `${pad}<ChildItems>${eol}${adjusted}${pad}</ChildItems>${eol}`;
    return splice(xml, at, at, section);
  }
  if (childItems.selfClosing) {
    const open = xml.slice(childItems.start, childItems.openEnd).replace(/\s*\/\s*>$/, '>');
    xml = splice(xml, childItems.start, childItems.end, `${open}${eol}${indentOf(xml, childItems)}</${childItems.tag}>`);
    document = scanXml(xml);
    container = isRoot ? document.root : findFormItem(document, nodeSelector(parent));
    childItems = container.children.find((node) => node.localName === 'ChildItems')!;
  }
  const children = childItems.children.filter(isNamedItem);
  const boundedIndex = Math.max(0, Math.min(Number.isFinite(index) ? index : children.length, children.length));
  const at = boundedIndex < children.length
    ? lineSpan(xml, children[boundedIndex]).start
    : lineStart(xml, childItems.closeStart);
  const pad = `${indentOf(xml, childItems)}\t`;
  return splice(xml, at, at, reindent(chunk, leadingIndent(chunk), pad));
}

function moveElement(xml: string, edit: Extract<FormXmlEdit, { type: 'moveElement' }>): string {
  let document = scanXml(xml);
  const source = findFormItem(document, edit.element);
  if (!source.parent || source.parent.localName !== 'ChildItems') {
    throw new FormXmlEditError(`Элемент «${edit.element.name ?? edit.element.id}» нельзя переместить отдельно.`);
  }
  const destination = edit.parent ? findFormItem(document, edit.parent) : document.root;
  if (isAncestor(source, destination)) { throw new FormXmlEditError('Нельзя переместить элемент внутрь самого себя или своего потомка.'); }
  const sourceContainer = source.parent.parent;
  if (sourceContainer === destination) {
    const siblings = source.parent.children.filter(isNamedItem);
    const currentIndex = siblings.indexOf(source);
    const boundedIndex = Math.max(0, Math.min(Number.isFinite(edit.index) ? edit.index : siblings.length - 1, siblings.length - 1));
    if (currentIndex === boundedIndex) { return xml; }
  }
  const sourceSpan = lineSpan(xml, source);
  const chunk = xml.slice(sourceSpan.start, sourceSpan.end);
  const oldIndent = indentOf(xml, source);
  xml = splice(xml, sourceSpan.start, sourceSpan.end, '');
  document = scanXml(xml);
  const newContainer = edit.parent ? findFormItem(document, edit.parent) : document.root;
  const newPad = newContainer.children.find((node) => node.localName === 'ChildItems')
    ? `${indentOf(xml, newContainer.children.find((node) => node.localName === 'ChildItems')!)}\t`
    : `${indentOf(xml, newContainer)}\t\t`;
  const formatted = reindent(chunk, oldIndent, newPad);
  return insertIntoChildItems(xml, newContainer, formatted, edit.index);
}

function removeElement(xml: string, selector: FormXmlSelector): string {
  const node = findFormItem(scanXml(xml), selector);
  if (!node.parent || node.parent.localName !== 'ChildItems') {
    throw new FormXmlEditError(`Элемент «${selector.name ?? selector.id}» нельзя удалить отдельно.`);
  }
  const span = lineSpan(xml, node);
  return splice(xml, span.start, span.end, '');
}

function applyMemberEdit(
  xml: string,
  sectionName: 'Attributes' | 'Commands',
  memberName: 'Attribute' | 'Command',
  edit: Extract<FormXmlEdit, { type: 'setAttribute' | 'setCommand' }>,
): string {
  let document = scanXml(xml);
  let holder = document.root.children.find((node) => node.localName === sectionName);
  if (!holder && edit.action === 'remove') { return xml; }
  if (!holder) {
    xml = findOrCreateRootSection(xml, sectionName).xml;
    document = scanXml(xml);
    holder = document.root.children.find((node) => node.localName === sectionName);
  }
  if (!holder) { throw new FormXmlEditError(`Не удалось открыть секцию ${sectionName}.`); }
  const selected = edit.selector ? findMember(holder, memberName, edit.selector) : undefined;
  if (edit.action === 'remove') {
    if (!selected) { return xml; }
    const span = lineSpan(xml, selected);
    return splice(xml, span.start, span.end, '');
  }
  if (!edit.name) { throw new FormXmlEditError(`${memberName} требует name.`); }
  if (selected) {
    let updated = xml;
    const originalId = attributeValue(selected, 'id');
    if (edit.name !== attributeValue(selected, 'name')) {
      updated = setNodeAttribute(updated, selected, 'name', edit.name);
    }
    if (edit.id !== undefined && edit.id !== attributeValue(selected, 'id')) {
      const refreshed = scanXml(updated).root.children.find((node) => node.localName === sectionName)!;
      const current = findMember(refreshed, memberName, originalId ? { id: originalId } : { name: edit.name })
        ?? findMember(refreshed, memberName, { name: edit.name });
      if (current) { updated = setNodeAttribute(updated, current, 'id', edit.id); }
    }
    if (edit.properties && Object.keys(edit.properties).length) {
      const latest = scanXml(updated).root.children.find((node) => node.localName === sectionName)!;
      const target = findMember(latest, memberName, edit.id ? { id: edit.id } : { name: edit.name });
      if (!target) { throw new FormXmlEditError(`${memberName} «${edit.name}» потерял идентификатор при редактировании.`); }
      updated = applySetProperties(updated, target, edit.properties);
    }
    return updated;
  }
  if (edit.id && [...walkNodes(holder)].some((node) => attributeValue(node, 'id') === edit.id)) {
    throw new FormXmlEditError(`ID ${edit.id} уже занят в секции ${sectionName}.`);
  }
  if ([...walkNodes(holder)].some((node) => node.localName === memberName && attributeValue(node, 'name') === edit.name)) {
    throw new FormXmlEditError(`${memberName} «${edit.name}» уже существует.`);
  }
  const pad = `${indentOf(xml, holder)}\t`;
  const item = serializeMember(memberName, edit.name, edit.id, edit.properties ?? {}, pad, eolOf(xml));
  const expanded = expandSelfClosingSection(xml, holder);
  document = scanXml(expanded);
  const expandedHolder = document.root.children.find((node) => node.localName === sectionName)!;
  const targetAt = lineStart(expanded, expandedHolder.closeStart);
  return splice(expanded, targetAt, targetAt, item);
}

function serializeMember(
  tag: 'Attribute' | 'Command',
  name: string,
  id: string | undefined,
  properties: Record<string, unknown>,
  indent: string,
  eol: string,
): string {
  const attrs = ` name="${escapeXmlAttribute(name)}"${id ? ` id="${escapeXmlAttribute(id)}"` : ''}`;
  const entries: string[] = [];
  for (const [property, value] of Object.entries(properties)) {
    if (value === undefined || value === null) { continue; }
    if (!/^[A-Za-z][A-Za-z0-9:._-]*$/.test(property)) { throw new FormXmlEditError(`Недопустимое свойство ${tag}: ${property}.`); }
    const inner = serializeNewPropertyValue(value, indent, eol);
    entries.push(`${indent}\t<${property}>${inner}</${property}>${eol}`);
  }
  return `${indent}<${tag}${attrs}>${eol}${entries.join('')}${indent}</${tag}>${eol}`;
}

function serializeNewPropertyValue(value: unknown, outerIndent: string, eol: string): string {
  if (Array.isArray(value)) {
    if (value.every((entry) => isTextNode(entry))) {
      return value.map((entry) => escapeXmlText(String((entry as Record<string, unknown>)['#text'] ?? ''))).join('');
    }
    const propertyIndent = `${outerIndent}\t`;
    const childIndent = `${propertyIndent}\t`;
    return `${eol}${value.map((entry) => serializePreserveOrderNode(entry, childIndent, eol)).join('')}${propertyIndent}`;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return escapeXmlText(String(value));
  }
  throw new FormXmlEditError('Составное свойство формы не представлено в поддерживаемом формате; сохранение остановлено.');
}

function findOrCreateRootSection(xml: string, sectionName: 'Attributes' | 'Commands'): { xml: string } {
  let document = scanXml(xml);
  let section = document.root.children.find((node) => node.localName === sectionName);
  if (section) { return { xml: expandSelfClosingSection(xml, section) }; }
  const rank = FORM_SECTION_ORDER.indexOf(sectionName);
  const next = document.root.children.find((node) => {
    const childRank = FORM_SECTION_ORDER.indexOf(node.localName);
    return childRank >= 0 && childRank > rank;
  });
  const at = next ? lineSpan(xml, next).start : lineStart(xml, document.root.closeStart);
  const pad = `${indentOf(xml, document.root)}\t`;
  const chunk = `${pad}<${sectionName}>${eolOf(xml)}${pad}</${sectionName}>${eolOf(xml)}`;
  xml = splice(xml, at, at, chunk);
  document = scanXml(xml);
  section = document.root.children.find((node) => node.localName === sectionName);
  if (!section) { throw new FormXmlEditError(`Не удалось создать секцию ${sectionName}.`); }
  return { xml: expandSelfClosingSection(xml, section) };
}

function expandSelfClosingSection(xml: string, section: XmlNode): string {
  if (!section.selfClosing) { return xml; }
  const opening = xml.slice(section.start, section.openEnd).replace(/\s*\/\s*>$/, '>');
  return splice(xml, section.start, section.end, `${opening}${eolOf(xml)}${indentOf(xml, section)}</${section.tag}>`);
}

function findMember(holder: XmlNode, memberTag: 'Attribute' | 'Command', selector: FormXmlSelector): XmlNode | undefined {
  if (!selector.id && !selector.name) { throw new FormXmlEditError(`Для ${memberTag} нужен id или name.`); }
  const matches = holder.children.filter((node) => node.localName === memberTag && selectorMatches(node, selector));
  if (matches.length > 1) { throw new FormXmlEditError(`${memberTag} по указанному селектору неоднозначен.`); }
  return matches[0];
}

function insertRootOrItemSection(xml: string, owner: XmlNode, section: string): string {
  const eol = eolOf(xml);
  const document = scanXml(xml);
  const isRoot = owner.localName === 'Form';
  const currentOwner = isRoot ? document.root : findFormItem(document, nodeSelector(owner));
  const existing = currentOwner.children.find((node) => node.localName === section);
  if (existing) { return expandSelfClosingSection(xml, existing); }
  const pad = `${indentOf(xml, currentOwner)}\t`;
  const chunk = `${pad}<${section}/>${eol}`;
  if (isRoot) {
    const next = currentOwner.children.find((node) => {
      const rank = FORM_SECTION_ORDER.indexOf(node.localName);
      return rank >= 0 && rank > FORM_SECTION_ORDER.indexOf(section);
    });
    const at = next ? lineSpan(xml, next).start : lineStart(xml, currentOwner.closeStart);
    return splice(xml, at, at, chunk);
  }
  const next = currentOwner.children.find((node) => node.localName === 'ChildItems');
  const at = next ? lineSpan(xml, next).start : lineStart(xml, currentOwner.closeStart);
  return splice(xml, at, at, chunk);
}

function appendElementChild(
  xml: string,
  parent: XmlNode,
  tag: string,
  attributes: Record<string, string>,
  text: string,
): string {
  if (parent.selfClosing) { xml = expandSelfClosingSection(xml, parent); }
  const document = scanXml(xml);
  const target = [...walkNodes(document.root)].find((node) => node.start === parent.start && node.localName === parent.localName);
  if (!target) { throw new FormXmlEditError(`Не удалось найти контейнер ${parent.localName}.`); }
  const attrText = Object.entries(attributes).map(([key, value]) => ` ${key}="${escapeXmlAttribute(value)}"`).join('');
  const pad = `${indentOf(xml, target)}\t`;
  const chunk = `${pad}<${tag}${attrText}>${escapeXmlText(text)}</${tag}>${eolOf(xml)}`;
  const at = lineStart(xml, target.closeStart);
  return splice(xml, at, at, chunk);
}

function formChildItemsInsertionPoint(xml: string, root: XmlNode): number {
  const later = root.children.find((node) => ['Events', 'Attributes', 'Commands', 'Parameters', 'CommandInterface', 'BaseForm'].includes(node.localName));
  return later ? lineSpan(xml, later).start : lineStart(xml, root.closeStart);
}

function findFormItem(document: XmlDocument, selector: FormXmlSelector): XmlNode {
  if (!selector.id && !selector.name) { throw new FormXmlEditError('Для элемента нужен id или name.'); }
  const matches = [...walkNodes(document.root)].filter((node) => isNamedItem(node) && selectorMatches(node, selector));
  if (matches.length === 0) { throw new FormXmlEditError(`Элемент «${selector.name ?? selector.id}» не найден.`); }
  if (matches.length > 1) { throw new FormXmlEditError(`Элемент «${selector.name ?? selector.id}» неоднозначен.`); }
  return matches[0];
}

function findCurrentNode(document: XmlDocument, original: XmlNode): XmlNode {
  if (original.localName === 'Form') { return document.root; }
  const selector = nodeSelector(original);
  if (isNamedItem(original)) { return findFormItem(document, selector); }
  const sectionName = original.parent?.localName;
  if (sectionName === 'Attributes' || sectionName === 'Commands') {
    const holder = document.root.children.find((node) => node.localName === sectionName);
    const memberTag = original.localName === 'Attribute' ? 'Attribute' : original.localName === 'Command' ? 'Command' : undefined;
    if (holder && memberTag) {
      const member = findMember(holder, memberTag, selector);
      if (member) { return member; }
    }
  }
  const matches = [...walkNodes(document.root)].filter((node) => node.tag === original.tag && selectorMatches(node, selector));
  if (matches.length !== 1) { throw new FormXmlEditError(`Узел ${original.tag} по исходной идентичности не найден однозначно.`); }
  return matches[0];
}

function selectorMatches(node: XmlNode, selector: FormXmlSelector): boolean {
  return (!selector.id || attributeValue(node, 'id') === selector.id)
    && (!selector.name || attributeValue(node, 'name') === selector.name);
}

function isNamedItem(node: XmlNode): boolean {
  return node.parent?.localName === 'ChildItems'
    && attributeValue(node, 'name') !== undefined
    && attributeValue(node, 'id') !== undefined;
}

function attributeValue(node: XmlNode, name: string): string | undefined {
  return node.attributes.get(name)?.value;
}

function nodeSelector(node: XmlNode): FormXmlSelector {
  return { id: attributeValue(node, 'id'), name: attributeValue(node, 'name') };
}

function lineSpan(xml: string, node: XmlNode): { start: number; end: number } {
  let start = lineStart(xml, node.start);
  if (!/^[\t ]*$/.test(xml.slice(start, node.start))) { start = node.start; }
  let end = node.end;
  if (xml[end] === '\r') { end++; }
  if (xml[end] === '\n') { end++; }
  return { start, end };
}

function lineStart(xml: string, offset: number): number {
  let start = offset;
  while (start > 0 && xml[start - 1] !== '\n') { start--; }
  return start;
}

function indentOf(xml: string, node: XmlNode): string {
  const start = lineStart(xml, node.start);
  const indent = xml.slice(start, node.start);
  return /^[\t ]*$/.test(indent) ? indent : '';
}

function eolOf(xml: string): string {
  return /\r\n/.test(xml) ? '\r\n' : '\n';
}

function reindent(value: string, from: string, to: string): string {
  return value.split(/\r?\n/).map((line) => from && line.startsWith(from) ? `${to}${line.slice(from.length)}` : line).join(eolFromText(value));
}

function leadingIndent(value: string): string {
  return /^[\t ]*/.exec(value.split(/\r?\n/, 1)[0] ?? '')?.[0] ?? '';
}

function eolFromText(value: string): string {
  return /\r\n/.test(value) ? '\r\n' : '\n';
}

function splice(xml: string, start: number, end: number, replacement: string): string {
  return `${xml.slice(0, start)}${replacement}${xml.slice(end)}`;
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeXmlAttribute(value: string, quote: '"' | "'" = '"'): string {
  let result = value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  result = quote === '"' ? result.replace(/"/g, '&quot;') : result.replace(/'/g, '&apos;');
  return result;
}

function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_match, token: string) => {
    if (token === 'lt') { return '<'; }
    if (token === 'gt') { return '>'; }
    if (token === 'amp') { return '&'; }
    if (token === 'quot') { return '"'; }
    if (token === 'apos') { return "'"; }
    const codePoint = token[1]?.toLowerCase() === 'x' ? Number.parseInt(token.slice(2), 16) : Number.parseInt(token.slice(1), 10);
    return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : _match;
  });
}

function localName(tag: string): string {
  return tag.slice(tag.lastIndexOf(':') + 1);
}

function malformed(detail: string): FormXmlEditError {
  return new FormXmlEditError(`Form.xml повреждён (${detail}); сохранение отменено без изменения исходного файла.`);
}

function isTextNode(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) && '#text' in value;
}

function walkNodes(node: XmlNode): XmlNode[] {
  return [node, ...node.children.flatMap(walkNodes)];
}

function isAncestor(ancestor: XmlNode, node: XmlNode): boolean {
  for (let current: XmlNode | undefined = node; current; current = current.parent) {
    if (current === ancestor) { return true; }
  }
  return false;
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) { return value.map((item) => cloneValue(item)) as T; }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, cloneValue(item)])) as T;
  }
  return value;
}

function cloneFormModel(model: FormModel): FormModel {
  return cloneValue(model);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) { return `[${value.map(stable).join(',')}]`; }
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort((a, b) => a.localeCompare(b)).map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function deepEqual(left: unknown, right: unknown): boolean {
  return stable(left) === stable(right);
}

function sha256(source: Uint8Array): string {
  return createHash('sha256').update(source).digest('hex');
}

function diffProperties(
  baseline: Record<string, unknown>,
  current: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(baseline), ...Object.keys(current)])) {
    if (!deepEqual(baseline[key], current[key])) {
      result[key] = key in current ? cloneValue(current[key]) : null;
    }
  }
  return result;
}

function assertUnchangedUnsupportedFields(baseline: FormModel, current: FormModel): void {
  const fields: Array<keyof FormModel> = [
    'version', 'xmlnsDeclarations', 'autoCommandBarName', 'autoCommandBarId', 'autoCommandBar',
    'parameters', 'excludedCommands', 'topLevelFields', 'parametersFirstClassLossless', 'commandSetFirstClassLossless',
  ];
  for (const field of fields) {
    if (!deepEqual(baseline[field], current[field])) {
      throw new FormXmlEditError(`Изменение корневого поля ${field} пока не поддерживается; XML не был перезаписан.`);
    }
  }
}

interface FlattenedItem {
  item: FormChildItem;
  parent?: FormChildItem;
  index: number;
  depth: number;
}

function flattenItems(items: readonly FormChildItem[], parent?: FormChildItem, depth = 0): FlattenedItem[] {
  const flattened: FlattenedItem[] = [];
  items.forEach((item, index) => {
    flattened.push({ item, parent, index, depth });
    flattened.push(...flattenItems(item.childItems ?? [], item, depth + 1));
  });
  return flattened;
}

function selectorFor(item: FormChildItem): FormXmlSelector {
  return { id: item.id, name: item.name };
}

function matchItems(oldItems: FlattenedItem[], newItems: FlattenedItem[]): Array<{ oldItem: FormChildItem; newItem: FormChildItem }> {
  const newById = uniqueMap(newItems, (entry) => entry.item.id, 'текущей модели');
  const newByName = uniqueMap(newItems, (entry) => entry.item.name, 'текущей модели');
  const matched = new Set<FormChildItem>();
  const pairs: Array<{ oldItem: FormChildItem; newItem: FormChildItem }> = [];
  const oldIds = new Set<string>();
  const oldNames = new Set<string>();
  for (const { item } of oldItems) {
    if (item.id && oldIds.has(item.id)) { throw new FormXmlEditError(`ID элемента ${item.id} неоднозначен в исходной модели.`); }
    if (item.id) { oldIds.add(item.id); }
    if (item.name && oldNames.has(item.name)) { throw new FormXmlEditError(`Имя элемента ${item.name} неоднозначно в исходной модели.`); }
    if (item.name) { oldNames.add(item.name); }
  }
  for (const { item } of oldItems) {
    const byId = item.id ? newById.get(item.id) : undefined;
    const byName = item.name ? newByName.get(item.name) : undefined;
    const target = byId && !matched.has(byId) ? byId : byName && !matched.has(byName) ? byName : undefined;
    if (target) {
      matched.add(target);
      pairs.push({ oldItem: item, newItem: target });
    }
  }
  return pairs;
}

function uniqueMap(
  items: FlattenedItem[],
  getKey: (entry: FlattenedItem) => string | undefined,
  label: string,
): Map<string, FormChildItem> {
  const map = new Map<string, FormChildItem>();
  for (const entry of items) {
    const key = getKey(entry);
    if (!key) { continue; }
    if (map.has(key)) { throw new FormXmlEditError(`Элемент ${key} неоднозначен в ${label}.`); }
    map.set(key, entry.item);
  }
  return map;
}

function cloneItemWithNewDescendantsOnly(item: FormChildItem, matched: Set<FormChildItem>): FormChildItem {
  return {
    tag: item.tag,
    id: item.id,
    name: item.name,
    properties: cloneValue(item.properties ?? {}),
    events: item.events ? cloneValue(item.events) : undefined,
    childItems: (item.childItems ?? [])
      .filter((child) => !matched.has(child))
      .map((child) => cloneItemWithNewDescendantsOnly(child, matched)),
  };
}

function diffMembers<T extends FormAttribute | FormCommand>(
  baseline: T[],
  current: T[],
  type: 'setAttribute' | 'setCommand',
): FormXmlEdit[] {
  const edits: FormXmlEdit[] = [];
  const newById = uniqueMapMembers(current, 'id', type);
  const newByName = uniqueMapMembers(current, 'name', type);
  const matched = new Set<T>();
  for (const oldMember of baseline) {
    const target = (oldMember.id ? newById.get(oldMember.id) : undefined)
      ?? (oldMember.name ? newByName.get(oldMember.name) : undefined);
    if (!target) {
      edits.push({ type, action: 'remove', selector: { id: oldMember.id, name: oldMember.name } });
      continue;
    }
    matched.add(target);
    const properties = diffProperties(oldMember.properties ?? {}, target.properties ?? {});
    if (oldMember.name !== target.name || oldMember.id !== target.id || Object.keys(properties).length > 0) {
      edits.push({
        type,
        action: 'upsert',
        selector: { id: oldMember.id, name: oldMember.name },
        name: target.name,
        id: target.id,
        properties,
      });
    }
  }
  for (const member of current) {
    if (!matched.has(member)) {
      edits.push({ type, action: 'upsert', name: member.name, id: member.id, properties: cloneValue(member.properties ?? {}) });
    }
  }
  return edits;
}

function uniqueMapMembers<T extends FormAttribute | FormCommand>(
  items: T[],
  key: 'id' | 'name',
  type: 'setAttribute' | 'setCommand',
): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    const value = item[key];
    if (!value) { continue; }
    if (map.has(value)) { throw new FormXmlEditError(`${type} ${value} неоднозначен в модели.`); }
    map.set(value, item);
  }
  return map;
}
