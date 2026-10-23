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
  InfobaseConfigurationOperationCancelledError,
  sharedInfobaseConfigurationOperationQueue,
  type InfobaseConfigurationOperationQueue,
} from '../../infobases/infobaseConfigurationOperationQueue';
import type { TreeNode } from '../../models/treeNode';
import type { IbcmdInfobaseOperationResult } from '../ibcmd/ibcmdInfobaseOperationResult';
import {
  ConfigurationRepositoryTransport,
  type ConfigurationRepositoryTransportDeps,
} from './configurationRepositoryTransport';
import {
  RepositorySecretStore,
  repositoryTargetMutationKey,
  type RepositoryBindingStorage,
  type RepositoryStateStorage,
  withRepositoryTargetMutationLock,
  withRepositoryTargetMutationWitness,
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
  ConfigurationRepositoryTransportRequest,
  ConfigurationRepositoryTransportOutcome,
  RepositoryBinding,
  RepositoryCancellation,
  RepositoryObjectReference,
  RepositoryObservedState,
  RepositoryServiceResult,
  RepositoryTarget,
} from './types';
import type { RepositoryStateProjection } from './repositoryTreeDecorations';
import type { RequestConfigurationReload } from '../../reload/requestConfigurationReload';
import {
  RepositoryBindingOwner,
  type RepositoryBindingSnapshot,
  type RepositoryOwnerStage,
} from './repositoryBindingOwner';

export interface ConfigurationRepositoryServiceDeps {
  readonly bindingStore: RepositoryBindingStorage;
  readonly secretStore: RepositorySecretStore;
  readonly stateStore: RepositoryStateStorage;
  readonly infobaseStorage: InfobaseStorageService;
  readonly transport?: ConfigurationRepositoryTransport;
  readonly transportDeps?: ConfigurationRepositoryTransportDeps;
  readonly queue?: InfobaseConfigurationOperationQueue;
  readonly requestConfigurationReload: RequestConfigurationReload;
  readonly importFiles?: typeof runInfobaseConfigIncrementalImport;
  readonly exportObjects?: typeof runInfobaseConfigExportObjects;
  readonly exportConfiguration?: typeof runInfobaseConfigExportToDirectory;
  /** Optional synchronous tree projection; it is never used as platform authority. */
  readonly stateProjection?: RepositoryStateProjection;
  readonly onStateChanged?: (target: RepositoryTarget) => void;
}

type RepositoryTransportServiceRequest = Omit<
  ConfigurationRepositoryTransportRequest,
  'binding' | 'infobaseCredentials' | 'cancellation'
> & {
  readonly binding: RepositoryBinding & { readonly repositoryPassword?: string };
  readonly infobase: InfobaseEntry;
  readonly cancellation: vscode.CancellationToken;
};

/** Orchestrates repository operations while keeping transport/state/tree concerns separate. */
export class ConfigurationRepositoryService {
  private readonly transport: ConfigurationRepositoryTransport;
  private readonly queue: InfobaseConfigurationOperationQueue;
  private readonly bindingOwner: RepositoryBindingOwner;

  constructor(private readonly deps: ConfigurationRepositoryServiceDeps) {
    this.transport = deps.transport ?? new ConfigurationRepositoryTransport(deps.transportDeps);
    this.queue = deps.queue ?? sharedInfobaseConfigurationOperationQueue;
    this.bindingOwner = new RepositoryBindingOwner({
      bindingStore: deps.bindingStore,
      secretStore: deps.secretStore,
      stateStore: deps.stateStore,
      stateProjection: deps.stateProjection,
      onStateChanged: deps.onStateChanged,
    });
  }

  targetForNode(node: TreeNode): RepositoryTarget | undefined {
    return resolveRepositoryTarget(node);
  }

  objectForNode(node: TreeNode, target = resolveRepositoryTarget(node)): RepositoryObjectReference | undefined {
    return target ? resolveRepositoryObject(node, target) : undefined;
  }

  async getObservedState(target: RepositoryTarget): Promise<RepositoryObservedState> {
    return withRepositoryTargetMutationLock(target, async () => {
      const binding = await this.deps.bindingStore.get(target);
      if (!binding) {
        const state = Object.freeze({ connection: 'disconnected' as const, locks: Object.freeze({}), source: 'unknown' as const });
        this.deps.stateProjection?.set(target.key, state);
        return state;
      }
      const state = await this.deps.stateStore.get(target);
      this.deps.stateProjection?.set(target.key, state);
      return state;
    });
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
    onOutput?: (chunk: string) => void,
  ): Promise<RepositoryServiceResult> {
    if (infobase.type !== 'file') {
      return this.failure(target, [], 'Хранилище конфигурации поддерживается только для файловой ИБ.');
    }
    const candidateBinding = Object.freeze({ ...binding, executionInfobaseId: infobase.id });
    return this.runQueued(infobase, target, 'bind', undefined, token, async (identity) => {
      const preparation = await this.bindingOwner.prepareCandidate(target, candidateBinding);
      if (preparation.status === 'failed') {
        return this.failure(
          target,
          [],
          'Не удалось сохранить привязку Хранилища до запуска Конфигуратора.'
          + (preparation.restoreFailed ? ' Предыдущая привязка восстановлена не полностью.' : ''),
        );
      }
      const { previous: snapshot, candidate: candidateOwner } = preparation;
      const transportStage = await this.startOwnedTransport(target, candidateOwner, {
        operation: 'bind', target, infobase, binding: candidateBinding, cancellation: token,
        onOutput,
      });
      if (transportStage.status === 'conflict') {
        return this.targetOwnerChanged(target);
      }
      const outcome = await transportStage.pending;
      if (outcome.status === 'inDoubt') {
        this.queue.quarantine([identity], `${outcome.operation}: ${outcome.errorCode}`);
        const owner = await this.bindingOwner.markUnknownIfOwned(target, candidateOwner, []);
        if (owner === 'conflict') {
          return this.targetOwnerChanged(target);
        }
        return { status: 'inDoubt', target, affectedFullNames: [], message: outcome.message };
      }
      if (outcome.status === 'failed') {
        const restoration = await this.bindingOwner.restoreIfCandidateOwned(target, snapshot, candidateOwner);
        if (restoration.status === 'conflict') {
          return this.targetOwnerChanged(target);
        }
        const restorationSuffix = restoration.status === 'failed'
          ? ` Предыдущая привязка восстановлена не полностью: ${restoration.message}`
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
      const acknowledgement = await this.bindingOwner.acknowledgeStateIfOwned(
        target,
        candidateOwner,
        { resetLocks: true },
      );
      if (acknowledgement.status === 'conflict') {
        return this.targetOwnerChanged(target);
      }
      if (acknowledgement.status === 'failed') {
        return this.postAcknowledgementFailure(
          target,
          `Хранилище подтверждено, но локальное состояние не сохранено: ${safeRepositoryErrorMessage(acknowledgement.error, [candidateBinding.repositoryPassword])}`,
          candidateOwner,
        );
      }
      return this.success(target, [], 'Конфигурация подключена к Хранилищу.');
    });
  }

  async disconnect(
    target: RepositoryTarget,
    token: vscode.CancellationToken,
    force = false,
    onOutput?: (chunk: string) => void,
  ): Promise<RepositoryServiceResult> {
    const infobase = await this.resolveExecutionInfobase(target);
    if (!infobase.entry) {
      return this.failure(target, [], infobase.message);
    }
    const executionInfobase = infobase.entry;
    return this.runQueued(infobase.entry, target, 'unbind', undefined, token, async (identity) => {
      const snapshot = await this.bindingOwner.capture(target);
      if (!snapshot.binding) {
        return this.failure(target, [], 'Для конфигурации не настроено подключение к Хранилищу.');
      }
      if (snapshot.binding.executionInfobaseId !== executionInfobase.id) {
        return this.targetOwnerChanged(target);
      }
      const binding = Object.freeze({ ...snapshot.binding, repositoryPassword: snapshot.password });
      const transportStage = await this.startOwnedTransport(target, snapshot, {
        operation: 'unbind', target, infobase: executionInfobase, binding, force, cancellation: token, onOutput,
      });
      if (transportStage.status === 'conflict') {
        return this.targetOwnerChanged(target);
      }
      const outcome = await transportStage.pending;
      if (outcome.status === 'failed') {
        return this.fromTransport(outcome, target, []);
      }
      if (outcome.status === 'inDoubt') {
        this.queue.quarantine([identity], `${outcome.operation}: ${outcome.errorCode}`);
        const owner = await this.bindingOwner.markUnknownIfOwned(target, snapshot, []);
        if (owner === 'conflict') {
          return this.targetOwnerChanged(target);
        }
        return { status: 'inDoubt', target, affectedFullNames: [], message: outcome.message };
      }
      const cleanup = await this.bindingOwner.clearIfOwned(target, snapshot);
      if (cleanup.status === 'conflict') {
        return this.targetOwnerChanged(target);
      }
      if (cleanup.status === 'failed') {
        return this.postAcknowledgementFailure(
          target,
          'Хранилище отключено, но локальная привязка не очищена.'
            + ` ${safeRepositoryErrorMessage(cleanup.error, [snapshot.password])}`,
          snapshot,
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
    onOutput?: (chunk: string) => void,
  ): Promise<RepositoryServiceResult> {
    return this.runObjectOperation(node, 'lock', token, options.recursive !== false, {
      force: options.revised === true,
    }, onOutput);
  }

  async unlock(
    node: TreeNode,
    token: vscode.CancellationToken,
    options: { readonly recursive?: boolean; readonly force?: boolean } = {},
    onOutput?: (chunk: string) => void,
  ): Promise<RepositoryServiceResult> {
    return this.runObjectOperation(node, 'unlock', token, options.recursive !== false, {
      force: options.force === true,
    }, onOutput);
  }

  async commit(
    node: TreeNode,
    token: vscode.CancellationToken,
    options: { readonly recursive?: boolean; readonly comment?: string; readonly keepLocked?: boolean; readonly force?: boolean } = {},
    onOutput?: (chunk: string) => void,
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
    return this.runQueued(infobase.entry, target, 'commit', [reference], token, async (identity) => {
      const owner = await this.bindingOwner.captureExecutionOwner(target, executionInfobase.id);
      if (owner.status === 'missing') {
        return this.failure(target, [], 'Для конфигурации не настроено подключение к Хранилищу.');
      }
      if (owner.status === 'conflict') {
        return this.targetOwnerChanged(target);
      }
      const { snapshot, binding } = owner;
      const importStage = await this.bindingOwner.startStageIfOwned(target, snapshot, () =>
        (this.deps.importFiles ?? runInfobaseConfigIncrementalImport)({
        storage: this.deps.infobaseStorage,
        entry: executionInfobase,
        configRoot: target.configRoot,
        relativeFiles: reference.relativeFiles,
        token,
        logContext: 'перед помещением в Хранилище',
        ...(target.extensionName ? { ibcmdExtensionName: target.extensionName } : {}),
        onOutput,
        }));
      if (importStage.status === 'conflict') {
        return this.targetOwnerChanged(target);
      }
      const imported = await importStage.pending;
      if (imported.status !== 'success') {
        return this.fromIbcmd(imported, target, reference.relativeFiles, imported.userMessage);
      }
      if (!await this.bindingOwner.matches(target, snapshot)) {
        return this.targetOwnerChanged(target);
      }
      const objects = await writeRepositoryObjectsFile(target, [reference], options.recursive !== false);
      try {
        const transportStage = await this.startOwnedTransport(target, snapshot, {
          operation: 'commit', target, infobase: executionInfobase, binding,
          objectListPath: objects.filePath,
          comment: options.comment,
          keepLocked: options.keepLocked === true,
          force: options.force === true,
          cancellation: token,
          onOutput,
        });
        if (transportStage.status === 'conflict') {
          return this.targetOwnerChanged(target);
        }
        const outcome = await transportStage.pending;
        if (outcome.status !== 'acknowledged') {
          return this.inDoubtOrFailure(outcome, target, objects.fullNames, identity, snapshot);
        }
        const acknowledgement = await this.bindingOwner.acknowledgeStateIfOwned(
          target,
          snapshot,
          {
            fullNames: objects.fullNames,
            lockState: options.keepLocked === true ? 'heldByCurrentCredentials' : 'unlocked',
          },
        );
        if (acknowledgement.status === 'conflict') {
          return this.targetOwnerChanged(target);
        }
        if (acknowledgement.status === 'failed') {
          return this.postAcknowledgementFailure(
            target,
            `Хранилище подтвердило помещение, но локальная синхронизация не завершена: ${safeRepositoryErrorMessage(acknowledgement.error, [binding.repositoryPassword])}`,
            snapshot,
          );
        }
        try {
          await this.reload(target);
        } catch (error) {
          return this.postAcknowledgementFailure(
            target,
            `Хранилище подтвердило помещение, но локальная синхронизация не завершена: ${safeRepositoryErrorMessage(error, [binding.repositoryPassword])}`,
            acknowledgement.owner,
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
    onOutput?: (chunk: string) => void,
  ): Promise<RepositoryServiceResult> {
    return this.runUpdate(node, 'updateObject', token, options.recursive !== false, options.force === true, onOutput);
  }

  async updateConfiguration(
    node: TreeNode,
    token: vscode.CancellationToken,
    force = false,
    onOutput?: (chunk: string) => void,
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
    return this.runQueued(infobase.entry, target, 'updateConfiguration', undefined, token, async (identity) => {
      const owner = await this.bindingOwner.captureExecutionOwner(target, executionInfobase.id);
      if (owner.status === 'missing') {
        return this.failure(target, [], 'Для конфигурации не настроено подключение к Хранилищу.');
      }
      if (owner.status === 'conflict') {
        return this.targetOwnerChanged(target);
      }
      const { snapshot, binding } = owner;
      const transportStage = await this.startOwnedTransport(target, snapshot, {
        operation: 'updateConfiguration', target, infobase: executionInfobase, binding, force, cancellation: token, onOutput,
      });
      if (transportStage.status === 'conflict') {
        return this.targetOwnerChanged(target);
      }
      const outcome = await transportStage.pending;
      if (outcome.status !== 'acknowledged') {
        return this.inDoubtOrFailure(outcome, target, [], identity, snapshot);
      }
      const exportStage = await this.bindingOwner.startStageIfOwned(target, snapshot, () =>
        (this.deps.exportConfiguration ?? runInfobaseConfigExportToDirectory)({
        storage: this.deps.infobaseStorage,
        entry: executionInfobase,
        configRoot: target.configRoot,
        token,
        logContext: 'после обновления из Хранилища',
        ...(target.extensionName ? { ibcmdExtensionName: target.extensionName } : {}),
        onOutput,
        }));
      if (exportStage.status === 'conflict') {
        return this.targetOwnerChanged(target);
      }
      const exported = await exportStage.pending;
      if (exported.status !== 'success') {
        return this.fromIbcmd(exported, target, [], `Хранилище обновлено, но выгрузка файлов не выполнена: ${exported.userMessage}`);
      }
      const acknowledgement = await this.bindingOwner.acknowledgeStateIfOwned(target, snapshot);
      if (acknowledgement.status === 'conflict') {
        return this.targetOwnerChanged(target);
      }
      if (acknowledgement.status === 'failed') {
        return this.postAcknowledgementFailure(
          target,
          `Хранилище подтвердило обновление, но локальное состояние не сохранено: ${safeRepositoryErrorMessage(acknowledgement.error, [binding.repositoryPassword])}`,
          snapshot,
        );
      }
      try {
        await this.reload(target);
      } catch (error) {
        return this.postAcknowledgementFailure(
          target,
          `Хранилище подтвердило обновление, но локальное состояние не сохранено: ${safeRepositoryErrorMessage(error, [binding.repositoryPassword])}`,
          acknowledgement.owner,
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
    onOutput?: (chunk: string) => void,
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
    return this.runQueued(infobase.entry, target, operation, [reference], token, async (identity) => {
      const owner = await this.bindingOwner.captureExecutionOwner(target, executionInfobase.id);
      if (owner.status === 'missing') {
        return this.failure(target, [], 'Для конфигурации не настроено подключение к Хранилищу.');
      }
      if (owner.status === 'conflict') {
        return this.targetOwnerChanged(target);
      }
      const { snapshot, binding } = owner;
      const objects = await writeRepositoryObjectsFile(target, [reference], recursive);
      try {
        const transportStage = await this.startOwnedTransport(target, snapshot, {
          operation, target, infobase: executionInfobase, binding,
          objectListPath: objects.filePath,
          force: extra.force,
          cancellation: token,
          onOutput,
        });
        if (transportStage.status === 'conflict') {
          return this.targetOwnerChanged(target);
        }
        const outcome = await transportStage.pending;
        if (outcome.status !== 'acknowledged') {
          return this.inDoubtOrFailure(outcome, target, objects.fullNames, identity, snapshot);
        }
        const acknowledgement = await this.bindingOwner.acknowledgeStateIfOwned(
          target,
          snapshot,
          {
            fullNames: objects.fullNames,
            lockState: operation === 'lock' ? 'heldByCurrentCredentials' : 'unlocked',
          },
        );
        if (acknowledgement.status === 'conflict') {
          return this.targetOwnerChanged(target);
        }
        if (acknowledgement.status === 'failed') {
          return this.postAcknowledgementFailure(
            target,
            `Хранилище подтвердило операцию, но локальное состояние не сохранено: ${safeRepositoryErrorMessage(acknowledgement.error, [binding.repositoryPassword])}`,
            snapshot,
          );
        }
        try {
          await this.reload(target);
        } catch (error) {
          return this.postAcknowledgementFailure(
            target,
            `Хранилище подтвердило операцию, но локальное состояние не сохранено: ${safeRepositoryErrorMessage(error, [binding.repositoryPassword])}`,
            acknowledgement.owner,
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
    onOutput?: (chunk: string) => void,
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
    return this.runQueued(infobase.entry, target, operation, [reference], token, async (identity) => {
      const owner = await this.bindingOwner.captureExecutionOwner(target, executionInfobase.id);
      if (owner.status === 'missing') {
        return this.failure(target, [], 'Для конфигурации не настроено подключение к Хранилищу.');
      }
      if (owner.status === 'conflict') {
        return this.targetOwnerChanged(target);
      }
      const { snapshot, binding } = owner;
      const objects = await writeRepositoryObjectsFile(target, [reference], recursive);
      try {
        const transportStage = await this.startOwnedTransport(target, snapshot, {
          operation, target, infobase: executionInfobase, binding,
          objectListPath: objects.filePath,
          force,
          cancellation: token,
          onOutput,
        });
        if (transportStage.status === 'conflict') {
          return this.targetOwnerChanged(target);
        }
        const outcome = await transportStage.pending;
        if (outcome.status !== 'acknowledged') {
          return this.inDoubtOrFailure(outcome, target, objects.fullNames, identity, snapshot);
        }
        const exportStage = await this.bindingOwner.startStageIfOwned(target, snapshot, () =>
          (this.deps.exportObjects ?? runInfobaseConfigExportObjects)({
          storage: this.deps.infobaseStorage,
          entry: executionInfobase,
          configRoot: target.configRoot,
          objectIds: [reference.ibcmdFullName],
          token,
          logContext: 'после обновления из Хранилища',
          ...(target.extensionName ? { ibcmdExtensionName: target.extensionName } : {}),
          onOutput,
          }));
        if (exportStage.status === 'conflict') {
          return this.targetOwnerChanged(target);
        }
        const exported = await exportStage.pending;
        if (exported.status !== 'success') {
          return this.fromIbcmd(exported, target, reference.relativeFiles, `Хранилище обновлено, но выгрузка объекта не выполнена: ${exported.userMessage}`);
        }
        const acknowledgement = await this.bindingOwner.acknowledgeStateIfOwned(target, snapshot);
        if (acknowledgement.status === 'conflict') {
          return this.targetOwnerChanged(target);
        }
        if (acknowledgement.status === 'failed') {
          return this.postAcknowledgementFailure(
            target,
            `Хранилище подтвердило обновление, но локальное состояние не сохранено: ${safeRepositoryErrorMessage(acknowledgement.error, [binding.repositoryPassword])}`,
            snapshot,
          );
        }
        try {
          await this.reload(target);
        } catch (error) {
          return this.postAcknowledgementFailure(
            target,
            `Хранилище подтвердило обновление, но локальное состояние не сохранено: ${safeRepositoryErrorMessage(error, [binding.repositoryPassword])}`,
            acknowledgement.owner,
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
    token: vscode.CancellationToken,
    callback: (identity: InfobaseCanonicalIdentity) => Promise<T>,
  ): Promise<T> {
    let identity: InfobaseCanonicalIdentity;
    try {
      identity = await resolveInfobaseCanonicalIdentity(infobase);
    } catch (error) {
      return this.failure(target, references?.map((reference) => reference.repositoryFullName) ?? [], `Не удалось определить физическую ИБ: ${error instanceof Error ? error.message : String(error)}`) as T;
    }
    try {
      return await this.queue.runComposite(
        [identity, `repository-target:${repositoryTargetMutationKey(target)}`],
        () => withRepositoryTargetMutationWitness(target, () => callback(identity)),
        toRepositoryCancellation(token),
      );
    } catch (error) {
      if (error instanceof InfobaseConfigurationOperationCancelledError) {
        return this.cancelled(target, `Операция ${operation} отменена до начала.`) as T;
      }
      return this.failure(target, references?.map((reference) => reference.repositoryFullName) ?? [], `Операция ${operation} не выполнена: ${safeRepositoryErrorMessage(error)}`) as T;
    }
  }

  private async startOwnedTransport(
    target: RepositoryTarget,
    expected: RepositoryBindingSnapshot,
    request: RepositoryTransportServiceRequest,
  ): Promise<RepositoryOwnerStage<ConfigurationRepositoryTransportOutcome>> {
    const infobasePassword = request.infobase.hasStoredPassword
      ? await this.deps.infobaseStorage.readPasswordSecret(request.infobase.id)
      : undefined;
    const user = request.infobase.user?.trim();
    const infobaseCredentials = user || infobasePassword
      ? { user, password: infobasePassword }
      : undefined;
    const transportRequest: ConfigurationRepositoryTransportRequest = {
      ...request,
      ...(infobaseCredentials ? { infobaseCredentials } : {}),
      cancellation: toRepositoryCancellation(request.cancellation),
    };
    return this.bindingOwner.startStageIfOwned(target, expected, () => this.transport.run(transportRequest));
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

  private async postAcknowledgementFailure(
    target: RepositoryTarget,
    message: string,
    expected: RepositoryBindingSnapshot,
  ): Promise<RepositoryServiceResult> {
    try {
      await this.bindingOwner.markUnknownIfOwned(target, expected, []);
    } catch {
      // Keep the acknowledged platform outcome visible if local recovery also fails.
    }
    return { status: 'inDoubt', target, affectedFullNames: [], message };
  }

  private targetOwnerChanged(target: RepositoryTarget): RepositoryServiceResult {
    return {
      status: 'inDoubt',
      target,
      affectedFullNames: [],
      message: 'Владелец привязки или состояния Хранилища изменился во время операции; новые локальные данные сохранены.',
    };
  }

  private async inDoubtOrFailure(
    outcome: ConfigurationRepositoryTransportOutcome,
    target: RepositoryTarget,
    fullNames: readonly string[],
    identity: InfobaseCanonicalIdentity,
    expected: RepositoryBindingSnapshot,
  ): Promise<RepositoryServiceResult> {
    if (outcome.status === 'inDoubt') {
      this.queue.quarantine([identity], `${outcome.operation}: ${outcome.errorCode}`);
      let ownerStatus: 'updated' | 'conflict' | 'failed' = 'failed';
      try {
        ownerStatus = await this.bindingOwner.markUnknownIfOwned(target, expected, fullNames);
      } catch {
        // The physical IB remains quarantined even when the owner cannot be inspected.
      }
      if (ownerStatus === 'conflict') {
        return this.targetOwnerChanged(target);
      }
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
    operation: IbcmdInfobaseOperationResult,
    target: RepositoryTarget,
    files: readonly string[],
    message: string,
  ): RepositoryServiceResult {
    return {
      status: operation.status === 'success'
        ? 'acknowledged'
        : operation.status === 'cancelled'
          ? 'cancelled'
          : operation.status === 'inDoubt' ? 'inDoubt' : 'failed',
      target,
      affectedFullNames: [],
      synchronizedFiles: files,
      message,
      effectPossible: operation.effectPossible,
      termination: operation.termination,
    };
  }

  private async reload(target: RepositoryTarget): Promise<void> {
    await this.deps.requestConfigurationReload(target.configRoot, 'repository');
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

function safeRepositoryErrorMessage(error: unknown, knownSecrets: readonly (string | undefined)[] = []): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of knownSecrets) {
    if (secret) {
      message = message.split(secret).join('<redacted>');
    }
  }
  return message
    .replace(/((?:password|passwd|пароль|access[_-]?token|refresh[_-]?token|token|bearer|secret|authorization)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu, '$1<redacted>')
    .replace(/(--(?:password|token)\s+)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu, '$1<redacted>');
}

function toRepositoryCancellation(token: vscode.CancellationToken): RepositoryCancellation {
  return {
    get isCancellationRequested(): boolean {
      return token.isCancellationRequested;
    },
    onCancellationRequested: (listener) => token.onCancellationRequested(() => listener()),
  };
}
