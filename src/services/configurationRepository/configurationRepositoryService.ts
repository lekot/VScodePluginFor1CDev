import * as vscode from 'vscode';
import type { InfobaseEntry } from '../../infobases/models/infobaseEntry';
import type { InfobaseStorageService } from '../../infobases/infobaseStorageService';
import {
  runInfobaseConfigExportObjects,
  runInfobaseConfigExportToDirectory,
  runInfobaseConfigIncrementalImport,
} from '../../infobases/infobaseConfigCommands';
import {
  resolveInfobaseCanonicalIdentity,
  type InfobaseCanonicalIdentity,
} from '../../infobases/infobaseCanonicalIdentity';
import {
  sharedInfobaseConfigurationOperationQueue,
  type InfobaseConfigurationOperationQueue,
} from '../../infobases/infobaseConfigurationOperationQueue';
import type { TreeNode } from '../../models/treeNode';
import {
  ConfigurationRepositoryTransport,
  type ConfigurationRepositoryTransportDeps,
} from './configurationRepositoryTransport';
import {
  RepositoryBindingStore,
  RepositorySecretStore,
  RepositoryStateStore,
} from './repositoryStores';
import {
  resolveRepositoryObject,
  resolveRepositoryTarget,
} from './repositoryObjectResolver';
import {
  writeRepositoryObjectsFile,
} from './repositoryObjectsFileWriter';
import type {
  ConfigurationRepositoryOperation,
  ConfigurationRepositoryTransportOutcome,
  RepositoryBinding,
  RepositoryCancellation,
  RepositoryObjectReference,
  RepositoryObservedState,
  RepositoryServiceResult,
  RepositoryTarget,
} from './types';
import type { RepositoryStateProjection } from './repositoryTreeDecorations';

export interface ConfigurationRepositoryServiceDeps {
  readonly bindingStore: RepositoryBindingStore;
  readonly secretStore: RepositorySecretStore;
  readonly stateStore: RepositoryStateStore;
  readonly infobaseStorage: InfobaseStorageService;
  readonly transport?: ConfigurationRepositoryTransport;
  readonly transportDeps?: ConfigurationRepositoryTransportDeps;
  readonly queue?: InfobaseConfigurationOperationQueue;
  readonly reloadConfiguration?: (configRoot: string) => Promise<void>;
  readonly importFiles?: typeof runInfobaseConfigIncrementalImport;
  readonly exportObjects?: typeof runInfobaseConfigExportObjects;
  readonly exportConfiguration?: typeof runInfobaseConfigExportToDirectory;
  /** Optional synchronous tree projection; it is never used as platform authority. */
  readonly stateProjection?: RepositoryStateProjection;
  readonly onStateChanged?: (target: RepositoryTarget) => void;
}

interface RepositoryBindingSnapshot {
  readonly binding?: RepositoryBinding;
  readonly password?: string;
  readonly state: RepositoryObservedState;
}

/** Orchestrates repository operations while keeping transport/state/tree concerns separate. */
export class ConfigurationRepositoryService {
  private readonly transport: ConfigurationRepositoryTransport;
  private readonly queue: InfobaseConfigurationOperationQueue;

  constructor(private readonly deps: ConfigurationRepositoryServiceDeps) {
    this.transport = deps.transport ?? new ConfigurationRepositoryTransport(deps.transportDeps);
    this.queue = deps.queue ?? sharedInfobaseConfigurationOperationQueue;
  }

  targetForNode(node: TreeNode): RepositoryTarget | undefined {
    return resolveRepositoryTarget(node);
  }

  objectForNode(node: TreeNode, target = resolveRepositoryTarget(node)): RepositoryObjectReference | undefined {
    return target ? resolveRepositoryObject(node, target) : undefined;
  }

  async getObservedState(target: RepositoryTarget): Promise<RepositoryObservedState> {
    const binding = await this.deps.bindingStore.get(target);
    if (!binding) {
      const state = Object.freeze({ connection: 'disconnected' as const, locks: Object.freeze({}), source: 'unknown' as const });
      this.deps.stateProjection?.set(target.key, state);
      return state;
    }
    const state = await this.deps.stateStore.get(target);
    this.deps.stateProjection?.set(target.key, state);
    return state;
  }

  async getBinding(target: RepositoryTarget): Promise<RepositoryBinding | undefined> {
    return this.deps.bindingStore.get(target);
  }

  /** Resolves the persisted execution IB; callers must not choose another base for a bound target. */
  async getExecutionInfobase(target: RepositoryTarget): Promise<InfobaseEntry | undefined> {
    const binding = await this.deps.bindingStore.get(target);
    if (!binding) {
      return undefined;
    }
    const entry = await this.deps.infobaseStorage.getById(binding.executionInfobaseId);
    return entry?.type === 'file' ? entry : undefined;
  }

  async connect(
    target: RepositoryTarget,
    infobase: InfobaseEntry,
    binding: RepositoryBinding & { readonly repositoryPassword?: string },
    token: vscode.CancellationToken,
  ): Promise<RepositoryServiceResult> {
    if (infobase.type !== 'file') {
      return this.failure(target, [], 'Хранилище конфигурации поддерживается только для файловой ИБ.');
    }
    const candidateBinding = Object.freeze({ ...binding, executionInfobaseId: infobase.id });
    return this.runQueued(infobase, target, 'bind', undefined, async (identity) => {
      let snapshot: RepositoryBindingSnapshot | undefined;
      try {
        snapshot = await this.captureBindingSnapshot(target);
        await this.persistCandidateBinding(target, candidateBinding);
      } catch (error) {
        const restoreError = snapshot ? await this.tryRestoreBindingSnapshot(target, snapshot) : undefined;
        return this.failure(
          target,
          [],
          `Не удалось сохранить привязку Хранилища до запуска Конфигуратора: ${error instanceof Error ? error.message : String(error)}`
          + (restoreError ? ` Предыдущая привязка восстановлена не полностью: ${restoreError}` : ''),
        );
      }
      if (!snapshot) {
        return this.failure(target, [], 'Не удалось сохранить снимок прежней привязки Хранилища.');
      }
      const outcome = await this.runTransport({
        operation: 'bind', target, infobase, binding: candidateBinding, cancellation: token,
      });
      if (outcome.status === 'inDoubt') {
        return this.inDoubtOrFailure(outcome, target, [], identity);
      }
      if (outcome.status === 'failed') {
        const restoreError = await this.tryRestoreBindingSnapshot(target, snapshot);
        const restorationSuffix = restoreError
          ? ` Предыдущая привязка восстановлена не полностью: ${restoreError}`
          : '';
        if (outcome.errorCode === 'CONFIGURATOR_CANCELLED_BEFORE_START') {
          return this.cancelled(
            target,
            `Запуск Конфигуратора отменён до начала операции.${restorationSuffix}`,
          );
        }
        const result = this.fromTransport(outcome, target, []);
        return {
          ...result,
          message: `${result.message}${restorationSuffix}`,
        };
      }
      try {
        await this.saveState(target, { connection: 'connected', locks: {}, source: 'configuratorAcknowledgement' });
      } catch (error) {
        return this.postAcknowledgementFailure(
          target,
          `Хранилище подтверждено, но локальное состояние не сохранено: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return this.success(target, [], 'Конфигурация подключена к Хранилищу.');
    });
  }

  async disconnect(
    target: RepositoryTarget,
    token: vscode.CancellationToken,
    force = false,
  ): Promise<RepositoryServiceResult> {
    const infobase = await this.resolveExecutionInfobase(target);
    if (!infobase.entry) {
      return this.failure(target, [], infobase.message);
    }
    const executionInfobase = infobase.entry;
    return this.runQueued(infobase.entry, target, 'unbind', undefined, async (identity) => {
      const binding = await this.loadBinding(target);
      if (!binding) {
        return this.failure(target, [], 'Для конфигурации не настроено подключение к Хранилищу.');
      }
      const outcome = await this.runTransport({
        operation: 'unbind', target, infobase: executionInfobase, binding, force, cancellation: token,
      });
      if (outcome.status !== 'acknowledged') {
        return this.inDoubtOrFailure(outcome, target, [], identity);
      }
      try {
        // Keep the binding until secret/state cleanup succeeds so a partial cleanup
        // remains recoverable through an explicit disconnect retry.
        await this.deps.stateStore.clear(target);
        await this.deps.secretStore.delete(target);
        await this.deps.bindingStore.delete(target);
        this.deps.stateProjection?.delete(target.key);
        this.deps.onStateChanged?.(target);
      } catch (error) {
        return this.postAcknowledgementFailure(
          target,
          `Хранилище отключено, но локальная привязка не очищена: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await this.reload(target);
      return this.success(target, [], 'Конфигурация отключена от Хранилища.');
    });
  }

  async lock(
    node: TreeNode,
    token: vscode.CancellationToken,
    options: { readonly recursive?: boolean; readonly revised?: boolean } = {},
  ): Promise<RepositoryServiceResult> {
    return this.runObjectOperation(node, 'lock', token, options.recursive !== false, {
      force: options.revised === true,
    });
  }

  async unlock(
    node: TreeNode,
    token: vscode.CancellationToken,
    options: { readonly recursive?: boolean; readonly force?: boolean } = {},
  ): Promise<RepositoryServiceResult> {
    return this.runObjectOperation(node, 'unlock', token, options.recursive !== false, {
      force: options.force === true,
    });
  }

  async commit(
    node: TreeNode,
    token: vscode.CancellationToken,
    options: { readonly recursive?: boolean; readonly comment?: string; readonly keepLocked?: boolean; readonly force?: boolean } = {},
  ): Promise<RepositoryServiceResult> {
    const target = resolveRepositoryTarget(node);
    const reference = target ? resolveRepositoryObject(node, target) : undefined;
    if (!target || !reference) {
      return this.failure(target, [], 'Для помещения не удалось определить корневой объект конфигурации.');
    }
    const infobase = await this.resolveExecutionInfobase(target);
    if (!infobase.entry) {
      return this.failure(target, [], infobase.message);
    }
    const executionInfobase = infobase.entry;
    return this.runQueued(infobase.entry, target, 'commit', [reference], async (identity) => {
      const binding = await this.loadBinding(target);
      if (!binding) {
        return this.failure(target, [], 'Для конфигурации не настроено подключение к Хранилищу.');
      }
      const imported = await (this.deps.importFiles ?? runInfobaseConfigIncrementalImport)({
        storage: this.deps.infobaseStorage,
        entry: executionInfobase,
        configRoot: target.configRoot,
        relativeFiles: reference.relativeFiles,
        token,
        logContext: 'перед помещением в Хранилище',
        ...(target.extensionName ? { ibcmdExtensionName: target.extensionName } : {}),
      });
      if (imported.status !== 'success') {
        return this.fromIbcmd(imported.status, target, reference.relativeFiles, imported.userMessage);
      }
      const objects = await writeRepositoryObjectsFile(target, [reference], options.recursive !== false);
      try {
        const outcome = await this.runTransport({
          operation: 'commit', target, infobase: executionInfobase, binding,
          objectListPath: objects.filePath,
          comment: options.comment,
          keepLocked: options.keepLocked === true,
          force: options.force === true,
          cancellation: token,
        });
        if (outcome.status !== 'acknowledged') {
          return this.inDoubtOrFailure(outcome, target, objects.fullNames, identity);
        }
        try {
          await this.updateLocks(target, objects.fullNames, options.keepLocked === true ? 'heldByCurrentCredentials' : 'unlocked');
          await this.reload(target);
        } catch (error) {
          return this.postAcknowledgementFailure(
            target,
            `Хранилище подтвердило помещение, но локальная синхронизация не завершена: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return this.success(target, objects.fullNames, 'Изменения помещены в Хранилище.', reference.relativeFiles);
      } finally {
        await objects.dispose();
      }
    });
  }

  async updateObject(
    node: TreeNode,
    token: vscode.CancellationToken,
    options: { readonly recursive?: boolean; readonly force?: boolean } = {},
  ): Promise<RepositoryServiceResult> {
    return this.runUpdate(node, 'updateObject', token, options.recursive !== false, options.force === true);
  }

  async updateConfiguration(
    node: TreeNode,
    token: vscode.CancellationToken,
    force = false,
  ): Promise<RepositoryServiceResult> {
    const target = resolveRepositoryTarget(node);
    if (!target) {
      return this.failure(undefined, [], 'Не удалось определить корень конфигурации.');
    }
    const infobase = await this.resolveExecutionInfobase(target);
    if (!infobase.entry) {
      return this.failure(target, [], infobase.message);
    }
    const executionInfobase = infobase.entry;
    return this.runQueued(infobase.entry, target, 'updateConfiguration', undefined, async (identity) => {
      const binding = await this.loadBinding(target);
      if (!binding) {
        return this.failure(target, [], 'Для конфигурации не настроено подключение к Хранилищу.');
      }
      const outcome = await this.runTransport({
        operation: 'updateConfiguration', target, infobase: executionInfobase, binding, force, cancellation: token,
      });
      if (outcome.status !== 'acknowledged') {
        return this.inDoubtOrFailure(outcome, target, [], identity);
      }
      const exported = await (this.deps.exportConfiguration ?? runInfobaseConfigExportToDirectory)({
        storage: this.deps.infobaseStorage,
        entry: executionInfobase,
        configRoot: target.configRoot,
        token,
        logContext: 'после обновления из Хранилища',
        ...(target.extensionName ? { ibcmdExtensionName: target.extensionName } : {}),
      });
      if (exported.status !== 'success') {
        return this.fromIbcmd(exported.status, target, [], `Хранилище обновлено, но выгрузка файлов не выполнена: ${exported.userMessage}`);
      }
      try {
        await this.updateConnectionAck(target);
        await this.reload(target);
      } catch (error) {
        return this.postAcknowledgementFailure(
          target,
          `Хранилище подтвердило обновление, но локальное состояние не сохранено: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return this.success(target, [], 'Конфигурация обновлена из Хранилища.');
    });
  }

  private async runObjectOperation(
    node: TreeNode,
    operation: 'lock' | 'unlock',
    token: vscode.CancellationToken,
    recursive: boolean,
    extra: { readonly force: boolean },
  ): Promise<RepositoryServiceResult> {
    const target = resolveRepositoryTarget(node);
    const reference = target ? resolveRepositoryObject(node, target) : undefined;
    if (!target || !reference) {
      return this.failure(target, [], 'Для выбранного узла не удалось определить корневой объект Хранилища.');
    }
    const infobase = await this.resolveExecutionInfobase(target);
    if (!infobase.entry) {
      return this.failure(target, [], infobase.message);
    }
    const executionInfobase = infobase.entry;
    return this.runQueued(infobase.entry, target, operation, [reference], async (identity) => {
      const binding = await this.loadBinding(target);
      if (!binding) {
        return this.failure(target, [], 'Для конфигурации не настроено подключение к Хранилищу.');
      }
      const objects = await writeRepositoryObjectsFile(target, [reference], recursive);
      try {
        const outcome = await this.runTransport({
          operation, target, infobase: executionInfobase, binding,
          objectListPath: objects.filePath,
          force: extra.force,
          cancellation: token,
        });
        if (outcome.status !== 'acknowledged') {
          return this.inDoubtOrFailure(outcome, target, objects.fullNames, identity);
        }
        try {
          await this.updateLocks(target, objects.fullNames, operation === 'lock' ? 'heldByCurrentCredentials' : 'unlocked');
          await this.updateConnectionAck(target);
          await this.reload(target);
        } catch (error) {
          return this.postAcknowledgementFailure(
            target,
            `Хранилище подтвердило операцию, но локальное состояние не сохранено: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return this.success(target, objects.fullNames, operation === 'lock' ? 'Объекты захвачены в Хранилище.' : 'Захват объектов снят.');
      } finally {
        await objects.dispose();
      }
    });
  }

  private async runUpdate(
    node: TreeNode,
    operation: 'updateObject',
    token: vscode.CancellationToken,
    recursive: boolean,
    force: boolean,
  ): Promise<RepositoryServiceResult> {
    const target = resolveRepositoryTarget(node);
    const reference = target ? resolveRepositoryObject(node, target) : undefined;
    if (!target || !reference) {
      return this.failure(target, [], 'Для обновления не удалось определить корневой объект Хранилища.');
    }
    const infobase = await this.resolveExecutionInfobase(target);
    if (!infobase.entry) {
      return this.failure(target, [], infobase.message);
    }
    const executionInfobase = infobase.entry;
    return this.runQueued(infobase.entry, target, operation, [reference], async (identity) => {
      const binding = await this.loadBinding(target);
      if (!binding) {
        return this.failure(target, [], 'Для конфигурации не настроено подключение к Хранилищу.');
      }
      const objects = await writeRepositoryObjectsFile(target, [reference], recursive);
      try {
        const outcome = await this.runTransport({
          operation, target, infobase: executionInfobase, binding,
          objectListPath: objects.filePath,
          force,
          cancellation: token,
        });
        if (outcome.status !== 'acknowledged') {
          return this.inDoubtOrFailure(outcome, target, objects.fullNames, identity);
        }
        const exported = await (this.deps.exportObjects ?? runInfobaseConfigExportObjects)({
          storage: this.deps.infobaseStorage,
          entry: executionInfobase,
          configRoot: target.configRoot,
          objectIds: [reference.ibcmdFullName],
          token,
          logContext: 'после обновления из Хранилища',
          ...(target.extensionName ? { ibcmdExtensionName: target.extensionName } : {}),
        });
        if (exported.status !== 'success') {
          return this.fromIbcmd(exported.status, target, reference.relativeFiles, `Хранилище обновлено, но выгрузка объекта не выполнена: ${exported.userMessage}`);
        }
        try {
          await this.updateConnectionAck(target);
          await this.reload(target);
        } catch (error) {
          return this.postAcknowledgementFailure(
            target,
            `Хранилище подтвердило обновление, но локальное состояние не сохранено: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return this.success(target, objects.fullNames, 'Объект обновлён из Хранилища.', reference.relativeFiles);
      } finally {
        await objects.dispose();
      }
    });
  }

  private async runQueued<T extends RepositoryServiceResult>(
    infobase: InfobaseEntry,
    target: RepositoryTarget,
    operation: ConfigurationRepositoryOperation,
    references: readonly RepositoryObjectReference[] | undefined,
    callback: (identity: InfobaseCanonicalIdentity) => Promise<T>,
  ): Promise<T> {
    let identity: InfobaseCanonicalIdentity;
    try {
      identity = await resolveInfobaseCanonicalIdentity(infobase);
    } catch (error) {
      return this.failure(target, references?.map((reference) => reference.repositoryFullName) ?? [], `Не удалось определить физическую ИБ: ${error instanceof Error ? error.message : String(error)}`) as T;
    }
    try {
      return await this.queue.runExclusive(identity, () => callback(identity));
    } catch (error) {
      return this.failure(target, references?.map((reference) => reference.repositoryFullName) ?? [], `Операция ${operation} не выполнена: ${error instanceof Error ? error.message : String(error)}`) as T;
    }
  }

  private async runTransport(
    request: Omit<import('./types').ConfigurationRepositoryTransportRequest, 'binding' | 'infobaseCredentials' | 'cancellation'> & {
      readonly binding: RepositoryBinding & { readonly repositoryPassword?: string };
      readonly infobase: InfobaseEntry;
      readonly cancellation: vscode.CancellationToken;
    },
  ): Promise<ConfigurationRepositoryTransportOutcome> {
    const infobasePassword = request.infobase.hasStoredPassword
      ? await this.deps.infobaseStorage.readPasswordSecret(request.infobase.id)
      : undefined;
    const user = request.infobase.user?.trim();
    const infobaseCredentials = user || infobasePassword
      ? { user, password: infobasePassword }
      : undefined;
    return this.transport.run({ ...request, infobaseCredentials, cancellation: toRepositoryCancellation(request.cancellation) });
  }

  private async resolveExecutionInfobase(
    target: RepositoryTarget,
  ): Promise<{ readonly entry?: InfobaseEntry; readonly message: string }> {
    const binding = await this.deps.bindingStore.get(target);
    if (!binding) {
      return { message: 'Для конфигурации не настроено подключение к Хранилищу.' };
    }
    const entry = await this.deps.infobaseStorage.getById(binding.executionInfobaseId);
    if (!entry) {
      return {
        message: `Исполняющая ИБ «${binding.executionInfobaseId}» удалена из каталога. Подключите Хранилище заново.`,
      };
    }
    if (entry.type !== 'file') {
      return {
        message: `Исполняющая ИБ «${entry.name}» больше не является файловой. Подключите Хранилище заново.`,
      };
    }
    return { entry, message: '' };
  }

  private async persistCandidateBinding(
    target: RepositoryTarget,
    binding: RepositoryBinding & { readonly repositoryPassword?: string },
  ): Promise<void> {
    await this.deps.bindingStore.set(target, binding);
    if (binding.repositoryPassword) {
      await this.deps.secretStore.set(target, binding.repositoryPassword);
    } else {
      await this.deps.secretStore.delete(target);
    }
    await this.deps.stateStore.set(target, {
      connection: 'unknown',
      locks: {},
      source: 'unknown',
    });
    this.deps.stateProjection?.set(target.key, await this.deps.stateStore.get(target));
    this.deps.onStateChanged?.(target);
  }

  private async captureBindingSnapshot(target: RepositoryTarget): Promise<RepositoryBindingSnapshot> {
    const [binding, password, state] = await Promise.all([
      this.deps.bindingStore.get(target),
      this.deps.secretStore.get(target),
      this.deps.stateStore.get(target),
    ]);
    return Object.freeze({ binding, password, state });
  }

  /**
   * Restores the local pre-connect snapshot. This is deliberately best effort:
   * a storage outage must be reported to the caller, never converted into a
   * false successful bind or a transport quarantine when Designer did not run.
   */
  private async tryRestoreBindingSnapshot(
    target: RepositoryTarget,
    snapshot: RepositoryBindingSnapshot,
  ): Promise<string | undefined> {
    try {
      if (snapshot.binding) {
        await this.deps.bindingStore.set(target, snapshot.binding);
      } else {
        await this.deps.bindingStore.delete(target);
      }
      if (snapshot.password !== undefined) {
        await this.deps.secretStore.set(target, snapshot.password);
      } else {
        await this.deps.secretStore.delete(target);
      }
      if (snapshot.binding) {
        await this.deps.stateStore.set(target, snapshot.state);
        this.deps.stateProjection?.set(target.key, snapshot.state);
      } else {
        await this.deps.stateStore.clear(target);
        this.deps.stateProjection?.delete(target.key);
      }
      this.deps.onStateChanged?.(target);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  private async loadBinding(target: RepositoryTarget): Promise<(RepositoryBinding & { readonly repositoryPassword?: string }) | undefined> {
    const binding = await this.deps.bindingStore.get(target);
    if (!binding) {
      return undefined;
    }
    return Object.freeze({ ...binding, repositoryPassword: await this.deps.secretStore.get(target) });
  }

  private async updateConnectionAck(target: RepositoryTarget): Promise<void> {
    const current = await this.deps.stateStore.get(target);
    await this.saveState(target, { ...current, connection: 'connected', source: 'configuratorAcknowledgement' });
  }

  private async updateLocks(target: RepositoryTarget, fullNames: readonly string[], state: 'heldByCurrentCredentials' | 'unlocked'): Promise<void> {
    const current = await this.deps.stateStore.get(target);
    const locks = { ...current.locks };
    for (const fullName of fullNames) {
      locks[fullName] = state;
    }
    await this.saveState(target, { ...current, connection: 'connected', locks, source: 'configuratorAcknowledgement' });
  }

  private async saveState(
    target: RepositoryTarget,
    state: Omit<RepositoryObservedState, 'lastConfirmedAt'> & { readonly lastConfirmedAt?: string },
  ): Promise<void> {
    const next = Object.freeze({
      ...state,
      locks: Object.freeze({ ...state.locks }),
      lastConfirmedAt: state.lastConfirmedAt ?? new Date().toISOString(),
    });
    await this.deps.stateStore.set(target, next);
    this.deps.stateProjection?.set(target.key, next);
    this.deps.onStateChanged?.(target);
  }

  private async markUnknown(target: RepositoryTarget, fullNames: readonly string[]): Promise<void> {
    const current = await this.deps.stateStore.get(target);
    const locks = { ...current.locks };
    for (const fullName of fullNames) {
      locks[fullName] = 'unknown';
    }
    const next = Object.freeze({
      connection: 'unknown',
      locks: Object.freeze(locks),
      ...(current.lastConfirmedAt ? { lastConfirmedAt: current.lastConfirmedAt } : {}),
      source: 'unknown',
    });
    await this.deps.stateStore.set(target, next);
    this.deps.stateProjection?.set(target.key, next);
    this.deps.onStateChanged?.(target);
  }

  private async postAcknowledgementFailure(
    target: RepositoryTarget,
    message: string,
  ): Promise<RepositoryServiceResult> {
    try {
      await this.markUnknown(target, []);
    } catch {
      // The platform effect is known; a local state outage must not quarantine
      // the physical IB. The next explicit operation can retry projection.
    }
    return { status: 'inDoubt', target, affectedFullNames: [], message };
  }

  private async inDoubtOrFailure(
    outcome: ConfigurationRepositoryTransportOutcome,
    target: RepositoryTarget,
    fullNames: readonly string[],
    identity: InfobaseCanonicalIdentity,
  ): Promise<RepositoryServiceResult> {
    if (outcome.status === 'inDoubt') {
      try {
        await this.markUnknown(target, fullNames);
      } catch {
        // The quarantine below still prevents another mutating operation.
      }
      this.queue.quarantine([identity], `${outcome.operation}: ${outcome.errorCode}`);
      return { status: 'inDoubt', target, affectedFullNames: fullNames, message: outcome.message };
    }
    return this.fromTransport(outcome, target, fullNames);
  }

  private fromTransport(
    outcome: ConfigurationRepositoryTransportOutcome,
    target: RepositoryTarget,
    fullNames: readonly string[],
  ): RepositoryServiceResult {
    return {
      status: outcome.status,
      target,
      affectedFullNames: fullNames,
      message: 'message' in outcome ? outcome.message : `Операция ${outcome.operation} подтверждена.`,
    };
  }

  private fromIbcmd(
    status: 'success' | 'cancelled' | 'error',
    target: RepositoryTarget,
    files: readonly string[],
    message: string,
  ): RepositoryServiceResult {
    return {
      status: status === 'success' ? 'acknowledged' : status === 'cancelled' ? 'cancelled' : 'failed',
      target,
      affectedFullNames: [],
      synchronizedFiles: files,
      message,
    };
  }

  private async reload(target: RepositoryTarget): Promise<void> {
    if (this.deps.reloadConfiguration) {
      await this.deps.reloadConfiguration(target.configRoot);
    }
  }

  private success(
    target: RepositoryTarget | undefined,
    fullNames: readonly string[],
    message: string,
    synchronizedFiles?: readonly string[],
  ): RepositoryServiceResult {
    return {
      status: 'acknowledged',
      target: target ?? {
        configRoot: '',
        configKind: 'cf',
        key: 'cf::',
      },
      affectedFullNames: fullNames,
      ...(synchronizedFiles ? { synchronizedFiles } : {}),
      message,
    };
  }

  private failure(
    target: RepositoryTarget | undefined,
    fullNames: readonly string[],
    message: string,
  ): RepositoryServiceResult {
    return {
      status: 'failed',
      target: target ?? { configRoot: '', configKind: 'cf', key: 'cf::' },
      affectedFullNames: fullNames,
      message,
    };
  }

  private cancelled(
    target: RepositoryTarget,
    message: string,
  ): RepositoryServiceResult {
    return {
      status: 'cancelled',
      target,
      affectedFullNames: [],
      message,
    };
  }
}

function toRepositoryCancellation(token: vscode.CancellationToken): RepositoryCancellation {
  return {
    get isCancellationRequested(): boolean {
      return token.isCancellationRequested;
    },
    onCancellationRequested: (listener) => token.onCancellationRequested(() => listener()),
  };
}
