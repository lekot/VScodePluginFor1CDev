import * as vscode from 'vscode';
import type { ConfigurationBinding, InfobaseBindingsFileRoot } from './models/configurationBinding';
import { parseBindingsFileJson, serializeBindingsFileJson } from './bindingFileCodec';
import { INFOBASE_BINDINGS_FILE_NAME } from './bindingConstants';
import { Logger } from '../utils/logger';

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder('utf-8');

export { parseBindingsFileJson, serializeBindingsFileJson } from './bindingFileCodec';

export function bindingsFileUri(folder: vscode.WorkspaceFolder): vscode.Uri {
  return vscode.Uri.joinPath(folder.uri, '.vscode', INFOBASE_BINDINGS_FILE_NAME);
}

async function ensureVscodeDir(fs: vscode.FileSystem, folder: vscode.WorkspaceFolder): Promise<void> {
  const vscodeDir = vscode.Uri.joinPath(folder.uri, '.vscode');
  try {
    await fs.createDirectory(vscodeDir);
  } catch {
    // already exists or race — ignore
  }
}

/**
 * Читает привязки из `.vscode/infobase-bindings.json` для одной папки workspace.
 */
export async function readBindingsForFolder(
  fs: vscode.FileSystem,
  folder: vscode.WorkspaceFolder,
): Promise<ConfigurationBinding[]> {
  const uri = bindingsFileUri(folder);
  try {
    const data = await fs.readFile(uri);
    return parseBindingsFileJson(TEXT_DECODER.decode(data)).bindings;
  } catch (err) {
    if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') {
      return [];
    }
    Logger.warn(`bindingStorage: read failed for ${uri.fsPath}`, err);
    return [];
  }
}

/**
 * Записывает полный список привязок для папки workspace (перезапись файла).
 */
export async function writeBindingsForFolder(
  fs: vscode.FileSystem,
  folder: vscode.WorkspaceFolder,
  bindings: ConfigurationBinding[],
): Promise<void> {
  await ensureVscodeDir(fs, folder);
  const uri = bindingsFileUri(folder);
  const body = serializeBindingsFileJson({ schemaVersion: 1, bindings } satisfies InfobaseBindingsFileRoot);
  await fs.writeFile(uri, TEXT_ENCODER.encode(body));
}
