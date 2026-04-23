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
  collectNodeIdentityPaths,
  compareFileRevealNodes,
  normalizePathForMatch,
  parseRevealTypeFolderObjectFromFilePath,
  REVEAL_METADATA_TYPE_FOLDERS,
  scoreNodeAgainstTarget,
} from '../extensionSupport/revealPathUtils';
import {
  getReferenceableObjects,
  getReferenceableObjectsForTypeEditor,
  getTypeEditorReferenceableScopeKey,
  countPendingReferenceableTypeLoads,
  cloneReferenceableGroups,
} from './treeReferenceLoader';
import { getObjectableObjectsForEditor, cloneObjectableGroups } from './objectTypeLoader';
import type { ObjectableGroup } from '../types/objectTypeDefinitions';

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

  /**
   * When &gt; 0, lazy loads in {@link getChildrenWithFilterOptions} skip per-node {@link refresh}
   * (e.g. reveal-active-file) so the tree is not re-rendered hundreds of times. Pair with a single
   * {@link refresh} when depth returns to 0.
   */
  private _suppressTreeRefreshDepth = 0;

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

  /** Whether search / type / subsystem filter narrows the tree. */
  hasActiveTreeFilter(): boolean {
    return this.filter.hasActiveFilter();
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

  /** When filters are active, restrict to visible branch; used by UI tree and by reveal-helpers. */
  private mapChildrenRespectingFilterIfNeeded(children: TreeNode[], applyFilter: boolean): TreeNode[] {
    if (!applyFilter || !this.filter.hasActiveFilter()) {
      return children;
    }
    this.filter.ensureFilterSets(this.cache.nodes);
    const ids = this.filter.filterAncestorOrVisibleIds!;
    return children.filter((c) => ids.has(c.id));
  }

  /**
   * Get children for a node (lazy loading). When search/type filter is active, returns only children that match or contain matches.
   * For lazy type nodes (structure-only load), loads type contents on first expand.
   * @param applyFilter When false, returns the full (unfiltered) list — used to locate a file in the tree while a filter is on.
   */
  private getChildrenWithFilterOptions(element: TreeNode | undefined, applyFilter: boolean): Thenable<TreeNode[]> {
    try {
      if (!element) {
        if (this.rootNodes.length === 0) {return Promise.resolve([]);}
        if (!applyFilter || !this.filter.hasActiveFilter()) {return Promise.resolve(this.rootNodes);}
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
          if (this._suppressTreeRefreshDepth === 0) {
            this.refresh(activeElement);
          }
          return this.mapChildrenRespectingFilterIfNeeded(children, applyFilter);
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
            if (this._suppressTreeRefreshDepth === 0) {
              this.refresh(activeElement);
            }
            return this.mapChildrenRespectingFilterIfNeeded(children, applyFilter);
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
      if (!applyFilter || !this.filter.hasActiveFilter()) {
        return Promise.resolve(raw);
      }
      this.filter.ensureFilterSets(this.cache.nodes);
      const ids = this.filter.filterAncestorOrVisibleIds!;
      return Promise.resolve(raw.filter((c) => ids.has(c.id)));
    } catch (error) {
      Logger.error('Error getting children', error);
      return Promise.resolve([]);
    }
  }

  getChildren(element?: TreeNode): Thenable<TreeNode[]> {
    return this.getChildrenWithFilterOptions(element, true);
  }

  /**
   * Find the most specific tree node for a file path, loading lazy branches as needed. Ignores search/type/subsystem filters
   * so a match can be found when the tree is narrowed. Optimized: no refresh storm during walk, exact match in cache,
   * fast `TypeDir/ObjectName` (например `Documents/гк_Договор` из `…/src/Documents/…/Module.bsl`),
   * иначе обход с корня, без full-tree DFS если hint уже дал.
   */
  async findDeepestNodeForFilePath(targetFsPath: string): Promise<TreeNode | null> {
    if (!targetFsPath.trim() || this.rootNodes.length === 0) {
      return null;
    }
    const targetNorm = normalizePathForMatch(targetFsPath);
    const getCfg = (n: TreeNode) => this.getConfigPathForNode(n);
    const exactHit = this.findExactFilePathInCache(targetNorm, getCfg);
    if (exactHit) {
      return exactHit;
    }
    const hint = parseRevealTypeFolderObjectFromFilePath(targetFsPath);
    this._suppressTreeRefreshDepth += 1;
    try {
      const allRoots = await this.getChildrenWithFilterOptions(undefined, false);
      const configRoots = this.filterRootsByPathPrefix(targetNorm, allRoots);
      const roots = configRoots.length > 0 ? configRoots : allRoots;
      if (hint) {
        const fast = await this.findRevealObjectByTypeFolderHint(hint, roots, targetNorm, getCfg);
        if (fast) {
          return fast;
        }
      }
      let best: TreeNode | null = null;
      let bestScore = -1;
      for (const r of roots) {
        const cand = await this.findDeepestByDfsFromNode(r, targetNorm, getCfg);
        if (!cand) {continue;}
        const sc = scoreNodeAgainstTarget(targetNorm, cand, getCfg);
        if (
          !best ||
          sc > bestScore ||
          (sc === bestScore && sc > 0 && compareFileRevealNodes(cand, best, targetNorm, getCfg) > 0)
        ) {
          best = cand;
          bestScore = sc;
        }
      }
      if (best && bestScore > 0) {return best;}
      if (!hint) {return this.findDeepestByFullTreeDfs(targetNorm, getCfg);}
      return null;
    } finally {
      this._suppressTreeRefreshDepth -= 1;
      if (this._suppressTreeRefreshDepth === 0) {
        this.refresh();
      }
    }
  }

  private findExactFilePathInCache(
    targetNorm: string,
    getCfg: (n: TreeNode) => string | null
  ): TreeNode | null {
    const matches: TreeNode[] = [];
    for (const node of this.cache.nodes.values()) {
      for (const p of collectNodeIdentityPaths(node, getCfg)) {
        if (path.resolve(p).toLowerCase() === targetNorm) {
          matches.push(node);
          break;
        }
      }
    }
    if (matches.length === 0) {
      return null;
    }
    if (matches.length === 1) {
      return matches[0] ?? null;
    }
    let best: TreeNode = matches[0] as TreeNode;
    for (let k = 1; k < matches.length; k++) {
      const cand = matches[k] as TreeNode;
      if (compareFileRevealNodes(cand, best, targetNorm, getCfg) > 0) {best = cand;}
    }
    return best;
  }

  private filterRootsByPathPrefix(targetNorm: string, roots: TreeNode[]): TreeNode[] {
    return roots.filter((r) => this.isFilePathUnderTreeRoot(targetNorm, r));
  }

  /** Whether target (normalized) is under the configuration / extension content root. */
  private isFilePathUnderTreeRoot(targetNorm: string, root: TreeNode): boolean {
    const ctx = this.cache.getLoadContext(root.id);
    if (ctx?.configPath) {
      return MetadataTreeDataProvider.pathIsUnderConfigDir(targetNorm, path.resolve(ctx.configPath).toLowerCase());
    }
    if (root.filePath) {
      if (root.type === MetadataType.Configuration) {
        const b = path.resolve(path.dirname(root.filePath)).toLowerCase();
        return MetadataTreeDataProvider.pathIsUnderConfigDir(targetNorm, b);
      }
    }
    return true;
  }

  private static pathIsUnderConfigDir(fileNorm: string, dirNorm: string): boolean {
    const f = fileNorm.replace(/\\/g, path.sep);
    const d = dirNorm.replace(/\\/g, path.sep);
    if (f === d) {return true;}
    if (f.length <= d.length) {return false;}
    return f.startsWith(d + path.sep) || f.startsWith(d + '/');
  }

  private async findDeepestByDfsFromNode(
    start: TreeNode,
    targetNorm: string,
    getCfg: (n: TreeNode) => string | null
  ): Promise<TreeNode | null> {
    const active = this.cache.resolveActiveNode(start, this.rootNodes);
    let best: TreeNode | null = null;
    let bestScore = -1;
    const visit = async (node: TreeNode): Promise<void> => {
      const s = scoreNodeAgainstTarget(targetNorm, node, getCfg);
      if (s > 0 && (!best || s > bestScore || (s === bestScore && best && compareFileRevealNodes(node, best, targetNorm, getCfg) > 0))) {
        bestScore = s;
        best = node;
      }
      const ch = await this.getChildrenWithFilterOptions(node, false);
      for (const c of ch) {
        await visit(c);
      }
    };
    await visit(active);
    return bestScore > 0 ? best : null;
  }

  private async findDeepestByFullTreeDfs(
    targetNorm: string,
    getCfg: (n: TreeNode) => string | null
  ): Promise<TreeNode | null> {
    let best: TreeNode | null = null;
    let bestScore = -1;
    const visit = async (node: TreeNode): Promise<void> => {
      const s = scoreNodeAgainstTarget(targetNorm, node, getCfg);
      if (s > 0 && (!best || s > bestScore || (s === bestScore && best && compareFileRevealNodes(node, best, targetNorm, getCfg) > 0))) {
        bestScore = s;
        best = node;
      }
      const ch = await this.getChildrenWithFilterOptions(node, false);
      for (const c of ch) {
        await visit(c);
      }
    };
    const roots = await this.getChildrenWithFilterOptions(undefined, false);
    for (const r of roots) {
      await visit(r);
    }
    return bestScore > 0 ? best : null;
  }

  /**
   * Быстрый reveal: `…/Documents/гк_Договор/…` → кэш по `Documents.гк_Договор` и поиск папки типа без
   * обхода всех справочников/документов (BFS не заходит внутрь каталогов-«корзин»).
   */
  private async findRevealObjectByTypeFolderHint(
    hint: { typeFolder: string; objectName: string },
    roots: TreeNode[],
    targetNorm: string,
    getCfg: (n: TreeNode) => string | null
  ): Promise<TreeNode | null> {
    const { typeFolder, objectName } = hint;
    const wantId = `${typeFolder}.${objectName}`;
    const byId = this.cache.getCandidatesById(wantId);
    if (byId.length > 0) {
      const good = this.filterRevealCandidatesForRootsAndPath(byId, roots, targetNorm);
      if (good.length === 1) {return good[0]!;}
      if (good.length > 1) {
        let b = good[0]!;
        for (let k = 1; k < good.length; k += 1) {
          if (compareFileRevealNodes(good[k]!, b, targetNorm, getCfg) > 0) {b = good[k]!;}
        }
        return b;
      }
    }
    for (const r of roots) {
      if (!this.isFilePathUnderTreeRoot(targetNorm, r)) {continue;}
      const typeNode = await this.findTypeFolderBfsFromRoot(r, typeFolder);
      if (!typeNode) {continue;}
      const obj = await this.findObjectInTypeFolder(typeNode, typeFolder, objectName, targetNorm, getCfg);
      if (obj) {return obj;}
    }
    return null;
  }

  private filterRevealCandidatesForRootsAndPath(
    cands: TreeNode[],
    roots: TreeNode[],
    targetNorm: string
  ): TreeNode[] {
    const out: TreeNode[] = [];
    for (const c of cands) {
      for (const r of roots) {
        if (this.isTreeDescendantOf(c, r) && this.isFilePathUnderTreeRoot(targetNorm, r) && this.objectFilePathCoversTarget(c, targetNorm)) {
          out.push(c);
          break;
        }
      }
    }
    return out;
  }

  private isTreeDescendantOf(needle: TreeNode, ancestor: TreeNode): boolean {
    for (let p: TreeNode | undefined = needle; p; p = p.parent) {
      if (p.id === ancestor.id) {return true;}
    }
    return false;
  }

  private objectFilePathCoversTarget(node: TreeNode, targetNorm: string): boolean {
    if (!node.filePath?.trim()) {return false;}
    const base = path.resolve(path.normalize(node.filePath.trim())).toLowerCase();
    if (targetNorm === base) {return true;}
    if (targetNorm.length <= base.length) {return false;}
    return MetadataTreeDataProvider.pathIsUnderConfigDir(targetNorm, base);
  }

  private isNodeExpandableForTypeFolderSearch(n: TreeNode): boolean {
    if (n.id === 'Common') {return true;}
    if (REVEAL_METADATA_TYPE_FOLDERS.has(n.id)) {return false;}
    if (n.type === MetadataType.Configuration) {return true;}
    if (n.type === MetadataType.Extension) {return true;}
    if (n.parent == null) {return true;}
    return false;
  }

  private async findTypeFolderBfsFromRoot(start: TreeNode, typeFolder: string): Promise<TreeNode | null> {
    const fromCache = this.cache.getCandidatesById(typeFolder);
    for (const t of fromCache) {
      if (this.isTreeDescendantOf(t, this.cache.resolveActiveNode(start, this.rootNodes)) && t.id === typeFolder) {
        return t;
      }
    }
    const seen = new Set<string>();
    const startActive = this.cache.resolveActiveNode(start, this.rootNodes);
    const q: TreeNode[] = [startActive];
    for (let it = 0; it < 320 && q.length > 0; it += 1) {
      const n = q.shift() as TreeNode;
      if (seen.has(n.id)) {continue;}
      seen.add(n.id);
      if (n.id === typeFolder) {return n;}
      const ch = await this.getChildrenWithFilterOptions(n, false);
      for (const c of ch) {
        if (c.id === typeFolder) {return c;}
        if (this.isNodeExpandableForTypeFolderSearch(c)) {
          q.push(c);
        }
      }
    }
    return null;
  }

  private async findObjectInTypeFolder(
    typeNode: TreeNode,
    typeFolder: string,
    objectName: string,
    targetNorm: string,
    getCfg: (n: TreeNode) => string | null
  ): Promise<TreeNode | null> {
    const wantId = `${typeFolder}.${objectName}`;
    const ch = await this.getChildrenWithFilterOptions(
      this.cache.resolveActiveNode(typeNode, this.rootNodes),
      false
    );
    const matches: TreeNode[] = [];
    for (const c of ch) {
      if (c.id === wantId) {matches.push(c);}
    }
    if (matches.length === 0) {
      for (const c of ch) {
        if (c.name && c.name.localeCompare(objectName, undefined, { sensitivity: 'base'}) === 0) {
          matches.push(c);
        }
      }
    }
    if (matches.length === 0) {return null;}
    const ok = matches.filter((m) => this.objectFilePathCoversTarget(m, targetNorm));
    const take = ok.length > 0 ? ok : matches;
    if (take.length === 1) {return take[0]!;}
    let best = take[0]!;
    for (let k = 1; k < take.length; k += 1) {
      if (compareFileRevealNodes(take[k]!, best, targetNorm, getCfg) > 0) {best = take[k]!;}
    }
    return best;
  }

  /** True if the node (after resolve) is visible in the current filtered tree. */
  isNodeVisibleInFilteredView(node: TreeNode): boolean {
    if (!this.filter.hasActiveFilter()) {
      return true;
    }
    const resolved = this.resolveNodeForUi(node);
    this.filter.ensureFilterSets(this.cache.nodes);
    const ids = this.filter.filterAncestorOrVisibleIds;
    return ids ? ids.has(resolved.id) : true;
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
}
