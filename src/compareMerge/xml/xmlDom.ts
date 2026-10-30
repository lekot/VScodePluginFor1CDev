import { XMLValidator } from 'fast-xml-parser';
import { encodeXmlAddressComponent, type XmlAddress } from './xmlAddress';

export interface XmlDocument {
  declaration?: string;
  root: XmlElement;
  hasBom?: boolean;
  lineEnding?: '\r\n' | '\n' | '\r';
  prolog?: XmlTopLevelNode[];
  epilog?: XmlTopLevelNode[];
}

export type XmlChildNode =
  | XmlElement
  | XmlTextNode
  | XmlCdataNode
  | XmlCommentNode
  | XmlProcessingInstructionNode;
export type XmlTopLevelNode = XmlTextNode | XmlCommentNode | XmlProcessingInstructionNode;

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
  const hasBom = source.startsWith('\uFEFF');
  const xmlSource = hasBom ? source.slice(1) : source;
  if (containsDoctype(xmlSource)) {
    throw new Error('Invalid XML: document type declarations are not supported');
  }

  const validation = XMLValidator.validate(xmlSource);
  if (validation !== true) {
    throw new Error(`Invalid XML: ${validation.err.msg}`);
  }

  const document = new Parser(xmlSource).parse();
  document.hasBom = hasBom;
  document.lineEnding = detectLineEnding(source);
  validateNamespaceBindings(
    document.root,
    new Map([['xml', 'http://www.w3.org/XML/1998/namespace']])
  );
  return document;
}

export function serializeXmlDocument(document: XmlDocument): string {
  const lineEnding = document.lineEnding ?? '\n';
  const declaration = document.declaration
    ? `${document.declaration}${document.prolog === undefined ? lineEnding : ''}`
    : '';
  const prolog = (document.prolog ?? []).map(serializeXmlTopLevelNode).join('');
  const root = serializeXmlElement(document.root, lineEnding);
  const epilog = (document.epilog ?? []).map(serializeXmlTopLevelNode).join('');
  return `${document.hasBom ? '\uFEFF' : ''}${declaration}${prolog}${root}${epilog}`;
}

export function serializeXmlElement(
  element: XmlElement,
  lineEnding: '\r\n' | '\n' | '\r' = '\n'
): string {
  const attrs = element.attributes
    .map(
      (attr) => ` ${attr.name}=${attr.quote}${escapeAttribute(attr.value, attr.quote)}${attr.quote}`
    )
    .join('');
  if (element.children.length === 0) {
    return `<${element.name}${attrs}/>`;
  }

  return `<${element.name}${attrs}>${element.children
    .map((child) => serializeXmlChild(child, lineEnding))
    .join('')}</${element.name}>`;
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

/** Serializes a detached subtree while carrying its effective namespace bindings on the root. */
export function captureXmlSubtree(element: XmlElement): string {
  const clone = cloneXmlElement(element);
  const inheritedDeclarations = new Map<string, XmlAttribute>();
  let current: XmlElement | undefined = element;
  while (current) {
    for (const attribute of current.attributes) {
      if (attribute.name === 'xmlns' || attribute.name.startsWith('xmlns:')) {
        if (!inheritedDeclarations.has(attribute.name)) {
          inheritedDeclarations.set(attribute.name, attribute);
        }
      }
    }
    current = current.parent;
  }

  for (const declaration of inheritedDeclarations.values()) {
    if (!clone.attributes.some((attribute) => attribute.name === declaration.name)) {
      clone.attributes.push({ ...declaration });
    }
  }

  return serializeXmlElement(clone);
}

export function buildXmlAddress(filePath: string, element: XmlElement): XmlAddress {
  const elements = ancestors(element);
  const pointer = elements
    .map((item) => {
      const identityKey = getXmlElementIdentityKey(item);
      const selector = identityKey ?? String(ordinalAmongSameLocalName(item));
      return `${encodeXmlAddressComponent(item.localName)}[${encodeXmlAddressComponent(selector)}]`;
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
  const structuredIdentity = structuredDesignerXmlIdentity(element);
  if (structuredIdentity) {
    return structuredIdentity;
  }
  const uuid = findAttributeByLocalName(element, 'uuid');
  if (uuid && element.parent?.localName === 'MetaDataObject') {
    const properties = elementChildren(element).find((child) => child.localName === 'Properties');
    const name = properties ? getDirectChildText(properties, 'Name') : undefined;
    if (name) {
      const separator = element.name.indexOf(':');
      const prefix = separator < 0 ? '' : element.name.slice(0, separator);
      const namespaceUri = lookupNamespace(element, prefix);
      const expandedName = namespaceUri ? `{${namespaceUri}}${element.localName}` : element.localName;
      return `metadata-root=${expandedName};name=${name.trim().normalize('NFC').toLocaleLowerCase('en-US')}`;
    }
  }
  if (uuid) {
    return `uuid=${uuid.value}`;
  }
  const id = findAttributeByLocalName(element, 'id');
  if (id) {
    return `id=${id.value}`;
  }
  const name = findAttributeByLocalName(element, 'name');
  if (name) {
    return `name=${name.value}`;
  }

  if (element.localName === 'Item' && element.parent?.localName === 'Content') {
    const itemValue = textContent(element).trim().normalize('NFC');
    if (itemValue) {
      return `Item=${itemValue}`;
    }
  }

  if (element.localName === 'Type' && element.parent?.localName === 'Type') {
    const typeName = textContent(element).trim().normalize('NFC');
    if (typeName) {
      return `Type=${expandQName(element, typeName)}`;
    }
  }

  if (element.localName === 'item') {
    const language = getDirectChildText(element, 'lang');
    if (language) {
      return `lang=${language.normalize('NFC')}`;
    }
  }

  const directName = getDirectChildText(element, 'Name');
  if (directName) {
    return `Name=${directName}`;
  }

  const properties = element.children.find(
    (child): child is XmlElement => child.kind === 'element' && child.localName === 'Properties'
  );
  const propertiesName = properties ? getDirectChildText(properties, 'Name') : undefined;
  if (propertiesName) {
    return `Properties.Name=${propertiesName}`;
  }

  return undefined;
}

function structuredDesignerXmlIdentity(element: XmlElement): string | undefined {
  const namespace = elementNamespace(element);
  const parent = element.parent;
  const name = element.localName;
  const rightsNamespace = 'http://v8.1c.ru/8.2/roles';
  const dcsNamespace = 'http://v8.1c.ru/8.1/data-composition-system/schema';

  if (namespace === rightsNamespace && parent && elementNamespace(parent) === rightsNamespace) {
    const directName = directTextInNamespace(element, 'name', rightsNamespace);
    if (name === 'object' && parent.localName === 'Rights' && directName) {
      return `rights-object=${normalizeXmlIdentityValue(directName)}`;
    }
    if (name === 'right' && parent.localName === 'object' && directName) {
      return `rights-right=${normalizeXmlIdentityValue(directName)}`;
    }
    if (name === 'restrictionTemplate' && parent.localName === 'Rights' && directName) {
      return `rights-restrictiontemplate=${normalizeXmlIdentityValue(directName)}`;
    }
  }

  if (namespace !== dcsNamespace || !parent || elementNamespace(parent) !== dcsNamespace) {
    return undefined;
  }
  const parentName = parent.localName;
  const dcsName = directTextInNamespace(element, 'name', dcsNamespace);
  if (parentName === 'DataCompositionSchema' && dcsName) {
    const rootKeys: Record<string, string> = {
      dataSource: 'dcs-datasource',
      dataSet: 'dcs-dataset',
      parameter: 'dcs-parameter',
      template: 'dcs-template',
    };
    const key = rootKeys[name];
    if (key) {
      return `${key}=${normalizeXmlIdentityValue(dcsName)}`;
    }
  }
  if (name === 'settingsVariant' && parentName === 'DataCompositionSchema') {
    const settingsName = directTextInNamespace(element, 'name', 'http://v8.1c.ru/8.1/data-composition-system/settings');
    if (settingsName) {
      return `dcs-settings-variant=${normalizeXmlIdentityValue(settingsName)}`;
    }
  }
  const parentDataSetType = structuredDcsDataSetType(parent);
  if (name === 'item' && (parentName === 'dataSet' || parentName === 'item') && parentDataSetType === 'DataSetUnion') {
    if (dcsName) {
      return `dcs-union-item=${normalizeXmlIdentityValue(dcsName)}`;
    }
  }
  const parentContainer = parent.parent;
  const isRootDataSet = parentName === 'dataSet' && parentContainer?.localName === 'DataCompositionSchema' &&
    elementNamespace(parentContainer) === dcsNamespace;
  const isTypedUnionMember = parentName === 'item' && Boolean(parentDataSetType);
  if (name === 'field' && (isRootDataSet || isTypedUnionMember)) {
    const dataPath = directTextInNamespace(element, 'dataPath', dcsNamespace);
    if (dataPath) {
      return `dcs-field=${normalizeXmlIdentityValue(dataPath)}`;
    }
  }
  if (name === 'dataSetLink' && parentName === 'DataCompositionSchema') {
    const tuple = ['sourceDataSet', 'destinationDataSet', 'sourceExpression', 'destinationExpression', 'parameter']
      .map((member) => directTextInNamespace(element, member, dcsNamespace)?.trim().normalize('NFC') ?? '');
    if (tuple.slice(0, 4).every(Boolean)) {
      return `dcs-link=${JSON.stringify(tuple)}`;
    }
  }
  if ((name === 'calculatedField' || name === 'totalField') && parentName === 'DataCompositionSchema') {
    const dataPath = directTextInNamespace(element, 'dataPath', dcsNamespace);
    if (!dataPath) {
      return undefined;
    }
    const normalizedPath = normalizeXmlIdentityValue(dataPath);
    if (name === 'calculatedField') {
      return `dcs-calculated-field=${normalizedPath}`;
    }
    const groups = elementChildren(element)
      .filter((child) => child.localName === 'group' && elementNamespace(child) === dcsNamespace)
      .map((child) => normalizeXmlIdentityValue(textContent(child)))
      .sort();
    return `dcs-total-field=${JSON.stringify([normalizedPath, groups])}`;
  }
  if ((name === 'groupTemplate' || name === 'groupHeaderTemplate') && parentName === 'DataCompositionSchema') {
    const memberNames = name === 'groupTemplate'
      ? ['groupField', 'templateType', 'template']
      : ['groupName', 'templateType', 'template'];
    const tuple = memberNames.map((member) => directTextInNamespace(element, member, dcsNamespace)?.trim().normalize('NFC') ?? '');
    if (tuple.every(Boolean)) {
      return `dcs-${name}=${JSON.stringify(tuple)}`;
    }
  }
  return undefined;
}

function structuredDcsDataSetType(element: XmlElement): string | undefined {
  const schemaNamespace = 'http://v8.1c.ru/8.1/data-composition-system/schema';
  const xsiNamespace = 'http://www.w3.org/2001/XMLSchema-instance';
  const attributes = element.attributes.filter((attribute) => {
    if (attribute.localName !== 'type') {return false;}
    const separator = attribute.name.indexOf(':');
    const namespace = separator < 0 ? '' : lookupNamespace(element, attribute.name.slice(0, separator));
    return namespace === xsiNamespace;
  });
  if (attributes.length !== 1) {return undefined;}
  const qName = attributes[0]!.value.trim();
  const parts = qName.split(':');
  if (parts.length > 2 || parts.some((part) => !/^[\p{L}_][\p{L}\p{N}_.-]*$/u.test(part))) {return undefined;}
  const prefix = parts.length === 2 ? parts[0]! : '';
  const localPart = parts[parts.length - 1]!;
  return lookupNamespace(element, prefix) === schemaNamespace &&
    ['DataSetQuery', 'DataSetObject', 'DataSetUnion'].includes(localPart)
    ? localPart
    : undefined;
}

function elementNamespace(element: XmlElement): string | undefined {
  const separator = element.name.indexOf(':');
  return lookupNamespace(element, separator < 0 ? '' : element.name.slice(0, separator));
}

function directTextInNamespace(element: XmlElement, localName: string, namespace: string): string | undefined {
  const child = elementChildren(element).find((candidate) => candidate.localName === localName && elementNamespace(candidate) === namespace);
  const value = child ? textContent(child).trim() : '';
  return value || undefined;
}

function normalizeXmlIdentityValue(value: string): string {
  return value.trim().normalize('NFC').toLocaleLowerCase('en-US');
}

export function elementChildren(element: XmlElement): XmlElement[] {
  return element.children.filter((child): child is XmlElement => child.kind === 'element');
}

export function textContent(element: XmlElement): string {
  return element.children
    .filter(
      (child): child is XmlTextNode | XmlCdataNode =>
        child.kind === 'text' || child.kind === 'cdata'
    )
    .map((child) => child.text)
    .join('');
}

function serializeXmlChild(child: XmlChildNode, lineEnding: '\r\n' | '\n' | '\r' = '\n'): string {
  switch (child.kind) {
    case 'element':
      return serializeXmlElement(child, lineEnding);
    case 'text':
      return escapeText(child.text, lineEnding);
    case 'cdata':
      return `<![CDATA[${child.text}]]>`;
    case 'comment':
      return `<!--${child.text}-->`;
    case 'processingInstruction':
      return `<?${child.text}?>`;
  }
}

function serializeXmlTopLevelNode(node: XmlTopLevelNode): string {
  return node.kind === 'text' ? node.text : serializeXmlChild(node);
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

function findAttributeByLocalName(element: XmlElement, name: string): XmlAttribute | undefined {
  const normalizedName = name.toLowerCase();
  return element.attributes.find(
    (attribute) => attribute.localName.toLowerCase() === normalizedName
  );
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

function expandQName(element: XmlElement, value: string): string {
  const normalized = value.trim().normalize('NFC');
  const separator = normalized.indexOf(':');
  if (
    separator <= 0 ||
    separator !== normalized.lastIndexOf(':') ||
    separator === normalized.length - 1
  ) {
    return normalized;
  }

  const prefix = normalized.slice(0, separator);
  const localPart = normalized.slice(separator + 1);
  const namespaceUri = lookupNamespace(element, prefix);
  return namespaceUri ? `{${namespaceUri}}${localPart}` : normalized;
}

function lookupNamespace(element: XmlElement, prefix: string): string | undefined {
  if (prefix === 'xml') {
    return 'http://www.w3.org/XML/1998/namespace';
  }

  const declarationName = prefix ? `xmlns:${prefix}` : 'xmlns';
  let current: XmlElement | undefined = element;
  while (current) {
    const declaration = current.attributes.find((attribute) => attribute.name === declarationName);
    if (declaration) {
      return declaration.value || undefined;
    }
    current = current.parent;
  }

  return undefined;
}

function localName(name: string): string {
  return name.includes(':') ? (name.split(':').pop() ?? name) : name;
}

function escapeText(value: string, lineEnding: '\r\n' | '\n' | '\r' = '\n'): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r/g, '&#13;')
    .replace(/\n/g, lineEnding);
}

function escapeAttribute(value: string, quote: '"' | "'"): string {
  const escapedWhitespace = escapeText(value).replace(/\t/g, '&#9;').replace(/\n/g, '&#10;');
  return quote === '"'
    ? escapedWhitespace.replace(/"/g, '&quot;')
    : escapedWhitespace.replace(/'/g, '&apos;');
}

function unescapeXml(value: string): string {
  const invalidReference = /&(?!(?:#x[\da-fA-F]+|#\d+|quot|apos|lt|gt|amp);)/.exec(value);
  if (invalidReference) {
    throw new Error(`Invalid XML entity reference: ${invalidReference[0]}`);
  }

  return value.replace(
    /&(#x[\da-fA-F]+|#\d+|quot|apos|lt|gt|amp);/g,
    (entity: string, value: string) => {
      switch (value) {
        case 'quot':
          return '"';
        case 'apos':
          return "'";
        case 'lt':
          return '<';
        case 'gt':
          return '>';
        case 'amp':
          return '&';
        default: {
          const codePoint = value.startsWith('#x')
            ? Number.parseInt(value.slice(2), 16)
            : Number.parseInt(value.slice(1), 10);
          if (!isValidXmlCodePoint(codePoint)) {
            throw new Error(`Invalid XML character reference: ${entity}`);
          }
          return String.fromCodePoint(codePoint);
        }
      }
    }
  );
}

function validateNamespaceBindings(element: XmlElement, inherited: Map<string, string>): void {
  const namespaces = new Map(inherited);
  for (const attribute of element.attributes) {
    if (attribute.name === 'xmlns') {
      validateNamespaceUri(attribute.value, '');
      namespaces.set('', attribute.value);
      continue;
    }
    if (!attribute.name.startsWith('xmlns:')) {
      continue;
    }

    const prefix = attribute.name.slice('xmlns:'.length);
    if (!prefix || prefix === 'xmlns') {
      throw new Error(`Invalid XML namespace prefix declaration: ${attribute.name}`);
    }
    if (prefix === 'xml') {
      if (attribute.value !== 'http://www.w3.org/XML/1998/namespace') {
        throw new Error('Invalid XML namespace prefix binding for xml');
      }
    } else {
      if (!attribute.value) {
        throw new Error(`Invalid XML namespace prefix binding for ${prefix}`);
      }
      validateNamespaceUri(attribute.value, prefix);
    }
    namespaces.set(prefix, attribute.value);
  }

  const elementName = splitQualifiedName(element.name);
  if (elementName.prefix && !namespaces.get(elementName.prefix)) {
    throw new Error(`Unbound XML namespace prefix: ${elementName.prefix}`);
  }

  const expandedAttributes = new Set<string>();
  for (const attribute of element.attributes) {
    if (attribute.name === 'xmlns' || attribute.name.startsWith('xmlns:')) {
      continue;
    }
    const attributeName = splitQualifiedName(attribute.name);
    const namespaceUri = attributeName.prefix ? namespaces.get(attributeName.prefix) : '';
    if (attributeName.prefix && !namespaceUri) {
      throw new Error(`Unbound XML namespace prefix: ${attributeName.prefix}`);
    }
    const expandedName = `${namespaceUri ?? ''}\0${attributeName.localName}`;
    if (expandedAttributes.has(expandedName)) {
      throw new Error(`Duplicate XML attribute by namespace: ${attribute.name}`);
    }
    expandedAttributes.add(expandedName);
  }

  for (const child of element.children) {
    if (child.kind === 'element') {
      validateNamespaceBindings(child, namespaces);
    }
  }
}

function validateNamespaceUri(value: string, prefix: string): void {
  const namespaceNamespace = 'http://www.w3.org/2000/xmlns/';
  if (
    value === namespaceNamespace ||
    (prefix !== 'xml' && value === 'http://www.w3.org/XML/1998/namespace')
  ) {
    throw new Error(`Invalid XML namespace URI for prefix ${prefix || '(default)'}`);
  }
}

function splitQualifiedName(name: string): { prefix?: string; localName: string } {
  const firstColon = name.indexOf(':');
  if (firstColon < 0) {
    return { localName: name };
  }
  if (firstColon === 0 || firstColon !== name.lastIndexOf(':') || firstColon === name.length - 1) {
    throw new Error(`Invalid XML qualified name: ${name}`);
  }
  return { prefix: name.slice(0, firstColon), localName: name.slice(firstColon + 1) };
}

function isValidXmlCodePoint(codePoint: number): boolean {
  return (
    codePoint === 0x9 ||
    codePoint === 0xa ||
    codePoint === 0xd ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  );
}

class Parser {
  private index = 0;

  constructor(private readonly source: string) {}

  parse(): XmlDocument {
    const declaration = this.readDeclaration();
    const prolog: XmlTopLevelNode[] = [];
    let root: XmlElement | undefined;
    while (this.index < this.source.length && !root) {
      if (this.source.startsWith('<!--', this.index)) {
        prolog.push(this.readComment());
      } else if (this.source.startsWith('<?', this.index)) {
        prolog.push(this.readProcessingInstruction());
      } else if (this.source.startsWith('</', this.index)) {
        throw new Error('Invalid XML: unexpected closing tag before root element');
      } else if (
        this.source.startsWith('<![CDATA[', this.index) ||
        this.source.startsWith('<!', this.index)
      ) {
        throw new Error('Invalid XML: unexpected declaration before root element');
      } else if (this.source[this.index] === '<') {
        root = this.readElement();
      } else {
        const text = this.readText(true);
        if (text.text.trim()) {
          throw new Error('Invalid XML: text is not allowed before the root element');
        }
        prolog.push(text);
      }
    }

    if (!root) {
      throw new Error('Invalid XML: missing root element');
    }

    const epilog: XmlTopLevelNode[] = [];
    while (this.index < this.source.length) {
      if (this.source.startsWith('<!--', this.index)) {
        epilog.push(this.readComment());
      } else if (this.source.startsWith('<?', this.index)) {
        epilog.push(this.readProcessingInstruction());
      } else if (this.source.startsWith('</', this.index)) {
        throw new Error('Invalid XML: unexpected closing tag after root element');
      } else if (
        this.source.startsWith('<![CDATA[', this.index) ||
        this.source.startsWith('<!', this.index)
      ) {
        throw new Error('Invalid XML: unexpected declaration after root element');
      } else if (this.source[this.index] === '<') {
        throw new Error('Invalid XML: multiple root elements');
      } else {
        const text = this.readText(true);
        if (text.text.trim()) {
          throw new Error('Invalid XML: text is not allowed after the root element');
        }
        epilog.push(text);
      }
    }

    return { declaration, root, prolog, epilog };
  }

  private readDeclaration(): string | undefined {
    if (
      !this.source.startsWith('<?xml', this.index) ||
      !/[\s?]/.test(this.source[this.index + 5] ?? '')
    ) {
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
        if (!closingName) {
          throw new Error(`Invalid XML: unexpected closing ${name}`);
        }
        if (name !== closingName) {
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
      if (this.source.startsWith('<!', this.index)) {
        throw new Error('Invalid XML declaration inside an element');
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

  private readText(preserveLineEndings = false): XmlTextNode {
    const next = this.source.indexOf('<', this.index);
    const end = next < 0 ? this.source.length : next;
    const rawText = this.source.slice(this.index, end);
    const text = unescapeXml(preserveLineEndings ? rawText : rawText.replace(/\r\n?/g, '\n'));
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
  let index = 0;
  while (index < source.length) {
    while (/\s/.test(source[index] ?? '')) {
      index += 1;
    }
    if (index >= source.length) {
      break;
    }

    const nameStart = index;
    while (index < source.length && !/[\s=]/.test(source[index])) {
      index += 1;
    }
    const name = source.slice(nameStart, index);
    if (!name) {
      throw new Error('Invalid XML attribute name');
    }

    while (/\s/.test(source[index] ?? '')) {
      index += 1;
    }
    if (source[index] !== '=') {
      throw new Error(`Invalid XML attribute ${name}: missing equals sign`);
    }
    index += 1;
    while (/\s/.test(source[index] ?? '')) {
      index += 1;
    }

    const quote = source[index];
    if (quote !== '"' && quote !== "'") {
      throw new Error(`Invalid XML attribute ${name}: value must be quoted`);
    }
    index += 1;
    const valueStart = index;
    while (index < source.length && source[index] !== quote) {
      index += 1;
    }
    if (index >= source.length) {
      throw new Error(`Invalid XML attribute ${name}: missing closing quote`);
    }
    const rawValue = source
      .slice(valueStart, index)
      .replace(/\r\n?/g, '\n')
      .replace(/[\t\n]/g, ' ');
    index += 1;
    attributes.push({
      name,
      localName: localName(name),
      value: unescapeXml(rawValue),
      quote: quote as '"' | "'",
    });
  }

  return attributes;
}

function containsDoctype(source: string): boolean {
  let index = 0;
  while (index < source.length) {
    const declarationStart = source.indexOf('<!', index);
    if (declarationStart < 0) {
      return false;
    }
    if (source.startsWith('<!--', declarationStart)) {
      const commentEnd = source.indexOf('-->', declarationStart + 4);
      index = commentEnd < 0 ? source.length : commentEnd + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', declarationStart)) {
      const cdataEnd = source.indexOf(']]>', declarationStart + 9);
      index = cdataEnd < 0 ? source.length : cdataEnd + 3;
      continue;
    }
    if (source.startsWith('<?', declarationStart)) {
      const instructionEnd = source.indexOf('?>', declarationStart + 2);
      index = instructionEnd < 0 ? source.length : instructionEnd + 2;
      continue;
    }
    if (source.slice(declarationStart, declarationStart + 9).toUpperCase() === '<!DOCTYPE') {
      return true;
    }
    index = declarationStart + 2;
  }
  return false;
}

function detectLineEnding(source: string): '\r\n' | '\n' | '\r' {
  const lineEnding = /\r\n|\n|\r/.exec(source)?.[0];
  return lineEnding === '\r\n' || lineEnding === '\r' || lineEnding === '\n' ? lineEnding : '\n';
}
