import * as path from 'path';
import * as vscode from 'vscode';
import { getMetadataTypeDescriptorByRootTag } from '../constants/metadataTypeDescriptors';
import type { TreeNode } from '../models/treeNode';
import type { MetadataTreeDataProvider } from '../providers/treeDataProvider';
import type { ConfigurationRepositoryService } from '../services/configurationRepository/configurationRepositoryService';
import type { RepositoryServiceResult, RepositoryTarget } from '../services/configurationRepository/types';
import { WorkspaceRegistry, WorkspaceRegistryError } from '../services/configurationSession/WorkspaceRegistry';
import type { ConfigurationSession } from '../services/configurationSession/ConfigurationSession';
import type { ConfigurationIdentity } from '../services/configurationSession/types';
import type { InfobaseStorageService } from '../infobases/infobaseStorageService';
import type {
  AgentRepositoryCommitParams,
  AgentRepositoryConnectParams,
  AgentRepositoryDisconnectParams,
  AgentRepositoryLockParams,
  AgentRepositoryStatusData,
  AgentRepositoryUpdateConfigurationParams,
  AgentRepositoryUpdateObjectParams,
  AgentRepositoryUnlockParams,
  AgentResult,
} from './types';
import { AgentTaskManager } from './agentTaskManager';
import type { AgentTaskReceipt } from './agentTaskManager';
import { createProcessOutputLineReporter } from '../services/process/processOutputLineReporter';

export interface AgentRepositoryOperationsDeps {
  readonly getService: () => ConfigurationRepositoryService | null;
  readonly getTreeProvider: () => MetadataTreeDataProvider | null;
  readonly getConfigurationRegistry: () => Promise<WorkspaceRegistry | null>;
  readonly infobaseStorage: InfobaseStorageService | null;
  readonly taskManager: AgentTaskManager;
}

interface RepositoryContext {
  readonly identity: ConfigurationIdentity;
  readonly session: ConfigurationSession;
  readonly target: RepositoryTarget;
  readonly root: TreeNode;
  readonly service: ConfigurationRepositoryService;
  readonly tree: MetadataTreeDataProvider;
}

type ContextResult =
  | { readonly context: RepositoryContext }
  | { readonly failure: AgentResult<never> };

type ObjectContextResult =
  | { readonly context: RepositoryContext; readonly node: TreeNode }
  | { readonly failure: AgentResult<never> };

type RepositoryCommandResult = AgentResult<RepositoryServiceResult | AgentTaskReceipt>;

/** Agent adapters for Designer repository service; commands are rooted in explicit configuration IDs. */
export class AgentRepositoryOperations {
  constructor(private readonly deps: AgentRepositoryOperationsDeps) {}

  async connect(
    params: AgentRepositoryConnectParams,
    requestToken?: vscode.CancellationToken,
    reportStage?: (message: string) => void,
  ): Promise<RepositoryCommandResult> {
    const contextResult = await this.resolveContext(params.configurationId, 'process');
    if ('failure' in contextResult) { return contextResult.failure; }
    const context = contextResult.context;
    const repositoryPath = params.repositoryPath.trim();
    const repositoryUser = params.repositoryUser.trim();
    if (!repositoryPath || !repositoryUser) {
      return { success: false, code: 'INVALID_ARGUMENTS', error: 'Путь и пользователь Хранилища обязательны.' };
    }
    if (!params.executionInfobaseId?.trim()) {
      return { success: false, code: 'INVALID_ARGUMENTS', error: 'Для Хранилища обязателен executionInfobaseId.' };
    }
    const storage = this.deps.infobaseStorage;
    if (!storage) {
      return { success: false, code: 'REPOSITORY_UNAVAILABLE', error: 'Каталог информационных баз не инициализирован.' };
    }
    const infobase = await storage.getById(params.executionInfobaseId);
    if (!infobase || infobase.type !== 'file') {
      return { success: false, code: 'REPOSITORY_INFOBASE_INVALID', error: 'Укажите существующую файловую ИБ из каталога CDT.' };
    }
    return this.runMutation(
      context,
      'agent.repository.connect',
      params.background,
      requestToken,
      'repository.connect',
      async (token, onOutput) => {
        try {
          const result = await context.service.connect(context.target, infobase, {
            repositoryPath,
            repositoryUser,
            executionInfobaseId: infobase.id,
            ...(params.repositoryPassword !== undefined ? { repositoryPassword: params.repositoryPassword } : {}),
          }, token, onOutput);
          const message = redactKnownSecret(result.message, params.repositoryPassword);
          return message === result.message ? result : { ...result, message };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(redactKnownSecret(message, params.repositoryPassword));
        }
      },
      reportStage,
    );
  }

  async disconnect(
    params: AgentRepositoryDisconnectParams,
    requestToken?: vscode.CancellationToken,
    reportStage?: (message: string) => void,
  ): Promise<RepositoryCommandResult> {
    const contextResult = await this.resolveContext(params.configurationId, 'process');
    if ('failure' in contextResult) { return contextResult.failure; }
    const context = contextResult.context;
    return this.runMutation(
      context, 'agent.repository.disconnect', params.background, requestToken, 'repository.disconnect',
      (token, onOutput) => context.service.disconnect(context.target, token, params.force === true, onOutput),
      reportStage,
    );
  }

  async lock(
    params: AgentRepositoryLockParams,
    requestToken?: vscode.CancellationToken,
    reportStage?: (message: string) => void,
  ): Promise<RepositoryCommandResult> {
    const resolved = await this.resolveObjectContext(params.configurationId, params.path, 'process');
    if ('failure' in resolved) { return resolved.failure; }
    const { context, node } = resolved;
    return this.runMutation(
      context, 'agent.repository.lock', params.background, requestToken, 'repository.lock',
      (token, onOutput) => context.service.lock(node, token, { recursive: params.recursive, revised: params.revised }, onOutput),
      reportStage,
    );
  }

  async unlock(
    params: AgentRepositoryUnlockParams,
    requestToken?: vscode.CancellationToken,
    reportStage?: (message: string) => void,
  ): Promise<RepositoryCommandResult> {
    const resolved = await this.resolveObjectContext(params.configurationId, params.path, 'process');
    if ('failure' in resolved) { return resolved.failure; }
    const { context, node } = resolved;
    return this.runMutation(
      context, 'agent.repository.unlock', params.background, requestToken, 'repository.unlock',
      (token, onOutput) => context.service.unlock(node, token, { recursive: params.recursive, force: params.force }, onOutput),
      reportStage,
    );
  }

  async commit(
    params: AgentRepositoryCommitParams,
    requestToken?: vscode.CancellationToken,
    reportStage?: (message: string) => void,
  ): Promise<RepositoryCommandResult> {
    const comment = typeof params.comment === 'string' ? params.comment.trim() : '';
    if (!comment) {
      return { success: false, code: 'INVALID_ARGUMENTS', error: 'Комментарий помещения в Хранилище не может быть пустым.' };
    }
    const resolved = await this.resolveObjectContext(params.configurationId, params.path, 'process');
    if ('failure' in resolved) { return resolved.failure; }
    const { context, node } = resolved;
    return this.runMutation(
      context, 'agent.repository.commit', params.background, requestToken, 'repository.commit',
      (token, onOutput) => context.service.commit(node, token, {
        comment,
        recursive: params.recursive,
        keepLocked: params.keepLocked,
        force: params.force,
      }, onOutput),
      reportStage,
    );
  }

  async updateObject(
    params: AgentRepositoryUpdateObjectParams,
    requestToken?: vscode.CancellationToken,
    reportStage?: (message: string) => void,
  ): Promise<RepositoryCommandResult> {
    const resolved = await this.resolveObjectContext(params.configurationId, params.path, 'process');
    if ('failure' in resolved) { return resolved.failure; }
    const { context, node } = resolved;
    return this.runMutation(
      context, 'agent.repository.updateObject', params.background, requestToken, 'repository.updateObject',
      (token, onOutput) => context.service.updateObject(node, token, { recursive: params.recursive, force: params.force }, onOutput),
      reportStage,
    );
  }

  async updateConfiguration(
    params: AgentRepositoryUpdateConfigurationParams,
    requestToken?: vscode.CancellationToken,
    reportStage?: (message: string) => void,
  ): Promise<RepositoryCommandResult> {
    const contextResult = await this.resolveContext(params.configurationId, 'process');
    if ('failure' in contextResult) { return contextResult.failure; }
    const context = contextResult.context;
    return this.runMutation(
      context, 'agent.repository.updateConfiguration', params.background, requestToken, 'repository.updateConfiguration',
      (token, onOutput) => context.service.updateConfiguration(context.root, token, params.force === true, onOutput),
      reportStage,
    );
  }

  async getStatus(params: { readonly configurationId: string }): Promise<AgentResult<AgentRepositoryStatusData>> {
    const contextResult = await this.resolveContext(params.configurationId, 'read');
    if ('failure' in contextResult) { return contextResult.failure; }
    const { context } = contextResult;
    try {
      const [binding, observedState] = await Promise.all([
        context.service.getBinding(context.target),
        context.service.getObservedState(context.target),
      ]);
      return {
        success: true,
        data: {
          live: false,
          target: context.target,
          ...(binding ? { binding } : {}),
          observedState,
        },
        configurationId: context.identity.configurationId,
      };
    } catch (error) {
      return {
        success: false,
        code: 'REPOSITORY_STATUS_FAILED',
        error: error instanceof Error ? error.message : String(error),
        configurationId: context.identity.configurationId,
      };
    }
  }

  private async runMutation(
    context: RepositoryContext,
    kind: string,
    background: boolean | undefined,
    requestToken: vscode.CancellationToken | undefined,
    stage: string,
    operation: (
      token: vscode.CancellationToken,
      onOutput?: (chunk: string) => void,
    ) => Promise<RepositoryServiceResult>,
    reportStage?: (message: string) => void,
  ): Promise<RepositoryCommandResult> {
    const execute = (
      token: vscode.CancellationToken,
      taskReportStage?: (message: string) => void,
    ): Promise<AgentResult<RepositoryServiceResult>> => {
      const output = createProcessOutputLineReporter((message) => {
        reportStage?.(message);
        taskReportStage?.(message);
      });
      return this.enqueueRepositoryMutation(
        context,
        kind,
        token,
        (operationToken) => operation(operationToken, output.accept),
      ).finally(() => output.flush());
    };
    if (background !== false) {
      return this.deps.taskManager.start(stage, async (token, reportStage) => {
        reportStage(`Начата операция ${stage}.`);
        return execute(token, reportStage);
      });
    }
    if (requestToken?.isCancellationRequested) {
      return { success: false, code: 'REQUEST_CANCELLED', error: 'Запрос отменён до запуска операции.' };
    }
    return execute(requestToken ?? uncancelledToken());
  }

  private async enqueueRepositoryMutation(
    context: RepositoryContext,
    kind: string,
    token: vscode.CancellationToken,
    operation: (token: vscode.CancellationToken) => Promise<RepositoryServiceResult>,
  ): Promise<AgentResult<RepositoryServiceResult>> {
    const outcome = await context.session.enqueue({
      kind,
      cancellation: token,
      execute: async () => repositoryAgentResult(await operation(token)),
      commitWhen: (result) => result.success,
    });
    if (outcome.status === 'committed' || (outcome.status === 'failed' && outcome.value)) {
      return {
        ...outcome.value!,
        configurationId: outcome.configurationId,
        operationId: outcome.operationId,
        snapshotVersion: outcome.snapshotVersion,
      };
    }
    return {
      success: false,
      code: outcome.status === 'conflict' ? outcome.code : outcome.status.toUpperCase(),
      error: outcome.status === 'failed' || outcome.status === 'conflict'
        ? outcome.error?.message ?? 'Операция Хранилища не выполнена.'
        : 'Операция Хранилища отменена до запуска.',
      configurationId: outcome.configurationId,
      operationId: outcome.operationId,
      snapshotVersion: outcome.snapshotVersion,
    };
  }

  private async resolveObjectContext(
    configurationId: string,
    objectPath: string,
    capability: keyof ConfigurationIdentity['capabilities'],
  ): Promise<ObjectContextResult> {
    const base = await this.resolveContext(configurationId, capability);
    if ('failure' in base) { return base; }
    const pathParts = objectPath.split('.');
    if (pathParts.length !== 2 || pathParts.some((part) => !part.trim())) {
      return { failure: { success: false, code: 'INVALID_OBJECT_PATH', error: 'Ожидается корневой путь RootTag.ObjectName.' } };
    }
    const descriptor = getMetadataTypeDescriptorByRootTag(pathParts[0]!);
    if (!descriptor) {
      return { failure: { success: false, code: 'INVALID_OBJECT_PATH', error: `Неизвестный тип метаданных: ${pathParts[0]}.` } };
    }
    const node = await this.findExactRootObject(base.context, descriptor.designerFolder, descriptor.type, pathParts[1]!);
    if (!node || base.context.service.objectForNode(node, base.context.target) === undefined) {
      return { failure: { success: false, code: 'REPOSITORY_OBJECT_NOT_FOUND', error: `Корневой объект «${objectPath}» не найден в выбранной конфигурации.` } };
    }
    return { context: base.context, node };
  }

  private async resolveContext(
    configurationId: string,
    capability: keyof ConfigurationIdentity['capabilities'],
  ): Promise<ContextResult> {
    if (!configurationId?.trim()) {
      return { failure: { success: false, code: 'CONFIGURATION_ID_REQUIRED', error: 'Для операции Хранилища обязателен configurationId.' } };
    }
    const service = this.deps.getService();
    if (!service) {
      return { failure: { success: false, code: 'REPOSITORY_UNAVAILABLE', error: 'Сервис Хранилища не инициализирован.' } };
    }
    const registry = await this.deps.getConfigurationRegistry();
    if (!registry) {
      return { failure: { success: false, code: 'CONFIGURATION_NOT_FOUND', error: 'Реестр конфигураций не инициализирован.' } };
    }
    let identity: ConfigurationIdentity;
    try {
      const session = registry.require(configurationId);
      identity = session.identity;
      if (!identity.capabilities[capability]) {
        return { failure: { success: false, code: 'CONFIGURATION_CAPABILITY_UNSUPPORTED', error: `Конфигурация ${configurationId} не поддерживает ${capability}.` } };
      }
    } catch (error) {
      return { failure: {
        success: false,
        code: error instanceof WorkspaceRegistryError ? error.code : 'CONFIGURATION_NOT_FOUND',
        error: error instanceof Error ? error.message : String(error),
      } };
    }
    const tree = this.deps.getTreeProvider();
    if (!tree) {
      return { failure: { success: false, code: 'REPOSITORY_TREE_UNAVAILABLE', error: 'Дерево метаданных не инициализировано.' } };
    }
    const root = tree.getRootNodes().find((candidate) => {
      const target = service.targetForNode(candidate);
      return target !== undefined && samePath(target.configRoot, identity.rootPath);
    });
    if (!root) {
      return { failure: { success: false, code: 'REPOSITORY_CONFIGURATION_NOT_LOADED', error: `Конфигурация ${configurationId} не загружена в дерево метаданных.` } };
    }
    const target = service.targetForNode(root);
    if (!target) {
      return { failure: { success: false, code: 'REPOSITORY_TARGET_UNAVAILABLE', error: 'Не удалось определить корень Хранилища для конфигурации.' } };
    }
    return { context: { identity, session: registry.require(configurationId), target, root, service, tree } };
  }

  private async findExactRootObject(
    context: RepositoryContext,
    typeFolderId: string,
    type: TreeNode['type'],
    name: string,
  ): Promise<TreeNode | undefined> {
    await context.tree.getChildren(context.root);
    const typeFolder = context.root.children?.find((child) => child.id === typeFolderId)
      ?? await this.findCommonTypeFolder(context, typeFolderId);
    if (!typeFolder) { return undefined; }
    await context.tree.getChildren(typeFolder);
    const matches = (typeFolder.children ?? []).filter((node) => node.type === type && node.name === name);
    return matches.length === 1 ? matches[0] : undefined;
  }

  private async findCommonTypeFolder(context: RepositoryContext, typeFolderId: string): Promise<TreeNode | undefined> {
    const common = context.root.children?.find((child) => child.id === 'Common');
    if (!common) { return undefined; }
    await context.tree.getChildren(common);
    return common.children?.find((child) => child.id === typeFolderId);
  }
}

function repositoryAgentResult(result: RepositoryServiceResult): AgentResult<RepositoryServiceResult> {
  return {
    success: result.status === 'acknowledged',
    code: `REPOSITORY_${result.status.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`,
    error: result.status === 'acknowledged' ? undefined : result.message,
    data: result,
  };
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLocaleLowerCase() === normalizedRight.toLocaleLowerCase()
    : normalizedLeft === normalizedRight;
}

function redactKnownSecret(message: string, secret: string | undefined): string {
  return secret ? message.split(secret).join('<redacted>') : message;
}

function uncancelledToken(): vscode.CancellationToken {
  return {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => undefined }),
  };
}
