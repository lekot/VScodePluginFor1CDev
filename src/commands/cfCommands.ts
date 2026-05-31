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
    openLabel: 'Р’С‹Р±СЂР°С‚СЊ CF/CFE',
    title: 'Р¤Р°Р№Р» РєРѕРЅС„РёРіСѓСЂР°С†РёРё 1РЎ',
  });
  return picked?.[0]?.fsPath;
}

async function pickXmlOutputDirectory(): Promise<string | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Р’С‹Р±СЂР°С‚СЊ РєР°С‚Р°Р»РѕРі',
    title: 'РљР°С‚Р°Р»РѕРі РґР»СЏ СЂР°Р·Р±РѕСЂР° CF/CFE РІ XML',
  });
  return picked?.[0]?.fsPath;
}

async function pickConfigurationRoot(): Promise<string | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Р’С‹Р±СЂР°С‚СЊ РєР°С‚Р°Р»РѕРі РєРѕРЅС„РёРіСѓСЂР°С†РёРё',
    title: 'РљР°С‚Р°Р»РѕРі XML-РєРѕРЅС„РёРіСѓСЂР°С†РёРё СЃ Configuration.xml',
  });
  return picked?.[0]?.fsPath;
}

async function pickCfOutputFile(configRoot: string): Promise<string | undefined> {
  const picked = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(path.dirname(configRoot), '1Cv8.cf')),
    filters: { '1C configuration packages': ['cf'] },
    saveLabel: 'РЎРѕР±СЂР°С‚СЊ CF',
    title: 'РљСѓРґР° СЃРѕС…СЂР°РЅРёС‚СЊ CF',
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
    `РљР°С‚Р°Р»РѕРі РЅРµ РїСѓСЃС‚ (${entries.length} СЌР»РµРјРµРЅС‚РѕРІ). Р”Р»СЏ СЂР°Р·Р±РѕСЂР° CF/CFE ibcmd РЅСѓР¶РµРЅ РїСѓСЃС‚РѕР№ РєР°С‚Р°Р»РѕРі. РћС‡РёСЃС‚РёС‚СЊ РµРіРѕ Рё РїСЂРѕРґРѕР»Р¶РёС‚СЊ?`,
    { modal: true },
    'РћС‡РёСЃС‚РёС‚СЊ Рё РїСЂРѕРґРѕР»Р¶РёС‚СЊ',
    'РћС‚РјРµРЅР°',
  );
  if (answer !== 'РћС‡РёСЃС‚РёС‚СЊ Рё РїСЂРѕРґРѕР»Р¶РёС‚СЊ') {
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
          title: `Р Р°Р·Р±РѕСЂ ${path.basename(cfPath)} РІ XML`,
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
              `РќРµ СѓРґР°Р»РѕСЃСЊ СЃРєРѕРїРёСЂРѕРІР°С‚СЊ СЂРµР·СѓР»СЊС‚Р°С‚ СЂР°Р·Р±РѕСЂР° РІ РІС‹Р±СЂР°РЅРЅС‹Р№ РєР°С‚Р°Р»РѕРі. Staging РѕСЃС‚Р°РІР»РµРЅ Р·РґРµСЃСЊ: ${stagingOutDir}. ${message}`,
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
          title: `РЎР±РѕСЂРєР° CF РёР· ${path.basename(configRoot)}`,
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
