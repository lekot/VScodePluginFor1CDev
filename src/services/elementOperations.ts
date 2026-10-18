import * as fs from 'fs';
import * as path from 'path';
import { TreeNode, MetadataType } from '../models/treeNode';
import {
  assertMetadataCrudSupported,
  DESIGNER_ROOT_OBJECT_TYPES,
  getMetadataTypeDescriptorByType,
  supportsMetadataGenericRootChildObject,
} from '../constants/metadataTypeDescriptors';
import { Logger } from '../utils/logger';
import { ROOT_TAGS_WITHOUT_CHILDOBJECTS, XMLWriter } from '../utils/XMLWriter';
import { validateElementName } from '../utils/elementNameValidator';
import {
  findReferencesToElement,
  findReferencesWithDiagnostics,
  ReferenceScanError,
} from '../utils/referenceFinder';
import {
  getDesignerTemplateXml,
} from './designerTemplateRepository';
import { substituteDesignerTemplate } from './designerTemplateSubstitutor';
import {
  appendRegisterReferenceToRecorderDocument,
} from './registerRecorderDocumentLinker';
import {
  buildRootObjectConfigurationContent,
} from './configurationXmlUpdater';
import type {
  MutationPlan,
  MutationStep,
} from './configurationSession/mutationPlan';
import { hashContent } from './configurationSession/atomicFileStorage';
import {
  assertNoSymlinkSegments,
  assertPathWithinRoot,
} from './configurationSession/pathBoundary';
import {
  assertCfeGenericCreateAllowed,
  assertCfeGenericDuplicateAllowed,
  assertCfeGenericMutationAllowed,
} from '../extensionSupport/cfeProject/mutationPolicy';
import { CONFIGURATION_XML } from '../constants/fileNames';
import { isSamePath } from '../utils/configurationPathIdentity';
import {
  appendPredefinedDesignerItem,
  removePredefinedDesignerItem,
} from '../utils/xml/predefinedDataAppender';
import {
  ensureTabularSectionColumnsPlaceholder,
  isTabularSectionColumnsContainer,
} from '../utils/treeNormalization';
import {
  requireProjectWriteFormatProfile,
  UnsupportedMetadataFormatError,
} from '../utils/format/formatRank';
import { injectInternalInfoIntoMetadataXml } from '../utils/xml/internalInfoGenerator';
import { normalizeMetaDataObjectRoot } from '../utils/xml/metaDataObjectRootNormalizer';
import { rulesRegistry, metadataConverter } from '../rules';
import {
  planCreateMetadataObject,
  planDeleteMetadataObject,
  planDuplicateMetadataObject,
  planRenameMetadataObject,
} from './metadataCrudService';
import { runConfigurationPlan } from './configurationSession/configurationMutationGateway';
import { createForm, deleteForm, buildMinimalExtFormXml } from './elementFormOperations';

async function resolveProjectFormatVersion(configRootPath: string): Promise<string> {
  try {
    const configXmlPath = path.join(configRootPath, CONFIGURATION_XML);
    const content = await fs.promises.readFile(configXmlPath, 'utf8');
    return requireProjectWriteFormatProfile(content).version;
  } catch (error) {
    if (error instanceof UnsupportedMetadataFormatError) {
      throw error;
    }
    throw new UnsupportedMetadataFormatError(undefined, 'не удалось прочитать Configuration.xml');
  }
}

function resolveTopLevelMetadataObject(node: TreeNode | undefined): TreeNode | undefined {
  let p: TreeNode | undefined = node;
  while (p) {
    if (TOP_LEVEL_TYPES.has(p.type)) {
      return p;
    }
    p = p.parent;
  }
  return undefined;
}

/** Section instance node for a tabular column (parent of «Реквизиты» / columns container), if any. */
export function findTabularSectionInstanceForAttributeParent(parentOfAttribute: TreeNode): TreeNode | undefined {
  if (isTabularSectionColumnsContainer(parentOfAttribute)) {
    return parentOfAttribute.parent;
  }
  if (
    parentOfAttribute.type === MetadataType.TabularSection &&
    parentOfAttribute.id.startsWith('TabularSections.') &&
    parentOfAttribute.parent?.id === 'TabularSections'
  ) {
    return parentOfAttribute;
  }
  return undefined;
}

function resolveXmlPathForTabularSectionInstance(sectionInstance: TreeNode): string | undefined {
  if (sectionInstance.filePath && sectionInstance.filePath.toLowerCase().endsWith('.xml')) {
    return sectionInstance.filePath;
  }
  return sectionInstance.parentFilePath;
}

/** Whether `parent` may hold a root-level type folder (e.g. Catalogs, Roles under «Общие»). */
function isAllowedTypeFolderParent(parent: TreeNode): boolean {
  if (parent.type === MetadataType.Configuration) {
    return true;
  }
  return parent.type === MetadataType.Unknown && parent.id === 'Common';
}

/** Structural Designer-root types. CRUD support is defined independently in the descriptor registry. */
export const TOP_LEVEL_TYPES = DESIGNER_ROOT_OBJECT_TYPES;

/**
 * True when `createElement` would create a new root metadata XML under a type folder
 * (direct child of Configuration or under «Общие»), not a nested Attribute/TabularSection.
 */
export function isRootObjectCreateInTypeFolder(parentNode: TreeNode): boolean {
  const parent = parentNode.parent;
  if (!parent) {
    return false;
  }
  return isAllowedTypeFolderParent(parent) && TOP_LEVEL_TYPES.has(parentNode.type);
}

/**
 * Gets the names of all child nodes of a parent node.
 * @param parent - The parent TreeNode
 * @returns Array of child node names
 */
function getSiblingNames(parent: TreeNode): string[] {
  return (parent.children || []).map((c) => c.name);
}

function assertRootChildObjectAllowed(
  parentType: MetadataType,
  childKind: 'Attribute' | 'TabularSection',
): void {
  if (supportsMetadataGenericRootChildObject(parentType, childKind)) {
    return;
  }

  const descriptor = getMetadataTypeDescriptorByType(parentType);
  if (!descriptor?.structure.hasChildObjects) {
    throw new Error(
      'В формате Designer у этого типа метаданных нет ChildObjects (например, роль, общий модуль). ' +
        'Создание реквизита/табличной части под выбранным узлом не поддерживается.'
    );
  }

  if (parentType === MetadataType.Subsystem) {
    const childLabel = childKind === 'Attribute' ? 'реквизита' : 'табличной части';
    throw new Error(`Создание ${childLabel} под подсистемой не поддерживается.`);
  }

  throw new Error(`Создание ${childKind} под ${String(parentType)} не поддерживается.`);
}

/** Directory that contains Configuration.xml (Designer root or EDT project root). */
async function findConfigurationRootDir(typeFolderPath: string): Promise<string> {
  let dir = typeFolderPath;
  for (let depth = 0; depth < 16; depth++) {
    const candidate = path.join(dir, CONFIGURATION_XML);
    try {
      await fs.promises.access(candidate);
      return dir;
    } catch {
      // not found, continue
    }
    const parentDir = path.dirname(dir);
    if (parentDir === dir) {
      break;
    }
    dir = parentDir;
  }
  return path.dirname(typeFolderPath);
}

// ---------------------------------------------------------------------------
// createElement validation helpers
// ---------------------------------------------------------------------------

/** Validate name and throw if invalid. Returns the trimmed name on success. */
function validateCreateName(newName: string, parentNode: TreeNode): string {
  const trimmedName = newName.trim();
  if (!trimmedName) {
    throw new Error('Имя элемента не может быть пустым');
  }
  const err = validateElementName(trimmedName, getSiblingNames(parentNode));
  if (err) {
    throw new Error(err);
  }
  return trimmedName;
}

// ---------------------------------------------------------------------------
// createElement branch handlers
// ---------------------------------------------------------------------------

/** Branch: parentNode is the Configuration root — always invalid for creation. */
async function handleCreateUnderConfiguration(): Promise<void> {
  throw new Error('Выберите узел типа (например Справочники) или объект для создания реквизита.');
}

/** Branch: parentNode is the Forms folder — delegate to createForm. */
async function handleCreateForm(parentNode: TreeNode, name: string): Promise<void> {
  return createForm(parentNode, name);
}

/** Branch: parentNode is a type folder (e.g. Catalogs) — create a root metadata object file. */
async function handleCreateRootObject(parentNode: TreeNode, name: string): Promise<void> {
  const typeFolderPath = parentNode.filePath;
  if (!typeFolderPath) {
    throw new Error(`Папка типа не найдена: ${typeFolderPath}`);
  }

  const configRootPath = await findConfigurationRootDir(typeFolderPath);
  await assertPathWithinRoot(configRootPath, typeFolderPath);
  if (isEdtSourceTypeFolder(configRootPath, typeFolderPath)) {
    await handleCreateEdtRootObject(parentNode, typeFolderPath, configRootPath, name);
    return;
  }
  const recorderDocument = parentNode.type === MetadataType.DocumentJournal
      || parentNode.type === MetadataType.AccumulationRegister
    ? process.env.IBCMD_RECORDER_DOCUMENT?.trim() || undefined
    : undefined;
  const planned = await planCreateMetadataObject(
    { configurationRootPath: configRootPath },
    { type: parentNode.type, name, recorderDocument },
  );
  await runConfigurationPlan(configRootPath, planned.plan);
}

/** Preserve the legacy EDT `src/<Type>` layout until the shared CRUD domain resolves project-specific paths. */
export function isEdtSourceTypeFolder(configurationRootPath: string, typeFolderPath: string): boolean {
  const relativePath = path.relative(configurationRootPath, typeFolderPath);
  return relativePath.split(path.sep)[0]?.toLocaleLowerCase() === 'src';
}

async function handleCreateEdtRootObject(
  parentNode: TreeNode,
  typeFolderPath: string,
  configurationRootPath: string,
  name: string,
): Promise<void> {
  assertMetadataCrudSupported(parentNode.type, 'create');
  const rootTag = String(parentNode.type);
  const targetVersion = await resolveProjectFormatVersion(configurationRootPath);
  const newFilePath = path.join(typeFolderPath, `${name}.xml`);
  await assertPathWithinRoot(configurationRootPath, newFilePath);
  try {
    await fs.promises.access(newFilePath);
    throw new Error(`Файл уже существует: ${newFilePath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  await assertCfeGenericCreateAllowed(newFilePath, name, { isRootObjectCreate: true });

  const steps: MutationStep[] = [];
  steps.push({ type: 'ensureDirectory', targetPath: typeFolderPath });

  const templateOnlyTypes = new Set([MetadataType.InformationRegister, MetadataType.AccumulationRegister]);
  const rules = templateOnlyTypes.has(parentNode.type) ? undefined : rulesRegistry.get(rootTag);
  const templateXml = rules ? null : await getDesignerTemplateXml(rootTag);
  let content: string;
  if (rules) {
    const uuid = XMLWriter.generateSimpleUuid();
    content = metadataConverter.irToXml(metadataConverter.createDefaultIR(rules, { name, uuid }), rules);
    content = injectInternalInfoIntoMetadataXml(content, rootTag, name);
    content = normalizeMetaDataObjectRoot(content, targetVersion);
  } else if (templateXml !== null) {
    const uuid = XMLWriter.generateSimpleUuid();
    content = substituteDesignerTemplate(templateXml, {
      uuid,
      Name: name,
      Synonym_ru: name,
      uuidDim: XMLWriter.generateSimpleUuid(),
      uuidResource: XMLWriter.generateSimpleUuid(),
      ...(rootTag === 'DocumentJournal'
        ? (() => {
            const recorderDocument = process.env.IBCMD_RECORDER_DOCUMENT?.trim();
            return recorderDocument ? { RecorderDocumentRef: `Document.${recorderDocument}` } : {};
          })()
        : {}),
    });
    content = injectInternalInfoIntoMetadataXml(content, rootTag, name);
    content = normalizeMetaDataObjectRoot(content, targetVersion);
  } else {
    content = XMLWriter.buildMinimalElementContent(rootTag, name, targetVersion);
  }
  steps.push({
    type: 'writeFile',
    targetPath: newFilePath,
    content,
    encoding: 'utf8',
    expected: { state: 'missing' },
  });

  const elementDirectory = path.join(typeFolderPath, name);
  steps.push({ type: 'ensureDirectory', targetPath: elementDirectory });
  if (rootTag === 'CommonModule') {
    const modulePath = path.join(elementDirectory, 'Ext', 'Module', 'Module.bsl');
    steps.push({ type: 'ensureDirectory', targetPath: path.dirname(modulePath) });
    steps.push({ type: 'writeFile', targetPath: modulePath, content: '', encoding: 'utf8', expected: { state: 'missing' } });
  }

  let companionTaskName: string | undefined;
  if (rootTag === 'BusinessProcess') {
    const taskFolderPath = path.join(path.dirname(typeFolderPath), 'Tasks');
    const taskFilePath = path.join(taskFolderPath, `${name}.xml`);
    let taskExists = false;
    try {
      await fs.promises.access(taskFilePath);
      taskExists = true;
    } catch {
      taskExists = false;
    }
    if (!taskExists) {
      companionTaskName = name;
      steps.push({ type: 'ensureDirectory', targetPath: taskFolderPath });
      const taskTemplateXml = await getDesignerTemplateXml('Task');
      let taskContent: string;
      if (taskTemplateXml !== null) {
        const uuid = XMLWriter.generateSimpleUuid();
        taskContent = substituteDesignerTemplate(taskTemplateXml, { uuid, Name: name, Synonym_ru: name });
        taskContent = injectInternalInfoIntoMetadataXml(taskContent, 'Task', name);
        taskContent = normalizeMetaDataObjectRoot(taskContent, targetVersion);
      } else {
        taskContent = XMLWriter.buildMinimalElementContent('Task', name, targetVersion);
      }
      steps.push({ type: 'writeFile', targetPath: taskFilePath, content: taskContent, encoding: 'utf8', expected: { state: 'missing' } });
      steps.push({ type: 'ensureDirectory', targetPath: path.join(taskFolderPath, name) });
    }
  }

  const configPath = path.join(configurationRootPath, CONFIGURATION_XML);
  const configContent = await fs.promises.readFile(configPath, 'utf8');
  let updatedConfigContent = buildRootObjectConfigurationContent(configContent, {
    type: 'add',
    rootTag,
    objectName: name,
  });
  if (companionTaskName) {
    updatedConfigContent = buildRootObjectConfigurationContent(updatedConfigContent, {
      type: 'add',
      rootTag: 'Task',
      objectName: companionTaskName,
    });
  }
  steps.push({
    type: 'writeFile',
    targetPath: configPath,
    content: updatedConfigContent,
    encoding: 'utf8',
    expected: { state: 'file', hash: hashContent(configContent) },
  });

  const plan: MutationPlan<void> = {
    kind: 'createEdtRootObject',
    steps,
    result: undefined,
  };

  await runConfigurationPlan(configurationRootPath, plan);

  if (rootTag === 'AccumulationRegister') {
    await appendRegisterReferenceToRecorderDocument(configurationRootPath, rootTag, name);
  }
}

/** Branch: parentNode is a top-level metadata object (Catalog, Document, …) — create nested Attribute. */
async function handleCreateNestedUnderTopLevel(parentNode: TreeNode, name: string): Promise<void> {
  assertRootChildObjectAllowed(parentNode.type, 'Attribute');
  const filePath = parentNode.filePath;
  if (!filePath) {
    throw new Error('Файл объекта не найден.');
  }
  try {
    await fs.promises.access(filePath);
  } catch {
    throw new Error('Файл объекта не найден.');
  }
  await XMLWriter.addNestedElement(filePath, 'Attribute', name, {}, parentNode.type, parentNode.name);
}

/** Branch: parentNode is an Attribute/TabularSection container folder under a top-level object. */
async function handleCreateInContainerFolder(
  parentNode: TreeNode,
  parent: TreeNode,
  name: string
): Promise<void> {
  const elementType = parentNode.type === MetadataType.Attribute ? 'Attribute' : 'TabularSection';
  assertRootChildObjectAllowed(parent.type, elementType);
  const filePath = parent.filePath;
  if (!filePath) {
    throw new Error('Файл объекта не найден.');
  }
  try {
    await fs.promises.access(filePath);
  } catch {
    throw new Error('Файл объекта не найден.');
  }
  await XMLWriter.addNestedElement(filePath, elementType, name, {}, parent.type, parent.name);
}

const REGISTER_TYPES_FOR_DIM_RES = new Set<MetadataType>([
  MetadataType.InformationRegister,
  MetadataType.AccumulationRegister,
  MetadataType.AccountingRegister,
  MetadataType.CalculationRegister,
]);

const PREDEFINED_METADATA_ROOT_TYPES = new Set<MetadataType>([
  MetadataType.Catalog,
  MetadataType.ChartOfCharacteristicTypes,
  MetadataType.ChartOfAccounts,
]);

/** Branch: EnumValues folder under an Enum metadata object. */
async function handleCreateEnumValue(_folder: TreeNode, enumOwner: TreeNode, name: string): Promise<void> {
  if (ROOT_TAGS_WITHOUT_CHILDOBJECTS.has(String(enumOwner.type))) {
    throw new Error('Создание значений перечисления для этого типа не поддерживается.');
  }
  const filePath = enumOwner.filePath;
  if (!filePath) {
    throw new Error('Файл объекта перечисления не найден.');
  }
  try {
    await fs.promises.access(filePath);
  } catch {
    throw new Error('Файл объекта перечисления не найден.');
  }
  await XMLWriter.addNestedElement(filePath, 'EnumValue', name, {}, MetadataType.Enum, enumOwner.name);
}

/** Branch: Dimensions folder under a register metadata object. */
async function handleCreateRegisterDimension(folderNode: TreeNode, registerOwner: TreeNode, name: string): Promise<void> {
  if (ROOT_TAGS_WITHOUT_CHILDOBJECTS.has(String(registerOwner.type))) {
    throw new Error('Создание измерений для этого типа не поддерживается.');
  }
  const filePath = registerOwner.filePath;
  if (!filePath) {
    throw new Error('Файл регистра не найден.');
  }
  try {
    await fs.promises.access(filePath);
  } catch {
    throw new Error('Файл регистра не найден.');
  }
  const existingDims = (folderNode.children || []).filter((c) => c.type === MetadataType.Dimension);
  const isPrimary = existingDims.length === 0;
  await XMLWriter.addNestedElement(
    filePath,
    'Dimension',
    name,
    { __isPrimaryDimension: isPrimary },
    registerOwner.type,
    registerOwner.name
  );
}

/** Branch: Resources folder under a register metadata object. */
async function handleCreateRegisterResource(_folder: TreeNode, registerOwner: TreeNode, name: string): Promise<void> {
  if (ROOT_TAGS_WITHOUT_CHILDOBJECTS.has(String(registerOwner.type))) {
    throw new Error('Создание ресурсов для этого типа не поддерживается.');
  }
  const filePath = registerOwner.filePath;
  if (!filePath) {
    throw new Error('Файл регистра не найден.');
  }
  try {
    await fs.promises.access(filePath);
  } catch {
    throw new Error('Файл регистра не найден.');
  }
  await XMLWriter.addNestedElement(filePath, 'Resource', name, {}, registerOwner.type, registerOwner.name);
}

/** Branch: PredefinedData folder (Ext/Predefined.xml path on the folder node). */
async function handleCreatePredefinedItem(predefinedFolder: TreeNode, owner: TreeNode, name: string): Promise<void> {
  const predefinedPath = predefinedFolder.filePath;
  if (!predefinedPath) {
    throw new Error('Путь к Predefined.xml не задан.');
  }
  if (!PREDEFINED_METADATA_ROOT_TYPES.has(owner.type)) {
    throw new Error('Создание предопределённых элементов для этого типа не поддерживается.');
  }
  const configRootPath = await findConfigurationRootDir(path.dirname(owner.filePath ?? predefinedPath));
  const targetVersion = await resolveProjectFormatVersion(configRootPath);
  await appendPredefinedDesignerItem(predefinedPath, owner.type, name, name, owner.filePath, targetVersion);
}

/** Branch: parentNode is a columns-container under a tabular section instance. */
async function handleCreateTabularSectionColumn(parentNode: TreeNode, name: string): Promise<void> {
  const sectionInstance = parentNode.parent;
  const owner = resolveTopLevelMetadataObject(sectionInstance);
  if (!sectionInstance || !owner) {
    throw new Error('Некорректный родитель для колонки табличной части.');
  }
  const xmlTarget = resolveXmlPathForTabularSectionInstance(sectionInstance);
  if (!xmlTarget) {
    throw new Error('Файл табличной части или объекта не найден.');
  }
  try {
    await fs.promises.access(xmlTarget);
  } catch {
    throw new Error('Файл табличной части или объекта не найден.');
  }
  await XMLWriter.addAttributeToTabularSection(xmlTarget, sectionInstance.name, name, owner.type, owner.name);
}

/** Branch: parentNode is a TabularSection instance node — delegate via its columns container. */
async function handleCreateViaTabularSectionInstance(
  parentNode: TreeNode,
  newName: string
): Promise<void> {
  ensureTabularSectionColumnsPlaceholder(parentNode);
  const container = parentNode.children?.find((c) => isTabularSectionColumnsContainer(c));
  if (container) {
    return createElement(container, newName);
  }
}

// ---------------------------------------------------------------------------
// Dispatch map entry type
// ---------------------------------------------------------------------------

type CreateElementCase = {
  /** Returns true when this case applies. `parent` may be undefined. */
  matches: (parentNode: TreeNode, parent: TreeNode | undefined) => boolean;
  handle: (parentNode: TreeNode, parent: TreeNode | undefined, name: string, newName: string) => Promise<void>;
};

/** Ordered dispatch table for {@link createElement}. First matching entry wins. */
const CREATE_ELEMENT_CASES: CreateElementCase[] = [
  {
    matches: (n) => n.type === MetadataType.Configuration,
    handle: () => handleCreateUnderConfiguration(),
  },
  {
    matches: (n) => n.id === 'Forms',
    handle: (n, _p, name) => handleCreateForm(n, name),
  },
  {
    matches: (n) => isRootObjectCreateInTypeFolder(n),
    handle: (n, _p, name) => handleCreateRootObject(n, name),
  },
  {
    matches: (n, p) =>
      n.id === 'EnumValues' && !!p && p.type === MetadataType.Enum && !!p.filePath,
    handle: (n, p, name) => handleCreateEnumValue(n, p as TreeNode, name),
  },
  {
    matches: (n, p) =>
      n.id === 'Dimensions' &&
      !!p &&
      REGISTER_TYPES_FOR_DIM_RES.has(p.type) &&
      !!p.filePath,
    handle: (n, p, name) => handleCreateRegisterDimension(n, p as TreeNode, name),
  },
  {
    matches: (n, p) =>
      n.id === 'Resources' &&
      !!p &&
      REGISTER_TYPES_FOR_DIM_RES.has(p.type) &&
      !!p.filePath,
    handle: (n, p, name) => handleCreateRegisterResource(n, p as TreeNode, name),
  },
  {
    matches: (n, p) =>
      n.id === 'PredefinedData' &&
      !!p &&
      PREDEFINED_METADATA_ROOT_TYPES.has(p.type) &&
      !!n.filePath,
    handle: (n, p, name) => handleCreatePredefinedItem(n, p as TreeNode, name),
  },
  {
    matches: (n) => TOP_LEVEL_TYPES.has(n.type),
    handle: (n, _p, name) => handleCreateNestedUnderTopLevel(n, name),
  },
  {
    matches: (n, p) =>
      (n.type === MetadataType.Attribute || n.type === MetadataType.TabularSection) &&
      p !== undefined &&
      TOP_LEVEL_TYPES.has(p.type),
    handle: (n, p, name) => handleCreateInContainerFolder(n, p as TreeNode, name),
  },
  {
    matches: (n) => isTabularSectionColumnsContainer(n),
    handle: (n, _p, name) => handleCreateTabularSectionColumn(n, name),
  },
  {
    matches: (n) =>
      n.type === MetadataType.TabularSection &&
      n.id.startsWith('TabularSections.') &&
      n.parent?.id === 'TabularSections',
    handle: (n, _p, _name, newName) => handleCreateViaTabularSectionInstance(n, newName),
  },
];

/**
 * Creates a new metadata element in the configuration.
 *
 * Parent can be a type node (e.g. Catalogs), an object (Catalog/Document) for nested Attribute,
 * or a container folder (Attributes/TabularSections) under an object.
 * Creates the element XML file and associated directory structure.
 *
 * @param parentNode - The parent node where the element will be created
 * @param newName - Name for the new element (will be validated)
 * @throws {Error} If validation fails or parent is invalid
 *
 * @example
 * ```typescript
 * // Create a new catalog
 * await createElement(catalogsTypeNode, 'NewCatalog');
 * // Create a new attribute under a catalog object
 * await createElement(catalogObjectNode, 'NewAttribute');
 * // Create a new attribute by selecting the Attributes folder
 * await createElement(attributesFolderNode, 'NewAttribute');
 * ```
 */
export async function createElement(
  parentNode: TreeNode,
  newName: string
): Promise<void> {
  const name = validateCreateName(newName, parentNode);
  const owner = resolveTopLevelMetadataObject(parentNode);
  const ownerMetadataXmlPath = owner?.filePath?.toLocaleLowerCase().endsWith('.xml')
    ? owner.filePath
    : undefined;
  await assertCfeGenericCreateAllowed(ownerMetadataXmlPath ?? parentNode.filePath ?? '', name, {
    isRootObjectCreate: isRootObjectCreateInTypeFolder(parentNode),
    ownerMetadataXmlPath,
  });
  const parent = parentNode.parent;

  for (const { matches, handle } of CREATE_ELEMENT_CASES) {
    if (matches(parentNode, parent)) {
      await handle(parentNode, parent, name, newName);
      return;
    }
  }

  throw new Error(
    'Создание элемента: выберите узел типа (в т.ч. под «Общие»), объект метаданных или контейнер (Атрибуты, Табличные части). ' +
      'Если выбран типовой узел, его родитель должен быть корень конфигурации или группа «Общие».'
  );
}

export { createForm, buildMinimalExtFormXml };

/**
 * Duplicates an existing metadata element with a new name.
 * 
 * Copies the element's XML structure and properties to create a new element.
 * Handles both top-level elements (Catalogs, Documents) and nested elements (Attributes).
 * 
 * @param node - The element to duplicate
 * @param newName - Name for the duplicated element (will be validated)
 * @throws {Error} If node is Configuration root, has no parent, or validation fails
 * 
 * @example
 * ```typescript
 * await duplicateElement(catalogNode, 'CopiedCatalog');
 * ```
 */
export async function duplicateElement(node: TreeNode, newName: string): Promise<void> {
  if (node.type === MetadataType.Configuration) {
    throw new Error('Нельзя дублировать корень конфигурации.');
  }
  const parent = node.parent;
  if (!parent) {
    throw new Error('Нет родительского узла.');
  }
  if (TOP_LEVEL_TYPES.has(node.type)) {
    const name = newName.trim();
    const plan = await planDuplicateRootElement(node, name);
    const { typeFolderPath } = requireRootMutationNode(node);
    const configRootPath = await findConfigurationRootDir(typeFolderPath);
    await runConfigurationPlan(configRootPath, plan);
    Logger.info(`Duplicated element to ${path.join(typeFolderPath, `${name}.xml`)}`);
    return;
  }
  const err = validateElementName(newName.trim(), getSiblingNames(parent));
  if (err) {
    throw new Error(err);
  }
  const name = newName.trim();

  const filePath = node.parentFilePath || node.filePath;
  if (!filePath) {
    throw new Error('Файл элемента не найден.');
  }
  try {
    await fs.promises.access(filePath);
  } catch {
    throw new Error('Файл элемента не найден.');
  }
  await assertCfeGenericDuplicateAllowed(filePath, name);

  if (node.type === MetadataType.Attribute || node.type === MetadataType.TabularSection) {
    const parentFilePath = node.parentFilePath || (parent as TreeNode).filePath;
    if (!parentFilePath) {
      throw new Error('Родительский файл не найден.');
    }
    const attrProps = (node.properties || {}) as Record<string, unknown>;
    const minimalProps = { ...attrProps, Name: name } as Record<string, unknown>;
    if (node.type === MetadataType.Attribute) {
      const tsInstance = findTabularSectionInstanceForAttributeParent(parent as TreeNode);
      if (tsInstance) {
        const xmlTarget = resolveXmlPathForTabularSectionInstance(tsInstance);
        if (!xmlTarget) {
          throw new Error('Файл табличной части или объекта не найден.');
        }
        try {
          await fs.promises.access(xmlTarget);
        } catch {
          throw new Error('Файл табличной части или объекта не найден.');
        }
        await XMLWriter.duplicateAttributeInTabularSection(
          xmlTarget,
          tsInstance.name,
          node.name,
          name
        );
        return;
      }
      const owner = resolveTopLevelMetadataObject(parent as TreeNode);
      if (!owner) {
        throw new Error('Не удалось определить объект-владелец для реквизита.');
      }
      await XMLWriter.addNestedElement(parentFilePath, 'Attribute', name, minimalProps, owner.type, owner.name);
      return;
    }
    const owner = resolveTopLevelMetadataObject(parent as TreeNode);
    if (!owner) {
      throw new Error('Не удалось определить объект-владелец.');
    }
    await XMLWriter.addNestedElement(
      parentFilePath,
      'TabularSection',
      name,
      minimalProps,
      owner.type,
      owner.name
    );
    return;
  }


  throw new Error('Дублирование для этого типа элемента не поддерживается.');
}

function requireRootMutationNode(node: TreeNode): {
  parent: TreeNode;
  filePath: string;
  typeFolderPath: string;
  rootTag: string;
} {
  if (!TOP_LEVEL_TYPES.has(node.type) || !node.parent) {
    throw new Error('Mutation plan is supported only for a root metadata object.');
  }
  const filePath = node.filePath ?? node.parentFilePath;
  if (!filePath) { throw new Error('Metadata object file was not found.'); }
  return {
    parent: node.parent,
    filePath,
    typeFolderPath: path.dirname(filePath),
    rootTag: String(node.type),
  };
}

/** Builds a byte-complete duplicate operation without applying filesystem effects. */
export async function planDuplicateRootElement(
  node: TreeNode,
  newName: string,
): Promise<MutationPlan<void>> {
  const { typeFolderPath } = requireRootMutationNode(node);
  const configRootPath = await findConfigurationRootDir(typeFolderPath);
  const planned = await planDuplicateMetadataObject(
    { configurationRootPath: configRootPath },
    { type: node.type, sourceName: node.name, newName },
  );
  return { ...planned.plan, kind: 'ui.duplicateRootElement' };
}
/** Builds a root rename, including directory XML identities and project references. */
export async function planRenameRootElement(
  node: TreeNode,
  newName: string,
  configPath: string,
): Promise<MutationPlan<void>> {
  requireRootMutationNode(node);
  const planned = await planRenameMetadataObject(
    { configurationRootPath: configPath },
    { type: node.type, oldName: node.name, newName },
  );
  return { ...planned.plan, kind: 'ui.renameRootElement' };
}

export interface DeleteElementContext {
  /** Canonical configuration boundary required for all R6 nested mutations. */
  trustedRootPath?: string;
}

async function resolveTrustedR6Path(trustedRootPath: string, targetPath: string): Promise<string> {
  const { canonicalRoot, canonicalTarget } = await assertPathWithinRoot(trustedRootPath, targetPath);
  await assertNoSymlinkSegments(canonicalRoot, canonicalTarget);
  return canonicalTarget;
}


/**
 * Delete element from XML or remove file. Optionally pass precomputed references to avoid second scan.
 */
export async function deleteElement(
  node: TreeNode,
  context: DeleteElementContext = {}
): Promise<void> {
  if (node.type === MetadataType.Configuration) {
    throw new Error('Нельзя удалить корень конфигурации.');
  }
  const parent = node.parent;
  if (!parent) {
    throw new Error('Нет родительского узла.');
  }

  const isR6Delete =
    node.type === MetadataType.EnumValue
    || node.type === MetadataType.Dimension
    || node.type === MetadataType.Resource
    || node.type === MetadataType.PredefinedItem;
  const trustedRootPath = context.trustedRootPath?.trim();
  if (isR6Delete && !trustedRootPath) {
    throw new Error('Для удаления R6-элемента не задан доверенный корень конфигурации.');
  }

  const filePath = node.parentFilePath || node.filePath;
  if (!filePath) {
    throw new Error('Файл элемента не найден.');
  }
  await assertCfeGenericMutationAllowed(filePath, 'delete');

  const r6NestedType =
    node.type === MetadataType.EnumValue ? 'EnumValue'
      : node.type === MetadataType.Dimension ? 'Dimension'
        : node.type === MetadataType.Resource ? 'Resource'
          : undefined;
  if (r6NestedType) {
    const expectedContainer = r6NestedType === 'EnumValue' ? 'EnumValues' : `${r6NestedType}s`;
    const owner = parent.id === expectedContainer ? parent.parent : undefined;
    const ownerTypeIsValid = owner && (
      (r6NestedType === 'EnumValue' && owner.type === MetadataType.Enum)
      || (r6NestedType !== 'EnumValue' && REGISTER_TYPES_FOR_DIM_RES.has(owner.type))
    );
    if (!ownerTypeIsValid || !owner?.filePath) {
      throw new Error('Некорректный владелец nested-элемента.');
    }
    if (!isSamePath(filePath, owner.filePath)) {
      throw new Error('Файл nested-элемента не совпадает с файлом владельца.');
    }
    const canonicalOwnerPath = await resolveTrustedR6Path(trustedRootPath as string, owner.filePath);
    const canonicalTargetPath = await resolveTrustedR6Path(trustedRootPath as string, filePath);
    if (!isSamePath(canonicalOwnerPath, canonicalTargetPath)) {
      throw new Error('Файл nested-элемента не совпадает с файлом владельца.');
    }
    await XMLWriter.removeNestedElement(canonicalTargetPath, r6NestedType, node.name, true);
    return;
  }

  if (node.type === MetadataType.PredefinedItem) {
    const owner = parent.id === 'PredefinedData' ? parent.parent : undefined;
    if (!owner || !PREDEFINED_METADATA_ROOT_TYPES.has(owner.type) || !owner.filePath) {
      throw new Error('Некорректный владелец предопределённого элемента.');
    }
    const predefinedPath = parent.filePath || node.parentFilePath;
    const expectedPredefinedPath = path.join(
      path.dirname(owner.filePath),
      owner.name,
      'Ext',
      'Predefined.xml'
    );
    const isExpectedPath = (candidate: string | undefined): boolean =>
      !!candidate && isSamePath(candidate, expectedPredefinedPath);
    if (
      !isExpectedPath(predefinedPath)
      || !isExpectedPath(parent.filePath)
      || (node.parentFilePath !== undefined && !isExpectedPath(node.parentFilePath))
      || !isExpectedPath(filePath)
    ) {
      throw new Error('Некорректный путь к Predefined.xml.');
    }
    const canonicalOwnerPath = await resolveTrustedR6Path(trustedRootPath as string, owner.filePath);
    const canonicalPredefinedPath = await resolveTrustedR6Path(
      trustedRootPath as string,
      predefinedPath as string
    );
    try {
      await fs.promises.access(canonicalOwnerPath);
    } catch {
      throw new Error('Файл владельца предопределённого элемента не найден.');
    }
    await removePredefinedDesignerItem(canonicalPredefinedPath, node.name);
    return;
  }

  if (node.type === MetadataType.Attribute || node.type === MetadataType.TabularSection) {
    const tsInstance = findTabularSectionInstanceForAttributeParent(parent as TreeNode);
    if (node.type === MetadataType.Attribute && tsInstance) {
      const xmlTarget = resolveXmlPathForTabularSectionInstance(tsInstance);
      if (!xmlTarget) {
        throw new Error('Файл табличной части или объекта не найден.');
      }
      try {
        await fs.promises.access(xmlTarget);
      } catch {
        throw new Error('Файл табличной части или объекта не найден.');
      }
      await XMLWriter.removeAttributeFromTabularSection(xmlTarget, tsInstance.name, node.name);
      return;
    }
    const parentFilePath = node.parentFilePath || (parent as TreeNode).filePath;
    if (!parentFilePath) {
      throw new Error('Родительский файл не найден.');
    }
    await XMLWriter.removeNestedElement(
      parentFilePath,
      node.type === MetadataType.TabularSection ? 'TabularSection' : 'Attribute',
      node.name
    );
    return;
  }

  if (TOP_LEVEL_TYPES.has(node.type)) {
    assertMetadataCrudSupported(node.type, 'delete');
    try {
      await fs.promises.access(filePath);
    } catch {
      throw new Error('Файл элемента не найден.');
    }
    const dirPath = path.dirname(filePath);
    const configRootPath = await findConfigurationRootDir(dirPath);
    const planned = await planDeleteMetadataObject(
      { configurationRootPath: configRootPath },
      { type: node.type, name: node.name },
    );
    const plannedDescriptorDelete = planned.plan.steps.some((step) => (
      step.type === 'deletePath' && isSamePath(step.targetPath, filePath)
    ));
    if (!plannedDescriptorDelete) {
      throw new Error('Корневой объект не совпадает с выбранным файлом элемента.');
    }
    await runConfigurationPlan(configRootPath, planned.plan);
    Logger.info(`Deleted element file ${filePath}`);
    return;
  }

  if (node.type === MetadataType.Form && node.id !== 'Forms') {
    await deleteForm(node);
    return;
  }

  throw new Error('Удаление для этого типа элемента не поддерживается.');
}

/**
 * Rename element and update references in project.
 */
export async function renameElement(
  node: TreeNode,
  newName: string,
  _configPath: string
): Promise<void> {
  if (node.type === MetadataType.Configuration) {
    throw new Error('Нельзя переименовать корень конфигурации.');
  }
  const parent = node.parent;
  if (!parent) {
    throw new Error('Нет родительского узла.');
  }
  const err = validateElementName(newName.trim(), getSiblingNames(parent));
  if (err) {
    throw new Error(err);
  }
  const name = newName.trim();
  const oldName = node.name;
  if (oldName === name) {
    return;
  }

  const filePath = node.parentFilePath || node.filePath;
  if (!filePath) {
    throw new Error('Файл элемента не найден.');
  }
  try {
    await fs.promises.access(filePath);
  } catch {
    throw new Error('Файл элемента не найден.');
  }
  if (node.type === MetadataType.Attribute || node.type === MetadataType.TabularSection) {
    await assertCfeGenericMutationAllowed(filePath, 'rename');
    const parentFilePath = node.parentFilePath || (parent as TreeNode).filePath;
    if (!parentFilePath) {
      throw new Error('Родительский файл не найден.');
    }
    const nestedOpts =
      node.type === MetadataType.Attribute
        ? (() => {
            const section = findTabularSectionInstanceForAttributeParent(parent as TreeNode);
            return section?.name ? { scopedTabularSectionName: section.name } : undefined;
          })()
        : undefined;
    await XMLWriter.writeNestedElementProperties(
      parentFilePath,
      node.type === MetadataType.TabularSection ? 'TabularSection' : 'Attribute',
      oldName,
      { ...node.properties, Name: name } as Record<string, unknown>,
      ['Name'],
      nestedOpts
    );
    return;
  }

  if (TOP_LEVEL_TYPES.has(node.type)) {
    const typeFolderPath = path.dirname(filePath);
    const configurationRootPath = await findConfigurationRootDir(typeFolderPath);
    await resolveProjectFormatVersion(configurationRootPath);
    const planned = await planRenameMetadataObject(
      { configurationRootPath },
      { type: node.type, oldName, newName: name },
    );
    await runConfigurationPlan(configurationRootPath, planned.plan);
    return;
  }

  throw new Error('Переименование для этого типа элемента не поддерживается.');
}


export { findReferencesToElement, findReferencesWithDiagnostics, ReferenceScanError };
