import { isDeepStrictEqual } from 'util';
import type { TreeLoadContext } from '../types/treeLoadContext';
import {
  TreeLoadError,
  type TreeTypeLoadResult,
} from '../types/treeTypeLoadResult';
import { MetadataParser } from '../parsers/metadataParser';
import { MetadataType, type TreeNode, type TreeNodeProperties } from '../models/treeNode';
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

interface DetachedElementInput {
  readonly element: TreeNode;
  readonly propertiesAtAdmission: WeakMap<TreeNode, TreeNodeProperties>;
}

export type ElementChildrenProjection = (
  element: TreeNode,
  parsedChildren: TreeNode[],
) => readonly TreeNode[];

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

function cloneReaderValue(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (!value || typeof value !== 'object') {
    return value;
  }
  const existing = seen.get(value);
  if (existing) {
    return existing;
  }
  if (value instanceof Date) {
    const copy = new Date(value.getTime());
    seen.set(value, copy);
    return copy;
  }
  if (value instanceof Error) {
    const copy = new Error(value.message);
    Object.setPrototypeOf(copy, Object.getPrototypeOf(value));
    seen.set(value, copy);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) {
        continue;
      }
      if ('value' in descriptor) {
        descriptor.value = cloneReaderValue(descriptor.value, seen);
      }
      Object.defineProperty(copy, key, descriptor);
    }
    return copy;
  }
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) {
      copy.push(cloneReaderValue(item, seen));
    }
    return copy;
  }
  if (value instanceof Map) {
    const copy = new Map<unknown, unknown>();
    seen.set(value, copy);
    for (const [key, item] of value) {
      copy.set(cloneReaderValue(key, seen), cloneReaderValue(item, seen));
    }
    return copy;
  }
  if (value instanceof Set) {
    const copy = new Set<unknown>();
    seen.set(value, copy);
    for (const item of value) {
      copy.add(cloneReaderValue(item, seen));
    }
    return copy;
  }

  const prototype = Object.getPrototypeOf(value) as object | null;
  const copy = Object.create(prototype) as Record<string, unknown>;
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value)) {
    copy[key] = cloneReaderValue(item, seen);
  }
  return copy;
}

function cloneNodeShell(
  source: TreeNode,
  propertiesAtAdmission: WeakMap<TreeNode, TreeNodeProperties>,
): TreeNode {
  const sourceProperties = source.properties;
  const detached: TreeNode = {
    ...source,
    properties: cloneReaderValue(sourceProperties) as TreeNodeProperties,
    children: [],
    parent: undefined,
    nestedPath: source.nestedPath
      ? cloneReaderValue(source.nestedPath) as TreeNode['nestedPath']
      : undefined,
  };
  propertiesAtAdmission.set(detached, cloneReaderValue(sourceProperties) as TreeNodeProperties);
  return detached;
}

function cloneElementSubtree(
  source: TreeNode,
  propertiesAtAdmission: WeakMap<TreeNode, TreeNodeProperties>,
  clones: WeakMap<TreeNode, TreeNode>,
): TreeNode {
  const existing = clones.get(source);
  if (existing) {
    return existing;
  }
  const detached = cloneNodeShell(source, propertiesAtAdmission);
  clones.set(source, detached);
  detached.children = source.children?.map((child) => {
    const childClone = cloneElementSubtree(child, propertiesAtAdmission, clones);
    childClone.parent = detached;
    return childClone;
  });
  return detached;
}

function createDetachedElementInput(element: TreeNode): DetachedElementInput {
  const propertiesAtAdmission = new WeakMap<TreeNode, TreeNodeProperties>();
  const detached = cloneElementSubtree(element, propertiesAtAdmission, new WeakMap<TreeNode, TreeNode>());
  let liveParent = element.parent;
  let detachedChild = detached;
  while (liveParent) {
    const detachedParent = cloneNodeShell(liveParent, propertiesAtAdmission);
    detachedParent.children = [detachedChild];
    detachedChild.parent = detachedParent;
    detachedChild = detachedParent;
    liveParent = liveParent.parent;
  }
  return { element: detached, propertiesAtAdmission };
}

function publishReaderPropertyChanges(
  liveElement: TreeNode,
  detachedInput: DetachedElementInput,
): void {
  let live: TreeNode | undefined = liveElement;
  let detached: TreeNode | undefined = detachedInput.element;
  while (live && detached) {
    const initialProperties = detachedInput.propertiesAtAdmission.get(detached);
    if (initialProperties) {
      const keys = new Set([...Object.keys(initialProperties), ...Object.keys(detached.properties)]);
      const initial = initialProperties as Record<string, unknown>;
      const parsed = detached.properties as Record<string, unknown>;
      const current = live.properties as Record<string, unknown>;
      for (const key of keys) {
        const wasPresent = Object.prototype.hasOwnProperty.call(initial, key);
        const isPresent = Object.prototype.hasOwnProperty.call(parsed, key);
        const initialValue = initial[key];
        const parsedValue = parsed[key];
        if (wasPresent === isPresent && isDeepStrictEqual(initialValue, parsedValue)) {
          continue;
        }

        const liveHasValue = Object.prototype.hasOwnProperty.call(current, key);
        if (liveHasValue !== wasPresent || !isDeepStrictEqual(current[key], initialValue)) {
          continue;
        }
        if (isPresent) {
          current[key] = cloneReaderValue(parsedValue);
        } else {
          delete current[key];
        }
      }
    }
    if (live.type === MetadataType.Configuration) {
      break;
    }
    live = live.parent;
    detached = detached.parent;
  }
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
    private readonly projectElementChildren: ElementChildrenProjection,
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

    const state = this.getNodeState(typeFolder);
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

  loadElementChildren(element: TreeNode): Promise<TreeTypeLoadResult> {
    if (this.disposed) {
      return Promise.resolve({
        status: 'disposed',
        error: loadError('TREE_LOAD_DISPOSED', 'Загрузчик дерева уже остановлен.'),
      });
    }

    const root = this.cache.getConfigurationRoot(element);
    if (!root || !this.publishedRoots.includes(root) || !this.cache.contains(element)) {
      return Promise.resolve({
        status: 'superseded',
        error: loadError('TREE_LOAD_SUPERSEDED', 'Запрос загрузки относится к устаревшему дереву конфигурации.'),
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
    if (element.properties._lazy !== true) {
      return Promise.resolve({ status: 'loaded', children: element.children ?? [] });
    }

    const state = this.getNodeState(element);
    if (state.inFlight) {
      return state.inFlight;
    }

    const detachedInput = createDetachedElementInput(element);
    const nodeVersion = state.version;
    const pending = this.parseAndPublishElementChildren(element, detachedInput, record, state, nodeVersion);
    state.inFlight = pending;
    void pending.finally(() => {
      if (state.inFlight === pending) {
        state.inFlight = undefined;
      }
    });
    return pending;
  }

  invalidateNode(node: TreeNode): void {
    const state = this.getNodeState(node);
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

  private async parseAndPublishElementChildren(
    element: TreeNode,
    detachedInput: DetachedElementInput,
    record: RootRecord,
    state: NodeLoadState,
    nodeVersion: number,
  ): Promise<TreeTypeLoadResult> {
    let parsedChildren: TreeNode[];
    try {
      parsedChildren = await MetadataParser.loadElementChildren(
        record.context.configPath,
        record.context.format,
        detachedInput.element,
      );
    } catch (cause) {
      if (this.disposed) {
        return {
          status: 'disposed',
          error: loadError('TREE_LOAD_DISPOSED', 'Загрузчик дерева уже остановлен.'),
        };
      }
      if (!this.isCurrent(record, element, state, nodeVersion)) {
        return {
          status: 'superseded',
          error: loadError('TREE_LOAD_SUPERSEDED', 'Ошибка загрузки относится к устаревшему дереву конфигурации.'),
        };
      }
      return {
        status: 'failed',
        error: loadError('TREE_LOAD_FAILED', `Не удалось загрузить элементы «${element.name}».`, cause),
      };
    }

    const projectedChildren = this.projectElementChildren(element, parsedChildren);
    if (this.disposed) {
      return {
        status: 'disposed',
        error: loadError('TREE_LOAD_DISPOSED', 'Загрузчик дерева уже остановлен.'),
      };
    }
    if (!this.isCurrent(record, element, state, nodeVersion)) {
      return {
        status: 'superseded',
        error: loadError('TREE_LOAD_SUPERSEDED', 'Результат загрузки относится к устаревшему дереву конфигурации.'),
      };
    }

    publishReaderPropertyChanges(element, detachedInput);
    const children = [...projectedChildren];
    for (const previousChild of element.children ?? []) {
      if (!children.includes(previousChild)) {
        this.cache.removeNode(previousChild);
      }
    }
    for (const child of children) {
      child.parent = element;
      this.cache.buildCache(child);
    }
    element.children = children;
    delete element.properties._lazy;
    this.onPublished(element);
    return { status: 'loaded', children };
  }

  private getNodeState(node: TreeNode): NodeLoadState {
    let state = this.nodeStates.get(node);
    if (!state) {
      state = { version: 0 };
      this.nodeStates.set(node, state);
    }
    return state;
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
