import { MetadataType, type TreeNode } from '../../models/treeNode';
import { resolveRepositoryObject, resolveRepositoryTarget } from './repositoryObjectResolver';
import type { RepositoryObservedState } from './types';

/** Synchronous projection used by TreeDataProvider; it never probes Designer. */
export interface RepositoryStateReader {
  get(targetKey: string): RepositoryObservedState | undefined;
}

export interface RepositoryTreeDecoration {
  readonly kind: 'configuration' | 'object';
  readonly state: RepositoryObservedState['connection'];
  readonly lockState?: RepositoryObservedState['locks'][string];
  readonly iconIntent?: 'lock';
  readonly contextTokens: readonly string[];
  readonly tooltip: string;
}

/** Last-known state only: absence/unknown never claims that an object is unlocked. */
export function resolveRepositoryTreeDecoration(
  node: TreeNode,
  reader: RepositoryStateReader | undefined,
): RepositoryTreeDecoration | undefined {
  if (!reader) {
    return undefined;
  }
  const target = resolveRepositoryTarget(node);
  if (!target) {
    return undefined;
  }
  const observed = reader.get(target.key);
  if (!observed) {
    return undefined;
  }
  const reference = resolveRepositoryObject(node, target);
  const confirmation = observed.lastConfirmedAt
    ? ` Последнее подтверждение: ${observed.lastConfirmedAt}.`
    : '';
  if (reference) {
    const lockState = observed.locks[reference.repositoryFullName];
    const locked = lockState === 'heldByCurrentCredentials';
    return {
      kind: 'object',
      state: observed.connection,
      ...(lockState ? { lockState } : {}),
      ...(locked ? { iconIntent: 'lock' as const } : {}),
      contextTokens: locked ? ['repositoryObject', 'repositoryObject.locked'] : ['repositoryObject'],
      tooltip: locked
        ? `Хранилище конфигурации: объект захвачен текущими учётными данными (последнее подтверждённое состояние).${confirmation}`
        : lockState === 'unknown'
          ? `Хранилище конфигурации: состояние захвата неизвестно.${confirmation}`
          : `Хранилище конфигурации: объект не захвачен текущими учётными данными (последнее подтверждённое состояние).${confirmation}`,
    };
  }
  if (node.type !== MetadataType.Configuration && node.type !== MetadataType.Extension) {
    return undefined;
  }
  const stateText = observed.connection === 'connected'
    ? 'подключено'
    : observed.connection === 'disconnected' ? 'отключено' : 'состояние неизвестно';
  return {
    kind: 'configuration',
    state: observed.connection,
    contextTokens: ['repositoryConfiguration', `repositoryConfiguration.${observed.connection}`],
    tooltip: `Хранилище конфигурации: ${stateText}. Состояние последнее подтверждённое; CLI не предоставляет read-only запрос блокировок.${confirmation}`,
  };
}

export class RepositoryStateProjection implements RepositoryStateReader {
  private readonly states = new Map<string, RepositoryObservedState>();

  get(targetKey: string): RepositoryObservedState | undefined {
    return this.states.get(targetKey);
  }

  set(targetKey: string, state: RepositoryObservedState): void {
    this.states.set(targetKey, state);
  }

  delete(targetKey: string): void {
    this.states.delete(targetKey);
  }

  clear(): void {
    this.states.clear();
  }
}
