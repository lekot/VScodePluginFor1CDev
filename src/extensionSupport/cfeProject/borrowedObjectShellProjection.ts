import { XMLValidator } from 'fast-xml-parser';
import {
  getMetadataTypeDescriptorByRootTag,
  type MetadataTypeDescriptor,
} from '../../constants/metadataTypeDescriptors';
import {
  elementChildren,
  parseXmlDocument,
  serializeXmlDocument,
  textContent,
  type XmlChildNode,
  type XmlElement,
  type XmlTextNode,
  cloneXmlElement,
} from '../../compareMerge/xml/xmlDom';
import {
  getExplicitGeneratedTypeSpecs,
  ROOT_TAGS_WITHOUT_INTERNALINFO,
} from '../../utils/xml/metadataGeneratedTypeSchema';
import { validateElementName } from '../../utils/elementNameValidator';
import type { CfeObjectIdentity } from './ownership';

const SUPPORTED_FORMATS = new Set(['2.17', '2.18', '2.19', '2.20', '2.21']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

export const COMMON_MODULE_BORROWED_BOOLEAN_PROPERTIES = Object.freeze([
  'Global',
  'ClientManagedApplication',
  'Server',
  'ExternalConnection',
  'ClientOrdinaryApplication',
  'ServerCall',
] as const);

type BorrowedPropertyRule = {
  readonly name: string;
  readonly kind: 'boolean' | 'scalar' | 'xml';
};

/** Source properties copied into adopted shells as XML, with only shape checks. */
export const BORROWED_OBJECT_SOURCE_PROPERTY_POLICY: Readonly<Record<string, readonly BorrowedPropertyRule[]>> = Object.freeze({
  CommonModule: Object.freeze(COMMON_MODULE_BORROWED_BOOLEAN_PROPERTIES.map((name) => Object.freeze({ name, kind: 'boolean' as const }))),
  Language: Object.freeze([{ name: 'LanguageCode', kind: 'scalar' as const }]),
  InformationRegister: Object.freeze([
    { name: 'InformationRegisterPeriodicity', kind: 'scalar' as const },
    { name: 'WriteMode', kind: 'scalar' as const },
  ]),
  Constant: Object.freeze([{ name: 'Type', kind: 'xml' as const }]),
  CommonForm: Object.freeze([{ name: 'FormType', kind: 'scalar' as const }]),
});

export interface BorrowedObjectSourceValidationInput {
  readonly sourceXml: string | Buffer;
  readonly identity: Pick<CfeObjectIdentity, 'type' | 'name' | 'uuid'>;
  readonly formatVersion: string;
}

export interface BorrowedObjectShellProjectionInput extends BorrowedObjectSourceValidationInput {
  readonly localUuid: string;
}

export type BorrowedObjectSourceValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export type BorrowedObjectShellProjectionResult =
  | { readonly ok: true; readonly xml: string }
  | { readonly ok: false; readonly reason: string };

/** Builds a minimal adopted shell from a validated own source descriptor. */
export function buildBorrowedObjectShellFromSource(
  input: BorrowedObjectShellProjectionInput,
): BorrowedObjectShellProjectionResult {
  try {
    const source = validateBorrowedObjectSourceShape(input);
    if (!isNonZeroUuid(input.localUuid) || input.localUuid.toLocaleLowerCase() === source.sourceUuid.toLocaleLowerCase()) {
      fail('UUID локального объекта должен быть корректным и отличаться от UUID источника.');
    }
    return { ok: true, xml: projectBorrowedObjectShell(input, source) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Validates the exact base descriptor checks used by both analysis and materialization. */
export function validateBorrowedObjectSource(
  input: BorrowedObjectSourceValidationInput,
): BorrowedObjectSourceValidationResult {
  try {
    validateBorrowedObjectSourceShape(input);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

interface ValidatedBorrowedSource {
  readonly sourceDocument: ReturnType<typeof parseXmlDocument>;
  readonly sourceObject: XmlElement;
  readonly sourceProperties: XmlElement;
  readonly sourceName: XmlElement;
  readonly internalInfo?: XmlElement;
  readonly copiedProperties: readonly XmlElement[];
  readonly sourceUuid: string;
  readonly sourceDescriptor: MetadataTypeDescriptor;
}

function validateBorrowedObjectSourceShape(input: BorrowedObjectSourceValidationInput): ValidatedBorrowedSource {
  if (!SUPPORTED_FORMATS.has(input.formatVersion)) {
    fail('Целевой формат XML объекта не поддерживается.');
  }
  if (!isNonZeroUuid(input.identity.uuid)) {
    fail('UUID исходного объекта некорректен.');
  }
  if (!input.identity.name || validateElementName(input.identity.name, []) !== null) {
    fail('Имя исходного объекта некорректно.');
  }

  const suppliedDescriptor = getMetadataTypeDescriptorByRootTag(input.identity.type);
  if (!suppliedDescriptor || !suppliedDescriptor.structure.designerRootObject) {
    fail(`Тип «${input.identity.type}» отсутствует в реестре корневых метаданных.`);
  }

  const sourceXml = typeof input.sourceXml === 'string' ? input.sourceXml : input.sourceXml.toString('utf8');
  const xml = sourceXml.startsWith('\uFEFF') ? sourceXml.slice(1) : sourceXml;
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    fail(`Исходный XML-дескриптор содержит некорректный XML: ${validation.err?.msg ?? 'ошибка структуры'}`);
  }

  const sourceDocument = parseXmlDocument(xml);
  if (sourceDocument.root.localName !== 'MetaDataObject') {
    fail('Исходный XML-дескриптор должен иметь корень MetaDataObject.');
  }
  const sourceVersion = readSingleAttribute(sourceDocument.root, 'version');
  if (!sourceVersion || !SUPPORTED_FORMATS.has(sourceVersion)) {
    fail('Версия исходного XML-дескриптора отсутствует или не поддерживается.');
  }
  if (sourceVersion !== input.formatVersion) {
    fail('Версия исходного XML-дескриптора не совпадает с целевым форматом.');
  }

  const metadataRoots = elementChildren(sourceDocument.root);
  if (metadataRoots.length !== 1) {
    fail('MetaDataObject должен содержать ровно один корневой объект метаданных.');
  }
  const sourceObject = metadataRoots[0]!;
  const sourceDescriptor = getMetadataTypeDescriptorByRootTag(sourceObject.localName);
  if (!sourceDescriptor || sourceDescriptor !== suppliedDescriptor) {
    fail('Тип исходного XML не совпадает с каноническим типом идентичности.');
  }

  const sourceUuid = readSingleAttribute(sourceObject, 'uuid');
  if (!isNonZeroUuid(sourceUuid) || sourceUuid.toLocaleLowerCase() !== input.identity.uuid.toLocaleLowerCase()) {
    fail('UUID исходного XML не совпадает с идентичностью объекта.');
  }

  const propertiesNodes = directElements(sourceObject, 'Properties');
  if (propertiesNodes.length !== 1) {
    fail('Исходный объект должен содержать ровно один прямой элемент Properties.');
  }
  const sourceProperties = propertiesNodes[0]!;
  if (directElements(sourceProperties, 'ObjectBelonging').length > 0
    || directElements(sourceProperties, 'ExtendedConfigurationObject').length > 0) {
    fail('Исходный объект для заимствования должен быть собственным объектом базовой конфигурации.');
  }

  const nameNodes = directElements(sourceProperties, 'Name');
  if (nameNodes.length !== 1 || readScalarText(nameNodes[0]!) !== input.identity.name
    || textContent(nameNodes[0]!) !== input.identity.name) {
    fail('Имя в исходном XML не совпадает с идентичностью объекта.');
  }
  if (directElements(sourceProperties, 'Comment').length > 1) {
    fail('Свойство Comment повторяется в исходном XML-дескрипторе.');
  }

  const childObjectsNodes = directElements(sourceObject, 'ChildObjects');
  if (childObjectsNodes.length > 1) {
    fail('Исходный объект содержит несколько прямых элементов ChildObjects.');
  }
  if (!sourceDescriptor.structure.hasChildObjects && childObjectsNodes.length > 0) {
    fail(`Тип ${sourceDescriptor.designerRootTag} не допускает прямой ChildObjects по реестру.`);
  }

  const internalInfoNodes = directElements(sourceObject, 'InternalInfo');
  if (internalInfoNodes.length > 1) {
    fail('Исходный объект содержит несколько элементов InternalInfo.');
  }
  const internalInfo = internalInfoNodes[0];
  validateInternalInfo(sourceDescriptor, input.identity.name, internalInfo);

  const copiedProperties = readTypedSourceProperties(sourceDescriptor, sourceProperties);
  return {
    sourceDocument,
    sourceObject,
    sourceProperties,
    sourceName: nameNodes[0]!,
    ...(internalInfo ? { internalInfo } : {}),
    copiedProperties,
    sourceUuid,
    sourceDescriptor,
  };
}

function projectBorrowedObjectShell(
  input: BorrowedObjectShellProjectionInput,
  source: ValidatedBorrowedSource,
): string {
  const { sourceDocument, sourceObject, sourceProperties, sourceName, internalInfo, copiedProperties, sourceUuid, sourceDescriptor } = source;
  const outputEnvelope = cloneXmlElement(sourceDocument.root);
  const versionAttribute = outputEnvelope.attributes.find((attribute) => attribute.localName === 'version');
  if (!versionAttribute) {
    fail('В MetaDataObject отсутствует версия XML.');
  }
  versionAttribute.value = input.formatVersion;

  const outputObject = cloneXmlElement(sourceObject);
  outputObject.name = qualifyLike(sourceObject.name, sourceDescriptor.designerRootTag);
  outputObject.localName = sourceDescriptor.designerRootTag;
  const uuidAttributes = outputObject.attributes.filter((attribute) => attribute.localName === 'uuid');
  if (uuidAttributes.length !== 1) {
    fail('Исходный объект должен содержать ровно один атрибут uuid.');
  }
  uuidAttributes[0]!.value = input.localUuid;

  const outputChildren: XmlChildNode[] = [];
  if (internalInfo) {
    outputChildren.push(cloneXmlElement(internalInfo));
  }
  outputChildren.push(buildProperties(sourceProperties, sourceName, copiedProperties, sourceUuid));
  if (sourceDescriptor.structure.hasChildObjects) {
    outputChildren.push(createEmptyElement(qualifyLike(sourceObject.name, 'ChildObjects'), 'ChildObjects'));
  }
  outputObject.children = outputChildren;
  for (const child of outputObject.children) {
    if (child.kind === 'element') {
      child.parent = outputObject;
    }
  }

  outputEnvelope.children = [outputObject];
  outputObject.parent = outputEnvelope;
  const serialized = serializeXmlDocument({
    declaration: '<?xml version="1.0" encoding="UTF-8"?>',
    root: outputEnvelope,
  });
  return `\uFEFF${serialized.replace(/\r?\n/gu, '\r\n')}\r\n`;
}

function readTypedSourceProperties(
  descriptor: MetadataTypeDescriptor,
  sourceProperties: XmlElement,
): readonly XmlElement[] {
  const rules = BORROWED_OBJECT_SOURCE_PROPERTY_POLICY[descriptor.designerRootTag] ?? [];
  for (const rule of rules) {
    const matches = directElements(sourceProperties, rule.name);
    if (matches.length > 1) {
      fail(`Свойство ${rule.name} повторяется в исходном XML-дескрипторе.`);
    }
    const element = matches[0];
    if (!element) {
      continue;
    }
    if (rule.kind === 'boolean') {
      const value = readScalarText(element);
      if (value !== 'true' && value !== 'false') {
        fail(`Логическое свойство ${rule.name} имеет некорректную структуру или значение.`);
      }
    } else if (rule.kind === 'scalar' && readScalarText(element) === undefined) {
      fail(`Свойство ${rule.name} должно содержать скалярное значение.`);
    }
  }

  const allowed = new Set(rules.map((rule) => rule.name));
  return sourceProperties.children
    .filter((child): child is XmlElement => child.kind === 'element' && allowed.has(child.localName))
    .map((element) => element);
}

function buildProperties(
  sourceProperties: XmlElement,
  sourceName: XmlElement,
  copiedProperties: readonly XmlElement[],
  sourceUuid: string,
): XmlElement {
  const childPrefixName = sourceProperties.name;
  const children: XmlChildNode[] = [
    createTextElement(qualifyLike(childPrefixName, 'ObjectBelonging'), 'ObjectBelonging', 'Adopted'),
    cloneXmlElement(sourceName),
  ];
  const sourceComments = directElements(sourceProperties, 'Comment');
  if (sourceComments.length > 1) {
    fail('Свойство Comment повторяется в исходном XML-дескрипторе.');
  }
  children.push(sourceComments[0]
    ? cloneXmlElement(sourceComments[0])
    : createEmptyElement(qualifyLike(childPrefixName, 'Comment'), 'Comment'));
  children.push(createTextElement(
    qualifyLike(childPrefixName, 'ExtendedConfigurationObject'),
    'ExtendedConfigurationObject',
    sourceUuid,
  ));
  for (const property of copiedProperties) {
    children.push(cloneXmlElement(property));
  }

  const properties: XmlElement = {
    kind: 'element',
    name: sourceProperties.name,
    localName: sourceProperties.localName,
    attributes: sourceProperties.attributes.map((attribute) => ({ ...attribute })),
    children,
  };
  for (const child of children) {
    if (child.kind === 'element') {
      child.parent = properties;
    }
  }
  return properties;
}

function validateInternalInfo(
  descriptor: MetadataTypeDescriptor,
  sourceName: string,
  internalInfo: XmlElement | undefined,
): void {
  const typeRequiresInternalInfo = !ROOT_TAGS_WITHOUT_INTERNALINFO.has(descriptor.designerRootTag);
  if (!internalInfo && typeRequiresInternalInfo) {
    fail(`Для типа ${descriptor.designerRootTag} исходный InternalInfo обязателен.`);
  }
  if (!internalInfo) {
    return;
  }

  const generatedTypes = directElements(internalInfo, 'GeneratedType');
  if (typeRequiresInternalInfo && generatedTypes.length === 0) {
    fail(`InternalInfo типа ${descriptor.designerRootTag} не содержит GeneratedType.`);
  }
  if (!typeRequiresInternalInfo && generatedTypes.length > 0) {
    fail(`Тип ${descriptor.designerRootTag} не должен содержать GeneratedType в InternalInfo.`);
  }

  const explicitSpecs = getExplicitGeneratedTypeSpecs(descriptor.designerRootTag);
  if (explicitSpecs && generatedTypes.length !== explicitSpecs.length) {
    fail(`В InternalInfo типа ${descriptor.designerRootTag} неверное количество GeneratedType.`);
  }

  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  const expectedTypes = explicitSpecs
    ? new Set(explicitSpecs.map((spec) => `${spec.namePrefix}.${sourceName}\0${spec.category}`))
    : undefined;
  for (const generatedType of generatedTypes) {
    const name = readSingleAttribute(generatedType, 'name');
    const category = readSingleAttribute(generatedType, 'category');
    if (!name || !category) {
      fail('GeneratedType должен содержать атрибуты name и category.');
    }
    if (seenNames.has(name.toLocaleLowerCase())) {
      fail('InternalInfo содержит повторяющиеся GeneratedType name.');
    }
    seenNames.add(name.toLocaleLowerCase());
    if (expectedTypes && !expectedTypes.delete(`${name}\0${category}`)) {
      fail(`GeneratedType ${name} не совпадает со схемой типа ${descriptor.designerRootTag}.`);
    }

    for (const idName of ['TypeId', 'ValueId']) {
      const idNodes = directElements(generatedType, idName);
      if (idNodes.length !== 1) {
        fail(`GeneratedType должен содержать ровно один ${idName}.`);
      }
      const id = readScalarText(idNodes[0]!);
      if (!isNonZeroUuid(id)) {
        fail(`GeneratedType ${idName} должен содержать ненулевой UUID.`);
      }
      const normalizedId = id.toLocaleLowerCase();
      if (seenIds.has(normalizedId)) {
        fail('InternalInfo содержит повторяющиеся UUID GeneratedType.');
      }
      seenIds.add(normalizedId);
    }
  }
  if (expectedTypes && expectedTypes.size > 0) {
    fail(`InternalInfo типа ${descriptor.designerRootTag} не содержит все GeneratedType по схеме.`);
  }
}

function directElements(parent: XmlElement, localName: string): XmlElement[] {
  return parent.children.filter(
    (child): child is XmlElement => child.kind === 'element' && child.localName === localName,
  );
}

function readSingleAttribute(element: XmlElement, localName: string): string | undefined {
  const matches = element.attributes.filter((attribute) => attribute.localName === localName);
  return matches.length === 1 ? matches[0]!.value.trim() : undefined;
}

function readScalarText(element: XmlElement): string | undefined {
  if (elementChildren(element).length > 0) {
    return undefined;
  }
  return textContent(element).trim();
}

function isNonZeroUuid(value: unknown): value is string {
  return typeof value === 'string'
    && UUID_PATTERN.test(value.trim())
    && value.trim().toLocaleLowerCase() !== ZERO_UUID;
}

function qualifyLike(qualifiedName: string, localName: string): string {
  const separator = qualifiedName.indexOf(':');
  return separator < 0 ? localName : `${qualifiedName.slice(0, separator)}:${localName}`;
}

function createEmptyElement(name: string, localName: string): XmlElement {
  return { kind: 'element', name, localName, attributes: [], children: [] };
}

function createTextElement(name: string, localName: string, text: string): XmlElement {
  const textNode: XmlTextNode = { kind: 'text', text };
  const element: XmlElement = { kind: 'element', name, localName, attributes: [], children: [textNode] };
  return element;
}

function fail(message: string): never {
  throw new Error(message);
}
