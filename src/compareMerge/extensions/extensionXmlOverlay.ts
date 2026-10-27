import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import { CFE_BORROW_TYPE_MATRIX } from '../../extensionSupport/cfeProject/borrowObjectBuilder';
import type { ExtensionIndexedObject } from './extensionMetadataIndex';
import { getValueByLocalName, localName } from '../../parsers/xmlNavHelpers';
import { XmlParser } from '../../parsers/xmlParser';

const SIMPLE_PROPERTIES = new Set(['Synonym', 'Comment']);
const INTERCEPT_KINDS = new Set(['Before', 'After', 'Instead']);
const PROPERTY_STATES = new Set(['Notify', 'MultiState', 'Extended']);
const COMMON_MODULE_PROPERTIES = CFE_BORROW_TYPE_MATRIX.CommonModule?.copiedBooleanProperties ?? [];
const PRESERVE_ORDER_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  preserveOrder: true,
  parseTagValue: false,
  commentPropName: '#comment',
  cdataTagName: '__cdata',
  suppressEmptyNode: false,
};
export function overlaySimpleProperties(targetBytes: Buffer, sourceBytes: Buffer, metadataType: string): { content: Buffer } | { error: string } {
  const targetXml = decodeXml(targetBytes);
  const sourceXml = decodeXml(sourceBytes);
  const targetParsed = parseOrderedXml(targetXml);
  const sourceParsed = parseOrderedXml(sourceXml);
  if (!targetParsed || !sourceParsed) {
    return { error: 'Не удалось разобрать descriptor для ограниченного property overlay.' };
  }
  const targetProperties = findPropertiesChildren(targetParsed, metadataType);
  const sourceProperties = findPropertiesChildren(sourceParsed, metadataType);
  if (!targetProperties || !sourceProperties) {
    return { error: 'В descriptor отсутствует единственный прямой Properties.' };
  }
  const allowed = new Set(SIMPLE_PROPERTIES);
  if (metadataType === 'CommonModule') {
    for (const property of COMMON_MODULE_PROPERTIES) {allowed.add(property);}
  }
  for (const property of allowed) {
    const sourceNodes = directElementNodes(sourceProperties, property);
    const targetNodes = directElementNodes(targetProperties, property);
    if (sourceNodes.length > 1 || targetNodes.length > 1) {
      return { error: `Разрешённое свойство ${property} повторяется в descriptor.` };
    }
    if (property !== 'Synonym' && property !== 'Comment' && sourceNodes.length > 0) {
      const booleanValue = xmlNodeText(sourceNodes[0]!);
      if (booleanValue !== 'true' && booleanValue !== 'false') {
        return { error: `Boolean-свойство ${property} имеет недопустимое значение.` };
      }
    }
    if (sourceNodes.length === 0) {
      continue;
    }
    replaceOrAppendDirectChild(targetProperties, property, cloneXmlNode(sourceNodes[0]!));
  }
  const serialized = buildOrderedXml(targetParsed);
  if (targetBytes.toString('utf8').startsWith('\uFEFF') && !serialized.startsWith('\uFEFF')) {
    return { content: Buffer.from(`\uFEFF${serialized}`, 'utf8') };
  }
  return { content: Buffer.from(serialized, 'utf8') };
}

export function isSemanticOverlayChanged(targetBytes: Buffer, sourceBytes: Buffer, metadataType: string): boolean {
  const target = parseOrderedXml(decodeXml(targetBytes));
  const source = parseOrderedXml(decodeXml(sourceBytes));
  if (!target || !source) {return true;}
  const targetProperties = findPropertiesChildren(target, metadataType);
  const sourceProperties = findPropertiesChildren(source, metadataType);
  if (!targetProperties || !sourceProperties) {return true;}
  const properties = new Set(SIMPLE_PROPERTIES);
  if (metadataType === 'CommonModule') {
    for (const property of COMMON_MODULE_PROPERTIES) {properties.add(property);}
  }
  for (const property of properties) {
    const targetNodes = directElementNodes(targetProperties, property);
    const sourceNodes = directElementNodes(sourceProperties, property);
    if (targetNodes.length > 1 || sourceNodes.length > 1) {return true;}
    if (sourceNodes.length === 0) {continue;}
    if (property === 'Synonym' || property === 'Comment') {
      if (targetNodes.length === 0 || JSON.stringify(targetNodes[0]) !== JSON.stringify(sourceNodes[0])) {return true;}
      continue;
    }
    const targetValue = targetNodes.length === 0 ? undefined : xmlNodeText(targetNodes[0]!);
    const sourceValue = xmlNodeText(sourceNodes[0]!);
    if ((targetValue !== 'true' && targetValue !== 'false') || (sourceValue !== 'true' && sourceValue !== 'false') || targetValue !== sourceValue) {return true;}
  }
  return false;
}

function parseOrderedXml(xml: string): XmlOrderedNode[] | undefined {
  try {
    const parsed = new XMLParser(PRESERVE_ORDER_OPTIONS).parse(xml);
    return Array.isArray(parsed) ? parsed as XmlOrderedNode[] : undefined;
  } catch {
    return undefined;
  }
}

function buildOrderedXml(nodes: readonly XmlOrderedNode[]): string {
  return new XMLBuilder(PRESERVE_ORDER_OPTIONS).build(nodes) as string;
}

type XmlOrderedNode = Record<string, unknown>;

function findPropertiesChildren(nodes: XmlOrderedNode[], metadataType: string): XmlOrderedNode[] | undefined {
  const metaNodes = directElementNodes(nodes, 'MetaDataObject');
  if (metaNodes.length !== 1) {return undefined;}
  const metadataChildren = metaNodes[0]!['MetaDataObject'];
  const actualObject = directElementNodes(metadataChildren, metadataType)[0];
  const objectContent = actualObject?.[metadataType];
  if (!Array.isArray(objectContent)) {return undefined;}
  const properties = directElementNodes(objectContent as XmlOrderedNode[], 'Properties');
  return properties.length === 1 && Array.isArray(properties[0]!.Properties)
    ? properties[0]!.Properties as XmlOrderedNode[]
    : undefined;
}

function directElementNodes(nodes: unknown, name: string): XmlOrderedNode[] {
  if (!Array.isArray(nodes)) {return [];}
  return (nodes as XmlOrderedNode[]).filter((node) => Object.keys(node).some((key) => !isOrderedMetaKey(key) && localName(key) === name));
}

function replaceOrAppendDirectChild(parentChildren: XmlOrderedNode[], name: string, replacement: XmlOrderedNode): void {
  const index = parentChildren.findIndex((node) => Object.keys(node).some((key) => !isOrderedMetaKey(key) && localName(key) === name));
  if (index < 0) {parentChildren.push(replacement);}
  else {parentChildren[index] = replacement;}
}

function cloneXmlNode(node: XmlOrderedNode): XmlOrderedNode {
  return JSON.parse(JSON.stringify(node)) as XmlOrderedNode;
}

function xmlNodeText(node: XmlOrderedNode): string | undefined {
  const key = Object.keys(node).find((name) => !isOrderedMetaKey(name));
  if (!key || !Array.isArray(node[key])) {return undefined;}
  const content = node[key] as XmlOrderedNode[];
  if (content.length === 0) {return '';}
  if (content.length === 1 && typeof content[0]?.['#text'] === 'string') {return String(content[0]['#text']).trim();}
  return undefined;
}

function isOrderedMetaKey(key: string): boolean {
  return key === ':@' || key.startsWith('@_') || key.startsWith('#') || key.startsWith('?');
}

export function readCommonModuleBooleans(xml: string, properties: readonly string[]): { values: Record<string, string> } | { error: string } {
  if (properties.length === 0) {return { values: {} };}
  const parsed = safeParse(xml);
  if (!parsed) {return { error: 'Не удалось разобрать base CommonModule descriptor.' };}
  const object = findObjectProperties(parsed, 'CommonModule');
  if (!object) {return { error: 'В base CommonModule отсутствует Properties.' };}
  const values: Record<string, string> = {};
  for (const property of properties) {
    const value = readPropertyScalar(object, property);
    if (value !== undefined && value !== 'true' && value !== 'false') {
      return { error: `Boolean-свойство ${property} base CommonModule имеет недопустимое значение.` };
    }
    values[property] = value ?? 'false';
  }
  return { values };
}

export function isValidPropertyState(object: ExtensionIndexedObject): boolean {
  if (!object.descriptorContent) {return false;}
  const parsed = safeParse(decodeXml(object.descriptorContent));
  if (!parsed) {return false;}
  let valid = true;
  walkValues(parsed, (key, value) => {
    if (localName(key) !== 'PropertyState') {return;}
    for (const propertyState of asArray(value)) {
      if (!isRecord(propertyState)) {
        valid = false;
        continue;
      }
      const property = readAnySimpleText(propertyState, 'Property');
      const state = readAnySimpleText(propertyState, 'State');
      if (!property || !state || !PROPERTY_STATES.has(state)) {valid = false;}
    }
  });
  return valid;
}

export function hasUnknownInterceptShape(object: ExtensionIndexedObject): boolean {
  const xmlParts = [
    object.descriptorContent,
    ...object.sidecarFiles
      .filter((file) => file.relativePath.toLowerCase().endsWith('.xml'))
      .map((file) => file.content),
  ].filter(isDefined).map(decodeXml);
  for (const xml of xmlParts) {
    const callTypes = [...xml.matchAll(/\bcallType\s*=\s*(['"])(.*?)\1/giu)];
    if (callTypes.some((match) => !INTERCEPT_KINDS.has(match[2]!))) {return true;}
    if (/<(?:[\w.-]+:)?(?:Intercept|Interception|MethodInterception)\b/iu.test(xml)) {return true;}
  }
  return false;
}

export function hasNonEmptyChildObjects(object: ExtensionIndexedObject): boolean {
  if (!object.descriptorContent) {return true;}
  const parsed = safeParse(decodeXml(object.descriptorContent));
  if (!parsed) {return true;}
  const metadataType = object.metadataType;
  const metadataObject = singleRecord(getValueByLocalName(parsed, 'MetaDataObject'));
  const metadata = metadataObject ? getValueByLocalName(metadataObject, metadataType) : undefined;
  const root = singleRecord(metadata);
  if (!root) {return true;}
  const childObjects = getValueByLocalName(root, 'ChildObjects');
  if (childObjects === undefined) {return false;}
  const childContent = Array.isArray(childObjects) && childObjects.length === 1
    ? childObjects[0]
    : childObjects;
  if (typeof childContent === 'string') {
    return childContent.trim().length > 0;
  }
  if (childContent === null || (Array.isArray(childContent) && childContent.length === 0)) {return false;}
  const record = singleRecord(childContent);
  if (!record) {return true;}
  return Object.entries(record).some(([key, value]) => !isXmlMetaKey(key) && value !== undefined && value !== null);
}

export function hasUnsupportedPropertyChanges(adopted: ExtensionIndexedObject, base: ExtensionIndexedObject): boolean {
  const adoptedParsed = adopted.descriptorContent ? safeParse(decodeXml(adopted.descriptorContent)) : undefined;
  const baseParsed = base.descriptorContent ? safeParse(decodeXml(base.descriptorContent)) : undefined;
  if (!adoptedParsed || !baseParsed) {return true;}
  const adoptedProps = findObjectProperties(adoptedParsed, adopted.metadataType);
  const baseProps = findObjectProperties(baseParsed, base.metadataType);
  if (!adoptedProps || !baseProps) {return true;}
  const allowed = new Set(SIMPLE_PROPERTIES);
  if (adopted.metadataType === 'CommonModule') {for (const property of COMMON_MODULE_PROPERTIES) {allowed.add(property);}}
  const ignored = new Set(['ObjectBelonging', 'ExtendedConfigurationObject']);
  for (const property of new Set([...Object.keys(adoptedProps), ...Object.keys(baseProps)])) {
    if (isXmlMetaKey(property) || ignored.has(localName(property)) || allowed.has(localName(property))) {continue;}
    // An omitted value in an adopted descriptor means “inherit from base”; the
    // overlay writer leaves that base property untouched. Only an explicit
    // source value can represent an unsupported change.
    if (adoptedProps[property] !== undefined && stableValue(adoptedProps[property]) !== stableValue(baseProps[property])) {return true;}
  }
  return false;
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) {return `[${value.map(stableValue).join(',')}]`;}
  if (isRecord(value)) {return `{${Object.keys(value).sort().map((key) => `${key}:${stableValue(value[key])}`).join(',')}}`;}
  return JSON.stringify(value);
}

export function replaceRootUuid(content: Buffer, metadataType: string, uuid: string): Buffer | undefined {
  const xml = content.toString('utf8');
  const expression = new RegExp(`(<(?:[\\w.-]+:)?${escapeRegExp(metadataType)}\\b[^>]*\\buuid\\s*=\\s*)(["'])([^"']+)(\\2)`, 'iu');
  if (!expression.test(xml)) {return undefined;}
  const replaced = xml.replace(expression, (_match, prefix: string, quote: string) => `${prefix}${quote}${uuid}${quote}`);
  return Buffer.from(replaced, 'utf8');
}

function findObjectProperties(parsed: Record<string, unknown>, metadataType: string): Record<string, unknown> | undefined {
  const metadata = singleRecord(getValueByLocalName(parsed, 'MetaDataObject'));
  const object = metadata ? singleRecord(getValueByLocalName(metadata, metadataType)) : undefined;
  return object ? singleRecord(getValueByLocalName(object, 'Properties')) : undefined;
}

function readPropertyScalar(properties: Record<string, unknown>, name: string): string | undefined {
  const value = getValueByLocalName(properties, name);
  if (value === undefined) {return undefined;}
  const unwrapped = singleValue(value);
  if (typeof unwrapped === 'string') {return unwrapped.trim();}
  if (isRecord(unwrapped) && typeof unwrapped['#text'] === 'string') {return String(unwrapped['#text']).trim();}
  return undefined;
}

function readAnySimpleText(record: Record<string, unknown>, name: string): string | undefined {
  const value = getValueByLocalName(record, name);
  const unwrapped = singleValue(value);
  return typeof unwrapped === 'string' ? unwrapped.trim() : undefined;
}

function safeParse(xml: string): Record<string, unknown> | undefined {
  try {
    return XmlParser.parseString(xml);
  } catch {
    return undefined;
  }
}

function walkValues(value: unknown, visitor: (key: string, value: unknown) => void): void {
  if (Array.isArray(value)) {
    for (const entry of value) {walkValues(entry, visitor);}
    return;
  }
  if (!isRecord(value)) {return;}
  for (const [key, child] of Object.entries(value)) {
    visitor(key, child);
    walkValues(child, visitor);
  }
}

function singleRecord(value: unknown): Record<string, unknown> | undefined {
  const unwrapped = singleValue(value);
  return isRecord(unwrapped) ? unwrapped : undefined;
}

function singleValue(value: unknown): unknown {
  if (!Array.isArray(value)) {return value;}
  return value.length === 1 ? value[0] : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isXmlMetaKey(key: string): boolean {
  return key === '@_' || key === ':@' || key.startsWith('@_') || key.startsWith('#') || key.startsWith('?');
}

function decodeXml(content: Buffer): string {
  return content.toString('utf8').replace(/^\\uFEFF/u, '');
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
