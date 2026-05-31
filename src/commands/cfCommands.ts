import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ExtensionState } from '../state/extensionState';
import { CONFIGURATION_XML } from '../constants/fileNames';
import { MetadataType, type TreeNode } from '../models/treeNode';
import {
  buildCfFromXmlConfiguration,
  decomposeCfToXmlDirectory,
  type BuildCfFromXmlConfigurationParams,
  type CfConfigurationOperationResult,
  type DecomposeCfToXmlDirectoryParams,
} from '../services/cfConfigurationService';
import { emptyDirectoryContents } from '../infobases/ibcmdExportTargetDir';
import { showIbcmdNotFoundDialog } from '../services/ibcmd/showIbcmdNotFoundDialog';

export interface CfCommandsService {
  decomposeCfToXmlDirectory(params: DecomposeCfToXmlDirectoryParams): Promise<CfConfigurationOperationResult>;
  buildCfFromXmlConfiguration(params: BuildCfFromXmlConfigurationParams): Promise<CfConfigurationOperationResult>;
}

export interface RegisterCfCommandsArgs {
  state: ExtensionState;
  service?: CfCommandsService;
}

const DEFAULT_SERVICE: CfCommandsService = {
  decomposeCfToXmlDirectory,
  buildCfFromXmlConfiguration,
};

function getSelectedNode(state: ExtensionState, explicit?: TreeNode): TreeNode | undefined {
  return explicit ?? state.treeView?.selection?.[0];
}

function getConfigRootForNode(state: ExtensionState, node: TreeNode | undefined): string | undefined {
  const provider = state.treeDataProvider;
  return (
    (node ? provider?.getConfigPathForNode?.(node) : undefined) ??
    provider?.getConfigPath?.() ??
    (node?.type === MetadataType.Configuration && node.filePath ? node.filePath : undefined)
  );
}

async function pickCfFileFromDialog(): Promise<string | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: { '1C configuration packages': ['cf', 'cfe'] },
    openLabel: 'Выбрать CF/CFE',
    title: 'Файл конфигурации 1С',
  });
  return picked?.[0]?.fsPath;
}

async function pickXmlOutputDirectory(): Promise<string | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Выбрать каталог',
    title: 'Каталог для разбора CF/CFE в XML',
  });
  return picked?.[0]?.fsPath;
}

async function pickConfigurationRoot(): Promise<string | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Выбрать каталог конфигурации',
    title: 'Каталог XML-конфигурации с Configuration.xml',
  });
  return picked?.[0]?.fsPath;
}

async function pickCfOutputFile(configRoot: string): Promise<string | undefined> {
  const picked = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(path.dirname(configRoot), '1Cv8.cf')),
    filters: { '1C configuration packages': ['cf'] },
    saveLabel: 'Собрать CF',
    title: 'Куда сохранить CF',
  });
  return picked?.fsPath;
}

async function prepareOutputDirectory(dir: string): Promise<boolean> {
  await fs.promises.mkdir(dir, { recursive: true });
  const entries = await fs.promises.readdir(dir);
  if (entries.length === 0) {
    return true;
  }
  const answer = await vscode.window.showWarningMessage(
    `Каталог не пуст (${entries.length} элементов). Для разбора CF/CFE ibcmd нужен пустой каталог. Очистить его и продолжить?`,
    { modal: true },
    'Очистить и продолжить',
    'Отмена',
  );
  if (answer !== 'Очистить и продолжить') {
    return false;
  }
  await emptyDirectoryContents(dir);
  return true;
}

async function copyDirectoryContents(srcDir: string, destDir: string): Promise<void> {
  await fs.promises.mkdir(destDir, { recursive: true });
  for (const entry of await fs.promises.readdir(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirectoryContents(srcPath, destPath);
    } else if (entry.isFile()) {
      await fs.promises.copyFile(srcPath, destPath);
    }
  }
}

function toVscodeCancellation(token: vscode.CancellationToken) {
  return {
    get isCancellationRequested(): boolean {
      return token.isCancellationRequested;
    },
    onCancellationRequested: (listener: () => void) => token.onCancellationRequested(listener),
  };
}

async function showOperationResult(result: CfConfigurationOperationResult): Promise<void> {
  if (result.status === 'success') {
    void vscode.window.showInformationMessage(result.userMessage);
    return;
  }
  if (result.code === 'IBCMD_NOT_FOUND') {
    await showIbcmdNotFoundDialog();
    return;
  }
  void vscode.window.showErrorMessage(result.userMessage);
}

export function registerCfCommands({ state, service = DEFAULT_SERVICE }: RegisterCfCommandsArgs): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('1c-metadata-tree.cf.decompose', async (node?: TreeNode) => {
      const selected = getSelectedNode(state, node);
      const cfPath =
        selected?.type === MetadataType.ConfigurationPackage && selected.filePath
          ? selected.filePath
          : await pickCfFileFromDialog();
      if (!cfPath) {
        return;
      }

      const outDir = await pickXmlOutputDirectory();
      if (!outDir) {
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Разбор ${path.basename(cfPath)} в XML`,
          cancellable: true,
        },
        async (_progress, token) => {
          const stagingRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-cf-decompose-'));
          const stagingOutDir = path.join(stagingRoot, 'xml');
          let copiedToFinal = false;
          try {
            const result = await service.decomposeCfToXmlDirectory({
              cfPath,
              outDir: stagingOutDir,
              token: toVscodeCancellation(token),
            });
            if (result.status !== 'success') {
              await showOperationResult(result);
              return;
            }
            if (!(await prepareOutputDirectory(outDir))) {
              return;
            }
            await copyDirectoryContents(stagingOutDir, outDir);
            copiedToFinal = true;
            await showOperationResult(result);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(
              `Не удалось скопировать результат разбора в выбранный каталог. Staging оставлен здесь: ${stagingOutDir}. ${message}`,
            );
          } finally {
            if (copiedToFinal) {
              await fs.promises.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
            }
          }
        },
      );
    }),

    vscode.commands.registerCommand('1c-metadata-tree.cf.buildFromConfiguration', async (node?: TreeNode) => {
      let configRoot = getConfigRootForNode(state, getSelectedNode(state, node));
      if (!configRoot || !fs.existsSync(path.join(configRoot, CONFIGURATION_XML))) {
        configRoot = await pickConfigurationRoot();
      }
      if (!configRoot) {
        return;
      }

      const outFile = await pickCfOutputFile(configRoot);
      if (!outFile) {
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Сборка CF из ${path.basename(configRoot)}`,
          cancellable: true,
        },
        async (_progress, token) => {
          const result = await service.buildCfFromXmlConfiguration({
            configRoot,
            outFile,
            token: toVscodeCancellation(token),
          });
          await showOperationResult(result);
        },
      );
    }),
  ];
}
