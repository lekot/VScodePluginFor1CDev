import type { TreeLoadContext } from '../types/treeLoadContext';
import {
  TreeLoadError,
  type TreeTypeLoadResult,
} from '../types/treeTypeLoadResult';
import { MetadataParser } from '../parsers/metadataParser';
import { MetadataType, type TreeNode } from '../models/treeNode';
import { ensureR6PlaceholdersForInstanceNode } from '../utils/treeNormalization';
import { configurationPathKey } from '../utils/configurationPathIdentity';
import { TreeCacheService } from './treeCacheService';
import { isTypeIndexFolder } from './typeFolderSelector';

type RootStatus = 'active' | 'suspended' | 'retired';

interface RootRecord {
  readonly root: TreeNode;
  readonly context: Readonly<TreeLoadContext>;
  status: RootStatus;
}

interface NodeLoadState {
  version: number;
  inFlight?: Promise<TreeTypeLoadResult>;
}

interface ScopeRootSnapshot {
  readonly root: TreeNode;
  readonly record: RootRecord | undefined;
  readonly folderVersions: readonly FolderVersion[];
}

interface FolderVersion {
  readonly folder: TreeNode;
  readonly version: number;
}

interface ScopeSnapshotState {
  readonly roots: readonly ScopeRootSnapshot[];
  readonly allRootsScope: boolean;
}

const scopeSnapshotBrand: unique symbol = Symbol('TreeTypeLoadScopeSnapshot');
export type TreeTypeLoadScopeSnapshot = { readonly [scopeSnapshotBrand]: true };

function sameContext(left: TreeLoadContext, right: TreeLoadContext): boolean {
  return left.configurationId === right.configurationId
    && left.configPath === right.configPath
    && left.format === right.format;
}

function snapshotContext(context: TreeLoadContext): Readonly<TreeLoadContext> {
  return Object.freeze({
    configurationId: context.configurationId,
    configPath: context.configPath,
    format: context.format,
  });
}

function loadError(code: ConstructorParameters<typeof TreeLoadError>[0], message: string, cause?: unknown): TreeLoadError {
  return new TreeLoadError(code, message, cause);
}

export class TreeTypeLoadCoordinator {
  private publishedRoots: TreeNode[] = [];
  private rootRecords = new Map<TreeNode, RootRecord>();
  private readonly nodeStates = new WeakMap<TreeNode, NodeLoadState>();
  private readonly scopeSnapshots = new WeakMap<TreeTypeLoadScopeSnapshot, ScopeSnapshotState>();
  private disposed = false;

  constructor(
    private readonly cache: TreeCacheService,
    private readonly onPublished: (typeFolder: TreeNode) => void,
  ) {}

  setRoots(roots: readonly TreeNode[], contexts: ReadonlyMap<TreeNode, TreeLoadContext>): void {
    if (this.disposed) {
      return;
    }

    const nextRecords = new Map<TreeNode, RootRecord>();
    for (const root of roots) {
      const context = contexts.get(root);
      if (
        !context
        || root.type !== MetadataType.Configuration
        || (root.configurationId !== undefined && root.configurationId !== context.configurationId)
      ) {
        continue;
      }

      const existing = this.rootRecords.get(root);
      if (existing && existing.status !== 'retired' && sameContext(existing.context, context)) {
        nextRecords.set(root, existing);
      } else {
        if (existing) {
          existing.status = 'retired';
        }
        nextRecords.set(root, {
          root,
          context: snapshotContext(context),
          status: 'active',
        });
      }
    }

    for (const [root, record] of this.rootRecords) {
      if (nextRecords.get(root) !== record) {
        record.status = 'retired';
      }
    }
    this.publishedRoots = [...roots];
    this.rootRecords = nextRecords;
  }

  captureScope(
    roots: readonly TreeNode[],
    allRootsScope: boolean,
    relevantFolders: readonly TreeNode[] = [],
  ): TreeTypeLoadScopeSnapshot {
    const snapshot = Object.freeze({ [scopeSnapshotBrand]: true }) as TreeTypeLoadScopeSnapshot;
    this.scopeSnapshots.set(snapshot, {
      roots: Object.freeze(roots.map((root) => Object.freeze({
        root,
        record: this.rootRecords.get(root),
        folderVersions: Object.freeze(relevantFolders
          .filter((folder) => this.cache.getConfigurationRoot(folder) === root)
          .map((folder) => Object.freeze({
            folder,
            version: this.nodeStates.get(folder)?.version ?? 0,
          }))),
      }))),
      allRootsScope,
    });
    return snapshot;
  }

  isScopeCurrent(snapshot: TreeTypeLoadScopeSnapshot): boolean {
    const state = this.scopeSnapshots.get(snapshot);
    if (!state || this.disposed) {
      return false;
    }
    if (state.allRootsScope) {
      if (state.roots.length !== this.publishedRoots.length) {
        return false;
      }
      for (let index = 0; index < state.roots.length; index += 1) {
        if (state.roots[index]?.root !== this.publishedRoots[index]) {
          return false;
        }
      }
    }
    return state.roots.every(({ root, record, folderVersions }) => {
      if (!this.publishedRoots.includes(root) || !this.cache.contains(root)) {
        return false;
      }
      const current = this.rootRecords.get(root);
      if (current !== record || (current && current.status !== 'active')) {
        return false;
      }
      return folderVersions.every(({ folder, version }) =>
        this.cache.contains(folder) && (this.nodeStates.get(folder)?.version ?? 0) === version,
      );
    });
  }

  loadTypeChildren(typeFolder: TreeNode): Promise<TreeTypeLoadResult> {
    if (this.disposed) {
      return Promise.resolve({
        status: 'disposed',
        error: loadError('TREE_LOAD_DISPOSED', 'Загрузчик дерева уже остановлен.'),
      });
    }

    const root = this.cache.getConfigurationRoot(typeFolder);
    if (!root || !this.publishedRoots.includes(root) || !this.cache.contains(typeFolder)) {
      return Promise.resolve({
        status: 'superseded',
        error: loadError('TREE_LOAD_SUPERSEDED', 'Запрос загрузки относится к устаревшему дереву конфигурации.'),
      });
    }
    if (!isTypeIndexFolder(root, typeFolder)) {
      return Promise.resolve({
        status: 'failed',
        error: loadError('CONFIGURATION_CONTEXT_UNAVAILABLE', 'Не удалось определить папку типа в опубликованном дереве.'),
      });
    }

    const record = this.rootRecords.get(root);
    if (!record) {
      return Promise.resolve({
        status: 'failed',
        error: loadError('CONFIGURATION_CONTEXT_UNAVAILABLE', 'Для конфигурации не зарегистрирован контекст чтения.'),
      });
    }
    if (record.status !== 'active') {
      return Promise.resolve({
        status: 'superseded',
        error: loadError('TREE_LOAD_SUPERSEDED', 'Конфигурация обновляется; запрос загрузки устарел.'),
      });
    }

    if ((typeFolder.properties as Record<string, unknown> | undefined)?._indexLoaded === true) {
      return Promise.resolve({ status: 'loaded', children: typeFolder.children ?? [] });
    }
    if ((typeFolder.children?.length ?? 0) > 0) {
      return Promise.resolve({ status: 'loaded', children: typeFolder.children ?? [] });
    }

    let state = this.nodeStates.get(typeFolder);
    if (!state) {
      state = { version: 0 };
      this.nodeStates.set(typeFolder, state);
    }
    if (state.inFlight) {
      return state.inFlight;
    }

    const nodeVersion = state.version;
    const pending = this.parseAndPublish(typeFolder, record, state, nodeVersion);
    state.inFlight = pending;
    void pending.finally(() => {
      if (state?.inFlight === pending) {
        state.inFlight = undefined;
      }
    });
    return pending;
  }

  invalidateNode(node: TreeNode): void {
    let state = this.nodeStates.get(node);
    if (!state) {
      state = { version: 0 };
      this.nodeStates.set(node, state);
    }
    state.version += 1;
    state.inFlight = undefined;
  }

  invalidateConfiguration(configPath: string): void {
    const key = configurationPathKey(configPath);
    for (const record of this.rootRecords.values()) {
      if (configurationPathKey(record.context.configPath) === key && record.status === 'active') {
        record.status = 'suspended';
      }
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const record of this.rootRecords.values()) {
      record.status = 'retired';
    }
    this.rootRecords.clear();
    this.publishedRoots = [];
  }

  private async parseAndPublish(
    typeFolder: TreeNode,
    record: RootRecord,
    state: NodeLoadState,
    nodeVersion: number,
  ): Promise<TreeTypeLoadResult> {
    try {
      const parsedChildren = await MetadataParser.parseTypeIndex(
        record.context.configPath,
        typeFolder.id,
        { format: record.context.format },
      );
      if (this.disposed) {
        return {
          status: 'disposed',
          error: loadError('TREE_LOAD_DISPOSED', 'Загрузчик дерева уже остановлен.'),
        };
      }
      if (!this.isCurrent(record, typeFolder, state, nodeVersion)) {
        return {
          status: 'superseded',
          error: loadError('TREE_LOAD_SUPERSEDED', 'Результат загрузки относится к устаревшему дереву конфигурации.'),
        };
      }

      const children = parsedChildren ?? [];
      for (const child of children) {
        child.parent = typeFolder;
        ensureR6PlaceholdersForInstanceNode(child, {
          configPath: record.context.configPath,
          format: record.context.format,
        });
      }
      typeFolder.children = children;
      if (!typeFolder.properties) {
        typeFolder.properties = {};
      }
      (typeFolder.properties as Record<string, unknown>)._indexLoaded = true;
      for (const child of children) {
        this.cache.buildCache(child);
      }
      this.onPublished(typeFolder);
      return { status: 'loaded', children };
    } catch (cause) {
      if (this.disposed) {
        return {
          status: 'disposed',
          error: loadError('TREE_LOAD_DISPOSED', 'Загрузчик дерева уже остановлен.'),
        };
      }
      if (!this.isCurrent(record, typeFolder, state, nodeVersion)) {
        return {
          status: 'superseded',
          error: loadError('TREE_LOAD_SUPERSEDED', 'Ошибка загрузки относится к устаревшему дереву конфигурации.'),
        };
      }
      return {
        status: 'failed',
        error: loadError(
          'TREE_LOAD_FAILED',
          `Не удалось загрузить элементы папки «${typeFolder.name}».`,
          cause,
        ),
      };
    }
  }

  private isCurrent(
    record: RootRecord,
    typeFolder: TreeNode,
    state: NodeLoadState,
    nodeVersion: number,
  ): boolean {
    return record.status === 'active'
      && this.rootRecords.get(record.root) === record
      && this.publishedRoots.includes(record.root)
      && this.cache.contains(record.root)
      && this.cache.contains(typeFolder)
      && state.version === nodeVersion;
  }
}
