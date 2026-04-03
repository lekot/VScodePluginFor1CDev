import * as fs from 'fs';
import * as vscode from 'vscode';
import * as path from 'path';
import { TreeNode, MetadataType } from '../models/treeNode';
import { Logger } from '../utils/logger';
import { getFormPaths } from '../formEditor/formPaths';
import type { ReferenceableGroup } from '../types/typeDefinitions';
import { MetadataParser } from '../parsers/metadataParser';
import { ConfigFormat } from '../parsers/formatDetector';
import { MESSAGES } from '../constants/messages';
import { CONFIGURATION_XML } from '../constants/fileNames';
import { METADATA_TYPE_TO_REFERENCE_KIND } from '../constants/metadataTypeReferenceKinds';
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

const REFERENCEABLE_METADATA_TYPES: ReadonlySet<MetadataType> = new Set([
  MetadataType.Catalog,
  MetadataType.Document,
  MetadataType.Enum,
  MetadataType.ChartOfCharacteristicTypes,
  MetadataType.ChartOfAccounts,
  MetadataType.ChartOfCalculationTypes,
]);

/** R6 placeholders under object XML — reload via loadElementChildren after mutations (see invalidateLoadedChildren). */
const R6_LAZY_SECTION_IDS = new Set(['Attributes', 'TabularSections', 'Forms', 'Commands', 'Templates']);

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

  private lookupConfigurationBindingDecoration(element: TreeNode): ConfigurationBindingDecoration | undefined {
    if (element.type === MetadataType.Configuration) {
      const configDir = this.getConfigPathForNode(element);
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
    if (element.type === MetadataType.Extension) {
      const props = element.properties as Record<string, unknown> | undefined;
      if (props?.isExtension !== true || !element.filePath?.trim()) {
        return undefined;
      }
      const configXmlFs = path.join(element.filePath.trim(), CONFIGURATION_XML);
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
    try {
      // Collapsible: has children, or lazy type node, or lazy element node (load on expand)
      const hasChildren =
        (element.children && element.children.length > 0) ||
        this.isLazyTypeNode(element) ||
        this.isLazyElementNode(element) ||
        this.isTabularSectionInstanceNode(element);
      const collapsibleState = hasChildren
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

      const bindingDeco = this.lookupConfigurationBindingDecoration(element);
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
      } else if (this.isExtensionInfobaseBindingRoot(element)) {
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
      const pathStr = this.getPathForTooltip(element);
      if (pathStr) {tooltipText += `\n${pathStr}`;}
      // Highlight match in tooltip when search is active (additional_req.md п.2)
      const q = this.filter.rawSearchQuery.trim();
      if (q && !this.filter.isRegex && this.filter.nodeMatchesSearch(element, q)) {
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
      } else if (this.isExtensionInfobaseBindingRoot(element)) {
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
        (element.type === MetadataType.Configuration || this.isExtensionInfobaseBindingRoot(element)) &&
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
      treeItem.iconPath = this.getIconForType(element.type);

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
        const configDir = this.getConfigPathForNode(element);
        if (configDir != null) {
          treeItem.resourceUri = vscode.Uri.file(path.join(configDir, CONFIGURATION_XML));
        }
      } else if (this.isExtensionInfobaseBindingRoot(element) && element.filePath?.trim()) {
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

  /** Path for tooltip: filePath if set, otherwise parent chain (e.g. "Configuration / Catalogs / MyCatalog"). */
  private getPathForTooltip(element: TreeNode): string {
    if (element.filePath) {return element.filePath;}
    const parts: string[] = [];
    let p: TreeNode | undefined = element.parent;
    while (p) {
      parts.unshift(p.name);
      p = p.parent;
    }
    return parts.length > 0 ? parts.join(' / ') : '';
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
   * Get icon for metadata type
   */
  private getIconForType(type: MetadataType): vscode.ThemeIcon {
    // Map metadata types to VS Code built-in icons
    const iconMap: Record<MetadataType, string> = {
      // Root
      [MetadataType.Configuration]: 'package',

      // Main types
      [MetadataType.Catalog]: 'book',
      [MetadataType.Document]: 'file-text',
      [MetadataType.Enum]: 'symbol-enum',
      [MetadataType.Report]: 'graph',
      [MetadataType.DataProcessor]: 'gear',
      [MetadataType.ChartOfCharacteristicTypes]: 'symbol-class',
      [MetadataType.ChartOfAccounts]: 'symbol-numeric',
      [MetadataType.ChartOfCalculationTypes]: 'calculator',
      [MetadataType.InformationRegister]: 'database',
      [MetadataType.AccumulationRegister]: 'archive',
      [MetadataType.AccountingRegister]: 'symbol-ruler',
      [MetadataType.CalculationRegister]: 'symbol-operator',
      [MetadataType.BusinessProcess]: 'git-branch',
      [MetadataType.Task]: 'checklist',
      [MetadataType.ExternalDataSource]: 'cloud',
      [MetadataType.Constant]: 'symbol-constant',
      [MetadataType.SessionParameter]: 'symbol-parameter',
      [MetadataType.FilterCriterion]: 'filter',
      [MetadataType.ScheduledJob]: 'watch',
      [MetadataType.FunctionalOption]: 'symbol-boolean',
      [MetadataType.FunctionalOptionsParameter]: 'symbol-variable',
      [MetadataType.SettingsStorage]: 'save',
      [MetadataType.EventSubscription]: 'bell',
      [MetadataType.CommonModule]: 'symbol-module',
      [MetadataType.CommandGroup]: 'folder',
      [MetadataType.Command]: 'terminal',
      [MetadataType.Role]: 'shield',
      [MetadataType.Interface]: 'symbol-interface',
      [MetadataType.Style]: 'paintcan',
      [MetadataType.WebService]: 'globe',
      [MetadataType.HTTPService]: 'server',
      [MetadataType.IntegrationService]: 'plug',
      [MetadataType.Subsystem]: 'folder-library',
      [MetadataType.ExchangePlan]: 'repo-sync',
      [MetadataType.DocumentJournal]: 'notebook',
      [MetadataType.DefinedType]: 'symbol-misc',
      [MetadataType.CommonAttribute]: 'symbol-field',
      [MetadataType.CommonCommand]: 'terminal',
      [MetadataType.CommonForm]: 'layout',
      [MetadataType.CommonPicture]: 'file-media',
      [MetadataType.CommonTemplate]: 'file-code',
      [MetadataType.DocumentNumerator]: 'list-ordered',
      [MetadataType.Language]: 'globe',
      [MetadataType.WSReference]: 'link',
      [MetadataType.XDTOPackage]: 'package',
      [MetadataType.StyleItem]: 'symbol-color',

      // Sub-elements
      [MetadataType.Attribute]: 'symbol-field',
      [MetadataType.TabularSection]: 'table',
      [MetadataType.Form]: 'layout',
      [MetadataType.Template]: 'file-code',
      [MetadataType.CommandSubElement]: 'symbol-method',
      [MetadataType.Recurrence]: 'sync',
      [MetadataType.Method]: 'symbol-method',
      [MetadataType.Parameter]: 'symbol-parameter',

      // Extensions
      [MetadataType.Extension]: 'extensions',

      // Unknown
      [MetadataType.Unknown]: 'question',
    };

    const iconName = iconMap[type] || 'file';
    return new vscode.ThemeIcon(iconName);
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

  /**
   * Returns referenceable objects for the type editor: each reference kind with its project object names.
   * Aggregates from all configuration roots (first root used for kind order; names merged per kind).
   */
  getReferenceableObjects(): ReferenceableGroup[] {
    const refKindOrder = [
      'CatalogRef',
      'DocumentRef',
      'EnumRef',
      'ChartOfCharacteristicTypesRef',
      'ChartOfAccountsRef',
      'ChartOfCalculationTypesRef',
    ];
    const byKind = new Map<string, Set<string>>();
    for (const root of this.rootNodes) {
      if (!root.children) {continue;}
      for (const node of root.children) {
        if (!REFERENCEABLE_METADATA_TYPES.has(node.type)) {continue;}
        const referenceKind = METADATA_TYPE_TO_REFERENCE_KIND[node.type];
        if (!referenceKind) {continue;}
        const names = (node.children || []).map((c) => c.name);
        const set = byKind.get(referenceKind) ?? new Set<string>();
        names.forEach((n) => set.add(n));
        byKind.set(referenceKind, set);
      }
    }
    return refKindOrder.map((refKind) => ({
      referenceKind: refKind,
      objectNames: Array.from(byKind.get(refKind) ?? []),
    }));
  }

  /**
   * Returns referenceable objects for the type editor, ensuring that the underlying
   * metadata type nodes (Catalogs/Documents/Enums/...) are loaded.
   *
   * Problem: parseStructureOnly() creates type nodes with empty `children` (lazy loading).
   * If type editor gets an empty list, it can't offer "DocumentRef.<...>" selection.
   */
  public async getReferenceableObjectsForTypeEditor(node?: TreeNode): Promise<ReferenceableGroup[]> {
    // Determine which configuration root we should use.
    // If `node` is provided, we restrict loading/aggregation to that configuration only.
    const configRoot = (() => {
      if (!node) {return null;}
      let cur: TreeNode | undefined = node;
      while (cur) {
        const curNode: TreeNode = cur;
        if (curNode.type === MetadataType.Configuration && this.rootNodes.some((r) => r.id === curNode.id)) {
          return curNode;
        }
        cur = curNode.parent;
      }
      return null;
    })();

    const rootsToUse = configRoot ? [configRoot] : this.rootNodes;

    // Load missing type contents (if `children` are empty) so that objectNames are available.
    for (const root of rootsToUse) {
      if (!root.children || root.children.length === 0) {continue;}

      const configPath =
        this.cache.getLoadContext(root.id)?.configPath ??
        (root.filePath ? path.dirname(root.filePath) : null);

      if (!configPath) {continue;}

      for (const typeNode of root.children) {
        if (!REFERENCEABLE_METADATA_TYPES.has(typeNode.type)) {continue;}
        if (typeNode.children && typeNode.children.length > 0) {continue;}

        try {
          const children = await MetadataParser.parseTypeContents(configPath, typeNode.id);
          for (const c of children) {c.parent = typeNode;}
          typeNode.children = children;

          // Update in-memory caches so other features can use the newly loaded nodes.
          for (const c of children) {this.cache.buildCache(c);}
        } catch (e) {
          Logger.warn('Failed to eager load referenceable type contents for type editor', {
            configPath,
            typeNodeId: typeNode.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }

    // Aggregate only for selected roots.
    if (!rootsToUse.length) {return [];}

    const refKindOrder = [
      'CatalogRef',
      'DocumentRef',
      'EnumRef',
      'ChartOfCharacteristicTypesRef',
      'ChartOfAccountsRef',
      'ChartOfCalculationTypesRef',
    ];
    const byKind = new Map<string, Set<string>>();
    for (const root of rootsToUse) {
      if (!root.children) {continue;}
      for (const child of root.children) {
        if (!REFERENCEABLE_METADATA_TYPES.has(child.type)) {continue;}
        const referenceKind = METADATA_TYPE_TO_REFERENCE_KIND[child.type];
        if (!referenceKind) {continue;}
        const names = (child.children || []).map((c: TreeNode) => c.name);
        const set = byKind.get(referenceKind) ?? new Set<string>();
        names.forEach((n: string) => set.add(n));
        byKind.set(referenceKind, set);
      }
    }

    return refKindOrder.map((refKind) => ({
      referenceKind: refKind,
      objectNames: Array.from(byKind.get(refKind) ?? []),
    }));
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
}
