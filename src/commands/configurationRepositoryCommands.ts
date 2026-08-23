import * as path from 'path';
import * as vscode from 'vscode';
import type { ExtensionState } from '../state/extensionState';
import type { TreeNode } from '../models/treeNode';
import type { InfobaseEntry } from '../infobases/models/infobaseEntry';
import { getSelectedNode } from '../helpers/commandHelpers';
import { normalizeConfigRelativePath } from '../bindings/bindingPathUtils';
import type { RepositoryServiceResult, RepositoryTarget } from '../services/configurationRepository/types';
import { Logger } from '../utils/logger';

const COMMAND_PREFIX = '1c-metadata-tree.repository.';

/** Registers phase-1 Designer Configuration Repository commands. */
export function registerConfigurationRepositoryCommands(
  state: ExtensionState,
): vscode.Disposable[] {
  const register = (suffix: string, handler: (node?: TreeNode) => Promise<void>): vscode.Disposable => {
    const disposable = vscode.commands.registerCommand(`${COMMAND_PREFIX}${suffix}`, handler);
    return disposable;
  };
  return [
    register('connect', (node) => runConnect(state, getSelectedNode(state, node))),
    register('disconnect', (node) => runOperation(state, getSelectedNode(state, node), 'disconnect')),
    register('lock', (node) => runOperation(state, getSelectedNode(state, node), 'lock')),
    register('unlock', (node) => runOperation(state, getSelectedNode(state, node), 'unlock')),
    register('commit', (node) => runOperation(state, getSelectedNode(state, node), 'commit')),
    register('updateObject', (node) => runOperation(state, getSelectedNode(state, node), 'updateObject')),
    register('updateConfiguration', (node) => runOperation(state, getSelectedNode(state, node), 'updateConfiguration')),
  ];
}

type RepositoryCommand = 'disconnect' | 'lock' | 'unlock' | 'commit' | 'updateObject' | 'updateConfiguration';

async function runConnect(state: ExtensionState, node: TreeNode | undefined): Promise<void> {
  const service = state.configurationRepositoryService;
  const target = node ? service?.targetForNode(node) : undefined;
  if (!service || !node || !target) {
    void vscode.window.showWarningMessage('Выберите конфигурацию или её объект в дереве.');
    return;
  }
  const infobase = await resolveInfobase(state, target);
  if (!infobase) {
    return;
  }
  const repositoryPath = await vscode.window.showInputBox({
    prompt: 'Путь к Хранилищу конфигурации 1С',
    placeHolder: 'например, \\server\repository или C:\\Repository',
    ignoreFocusOut: true,
  });
  if (!repositoryPath?.trim()) {
    return;
  }
  const repositoryUser = await vscode.window.showInputBox({
    prompt: 'Пользователь Хранилища',
    ignoreFocusOut: true,
  });
  if (!repositoryUser?.trim()) {
    return;
  }
  const repositoryPassword = await vscode.window.showInputBox({
    prompt: 'Пароль Хранилища (необязательно)',
    password: true,
    ignoreFocusOut: true,
  });
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Подключение к Хранилищу…', cancellable: true },
    async (_progress, token) => {
      const result = await service.connect(target, infobase, {
        repositoryPath: repositoryPath.trim(),
        repositoryUser: repositoryUser.trim(),
        executionInfobaseId: infobase.id,
        ...(repositoryPassword ? { repositoryPassword } : {}),
      }, token);
      reportResult(result);
    },
  );
}

async function runOperation(
  state: ExtensionState,
  node: TreeNode | undefined,
  operation: RepositoryCommand,
): Promise<void> {
  const service = state.configurationRepositoryService;
  if (!service || !node) {
    void vscode.window.showWarningMessage('Выберите конфигурацию или её объект в дереве.');
    return;
  }
  const target = service.targetForNode(node);
  if (!target) {
    void vscode.window.showWarningMessage('Не удалось определить корень конфигурации для операции Хранилища.');
    return;
  }
  let comment: string | undefined;
  if (operation === 'commit') {
    comment = await vscode.window.showInputBox({
      prompt: 'Комментарий помещения в Хранилище (необязательно)',
      ignoreFocusOut: true,
    });
    if (comment === undefined) {
      return;
    }
  }
  const title = operationTitle(operation);
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `${title}…`, cancellable: true },
    async (_progress, token) => {
      let result: RepositoryServiceResult;
      switch (operation) {
        case 'disconnect':
          result = await service.disconnect(target, token);
          break;
        case 'lock':
          result = await service.lock(node, token);
          break;
        case 'unlock':
          result = await service.unlock(node, token);
          break;
        case 'commit':
          result = await service.commit(node, token, { comment: comment?.trim() || undefined });
          break;
        case 'updateObject':
          result = await service.updateObject(node, token);
          break;
        case 'updateConfiguration':
          result = await service.updateConfiguration(node, token);
          break;
      }
      reportResult(result);
    },
  );
}

async function resolveInfobase(state: ExtensionState, target: RepositoryTarget): Promise<InfobaseEntry | undefined> {
  const storage = state.infobaseStorage;
  if (!storage) {
    void vscode.window.showErrorMessage('Каталог информационных баз не инициализирован.');
    return undefined;
  }
  const entries = (await storage.load()).filter((entry) => entry.type === 'file');
  if (entries.length === 0) {
    void vscode.window.showWarningMessage('Для Хранилища нужна файловая информационная база в каталоге CDT.');
    return undefined;
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(target.configRoot));
  if (workspaceFolder && state.bindingManager) {
    const configXml = path.join(target.configRoot, 'Configuration.xml');
    const relative = normalizeConfigRelativePath(path.relative(workspaceFolder.uri.fsPath, configXml));
    const binding = await state.bindingManager.get(workspaceFolder.name, relative, target.extensionName);
    const bound = binding?.infobaseIds
      .map((id) => entries.find((entry) => entry.id === id))
      .filter((entry): entry is InfobaseEntry => entry !== undefined) ?? [];
    if (bound.length === 1) {
      return bound[0];
    }
    if (bound.length > 1) {
      return chooseInfobase(bound);
    }
  }
  return chooseInfobase(entries);
}

async function chooseInfobase(entries: readonly InfobaseEntry[]): Promise<InfobaseEntry | undefined> {
  const picked = await vscode.window.showQuickPick(
    entries.map((entry) => ({ label: entry.name, description: entry.filePath, entry })),
    { placeHolder: 'Выберите файловую ИБ для операции Хранилища' },
  );
  return picked?.entry;
}

function operationTitle(operation: RepositoryCommand): string {
  const titles: Record<RepositoryCommand, string> = {
    disconnect: 'Отключение от Хранилища',
    lock: 'Захват объекта в Хранилище',
    unlock: 'Снятие захвата объекта',
    commit: 'Помещение изменений в Хранилище',
    updateObject: 'Обновление объекта из Хранилища',
    updateConfiguration: 'Обновление конфигурации из Хранилища',
  };
  return titles[operation];
}

function reportResult(result: RepositoryServiceResult): void {
  const prefix = result.status === 'acknowledged'
    ? 'Хранилище'
    : result.status === 'inDoubt' ? 'Результат неизвестен' : 'Хранилище';
  const message = `${prefix}: ${result.message}`;
  if (result.status === 'acknowledged') {
    void vscode.window.showInformationMessage(message);
  } else if (result.status === 'inDoubt') {
    void vscode.window.showWarningMessage(`${message} Повторите после проверки состояния.`);
  } else if (result.status === 'cancelled') {
    void vscode.window.showInformationMessage(message);
  } else {
    void vscode.window.showErrorMessage(message);
  }
  Logger.info('configurationRepository.command.completed', {
    status: result.status,
    target: result.target.key,
    affectedFullNames: result.affectedFullNames,
  });
}
