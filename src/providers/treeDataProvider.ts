import * as fs from 'fs';
import * as vscode from 'vscode';
import * as path from 'path';
import { TreeNode, MetadataType } from '../models/treeNode';
import { Logger } from '../utils/logger';
import type { ReferenceableGroup } from '../types/typeDefinitions';
import { MetadataParser } from '../parsers/metadataParser';
import { ConfigFormat } from '../parsers/formatDetector';
import { MESSAGES } from '../constants/messages';
import { CONFIGURATION_XML } from '../constants/fileNames';
import {
  ensureR6PlaceholdersForInstanceNode,
  ensureTabularSectionColumnsPlaceholder,
  R5_COMMON_DISK_BACKED_FOLDER_IDS,
} from '../utils/treeNormalization';
import { OptimisticDeleteToken } from '../types/reloadContracts';
import { TOP_LEVEL_TYPES } from '../services/elementOperations';
import { validateSubsystemCompositionRef } from '../parsers/xmlChildObjects';
import { expectedTreeNodeIdForCompositionRef } from '../services/subsystemCompositionRefResolver';
import type { ConfigurationBindingDecoration } from '../bindings/bindingDecorationTypes';
import {
  bindingKey,
  detectIbcmdExtensionNameFromConfigRelativePath,
  normalizeConfigRelativePath,
} from '../bindings/bindingPathUtils';
import { MetadataTypeMapper } from '../utils/metadataTypeMapper';
import { TreeFilterService, FILTERABLE_METADATA_TYPES } from './treeFilterService';
import { TreeCacheService } from './treeCacheService';
import { buildTreeItem } from './treeItemBuilder';
import {
  getReferenceableObjects,
  getReferenceableObjectsForTypeEditor,
  getTypeEditorReferenceableScopeKey,
  countPendingReferenceableTypeLoads,
  cloneReferenceableGroups,
} from './treeReferenceLoader';
import { getObjectableObjectsForEditor, cloneObjectableGroups } from './objectTypeLoader';
import type { ObjectableGroup } from '../types/objectTypeDefinitions';
import type { MetadataLocation } from '../services/metadataFileLocator';

/** R6 placeholders under object XML — reload via loadElementChildren after mutations (see invalidateLoadedChildren). */
const R6_LAZY_SECTION_IDS = new Set(['Attributes', 'TabularSections', 'Forms', 'Commands', 'Templates', 'Dimensions', 'Resources', 'EnumValues', 'PredefinedData']);

/**
 * Tree Data Provider for VS Code Tree View
 */
export class MetadataTreeDataProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData: vscode.EventEmitter<TreeNode | undefined | null | void> =
    new vscode.EventEmitter<TreeNode | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<TreeNode | undefined | null | void> =
    this._onDidChangeTreeData.event;

  private rootNodes: TreeNode[] = [];

  private readonly filter = new TreeFilterService();
  private readonly cache = new TreeCacheService();
  /** Snapshot of referenceable names per scope for TypeEditor (invalidated with tree reload / structure). */
  private readonly typeEditorReferenceableCache = new Map<string, ReferenceableGroup[]>();
  /** Snapshot of objectable object groups per scope for ObjectTypeEditor (invalidated with tree reload / structure). */
  private readonly objectableObjectsCache = new Map<string, ObjectableGroup[]>();

  private messageUpdater: ((message: string | undefined) => void) | null = null;
  /** Ключ {@link bindingKey}(workspaceFolder, configRelativePath) → сводка для узла Configuration. */
  private configurationBindingDecorations = new Map<string, ConfigurationBindingDecoration>();

  constructor() {
    Logger.info('MetadataTreeDataProvider initialized');
  }

  setMessageUpdater(updater: (message: string | undefined) => void): void {
    this.messageUpdater = updater;
  }

  /**
   * Обновляет кэш привязок ИБ для бейджа/tooltip на узле Configuration (WOW §2C).
   */
  setConfigurationBindingDecorations(map: ReadonlyMap<string, ConfigurationBindingDecoration>): void {
    this.configurationBindingDecorations = new Map(map);
  }

  private lookupConfigurationBindingDecorationForRoot(root: TreeNode): ConfigurationBindingDecoration | undefined {
    if (root.type === MetadataType.Configuration) {
      const configDir = this.getConfigPathForNode(root);
      if (!configDir) {
        return undefined;
      }
      const configXmlFs = path.join(configDir, CONFIGURATION_XML);
      const uri = vscode.Uri.file(configXmlFs);
      const wf = vscode.workspace.getWorkspaceFolder(uri);
      if (!wf) {
        return undefined;
      }
      const rel = path.relative(wf.uri.fsPath, configXmlFs).replace(/\\/g, '/');
      const norm = normalizeConfigRelativePath(rel);
      const ext = detectIbcmdExtensionNameFromConfigRelativePath(norm);
      const key = bindingKey(wf.name, norm, ext);
      return this.configurationBindingDecorations.get(key);
    }
    if (root.type === MetadataType.Extension) {
      const props = root.properties as Record<string, unknown> | undefined;
      if (props?.isExtension !== true || !root.filePath?.trim()) {
        return undefined;
      }
      const configXmlFs = path.join(root.filePath.trim(), CONFIGURATION_XML);
      try {
        if (!fs.existsSync(configXmlFs)) {
          return undefined;
        }
      } catch {
        return undefined;
      }
      const uri = vscode.Uri.file(configXmlFs);
      const wf = vscode.workspace.getWorkspaceFolder(uri);
      if (!wf) {
        return undefined;
      }
      const rel = path.relative(wf.uri.fsPath, configXmlFs).replace(/\\/g, '/');
      const norm = normalizeConfigRelativePath(rel);
      const ext = detectIbcmdExtensionNameFromConfigRelativePath(norm);
      const key = bindingKey(wf.name, norm, ext);
      return this.configurationBindingDecorations.get(key);
    }
    return undefined;
  }

  private lookupConfigurationBindingDecoration(element: TreeNode): ConfigurationBindingDecoration | undefined {
    if (element.type === MetadataType.Configuration || this.isExtensionInfobaseBindingRoot(element)) {
      return this.lookupConfigurationBindingDecorationForRoot(element);
    }
    // For child nodes: walk up to find the config/extension root and reuse its decoration.
    const configRoot = this.cache.getConfigurationRoot(element);
    if (configRoot) {
      return this.lookupConfigurationBindingDecorationForRoot(configRoot);
    }
    // Walk parent chain to find Extension infobase binding root.
    let n: TreeNode | undefined = element.parent;
    while (n) {
      if (this.isExtensionInfobaseBindingRoot(n)) {
        return this.lookupConfigurationBindingDecorationForRoot(n);
      }
      n = n.parent;
    }
    return undefined;
  }

  /** WOW Phase 4 #64 — папка выгрузки расширения с отдельным Configuration.xml. */
  private isExtensionInfobaseBindingRoot(element: TreeNode): boolean {
    if (element.type !== MetadataType.Extension) {
      return false;
    }
    const props = element.properties as Record<string, unknown> | undefined;
    if (props?.isExtension !== true) {
      return false;
    }
    const dir = element.filePath?.trim();
    if (!dir) {
      return false;
    }
    try {
      return fs.existsSync(path.join(dir, CONFIGURATION_XML));
    } catch {
      return false;
    }
  }

  private updateFilterMessage(): void {
    if (!this.messageUpdater) {return;}
    const parts = this.filter.buildFilterMessageParts();
    this.messageUpdater(parts.length > 0 ? parts.join(' · ') : undefined);
  }

  // --- Search/filter state (public API) ---

  setSearchQuery(query: string): void {
    this.filter.setSearchQuery(query);
    this.updateFilterMessage();
    this.refresh();
  }

  getSearchQuery(): string {
    return this.filter.getSearchQuery();
  }

  setSearchOptions(options: { bySynonymComment?: boolean; useRegex?: boolean }): void {
    this.filter.setSearchOptions(options);
    this.refresh();
  }

  setTypeFilter(types: MetadataType[] | null): void {
    this.filter.setTypeFilter(types);
    this.updateFilterMessage();
    this.refresh();
  }

  getTypeFilter(): MetadataType[] | null {
    return this.filter.getTypeFilter();
  }

  /**
   * Set subsystem filter to show only nodes belonging to the specified subsystem.
   * @param subsystemId The ID of the subsystem node to filter by, or null to clear filter
   * @param subsystemName The display name of the subsystem, or null to clear filter
   */
  async setSubsystemFilter(subsystemId: string | null, subsystemName: string | null): Promise<void> {
    this.filter.setSubsystemFilter(subsystemId, subsystemName);

    if (subsystemId) {
      const subsystemNode = this.cache.findById(subsystemId);
      if (subsystemNode) {
        await this.loadSubsystemContent(subsystemNode);
        // Eagerly load all type-nodes referenced in subsystem Content so that
        // ensureFilterSets() can find them in nodeCache (lazy nodes are not yet loaded).
        await this.eagerLoadSubsystemTypes(subsystemNode);
      }
    }

    this.updateFilterMessage();
    this.refresh();
  }

  /**
   * Get current subsystem filter state.
   * @returns Object with subsystemId and subsystemName, or null values if no filter is active
   */
  getSubsystemFilter(): { subsystemId: string | null; subsystemName: string | null } {
    return this.filter.getSubsystemFilter();
  }

  /**
   * Subsystem filter contract (ADR 0001): a node passes if (1) no filter, or (2) node is the
   * selected subsystem or its ancestor, or (3) node is in the Content of the selected subsystem
   * or in the Content of any of its descendant subsystems (recursively). TreeDataProvider uses
   * path-based id for subsystems and loads Content from subsystemNode.filePath when present.
   */
  private async loadSubsystemContent(subsystemNode: TreeNode): Promise<void> {
    Logger.info('loadSubsystemContent called', {
      subsystemId: subsystemNode.id,
      hasContent: !!subsystemNode.properties.Content,
      isLazy: !!subsystemNode.properties._lazy,
      hasFilePath: !!subsystemNode.filePath,
      filePath: subsystemNode.filePath,
    });
    
    // If already loaded, skip
    if (subsystemNode.properties.Content) {
      Logger.info('Skipping load - already loaded');
      return;
    }

    // Get config path
    const configRoot = this.cache.getConfigurationRoot(subsystemNode);
    if (!configRoot) {
      Logger.info('No config root found');
      return;
    }

    const ctx = this.cache.getLoadContext(configRoot.id);
    if (!ctx) {
      Logger.info('No load context found');
      return;
    }

    const pathModule = await import('path');
    const xmlPath = subsystemNode.filePath
      ? pathModule.default.normalize(subsystemNode.filePath)
      : pathModule.default.join(ctx.configPath, 'Subsystems', `${subsystemNode.name}.xml`);
    
    Logger.info('Loading subsystem XML', { xmlPath });

    try {
      const xmlParserModule = await import('../parsers/xmlParser');
      const xmlContent = await xmlParserModule.XmlParser.parseFileAsync(xmlPath);
      const properties = this.extractPropertiesFromXml(xmlContent);
      
      subsystemNode.properties = { ...subsystemNode.properties, ...properties };
      delete subsystemNode.properties._lazy;
      
      Logger.info('Loaded subsystem properties', {
        subsystemId: subsystemNode.id,
        propertyKeys: Object.keys(subsystemNode.properties),
        hasContent: !!subsystemNode.properties.Content,
      });
    } catch (error) {
      Logger.error('Failed to load subsystem properties', error);
    }
  }

  /**
   * Eagerly load all type-nodes referenced in subsystem Content (selected + all descendants) into nodeCache.
   * Without this, lazy type-nodes (Documents, Reports, etc.) have no children in cache
   * and ensureFilterSets() cannot match any element nodes.
   */
  private async eagerLoadSubsystemTypes(subsystemNode: TreeNode): Promise<void> {
    const subsystemsToLoad = this.filter.collectSubsystemAndDescendants(subsystemNode);
    for (const sub of subsystemsToLoad) {
      await this.loadSubsystemContent(sub);
    }
    const refTypeToFolder = this.buildRefTypeToFolderMap();
    const foldersToLoad = new Set<string>();
    for (const sub of subsystemsToLoad) {
      const content = sub.properties.Content;
      if (!content || typeof content !== 'object') {continue;}
      const contentObj = content as Record<string, unknown>;
      const rawItems = contentObj['xr:Item'];
      const items: unknown[] = Array.isArray(rawItems) ? rawItems : (rawItems != null ? [rawItems] : []);
      for (const item of items) {
        if (typeof item === 'object' && item !== null) {
          const refText = (item as Record<string, unknown>)['#text'] as string;
          if (refText) {
            const refType = refText.split('.')[0];
            const folder = refTypeToFolder.get(refType);
            if (folder) {foldersToLoad.add(folder);}
          }
        }
      }
    }
    if (foldersToLoad.size === 0) {return;}

    // Find config root and load context
    const configRoot = this.cache.getConfigurationRoot(subsystemNode);
    if (!configRoot) {return;}
    const ctx = this.cache.getLoadContext(configRoot.id);
    if (!ctx) {return;}

    // For each folder, find the type-node in the tree and load its children if not yet loaded.
    // Process in small chunks to avoid blocking the event loop on large configurations.
    const CHUNK_SIZE = 5;
    const foldersArray = Array.from(foldersToLoad);
    for (let i = 0; i < foldersArray.length; i += CHUNK_SIZE) {
      const chunk = foldersArray.slice(i, i + CHUNK_SIZE);
      for (const folder of chunk) {
        const typeNode = this.findTypeFolderNode(configRoot, folder);
        if (!typeNode) {continue;}
        // Already loaded
        if (typeNode.children && typeNode.children.length > 0) {continue;}

        Logger.info('Eager loading type for subsystem filter', { folder });
        try {
          const children = await MetadataParser.parseTypeContents(ctx.configPath, folder);
          for (const c of children) {
            c.parent = typeNode;
            this.cache.buildCache(c);
          }
          typeNode.children = children;
        } catch (error) {
          Logger.warn('Failed to eager load type for subsystem filter', { folder, error });
        }
      }
      // Yield between chunks to avoid blocking the event loop
      if (i + CHUNK_SIZE < foldersArray.length) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
  }

  /**
   * Build a map from XML ref type name (singular) to folder name (plural).
   * Derived from MetadataTypeMapper: the MetadataType enum values equal the singular XML ref type
   * names used in subsystem Content (e.g. 'Document', 'Catalog'), and the folder names are the
   * plural Designer directory names (e.g. 'Documents', 'Catalogs').
   */
  private buildRefTypeToFolderMap(): Map<string, string> {
    const map = new Map<string, string>();
    for (const folderName of MetadataTypeMapper.getMetadataTypes()) {
      const metaType = MetadataTypeMapper.map(folderName);
      // MetadataType enum values are string literals matching the singular XML ref type names
      map.set(metaType as string, folderName);
    }
    return map;
  }

  private extractPropertiesFromXml(xmlContent: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    // Find Properties object at depth 1 or depth 2.
    // Subsystem XML has structure: MetaDataObject → Subsystem → Properties
    // Other XMLs may have: RootElement → Properties
    const findProperties = (element: Record<string, unknown>): Record<string, unknown> | null => {
      if (element.Properties && typeof element.Properties === 'object' && !Array.isArray(element.Properties)) {
        return element.Properties as Record<string, unknown>;
      }
      // One level deeper (e.g. MetaDataObject.Subsystem.Properties)
      for (const val of Object.values(element)) {
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          const nested = val as Record<string, unknown>;
          if (nested.Properties && typeof nested.Properties === 'object' && !Array.isArray(nested.Properties)) {
            return nested.Properties as Record<string, unknown>;
          }
        }
      }
      return null;
    };

    for (const [key, value] of Object.entries(xmlContent)) {
      if (key === '@_' || key.startsWith('#')) {continue;}

      if (typeof value === 'object' && value !== null) {
        const element = value as Record<string, unknown>;
        const properties = findProperties(element);

        if (properties) {
          for (const [propKey, propValue] of Object.entries(properties)) {
            if (propKey === '@_' || propKey.startsWith('#')) {continue;}

            if (typeof propValue === 'boolean' || typeof propValue === 'number' || typeof propValue === 'string') {
              result[propKey] = propValue;
            } else if (typeof propValue === 'object' && propValue !== null) {
              const obj = propValue as Record<string, unknown>;
              if (obj['v8:item']) {
                const items = obj['v8:item'];
                if (Array.isArray(items) && items.length > 0) {
                  const firstItem = items[0];
                  if (firstItem && typeof firstItem === 'object' && 'v8:content' in firstItem) {
                    result[propKey] = (firstItem as Record<string, unknown>)['v8:content'];
                  }
                }
              } else if ('v8:Type' in obj) {
                result[propKey] = obj;
              } else if (obj['xr:Item']) {
                // Handle Content field with xr:Item array
                result[propKey] = obj;
              } else if (obj.item) {
                result[propKey] = obj.item;
              } else {
                result[propKey] = propValue;
              }
            } else {
              result[propKey] = propValue;
            }
          }
        }
      }
    }
    return result;
  }

  /**
   * Get the subsystem filter label for display in the UI.
   * @returns The filter label string, or null if no filter is active
   */
  getSubsystemFilterLabel(): string | null {
    return this.filter.getSubsystemFilterLabel();
  }

  clearSearch(): void {
    this.filter.clearAll();
    this.updateFilterMessage();
    this.refresh();
  }

  addSearchToHistory(query: string): void {
    this.filter.addSearchToHistory(query);
  }

  getSearchHistory(): string[] {
    return this.filter.getSearchHistory();
  }

  /** Human-readable labels for filterable types. */
  static getFilterableTypeLabels(): { type: MetadataType; label: string }[] {
    return TreeFilterService.getFilterableTypeLabels();
  }

  /** Visible nodes in depth-first order (for next/previous match navigation). */
  getVisibleNodesInOrder(): TreeNode[] {
    const ids = this.getVisibleOrderedNodeIds();
    return ids
      .map((id) => this.cache.findById(id))
      .filter((n): n is TreeNode => n != null);
  }

  /**
   * Set single root node and refresh tree (backward compat).
   * @param loadContext When provided, type nodes load their children on first expand (lazy loading).
   */
  setRootNode(node: TreeNode, loadContext?: { configPath: string; format: ConfigFormat }): void {
    if (!node) {
      Logger.error('Cannot set null or undefined root node');
      return;
    }
    this.rootNodes = [node];
    this.cache.clearLoadContexts();
    if (loadContext) {this.cache.setLoadContext(node.id, loadContext);}
    this.cache.clear();
    this.cache.buildCache(node);
    this.clearTypeEditorReferenceableCache();
    Logger.info('Tree cache size', { nodeCount: this.cache.size });
    this.filter.filterAncestorOrVisibleIds = null;
    this.refresh();
    if (this.messageUpdater && !this.filter.hasActiveFilter()) {
      this.messageUpdater(undefined);
    }
  }

  /**
   * Set multiple root nodes (one per configuration) and per-root load context.
   */
  setRootNodes(
    nodes: TreeNode[],
    loadContextMap?: Map<string, { configPath: string; format: ConfigFormat }>
  ): void {
    this.rootNodes = nodes;
    this.cache.setLoadContexts(loadContextMap ?? new Map());
    this.cache.clear();
    for (const node of nodes) {this.cache.buildCache(node);}
    this.clearTypeEditorReferenceableCache();
    Logger.info('Tree cache size', { nodeCount: this.cache.size, roots: nodes.length });
    this.filter.filterAncestorOrVisibleIds = null;
    this.refresh();
    if (this.messageUpdater) {
      if (this.rootNodes.length === 0) {
        this.messageUpdater(MESSAGES.EMPTY_TREE_MESSAGE);
      } else if (!this.filter.hasActiveFilter()) {
        this.messageUpdater(undefined);
      }
    }
  }

  /**
   * Get first root node (for backward compat when single root).
   */
  getRootNode(): TreeNode | null {
    return this.rootNodes.length > 0 ? this.rootNodes[0] : null;
  }

  /**
   * Get all root nodes (one per configuration in workspace).
   */
  getRootNodes(): readonly TreeNode[] {
    return this.rootNodes;
  }

  /**
   * Eagerly load children for all lazy type-folder nodes under a configuration root.
   * Used by composition editor to see all objects before lazy expand.
   */
  async eagerLoadAllTypeFolders(configRoot: TreeNode): Promise<void> {
    const ctx = this.cache.getLoadContext(configRoot.id);
    if (!ctx) { return; }

    if (!configRoot.children) { return; }

    for (const typeFolder of configRoot.children) {
      // Already loaded
      if (typeFolder.children && typeFolder.children.length > 0) { continue; }
      // Skip non-lazy nodes (e.g. already empty or not a type folder)
      if (!this.isLazyTypeNode(typeFolder)) { continue; }

      try {
        const children = await MetadataParser.parseTypeContents(ctx.configPath, typeFolder.id);
        for (const c of children) {
          c.parent = typeFolder;
          this.cache.buildCache(c);
        }
        typeFolder.children = children;
      } catch (error) {
        Logger.warn('Failed to eager load type folder', { folder: typeFolder.id, error });
      }
    }
    this.clearTypeEditorReferenceableCache();
  }

  /**
   * Get configuration root path for the tree (first root's context; backward compat).
   */
  getConfigPath(): string | null {
    const first = this.rootNodes[0];
    if (!first) {return null;}
    return this.cache.getLoadContext(first.id)?.configPath ?? first.filePath ?? null;
  }

  /**
   * Get configuration root paths for all loaded roots (multi-root workspace support).
   * Used by revealActiveFileInTree command to locate a file across all configurations.
   */
  getConfigRootPaths(): string[] {
    return this.rootNodes
      .map((root) => this.cache.getLoadContext(root.id)?.configPath ?? root.filePath ?? null)
      .filter((p): p is string => p != null);
  }

  /**
   * Get configuration root path for a node (walk up to Configuration node, return its directory path).
   */
  getConfigPathForNode(node: TreeNode): string | null {
    let n: TreeNode | undefined = node;
    while (n) {
      if (n.type === MetadataType.Configuration && n.filePath) {return path.dirname(n.filePath);}
      n = n.parent;
    }
    return null;
  }

  /**
   * Search nodes by name (substring, case-insensitive). Uses name index for speed.
   * Returns only nodes currently in cache (loaded so far).
   */
  searchByName(query: string): TreeNode[] {
    return this.cache.searchByName(query);
  }

  /**
   * Refresh tree view
   */
  refresh(element?: TreeNode): void {
    Logger.debug('Refreshing tree view', element ? element.name : 'root');
    this._onDidChangeTreeData.fire(element);
  }

  /**
   * Drop cached children so the next {@link getChildren} reloads from disk/XML.
   * Call after create/delete that change files under this container (matrix, tests).
   */
  invalidateLoadedChildren(element: TreeNode): void {
    const el = this.cache.resolveActiveNode(element, this.rootNodes);
    if (!el.properties) {
      el.properties = {};
    }
    el.children = [];
    if (R6_LAZY_SECTION_IDS.has(el.id) || el.type === MetadataType.Subsystem) {
      (el.properties as Record<string, unknown>)._lazy = true;
    } else if (
      TOP_LEVEL_TYPES.has(el.type) &&
      el.id.includes('.') &&
      el.type !== MetadataType.Form
    ) {
      // Instance XML (e.g. Roles.Имя, CommonModules.X): after create/delete under this node,
      // children must reload from disk like first expand — same as shallow parseMetadataElement.
      (el.properties as Record<string, unknown>)._lazy = true;
    }
    this.filter.filterAncestorOrVisibleIds = null;
    this.clearTypeEditorReferenceableCache();
    this.refresh(el);
  }

  /** Type folder under `Configuration` or under «Общие» (`Common`) after tree normalization. */
  private findTypeFolderNode(configRoot: TreeNode, folderId: string): TreeNode | undefined {
    const direct = configRoot.children?.find((c) => c.id === folderId);
    if (direct) {
      return direct;
    }
    const commonGroup = configRoot.children?.find((c) => c.id === 'Common');
    return commonGroup?.children?.find((c) => c.id === folderId);
  }

  private getConfigRootIdentity(root: TreeNode | null): string {
    if (!root) {return '';}
    const fromLoadContext = this.cache.getLoadContext(root.id)?.configPath;
    if (fromLoadContext) {return fromLoadContext.replace(/\\/g, '/').toLowerCase();}
    if (root.filePath) {return path.dirname(root.filePath).replace(/\\/g, '/').toLowerCase();}
    return root.id.replace(/\\/g, '/').toLowerCase();
  }

  private getNodeRootIdentity(node: TreeNode): string {
    return this.getConfigRootIdentity(this.cache.getConfigurationRoot(node));
  }

  private isLazyTypeNode(element: TreeNode): boolean {
    if (element.children && element.children.length > 0) {
      return false;
    }
    const configRoot = this.cache.getConfigurationRoot(element);
    if (!configRoot || !this.cache.getLoadContext(configRoot.id)) {
      return false;
    }
    const p = element.parent;
    if (!p) {
      return false;
    }
    if (p === configRoot) {
      return true;
    }
    if (p.type === MetadataType.Unknown && p.id === 'Common') {
      return R5_COMMON_DISK_BACKED_FOLDER_IDS.has(element.id);
    }
    return false;
  }

  private isLazyElementNode(element: TreeNode): boolean {
    const configRoot = this.cache.getConfigurationRoot(element);
    if (!configRoot || !this.cache.getLoadContext(configRoot.id) || element.properties._lazy !== true) {
      return false;
    }
    if (!element.children || element.children.length === 0) {return true;}
    if (element.type === MetadataType.Subsystem) {
      const hasNonSubsystem = element.children.some((c) => c.type !== MetadataType.Subsystem);
      return !hasNonSubsystem;
    }
    return false;
  }

  /**
   * Parsers may leave a tabular section instance with no children when there are no columns yet.
   * Without the synthetic «Реквизиты» node the item is a leaf and the user cannot add the first column.
   * {@link MetadataParser.loadElementChildren} already fixes this for `_lazy` sections; mirror here for eager nodes.
   */
  private ensureTabularSectionColumnsIfNeeded(node: TreeNode): void {
    if (
      node.parent?.id !== 'TabularSections' ||
      node.type !== MetadataType.TabularSection ||
      !node.id.startsWith('TabularSections.') ||
      node.id === 'TabularSections'
    ) {
      return;
    }
    ensureTabularSectionColumnsPlaceholder(node);
    for (const c of node.children ?? []) {
      if (!this.cache.findById(c.id)) {
        this.cache.buildCache(c);
      }
    }
  }

  /** Instance of a tabular section (under folder «Табличные части») always has at least the «Реквизиты» subtree in the UI. */
  private isTabularSectionInstanceNode(element: TreeNode): boolean {
    return (
      element.parent?.id === 'TabularSections' &&
      element.type === MetadataType.TabularSection &&
      element.id.startsWith('TabularSections.') &&
      element.id !== 'TabularSections'
    );
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    const hasChildren =
      (element.children && element.children.length > 0) ||
      this.isLazyTypeNode(element) ||
      this.isLazyElementNode(element) ||
      this.isTabularSectionInstanceNode(element);

    const bindingDeco = this.lookupConfigurationBindingDecoration(element);
    const isExtBindingRoot = this.isExtensionInfobaseBindingRoot(element);
    const q = this.filter.rawSearchQuery.trim();

    return buildTreeItem(element, {
      hasChildren,
      bindingDeco,
      isExtensionInfobaseBindingRoot: isExtBindingRoot,
      rawSearchQuery: q,
      isRegex: this.filter.isRegex,
      nodeMatchesSearch: !!(q && this.filter.nodeMatchesSearch(element, q)),
      configDirPath: element.type === MetadataType.Configuration ? this.getConfigPathForNode(element) : null,
    });
  }

  /**
   * Get children for a node (lazy loading). When search/type filter is active, returns only children that match or contain matches.
   * For lazy type nodes (structure-only load), loads type contents on first expand.
   */
  getChildren(element?: TreeNode): Thenable<TreeNode[]> {
    try {
      if (!element) {
        if (this.rootNodes.length === 0) {return Promise.resolve([]);}
        if (!this.filter.hasActiveFilter()) {return Promise.resolve(this.rootNodes);}
        this.filter.ensureFilterSets(this.cache.nodes);
        const ids = this.filter.filterAncestorOrVisibleIds!;
        return Promise.resolve(this.rootNodes.filter((r) => ids.has(r.id)));
      }
      const activeElement = this.cache.resolveActiveNode(element, this.rootNodes);

      // Lazy load: type node with no children yet
      if (this.isLazyTypeNode(activeElement)) {
        const configRoot = this.cache.getConfigurationRoot(activeElement);
        const ctx = configRoot ? this.cache.getLoadContext(configRoot.id) : undefined;
        if (!ctx) {return Promise.resolve([]);}
        return MetadataParser.parseTypeContents(ctx.configPath, activeElement.id).then((children) => {
          for (const c of children) {
            c.parent = activeElement;
            this.cache.buildCache(c);
          }
          activeElement.children = children;
          for (const c of children) {
            ensureR6PlaceholdersForInstanceNode(c, { configPath: ctx.configPath, format: ctx.format });
          }
          Logger.info('Tree cache size after lazy load', {
            type: activeElement.id,
            nodeCount: this.cache.size,
          });
          this.filter.filterAncestorOrVisibleIds = null;
          this.refresh(activeElement);
          if (!this.filter.hasActiveFilter()) {return children;}
          this.filter.ensureFilterSets(this.cache.nodes);
          const ids = this.filter.filterAncestorOrVisibleIds!;
          return children.filter((c) => ids.has(c.id));
        });
      }

      // Lazy load: element node with _lazy and no children yet (Attributes, Forms, Ext, etc.)
      if (this.isLazyElementNode(activeElement)) {
        const configRoot = this.cache.getConfigurationRoot(activeElement);
        const ctx = configRoot ? this.cache.getLoadContext(configRoot.id) : undefined;
        if (!ctx) {return Promise.resolve([]);}
        const format = ctx.format;
        if (format == null) {
          return Promise.resolve([]);
        }
        return MetadataParser.loadElementChildren(ctx.configPath, format, activeElement).then(
          (loaded) => {
            const existingSubsystems = (activeElement.children ?? []).filter(
              (c) => c.type === MetadataType.Subsystem
            );
            const children = existingSubsystems.length > 0 ? [...existingSubsystems, ...loaded] : loaded;
            for (const c of loaded) {
              c.parent = activeElement;
              this.cache.buildCache(c);
            }
            if (activeElement.type === MetadataType.Subsystem && activeElement.filePath) {
              const ciPath = path.join(path.dirname(activeElement.filePath), 'Ext', 'CommandInterface.xml');
              if (fs.existsSync(ciPath)) {
                const ciNode: TreeNode = {
                  id: `${activeElement.id}.CommandInterface`,
                  name: 'Командный интерфейс',
                  type: MetadataType.Unknown,
                  parent: activeElement,
                  properties: { isVirtual: true },
                  filePath: ciPath,
                };
                children.push(ciNode);
                this.cache.buildCache(ciNode);
              }
            }
            activeElement.children = children;
            delete activeElement.properties._lazy;
            Logger.info('Tree cache size after lazy element load', {
              element: activeElement.id,
              nodeCount: this.cache.size,
            });
            this.filter.filterAncestorOrVisibleIds = null;
            this.refresh(activeElement);
            if (!this.filter.hasActiveFilter()) {return children;}
            this.filter.ensureFilterSets(this.cache.nodes);
            const ids = this.filter.filterAncestorOrVisibleIds!;
            return children.filter((c) => ids.has(c.id));
          }
        );
      }

      const configRoot = this.cache.getConfigurationRoot(activeElement);
      const ctx = configRoot ? this.cache.getLoadContext(configRoot.id) : undefined;
      if (ctx) {
        ensureR6PlaceholdersForInstanceNode(activeElement, { configPath: ctx.configPath, format: ctx.format });
      }

      this.ensureTabularSectionColumnsIfNeeded(activeElement);

      const raw = activeElement.children || [];
      if (!this.filter.hasActiveFilter()) {
        return Promise.resolve(raw);
      }

      this.filter.ensureFilterSets(this.cache.nodes);
      const ids = this.filter.filterAncestorOrVisibleIds!;
      const filtered = raw.filter((c) => ids.has(c.id));
      return Promise.resolve(filtered);
    } catch (error) {
      Logger.error('Error getting children', error);
      return Promise.resolve([]);
    }
  }

  /** Ordered list of visible node ids (depth-first) for next/previous match navigation. */
  getVisibleOrderedNodeIds(): string[] {
    if (this.rootNodes.length === 0) {return [];}
    this.filter.ensureFilterSets(this.cache.nodes);
    const ids = this.filter.filterAncestorOrVisibleIds!;
    const out: string[] = [];
    const walk = (n: TreeNode): void => {
      if (!ids.has(n.id)) {return;}
      out.push(n.id);
      for (const c of n.children || []) {walk(c);}
    };
    for (const root of this.rootNodes) {walk(root);}
    return out;
  }

  /** Metadata types offered in the type filter QuickPick. */
  getFilterableMetadataTypes(): MetadataType[] {
    return [...FILTERABLE_METADATA_TYPES];
  }

  /**
   * Get parent for a node
   */
  getParent(element: TreeNode): vscode.ProviderResult<TreeNode> {
    return element.parent || null;
  }

  /**
   * Find node by ID (uses cache for performance)
   */
  findNodeById(id: string): TreeNode | null {
    return this.cache.findById(id);
  }

  /**
   * Resolve a subsystem composition ref (`Catalog.Name`) to a loaded root object node in the same
   * configuration as `scopeNode`. Returns `null` if invalid or not found in the tree.
   */
  findRootObjectForCompositionRef(ref: string, scopeNode: TreeNode): TreeNode | null {
    if (validateSubsystemCompositionRef(ref) !== null) {
      return null;
    }
    const expectedId = expectedTreeNodeIdForCompositionRef(ref);
    if (!expectedId) {
      return null;
    }
    const candidates = this.cache.getCandidatesById(expectedId);
    const configPath = this.getConfigPathForNode(scopeNode);
    if (candidates.length === 0) {
      return this.cache.findById(expectedId);
    }
    if (configPath) {
      const scoped = candidates.find((candidate) => this.getConfigPathForNode(candidate) === configPath);
      return scoped ?? null;
    }
    return candidates[0] ?? null;
  }

  /**
   * Returns true when a valid composition ref exists in the workspace cache,
   * but only under another configuration root than `scopeNode`.
   */
  hasCompositionRefInOtherConfiguration(ref: string, scopeNode: TreeNode): boolean {
    if (validateSubsystemCompositionRef(ref) !== null) {
      return false;
    }
    const expectedId = expectedTreeNodeIdForCompositionRef(ref);
    if (!expectedId) {
      return false;
    }
    const candidates = this.cache.getCandidatesById(expectedId);
    if (candidates.length === 0) {
      return false;
    }
    const scopeConfigPath = this.getConfigPathForNode(scopeNode);
    if (!scopeConfigPath) {
      return false;
    }
    const inSameConfig = candidates.some((candidate) => this.getConfigPathForNode(candidate) === scopeConfigPath);
    if (inSameConfig) {
      return false;
    }
    return candidates.some((candidate) => this.getConfigPathForNode(candidate) !== scopeConfigPath);
  }

  /** Resolve possibly stale node reference to active in-memory node. */
  resolveNodeForUi(node: TreeNode): TreeNode {
    return this.cache.resolveActiveNode(node, this.rootNodes);
  }

  applyOptimisticDelete(node: TreeNode, operationId: string): OptimisticDeleteToken | null {
    const activeNode = this.cache.resolveActiveNode(node, this.rootNodes);
    const parent = activeNode.parent;
    if (!parent || !parent.children || parent.children.length === 0) {
      return null;
    }

    const removedIndex = parent.children.findIndex((candidate) =>
      candidate === activeNode ||
      (
        candidate.id === activeNode.id &&
        candidate.name === activeNode.name &&
        candidate.type === activeNode.type
      )
    );
    if (removedIndex < 0) {
      return null;
    }

    const [removedNode] = parent.children.splice(removedIndex, 1);
    if (!removedNode) {
      return null;
    }

    const configPath = this.getConfigPathForNode(parent) ?? '';
    const token: OptimisticDeleteToken = {
      configRootId: this.getNodeRootIdentity(parent),
      parentId: parent.id,
      removedNodeId: removedNode.id,
      removedNodeSnapshot: this.cloneNodeForRollback(removedNode),
      removedIndex,
      operationId,
    };
    this.filter.filterAncestorOrVisibleIds = null;
    this.refresh(parent);
    Logger.info('Applied optimistic delete', { operationId, configPath, parentId: parent.id, removedNodeId: removedNode.id });
    return token;
  }

  rollbackOptimisticDelete(token: OptimisticDeleteToken): boolean {
    const parent = this.cache.findRollbackParentNode(token.parentId, token.configRootId);
    if (!parent) {
      Logger.warn('Rollback skipped: parent not found', { operationId: token.operationId, parentId: token.parentId });
      return false;
    }
    if (!parent.children) {
      parent.children = [];
    }

    const alreadyPresent = parent.children.some((child) => child.id === token.removedNodeId);
    if (alreadyPresent) {
      Logger.debug('Rollback skipped: node already present', { operationId: token.operationId, nodeId: token.removedNodeId });
      return false;
    }

    const restoredNode = this.rehydrateRollbackNode(token.removedNodeSnapshot, parent);
    const insertionIndex = Math.max(0, Math.min(token.removedIndex, parent.children.length));
    parent.children.splice(insertionIndex, 0, restoredNode);
    this.cache.buildCache(restoredNode);
    this.filter.filterAncestorOrVisibleIds = null;
    this.refresh(parent);
    Logger.warn('Optimistic delete rolled back', { operationId: token.operationId, parentId: token.parentId, nodeId: token.removedNodeId });
    return true;
  }

  /**
   * Find nodes by name (uses name index for fast lookup). For Stage 6 search.
   * @param query Normalized (e.g. lowercase) or exact name to match
   * @returns Nodes whose name matches (includes partial match if index is extended)
   */
  findNodesByName(query: string): TreeNode[] {
    return this.cache.findByName(query);
  }

  /**
   * Expand node
   */
  expandNode(node: TreeNode): void {
    node.isExpanded = true;
    this.refresh(node);
  }

  /**
   * Collapse node
   */
  collapseNode(node: TreeNode): void {
    node.isExpanded = false;
    this.refresh(node);
  }

  private clearTypeEditorReferenceableCache(): void {
    const hadReferenceable = this.typeEditorReferenceableCache.size > 0;
    const hadObjectable = this.objectableObjectsCache.size > 0;
    if (!hadReferenceable && !hadObjectable) {
      return;
    }
    if (hadReferenceable) {
      this.typeEditorReferenceableCache.clear();
    }
    if (hadObjectable) {
      this.objectableObjectsCache.clear();
    }
    Logger.debug('Cleared type editor referenceable cache');
  }

  /**
   * Returns referenceable objects for the type editor: each reference kind with its project object names.
   * Aggregates from all configuration roots (first root used for kind order; names merged per kind).
   */
  getReferenceableObjects(): ReferenceableGroup[] {
    return getReferenceableObjects(this.rootNodes);
  }

  /**
   * Returns referenceable objects for the type editor, ensuring that the underlying
   * metadata type nodes (Catalogs/Documents/Enums/...) are loaded.
   *
   * Problem: parseStructureOnly() creates type nodes with empty `children` (lazy loading).
   * If type editor gets an empty list, it can't offer "DocumentRef.<...>" selection.
   */
  public async getReferenceableObjectsForTypeEditor(node?: TreeNode): Promise<ReferenceableGroup[]> {
    const t0 = Date.now();
    const scopeKey = getTypeEditorReferenceableScopeKey(node, this.rootNodes, this.cache);

    if (scopeKey) {
      const cached = this.typeEditorReferenceableCache.get(scopeKey);
      if (cached) {
        const durationMs = Date.now() - t0;
        Logger.debug('getReferenceableObjectsForTypeEditor cache hit', { durationMs, scopeKey });
        return cloneReferenceableGroups(cached);
      }
    }

    const pendingLoads = countPendingReferenceableTypeLoads(node, this.rootNodes, this.cache);

    const run = async (): Promise<ReferenceableGroup[]> => {
      const groups = await getReferenceableObjectsForTypeEditor(node, this.rootNodes, this.cache);
      if (scopeKey) {
        this.typeEditorReferenceableCache.set(scopeKey, cloneReferenceableGroups(groups));
      }
      const durationMs = Date.now() - t0;
      if (durationMs >= 500) {
        Logger.info('getReferenceableObjectsForTypeEditor completed', {
          durationMs,
          scopeKey,
          pendingLoads,
        });
      } else {
        Logger.debug('getReferenceableObjectsForTypeEditor completed', {
          durationMs,
          scopeKey,
          pendingLoads,
        });
      }
      return groups;
    };

    if (pendingLoads > 0) {
      return vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: MESSAGES.TYPE_EDITOR_LOADING_REFS,
          cancellable: false,
        },
        async (progress) => {
          progress.report({ increment: 0 });
          return run();
        }
      );
    }

    return run();
  }

  public async getObjectableObjectsForEditor(node?: TreeNode): Promise<ObjectableGroup[]> {
    const t0 = Date.now();
    const scopeKey = getTypeEditorReferenceableScopeKey(node, this.rootNodes, this.cache);

    if (scopeKey) {
      const cached = this.objectableObjectsCache.get(scopeKey);
      if (cached) {
        const durationMs = Date.now() - t0;
        Logger.debug('getObjectableObjectsForEditor cache hit', { durationMs, scopeKey });
        return cloneObjectableGroups(cached);
      }
    }

    const groups = await getObjectableObjectsForEditor(node, this.rootNodes, this.cache);
    if (scopeKey) {
      this.objectableObjectsCache.set(scopeKey, cloneObjectableGroups(groups));
    }
    const durationMs = Date.now() - t0;
    if (durationMs >= 500) {
      Logger.info('getObjectableObjectsForEditor completed', { durationMs, scopeKey });
    } else {
      Logger.debug('getObjectableObjectsForEditor completed', { durationMs, scopeKey });
    }
    return groups;
  }

  private cloneNodeForRollback(node: TreeNode): TreeNode {
    return {
      id: node.id,
      name: node.name,
      type: node.type,
      properties: { ...node.properties },
      filePath: node.filePath,
      parentFilePath: node.parentFilePath,
      isExpanded: node.isExpanded,
      children: (node.children ?? []).map((child) => this.cloneNodeForRollback(child)),
    };
  }

  private rehydrateRollbackNode(node: TreeNode, parent?: TreeNode): TreeNode {
    const restored: TreeNode = {
      id: node.id,
      name: node.name,
      type: node.type,
      parent,
      properties: { ...node.properties },
      filePath: node.filePath,
      parentFilePath: node.parentFilePath,
      isExpanded: node.isExpanded,
      children: [],
    };
    restored.children = (node.children ?? []).map((child) => this.rehydrateRollbackNode(child, restored));
    return restored;
  }

  // ---------------------------------------------------------------------------
  // findNodeByLocation — targeted tree walk for reveal-in-tree (issue #88)
  // ---------------------------------------------------------------------------

  /**
   * Walk the tree from the configuration root matching `loc.configRoot` down to the node
   * described by `loc`. Returns `null` when any step fails (root not found, type folder absent, etc.).
   *
   * Subsystem structure (Designer + EDT): child subsystems are direct children of the parent
   * subsystem node with type `MetadataType.Subsystem` — no intermediate subfolder.
   *
   * Uses `getChildren()` for lazy-loading at every step so that nodes that have not been
   * expanded yet are loaded transparently.
   *
   * @param loc Descriptor produced by `locateMetadataFile`.
   */
  async findNodeByLocation(loc: MetadataLocation): Promise<TreeNode | null> {
    // ── Step 1: find configuration root by configRoot path ──────────────────
    const configRootNode = await this.findConfigRootByPath(loc.configRoot);
    if (!configRootNode) {
      return null;
    }

    // ── Step 2: extension support ────────────────────────────────────────────
    // When loc.extensionName is set, the file lives inside ConfigurationExtensions/<Name>/
    // of the main config (the locator found the main config as longest prefix).
    // We need to find the corresponding extension root node, which is loaded as a separate
    // root with loadContext.configPath = <mainConfigRoot>/ConfigurationExtensions/<extensionName>.
    let searchRoot = configRootNode;
    if (loc.extensionName) {
      const extRoot = await this.findExtensionRootByName(loc.configRoot, loc.extensionName);
      if (extRoot === null) {
        // Extension root not loaded — cannot walk into it; avoid false-positive on main config.
        return null;
      }
      searchRoot = extRoot;
    }

    // ── Step 3: find type folder ─────────────────────────────────────────────
    const typeFolderNode = await this.findChildByName(searchRoot, loc.objectType);
    if (!typeFolderNode) {
      return null;
    }

    // ── Step 4/5: find object (with optional subsystem hierarchy walk) ───────
    let objectNode: TreeNode | null;

    if (loc.objectType === 'Subsystems' && loc.hierarchy && loc.hierarchy.length > 0) {
      objectNode = await this.walkSubsystemHierarchy(typeFolderNode, loc.hierarchy);
    } else {
      objectNode = await this.findChildByName(typeFolderNode, loc.objectName);
    }

    if (!objectNode) {
      return null;
    }

    // ── Step 6: subPath walk ─────────────────────────────────────────────────
    if (!loc.subPath) {
      return objectNode;
    }

    return this.walkSubPath(objectNode, loc.subPath);
  }

  /**
   * Find the configuration root node whose load context configPath matches `configRoot`.
   * Comparison is done with `path.resolve` to normalise separators and relative segments.
   */
  private async findConfigRootByPath(configRoot: string): Promise<TreeNode | null> {
    const normalizedTarget = path.resolve(configRoot);
    for (const root of this.rootNodes) {
      const ctx = this.cache.getLoadContext(root.id);
      if (ctx) {
        if (path.resolve(ctx.configPath) === normalizedTarget) {
          return root;
        }
      } else if (root.filePath) {
        // Fallback: Configuration.xml lives directly in configPath
        const rootDir = path.resolve(path.dirname(root.filePath));
        if (rootDir === normalizedTarget) {
          return root;
        }
      }
    }
    return null;
  }

  /**
   * Find an extension root node whose loadContext.configPath equals
   * `<mainConfigRoot>/ConfigurationExtensions/<extensionName>`.
   *
   * Designer stores extension files under `ConfigurationExtensions/<Name>/` inside
   * the main config directory. When the locator sees such a path it returns
   * `configRoot = mainConfigRoot` plus `extensionName = '<Name>'`. The corresponding
   * root node has `configPath = <mainConfigRoot>/ConfigurationExtensions/<Name>` and
   * `properties.extensionPurpose` set.
   *
   * Returns `null` when no matching extension root is loaded.
   */
  private async findExtensionRootByName(
    mainConfigRoot: string,
    extensionName: string
  ): Promise<TreeNode | null> {
    const expectedPath = path.resolve(mainConfigRoot, 'ConfigurationExtensions', extensionName);
    for (const root of this.rootNodes) {
      if (root.properties.extensionPurpose === undefined) {
        continue;
      }
      const ctx = this.cache.getLoadContext(root.id);
      if (ctx && path.resolve(ctx.configPath) === expectedPath) {
        return root;
      }
    }
    return null;
  }

  /**
   * Get (lazy-load if needed) children of `parent` and find the first child
   * whose `name` equals `targetName` (case-sensitive, matching 1C metadata names).
   *
   * Uses the resolved children from getChildren() (handles lazy-load and stale-node
   * resolution) rather than reading `parent.children` directly.
   */
  private async findChildByName(parent: TreeNode, targetName: string): Promise<TreeNode | null> {
    const children = await this.getChildren(parent);
    const found = children.find((c) => c.name === targetName);
    if (found) {
      return found;
    }
    // Fallback: getChildren may return a filtered list when a search filter is active.
    // Skip the raw-children fallback when a filter is active — the caller (revealActiveFile)
    // has already guarded against this via the filter-cancel dialog (Critical #1).
    // Raw fallback only makes sense when no filter is active to ensure lazy nodes are reachable.
    if (this.filter.hasActiveFilter()) {
      return null;
    }
    const raw = parent.children ?? [];
    return raw.find((c) => c.name === targetName) ?? null;
  }

  /**
   * Get (lazy-load if needed) children of `parent` and find the first child with `id === targetId`.
   * Used for R6 placeholder subfolders (Forms, Commands, Templates) whose `name` may be localised
   * by `ensureR6PlaceholdersForInstanceNode` (e.g. 'Формы'), but whose `id` stays stable.
   */
  private async findChildById(parent: TreeNode, targetId: string): Promise<TreeNode | null> {
    const children = await this.getChildren(parent);
    const found = children.find((c) => c.id === targetId);
    if (found) {
      return found;
    }
    // Skip raw fallback when a filter is active — same reasoning as findChildByName.
    if (this.filter.hasActiveFilter()) {
      return null;
    }
    const raw = parent.children ?? [];
    return raw.find((c) => c.id === targetId) ?? null;
  }

  /**
   * Walk the subsystem hierarchy chain starting from the `Subsystems` type-folder node.
   * `hierarchy` is an array like ['Sales', 'Orders'] — root is hierarchy[0].
   * Child subsystems are direct children of type MetadataType.Subsystem (no intermediate folder).
   */
  private async walkSubsystemHierarchy(
    subsystemsFolderNode: TreeNode,
    hierarchy: string[]
  ): Promise<TreeNode | null> {
    // hierarchy[0] is the root subsystem name (child of Subsystems folder).
    let current: TreeNode = subsystemsFolderNode;
    for (const name of hierarchy) {
      const children = await this.getChildren(current);
      // Match by name AND type to avoid collisions with non-subsystem children
      // (e.g. the synthetic CommandInterface node that shares the parent).
      let found = children.find((c) => c.name === name && c.type === MetadataType.Subsystem);
      if (!found) {
        // Fallback: check raw children in case filter hides the subsystem node.
        found = (current.children ?? []).find(
          (c) => c.name === name && c.type === MetadataType.Subsystem
        );
      }
      if (!found) {
        return null;
      }
      current = found;
    }
    return current;
  }

  /**
   * Walk inside an object node following `subPath` descriptor.
   * Returns the target node or `null` when the path cannot be resolved.
   */
  private async walkSubPath(
    objectNode: TreeNode,
    subPath: NonNullable<MetadataLocation['subPath']>
  ): Promise<TreeNode | null> {
    switch (subPath.kind) {
      case 'commonModule': {
        // CommonModules/X — the object node IS the common module.
        // Virtual Ext node with Module.bsl is a child, but the object node itself
        // is the navigable entity for a commonModule subPath.
        return objectNode;
      }

      case 'objectModule':
        return this.findModuleNode(objectNode, 'ObjectModule.bsl');

      case 'managerModule':
        return this.findModuleNode(objectNode, 'ManagerModule.bsl');

      case 'recordSetModule':
        return this.findModuleNode(objectNode, 'RecordSetModule.bsl');

      case 'valueManagerModule':
        return this.findModuleNode(objectNode, 'ValueManagerModule.bsl');

      case 'form': {
        // R6 placeholder id is 'Forms'; name may be localised by ensureR6PlaceholdersForInstanceNode.
        const formsFolder = await this.findChildById(objectNode, 'Forms');
        if (!formsFolder) {
          return null;
        }
        const formNode = await this.findChildByName(formsFolder, subPath.name);
        if (!formNode) {
          return null;
        }
        if (subPath.subFile === 'xml' || subPath.subFile === 'container') {
          return formNode;
        }
        // subFile === 'module': find the module node inside the form
        return this.findModuleNode(formNode, 'Module.bsl');
      }

      case 'command': {
        // R6 placeholder id is 'Commands'.
        const commandsFolder = await this.findChildById(objectNode, 'Commands');
        if (!commandsFolder) {
          return null;
        }
        const commandNode = await this.findChildByName(commandsFolder, subPath.name);
        if (!commandNode) {
          return null;
        }
        if (subPath.subFile === 'xml') {
          return commandNode;
        }
        // subFile === 'module'
        return this.findModuleNode(commandNode, 'CommandModule.bsl');
      }

      case 'template': {
        // R6 placeholder id is 'Templates'.
        const templatesFolder = await this.findChildById(objectNode, 'Templates');
        if (!templatesFolder) {
          return null;
        }
        return this.findChildByName(templatesFolder, subPath.name);
      }

      case 'rights': {
        // Rights.xml is parsed into object properties, not a separate tree node.
        // Return the role node itself so the caller can reveal/select it.
        return objectNode;
      }

      case 'predefinedData': {
        // PredefinedData container node has id 'PredefinedData' and is a direct child of the object.
        const pdChildren = await this.getChildren(objectNode);
        const allPdChildren = this.mergeChildren(pdChildren, objectNode.children ?? []);
        const predefined = allPdChildren.find((c) => c.id === 'PredefinedData');
        return predefined ?? objectNode;
      }

      default:
        return objectNode;
    }
  }

  /**
   * Find a module .bsl node inside an object node.
   * Modules live under the `Ext` child node (`MetadataType.Extension`, id ends with `.Ext` or `Ext`).
   * For CommonModules the Ext id is `CommonModules.X.Ext`; for others plain `Ext`.
   */
  private async findModuleNode(objectNode: TreeNode, fileName: string): Promise<TreeNode | null> {
    const children = await this.getChildren(objectNode);
    // Use the union of resolved children and raw node.children to handle filtered views.
    const allChildren = this.mergeChildren(children, objectNode.children ?? []);
    // Find the Ext node (may be named 'Extensions' with type Extension)
    const extNode = allChildren.find(
      (c) => c.type === MetadataType.Extension && (c.id === 'Ext' || c.id.endsWith('.Ext'))
    );
    if (!extNode) {
      return null;
    }
    const extChildren = await this.getChildren(extNode);
    const allExtChildren = this.mergeChildren(extChildren, extNode.children ?? []);
    return allExtChildren.find((c) => c.name === fileName) ?? null;
  }

  /**
   * Merge two children arrays without duplicates (by identity).
   * Used to combine getChildren() result (possibly filtered) with raw node.children.
   */
  private mergeChildren(a: TreeNode[], b: TreeNode[]): TreeNode[] {
    if (a.length === 0) {return b;}
    if (b.length === 0) {return a;}
    const seen = new Set<TreeNode>(a);
    const extra = b.filter((n) => !seen.has(n));
    return extra.length === 0 ? a : [...a, ...extra];
  }
}
