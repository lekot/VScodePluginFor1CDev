import * as fs from 'fs';
import * as vscode from 'vscode';
import * as path from 'path';
import { TreeNode, MetadataType } from '../models/treeNode';
import { Logger } from '../utils/logger';
import type { ReferenceableGroup } from '../types/typeDefinitions';
import { MESSAGES } from '../constants/messages';
import { CONFIGURATION_XML } from '../constants/fileNames';
import {
  ensureR6PlaceholdersForInstanceNode,
  ensureTabularSectionColumnsPlaceholder,
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
import { configurationPathKey, isSameOrDescendantPath } from '../utils/configurationPathIdentity';
import type { ConfigurationId } from '../services/configurationSession/types';
import type { TreeLoadContext } from '../types/treeLoadContext';
import { TreeFilterService, FILTERABLE_METADATA_TYPES } from './treeFilterService';
import { TreeCacheService } from './treeCacheService';
import { buildTreeItem } from './treeItemBuilder';
import {
  getReferenceableObjects,
  getTypeEditorReferenceableScopeKey,
  countPendingReferenceableTypeLoads,
  cloneReferenceableGroups,
  isReferenceableTypeFolder,
  resolveRootsToUse,
  projectReferenceableObjectsForTypeEditor,
} from './treeReferenceLoader';
import {
  isObjectableTypeFolder,
  projectObjectableObjectsForEditor,
  cloneObjectableGroups,
} from './objectTypeLoader';
import { TreeTypeLoadCoordinator } from './treeTypeLoadCoordinator';
import { getTypeIndexFolders, isTypeIndexFolder, isTypeIndexLoaded } from './typeFolderSelector';
import { TreeLoadError, unwrapTreeTypeLoadResult } from '../types/treeTypeLoadResult';
import type { ObjectableGroup } from '../types/objectTypeDefinitions';
import type { MetadataLocation } from '../services/metadataFileLocator';
import type { CachedSupportStatus } from '../support/supportStateCache';
import {
  resolveSupportTreeDecoration,
  type SupportTreeDecoration,
} from '../support/supportTreeDecorations';
import {
  resolveRepositoryTreeDecoration,
  type RepositoryStateReader,
  type RepositoryTreeDecoration,
} from '../services/configurationRepository/repositoryTreeDecorations';
import { TreeWarmupScheduler } from './treeWarmupScheduler';
import type { TypeContentsWarmupOptions } from './treeWarmupScheduler';
import { TreeLocationNavigator } from './treeLocationNavigator';

export type { TypeContentsWarmupOptions } from './treeWarmupScheduler';

/** R6 placeholders under object XML — reload via loadElementChildren after mutations (see invalidateLoadedChildren). */
const R6_LAZY_SECTION_IDS = new Set(['Attributes', 'TabularSections', 'Forms', 'Commands', 'Templates', 'Dimensions', 'Resources', 'EnumValues', 'PredefinedData']);
const TYPE_CONTENTS_WARMUP_RESUME_AFTER_FOREGROUND_MS = 1000;

export type LoadedTypeObjectsResult =
  | { readonly status: 'loaded'; readonly names: readonly string[] }
  | { readonly status: 'notLoaded' };

export interface SupportStateCacheReader {
  get(configRoot: string, generationId?: string): CachedSupportStatus | undefined;
}

export type SupportDecorationResolver = (
  node: TreeNode,
  cached: CachedSupportStatus | undefined
) => SupportTreeDecoration | undefined;

export type SupportRootRegistrationCallback = (
  configRoots: readonly string[]
) => void;

export type RepositoryDecorationResolver = (
  node: TreeNode,
  reader: RepositoryStateReader | undefined,
) => RepositoryTreeDecoration | undefined;

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
  private readonly cache: TreeCacheService;
  private readonly typeLoadCoordinator: TreeTypeLoadCoordinator;

  /** Snapshot of referenceable names per scope for TypeEditor (invalidated with tree reload / structure). */
  private readonly typeEditorReferenceableCache = new Map<string, ReferenceableGroup[]>();
  /** Snapshot of objectable object groups per scope for ObjectTypeEditor (invalidated with tree reload / structure). */
  private readonly objectableObjectsCache = new Map<string, ObjectableGroup[]>();
  private readonly typeContentsWarmupScheduler: TreeWarmupScheduler;
  private readonly locationNavigator: TreeLocationNavigator;
  private disposed = false;

  private messageUpdater: ((message: string | undefined) => void) | null = null;
  /** Ключ {@link bindingKey}(workspaceFolder, configRelativePath) → сводка для узла Configuration. */
  private configurationBindingDecorations = new Map<string, ConfigurationBindingDecoration>();
  private supportStateCache: SupportStateCacheReader | undefined;
  private supportDecorationResolver: SupportDecorationResolver = resolveSupportTreeDecoration;
  private supportRootRegistrationCallback: SupportRootRegistrationCallback | undefined;
  private repositoryStateReader: RepositoryStateReader | undefined;
  private repositoryDecorationResolver: RepositoryDecorationResolver = resolveRepositoryTreeDecoration;

  constructor(private readonly platform: NodeJS.Platform = process.platform) {
    this.cache = new TreeCacheService(this.platform);
    this.typeLoadCoordinator = new TreeTypeLoadCoordinator(
      this.cache,
      () => this.clearTypeEditorReferenceableCache(),
      (element, loaded) => this.projectElementChildren(element, loaded),
    );
    this.typeContentsWarmupScheduler = new TreeWarmupScheduler({
      getRoots: () => this.rootNodes,
      loadTypeFolderIndex: (node) => this.loadTypeFolderIndex(node),
    });
    this.locationNavigator = new TreeLocationNavigator({
      getRoots: () => this.rootNodes,
      getLoadContext: (root) => this.cache.getLoadContext(root),
      getChildren: (node) => this.getChildren(node),
      hasActiveFilter: () => this.filter.hasActiveFilter(),
      findTypeFolder: (root, folderId) => this.findTypeFolderNode(root, folderId),
    });
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

  setSupportStateCache(cache: SupportStateCacheReader | undefined): void {
    this.supportStateCache = cache;
    this.refresh();
  }

  setSupportDecorationResolver(resolver: SupportDecorationResolver | undefined): void {
    this.supportDecorationResolver = resolver ?? resolveSupportTreeDecoration;
    this.refresh();
  }

  setSupportRootRegistrationCallback(
    callback: SupportRootRegistrationCallback | undefined
  ): void {
    this.supportRootRegistrationCallback = callback;
    this.notifySupportRootsChanged();
  }

  setRepositoryStateReader(reader: RepositoryStateReader | undefined): void {
    this.repositoryStateReader = reader;
    this.refresh();
  }

  setRepositoryDecorationResolver(resolver: RepositoryDecorationResolver | undefined): void {
    this.repositoryDecorationResolver = resolver ?? resolveRepositoryTreeDecoration;
    this.refresh();
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
  private lookupSupportDecoration(element: TreeNode): SupportTreeDecoration | undefined {
    if (!this.supportStateCache) {
      return undefined;
    }
    let root = element.type === MetadataType.Configuration
      ? element
      : this.cache.getConfigurationRoot(element);
    if (!root) {
      let current = element.parent;
      while (current) {
        if (current.type === MetadataType.Configuration) {
          root = current;
          break;
        }
        current = current.parent;
      }
    }
    const configRoot = root ? this.getConfigRootPath(root) : null;
    if (!configRoot) {
      return undefined;
    }
    try {
      return this.supportDecorationResolver(
        element,
        this.supportStateCache.get(configRoot)
      );
    } catch (error) {
      Logger.warn('Failed to resolve support tree decoration', {
        nodeId: element.id,
        configRoot,
        error,
      });
      return undefined;
    }
  }

  private notifySupportRootsChanged(): void {
    if (!this.supportRootRegistrationCallback) {
      return;
    }
    try {
      this.supportRootRegistrationCallback(Object.freeze(this.getConfigRootPaths()));
    } catch (error) {
      Logger.warn('Failed to register support configuration roots', error);
    }
  }

  private getConfigRootPath(root: TreeNode): string | null {
    return this.cache.getConfigRootPath(root);
  }

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
  async setSubsystemFilter(
    subsystemId: string | null,
    subsystemName: string | null,
    scopeNodeOrRoot?: TreeNode | string,
  ): Promise<void> {


    let rootIdentity: string | null = null;
    let subsystemNode: TreeNode | undefined;
    if (subsystemId) {
      const candidates = this.cache.getCandidatesById(subsystemId);
      rootIdentity = typeof scopeNodeOrRoot === 'object' && scopeNodeOrRoot !== null
        ? this.cache.getNodeRootIdentity(scopeNodeOrRoot)
        : (typeof scopeNodeOrRoot === 'string' ? scopeNodeOrRoot : null);
      subsystemNode = typeof scopeNodeOrRoot === 'object' && scopeNodeOrRoot !== null
        ? scopeNodeOrRoot
        : (rootIdentity ? (candidates.find((c) => this.cache.getNodeRootIdentity(c) === rootIdentity) ?? candidates[0]) : candidates[0]);
    }

    this.filter.setSubsystemFilter(
      subsystemId,
      subsystemName,
      rootIdentity ?? undefined,
      subsystemNode,
      (node) => this.cache.getNodeRootIdentity(node),
    );

    if (subsystemNode) {
        await this.loadSubsystemContent(subsystemNode);
        // Eagerly load all type-nodes referenced in subsystem Content so that
        // ensureFilterSets() can find them in nodeCache (lazy nodes are not yet loaded).
        await this.eagerLoadSubsystemTypes(subsystemNode);
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

    const ctx = this.cache.getLoadContext(configRoot);
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
          await this.loadTypeFolderIndex(typeNode);
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

  /** Returns true when any filter (search query, type filter, or subsystem filter) is active. */
  hasActiveFilter(): boolean {
    return this.filter.hasActiveFilter();
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

  private ensureFilterSets(): void {
    this.filter.ensureFilterSets(this.rootNodes, (node) => this.cache.getNodeRootIdentity(node));
  }

  private isNodeFilteredVisible(node: TreeNode): boolean {
    return this.filter.isNodeVisible(node, (n) => this.cache.getNodeRootIdentity(n));
  }

  /** Visible nodes in depth-first order (for next/previous match navigation). */
  getVisibleNodesInOrder(): TreeNode[] {
    if (this.rootNodes.length === 0) {return [];}
    this.ensureFilterSets();
    const out: TreeNode[] = [];
    const walk = (n: TreeNode): void => {
      if (!this.isNodeFilteredVisible(n)) {return;}
      out.push(n);
      for (const c of n.children || []) {walk(c);}
    };
    for (const root of this.rootNodes) {walk(root);}
    return out;



  }

  /**
   * Set single root node and refresh tree (backward compat).
   * @param loadContext When provided, type nodes load their children on first expand (lazy loading).
   */
  setRootNode(node: TreeNode, loadContext?: TreeLoadContext): void {
    if (!node) {
      Logger.error('Cannot set null or undefined root node');
      return;
    }
    this.cancelTypeContentsCacheWarmup();
    this.rootNodes = [node];
    this.cache.clearLoadContexts();
    if (loadContext) {this.cache.setLoadContext(node, this.snapshotLoadContext(loadContext));}
    this.cache.clear();
    this.cache.buildCache(node);
    this.typeLoadCoordinator.setRoots(this.rootNodes, this.cache.getLoadContexts());
    this.clearTypeEditorReferenceableCache();
    Logger.info('Tree cache size', { nodeCount: this.cache.size });
    this.filter.filterAncestorOrVisibleIds = null;
    this.notifySupportRootsChanged();
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
    loadContextMap?: Map<TreeNode, TreeLoadContext>
  ): void {
    this.cancelTypeContentsCacheWarmup();
    this.rootNodes = nodes;
    const publishedContexts = new Map<TreeNode, TreeLoadContext>();
    for (const node of nodes) {
      const context = loadContextMap?.get(node);
      if (context) {
        publishedContexts.set(node, this.snapshotLoadContext(context));
      }
    }
    this.cache.setLoadContexts(publishedContexts);
    this.cache.clear();
    for (const node of nodes) {this.cache.buildCache(node);}
    this.typeLoadCoordinator.setRoots(this.rootNodes, this.cache.getLoadContexts());
    this.clearTypeEditorReferenceableCache();
    Logger.info('Tree cache size', { nodeCount: this.cache.size, roots: nodes.length });
    this.filter.clearFilterCaches();
    if (this.filter.activeSubsystemId) {
      const subFilter = this.filter.getSubsystemFilter();
      if (subFilter.subsystemId) {
        const candidates = this.cache.getCandidatesById(subFilter.subsystemId);
        const matching = subFilter.rootIdentity
          ? candidates.find((c) => this.cache.getNodeRootIdentity(c) === subFilter.rootIdentity)
          : candidates[0];
        this.filter.setSubsystemFilter(
          subFilter.subsystemId,
          subFilter.subsystemName,
          subFilter.rootIdentity ?? undefined,
          matching ?? null,
          (n) => this.cache.getNodeRootIdentity(n),
        );
        if (matching) {
          void this.loadSubsystemContent(matching)
            .then(() => this.eagerLoadSubsystemTypes(matching))
            .then(() => {
              if (this.disposed) {
                return;
              }
              if (this.filter.activeSubsystemId === matching.id) {
                this.filter.clearFilterCaches();
                this.refresh();
              }
            })
            .catch((err) => {
              Logger.warn('Failed to reload subsystem content after setRootNodes', err);
            });
        }
      }
    }
    this.notifySupportRootsChanged();
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

  private snapshotLoadContext(context: TreeLoadContext): TreeLoadContext {
    return Object.freeze({
      configurationId: context.configurationId,
      configPath: context.configPath,
      format: context.format,
    });
  }

  /**
   * Returns names from an already-loaded direct type-folder index for the configuration
   * containing `resourcePath`. This read-only lookup never triggers lazy loading or I/O.
   */
  getLoadedTypeObjectsForResource(resourcePath: string, folderId: string): LoadedTypeObjectsResult {
    if (!resourcePath || !folderId) {
      return { status: 'notLoaded' };
    }
    const selectedRoot = this.findConfigurationRootForResource(resourcePath);
    const typeFolder = selectedRoot ? this.findTypeFolderNode(selectedRoot, folderId) : undefined;
    if (!typeFolder || (typeFolder.properties as Record<string, unknown>)._indexLoaded !== true) {
      return { status: 'notLoaded' };
    }
    return {
      status: 'loaded',
      names: (typeFolder.children ?? []).map(({ name }) => name),
    };
  }

  /** Returns the normalized primary BSL language for a resource in the most-specific loaded root. */
  getLanguageForResource(resourcePath: string): 'ru' | 'en' {
    return this.findConfigurationRootForResource(resourcePath)?.properties.bslLanguage === 'en' ? 'en' : 'ru';
  }

  private findConfigurationRootForResource(resourcePath: string): TreeNode | undefined {
    if (!resourcePath) {
      return undefined;
    }
    const targetPath = path.resolve(resourcePath);
    const matchingRoots = this.rootNodes
      .map((root) => {
        const configPath = this.cache.getLoadContext(root)?.configPath;
        if (!configPath) {
          return undefined;
        }
        const resolvedConfigPath = path.resolve(configPath);
        const isContained = isSameOrDescendantPath(resolvedConfigPath, targetPath);
        return isContained ? { root, configPath: resolvedConfigPath } : undefined;
      })
      .filter((candidate): candidate is { root: TreeNode; configPath: string } => candidate !== undefined)
      .sort((left, right) => right.configPath.length - left.configPath.length);
    return matchingRoots[0]?.root;
  }

  /** Atomically replaces one loaded configuration root and preserves every other root/context. */
  replaceConfigurationRoot(
    configurationId: ConfigurationId,
    node: TreeNode,
    loadContext: TreeLoadContext,
  ): boolean {
    // Reject a mismatched replacement before looking up or mutating the active
    // roots. The stable root ID and the private context must describe the same
    // configuration that the caller asked to replace.
    if (
      loadContext.configurationId !== configurationId
      || node.configurationId !== configurationId
    ) {
      return false;
    }
    const index = this.rootNodes.findIndex((root) => {
      const context = this.cache.getLoadContext(root);
      return root.type === MetadataType.Configuration
        && context?.configurationId === configurationId;
    });
    if (index < 0) {
      return false;
    }

    const previousRoot = this.rootNodes[index]!;
    const contexts = this.cache.getLoadContexts();
    contexts.delete(previousRoot);
    contexts.set(node, this.snapshotLoadContext(loadContext));
    const roots = [...this.rootNodes];
    roots[index] = node;
    this.setRootNodes(roots, contexts);
    return true;
  }

  /**
   * Eagerly load children for all lazy type-folder nodes under a configuration root.
   * Used by composition editor to see all objects before lazy expand.
   */
  async eagerLoadAllTypeFolders(configRoot: TreeNode): Promise<void> {
    for (const typeFolder of getTypeIndexFolders(configRoot)) {
      // Already loaded
      if (isTypeIndexLoaded(typeFolder)) { continue; }

      try {
        await this.loadTypeFolderIndex(typeFolder);
      } catch (error) {
        Logger.warn('Failed to eager load type folder', { folder: typeFolder.id, error });
      }
    }
  }

  startTypeContentsCacheWarmup(options: number | TypeContentsWarmupOptions = 1000): void {
    if (this.disposed) {
      return;
    }
    this.typeContentsWarmupScheduler.start(options);
  }

  private cancelTypeContentsCacheWarmup(): void {
    this.typeContentsWarmupScheduler.cancel();
  }

  private async loadTypeFolderIndex(typeFolder: TreeNode): Promise<TreeNode[]> {
    return unwrapTreeTypeLoadResult(await this.typeLoadCoordinator.loadTypeChildren(typeFolder));
  }

  dispose(): void {
    this.disposed = true;
    this.typeContentsWarmupScheduler.dispose();
    this.typeLoadCoordinator.dispose();
    this._onDidChangeTreeData.dispose();
  }

  /** Suspends type-index publication until a fresh configuration root is published. */
  invalidateTypeLoadsForConfiguration(configPath: string): void {
    this.typeLoadCoordinator.invalidateConfiguration(configPath);
    this.clearTypeEditorReferenceableCache();
  }

  /** Retires any pending type-index parse before an in-place child mutation. */
  invalidatePendingTypeLoad(node: TreeNode): void {
    this.typeLoadCoordinator.invalidateNode(node);
    this.clearTypeEditorReferenceableCache();
  }

  /**
   * Get configuration root path for the tree (first root's context; backward compat).
   */
  getConfigPath(): string | null {
    const first = this.rootNodes[0];
    if (!first) {return null;}
    return this.cache.getLoadContext(first)?.configPath ?? first.filePath ?? null;
  }

  /**
   * Get configuration root paths for all loaded roots (multi-root workspace support).
   * Used by revealActiveFileInTree command to locate a file across all configurations.
   */
  getConfigRootPaths(): string[] {
    const roots = this.rootNodes
      .filter((root) => root.type === MetadataType.Configuration)
      .map((root) => this.getConfigRootPath(root))
      .filter((root): root is string => root !== null);
    const seen = new Set<string>();
    return roots.filter((root) => {
      const key = normalizeConfigIdentity(root, this.platform);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  /**
   * Canonical support root used by the registration/cache wiring for a concrete tree node.
   * Unlike the legacy config-path helper, this honors the parser load context in multi-root
   * and symlinked workspaces.
   */
  getSupportConfigRootForNode(node: TreeNode): string | null {
    let root = node.type === MetadataType.Configuration
      ? node
      : this.cache.getConfigurationRoot(node);
    if (!root) {
      let current = node.parent;
      while (current) {
        if (current.type === MetadataType.Configuration) {
          root = current;
          break;
        }
        current = current.parent;
      }
    }
    return root ? this.getConfigRootPath(root) : null;
  }

  /** Refreshes only the loaded root affected by a support-file watcher event. */
  refreshSupportForRoot(configRoot: string): void {
    const identity = normalizeConfigIdentity(configRoot, this.platform);
    const root = this.rootNodes.find(
      (candidate) =>
        normalizeConfigIdentity(this.getConfigRootPath(candidate) ?? undefined, this.platform) === identity
    );
    if (root) {
      this.refresh(root);
    }
  }

  /**
   * Get configuration root path for a node (walk up to Configuration node, return its directory path).
   */
  getConfigPathForNode(node: TreeNode): string | null {
    let n: TreeNode | undefined = node;
    while (n) {
      if (n.type === MetadataType.Configuration) {
        return this.getConfigRootPath(n);
      }
      n = n.parent;
    }
    return null;
  }

  /**
   * Search nodes by name (substring, case-insensitive). Uses name index for speed.
   * Returns only nodes currently in cache (loaded so far).
   */
  searchByName(query: string, contextNodeOrRootPath?: TreeNode | string): TreeNode[] {
    return this.cache.searchByName(query, contextNodeOrRootPath);
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
    this.typeLoadCoordinator.invalidateNode(el);
    if (!el.properties) {
      el.properties = {};
    }
    const childrenToRemove = new Set<TreeNode>();
    if (el.children) {
      for (const child of el.children) {
        childrenToRemove.add(child);
      }
    }
    if (element !== el && element.children) {
      for (const child of element.children) {
        childrenToRemove.add(child);
      }
    }
    for (const child of childrenToRemove) {
      this.cache.removeNode(child);
    }
    el.children = [];
    if (element !== el) {
      element.children = [];
    }
    delete (el.properties as Record<string, unknown>)._indexLoaded;
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
    return root ? this.cache.getNodeRootIdentity(root) : '';

  }

  private getNodeRootIdentity(node: TreeNode): string {
    return this.getConfigRootIdentity(this.cache.getConfigurationRoot(node));
  }

  private isTypeFolderAlreadyLoaded(element: TreeNode): boolean {
    return isTypeIndexLoaded(element);
  }

  private isLazyTypeNode(element: TreeNode): boolean {
    if (this.isTypeFolderAlreadyLoaded(element)) {
      return false;
    }
    const configRoot = this.cache.getConfigurationRoot(element);
    if (!configRoot) {
      return false;
    }
    return isTypeIndexFolder(configRoot, element);
  }

  private isLazyElementNode(element: TreeNode): boolean {
    const configRoot = this.cache.getConfigurationRoot(element);
    if (!configRoot || !this.cache.getLoadContext(configRoot) || element.properties._lazy !== true) {
      return false;
    }
    if (!element.children || element.children.length === 0) {return true;}
    if (element.type === MetadataType.Subsystem) {
      const hasNonSubsystem = element.children.some((c) => c.type !== MetadataType.Subsystem);
      return !hasNonSubsystem;
    }
    return false;
  }

  private projectElementChildren(element: TreeNode, loaded: TreeNode[]): readonly TreeNode[] {
    const existingSubsystems = (element.children ?? []).filter(
      (child) => child.type === MetadataType.Subsystem,
    );
    const children = existingSubsystems.length > 0
      ? [...existingSubsystems, ...loaded]
      : [...loaded];
    if (element.type === MetadataType.Subsystem && element.filePath) {
      const commandInterfacePath = path.join(path.dirname(element.filePath), 'Ext', 'CommandInterface.xml');
      if (fs.existsSync(commandInterfacePath)) {
        children.push({
          id: `${element.id}.CommandInterface`,
          name: 'Командный интерфейс',
          type: MetadataType.Unknown,
          parent: element,
          properties: { isVirtual: true },
          filePath: commandInterfacePath,
        });
      }
    }
    return children;
  }

  /**
   * Parsers may leave a tabular section instance with no children when there are no columns yet.
   * Without the synthetic «Реквизиты» node the item is a leaf and the user cannot add the first column.
   * The element-load projection already fixes this for `_lazy` sections; mirror here for eager nodes.
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
    const supportDecoration = this.lookupSupportDecoration(element);
    const repositoryDecoration = this.repositoryDecorationResolver(element, this.repositoryStateReader);

    return buildTreeItem(element, {
      hasChildren,
      bindingDeco,
      isExtensionInfobaseBindingRoot: isExtBindingRoot,
      rawSearchQuery: q,
      isRegex: this.filter.isRegex,
      nodeMatchesSearch: !!(q && this.filter.nodeMatchesSearch(element, q)),
      configDirPath: element.type === MetadataType.Configuration ? this.getConfigPathForNode(element) : null,
      ...(supportDecoration === undefined ? {} : { supportDecoration }),
      ...(repositoryDecoration === undefined ? {} : { repositoryDecoration }),
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
        this.ensureFilterSets();

        return Promise.resolve(this.rootNodes.filter((r) => this.isNodeFilteredVisible(r)));
      }
      const activeElement = this.cache.resolveActiveNode(element, this.rootNodes);

      if (activeElement.type === MetadataType.Configuration) {
        this.startTypeContentsCacheWarmup({
          delayMs: 50,
          preferredRootId: activeElement.id,
        });
      }

      // Lazy load: type node with no children yet
      if (this.isLazyTypeNode(activeElement)) {
        const configRoot = this.cache.getConfigurationRoot(activeElement);
        this.cancelTypeContentsCacheWarmup();
        return this.loadTypeFolderIndex(activeElement).then((children) => {
          Logger.info('Tree cache size after lazy load', {
            type: activeElement.id,
            nodeCount: this.cache.size,
          });
          this.filter.filterAncestorOrVisibleIds = null;
          if (!this.filter.hasActiveFilter()) {return children;}
          this.ensureFilterSets();

          return children.filter((c) => this.isNodeFilteredVisible(c));
        }).finally(() => {
          if (!this.disposed) {
            this.startTypeContentsCacheWarmup({
              delayMs: TYPE_CONTENTS_WARMUP_RESUME_AFTER_FOREGROUND_MS,
              preferredRootId: configRoot?.id,
            });
          }
        });
      }

      // Lazy load: element node with _lazy and no children yet (Attributes, Forms, Ext, etc.)
      if (this.isLazyElementNode(activeElement)) {
        const configRoot = this.cache.getConfigurationRoot(activeElement);
        this.cancelTypeContentsCacheWarmup();
        return this.typeLoadCoordinator.loadElementChildren(activeElement).then(
          (result) => {
            const children = unwrapTreeTypeLoadResult(result);
            Logger.info('Tree cache size after lazy element load', {
              element: activeElement.id,
              nodeCount: this.cache.size,
            });
            this.filter.filterAncestorOrVisibleIds = null;
            if (!this.filter.hasActiveFilter()) {return children;}
            this.ensureFilterSets();

            return children.filter((c) => this.isNodeFilteredVisible(c));
          }
        ).finally(() => {
          this.startTypeContentsCacheWarmup({
            delayMs: TYPE_CONTENTS_WARMUP_RESUME_AFTER_FOREGROUND_MS,
            preferredRootId: configRoot?.id,
          });
        });
      }

      const configRoot = this.cache.getConfigurationRoot(activeElement);
      const ctx = configRoot ? this.cache.getLoadContext(configRoot) : undefined;
      if (ctx) {
        ensureR6PlaceholdersForInstanceNode(activeElement, { configPath: ctx.configPath, format: ctx.format });
      }

      this.ensureTabularSectionColumnsIfNeeded(activeElement);

      const raw = activeElement.children || [];
      if (!this.filter.hasActiveFilter()) {
        return Promise.resolve(raw);
      }

      this.ensureFilterSets();

      const filtered = raw.filter((c) => this.isNodeFilteredVisible(c));
      return Promise.resolve(filtered);
    } catch (error) {
      Logger.error('Error getting children', error);
      return Promise.resolve([]);
    }
  }

  /** Ordered list of visible node ids (depth-first) for next/previous match navigation. */
  getVisibleOrderedNodeIds(): string[] {
    return this.getVisibleNodesInOrder().map((n) => n.id);










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

  /** Exact reference membership check for command arguments supplied by the tree view. */
  isLoadedNode(node: TreeNode): boolean {
    return this.cache.contains(node);
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
    const scopeIdentity = this.getNodeRootIdentity(scopeNode);
    if (candidates.length === 0) {
      return this.cache.findById(expectedId);
    }
    if (scopeIdentity) {
      const scoped = candidates.find((candidate) => this.getNodeRootIdentity(candidate) === scopeIdentity);
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
    const scopeIdentity = this.getNodeRootIdentity(scopeNode);
    if (!scopeIdentity) {
      return false;
    }
    const inSameConfig = candidates.some((candidate) => this.getNodeRootIdentity(candidate) === scopeIdentity);
    if (inSameConfig) {
      return false;
    }
    return candidates.some((candidate) => this.getNodeRootIdentity(candidate) !== scopeIdentity);
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

    this.typeLoadCoordinator.invalidateNode(parent);
    const [removedNode] = parent.children.splice(removedIndex, 1);

    if (!removedNode) {
      return null;
    }
    this.cache.removeNode(removedNode);

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
    this.clearTypeEditorReferenceableCache();
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
    this.typeLoadCoordinator.invalidateNode(parent);
    parent.children.splice(insertionIndex, 0, restoredNode);
    this.cache.buildCache(restoredNode);
    this.filter.filterAncestorOrVisibleIds = null;
    this.clearTypeEditorReferenceableCache();
    this.refresh(parent);
    Logger.warn('Optimistic delete rolled back', { operationId: token.operationId, parentId: token.parentId, nodeId: token.removedNodeId });
    return true;
  }

  /**
   * Find nodes by name (uses name index for fast lookup). For Stage 6 search.
   * @param query Normalized (e.g. lowercase) or exact name to match
   * @returns Nodes whose name matches (includes partial match if index is extended)
   */
  findNodesByName(query: string, contextNodeOrRootPath?: TreeNode | string): TreeNode[] {
    return this.cache.findByName(query, contextNodeOrRootPath);
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
    const publishedRoots = this.rootNodes;
    const rootsToUse = resolveRootsToUse(node, publishedRoots);
    const allRootsScope = node === undefined;
    const typeFolders = rootsToUse.flatMap((root) => getTypeIndexFolders(root)).filter(isReferenceableTypeFolder);
    const scopeSnapshot = this.typeLoadCoordinator.captureScope(rootsToUse, allRootsScope, typeFolders);
    const scopeKey = getTypeEditorReferenceableScopeKey(node, publishedRoots, this.cache);

    if (scopeKey) {
      const cached = this.typeEditorReferenceableCache.get(scopeKey);
      if (cached && this.typeLoadCoordinator.isScopeCurrent(scopeSnapshot)) {
        const durationMs = Date.now() - t0;
        Logger.debug('getReferenceableObjectsForTypeEditor cache hit', { durationMs, scopeKey });
        return cloneReferenceableGroups(cached);
      }
    }

    const pendingLoads = countPendingReferenceableTypeLoads(node, publishedRoots);

    const run = async (): Promise<ReferenceableGroup[]> => {
      await this.loadEditorTypeIndexes(typeFolders);
      this.assertTypeEditorScopeCurrent(scopeSnapshot);
      const groups = projectReferenceableObjectsForTypeEditor(rootsToUse);
      if (scopeKey && this.typeLoadCoordinator.isScopeCurrent(scopeSnapshot)) {
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
    const publishedRoots = this.rootNodes;
    const rootsToUse = resolveRootsToUse(node, publishedRoots);
    const allRootsScope = node === undefined;
    const typeFolders = rootsToUse.flatMap((root) => getTypeIndexFolders(root)).filter(isObjectableTypeFolder);
    const scopeSnapshot = this.typeLoadCoordinator.captureScope(rootsToUse, allRootsScope, typeFolders);
    const scopeKey = getTypeEditorReferenceableScopeKey(node, publishedRoots, this.cache);

    if (scopeKey) {
      const cached = this.objectableObjectsCache.get(scopeKey);
      if (cached && this.typeLoadCoordinator.isScopeCurrent(scopeSnapshot)) {
        const durationMs = Date.now() - t0;
        Logger.debug('getObjectableObjectsForEditor cache hit', { durationMs, scopeKey });
        return cloneObjectableGroups(cached);
      }
    }

    await this.loadEditorTypeIndexes(typeFolders);
    this.assertTypeEditorScopeCurrent(scopeSnapshot);
    const groups = projectObjectableObjectsForEditor(rootsToUse);
    if (scopeKey && this.typeLoadCoordinator.isScopeCurrent(scopeSnapshot)) {
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

  private async loadEditorTypeIndexes(
    typeFolders: readonly TreeNode[],
  ): Promise<void> {
    const requests = typeFolders
      .filter((typeFolder) => !isTypeIndexLoaded(typeFolder))
      .map((typeFolder) => this.loadTypeFolderIndex(typeFolder));
    await Promise.all(requests);
  }

  private assertTypeEditorScopeCurrent(snapshot: ReturnType<TreeTypeLoadCoordinator['captureScope']>): void {
    if (!this.typeLoadCoordinator.isScopeCurrent(snapshot)) {
      throw new TreeLoadError(
        'TREE_LOAD_SUPERSEDED',
        'Результат загрузки типов относится к устаревшему составу конфигураций.',
      );
    }
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
  async findNodeByLocation(loc: MetadataLocation): Promise<TreeNode | null> {
    return this.locationNavigator.findNodeByLocation(loc);
  }
}

function normalizeConfigIdentity(configPath: string | undefined, platform: NodeJS.Platform = process.platform): string {
  const value = configPath?.trim();
  if (!value) {
    return '';
  }

  return configurationPathKey(value, platform);
}
