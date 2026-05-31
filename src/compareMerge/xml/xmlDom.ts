import type { XmlAddress } from './xmlAddress';

export interface XmlDocument {
  declaration?: string;
  root: XmlElement;
}

export type XmlChildNode = XmlElement | XmlTextNode | XmlCdataNode | XmlCommentNode | XmlProcessingInstructionNode;

export interface XmlElement {
  kind: 'element';
  name: string;
  localName: string;
  attributes: XmlAttribute[];
  children: XmlChildNode[];
  parent?: XmlElement;
}

export interface XmlAttribute {
  name: string;
  localName: string;
  value: string;
  quote: '"' | "'";
}

export interface XmlTextNode {
  kind: 'text';
  text: string;
}

export interface XmlCdataNode {
  kind: 'cdata';
  text: string;
}

export interface XmlCommentNode {
  kind: 'comment';
  text: string;
}

export interface XmlProcessingInstructionNode {
  kind: 'processingInstruction';
  text: string;
}

export function parseXmlDocument(source: string): XmlDocument {
  const parser = new Parser(source);
  return parser.parse();
}

export function serializeXmlDocument(document: XmlDocument): string {
  const body = serializeXmlElement(document.root);
  return document.declaration ? `${document.declaration}\n${body}` : body;
}

export function serializeXmlElement(element: XmlElement): string {
  const attrs = element.attributes
    .map((attr) => ` ${attr.name}=${attr.quote}${escapeAttribute(attr.value)}${attr.quote}`)
    .join('');
  if (element.children.length === 0) {
    return `<${element.name}${attrs}/>`;
  }

  return `<${element.name}${attrs}>${element.children.map(serializeXmlChild).join('')}</${element.name}>`;
}

export function cloneXmlElement(element: XmlElement): XmlElement {
  const clone: XmlElement = {
    kind: 'element',
    name: element.name,
    localName: element.localName,
    attributes: element.attributes.map((attr) => ({ ...attr })),
    children: [],
  };
  clone.children = element.children.map((child) => cloneXmlChild(child, clone));
  return clone;
}

export function buildXmlAddress(filePath: string, element: XmlElement): XmlAddress {
  const elements = ancestors(element);
  const pointer = elements
    .map((item) => {
      const identityKey = getXmlElementIdentityKey(item);
      const selector = identityKey ?? String(ordinalAmongSameLocalName(item));
      return `${item.localName}[${selector}]`;
    })
    .join('/');
  const identityKey = getXmlElementIdentityKey(element);

  return {
    filePath,
    pointer: `/${pointer}`,
    displayPath: elements
      .map((item) => {
        const value = identityValue(getXmlElementIdentityKey(item));
        return value ? `${item.localName} ${value}` : item.localName;
      })
      .join(' > '),
    identityKey,
  };
}

export function getXmlElementIdentityKey(element: XmlElement): string | undefined {
  const attrIdentity = findIdentityAttribute(element);
  if (attrIdentity) {
    return attrIdentity;
  }

  const directName = getDirectChildText(element, 'Name');
  if (directName) {
    return `Name=${directName}`;
  }

  const properties = element.children.find(
    (child): child is XmlElement => child.kind === 'element' && child.localName === 'Properties'
  );
  const propertiesName = properties ? getDirectChildText(properties, 'Name') : undefined;
  return propertiesName ? `Properties.Name=${propertiesName}` : undefined;
}

export function elementChildren(element: XmlElement): XmlElement[] {
  return element.children.filter((child): child is XmlElement => child.kind === 'element');
}

export function textContent(element: XmlElement): string {
  return element.children
    .filter((child): child is XmlTextNode | XmlCdataNode => child.kind === 'text' || child.kind === 'cdata')
    .map((child) => child.text)
    .join('');
}

function serializeXmlChild(child: XmlChildNode): string {
  switch (child.kind) {
    case 'element':
      return serializeXmlElement(child);
    case 'text':
      return escapeText(child.text);
    case 'cdata':
      return `<![CDATA[${child.text}]]>`;
    case 'comment':
      return `<!--${child.text}-->`;
    case 'processingInstruction':
      return `<?${child.text}?>`;
  }
}

function cloneXmlChild(child: XmlChildNode, parent: XmlElement): XmlChildNode {
  if (child.kind !== 'element') {
    return { ...child };
  }

  const clone = cloneXmlElement(child);
  clone.parent = parent;
  return clone;
}

function ancestors(element: XmlElement): XmlElement[] {
  const result: XmlElement[] = [];
  let cursor: XmlElement | undefined = element;
  while (cursor) {
    result.unshift(cursor);
    cursor = cursor.parent;
  }
  return result;
}

function ordinalAmongSameLocalName(element: XmlElement): number {
  if (!element.parent) {
    return 0;
  }

  return elementChildren(element.parent)
    .filter((sibling) => sibling.localName === element.localName)
    .indexOf(element);
}

function findIdentityAttribute(element: XmlElement): string | undefined {
  for (const attr of element.attributes) {
    const lowerName = attr.localName.toLowerCase();
    if (lowerName === 'uuid' || lowerName === 'id') {
      return `${lowerName}=${attr.value}`;
    }
    if (attr.localName === 'Name') {
      return `Name=${attr.value}`;
    }
  }

  return undefined;
}

function getDirectChildText(element: XmlElement, localName: string): string | undefined {
  const child = element.children.find(
    (candidate): candidate is XmlElement =>
      candidate.kind === 'element' && candidate.localName === localName
  );
  const value = child ? textContent(child).trim() : '';
  return value || undefined;
}

function identityValue(identityKey: string | undefined): string | undefined {
  if (!identityKey) {
    return undefined;
  }

  const index = identityKey.indexOf('=');
  return index < 0 ? undefined : identityKey.slice(index + 1);
}

function localName(name: string): string {
  return name.includes(':') ? name.split(':').pop() ?? name : name;
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}

function unescapeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

class Parser {
  private index = 0;

  constructor(private readonly source: string) {}

  parse(): XmlDocument {
    const declaration = this.readDeclaration();
    const children = this.readChildren();
    const root = children.find((child): child is XmlElement => child.kind === 'element');
    if (!root) {
      throw new Error('Invalid XML: missing root element');
    }

    return { declaration, root };
  }

  private readDeclaration(): string | undefined {
    this.skipWhitespace();
    if (!this.source.startsWith('<?xml', this.index)) {
      return undefined;
    }

    const end = this.source.indexOf('?>', this.index);
    if (end < 0) {
      throw new Error('Invalid XML declaration');
    }

    const declaration = this.source.slice(this.index, end + 2);
    this.index = end + 2;
    return declaration;
  }

  private readChildren(parent?: XmlElement, closingName?: string): XmlChildNode[] {
    const children: XmlChildNode[] = [];
    while (this.index < this.source.length) {
      if (this.source.startsWith('</', this.index)) {
        const name = this.readClosingTag();
        if (closingName && name !== closingName) {
          throw new Error(`Invalid XML: expected closing ${closingName}, got ${name}`);
        }
        return children;
      }

      if (this.source.startsWith('<!--', this.index)) {
        children.push(this.readComment());
        continue;
      }
      if (this.source.startsWith('<![CDATA[', this.index)) {
        children.push(this.readCdata());
        continue;
      }
      if (this.source.startsWith('<?', this.index)) {
        children.push(this.readProcessingInstruction());
        continue;
      }
      if (this.source[this.index] === '<') {
        children.push(this.readElement(parent));
        continue;
      }

      children.push(this.readText());
    }

    if (closingName) {
      throw new Error(`Invalid XML: missing closing ${closingName}`);
    }
    return children;
  }

  private readElement(parent?: XmlElement): XmlElement {
    const end = findTagEnd(this.source, this.index);
    const tagSource = this.source.slice(this.index + 1, end);
    const selfClosing = tagSource.trimEnd().endsWith('/');
    const content = selfClosing ? tagSource.trimEnd().slice(0, -1).trimEnd() : tagSource.trimEnd();
    const nameMatch = /^([^\s/>]+)/.exec(content);
    if (!nameMatch) {
      throw new Error('Invalid XML: empty element tag');
    }

    const name = nameMatch[1];
    const element: XmlElement = {
      kind: 'element',
      name,
      localName: localName(name),
      attributes: parseAttributes(content.slice(name.length)),
      children: [],
      parent,
    };
    this.index = end + 1;

    if (!selfClosing) {
      element.children = this.readChildren(element, name);
    }

    return element;
  }

  private readClosingTag(): string {
    const end = this.source.indexOf('>', this.index);
    if (end < 0) {
      throw new Error('Invalid XML closing tag');
    }

    const name = this.source.slice(this.index + 2, end).trim();
    this.index = end + 1;
    return name;
  }

  private readText(): XmlTextNode {
    const next = this.source.indexOf('<', this.index);
    const end = next < 0 ? this.source.length : next;
    const text = unescapeXml(this.source.slice(this.index, end));
    this.index = end;
    return { kind: 'text', text };
  }

  private readComment(): XmlCommentNode {
    const end = this.source.indexOf('-->', this.index);
    if (end < 0) {
      throw new Error('Invalid XML comment');
    }

    const text = this.source.slice(this.index + 4, end);
    this.index = end + 3;
    return { kind: 'comment', text };
  }

  private readCdata(): XmlCdataNode {
    const end = this.source.indexOf(']]>', this.index);
    if (end < 0) {
      throw new Error('Invalid XML CDATA');
    }

    const text = this.source.slice(this.index + 9, end);
    this.index = end + 3;
    return { kind: 'cdata', text };
  }

  private readProcessingInstruction(): XmlProcessingInstructionNode {
    const end = this.source.indexOf('?>', this.index);
    if (end < 0) {
      throw new Error('Invalid XML processing instruction');
    }

    const text = this.source.slice(this.index + 2, end);
    this.index = end + 2;
    return { kind: 'processingInstruction', text };
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.source[this.index] ?? '')) {
      this.index += 1;
    }
  }
}

function findTagEnd(source: string, start: number): number {
  let quote: '"' | "'" | undefined;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if ((char === '"' || char === "'") && !quote) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = undefined;
      continue;
    }
    if (char === '>' && !quote) {
      return index;
    }
  }

  throw new Error('Invalid XML tag');
}

function parseAttributes(source: string): XmlAttribute[] {
  const attributes: XmlAttribute[] = [];
  const regex = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(source)) !== null) {
    const quote = match[2].startsWith("'") ? "'" : '"';
    attributes.push({
      name: match[1],
      localName: localName(match[1]),
      value: unescapeXml(match[3] ?? match[4] ?? ''),
      quote,
    });
  }

  return attributes;
}
