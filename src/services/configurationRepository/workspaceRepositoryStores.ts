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
  type RepositoryBindingStorage,
  type RepositoryStateStorage,
  type RepositoryStoredBinding,
} from './repositoryStores';

const DEFAULT_STATE: RepositoryObservedState = Object.freeze({
  connection: 'unknown',
  locks: Object.freeze({}),
  source: 'unknown',
});

export interface WorkspaceRepositoryStoreOptions {
  readonly getWorkspaceFolders: () => readonly string[];
  readonly globalStorageRoot: string;
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

async function finishAll<T>(operations: readonly Promise<T>[]): Promise<T[]> {
  const outcomes = await Promise.allSettled(operations);
  const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
  if (failure) {
    throw failure.reason;
  }
  return outcomes.map((outcome) => (outcome as PromiseFulfilledResult<T>).value);
}

/**
 * Moves mixed legacy records to the store for their owning workspace. The workspace roots are
 * captured once so a folder change cannot redirect a migration halfway through its copy/delete.
 */
export async function migrateWorkspaceRepositoryStores(
  options: WorkspaceRepositoryStoreOptions,
): Promise<void> {
  const roots = normalizeRoots(options.getWorkspaceFolders());
  const globalRoot = path.resolve(options.globalStorageRoot);
  const sources = candidateRoots(roots, globalRoot);
  const bindingsByTarget = new Map<string, Array<{ source: string; binding: RepositoryStoredBinding }>>();
  for (const source of sources) {
    const bindings = await new RepositoryBindingStore(bindingFile(source, globalRoot)).list();
    for (const binding of bindings) {
      const targetBindings = bindingsByTarget.get(binding.targetKey) ?? [];
      targetBindings.push({ source, binding });
      bindingsByTarget.set(binding.targetKey, targetBindings);
    }
  }

  for (const [targetKey, candidates] of bindingsByTarget) {
    const target = targetFromStoredBinding(candidates[0].binding);
    if (target.key !== targetKey) {
      throw new Error(`Repository binding target key mismatch: ${targetKey}`);
    }
    const destination = storageRootFor(target, roots, globalRoot);
    const destinationBindingStore = new RepositoryBindingStore(bindingFile(destination, globalRoot));
    const destinationStateStore = new RepositoryStateStore(stateFile(destination, globalRoot));
    const destinationBinding = await destinationBindingStore.get(target);
    const destinationState = await destinationStateStore.getStored(target);

    const bindingToMigrate = candidates.find((candidate) => rootKey(candidate.source) !== rootKey(destination));
    if (!destinationBinding && bindingToMigrate) {
      await destinationBindingStore.set(target, {
        repositoryPath: bindingToMigrate.binding.repositoryPath,
        repositoryUser: bindingToMigrate.binding.repositoryUser,
        executionInfobaseId: bindingToMigrate.binding.executionInfobaseId,
      });
    }

    let stateToMigrate = destinationState;
    if (!stateToMigrate) {
      const stateSources = [
        ...candidates.map((candidate) => candidate.source),
        ...sources,
      ].filter((source, index, all) => all.findIndex((candidate) => rootKey(candidate) === rootKey(source)) === index);
      for (const source of stateSources) {
        if (rootKey(source) === rootKey(destination)) {
          continue;
        }
        stateToMigrate = await new RepositoryStateStore(stateFile(source, globalRoot)).getStored(target);
        if (stateToMigrate) {
          break;
        }
      }
      if (stateToMigrate) {
        await destinationStateStore.set(target, stateToMigrate);
      }
    }

    // Source copies remain untouched until the destination binding and its available state are durable.
    await finishAll(candidates
      .filter((candidate) => rootKey(candidate.source) !== rootKey(destination))
      .map(async ({ source }) => {
        await new RepositoryBindingStore(bindingFile(source, globalRoot)).delete(target);
        await new RepositoryStateStore(stateFile(source, globalRoot)).clear(target);
      }));
  }
}

/** Routes repository bindings by their configuration root, independent of workspace order. */
export class WorkspaceRepositoryBindingStore implements RepositoryBindingStorage {
  constructor(private readonly options: WorkspaceRepositoryStoreOptions) {}

  async get(target: RepositoryTarget): Promise<RepositoryBinding | undefined> {
    const roots = normalizeRoots(this.options.getWorkspaceFolders());
    const globalRoot = path.resolve(this.options.globalStorageRoot);
    const destination = storageRootFor(target, roots, globalRoot);
    const sources = [
      destination,
      ...candidateRoots(roots, globalRoot).filter((root) => rootKey(root) !== rootKey(destination)),
    ];
    for (const source of sources) {
      try {
        const binding = await new RepositoryBindingStore(bindingFile(source, globalRoot)).get(target);
        if (binding) {
          return binding;
        }
      } catch (error) {
        if (rootKey(source) === rootKey(destination)) {
          throw error;
        }
      }
    }
    return undefined;
  }

  async list(): Promise<readonly RepositoryStoredBinding[]> {
    const roots = normalizeRoots(this.options.getWorkspaceFolders());
    const globalRoot = path.resolve(this.options.globalStorageRoot);
    const entries = new Map<string, RepositoryStoredBinding>();
    for (const source of candidateRoots(roots, globalRoot)) {
      let bindings: readonly RepositoryStoredBinding[];
      try {
        bindings = await new RepositoryBindingStore(bindingFile(source, globalRoot)).list();
      } catch {
        continue;
      }
      for (const binding of bindings) {
        const target = targetFromStoredBinding(binding);
        const destination = storageRootFor(target, roots, globalRoot);
        // Enumeration only exposes records from their owner; get() remains a legacy fallback
        // while migration is pending or cannot reach its destination.
        if (rootKey(source) !== rootKey(destination)) {
          continue;
        }
        entries.set(binding.targetKey, binding);
      }
    }
    return Object.freeze([...entries.values()]
      .sort((left, right) => left.targetKey.localeCompare(right.targetKey)));
  }

  async set(target: RepositoryTarget, binding: RepositoryBinding): Promise<void> {
    const roots = normalizeRoots(this.options.getWorkspaceFolders());
    const globalRoot = path.resolve(this.options.globalStorageRoot);
    const destination = storageRootFor(target, roots, globalRoot);
    await new RepositoryBindingStore(bindingFile(destination, globalRoot)).set(target, binding);
    await finishAll(candidateRoots(roots, globalRoot)
      .filter((root) => rootKey(root) !== rootKey(destination))
      .map(async (root) => {
        await new RepositoryBindingStore(bindingFile(root, globalRoot)).delete(target);
      }));
  }

  async delete(target: RepositoryTarget): Promise<boolean> {
    const roots = normalizeRoots(this.options.getWorkspaceFolders());
    const globalRoot = path.resolve(this.options.globalStorageRoot);
    const outcomes = await finishAll(candidateRoots(roots, globalRoot).map(async (root) =>
      new RepositoryBindingStore(bindingFile(root, globalRoot)).delete(target)));
    return outcomes.some(Boolean);
  }
}

/** Routes observed repository state with the same workspace ownership and migration rules. */
export class WorkspaceRepositoryStateStore implements RepositoryStateStorage {
  constructor(private readonly options: WorkspaceRepositoryStoreOptions) {}

  async get(target: RepositoryTarget): Promise<RepositoryObservedState> {
    return (await this.getStored(target)) ?? DEFAULT_STATE;
  }

  async getStored(target: RepositoryTarget): Promise<RepositoryObservedState | undefined> {
    const roots = normalizeRoots(this.options.getWorkspaceFolders());
    const globalRoot = path.resolve(this.options.globalStorageRoot);
    const destination = storageRootFor(target, roots, globalRoot);
    const sources = [
      destination,
      ...candidateRoots(roots, globalRoot).filter((root) => rootKey(root) !== rootKey(destination)),
    ];
    for (const source of sources) {
      try {
        const state = await new RepositoryStateStore(stateFile(source, globalRoot)).getStored(target);
        if (state) {
          return state;
        }
      } catch (error) {
        if (rootKey(source) === rootKey(destination)) {
          throw error;
        }
      }
    }
    return undefined;
  }

  async set(target: RepositoryTarget, state: RepositoryObservedState): Promise<void> {
    const roots = normalizeRoots(this.options.getWorkspaceFolders());
    const globalRoot = path.resolve(this.options.globalStorageRoot);
    const destination = storageRootFor(target, roots, globalRoot);
    await new RepositoryStateStore(stateFile(destination, globalRoot)).set(target, state);
    await finishAll(candidateRoots(roots, globalRoot)
      .filter((root) => rootKey(root) !== rootKey(destination))
      .map(async (root) => {
        await new RepositoryStateStore(stateFile(root, globalRoot)).clear(target);
      }));
  }

  async clear(target: RepositoryTarget): Promise<void> {
    const roots = normalizeRoots(this.options.getWorkspaceFolders());
    const globalRoot = path.resolve(this.options.globalStorageRoot);
    await finishAll(candidateRoots(roots, globalRoot).map(async (root) =>
      new RepositoryStateStore(stateFile(root, globalRoot)).clear(target)));
  }
}
