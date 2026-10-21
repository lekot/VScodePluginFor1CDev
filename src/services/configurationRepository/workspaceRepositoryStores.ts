import * as path from 'path';
import {
  filesystemPathKey,
  isSameOrDescendantPath,
} from '../../utils/configurationPathIdentity';
import type {
  RepositoryBinding,
  RepositoryObservedState,
  RepositoryTarget,
} from './types';
import {
  RepositoryBindingStore,
  RepositoryStateStore,
  repositoryTargetKey,
  repositoryTargetMutationKey,
  withRepositoryTargetMutationLock,
  type RepositoryBindingStorage,
  type RepositoryStateStorage,
  type RepositoryStoredBinding,
} from './repositoryStores';

const DEFAULT_STATE: RepositoryObservedState = Object.freeze({
  connection: 'unknown',
  locks: Object.freeze({}),
  source: 'unknown',
});
const MAX_OWNER_ROUTE_PASSES = 8;
const observedRootsByOptions = new WeakMap<
  WorkspaceRepositoryStoreOptions,
  Map<string, Map<string, string>>
>();

export interface WorkspaceRepositoryStoreOptions {
  readonly getWorkspaceFolders: () => readonly string[];
  readonly globalStorageRoot: string;
}

export interface WorkspaceRepositoryStoreWorkspaceLifecycle {
  handleWorkspaceFoldersChanged(): Promise<void>;
  dispose(): Promise<void>;
}

function rootKey(root: string): string {
  return filesystemPathKey(root);
}

function normalizeRoots(roots: readonly string[]): string[] {
  const unique = new Map<string, string>();
  for (const root of roots) {
    const resolved = path.resolve(root);
    const key = rootKey(resolved);
    if (!unique.has(key)) {
      unique.set(key, resolved);
    }
  }
  return [...unique.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, root]) => root);
}

function ownerRoot(target: RepositoryTarget, roots: readonly string[]): string | undefined {
  return roots
    .filter((root) => isSameOrDescendantPath(root, target.configRoot))
    .sort((left, right) => rootKey(right).length - rootKey(left).length)[0];
}

function storageRootFor(target: RepositoryTarget, roots: readonly string[], globalRoot: string): string {
  return ownerRoot(target, roots) ?? path.resolve(globalRoot);
}

function candidateRoots(roots: readonly string[], globalRoot: string): string[] {
  return normalizeRoots([...roots, globalRoot]);
}

/**
 * Retains only roots previously observed in this store composition's live workspace snapshots.
 * This lets a later owner change finish migration/cleanup without discovering paths from disk metadata.
 */
function observeWorkspaceRoots(
  options: WorkspaceRepositoryStoreOptions,
  target: RepositoryTarget,
  roots: readonly string[] = options.getWorkspaceFolders(),
): string[] {
  let rootsByTarget = observedRootsByOptions.get(options);
  if (!rootsByTarget) {
    rootsByTarget = new Map<string, Map<string, string>>();
    observedRootsByOptions.set(options, rootsByTarget);
  }

  const targetKey = repositoryTargetMutationKey(target);
  let observedRoots = rootsByTarget.get(targetKey);
  if (!observedRoots) {
    observedRoots = new Map<string, string>();
    rootsByTarget.set(targetKey, observedRoots);
  }
  rememberRoots(observedRoots, roots);
  return [...observedRoots.values()];
}

function bindingFile(root: string, globalRoot: string): string {
  return rootKey(root) === rootKey(globalRoot)
    ? path.join(root, 'configuration-repository-bindings.json')
    : path.join(root, '.vscode', 'configuration-repository-bindings.json');
}

function stateFile(root: string, globalRoot: string): string {
  return rootKey(root) === rootKey(globalRoot)
    ? path.join(root, 'configuration-repository-state.json')
    : path.join(root, '.vscode', 'configuration-repository-state.json');
}

function targetFromStoredBinding(binding: RepositoryStoredBinding): RepositoryTarget {
  return {
    configRoot: binding.configRoot,
    configKind: binding.configKind,
    ...(binding.extensionName ? { extensionName: binding.extensionName } : {}),
    key: binding.targetKey,
  };
}

function rememberRoots(knownRoots: Map<string, string>, roots: readonly string[]): void {
  for (const root of normalizeRoots(roots)) {
    const key = rootKey(root);
    if (!knownRoots.has(key)) {
      knownRoots.set(key, root);
    }
  }
}

async function findBinding(
  target: RepositoryTarget,
  destination: string,
  knownRoots: readonly string[],
  globalRoot: string,
): Promise<RepositoryBinding | undefined> {
  return (await findBindingLocation(target, destination, knownRoots, globalRoot))?.value;
}

async function findBindingLocation(
  target: RepositoryTarget,
  destination: string,
  knownRoots: readonly string[],
  globalRoot: string,
): Promise<{ readonly source: string; readonly value: RepositoryBinding } | undefined> {
  const sources = [
    destination,
    ...candidateRoots(knownRoots, globalRoot).filter((root) => rootKey(root) !== rootKey(destination)),
  ];
  for (const source of sources) {
    try {
      const binding = await new RepositoryBindingStore(bindingFile(source, globalRoot)).get(target);
      if (binding) {
        return { source, value: binding };
      }
    } catch (error) {
      if (rootKey(source) === rootKey(destination)) {
        throw error;
      }
    }
  }
  return undefined;
}

async function findState(
  target: RepositoryTarget,
  destination: string,
  knownRoots: readonly string[],
  globalRoot: string,
): Promise<RepositoryObservedState | undefined> {
  return (await findStateLocation(target, destination, knownRoots, globalRoot))?.value;
}

async function findStateLocation(
  target: RepositoryTarget,
  destination: string,
  knownRoots: readonly string[],
  globalRoot: string,
): Promise<{ readonly source: string; readonly value: RepositoryObservedState } | undefined> {
  const sources = [
    destination,
    ...candidateRoots(knownRoots, globalRoot).filter((root) => rootKey(root) !== rootKey(destination)),
  ];
  for (const source of sources) {
    try {
      const state = await new RepositoryStateStore(stateFile(source, globalRoot)).getStored(target);
      if (state) {
        return { source, value: state };
      }
    } catch (error) {
      if (rootKey(source) === rootKey(destination)) {
        throw error;
      }
    }
  }
  return undefined;
}

/**
 * Reconciles both durable values under the shared target lock. Roots are only added from live
 * workspace snapshots or the caller's initial snapshot; persisted target paths never initiate scans.
 */
async function reconcileWorkspaceTarget(
  options: WorkspaceRepositoryStoreOptions,
  target: RepositoryTarget,
  initialRoots: readonly string[],
  explicitBinding?: RepositoryBinding,
  explicitState?: RepositoryObservedState,
): Promise<void> {
  const globalRoot = path.resolve(options.globalStorageRoot);
  const knownRoots = new Map<string, string>();
  rememberRoots(knownRoots, initialRoots);
  let bindingToPreserve = explicitBinding;
  let stateToPreserve = explicitState;

  for (let pass = 0; pass < MAX_OWNER_ROUTE_PASSES; pass += 1) {
    const roots = normalizeRoots(options.getWorkspaceFolders());
    rememberRoots(knownRoots, roots);
    const destination = storageRootFor(target, roots, globalRoot);
    const destinationBindingStore = new RepositoryBindingStore(bindingFile(destination, globalRoot));
    const destinationStateStore = new RepositoryStateStore(stateFile(destination, globalRoot));

    if (explicitBinding === undefined) {
      const destinationBinding = await destinationBindingStore.get(target);
      if (destinationBinding) {
        bindingToPreserve = destinationBinding;
      } else if (bindingToPreserve === undefined) {
        bindingToPreserve = await findBinding(target, destination, [...knownRoots.values()], globalRoot);
      }
    }
    if (explicitState === undefined) {
      const destinationState = await destinationStateStore.getStored(target);
      if (destinationState) {
        stateToPreserve = destinationState;
      } else if (stateToPreserve === undefined) {
        stateToPreserve = await findState(target, destination, [...knownRoots.values()], globalRoot);
      }
    }

    if (bindingToPreserve) {
      await destinationBindingStore.set(target, bindingToPreserve);
    }
    if (stateToPreserve) {
      await destinationStateStore.set(target, stateToPreserve);
    }

    const beforeCleanupRoots = normalizeRoots(options.getWorkspaceFolders());
    rememberRoots(knownRoots, beforeCleanupRoots);
    if (rootKey(storageRootFor(target, beforeCleanupRoots, globalRoot)) !== rootKey(destination)) {
      continue;
    }

    await cleanupForeignCopies(
      target,
      options,
      [...knownRoots.values()],
      destination,
      bindingToPreserve,
      stateToPreserve,
    );

    const afterCleanupRoots = normalizeRoots(options.getWorkspaceFolders());
    rememberRoots(knownRoots, afterCleanupRoots);
    if (rootKey(storageRootFor(target, afterCleanupRoots, globalRoot)) === rootKey(destination)) {
      return;
    }
  }

  throw new Error(`Repository workspace owner kept changing while reconciling ${repositoryTargetKey(target)}.`);
}

async function cleanupForeignCopies(
  target: RepositoryTarget,
  options: WorkspaceRepositoryStoreOptions,
  knownRoots: readonly string[],
  destination: string,
  bindingToPreserve: RepositoryBinding | undefined,
  stateToPreserve: RepositoryObservedState | undefined,
): Promise<void> {
  const globalRoot = path.resolve(options.globalStorageRoot);
  let firstFailure: unknown;
  let hasFailure = false;
  const recordFailure = (error: unknown): void => {
    if (!hasFailure) {
      firstFailure = error;
      hasFailure = true;
    }
  };

  for (const source of candidateRoots(knownRoots, globalRoot)) {
    const beforeDelete = normalizeRoots(options.getWorkspaceFolders());
    const currentDestination = storageRootFor(target, beforeDelete, globalRoot);
    if (rootKey(source) === rootKey(currentDestination)) {
      continue;
    }

    try {
      await new RepositoryBindingStore(bindingFile(source, globalRoot)).delete(target);
    } catch (error) {
      recordFailure(error);
    }

    const afterDeleteRoots = normalizeRoots(options.getWorkspaceFolders());
    if (rootKey(storageRootFor(target, afterDeleteRoots, globalRoot)) === rootKey(source)) {
      try {
        if (bindingToPreserve) {
          await new RepositoryBindingStore(bindingFile(source, globalRoot)).set(target, bindingToPreserve);
        }
        if (stateToPreserve) {
          await new RepositoryStateStore(stateFile(source, globalRoot)).set(target, stateToPreserve);
        }
      } catch (error) {
        recordFailure(error);
      }
      continue;
    }

    try {
      await new RepositoryStateStore(stateFile(source, globalRoot)).clear(target);
    } catch (error) {
      recordFailure(error);
    }
  }

  const latestRoots = normalizeRoots(options.getWorkspaceFolders());
  if (rootKey(storageRootFor(target, latestRoots, globalRoot)) !== rootKey(destination)) {
    return;
  }
  if (hasFailure) {
    throw firstFailure;
  }
}

async function deleteVisibleCopies(
  options: WorkspaceRepositoryStoreOptions,
  target: RepositoryTarget,
  deleteBindings: boolean,
): Promise<boolean> {
  const globalRoot = path.resolve(options.globalStorageRoot);
  const processed = new Set<string>();
  let removed = false;
  let firstFailure: unknown;
  let hasFailure = false;

  for (let pass = 0; pass < MAX_OWNER_ROUTE_PASSES; pass += 1) {
    const roots = normalizeRoots(options.getWorkspaceFolders());
    const sources = candidateRoots(observeWorkspaceRoots(options, target, roots), globalRoot);
    for (const source of sources) {
      const key = rootKey(source);
      if (processed.has(key)) {
        continue;
      }
      processed.add(key);
      try {
        if (deleteBindings) {
          removed = await new RepositoryBindingStore(bindingFile(source, globalRoot)).delete(target) || removed;
        } else {
          await new RepositoryStateStore(stateFile(source, globalRoot)).clear(target);
        }
      } catch (error) {
        if (!hasFailure) {
          firstFailure = error;
          hasFailure = true;
        }
      }
    }

    const afterRoots = normalizeRoots(options.getWorkspaceFolders());
    const unseenSource = candidateRoots(afterRoots, globalRoot)
      .some((source) => !processed.has(rootKey(source)));
    if (!unseenSource) {
      if (hasFailure) {
        throw firstFailure;
      }
      return removed;
    }
  }

  if (hasFailure) {
    throw firstFailure;
  }
  throw new Error(`Repository workspace roots kept changing while deleting ${repositoryTargetKey(target)}.`);
}

/** Migrates the records found in the caller's current workspace snapshot. */
export async function migrateWorkspaceRepositoryStores(
  options: WorkspaceRepositoryStoreOptions,
  trustedPreviousRoots: readonly string[] = [],
): Promise<void> {
  const initialRoots = normalizeRoots([...options.getWorkspaceFolders(), ...trustedPreviousRoots]);
  const globalRoot = path.resolve(options.globalStorageRoot);
  const bindingsByTarget = new Map<string, RepositoryTarget>();
  for (const source of candidateRoots(initialRoots, globalRoot)) {
    const bindings = await new RepositoryBindingStore(bindingFile(source, globalRoot)).list();
    for (const binding of bindings) {
      const target = targetFromStoredBinding(binding);
      if (repositoryTargetKey(target) !== binding.targetKey) {
        throw new Error(`Repository binding target key mismatch: ${binding.targetKey}`);
      }
      bindingsByTarget.set(binding.targetKey, target);
    }
  }

  for (const target of bindingsByTarget.values()) {
    await withRepositoryTargetMutationLock(target, () => {
      const knownRoots = observeWorkspaceRoots(options, target, initialRoots);
      return reconcileWorkspaceTarget(options, target, knownRoots);
    });
  }
}

/**
 * Migrates records from the last known live snapshot when workspace ownership changes. The
 * extension root owns this lifecycle and drains queued migrations during disposal.
 */
export function createWorkspaceRepositoryStoreWorkspaceLifecycle(
  options: WorkspaceRepositoryStoreOptions,
): WorkspaceRepositoryStoreWorkspaceLifecycle {
  let previousRoots = normalizeRoots(options.getWorkspaceFolders());
  let isDisposed = false;
  let eventTail: Promise<void> = Promise.resolve();
  let disposePromise: Promise<void> | undefined;

  return {
    handleWorkspaceFoldersChanged(): Promise<void> {
      if (isDisposed) {
        return eventTail;
      }

      const trustedPreviousRoots = previousRoots;
      previousRoots = normalizeRoots(options.getWorkspaceFolders());
      const operation = eventTail.then(() =>
        migrateWorkspaceRepositoryStores(options, trustedPreviousRoots));
      eventTail = operation.then(() => undefined, () => undefined);
      return operation;
    },
    dispose(): Promise<void> {
      if (disposePromise) {
        return disposePromise;
      }
      isDisposed = true;
      disposePromise = eventTail;
      return disposePromise;
    },
  };
}

/** Routes repository bindings by their configuration root, independent of workspace order. */
export class WorkspaceRepositoryBindingStore implements RepositoryBindingStorage {
  constructor(private readonly options: WorkspaceRepositoryStoreOptions) {}

  async get(target: RepositoryTarget): Promise<RepositoryBinding | undefined> {
    return withRepositoryTargetMutationLock(target, async () => {
      const roots = normalizeRoots(this.options.getWorkspaceFolders());
      const knownRoots = observeWorkspaceRoots(this.options, target, roots);
      const globalRoot = path.resolve(this.options.globalStorageRoot);
      const destination = storageRootFor(target, roots, globalRoot);
      const located = await findBindingLocation(target, destination, roots, globalRoot);
      if (!located || rootKey(located.source) === rootKey(destination)) {
        return located?.value;
      }

      await reconcileWorkspaceTarget(this.options, target, knownRoots);
      const latestRoots = normalizeRoots(this.options.getWorkspaceFolders());
      const latestDestination = storageRootFor(target, latestRoots, globalRoot);
      return findBinding(target, latestDestination, observeWorkspaceRoots(this.options, target, latestRoots), globalRoot);
    });
  }

  async list(): Promise<readonly RepositoryStoredBinding[]> {
    const roots = normalizeRoots(this.options.getWorkspaceFolders());
    const globalRoot = path.resolve(this.options.globalStorageRoot);
    const foreignTargets = new Map<string, RepositoryTarget>();
    for (const source of candidateRoots(roots, globalRoot)) {
      let bindings: readonly RepositoryStoredBinding[];
      try {
        bindings = await new RepositoryBindingStore(bindingFile(source, globalRoot)).list();
      } catch {
        continue;
      }
      for (const binding of bindings) {
        const target = targetFromStoredBinding(binding);
        observeWorkspaceRoots(this.options, target, roots);
        const destination = storageRootFor(target, roots, globalRoot);
        if (rootKey(source) !== rootKey(destination)) {
          foreignTargets.set(repositoryTargetMutationKey(target), target);
        }
      }
    }

    for (const target of foreignTargets.values()) {
      await withRepositoryTargetMutationLock(target, () =>
        reconcileWorkspaceTarget(this.options, target, observeWorkspaceRoots(this.options, target, roots)));
    }

    const latestRoots = normalizeRoots(this.options.getWorkspaceFolders());
    const entries = new Map<string, RepositoryStoredBinding>();
    for (const source of candidateRoots(latestRoots, globalRoot)) {
      let bindings: readonly RepositoryStoredBinding[];
      try {
        bindings = await new RepositoryBindingStore(bindingFile(source, globalRoot)).list();
      } catch {
        continue;
      }
      for (const binding of bindings) {
        const target = targetFromStoredBinding(binding);
        if (rootKey(source) === rootKey(storageRootFor(target, latestRoots, globalRoot))) {
          entries.set(binding.targetKey, binding);
        }
      }
    }
    return Object.freeze([...entries.values()]
      .sort((left, right) => left.targetKey.localeCompare(right.targetKey)));
  }

  async set(target: RepositoryTarget, binding: RepositoryBinding): Promise<void> {
    await withRepositoryTargetMutationLock(target, () =>
      reconcileWorkspaceTarget(this.options, target, observeWorkspaceRoots(this.options, target), binding));
  }

  async delete(target: RepositoryTarget): Promise<boolean> {
    observeWorkspaceRoots(this.options, target);
    return withRepositoryTargetMutationLock(target, () =>
      deleteVisibleCopies(this.options, target, true));
  }
}

/** Routes observed repository state with the same workspace ownership and migration rules. */
export class WorkspaceRepositoryStateStore implements RepositoryStateStorage {
  constructor(private readonly options: WorkspaceRepositoryStoreOptions) {}

  async get(target: RepositoryTarget): Promise<RepositoryObservedState> {
    return (await this.getStored(target)) ?? DEFAULT_STATE;
  }

  async getStored(target: RepositoryTarget): Promise<RepositoryObservedState | undefined> {
    return withRepositoryTargetMutationLock(target, async () => {
      const roots = normalizeRoots(this.options.getWorkspaceFolders());
      const knownRoots = observeWorkspaceRoots(this.options, target, roots);
      const globalRoot = path.resolve(this.options.globalStorageRoot);
      const destination = storageRootFor(target, roots, globalRoot);
      const located = await findStateLocation(target, destination, roots, globalRoot);
      if (!located || rootKey(located.source) === rootKey(destination)) {
        return located?.value;
      }

      await reconcileWorkspaceTarget(this.options, target, knownRoots);
      const latestRoots = normalizeRoots(this.options.getWorkspaceFolders());
      const latestDestination = storageRootFor(target, latestRoots, globalRoot);
      return findState(target, latestDestination, observeWorkspaceRoots(this.options, target, latestRoots), globalRoot);
    });
  }

  async set(target: RepositoryTarget, state: RepositoryObservedState): Promise<void> {
    await withRepositoryTargetMutationLock(target, () =>
      reconcileWorkspaceTarget(this.options, target, observeWorkspaceRoots(this.options, target), undefined, state));
  }

  async clear(target: RepositoryTarget): Promise<void> {
    observeWorkspaceRoots(this.options, target);
    await withRepositoryTargetMutationLock(target, () =>
      deleteVisibleCopies(this.options, target, false).then(() => undefined));
  }
}
