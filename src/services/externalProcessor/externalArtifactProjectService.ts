import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import {
  elementChildren,
  parseXmlDocument,
  serializeXmlDocument,
  textContent,
  type XmlChildNode,
  type XmlElement,
  type XmlTextNode,
} from '../../compareMerge/xml/xmlDom';
import {
  CreateExternalArtifactProjectRequest,
  ExternalArtifactKind,
  ExternalArtifactProjectOutcome,
  ExportEmbeddedArtifactRequest,
} from './externalArtifactProjectTypes';

const EXTERNAL_DATA_PROCESSOR_CLASS_ID = 'c3831ec8-d8d5-4f93-8a22-f9bfae07327f';
const EXTERNAL_REPORT_CLASS_ID = 'e41aff26-25cf-4bb6-b6c1-3f478a75f374';
const SUPPORTED_DESIGNER_VERSIONS = new Set(['2.17', '2.18', '2.19', '2.20', '2.21']);
const EXTERNAL_CHILD_OBJECT_TYPES = new Set(['Attribute', 'TabularSection', 'Form', 'Template']);

type EmbeddedKind = 'DataProcessor' | 'Report';
type ReferencedChildMetadata = {
  readonly kind: 'Form' | 'Template';
  readonly name: string;
};

interface ReferenceTransform {
  readonly sourceKind: EmbeddedKind;
  readonly targetKind: ExternalArtifactKind;
  readonly objectName: string;
}

export class ExternalArtifactProjectService {
  constructor(
    private readonly templateDirectory = path.resolve(
      __dirname,
      '../../../resources/external-artifacts'
    )
  ) {}

  async create(
    request: CreateExternalArtifactProjectRequest
  ): Promise<ExternalArtifactProjectOutcome> {
    const workspaceRoot = await resolveWorkspaceRoot(request.workspaceRoot);
    const name = validateArtifactName(request.name);
    if (request.kind !== 'ExternalDataProcessor' && request.kind !== 'ExternalReport') {
      throw new Error('Тип внешнего объекта должен быть ExternalDataProcessor или ExternalReport.');
    }
    if (request.language !== 'ru' && request.language !== 'en') {
      throw new Error('Язык синонима должен быть ru или en.');
    }

    const projectDirectory = path.join(workspaceRoot, `${name}_src`);
    const rootXmlPath = path.join(projectDirectory, `${name}.xml`);
    await ensurePathDoesNotExist(projectDirectory);

    const profilePath = path.join(this.templateDirectory, `${request.kind}.xml`);
    const profile = await fs.promises.readFile(profilePath, 'utf8');
    const synonym = request.synonym?.trim() || name;
    const content = renderProfile(profile, {
      NAME: name,
      LANG: request.language,
      SYNONYM: synonym,
      ROOT_UUID: randomUUID(),
      OBJECT_ID: randomUUID(),
      TYPE_ID: randomUUID(),
      VALUE_ID: randomUUID(),
    });

    const stagingDirectory = path.join(workspaceRoot, `.cdt-external-project-${randomUUID()}`);
    try {
      await fs.promises.mkdir(stagingDirectory);
      await fs.promises.mkdir(path.join(stagingDirectory, name));
      await fs.promises.writeFile(path.join(stagingDirectory, `${name}.xml`), content, 'utf8');
      await ensurePathDoesNotExist(projectDirectory);
      await fs.promises.rename(stagingDirectory, projectDirectory);
    } catch (error) {
      await fs.promises.rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
      throw new Error(`Не удалось создать проект внешнего объекта: ${errorMessage(error)}`);
    }

    return { rootXmlPath, kind: request.kind, projectDirectory };
  }

  async exportEmbedded(
    request: ExportEmbeddedArtifactRequest
  ): Promise<ExternalArtifactProjectOutcome> {
    const workspaceRoot = await resolveWorkspaceRoot(request.workspaceRoot);
    const sourceRootXmlPath = path.resolve(request.sourceRootXmlPath);
    const sourceRootStat = await fs.promises.lstat(sourceRootXmlPath).catch((error: unknown) => {
      throw new Error(`Не удалось прочитать XML встроенного объекта: ${errorMessage(error)}`);
    });
    if (!sourceRootStat.isFile() || sourceRootStat.isSymbolicLink()) {
      throw new Error('XML встроенного объекта должен быть обычным файлом.');
    }
    const sourceRootRealPath = await fs.promises.realpath(sourceRootXmlPath);
    assertPathInside(workspaceRoot, sourceRootRealPath, 'Исходный объект должен находиться в workspace.');

    const { name, sourceKind, kind, convertedRoot, referencedChildren } =
      await convertEmbeddedRoot(sourceRootRealPath);
    const requestedProjectDirectory = path.resolve(request.destinationDirectory);
    const parentRealPath = await fs.promises.realpath(path.dirname(requestedProjectDirectory));
    assertPathInside(workspaceRoot, parentRealPath, 'Родитель каталога проекта должен находиться в workspace.');
    const projectDirectory = path.join(parentRealPath, path.basename(requestedProjectDirectory));
    assertPathInside(workspaceRoot, projectDirectory, 'Каталог проекта должен находиться в workspace.');
    const sourceDirectory = path.dirname(sourceRootRealPath);
    if (isPathInside(sourceDirectory, projectDirectory) || isPathInside(projectDirectory, sourceDirectory)) {
      throw new Error('Каталог назначения не должен пересекаться с исходным объектом.');
    }
    await ensurePathDoesNotExist(projectDirectory);

    const sourceObjectDirectory = path.join(sourceDirectory, name);
    await rejectRootCommandsDirectory(sourceObjectDirectory);
    await validateReferencedChildMetadata(sourceObjectDirectory, referencedChildren);
    const stagingDirectory = path.join(path.dirname(projectDirectory), `.cdt-external-project-${randomUUID()}`);
    try {
      await fs.promises.mkdir(stagingDirectory);
      const objectDirectory = path.join(stagingDirectory, name);
      await copyDirectoryWithoutLinks(sourceObjectDirectory, objectDirectory, {
        sourceKind,
        targetKind: kind,
        objectName: name,
      });
      const outputRootXmlPath = path.join(stagingDirectory, `${name}.xml`);
      await fs.promises.writeFile(outputRootXmlPath, convertedRoot, 'utf8');
      await ensurePathDoesNotExist(projectDirectory);
      await fs.promises.rename(stagingDirectory, projectDirectory);
    } catch (error) {
      await fs.promises.rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
      throw new Error(`Не удалось выгрузить встроенный объект: ${errorMessage(error)}`);
    }

    return {
      rootXmlPath: path.join(projectDirectory, `${name}.xml`),
      kind,
      projectDirectory,
    };
  }
}

async function resolveWorkspaceRoot(workspacePath: string): Promise<string> {
  if (!workspacePath.trim()) {
    throw new Error('Workspace не задан.');
  }
  const workspaceRoot = await fs.promises.realpath(path.resolve(workspacePath));
  const stat = await fs.promises.stat(workspaceRoot);
  if (!stat.isDirectory()) {
    throw new Error('Workspace должен быть каталогом.');
  }
  return workspaceRoot;
}

function validateArtifactName(value: string): string {
  const name = value.trim();
  if (!/^[\p{L}_][\p{L}\p{N}_]{0,79}$/u.test(name)) {
    throw new Error('Имя должно быть идентификатором 1С длиной до 80 символов.');
  }
  return name;
}

async function ensurePathDoesNotExist(targetPath: string): Promise<void> {
  try {
    await fs.promises.lstat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
  throw new Error(`Каталог назначения уже существует: ${targetPath}`);
}

function renderProfile(profile: string, values: Readonly<Record<string, string>>): string {
  let rendered = profile;
  for (const [key, value] of Object.entries(values)) {
    const replacement = key === 'NAME' || key === 'SYNONYM'
      ? escapeXmlText(value)
      : value;
    rendered = rendered.split(`{{${key}}}`).join(replacement);
  }
  if (/\{\{[A-Z_]+\}\}/u.test(rendered)) {
    throw new Error('Профиль внешнего объекта содержит неподдерживаемый шаблон.');
  }
  return rendered;
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function copyDirectoryWithoutLinks(
  sourceDirectory: string,
  destinationDirectory: string,
  transform?: ReferenceTransform
): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(sourceDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await fs.promises.mkdir(destinationDirectory);
      return;
    }
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Каталог встроенного объекта должен быть обычным каталогом без ссылок.');
  }
  await fs.promises.mkdir(destinationDirectory);
  const entries = await fs.promises.readdir(sourceDirectory, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDirectory, entry.name);
    const destinationPath = path.join(destinationDirectory, entry.name);
    const entryStat = await fs.promises.lstat(sourcePath);
    if (entryStat.isSymbolicLink()) {
      throw new Error(`Ссылки внутри дерева источника не поддерживаются: ${sourcePath}`);
    }
    if (entryStat.isDirectory()) {
      await copyDirectoryWithoutLinks(sourcePath, destinationPath, transform);
    } else if (entryStat.isFile()) {
      if (transform && path.extname(entry.name).toLocaleLowerCase() === '.xml') {
        const source = await fs.promises.readFile(sourcePath, 'utf8');
        const transformed = transformXmlReferences(source, transform);
        await fs.promises.writeFile(destinationPath, transformed, 'utf8');
      } else {
        await fs.promises.copyFile(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
      }
    } else {
      throw new Error(`Поддерживаются только файлы и каталоги: ${sourcePath}`);
    }
  }
}

async function rejectRootCommandsDirectory(sourceObjectDirectory: string): Promise<void> {
  const commandsDirectory = path.join(sourceObjectDirectory, 'Commands');
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(commandsDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new Error('Ссылки внутри дерева источника не поддерживаются.');
  }
  if (!stat.isDirectory()) {
    return;
  }
  if ((await fs.promises.readdir(commandsDirectory)).length > 0) {
    throw new Error(
      'Каталог Commands содержит команды конфигурации, которые нельзя перенести во внешний объект EPF/ERF без потери поведения.'
    );
  }
}

function assertPathInside(parentPath: string, candidatePath: string, message: string): void {
  if (!isPathInside(parentPath, candidatePath)) {
    throw new Error(message);
  }
}

function isPathInside(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function convertEmbeddedRoot(rootXmlPath: string): Promise<{
  readonly name: string;
  readonly sourceKind: 'DataProcessor' | 'Report';
  readonly kind: ExternalArtifactKind;
  readonly convertedRoot: string;
  readonly referencedChildren: readonly ReferencedChildMetadata[];
}> {
  const source = await fs.promises.readFile(rootXmlPath, 'utf8');
  assertSupportedXml(source, rootXmlPath);
  const document = parseXmlDocument(source);
  if (document.root.localName !== 'MetaDataObject') {
    throw new Error('Корневой элемент XML должен быть MetaDataObject.');
  }
  const version = document.root.attributes.find((attribute) => attribute.localName === 'version')?.value;
  if (!version || !SUPPORTED_DESIGNER_VERSIONS.has(version)) {
    throw new Error(`Версия Designer XML не поддерживается: ${version ?? 'не указана'} (допустимы 2.17–2.21).`);
  }
  const objectRoots = elementChildren(document.root);
  if (objectRoots.length !== 1) {
    throw new Error('MetaDataObject должен содержать ровно один DataProcessor или Report.');
  }

  const objectRoot = objectRoots[0];
  if (!isEmbeddedKind(objectRoot.localName)) {
    throw new Error('MetaDataObject должен содержать ровно один DataProcessor или Report.');
  }
  const sourceKind: EmbeddedKind = objectRoot.localName;
  const kind: ExternalArtifactKind = sourceKind === 'DataProcessor'
    ? 'ExternalDataProcessor'
    : 'ExternalReport';
  const name = validateArtifactName(readRootName(objectRoot));
  const transform: ReferenceTransform = { sourceKind, targetKind: kind, objectName: name };

  for (const child of elementChildren(objectRoot)) {
    if (!['InternalInfo', 'Properties', 'ChildObjects'].includes(child.localName)) {
      throw new Error(`Неизвестная конструкция в корне ${sourceKind}: ${child.localName}.`);
    }
  }
  const internalInfo = requireSingleChild(objectRoot, 'InternalInfo');
  const properties = requireSingleChild(objectRoot, 'Properties');
  const childObjects = requireSingleChild(objectRoot, 'ChildObjects');
  if (elementChildren(childObjects).some((child) => child.localName === 'Command')) {
    throw new Error(
      'Команды конфигурации нельзя перенести во внешний объект EPF/ERF без потери поведения.'
    );
  }
  const unsupportedChild = elementChildren(childObjects).find(
    (child) => !EXTERNAL_CHILD_OBJECT_TYPES.has(child.localName)
  );
  if (unsupportedChild) {
    throw new Error(
      `Дочерний объект ${unsupportedChild.localName} нельзя перенести во внешний объект EPF/ERF.`
    );
  }
  const referencedChildren = elementChildren(childObjects)
    .filter((child) => child.localName === 'Form' || child.localName === 'Template')
    .map((child): ReferencedChildMetadata => ({
      kind: child.localName as 'Form' | 'Template',
      name: validateArtifactName(textContent(child).trim()),
    }));
  const rootUuid = objectRoot.attributes.find((attribute) => attribute.localName === 'uuid')?.value;
  if (!rootUuid || !isUuid(rootUuid)) {
    throw new Error('У встроенного объекта отсутствует корректный UUID корневого объекта.');
  }

  objectRoot.name = replaceLocalName(objectRoot.name, kind);
  objectRoot.localName = kind;
  replaceRootInternalInfo(internalInfo, sourceKind, kind, name);
  replaceRootProperties(properties, sourceKind, kind);
  transformXmlReferencesInElement(objectRoot, transform);
  return {
    name,
    sourceKind,
    kind,
    convertedRoot: serializeXmlDocument(document),
    referencedChildren,
  };
}

async function validateReferencedChildMetadata(
  objectDirectory: string,
  referencedChildren: readonly ReferencedChildMetadata[]
): Promise<void> {
  for (const child of referencedChildren) {
    const childDirectory = child.kind === 'Form' ? 'Forms' : 'Templates';
    const metadataPath = path.join(objectDirectory, childDirectory, `${child.name}.xml`);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(metadataPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Не найден обязательный XML ${child.kind === 'Form' ? 'формы' : 'макета'} "${child.name}": ${metadataPath}`);
      }
      throw new Error(`Не удалось проверить обязательный XML ${child.kind === 'Form' ? 'формы' : 'макета'} "${child.name}": ${errorMessage(error)}`);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Обязательный XML ${child.kind === 'Form' ? 'формы' : 'макета'} "${child.name}" должен быть обычным файлом: ${metadataPath}`);
    }
  }
}

function isEmbeddedKind(value: string): value is EmbeddedKind {
  return value === 'DataProcessor' || value === 'Report';
}

function readRootName(objectRoot: XmlElement): string {
  const properties = requireSingleChild(objectRoot, 'Properties');
  const nameElement = requireSingleChild(properties, 'Name');
  const name = textContent(nameElement).trim();
  if (!name) {
    throw new Error('У встроенного объекта не задано имя.');
  }
  return name;
}

function requireSingleChild(parent: XmlElement, localName: string): XmlElement {
  const matches = elementChildren(parent).filter((child) => child.localName === localName);
  if (matches.length !== 1) {
    throw new Error(`Ожидался ровно один элемент ${localName}.`);
  }
  return matches[0];
}

function replaceRootInternalInfo(
  internalInfo: XmlElement,
  sourceKind: EmbeddedKind,
  targetKind: ExternalArtifactKind,
  name: string
): void {
  const children = elementChildren(internalInfo);
  if (children.some((child) => child.localName !== 'GeneratedType')) {
    throw new Error('InternalInfo содержит неизвестную конструкцию, которую нельзя перенести во внешний объект.');
  }
  const objectTypes = children.filter((child) =>
    attributeValue(child, 'category') === 'Object'
  );
  const managerTypes = children.filter((child) =>
    attributeValue(child, 'category') === 'Manager'
  );
  if (objectTypes.length !== 1 || managerTypes.length > 1 || objectTypes.length + managerTypes.length !== children.length) {
    throw new Error('Набор GeneratedType встроенного объекта не поддерживается.');
  }

  const objectType = objectTypes[0];
  if (attributeValue(objectType, 'name') !== `${sourceKind}Object.${name}`) {
    throw new Error('GeneratedType объекта не соответствует его имени или типу.');
  }
  for (const generatedType of [...objectTypes, ...managerTypes]) {
    validateGeneratedType(generatedType);
  }
  if (managerTypes.length === 1
      && attributeValue(managerTypes[0], 'name') !== `${sourceKind}Manager.${name}`) {
    throw new Error('GeneratedType менеджера не соответствует имени объекта.');
  }

  const namespacePrefix = objectType.name.includes(':') ? objectType.name.split(':')[0] : 'xr';
  if (!hasNamespacePrefix(internalInfo, namespacePrefix)) {
    throw new Error(`В XML не объявлено пространство имён ${namespacePrefix} для InternalInfo.`);
  }
  const classId = targetKind === 'ExternalReport'
    ? EXTERNAL_REPORT_CLASS_ID
    : EXTERNAL_DATA_PROCESSOR_CLASS_ID;
  const containedObject = makeElement(`${namespacePrefix}:ContainedObject`, [], [
    textNode('\n\t\t\t\t'),
    makeElement(`${namespacePrefix}:ClassId`, [], [textNode(classId)]),
    textNode('\n\t\t\t\t'),
    makeElement(`${namespacePrefix}:ObjectId`, [], [textNode(randomUUID())]),
    textNode('\n\t\t\t'),
  ]);
  const generatedObjectType = makeElement(
    objectType.name,
    objectType.attributes.map((attribute) => ({ ...attribute })),
    [
      textNode('\n\t\t\t\t'),
      makeElement(`${namespacePrefix}:TypeId`, [], [textNode(randomUUID())]),
      textNode('\n\t\t\t\t'),
      makeElement(`${namespacePrefix}:ValueId`, [], [textNode(randomUUID())]),
      textNode('\n\t\t\t'),
    ]
  );
  setAttributeValue(generatedObjectType, 'name', `${targetKind}Object.${name}`);
  setAttributeValue(generatedObjectType, 'category', 'Object');
  internalInfo.children = [
    textNode('\n\t\t\t'),
    containedObject,
    textNode('\n\t\t\t'),
    generatedObjectType,
    textNode('\n\t\t'),
  ];
  setChildParents(internalInfo);
}

function validateGeneratedType(generatedType: XmlElement): void {
  const ids = elementChildren(generatedType);
  if (ids.length !== 2 || !ids.some((child) => child.localName === 'TypeId')
      || !ids.some((child) => child.localName === 'ValueId')) {
    throw new Error('GeneratedType должен содержать только TypeId и ValueId.');
  }
  for (const child of ids) {
    const value = textContent(child).trim();
    if (!isUuid(value)) {
      throw new Error(`У GeneratedType некорректный ${child.localName}.`);
    }
  }
}

function replaceRootProperties(
  properties: XmlElement,
  sourceKind: EmbeddedKind,
  targetKind: ExternalArtifactKind
): void {
  const knownSourceProperties = sourceKind === 'DataProcessor'
    ? [
        'Name', 'Synonym', 'Comment', 'UseStandardCommands', 'DefaultForm', 'AuxiliaryForm',
        'IncludeHelpInContents', 'ExtendedPresentation', 'Explanation',
      ]
    : [
        'Name', 'Synonym', 'Comment', 'UseStandardCommands', 'DefaultForm', 'AuxiliaryForm',
        'IncludeHelpInContents', 'ExtendedPresentation', 'Explanation', 'DefaultSettingsForm',
        'AuxiliarySettingsForm', 'DefaultVariantForm', 'MainDataCompositionSchema',
        'SettingsStorage', 'VariantsStorage',
      ];
  const targetPropertyOrder = targetKind === 'ExternalReport'
    ? [
        'Name', 'Synonym', 'Comment', 'DefaultForm', 'AuxiliaryForm', 'MainDataCompositionSchema',
        'DefaultSettingsForm', 'AuxiliarySettingsForm', 'DefaultVariantForm', 'VariantsStorage',
        'SettingsStorage',
      ]
    : ['Name', 'Synonym', 'Comment', 'DefaultForm', 'AuxiliaryForm'];

  const propertyByName = new Map<string, XmlElement>();
  for (const child of properties.children) {
    if (child.kind === 'text') {
      if (child.text.trim()) {
        throw new Error('Properties содержит текст вне элементов.');
      }
      continue;
    }
    if (child.kind !== 'element') {
      throw new Error('Properties содержит неизвестную XML-конструкцию.');
    }
    if (!knownSourceProperties.includes(child.localName)) {
      throw new Error(`Свойство ${child.localName} встроенного объекта не поддерживается.`);
    }
    if (propertyByName.has(child.localName)) {
      throw new Error(`Свойство ${child.localName} встречается несколько раз.`);
    }
    propertyByName.set(child.localName, child);
  }
  const missing = targetPropertyOrder.filter((name) => !propertyByName.has(name));
  if (missing.length > 0) {
    throw new Error(`Для внешнего объекта отсутствуют свойства: ${missing.join(', ')}.`);
  }

  const convertedChildren: XmlChildNode[] = [];
  for (const propertyName of targetPropertyOrder) {
    const property = propertyByName.get(propertyName);
    if (property) {
      convertedChildren.push(textNode('\n\t\t\t'), property);
    }
  }
  convertedChildren.push(textNode('\n\t\t'));
  properties.children = convertedChildren;
  setChildParents(properties);
}

function transformXmlReferences(source: string, transform: ReferenceTransform): string {
  assertSupportedXml(source, 'вложенный XML');
  const document = parseXmlDocument(source);
  if (transformXmlReferencesInElement(document.root, transform)) {
    return serializeXmlDocument(document);
  }
  return source;
}

function transformXmlReferencesInElement(element: XmlElement, transform: ReferenceTransform): boolean {
  let changed = false;
  for (const attribute of element.attributes) {
    const transformed = replaceSelfReference(attribute.value, transform);
    if (transformed !== attribute.value) {
      attribute.value = transformed;
      changed = true;
    }
  }
  for (const child of element.children) {
    if (child.kind === 'element') {
      changed = transformXmlReferencesInElement(child, transform) || changed;
    } else if (child.kind === 'text') {
      const transformed = replaceSelfReference(child.text, transform);
      if (transformed !== child.text) {
        child.text = transformed;
        changed = true;
      }
    }
  }
  return changed;
}

function replaceSelfReference(value: string, transform: ReferenceTransform): string {
  const boundary = '(^|[^\\p{L}\\p{N}_])';
  const escapedName = escapeRegExp(transform.objectName);
  const suffix = '(?=\\.|$)';
  const pathPattern = new RegExp(
    `${boundary}${transform.sourceKind}\\.${escapedName}${suffix}`,
    'gu'
  );
  const typePattern = new RegExp(
    `${boundary}(cfg:)?${transform.sourceKind}Object\\.${escapedName}${suffix}`,
    'gu'
  );
  return value
    .replace(pathPattern, (_match, prefix: string) => `${prefix}${transform.targetKind}.${transform.objectName}`)
    .replace(typePattern, (_match, prefix: string, cfgPrefix: string | undefined) =>
      `${prefix}${cfgPrefix ?? ''}${transform.targetKind}Object.${transform.objectName}`
    );
}

function assertSupportedXml(source: string, displayPath: string): void {
  if (/<!DOCTYPE|<!ENTITY/iu.test(source)) {
    throw new Error(`XML с DTD или пользовательскими сущностями не поддерживается: ${displayPath}`);
  }
  if (/&#(?:x[\da-f]+|\d+);/iu.test(source)) {
    throw new Error(`Числовые XML-сущности пока не поддерживаются без потери исходной записи: ${displayPath}`);
  }
  if (/&(?!(?:amp|lt|gt|quot|apos);)[a-z][\w.-]*;/iu.test(source)) {
    throw new Error(`XML содержит неподдерживаемую именованную сущность: ${displayPath}`);
  }
}

function attributeValue(element: XmlElement, localName: string): string | undefined {
  return element.attributes.find((attribute) => attribute.localName === localName)?.value;
}

function setAttributeValue(element: XmlElement, localName: string, value: string): void {
  const attribute = element.attributes.find((candidate) => candidate.localName === localName);
  if (!attribute) {
    throw new Error(`В элементе ${element.localName} отсутствует атрибут ${localName}.`);
  }
  attribute.value = value;
}

function hasNamespacePrefix(element: XmlElement, prefix: string): boolean {
  let current: XmlElement | undefined = element;
  while (current) {
    if (current.attributes.some((attribute) => attribute.name === `xmlns:${prefix}`)) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function replaceLocalName(qualifiedName: string, newLocalName: string): string {
  const colon = qualifiedName.indexOf(':');
  return colon < 0 ? newLocalName : `${qualifiedName.slice(0, colon + 1)}${newLocalName}`;
}

function makeElement(
  name: string,
  attributes: XmlElement['attributes'],
  children: XmlChildNode[]
): XmlElement {
  const element: XmlElement = {
    kind: 'element',
    name,
    localName: name.includes(':') ? name.split(':').pop() ?? name : name,
    attributes,
    children,
  };
  setChildParents(element);
  return element;
}

function textNode(text: string): XmlTextNode {
  return { kind: 'text', text };
}

function setChildParents(element: XmlElement): void {
  for (const child of element.children) {
    if (child.kind === 'element') {
      child.parent = element;
      setChildParents(child);
    }
  }
}

function isUuid(value: string): boolean {
  return /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu.test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
