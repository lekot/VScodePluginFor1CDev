import * as fs from 'fs';
import * as path from 'path';
import { TreeNode, MetadataType } from '../models/treeNode';
import { Logger } from '../utils/logger';
import { ROOT_TAGS_WITHOUT_CHILDOBJECTS, XMLWriter } from '../utils/XMLWriter';
import { validateElementName } from '../utils/elementNameValidator';
import {
  findReferencesToElement,
  replaceReferencesInProject,
} from '../utils/referenceFinder';
import { getDesignerTemplateXml } from './designerTemplateRepository';
import { substituteDesignerTemplate } from './designerTemplateSubstitutor';
import {
  appendRegisterReferenceToRecorderDocument,
  removeRegisterReferenceFromRecorderDocument,
} from './registerRecorderDocumentLinker';
import { addRootObjectToConfiguration, removeRootObjectFromConfiguration } from './configurationXmlUpdater';
import { CONFIGURATION_XML, FORM_XML } from '../constants/fileNames';
import { injectInternalInfoIntoMetadataXml } from '../utils/xml/internalInfoGenerator';
import { normalizeMetaDataObjectRoot } from '../utils/xml/metaDataObjectRootNormalizer';
import {
  ensureTabularSectionColumnsPlaceholder,
  isTabularSectionColumnsContainer,
} from '../utils/treeNormalization';
import { rulesRegistry, metadataConverter } from '../rules';

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

/** Top-level metadata types that have their own XML file in Designer. */
export const TOP_LEVEL_TYPES = new Set<MetadataType>([
  MetadataType.Catalog,
  MetadataType.Document,
  MetadataType.Enum,
  MetadataType.Report,
  MetadataType.DataProcessor,
  MetadataType.ChartOfCharacteristicTypes,
  MetadataType.ChartOfAccounts,
  MetadataType.ChartOfCalculationTypes,
  MetadataType.InformationRegister,
  MetadataType.AccumulationRegister,
  MetadataType.AccountingRegister,
  MetadataType.CalculationRegister,
  MetadataType.BusinessProcess,
  MetadataType.Task,
  MetadataType.ExternalDataSource,
  MetadataType.Constant,
  MetadataType.SessionParameter,
  MetadataType.FilterCriterion,
  MetadataType.ScheduledJob,
  MetadataType.FunctionalOption,
  MetadataType.FunctionalOptionsParameter,
  MetadataType.SettingsStorage,
  MetadataType.EventSubscription,
  MetadataType.CommonModule,
  MetadataType.CommandGroup,
  MetadataType.Role,
  MetadataType.Interface,
  MetadataType.Style,
  MetadataType.WebService,
  MetadataType.HTTPService,
  MetadataType.IntegrationService,
  MetadataType.Subsystem,
  MetadataType.ExchangePlan,
  MetadataType.DocumentJournal,
  MetadataType.DefinedType,
  MetadataType.CommonAttribute,
  MetadataType.CommonCommand,
  MetadataType.CommonForm,
  MetadataType.CommonPicture,
  MetadataType.CommonTemplate,
  MetadataType.DocumentNumerator,
  MetadataType.Language,
  MetadataType.WSReference,
  MetadataType.XDTOPackage,
  MetadataType.StyleItem,
]);

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

/**
 * BusinessProcess.Properties.Task must reference an existing Task metadata object.
 * Template uses `Task.{Name}` with the same name as the business process; create the task first if missing.
 */
async function ensureCompanionTaskForBusinessProcess(
  configRootPath: string,
  businessProcessesFolderPath: string,
  taskName: string
): Promise<void> {
  const tasksDir = path.join(path.dirname(businessProcessesFolderPath), 'Tasks');
  await fs.promises.mkdir(tasksDir, { recursive: true });
  const taskFilePath = path.join(tasksDir, `${taskName}.xml`);
  try {
    await fs.promises.access(taskFilePath);
    return;
  } catch {
    // file does not exist, continue
  }
  const templateXml = await getDesignerTemplateXml('Task');
  if (templateXml !== null) {
    const uuid = XMLWriter.generateSimpleUuid();
    let content = substituteDesignerTemplate(templateXml, {
      uuid,
      Name: taskName,
      Synonym_ru: taskName,
    });
    content = injectInternalInfoIntoMetadataXml(content, 'Task', taskName);
    content = normalizeMetaDataObjectRoot(content);
    await fs.promises.writeFile(taskFilePath, content, 'utf-8');
  } else {
    await XMLWriter.createMinimalElementFile(taskFilePath, 'Task', taskName);
  }
  const taskElementDir = path.join(tasksDir, taskName);
  await fs.promises.mkdir(taskElementDir, { recursive: true });
  await addRootObjectToConfiguration(configRootPath, 'Task', taskName);
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

  // Guard against path traversal: typeFolderPath must be inside configuration root.
  const configRootForCheck = await findConfigurationRootDir(typeFolderPath);
  const resolvedTypeFolder = path.resolve(typeFolderPath);
  const resolvedConfigRoot = path.resolve(configRootForCheck);
  if (!resolvedTypeFolder.startsWith(resolvedConfigRoot + path.sep) && resolvedTypeFolder !== resolvedConfigRoot) {
    throw new Error(`Небезопасный путь: папка типа за пределами корня конфигурации: ${typeFolderPath}`);
  }

  // When using placeholder type-nodes, the type folder may be absent on disk.
  // Create it on-demand so element creation can proceed.
  // Use a single async stat to avoid TOCTOU between existsSync and statSync.
  try {
    const stat = await fs.promises.stat(typeFolderPath);
    if (!stat.isDirectory()) {
      throw new Error(`Папка типа не является директорией: ${typeFolderPath}`);
    }
  } catch (statErr) {
    if ((statErr as NodeJS.ErrnoException).code === 'ENOENT') {
      await fs.promises.mkdir(typeFolderPath, { recursive: true });
    } else {
      throw statErr;
    }
  }

  const newFilePath = path.join(typeFolderPath, `${name}.xml`);
  try {
    await fs.promises.access(newFilePath);
    throw new Error(`Файл уже существует: ${newFilePath}`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw e;
    }
  }

  const rootTag = String(parentNode.type);
  const configRootPath = await findConfigurationRootDir(typeFolderPath);

  if (rootTag === 'BusinessProcess') {
    await ensureCompanionTaskForBusinessProcess(configRootPath, typeFolderPath, name);
  }

  // Types that need template fallback (templates include ChildObjects with default children)
  const templateOnlyTypes = new Set(['InformationRegister', 'AccumulationRegister']);

  // Rules-based path
  const rules = !templateOnlyTypes.has(rootTag) ? rulesRegistry.get(rootTag) : undefined;
  if (rules) {
    const uuid = XMLWriter.generateSimpleUuid();
    const ir = metadataConverter.createDefaultIR(rules, { name, uuid });
    let content = metadataConverter.irToXml(ir, rules);
    content = injectInternalInfoIntoMetadataXml(content, rootTag, name);
    content = normalizeMetaDataObjectRoot(content);
    await fs.promises.writeFile(newFilePath, content, 'utf-8');
  } else {
    // Template-based fallback (все остальные типы)
    const templateXml = await getDesignerTemplateXml(rootTag);
    if (templateXml !== null) {
      const uuid = XMLWriter.generateSimpleUuid();
      const uuidDim = XMLWriter.generateSimpleUuid();
      const uuidResource = XMLWriter.generateSimpleUuid();
      let content = substituteDesignerTemplate(templateXml, {
        uuid,
        Name: name,
        Synonym_ru: name,
        ...(rootTag === 'InformationRegister' || rootTag === 'AccumulationRegister'
          ? { uuidDim, uuidResource }
          : {}),
        ...(rootTag === 'DocumentJournal'
          ? (() => {
              const doc = process.env.IBCMD_RECORDER_DOCUMENT?.trim();
              return doc ? { RecorderDocumentRef: `Document.${doc}` } : {};
            })()
          : {}),
      });
      content = injectInternalInfoIntoMetadataXml(content, rootTag, name);
      content = normalizeMetaDataObjectRoot(content);
      await fs.promises.writeFile(newFilePath, content, 'utf-8');
    } else {
      await XMLWriter.createMinimalElementFile(newFilePath, rootTag, name);
    }
  }

  const elementDir = path.join(typeFolderPath, name);
  await fs.promises.mkdir(elementDir, { recursive: true });

  if (rootTag === 'CommonModule') {
    const moduleBslPath = path.join(elementDir, 'Ext', 'Module', 'Module.bsl');
    await fs.promises.mkdir(path.dirname(moduleBslPath), { recursive: true });
    await fs.promises.writeFile(moduleBslPath, '', 'utf-8');
  }

  try {
    await addRootObjectToConfiguration(configRootPath, rootTag, name);
  } catch (err) {
    Logger.error('Failed to update Configuration.xml', err);
    throw err;
  }

  if (rootTag === 'AccumulationRegister') {
    try {
      await appendRegisterReferenceToRecorderDocument(configRootPath, 'AccumulationRegister', name);
    } catch (e) {
      Logger.warn('Could not link AccumulationRegister to recorder document', e);
    }
  }
}

/** Branch: parentNode is a top-level metadata object (Catalog, Document, …) — create nested Attribute. */
async function handleCreateNestedUnderTopLevel(parentNode: TreeNode, name: string): Promise<void> {
  if (ROOT_TAGS_WITHOUT_CHILDOBJECTS.has(String(parentNode.type))) {
    throw new Error(
      'В формате Designer у этого типа метаданных нет ChildObjects (например, роль, общий модуль). ' +
        'Создание реквизита/табличной части под выбранным узлом не поддерживается.'
    );
  }
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
  if (ROOT_TAGS_WITHOUT_CHILDOBJECTS.has(String(parent.type))) {
    throw new Error(
      'В формате Designer у этого типа метаданных нет ChildObjects. ' +
        'Создание реквизита/табличной части под выбранным узлом не поддерживается.'
    );
  }
  const filePath = parent.filePath;
  if (!filePath) {
    throw new Error('Файл объекта не найден.');
  }
  try {
    await fs.promises.access(filePath);
  } catch {
    throw new Error('Файл объекта не найден.');
  }
  const elementType = parentNode.type === MetadataType.Attribute ? 'Attribute' : 'TabularSection';
  await XMLWriter.addNestedElement(filePath, elementType, name, {}, parent.type, parent.name);
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
  const parent = parentNode.parent;

  for (const { matches, handle } of CREATE_ELEMENT_CASES) {
    if (matches(parentNode, parent)) {
      await handle(parentNode, parent, name, newName);
      return;
    }
  }

  // Recognize new R6 containers that don't yet have a create handler — give a precise message
  const unsupportedContainers: Record<string, string> = {
    EnumValues: 'значений перечисления',
    Dimensions: 'измерений регистра',
    Resources: 'ресурсов регистра',
    PredefinedData: 'предопределённых элементов',
  };
  const reason = unsupportedContainers[parentNode.id];
  if (reason) {
    throw new Error(
      `Создание ${reason} пока не поддерживается. ` +
        `Добавьте элемент напрямую в XML файл объекта и перезагрузите конфигурацию. ` +
        `Реализация CRUD через UI в процессе разработки.`
    );
  }

  throw new Error(
    'Создание элемента: выберите узел типа (в т.ч. под «Общие»), объект метаданных или контейнер (Атрибуты, Табличные части). ' +
      'Если выбран типовой узел, его родитель должен быть корень конфигурации или группа «Общие».'
  );
}

/** Minimal Ext/Form.xml content for a new form (Designer). */
const MINIMAL_EXT_FORM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.20">
\t<Events/>
\t<ChildItems/>
\t<Attributes/>
\t<Commands/>
</Form>
`;

/**
 * Creates a new form under the Forms node (Designer format only).
 * 
 * Creates the complete form structure (выгрузка Designer / ibcmd):
 * - Forms/FormName.xml (метаданные формы)
 * - Forms/FormName/Ext/Form.xml и Forms/FormName/Ext/Form/Module.bsl
 * 
 * @param parentNode - The Forms node where the form will be created
 * @param formName - Name for the new form (will be validated)
 * @throws {Error} If parent is not a Forms node or validation fails
 * 
 * @example
 * ```typescript
 * await createForm(formsNode, 'ItemForm');
 * ```
 */
export async function createForm(parentNode: TreeNode, formName: string): Promise<void> {
  const name = formName.trim();
  const err = validateElementName(name, getSiblingNames(parentNode));
  if (err) {
    throw new Error(err);
  }
  if (parentNode.id !== 'Forms') {
    throw new Error('Создание формы: выберите узел «Forms» в дереве метаданных.');
  }
  const formsPath = parentNode.filePath;
  if (!formsPath) {
    throw new Error('Папка форм: не задан путь к каталогу Forms.');
  }
  let formsStat: fs.Stats | undefined;
  try {
    formsStat = await fs.promises.stat(formsPath);
  } catch {
    // directory does not exist yet
  }
  if (!formsStat) {
    await fs.promises.mkdir(formsPath, { recursive: true });
  } else if (!formsStat.isDirectory()) {
    throw new Error(`Папка форм не найдена: ${formsPath}`);
  }
  const formMetaPath = path.join(formsPath, `${name}.xml`);
  const extRoot = path.join(formsPath, name);
  const [metaExists, extRootExists] = await Promise.all([
    fs.promises.access(formMetaPath).then(() => true).catch(() => false),
    fs.promises.access(extRoot).then(() => true).catch(() => false),
  ]);
  if (metaExists || extRootExists) {
    throw new Error(`Форма с именем «${name}» уже существует.`);
  }
  await XMLWriter.createMinimalElementFile(formMetaPath, 'Form', name);
  const extDir = path.join(extRoot, 'Ext');
  const formXmlPath = path.join(extDir, FORM_XML);
  const formModuleDir = path.join(extDir, 'Form');
  const modulePath = path.join(formModuleDir, 'Module.bsl');
  await fs.promises.mkdir(formModuleDir, { recursive: true });
  await fs.promises.writeFile(formXmlPath, MINIMAL_EXT_FORM_XML, 'utf-8');
  await fs.promises.writeFile(modulePath, '', 'utf-8');
  Logger.info(`Created form: ${formMetaPath}`);

  const owner = parentNode.parent;
  const ownerXmlPath = owner?.filePath;
  if (ownerXmlPath && ownerXmlPath.toLowerCase().endsWith('.xml')) {
    const ownerExists = await fs.promises.access(ownerXmlPath).then(() => true).catch(() => false);
    if (ownerExists) {
      await XMLWriter.addDesignerFormReferenceToOwnerMetadata(ownerXmlPath, name);
    }
  }
}

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

  if (TOP_LEVEL_TYPES.has(node.type)) {
    const typeNode = parent;
    const typeFolderPath = typeNode.filePath;
    if (!typeFolderPath) {
      throw new Error('Папка типа не найдена.');
    }
    const sourcePath = node.filePath;
    if (!sourcePath) {
      throw new Error('Файл исходного элемента не найден.');
    }
    try {
      await fs.promises.access(sourcePath);
    } catch {
      throw new Error('Файл исходного элемента не найден.');
    }
    const newFilePath = path.join(typeFolderPath, `${name}.xml`);
    const newFileExists = await fs.promises.access(newFilePath).then(() => true).catch(() => false);
    if (newFileExists) {
      throw new Error(`Файл уже существует: ${newFilePath}`);
    }
    let content = await fs.promises.readFile(sourcePath, 'utf-8');
    content = content.replace(new RegExp(`<Name>${escapeRegex(node.name)}</Name>`, 'g'), `<Name>${name}</Name>`);
    const synonymMatch = content.match(/<v8:content>([^<]*)<\/v8:content>/);
    if (synonymMatch) {
      content = content.replace(
        new RegExp(`<v8:content>${escapeRegex(synonymMatch[1])}</v8:content>`, 'g'),
        `<v8:content>${name}</v8:content>`
      );
    }
    await fs.promises.writeFile(newFilePath, content, 'utf-8');
    const oldDir = path.join(typeFolderPath, node.name);
    const newDir = path.join(typeFolderPath, name);
    let oldDirStat: fs.Stats | undefined;
    try {
      oldDirStat = await fs.promises.stat(oldDir);
    } catch {
      // oldDir does not exist
    }
    if (oldDirStat?.isDirectory()) {
      const newDirExists = await fs.promises.access(newDir).then(() => true).catch(() => false);
      if (newDirExists) {
        throw new Error(`Каталог объекта уже существует: ${newDir}`);
      }
      await fs.promises.cp(oldDir, newDir, { recursive: true });
    }
    Logger.info(`Duplicated element to ${newFilePath}`);
    return;
  }

  throw new Error('Дублирование для этого типа элемента не поддерживается.');
}

/**
 * Escapes special regex characters in a string.
 * @param s - String to escape
 * @returns Escaped string safe for use in RegExp
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


/**
 * Delete element from XML or remove file. Optionally pass precomputed references to avoid second scan.
 */
export async function deleteElement(node: TreeNode): Promise<void> {
  if (node.type === MetadataType.Configuration) {
    throw new Error('Нельзя удалить корень конфигурации.');
  }
  const parent = node.parent;
  if (!parent) {
    throw new Error('Нет родительского узла.');
  }

  const filePath = node.parentFilePath || node.filePath;
  if (!filePath) {
    throw new Error('Файл элемента не найден.');
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
    try {
      await fs.promises.access(filePath);
    } catch {
      throw new Error('Файл элемента не найден.');
    }
    await fs.promises.unlink(filePath);
    const dirPath = path.dirname(filePath);
    const elementDir = path.join(dirPath, node.name);
    let elementDirStat: fs.Stats | undefined;
    try {
      elementDirStat = await fs.promises.stat(elementDir);
    } catch {
      // directory does not exist
    }
    if (elementDirStat?.isDirectory()) {
      await fs.promises.rm(elementDir, { recursive: true });
    }
    const rootTag = String(node.type);
    const configRootPath = path.dirname(dirPath);
    try {
      await removeRootObjectFromConfiguration(configRootPath, rootTag, node.name);
    } catch (err) {
      Logger.error('Failed to update Configuration.xml on delete', err);
      throw err;
    }
    if (rootTag === 'AccumulationRegister') {
      try {
        await removeRegisterReferenceFromRecorderDocument(
          configRootPath,
          'AccumulationRegister',
          node.name
        );
      } catch (e) {
        Logger.warn('Could not remove AccumulationRegister ref from recorder document', e);
      }
    }
    Logger.info(`Deleted element file ${filePath}`);
    return;
  }

  if (node.type === MetadataType.Form && node.id !== 'Forms') {
    if (parent.id !== 'Forms') {
      throw new Error('Удаление формы: ожидался родительский узел «Forms».');
    }
    const owner = parent.parent;
    const ownerXmlPath = owner?.filePath;
    if (ownerXmlPath && ownerXmlPath.toLowerCase().endsWith('.xml')) {
      const ownerExists = await fs.promises.access(ownerXmlPath).then(() => true).catch(() => false);
      if (ownerExists) {
        await XMLWriter.removeDesignerFormFromOwnerMetadata(ownerXmlPath, node.name);
      }
    }
    const fp = node.filePath;
    if (!fp) {
      throw new Error('Файл элемента не найден.');
    }
    try {
      await fs.promises.access(fp);
    } catch {
      throw new Error('Файл элемента не найден.');
    }
    const lower = fp.toLowerCase();
    if (lower.endsWith('.xml')) {
      const extRoot = path.join(path.dirname(fp), path.basename(fp, path.extname(fp)));
      await fs.promises.unlink(fp);
      let extRootStat: fs.Stats | undefined;
      try {
        extRootStat = await fs.promises.stat(extRoot);
      } catch {
        // ext dir does not exist
      }
      if (extRootStat?.isDirectory()) {
        await fs.promises.rm(extRoot, { recursive: true, force: true });
      }
      Logger.info(`Deleted form metadata ${fp} and ext dir if present`);
      return;
    }
    const stat = await fs.promises.stat(fp);
    if (!stat.isDirectory()) {
      throw new Error('Ожидалась папка формы.');
    }
    await fs.promises.rm(fp, { recursive: true, force: true });
    Logger.info(`Deleted form directory ${fp}`);
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
  configPath: string
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
    const newFilePath = path.join(typeFolderPath, `${name}.xml`);
    if (newFilePath === filePath) {
      await replaceReferencesInProject(configPath, oldName, name, node.type);
      return;
    }
    let content = await fs.promises.readFile(filePath, 'utf-8');
    content = content.replace(
      new RegExp(`<Name>${escapeRegex(oldName)}</Name>`, 'g'),
      `<Name>${name}</Name>`
    );
    const synonymMatch = content.match(/<v8:content>([^<]*)<\/v8:content>/);
    if (synonymMatch) {
      content = content.replace(
        new RegExp(`<v8:content>${escapeRegex(synonymMatch[1])}</v8:content>`, 'g'),
        `<v8:content>${name}</v8:content>`
      );
    }
    await fs.promises.writeFile(newFilePath, content, 'utf-8');
    await fs.promises.unlink(filePath);
    const oldDir = path.join(typeFolderPath, oldName);
    const newDir = path.join(typeFolderPath, name);
    let oldDirStat: fs.Stats | undefined;
    try {
      oldDirStat = await fs.promises.stat(oldDir);
    } catch {
      // directory does not exist
    }
    if (oldDirStat?.isDirectory()) {
      await fs.promises.rename(oldDir, newDir);
    }
    const updated = await replaceReferencesInProject(configPath, oldName, name, node.type);
    Logger.info(`Renamed to ${name}, updated ${updated.length} file(s)`);
    return;
  }

  throw new Error('Переименование для этого типа элемента не поддерживается.');
}


export { findReferencesToElement };
