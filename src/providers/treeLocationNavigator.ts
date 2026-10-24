import * as path from 'path';
import { TreeNode, MetadataType } from '../models/treeNode';
import { getStandardModuleFileName, type StandardModuleKind } from '../constants/metadataModuleDescriptors';
import { isSamePath } from '../utils/configurationPathIdentity';
import type { MetadataLocation } from '../services/metadataFileLocator';
import type { TreeLoadContext } from '../types/treeLoadContext';

export interface TreeLocationNavigatorPorts {
  getRoots(): readonly TreeNode[];
  getLoadContext(root: TreeNode): TreeLoadContext | undefined;
  getChildren(node: TreeNode): Thenable<TreeNode[]>;
  hasActiveFilter(): boolean;
  findTypeFolder(root: TreeNode, folderId: string): TreeNode | undefined;
}

/** Resolves a metadata location against the currently published tree and its lazy children. */
export class TreeLocationNavigator {
  constructor(private readonly ports: TreeLocationNavigatorPorts) {}

  async findNodeByLocation(loc: MetadataLocation): Promise<TreeNode | null> {
    const configRootNode = await this.findConfigRootByPath(loc.configRoot);
    if (!configRootNode) {
      return null;
    }

    let searchRoot = configRootNode;
    if (loc.extensionName) {
      const extensionRoot = await this.findExtensionRootByName(loc.configRoot, loc.extensionName);
      if (extensionRoot === null) {
        return null;
      }
      searchRoot = extensionRoot;
    }

    const typeFolderNode = this.ports.findTypeFolder(searchRoot, loc.objectType);
    if (!typeFolderNode) {
      return null;
    }

    const objectNode = loc.objectType === 'Subsystems' && loc.hierarchy && loc.hierarchy.length > 0
      ? await this.walkSubsystemHierarchy(typeFolderNode, loc.hierarchy)
      : await this.findChildByName(typeFolderNode, loc.objectName);
    if (!objectNode) {
      return null;
    }
    if (!loc.subPath) {
      return objectNode;
    }
    return this.walkSubPath(objectNode, loc.subPath);
  }

  private async findConfigRootByPath(configRoot: string): Promise<TreeNode | null> {
    const normalizedTarget = path.resolve(configRoot);
    for (const root of this.ports.getRoots()) {
      const context = this.ports.getLoadContext(root);
      if (context) {
        if (isSamePath(context.configPath, normalizedTarget)) {
          return root;
        }
      } else if (root.filePath) {
        const rootDir = path.resolve(path.dirname(root.filePath));
        if (isSamePath(rootDir, normalizedTarget)) {
          return root;
        }
      }
    }
    return null;
  }

  private async findExtensionRootByName(
    mainConfigRoot: string,
    extensionName: string,
  ): Promise<TreeNode | null> {
    const expectedPath = path.resolve(mainConfigRoot, 'ConfigurationExtensions', extensionName);
    for (const root of this.ports.getRoots()) {
      if (root.properties.extensionPurpose === undefined) {
        continue;
      }
      const context = this.ports.getLoadContext(root);
      if (context && isSamePath(context.configPath, expectedPath)) {
        return root;
      }
    }
    return null;
  }

  private async findChildByName(parent: TreeNode, targetName: string): Promise<TreeNode | null> {
    const children = await this.ports.getChildren(parent);
    const found = children.find((child) => child.name === targetName);
    if (found) {
      return found;
    }
    if (this.ports.hasActiveFilter()) {
      return null;
    }
    const raw = parent.children ?? [];
    return raw.find((child) => child.name === targetName) ?? null;
  }

  private async findChildById(parent: TreeNode, targetId: string): Promise<TreeNode | null> {
    const children = await this.ports.getChildren(parent);
    const found = children.find((child) => child.id === targetId);
    if (found) {
      return found;
    }
    if (this.ports.hasActiveFilter()) {
      return null;
    }
    const raw = parent.children ?? [];
    return raw.find((child) => child.id === targetId) ?? null;
  }

  private async walkSubsystemHierarchy(
    subsystemsFolderNode: TreeNode,
    hierarchy: string[],
  ): Promise<TreeNode | null> {
    let current: TreeNode = subsystemsFolderNode;
    for (const name of hierarchy) {
      const children = await this.ports.getChildren(current);
      let found = children.find((child) => child.name === name && child.type === MetadataType.Subsystem);
      if (!found) {
        found = (current.children ?? []).find(
          (child) => child.name === name && child.type === MetadataType.Subsystem,
        );
      }
      if (!found) {
        return null;
      }
      current = found;
    }
    return current;
  }

  private async walkSubPath(
    objectNode: TreeNode,
    subPath: NonNullable<MetadataLocation['subPath']>,
  ): Promise<TreeNode | null> {
    switch (subPath.kind) {
      case 'commonModule':
        return objectNode;
      case 'objectModule':
        return this.findStandardModuleNode(objectNode, 'ObjectModule');
      case 'managerModule':
        return this.findStandardModuleNode(objectNode, 'ManagerModule');
      case 'recordSetModule':
        return this.findStandardModuleNode(objectNode, 'RecordSetModule');
      case 'valueManagerModule':
        return this.findStandardModuleNode(objectNode, 'ValueManagerModule');
      case 'form': {
        if (objectNode.type === MetadataType.CommonForm) {
          if (subPath.name !== objectNode.name) {
            return null;
          }
          if (subPath.subFile === 'xml' || subPath.subFile === 'container') {
            return objectNode;
          }
          return this.findModuleNode(objectNode, 'Module.bsl');
        }
        const formsFolder = await this.findChildById(objectNode, 'Forms');
        if (!formsFolder) {
          return null;
        }
        const children = await this.ports.getChildren(formsFolder);
        const allChildren = this.mergeChildren(children, formsFolder.children ?? []);
        const formNode = allChildren.find(
          (child) => child.name === subPath.name && child.type === MetadataType.Form,
        ) ?? null;
        if (!formNode) {
          return null;
        }
        if (subPath.subFile === 'xml' || subPath.subFile === 'container') {
          return formNode;
        }
        return this.findModuleNode(formNode, 'Module.bsl');
      }
      case 'command': {
        const commandsFolder = await this.findChildById(objectNode, 'Commands');
        if (!commandsFolder) {
          return null;
        }
        const commandChildren = await this.ports.getChildren(commandsFolder);
        const allCommandChildren = this.mergeChildren(commandChildren, commandsFolder.children ?? []);
        const commandNode = allCommandChildren.find(
          (child) => child.name === subPath.name && child.type === MetadataType.Command,
        ) ?? null;
        if (!commandNode) {
          return null;
        }
        if (subPath.subFile === 'xml') {
          return commandNode;
        }
        return this.findModuleNode(commandNode, 'CommandModule.bsl');
      }
      case 'template': {
        const templatesFolder = await this.findChildById(objectNode, 'Templates');
        if (!templatesFolder) {
          return null;
        }
        const templateChildren = await this.ports.getChildren(templatesFolder);
        const allTemplateChildren = this.mergeChildren(templateChildren, templatesFolder.children ?? []);
        return allTemplateChildren.find(
          (child) => child.name === subPath.name && child.type === MetadataType.Template,
        ) ?? null;
      }
      case 'rights':
        return objectNode;
      case 'predefinedData': {
        const children = await this.ports.getChildren(objectNode);
        const allChildren = this.mergeChildren(children, objectNode.children ?? []);
        return allChildren.find((child) => child.id === 'PredefinedData') ?? objectNode;
      }
      default:
        return objectNode;
    }
  }

  private async findModuleNode(objectNode: TreeNode, fileName: string): Promise<TreeNode | null> {
    const children = await this.ports.getChildren(objectNode);
    const allChildren = this.mergeChildren(children, objectNode.children ?? []);
    const extensionNode = allChildren.find(
      (child) => child.type === MetadataType.Extension && (child.id === 'Ext' || child.id.endsWith('.Ext')),
    );
    if (!extensionNode) {
      return null;
    }
    const extensionChildren = await this.ports.getChildren(extensionNode);
    const allExtensionChildren = this.mergeChildren(extensionChildren, extensionNode.children ?? []);
    return allExtensionChildren.find((child) => child.name === fileName) ?? null;
  }

  private async findStandardModuleNode(
    objectNode: TreeNode,
    kind: StandardModuleKind,
  ): Promise<TreeNode | null> {
    const fileName = getStandardModuleFileName(objectNode.type, kind);
    return fileName ? this.findModuleNode(objectNode, fileName) : null;
  }

  private mergeChildren(first: TreeNode[], second: TreeNode[]): TreeNode[] {
    if (first.length === 0) {return second;}
    if (second.length === 0) {return first;}
    const seen = new Set<TreeNode>(first);
    const extra = second.filter((node) => !seen.has(node));
    return extra.length === 0 ? first : [...first, ...extra];
  }
}
