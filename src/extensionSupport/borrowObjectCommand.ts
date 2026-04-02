import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { TreeNode, MetadataType } from '../models/treeNode';
import { ExtensionState } from '../state/extensionState';
import { addRootObjectToConfiguration } from '../services/configurationXmlUpdater';
import { generateSimpleUuid } from '../utils/xml/xmlHelpers';
import { CONFIGURATION_XML } from '../constants/fileNames';
import { Logger } from '../utils/logger';
import { getExtensionRootNodes } from './extensionTypes';

/** XML namespaces for MetaDataObject root element */
const METADATA_OBJECT_NS = [
  'xmlns="http://v8.1c.ru/8.3/MDClasses"',
  'xmlns:app="http://v8.1c.ru/8.2/managed-application/core"',
  'xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config"',
  'xmlns:cmi="http://v8.1c.ru/8.2/managed-application/cmi"',
  'xmlns:ent="http://v8.1c.ru/8.1/data/enterprise"',
  'xmlns:lf="http://v8.1c.ru/8.2/managed-application/logform"',
  'xmlns:style="http://v8.1c.ru/8.1/data/ui/style"',
  'xmlns:sys="http://v8.1c.ru/8.1/data/ui/fonts/system"',
  'xmlns:v8="http://v8.1c.ru/8.1/data/core"',
  'xmlns:v8ui="http://v8.1c.ru/8.1/data/ui"',
  'xmlns:web="http://v8.1c.ru/8.1/data/ui/colors/web"',
  'xmlns:win="http://v8.1c.ru/8.1/data/ui/colors/windows"',
  'xmlns:xen="http://v8.1c.ru/8.3/xcf/enums"',
  'xmlns:xpr="http://v8.1c.ru/8.3/xcf/predef"',
  'xmlns:xr="http://v8.1c.ru/8.3/xcf/readable"',
  'xmlns:xs="http://www.w3.org/2001/XMLSchema"',
  'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
].join(' ');

/**
 * Escapes special XML characters to prevent XML injection.
 */
function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Builds the XML content for a borrowed (Adopted) object in an extension.
 */
function buildBorrowedObjectXml(rootTag: string, newUuid: string, objectName: string, sourceUuid: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<MetaDataObject ${METADATA_OBJECT_NS}>\n` +
    `\t<${escapeXml(rootTag)} uuid="${escapeXml(newUuid)}">\n` +
    `\t\t<Properties>\n` +
    `\t\t\t<Name>${escapeXml(objectName)}</Name>\n` +
    `\t\t\t<ObjectBelonging>Adopted</ObjectBelonging>\n` +
    `\t\t\t<ExtendedConfigurationObject>${escapeXml(sourceUuid)}</ExtendedConfigurationObject>\n` +
    `\t\t</Properties>\n` +
    `\t</${escapeXml(rootTag)}>\n` +
    `</MetaDataObject>\n`
  );
}

/**
 * Reads the uuid attribute from the root metadata element in an XML file.
 * Returns null if not found.
 */
async function readObjectUuid(xmlFilePath: string): Promise<string | null> {
  let content: string;
  try {
    content = await fs.promises.readFile(xmlFilePath, 'utf-8');
  } catch {
    return null;
  }
  // Match uuid="..." on a root element tag like <Catalog uuid="..."> or <Document uuid="...">
  const match = /<\w+[^>]+uuid="([0-9a-f-]{36})"/i.exec(content);
  return match ? match[1] : null;
}

/**
 * Returns all extension root nodes from the tree.
 * Extensions are top-level root nodes with extensionPurpose in properties.
 */
function findExtensionRootNodes(state: ExtensionState): TreeNode[] {
  return getExtensionRootNodes(state);
}

/**
 * Finds the type folder for a given MetadataType inside an extension root node.
 * E.g. for Catalog, returns the "Catalogs" child node.
 */
function findTypeFolderInExtension(extensionNode: TreeNode, targetType: MetadataType): TreeNode | undefined {
  if (!extensionNode.children) {
    return undefined;
  }
  return extensionNode.children.find((c) => c.type === targetType);
}

/**
 * Checks whether an object with the given name already exists in the extension's type folder.
 */
function isAlreadyBorrowed(extensionNode: TreeNode, targetType: MetadataType, objectName: string): boolean {
  const typeFolder = findTypeFolderInExtension(extensionNode, targetType);
  if (!typeFolder || !typeFolder.children) {
    return false;
  }
  return typeFolder.children.some((c) => c.name === objectName);
}

/**
 * Derives the type folder disk path for a given MetadataType inside an extension root directory.
 * Convention: plural form is stored in `typeFolder.filePath` if it exists.
 */
function resolveTypeFolderPath(extensionRootDir: string, typeFolderNode: TreeNode | undefined, type: MetadataType): string {
  if (typeFolderNode?.filePath) {
    return typeFolderNode.filePath;
  }
  // Fallback: derive the plural folder name from the type enum value
  const pluralMap: Partial<Record<MetadataType, string>> = {
    [MetadataType.Catalog]: 'Catalogs',
    [MetadataType.Document]: 'Documents',
    [MetadataType.Enum]: 'Enums',
    [MetadataType.Report]: 'Reports',
    [MetadataType.DataProcessor]: 'DataProcessors',
    [MetadataType.InformationRegister]: 'InformationRegisters',
    [MetadataType.AccumulationRegister]: 'AccumulationRegisters',
    [MetadataType.CommonModule]: 'CommonModules',
    [MetadataType.Role]: 'Roles',
    [MetadataType.Subsystem]: 'Subsystems',
    [MetadataType.CommonForm]: 'CommonForms',
    [MetadataType.CommonTemplate]: 'CommonTemplates',
    [MetadataType.CommonPicture]: 'CommonPictures',
    [MetadataType.CommonCommand]: 'CommonCommands',
    [MetadataType.ExchangePlan]: 'ExchangePlans',
    [MetadataType.Constant]: 'Constants',
    [MetadataType.ChartOfCharacteristicTypes]: 'ChartsOfCharacteristicTypes',
    [MetadataType.ChartOfAccounts]: 'ChartsOfAccounts',
    [MetadataType.AccountingRegister]: 'AccountingRegisters',
    [MetadataType.ChartOfCalculationTypes]: 'ChartsOfCalculationTypes',
    [MetadataType.CalculationRegister]: 'CalculationRegisters',
    [MetadataType.BusinessProcess]: 'BusinessProcesses',
    [MetadataType.Task]: 'Tasks',
    [MetadataType.DocumentJournal]: 'DocumentJournals',
    [MetadataType.FilterCriterion]: 'FilterCriteria',
    [MetadataType.SettingsStorage]: 'SettingsStorages',
    [MetadataType.FunctionalOption]: 'FunctionalOptions',
    [MetadataType.ScheduledJob]: 'ScheduledJobs',
    [MetadataType.ExternalDataSource]: 'ExternalDataSources',
    [MetadataType.SessionParameter]: 'SessionParameters',
    [MetadataType.FunctionalOptionsParameter]: 'FunctionalOptionsParameters',
    [MetadataType.EventSubscription]: 'EventSubscriptions',
    [MetadataType.CommandGroup]: 'CommandGroups',
    [MetadataType.Interface]: 'Interfaces',
    [MetadataType.WebService]: 'WebServices',
    [MetadataType.HTTPService]: 'HTTPServices',
    [MetadataType.IntegrationService]: 'IntegrationServices',
    [MetadataType.DefinedType]: 'DefinedTypes',
    [MetadataType.CommonAttribute]: 'CommonAttributes',
    [MetadataType.DocumentNumerator]: 'DocumentNumerators',
    [MetadataType.Language]: 'Languages',
    [MetadataType.XDTOPackage]: 'XDTOPackages',
    [MetadataType.WSReference]: 'WSReferences',
  };
  const typeName = String(type);
  const folderName = pluralMap[type] ?? (typeName.endsWith('s') ? `${typeName}es` : `${typeName}s`);
  return path.join(extensionRootDir, folderName);
}

/**
 * Command: "Добавить в расширение"
 * Borrows a main-config object into the selected extension.
 */
export async function borrowObjectToExtension(sourceNode: TreeNode, state: ExtensionState): Promise<void> {
  const provider = state.treeDataProvider;
  if (!provider) {
    vscode.window.showWarningMessage('Дерево метаданных не загружено.');
    return;
  }

  // 1. Find extension roots
  const extensions = findExtensionRootNodes(state);
  if (extensions.length === 0) {
    vscode.window.showWarningMessage('В workspace не найдено расширений. Добавьте папку расширения в рабочую область.');
    return;
  }

  // 2. QuickPick: select target extension
  const items = extensions.map((ext) => ({
    label: ext.name,
    description: String(ext.properties.extensionPurpose ?? ''),
    extension: ext,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Выберите расширение для добавления объекта',
    matchOnDescription: true,
  });
  if (!picked) {
    return;
  }
  const targetExtension = picked.extension;

  // 3. Verify not already borrowed
  if (isAlreadyBorrowed(targetExtension, sourceNode.type, sourceNode.name)) {
    vscode.window.showWarningMessage(
      `Объект «${sourceNode.name}» уже присутствует в расширении «${targetExtension.name}».`
    );
    return;
  }

  // 4. Read UUID of the source object
  const sourceXmlPath = sourceNode.filePath;
  if (!sourceXmlPath) {
    vscode.window.showErrorMessage(`Не удалось определить путь к XML-файлу объекта «${sourceNode.name}».`);
    return;
  }
  const sourceUuid = await readObjectUuid(sourceXmlPath);
  if (!sourceUuid) {
    vscode.window.showErrorMessage(
      `Не удалось прочитать UUID объекта «${sourceNode.name}» из файла ${sourceXmlPath}.`
    );
    return;
  }

  // 5. Resolve extension root directory
  const extensionRootDir = targetExtension.filePath;
  if (!extensionRootDir) {
    vscode.window.showErrorMessage(`Не удалось определить путь к расширению «${targetExtension.name}».`);
    return;
  }

  // 6. Resolve type folder path
  const typeFolderNode = findTypeFolderInExtension(targetExtension, sourceNode.type);
  const typeFolderPath = resolveTypeFolderPath(extensionRootDir, typeFolderNode, sourceNode.type);

  // 7. Create type folder if needed
  await fs.promises.mkdir(typeFolderPath, { recursive: true });

  // 8. Write borrowed object XML
  const newUuid = generateSimpleUuid();
  const objectXmlPath = path.join(typeFolderPath, `${sourceNode.name}.xml`);
  if (fs.existsSync(objectXmlPath)) {
    vscode.window.showErrorMessage(
      `Файл уже существует: ${objectXmlPath}. Объект возможно уже заимствован вне дерева.`
    );
    return;
  }

  const xmlContent = buildBorrowedObjectXml(String(sourceNode.type), newUuid, sourceNode.name, sourceUuid);
  try {
    await fs.promises.writeFile(objectXmlPath, xmlContent, 'utf-8');
  } catch (err) {
    vscode.window.showErrorMessage(
      `Не удалось создать файл объекта: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  // 9. Add to Configuration.xml of extension
  try {
    await addRootObjectToConfiguration(extensionRootDir, String(sourceNode.type), sourceNode.name);
  } catch (err) {
    Logger.error('borrowObjectToExtension: failed to update Configuration.xml', err);
    vscode.window.showErrorMessage(
      `Объект создан, но не удалось обновить Configuration.xml расширения: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  // 10. Also create object subdirectory (Designer convention)
  const objectDir = path.join(typeFolderPath, sourceNode.name);
  await fs.promises.mkdir(objectDir, { recursive: true });

  // 11. Refresh tree
  provider.refresh();

  vscode.window.showInformationMessage(
    `Объект «${sourceNode.name}» добавлен в расширение «${targetExtension.name}».`
  );
}

// Re-export for use in extension commands
export { CONFIGURATION_XML };
