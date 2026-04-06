import * as vscode from 'vscode';
import * as path from 'path';
import { TreeNode, MetadataType } from '../models/treeNode';
import { getFormPaths } from '../formEditor/formPaths';
import { CONFIGURATION_XML } from '../constants/fileNames';
import type { ConfigurationBindingDecoration } from '../bindings/bindingDecorationTypes';
import { getIconForType } from './treeIconMapper';
import { Logger } from '../utils/logger';

export interface TreeItemBuildOptions {
  /** Whether this node has (or may have) children. */
  hasChildren: boolean;
  /** Binding decoration for Configuration / Extension nodes. */
  bindingDeco: ConfigurationBindingDecoration | undefined;
  /** Whether the node is an extension that has its own Configuration.xml (infobase binding root). */
  isExtensionInfobaseBindingRoot: boolean;
  /** Active search query (raw). */
  rawSearchQuery: string;
  /** Whether the search query is a regex. */
  isRegex: boolean;
  /** Whether the node matches the current search. */
  nodeMatchesSearch: boolean;
  /** Config directory path for the node (used for resourceUri on Configuration nodes). */
  configDirPath: string | null;
}

/**
 * Returns the path string for tooltip: filePath if set, otherwise parent chain
 * (e.g. "Configuration / Catalogs / MyCatalog").
 */
export function getPathForTooltip(element: TreeNode): string {
  if (element.filePath) { return element.filePath; }
  const parts: string[] = [];
  let p: TreeNode | undefined = element.parent;
  while (p) {
    parts.unshift(p.name);
    p = p.parent;
  }
  return parts.length > 0 ? parts.join(' / ') : '';
}

/**
 * Builds a vscode.TreeItem for the given TreeNode using the provided options.
 * Pure function — no side effects, no access to provider state.
 */
export function buildTreeItem(element: TreeNode, options: TreeItemBuildOptions): vscode.TreeItem {
  try {
    const collapsibleState = options.hasChildren
      ? element.isExpanded
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;

    const treeItem = new vscode.TreeItem(element.name, collapsibleState);

    // Set context value for context menu (Forms folder vs concrete Form node vs BSL module leaf)
    const props = element.properties as Record<string, unknown> | undefined;
    if (element.type === MetadataType.Method && props?.fileType === 'bsl') {
      treeItem.contextValue = 'MethodBsl';
    } else {
      treeItem.contextValue = element.id === 'Forms' ? 'Forms' : element.type;
    }

    // Extension: append '.Adopted' suffix to contextValue for borrowed objects
    if (props?.objectBelonging === 'Adopted') {
      treeItem.contextValue = `${treeItem.contextValue}.Adopted`;
    }

    const { bindingDeco, isExtensionInfobaseBindingRoot } = options;

    // WOW §2D: контекст для «Раскатать в базу/базы» (viewItem when в package.json).
    if (element.type === MetadataType.Configuration) {
      let cv = 'Configuration';
      if (bindingDeco && bindingDeco.boundCount > 0) {
        cv += ' bindingBound';
        // Дизайн §12.5: подпись/иконка от флага массовой раскатки, не от числа баз в списке.
        const many = bindingDeco.massDeployment === true;
        cv += many ? ' deployMany' : ' deployOne';
      }
      treeItem.contextValue = cv;
    } else if (isExtensionInfobaseBindingRoot) {
      let cv = 'Extension extensionBindingRoot';
      if (bindingDeco && bindingDeco.boundCount > 0) {
        cv += ' bindingBound';
        const many = bindingDeco.massDeployment === true;
        cv += many ? ' deployMany' : ' deployOne';
      }
      treeItem.contextValue = cv;
    }

    // Set tooltip: name, type, path (additional_req.md п.14)
    const synonym = element.properties.synonym as string | undefined;
    let tooltipText =
      synonym ? `${element.type}: ${element.name}\nСиноним: ${synonym}` : `${element.type}: ${element.name}`;
    const pathStr = getPathForTooltip(element);
    if (pathStr) { tooltipText += `\n${pathStr}`; }
    // Highlight match in tooltip when search is active (additional_req.md п.2)
    const q = options.rawSearchQuery.trim();
    if (q && !options.isRegex && options.nodeMatchesSearch) {
      tooltipText += `\nНайдено: "${q}"`;
    }
    if (element.type === MetadataType.Configuration) {
      if (bindingDeco && bindingDeco.boundCount > 0) {
        const mass = bindingDeco.massDeployment ? '\nМассовая раскатка: да' : '';
        tooltipText += `\n\nПривязка ИБ: ${bindingDeco.boundCount} баз(ы).${mass}\n${bindingDeco.namesPreview}`;
      } else {
        tooltipText +=
          '\n\nПривязка ИБ: не настроена. Контекстное меню узла → «Привязать базы…».';
      }
    } else if (isExtensionInfobaseBindingRoot) {
      if (bindingDeco && bindingDeco.boundCount > 0) {
        const mass = bindingDeco.massDeployment ? '\nМассовая раскатка: да' : '';
        tooltipText += `\n\nПривязка ИБ (расширение): ${bindingDeco.boundCount} баз(ы).${mass}\n${bindingDeco.namesPreview}`;
      } else {
        tooltipText += '\n\nПривязка ИБ расширения: не настроена. Контекстное меню → «Привязать базы…».';
      }
    }
    treeItem.tooltip = tooltipText;

    // Set description (shown next to the label); для Configuration — бейдж числа привязок (§2C)
    const descParts: string[] = [];
    if (synonym) {
      descParts.push(synonym);
    }
    if (
      (element.type === MetadataType.Configuration || isExtensionInfobaseBindingRoot) &&
      bindingDeco &&
      bindingDeco.boundCount > 0
    ) {
      descParts.push(`🔗${bindingDeco.boundCount}`);
    }

    // Extension decorations
    if (props?.objectBelonging === 'Adopted') {
      // Borrowed (adopted) object from base configuration
      descParts.push('(заимствованный)');
    } else if (props?.extensionPurpose) {
      // Extension root node: show purpose and prefix
      const purpose = props.extensionPurpose as string;
      const prefix = props.namePrefix as string | undefined;
      const extDesc = prefix ? `(${purpose}, ${prefix})` : `(${purpose})`;
      descParts.push(extDesc);
    }

    if (descParts.length > 0) {
      treeItem.description = descParts.join(' · ');
    }

    // Set icon based on metadata type
    treeItem.iconPath = getIconForType(element.type);

    // BSL module nodes: open module on click (creates file if virtual)
    if (element.type === MetadataType.Method && props?.fileType === 'bsl') {
      treeItem.command = {
        command: '1c-metadata-tree.openBslModule',
        title: 'Open BSL Module',
        arguments: [element],
      };
    }
    // Other nodes: selection triggers properties panel (no command)

    // Set resource URI: Configuration → Configuration.xml in configDir; Form → formXmlPath; else filePath
    if (element.type === MetadataType.Configuration) {
      if (options.configDirPath != null) {
        treeItem.resourceUri = vscode.Uri.file(path.join(options.configDirPath, CONFIGURATION_XML));
      }
    } else if (isExtensionInfobaseBindingRoot && element.filePath?.trim()) {
      treeItem.resourceUri = vscode.Uri.file(path.join(element.filePath.trim(), CONFIGURATION_XML));
    } else if (element.filePath) {
      if (element.type === MetadataType.Form) {
        const { formXmlPath } = getFormPaths(element.filePath);
        treeItem.resourceUri = vscode.Uri.file(formXmlPath);
      } else {
        treeItem.resourceUri = vscode.Uri.file(element.filePath);
      }
    }

    return treeItem;
  } catch (error) {
    Logger.error('Error creating tree item', error);
    // Return minimal tree item on error
    return new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
  }
}
