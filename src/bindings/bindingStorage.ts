import * as vscode from 'vscode';
import type { ConfigurationBinding, InfobaseBindingsFileRoot } from './models/configurationBinding';
import { parseBindingsFileJson, serializeBindingsFileJson } from './bindingFileCodec';
import { INFOBASE_BINDINGS_FILE_NAME } from './bindingConstants';
import { Logger } from '../utils/logger';
import { normalizeConfigRelativePath } from './bindingPathUtils';

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder('utf-8');

export { parseBindingsFileJson, serializeBindingsFileJson } from './bindingFileCodec';

export type BindingsFileReadDiagnostic =
  | { readonly kind: 'absent'; readonly uri: vscode.Uri }
  | { readonly kind: 'valid'; readonly uri: vscode.Uri; readonly bindings: readonly ConfigurationBinding[] }
  | { readonly kind: 'invalid'; readonly uri: vscode.Uri; readonly diagnostics: readonly string[] };

function parseBindingsFileStrict(text: string):
  | { readonly kind: 'valid'; readonly bindings: readonly ConfigurationBinding[] }
  | { readonly kind: 'invalid'; readonly diagnostics: readonly string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    return {
      kind: 'invalid',
      diagnostics: [`Некорректный JSON: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'invalid', diagnostics: ['Корень файла привязок должен быть объектом.'] };
  }
  const root = parsed as Record<string, unknown>;
  if (root.schemaVersion !== 1) {
    return {
      kind: 'invalid',
      diagnostics: [`Неподдерживаемая schemaVersion: ${String(root.schemaVersion)}.`],
    };
  }
  if (!Array.isArray(root.bindings)) {
    return { kind: 'invalid', diagnostics: ['Поле bindings должно быть массивом.'] };
  }

  const diagnostics: string[] = [];
  const bindings: ConfigurationBinding[] = [];
  const keys = new Set<string>();
  root.bindings.forEach((candidate, index) => {
    const prefix = `bindings[${index}]`;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      diagnostics.push(`${prefix}: ожидается объект.`);
      return;
    }
    const item = candidate as Record<string, unknown>;
    const workspaceFolder = typeof item.workspaceFolder === 'string' ? item.workspaceFolder.trim() : '';
    const rawConfigPath = typeof item.configRelativePath === 'string' ? item.configRelativePath.trim() : '';
    if (!workspaceFolder) {
      diagnostics.push(`${prefix}.workspaceFolder: ожидается непустая строка.`);
    }
    if (!rawConfigPath) {
      diagnostics.push(`${prefix}.configRelativePath: ожидается непустая строка.`);
    }
    if (!Array.isArray(item.infobaseIds)) {
      diagnostics.push(`${prefix}.infobaseIds: ожидается массив строк.`);
    }
    if (typeof item.massDeployment !== 'boolean') {
      diagnostics.push(`${prefix}.massDeployment: ожидается boolean.`);
    }
    if (item.ibcmdExtensionName !== undefined && typeof item.ibcmdExtensionName !== 'string') {
      diagnostics.push(`${prefix}.ibcmdExtensionName: ожидается строка.`);
    }

    let configRelativePath = '';
    if (rawConfigPath) {
      try {
        configRelativePath = normalizeConfigRelativePath(rawConfigPath);
      } catch (error) {
        diagnostics.push(
          `${prefix}.configRelativePath: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const infobaseIds: string[] = [];
    if (Array.isArray(item.infobaseIds)) {
      item.infobaseIds.forEach((value, idIndex) => {
        if (typeof value !== 'string' || !value.trim()) {
          diagnostics.push(`${prefix}.infobaseIds[${idIndex}]: ожидается непустая строка.`);
          return;
        }
        infobaseIds.push(value.trim());
      });
    }
    const ibcmdExtensionName = typeof item.ibcmdExtensionName === 'string'
      ? item.ibcmdExtensionName.trim() || undefined
      : undefined;
    if (!workspaceFolder || !configRelativePath || !Array.isArray(item.infobaseIds)
      || typeof item.massDeployment !== 'boolean') {
      return;
    }
    const key = `${workspaceFolder}\0${configRelativePath}\0${ibcmdExtensionName ?? ''}`;
    if (keys.has(key)) {
      diagnostics.push(`${prefix}: привязка с тем же workspace/configuration/extension уже объявлена.`);
      return;
    }
    keys.add(key);
    bindings.push({
      workspaceFolder,
      configRelativePath,
      infobaseIds,
      massDeployment: item.massDeployment,
      ibcmdExtensionName,
    });
  });

  return diagnostics.length > 0
    ? { kind: 'invalid', diagnostics }
    : { kind: 'valid', bindings };
}

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
 * Fail-closed read used by support mutations. Unlike {@link readBindingsForFolder}, this API
 * distinguishes a missing file from malformed or unreadable contents.
 */
export async function readBindingsForFolderDiagnostic(
  fs: vscode.FileSystem,
  folder: vscode.WorkspaceFolder,
): Promise<BindingsFileReadDiagnostic> {
  const uri = bindingsFileUri(folder);
  try {
    const data = await fs.readFile(uri);
    const parsed = parseBindingsFileStrict(TEXT_DECODER.decode(data));
    return parsed.kind === 'valid'
      ? { kind: 'valid', uri, bindings: parsed.bindings }
      : { kind: 'invalid', uri, diagnostics: parsed.diagnostics };
  } catch (error) {
    if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
      return { kind: 'absent', uri };
    }
    Logger.warn(`bindingStorage: diagnostic read failed for ${uri.fsPath}`, error);
    return {
      kind: 'invalid',
      uri,
      diagnostics: [`Не удалось прочитать файл привязок: ${error instanceof Error ? error.message : String(error)}`],
    };
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
