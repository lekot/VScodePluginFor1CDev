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

  // 8. Resolve platform executable to get platformBin
  const exe = await resolveLaunchExecutable(entry, 'enterprise');
  if (!exe) {
    // resolveLaunchExecutable already shows an error message
    return;
  }
  const platformBin = path.dirname(exe);

  // 9. Build infobase connection string or name
  // For file infobase: use File=<path> connection string
  // For server infobase: use Srvr=<server>;Ref=<name> connection string
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

  // 10. Build BslLaunchConfiguration. Intentionally NOT setting autoAttachTypes —
  // OQ-1 in the codec audit means encodeSetAutoAttachSettings does not yet match
  // the canonical Messages.cs schema. Setting it here would only trigger a
  // diagnostic warning in BslDebugSession.launchRequest without any benefit.
  // The platform applies its own default once the first target attaches.
  const launchConfig: BslLaunchConfiguration = {
    type: 'bsl',
    request: 'launch',
    name: 'Отладка 1С',
    rootProject: configPath ?? node.filePath ?? '',
    infobase: infobaseArg,
    platformPath: platformBin,
    debugServerHost: 'localhost',
    debugServerPort: 1550,
  };

  // 11. Start DAP launch session — process lifecycle is owned by BslDebugSession
  const started = await vscode.debug.startDebugging(workspaceFolder, launchConfig);
  if (!started) {
    void vscode.window.showErrorMessage('Не удалось запустить отладку 1С');
  }
}
