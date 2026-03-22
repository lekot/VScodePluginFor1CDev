import * as fs from 'fs';
import * as path from 'path';
import { TreeNode, MetadataType } from '../models/treeNode';
import { Logger } from '../utils/logger';
import { XMLWriter } from '../utils/XMLWriter';
import { validateElementName } from '../utils/elementNameValidator';
import {
  findReferencesToElement,
  replaceReferencesInProject,
} from '../utils/referenceFinder';
import { getDesignerTemplateXml } from './designerTemplateRepository';
import { substituteDesignerTemplate } from './designerTemplateSubstitutor';
import { addRootObjectToConfiguration, removeRootObjectFromConfiguration } from './configurationXmlUpdater';
import { injectInternalInfoIntoMetadataXml } from './internalInfoGenerator';
import { normalizeMetaDataObjectRoot } from './metaDataObjectRootNormalizer';

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
function findConfigurationRootDir(typeFolderPath: string): string {
  let dir = typeFolderPath;
  for (let depth = 0; depth < 16; depth++) {
    const candidate = path.join(dir, 'Configuration.xml');
    if (fs.existsSync(candidate)) {
      return dir;
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
  const trimmedName = newName.trim();
  if (!trimmedName) {
    throw new Error('Имя элемента не может быть пустым');
  }
  
  const err = validateElementName(trimmedName, getSiblingNames(parentNode));
  if (err) {
    throw new Error(err);
  }
  const name = trimmedName;

  if (parentNode.type === MetadataType.Configuration) {
    throw new Error('Выберите узел типа (например Справочники) или объект для создания реквизита.');
  }

  const parent = parentNode.parent;
  if (!parent) {
    throw new Error('Нет родительского узла.');
  }

  if (isRootObjectCreateInTypeFolder(parentNode)) {
    const typeFolderPath = parentNode.filePath;
    if (!typeFolderPath) {
      throw new Error(`Папка типа не найдена: ${typeFolderPath}`);
    }
    
    // When using placeholder type-nodes, the type folder may be absent on disk.
    // Create it on-demand so element creation can proceed.
    if (!fs.existsSync(typeFolderPath)) {
      await fs.promises.mkdir(typeFolderPath, { recursive: true });
    } else {
      // If the path exists but is not a directory, fail early with a clear message.
      const stat = fs.statSync(typeFolderPath);
      if (!stat.isDirectory()) {
        throw new Error(`Папка типа не является директорией: ${typeFolderPath}`);
      }
    }
    const newFilePath = path.join(typeFolderPath, `${name}.xml`);
    if (fs.existsSync(newFilePath)) {
      throw new Error(`Файл уже существует: ${newFilePath}`);
    }
    const rootTag = String(parentNode.type);
    const configRootPath = findConfigurationRootDir(typeFolderPath);
    const templateXml = await getDesignerTemplateXml(rootTag);
    if (templateXml !== null) {
      const uuid = XMLWriter.generateSimpleUuid();
      let content = substituteDesignerTemplate(templateXml, {
        uuid,
        Name: name,
        Synonym_ru: name,
      });
      content = injectInternalInfoIntoMetadataXml(content, rootTag, name);
      content = normalizeMetaDataObjectRoot(content);
      await fs.promises.writeFile(newFilePath, content, 'utf-8');
    } else {
      await XMLWriter.createMinimalElementFile(newFilePath, rootTag, name);
    }
    const elementDir = path.join(typeFolderPath, name);
    await fs.promises.mkdir(elementDir, { recursive: true });
    try {
      await addRootObjectToConfiguration(configRootPath, rootTag, name);
    } catch (err) {
      Logger.error('Failed to update Configuration.xml', err);
      throw err;
    }
    return;
  }

  // Handle nested elements: when parentNode is a top-level type (Catalog, Document, etc.)
  if (TOP_LEVEL_TYPES.has(parentNode.type)) {
    const filePath = parentNode.filePath;
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error('Файл объекта не найден.');
    }
    await XMLWriter.addNestedElement(filePath, 'Attribute', name, {}, parentNode.type, parentNode.name);
    return;
  }

  // Handle container folders (Attributes, TabularSections) under objects
  const containerTypes = new Set([
    MetadataType.Attribute, // Attributes folder has type Attribute
    MetadataType.TabularSection // TabularSections folder has type TabularSection
  ]);

  if (containerTypes.has(parentNode.type) && parent) {
    // Check if the parent of the container is a top-level type object
    if (TOP_LEVEL_TYPES.has(parent.type)) {
      const filePath = parent.filePath;
      if (!filePath || !fs.existsSync(filePath)) {
        throw new Error('Файл объекта не найден.');
      }
      
      // Determine the element type based on container type
      const elementType = parentNode.type === MetadataType.Attribute ? 'Attribute' : 'TabularSection';
      await XMLWriter.addNestedElement(filePath, elementType, name, {}, parent.type, parent.name);
      return;
    }
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
 * Creates the complete form structure:
 * - FormName.xml (metadata file)
 * - Ext/Form.xml (minimal form structure)
 * - Ext/Form/Module.bsl (empty module file)
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
  if (!fs.existsSync(formsPath)) {
    await fs.promises.mkdir(formsPath, { recursive: true });
  }
  if (!fs.statSync(formsPath).isDirectory()) {
    throw new Error(`Папка форм не найдена: ${formsPath}`);
  }
  const formDir = path.join(formsPath, name);
  const formMetaPath = path.join(formDir, `${name}.xml`);
  if (fs.existsSync(formDir)) {
    throw new Error(`Форма с именем «${name}» уже существует.`);
  }
  await fs.promises.mkdir(formDir, { recursive: true });
  await XMLWriter.createMinimalElementFile(formMetaPath, 'Form', name);
  const extDir = path.join(formDir, 'Ext');
  const formXmlPath = path.join(extDir, 'Form.xml');
  const formModuleDir = path.join(extDir, 'Form');
  const modulePath = path.join(formModuleDir, 'Module.bsl');
  await fs.promises.mkdir(formModuleDir, { recursive: true });
  await fs.promises.writeFile(formXmlPath, MINIMAL_EXT_FORM_XML, 'utf-8');
  await fs.promises.writeFile(modulePath, '', 'utf-8');
  Logger.info(`Created form: ${formMetaPath}`);

  const owner = parentNode.parent;
  const ownerXmlPath = owner?.filePath;
  if (ownerXmlPath && fs.existsSync(ownerXmlPath) && ownerXmlPath.toLowerCase().endsWith('.xml')) {
    await XMLWriter.addDesignerFormReferenceToOwnerMetadata(ownerXmlPath, name);
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
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error('Файл элемента не найден.');
  }

  if (node.type === MetadataType.Attribute || node.type === MetadataType.TabularSection) {
    const parentFilePath = node.parentFilePath || (parent as TreeNode).filePath;
    if (!parentFilePath) {
      throw new Error('Родительский файл не найден.');
    }
    const attrProps = (node.properties || {}) as Record<string, unknown>;
    const minimalProps = { ...attrProps, Name: name } as Record<string, unknown>;
    await XMLWriter.addNestedElement(
      parentFilePath,
      node.type === MetadataType.TabularSection ? 'TabularSection' : 'Attribute',
      name,
      minimalProps,
      parent.type,
      parent.name
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
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      throw new Error('Файл исходного элемента не найден.');
    }
    const newFilePath = path.join(typeFolderPath, `${name}.xml`);
    if (fs.existsSync(newFilePath)) {
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
    if (!fs.existsSync(filePath)) {
      throw new Error('Файл элемента не найден.');
    }
    await fs.promises.unlink(filePath);
    const dirPath = path.dirname(filePath);
    const elementDir = path.join(dirPath, node.name);
    if (fs.existsSync(elementDir) && fs.statSync(elementDir).isDirectory()) {
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
    Logger.info(`Deleted element file ${filePath}`);
    return;
  }

  if (node.type === MetadataType.Form && node.id !== 'Forms') {
    if (parent.id !== 'Forms') {
      throw new Error('Удаление формы: ожидался родительский узел «Forms».');
    }
    const owner = parent.parent;
    const ownerXmlPath = owner?.filePath;
    if (ownerXmlPath && fs.existsSync(ownerXmlPath) && ownerXmlPath.toLowerCase().endsWith('.xml')) {
      await XMLWriter.removeDesignerFormFromOwnerMetadata(ownerXmlPath, node.name);
    }
    const formDir = node.filePath;
    if (!formDir || !fs.existsSync(formDir)) {
      throw new Error('Файл элемента не найден.');
    }
    const stat = fs.statSync(formDir);
    if (!stat.isDirectory()) {
      throw new Error('Ожидалась папка формы.');
    }
    await fs.promises.rm(formDir, { recursive: true, force: true });
    Logger.info(`Deleted form directory ${formDir}`);
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
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error('Файл элемента не найден.');
  }

  if (node.type === MetadataType.Attribute || node.type === MetadataType.TabularSection) {
    const parentFilePath = node.parentFilePath || (parent as TreeNode).filePath;
    if (!parentFilePath) {
      throw new Error('Родительский файл не найден.');
    }
    await XMLWriter.writeNestedElementProperties(
      parentFilePath,
      node.type === MetadataType.TabularSection ? 'TabularSection' : 'Attribute',
      oldName,
      { ...node.properties, Name: name } as Record<string, unknown>,
      ['Name']
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
    if (fs.existsSync(oldDir) && fs.statSync(oldDir).isDirectory()) {
      await fs.promises.rename(oldDir, newDir);
    }
    const updated = await replaceReferencesInProject(configPath, oldName, name, node.type);
    Logger.info(`Renamed to ${name}, updated ${updated.length} file(s)`);
    return;
  }

  throw new Error('Переименование для этого типа элемента не поддерживается.');
}


export { findReferencesToElement };
