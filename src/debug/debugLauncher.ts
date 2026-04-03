import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { TreeNode } from '../models/treeNode';
import { BindingManager } from '../bindings/bindingManager';
import { InfobaseStorageService } from '../infobases/infobaseStorageService';
import { MetadataTreeDataProvider } from '../providers/treeDataProvider';
import { resolveLaunchExecutable, buildLaunchArgs, spawnPlatformProcess } from '../services/platformLauncher';
import { resolveConfigurationXmlDirectory } from '../bindings/deployService';
import { Logger } from '../utils/logger';

const DBGS_PORT = 1550;
const DBGS_POLL_INTERVAL_MS = 500;
const DBGS_POLL_TIMEOUT_MS = 5000;

export type StartDebuggingDeps = {
  node: TreeNode;
  bindingManager: BindingManager;
  infobaseStorage: InfobaseStorageService;
  treeDataProvider: MetadataTreeDataProvider;
};

async function waitForDbgs(port: number, timeoutMs: number, exitSignal: { exited: boolean }): Promise<boolean> {
  const url = `http://localhost:${port}/e1crdbg/rdbg`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exitSignal.exited) {
      return false;
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(DBGS_POLL_INTERVAL_MS) });
      if (res.status < 600) {
        return true;
      }
    } catch {
      // not ready yet
    }
    await new Promise<void>((resolve) => setTimeout(resolve, DBGS_POLL_INTERVAL_MS));
  }
  return false;
}

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

  // 3. Find matching binding
  const allBindings = await bindingManager.listAll();
  const localBindings = allBindings.filter((b) => b.workspaceFolder === workspaceFolder.name);

  let matchedBinding: (typeof localBindings)[number] | undefined;
  for (const b of localBindings) {
    const resolved = resolveConfigurationXmlDirectory(workspaceFolder.uri.fsPath, b.configRelativePath);
    if (!resolved.ok) {
      continue;
    }
    const src = path.resolve(resolved.sourceDir);
    if (configPath) {
      const configResolved = path.resolve(configPath);
      if (configResolved === src || configResolved.startsWith(src + path.sep)) {
        matchedBinding = b;
        break;
      }
    } else {
      // fallback: match by node filePath
      const nodeDir = path.resolve(path.dirname(node.filePath));
      if (nodeDir === src || nodeDir.startsWith(src + path.sep)) {
        matchedBinding = b;
        break;
      }
    }
  }

  // 4. No binding found
  if (!matchedBinding) {
    void vscode.window.showWarningMessage(
      'Для конфигурации не найдена привязка базы. Привяжите базу через «Привязать базы…»',
    );
    return;
  }

  // 5. Binding has no infobaseIds
  if (matchedBinding.infobaseIds.length === 0) {
    void vscode.window.showWarningMessage(
      'Для конфигурации нет привязанных баз. Добавьте базу в диалоге привязки.',
    );
    return;
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
    void vscode.window.showWarningMessage(
      'Среди привязанных баз нет подходящей для отладки (требуется файловая или серверная база).',
    );
    return;
  }

  // 8. Resolve platform executable
  const exe = await resolveLaunchExecutable(entry, 'enterprise');
  if (!exe) {
    // resolveLaunchExecutable already shows an error
    return;
  }

  // 10. Derive dbgs path
  const binDir = path.dirname(exe);
  const dbgsName = process.platform === 'win32' ? 'dbgs.exe' : 'dbgs';
  const dbgsPath = path.join(binDir, dbgsName);
  if (!fs.existsSync(dbgsPath)) {
    void vscode.window.showErrorMessage(`dbgs не найден рядом с платформой: ${dbgsPath}`);
    return;
  }

  // 12. Pick port
  const port = DBGS_PORT;

  // 13. Spawn dbgs
  Logger.info(`[debugLauncher] Запуск dbgs: ${dbgsPath} --port=${port}`);
  const exitSignal = { exited: false };
  const dbgsProcess = spawn(dbgsPath, [`--port=${port}`], {
    detached: false,
    stdio: 'pipe',
    windowsHide: true,
  });

  dbgsProcess.on('exit', (code) => {
    exitSignal.exited = true;
    Logger.info(`[debugLauncher] dbgs завершился с кодом ${code}`);
  });

  dbgsProcess.on('error', (err) => {
    exitSignal.exited = true;
    Logger.error('[debugLauncher] Ошибка запуска dbgs', err);
  });

  // 14. Wait for dbgs readiness
  const ready = await waitForDbgs(port, DBGS_POLL_TIMEOUT_MS, exitSignal);
  if (!ready) {
    dbgsProcess.kill();
    void vscode.window.showErrorMessage(
      `Сервер отладки (dbgs) не запустился за ${DBGS_POLL_TIMEOUT_MS / 1000} секунд. Проверьте, не занят ли порт ${port}.`,
    );
    return;
  }

  // 15. Start DAP session
  const debugConfig: vscode.DebugConfiguration = {
    type: 'bsl',
    request: 'attach',
    name: 'Отладка 1С',
    host: 'localhost',
    port: port,
    infobaseAlias: matchedBinding.ibcmdExtensionName ?? undefined,
    autoAttachTargets: true,
    _dbgsPort: port,
    workspaceRoot: configPath ?? node.filePath,
  };

  const started = await vscode.debug.startDebugging(workspaceFolder, debugConfig);

  // 16. If not started — cleanup
  if (!started) {
    dbgsProcess.kill();
    void vscode.window.showErrorMessage('Не удалось запустить сеанс отладки BSL. Проверьте настройки отладчика.');
    return;
  }

  // 17-19. Build 1C client args with credentials and debug flags
  const password = await infobaseStorage.readPasswordSecret(entry.id);
  const creds = entry.user || password
    ? { user: entry.user, password: password ?? undefined }
    : undefined;

  let launchArgs: string[];
  try {
    launchArgs = buildLaunchArgs(entry, 'enterprise', process.platform, creds);
  } catch (err) {
    dbgsProcess.kill();
    void vscode.window.showErrorMessage(
      `Ошибка построения аргументов запуска 1С: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  launchArgs.push('/Debug', '-http', '-attach', '/DebuggerURL', `http://localhost:${port}`);

  // 20. Launch 1C client
  Logger.info(`[debugLauncher] Запуск 1С клиента: ${exe}`);
  spawnPlatformProcess(exe, launchArgs);

  // 21. Register cleanup on session termination
  const disposable = vscode.debug.onDidTerminateDebugSession((session) => {
    if (
      session.configuration.type === 'bsl' &&
      session.configuration._dbgsPort === port
    ) {
      Logger.info('[debugLauncher] Сеанс отладки завершён, останавливаем dbgs');
      dbgsProcess.kill();
      disposable.dispose();
    }
  });
}
