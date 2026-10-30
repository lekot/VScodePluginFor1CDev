import { cloneXmlElement, elementChildren, textContent, type XmlElement } from '../xml/xmlDom';
import { compareOrdinalStrings } from '../ordinalStringOrder';

export function direct(parent: XmlElement, name: string): XmlElement[] {
  return elementChildren(parent).filter((child) => child.localName === name);
}

export function childText(parent: XmlElement, name: string): string | undefined {
  const matches = direct(parent, name);
  if (matches.length !== 1) { return undefined; }
  return textContent(matches[0]!).trim();
}

export function attribute(element: XmlElement, name: string): string | undefined {
  // Metadata UUIDs and XML ids are unqualified in Designer exports. Do not let
  // a vendor:uuid/vendor:id lookalike satisfy an ownership or identity check.
  return element.attributes.find((item) => item.name === name)?.value;
}

export function setAttribute(element: XmlElement, name: string, value: string): void {
  const existing = element.attributes.find((item) => item.name === name);
  if (existing) { existing.value = value; }
  else { element.attributes.push({ name, localName: name === 'xmlns' ? 'xmlns' : name.startsWith('xmlns:') ? name.slice(6) : name, value, quote: '"' }); }
}

export function replaceOrAppend(parent: XmlElement, replacement: XmlElement): void {
  const old = direct(parent, replacement.localName)[0];
  if (old) { replace(parent, old, replacement); }
  else { attach(parent, replacement); }
}

export function replace(parent: XmlElement, old: XmlElement, replacement: XmlElement): void {
  const index = parent.children.indexOf(old);
  if (index < 0) { throw new Error('XML node is detached from its expected parent.'); }
  replacement.parent = parent;
  parent.children[index] = replacement;
}

export function remove(parent: XmlElement, child: XmlElement): void {
  parent.children = parent.children.filter((candidate) => candidate !== child);
}

export function attach(parent: XmlElement, child: XmlElement): void {
  child.parent = parent;
  parent.children.push(child);
}

export function makeElement(name: string): XmlElement {
  return { kind: 'element', name, localName: name.split(':').pop() ?? name, attributes: [], children: [] };
}

export function makeTextElement(name: string, text: string): XmlElement {
  const result = makeElement(name);
  result.children.push({ kind: 'text', text });
  return result;
}

/** Clones a subtree while carrying namespace declarations inherited from its source ancestors. */
export function cloneWithNamespaces(element: XmlElement): XmlElement {
  const clone = cloneXmlElement(element);
  const declarations = new Map<string, string>();
  let current: XmlElement | undefined = element;
  while (current) {
    for (const attribute of current.attributes) {
      if (attribute.name === 'xmlns' || attribute.name.startsWith('xmlns:')) {
        if (!declarations.has(attribute.name)) { declarations.set(attribute.name, attribute.value); }
      }
    }
    current = current.parent;
  }
  for (const [name, value] of declarations) {
    if (!clone.attributes.some((attribute) => attribute.name === name)) {
      clone.attributes.push({ name, localName: name === 'xmlns' ? 'xmlns' : name.slice('xmlns:'.length), value, quote: '"' });
    }
  }
  return clone;
}

export function xmlEqual(left: XmlElement, right: XmlElement): boolean {
  return stableElement(left) === stableElement(right);
}

export function sameElement(left: XmlElement | undefined, right: XmlElement | undefined): boolean {
  if (!left || !right) { return left === right; }
  return xmlEqual(left, right);
}

export function stableElement(element: XmlElement): string {
  const namespaces = namespaceBindingsFromAncestors(element.parent);
  return stableElementWithNamespaces(element, namespaces);
}

const CORE_NAMESPACE = 'http://v8.1c.ru/8.1/data/core';
const XSI_NAMESPACE = 'http://www.w3.org/2001/XMLSchema-instance';

function stableElementWithNamespaces(element: XmlElement, inherited: ReadonlyMap<string, string>): string {
  const namespaces = new Map(inherited);
  for (const attribute of element.attributes) {
    if (attribute.name === 'xmlns') { namespaces.set('', attribute.value); }
    else if (attribute.name.startsWith('xmlns:')) { namespaces.set(attribute.name.slice(6), attribute.value); }
  }

  const attrs = element.attributes.filter((attribute) => attribute.name !== 'xmlns' && !attribute.name.startsWith('xmlns:'))
    .map((attribute) => {
      const name = expandedAttributeName(attribute.name, namespaces);
      const value = name === `{${XSI_NAMESPACE}}type`
        ? canonicalQNameValue(attribute.value, namespaces)
        : attribute.value;
      return `${name}=${JSON.stringify(value)}`;
    }).sort(compareOrdinalStrings).join('|');
  const childElements = elementChildren(element);
  const isLeaf = childElements.length === 0;
  const typedQName = expandedNameWithNamespaces(element, namespaces) === `{${CORE_NAMESPACE}}Type`
    || expandedNameWithNamespaces(element, namespaces) === `{${CORE_NAMESPACE}}TypeSet`;
  const children = element.children.map((child) => {
    if (child.kind === 'element') { return `E(${stableElementWithNamespaces(child, namespaces)})`; }
    if (child.kind === 'text') {
      if (!child.text.trim() && !isLeaf) { return ''; }
      return `T(${JSON.stringify(typedQName ? canonicalQNameValue(child.text, namespaces) : child.text)})`;
    }
    if (child.kind === 'cdata') { return `D(${JSON.stringify(child.text)})`; }
    if (child.kind === 'comment') { return ''; }
    return `P(${JSON.stringify(child.text)})`;
  }).join('');
  return `${expandedNameWithNamespaces(element, namespaces)}[${attrs}]${children}`;
}

function namespaceBindingsFromAncestors(element: XmlElement | undefined): Map<string, string> {
  const chain: XmlElement[] = [];
  let current = element;
  while (current) { chain.unshift(current); current = current.parent; }
  const result = new Map<string, string>([['xml', 'http://www.w3.org/XML/1998/namespace']]);
  for (const ancestor of chain) {
    for (const attribute of ancestor.attributes) {
      if (attribute.name === 'xmlns') { result.set('', attribute.value); }
      else if (attribute.name.startsWith('xmlns:')) { result.set(attribute.name.slice(6), attribute.value); }
    }
  }
  return result;
}

function expandedNameWithNamespaces(element: XmlElement, namespaces: ReadonlyMap<string, string>): string {
  const colon = element.name.indexOf(':');
  const prefix = colon < 0 ? '' : element.name.slice(0, colon);
  const localName = colon < 0 ? element.name : element.name.slice(colon + 1);
  const namespace = namespaces.get(prefix);
  return namespace ? `{${namespace}}${localName}` : localName;
}

function expandedAttributeName(name: string, namespaces: ReadonlyMap<string, string>): string {
  const colon = name.indexOf(':');
  if (colon < 0) { return name; }
  const prefix = name.slice(0, colon);
  const namespace = namespaces.get(prefix);
  return namespace ? `{${namespace}}${name.slice(colon + 1)}` : name;
}

function canonicalQNameValue(value: string, namespaces: ReadonlyMap<string, string>): string {
  const text = value.trim();
  if (!text) { return value; }
  const colon = text.indexOf(':');
  if (colon !== text.lastIndexOf(':')) { return text; }
  const prefix = colon < 0 ? '' : text.slice(0, colon);
  const localName = colon < 0 ? text : text.slice(colon + 1);
  const ncName = '[\\p{L}_][\\p{L}\\p{M}\\p{N}._\\-·]*';
  if (!new RegExp(`^${ncName}(?::${ncName})?$`, 'u').test(text)) { return value; }
  const namespace = namespaces.get(prefix);
  return namespace ? `{${namespace}}${localName}` : text;
}

export function expandQName(element: XmlElement, value: string): string {
  const text = value.trim();
  const split = text.indexOf(':');
  if (split <= 0 || split !== text.lastIndexOf(':')) { return text; }
  const prefix = text.slice(0, split);
  let parent: XmlElement | undefined = element;
  while (parent) {
    const declaration = parent.attributes.find((attribute) => attribute.name === `xmlns:${prefix}`);
    if (declaration) { return `{${declaration.value}}${text.slice(split + 1)}`; }
    parent = parent.parent;
  }
  return text;
}

export function prefixForNamespace(element: XmlElement, uri: string, fallback: string): string {
  const declarations = new Map<string, string>();
  let current: XmlElement | undefined = element;
  while (current) {
    for (const attribute of current.attributes) {
      if (attribute.name.startsWith('xmlns:')) {
        const prefix = attribute.name.slice('xmlns:'.length);
        if (!declarations.has(prefix)) { declarations.set(prefix, attribute.value); }
      }
    }
    current = current.parent;
  }
  const existing = [...declarations].find(([, value]) => value === uri)?.[0];
  if (existing) { return existing; }
  const root = ancestors(element)[0];
  if (root) { setAttribute(root, `xmlns:${fallback}`, uri); }
  return fallback;
}

export function expandedName(element: XmlElement): string {
  const colon = element.name.indexOf(':');
  const prefix = colon < 0 ? '' : element.name.slice(0, colon);
  const declarationName = prefix ? `xmlns:${prefix}` : 'xmlns';
  let current: XmlElement | undefined = element;
  while (current) {
    const declaration = current.attributes.find((attribute) => attribute.name === declarationName);
    if (declaration) { return declaration.value ? `{${declaration.value}}${element.localName}` : element.localName; }
    current = current.parent;
  }
  return element.localName;
}

export function ancestors(element: XmlElement): XmlElement[] {
  const result: XmlElement[] = [];
  let current: XmlElement | undefined = element;
  while (current) { result.unshift(current); current = current.parent; }
  return result;
}

export function descendants(root: XmlElement): XmlElement[] {
  const result: XmlElement[] = [];
  const visit = (node: XmlElement) => { result.push(node); for (const child of elementChildren(node)) { visit(child); } };
  visit(root);
  return result;
}
