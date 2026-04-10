import * as vscode from 'vscode';
import * as path from 'path';
import { TreeNode } from '../models/treeNode';
import { BindingManager } from '../bindings/bindingManager';
import { InfobaseStorageService } from '../infobases/infobaseStorageService';
import { MetadataTreeDataProvider } from '../providers/treeDataProvider';
import { resolveLaunchExecutable } from '../services/platformLauncher';
import { resolveConfigurationXmlDirectory } from '../bindings/deployService';
import { BslLaunchConfiguration } from './types';

export type StartDebuggingDeps = {
  node: TreeNode;
  bindingManager: BindingManager;
  infobaseStorage: InfobaseStorageService;
  treeDataProvider: MetadataTreeDataProvider;
};

export type StartDebuggingFromConfigPathDeps = {
  configPath: string;
  workspaceFolder: vscode.WorkspaceFolder;
  bindingManager: BindingManager;
  infobaseStorage: InfobaseStorageService;
};

/**
 * Core logic: запускает DAP launch session по configPath. Резолвит binding,
 * достаёт инфобазу из каталога, строит BslLaunchConfiguration, вызывает
 * vscode.debug.startDebugging. Возвращает true если startDebugging вернул true.
 *
 * Бросает Error с описательным сообщением если что-то не найдено.
 * Не показывает UI — это ответственность caller'а.
 */
export async function startDebuggingFromConfigPath(deps: StartDebuggingFromConfigPathDeps): Promise<boolean> {
  const { configPath, workspaceFolder, bindingManager, infobaseStorage } = deps;

  // 3. Find matching binding
  const allBindings = await bindingManager.listAll();
  const localBindings = allBindings.filter((b) => b.workspaceFolder === workspaceFolder.name);

  // На Windows пути case-insensitive — драйв буква может прийти как C:\ или c:\
  // (vscode workspaceFolder.uri.fsPath нормализует drive letter в нижний регистр).
  const isWin = process.platform === 'win32';
  const norm = (p: string): string => {
    const r = path.resolve(p);
    return isWin ? r.toLowerCase() : r;
  };

  let matchedBinding: (typeof localBindings)[number] | undefined;
  const configResolved = norm(configPath);
  for (const b of localBindings) {
    const resolved = resolveConfigurationXmlDirectory(workspaceFolder.uri.fsPath, b.configRelativePath);
    if (!resolved.ok) {
      continue;
    }
    const src = norm(resolved.sourceDir);
    if (configResolved === src || configResolved.startsWith(src + path.sep)) {
      matchedBinding = b;
      break;
    }
  }

  // 4. No binding found
  if (!matchedBinding) {
    throw new Error('Для конфигурации не найдена привязка базы. Привяжите базу через «Привязать базы…»');
  }

  // 5. Binding has no infobaseIds
  if (matchedBinding.infobaseIds.length === 0) {
    throw new Error('Для конфигурации нет привязанных баз. Добавьте базу в диалоге привязки.');
  }

  // 6. Load infobase catalog and find first file/server entry
  const catalog = await infobaseStorage.load();
  const catalogById = new Map(catalog.map((e) => [e.id, e] as const));

  let entry: (typeof catalog)[number] | undefined;
  for (const id of matchedBinding.infobaseIds) {
    const e = catalogById.get(id);
    if (e && (e.type === 'file' || e.type === 'server')) {
      entry = e;
      break;
    }
  }

  // 7. No suitable entry
  if (!entry) {
    throw new Error(
      'Среди привязанных баз нет подходящей для отладки (требуется файловая или серверная база).',
    );
  }

  // 8. Resolve platform executable to get platformBin
  const exe = await resolveLaunchExecutable(entry, 'enterprise');
  if (!exe) {
    throw new Error('Не удалось определить путь к платформе 1С для запуска отладки.');
  }
  const platformBin = path.dirname(exe);

  // 9. Build infobase connection string or name
  let infobaseArg: string;
  if (entry.type === 'file') {
    infobaseArg = `File=${entry.filePath}`;
  } else {
    // server type
    const serverEntry = entry as { server?: string; name?: string };
    if (serverEntry.server && serverEntry.name) {
      infobaseArg = `Srvr=${serverEntry.server};Ref=${serverEntry.name}`;
    } else {
      infobaseArg = entry.name ?? '';
    }
  }

  // 10. Build BslLaunchConfiguration
  const launchConfig: BslLaunchConfiguration = {
    type: 'bsl',
    request: 'launch',
    name: 'Отладка 1С',
    rootProject: configPath,
    infobase: infobaseArg,
    platformPath: platformBin,
    debugServerHost: 'localhost',
    debugServerPort: 1550,
  };

  // 11. Start DAP launch session
  return vscode.debug.startDebugging(workspaceFolder, launchConfig);
}

/**
 * Facade: resolves all needed info from the tree node and infobase catalog,
 * then starts a standard DAP "launch" session (type=bsl, request=launch).
 *
 * All process lifecycle (dbgs + 1cv8c) is managed inside BslDebugSession.launchRequest
 * via DebuggeeLauncher. This function does NOT spawn any processes.
 */
export async function startDebugging(deps: StartDebuggingDeps): Promise<void> {
  const { node, bindingManager, infobaseStorage, treeDataProvider } = deps;

  // 1. Get workspace folder from node's filePath
  if (!node.filePath) {
    void vscode.window.showWarningMessage('Не удалось определить путь конфигурации.');
    return;
  }
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(node.filePath));
  if (!workspaceFolder) {
    void vscode.window.showWarningMessage('Не удалось определить папку workspace для выбранного узла.');
    return;
  }

  // 2. Get config path for node
  const configPath = treeDataProvider.getConfigPathForNode(node) ?? treeDataProvider.getConfigPath();

  if (!configPath) {
    void vscode.window.showWarningMessage('Не удалось определить путь конфигурации.');
    return;
  }

  try {
    const started = await startDebuggingFromConfigPath({ configPath, workspaceFolder, bindingManager, infobaseStorage });
    if (!started) {
      void vscode.window.showErrorMessage('Не удалось запустить отладку 1С');
    }
  } catch (err) {
    void vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
  }
}
