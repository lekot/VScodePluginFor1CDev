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

/** Top-level metadata types that have their own XML file in Designer. */
const TOP_LEVEL_TYPES = new Set<MetadataType>([
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
]);

/**
 * Gets the names of all child nodes of a parent node.
 * @param parent - The parent TreeNode
 * @returns Array of child node names
 */
function getSiblingNames(parent: TreeNode): string[] {
  return (parent.children || []).map((c) => c.name);
}

/**
 * Creates a new metadata element in the configuration.
 * 
 * Parent can be a type node (e.g. Catalogs) or an object (Catalog/Document) for nested Attribute.
 * Creates the element XML file and associated directory structure.
 * 
 * @param parentNode - The parent node where the element will be created
 * @param newName - Name for the new element (will be validated)
 * @param _options - Optional configuration (currently unused)
 * @throws {Error} If validation fails or parent is invalid
 * 
 * @example
 * ```typescript
 * // Create a new catalog
 * await createElement(catalogsTypeNode, 'NewCatalog');
 * ```
 */
export async function createElement(
  parentNode: TreeNode,
  newName: string,
  _options?: { type?: string }
): Promise<void> {
  const err = validateElementName(newName.trim(), getSiblingNames(parentNode));
  if (err) {
    throw new Error(err);
  }
  const name = newName.trim();

  if (parentNode.type === MetadataType.Configuration) {
    throw new Error('Выберите узел типа (например Справочники) или объект для создания реквизита.');
  }

  const parent = parentNode.parent;
  if (!parent) {
    throw new Error('Нет родительского узла.');
  }

  const isTypeFolder = parent.type === MetadataType.Configuration;
  if (isTypeFolder && TOP_LEVEL_TYPES.has(parentNode.type)) {
    const typeFolderPath = parentNode.filePath;
    if (!typeFolderPath || !fs.existsSync(typeFolderPath)) {
      throw new Error(`Папка типа не найдена: ${typeFolderPath}`);
    }
    const newFilePath = path.join(typeFolderPath, `${name}.xml`);
    if (fs.existsSync(newFilePath)) {
      throw new Error(`Файл уже существует: ${newFilePath}`);
    }
    const rootTag = String(parentNode.type);
    await XMLWriter.createMinimalElementFile(newFilePath, rootTag, name);
    const elementDir = path.join(typeFolderPath, name);
    await fs.promises.mkdir(elementDir, { recursive: true });
    return;
  }

  if (TOP_LEVEL_TYPES.has(parentNode.type)) {
    const filePath = parentNode.filePath;
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error('Файл объекта не найден.');
    }
    await XMLWriter.addNestedElement(filePath, 'Attribute', name, {});
    return;
  }

  throw new Error('Создание элемента: выберите узел типа (Справочники, Документы и т.д.) или объект метаданных.');
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
  if (!formsPath || !fs.existsSync(formsPath) || !fs.statSync(formsPath).isDirectory()) {
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
      minimalProps
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
    Logger.info(`Deleted element file ${filePath}`);
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
