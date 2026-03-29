import * as vscode from 'vscode';
import type { ConfigurationBinding } from './models/configurationBinding';
import { readBindingsForFolder, writeBindingsForFolder } from './bindingStorage';
import { bindingKey, normalizeConfigRelativePath } from './bindingPathUtils';

/** Для тестов и альтернативных окружений (по умолию — workspace VS Code). */
export interface BindingManagerDeps {
  readonly fileSystem?: vscode.FileSystem;
  readonly getWorkspaceFolders?: () => readonly vscode.WorkspaceFolder[] | undefined;
}

function validateBindingInput(b: ConfigurationBinding): void {
  const wf = b.workspaceFolder?.trim() ?? '';
  const cr = b.configRelativePath?.trim() ?? '';
  if (!wf) {
    throw new Error('ConfigurationBinding: workspaceFolder is required');
  }
  if (!cr) {
    throw new Error('ConfigurationBinding: configRelativePath is required');
  }
}

function normalizeBinding(b: ConfigurationBinding): ConfigurationBinding {
  const workspaceFolder = b.workspaceFolder.trim();
  const configRelativePath = normalizeConfigRelativePath(b.configRelativePath);
  const extRaw = typeof b.ibcmdExtensionName === 'string' ? b.ibcmdExtensionName.trim() : '';
  const ibcmdExtensionName = extRaw.length > 0 ? extRaw : undefined;
  const seen = new Set<string>();
  const infobaseIds: string[] = [];
  for (const id of b.infobaseIds) {
    const t = id.trim();
    if (!t || seen.has(t)) {
      continue;
    }
    seen.add(t);
    infobaseIds.push(t);
  }
  return {
    workspaceFolder,
    configRelativePath,
    infobaseIds,
    massDeployment: b.massDeployment === true,
    ibcmdExtensionName,
  };
}

/**
 * CRUD привязок конфигураций к базам (plan §2A #29). Файл на папку: `.vscode/infobase-bindings.json`.
 */
export class BindingManager {
  private readonly fsApi: vscode.FileSystem;
  private readonly getWorkspaceFolders: () => readonly vscode.WorkspaceFolder[] | undefined;

  constructor(deps?: BindingManagerDeps) {
    this.fsApi = deps?.fileSystem ?? vscode.workspace.fs;
    this.getWorkspaceFolders = deps?.getWorkspaceFolders ?? (() => vscode.workspace.workspaceFolders);
  }

  private resolveFolder(workspaceFolderName: string): vscode.WorkspaceFolder | undefined {
    const folders = this.getWorkspaceFolders() ?? [];
    return folders.find((f) => f.name === workspaceFolderName);
  }

  /**
   * Все привязки из всех корневых папок текущего workspace.
   */
  async listAll(): Promise<ConfigurationBinding[]> {
    const folders = this.getWorkspaceFolders() ?? [];
    const out: ConfigurationBinding[] = [];
    for (const folder of folders) {
      const part = await readBindingsForFolder(this.fsApi, folder);
      out.push(...part);
    }
    return out;
  }

  async get(
    workspaceFolderName: string,
    configRelativePath: string,
    ibcmdExtensionName?: string,
  ): Promise<ConfigurationBinding | undefined> {
    const folder = this.resolveFolder(workspaceFolderName);
    if (!folder) {
      return undefined;
    }
    const norm = normalizeConfigRelativePath(configRelativePath);
    const ext = (ibcmdExtensionName ?? '').trim();
    const list = await readBindingsForFolder(this.fsApi, folder);
    return list.find(
      (b) =>
        b.workspaceFolder === workspaceFolderName &&
        normalizeConfigRelativePath(b.configRelativePath) === norm &&
        (b.ibcmdExtensionName ?? '').trim() === ext,
    );
  }

  /**
   * Создаёт или обновляет привязку для пары (workspaceFolder, configRelativePath).
   */
  async upsert(binding: ConfigurationBinding): Promise<void> {
    validateBindingInput(binding);
    const next = normalizeBinding(binding);
    const folder = this.resolveFolder(next.workspaceFolder);
    if (!folder) {
      throw new Error(`Workspace folder not found: "${next.workspaceFolder}"`);
    }
    const list = await readBindingsForFolder(this.fsApi, folder);
    const key = bindingKey(next.workspaceFolder, next.configRelativePath, next.ibcmdExtensionName);
    const mapped = new Map<string, ConfigurationBinding>();
    for (const b of list) {
      const k = bindingKey(b.workspaceFolder, b.configRelativePath, b.ibcmdExtensionName);
      mapped.set(k, normalizeBinding(b));
    }
    mapped.set(key, next);
    await writeBindingsForFolder(this.fsApi, folder, [...mapped.values()]);
  }

  async delete(
    workspaceFolderName: string,
    configRelativePath: string,
    ibcmdExtensionName?: string,
  ): Promise<boolean> {
    const folder = this.resolveFolder(workspaceFolderName);
    if (!folder) {
      return false;
    }
    const norm = normalizeConfigRelativePath(configRelativePath);
    const list = await readBindingsForFolder(this.fsApi, folder);
    const targetKey = bindingKey(workspaceFolderName, norm, ibcmdExtensionName);
    const filtered = list.filter(
      (b) => bindingKey(b.workspaceFolder, b.configRelativePath, b.ibcmdExtensionName) !== targetKey,
    );
    if (filtered.length === list.length) {
      return false;
    }
    await writeBindingsForFolder(this.fsApi, folder, filtered.map((b) => normalizeBinding(b)));
    return true;
  }

  /**
   * Удаляет id базы из всех привязок во всех папках workspace (design §14.2).
   * @returns число привязок, в которых список infobaseIds изменился
   */
  async removeInfobaseFromAllBindings(infobaseId: string): Promise<number> {
    const id = infobaseId.trim();
    if (!id) {
      return 0;
    }
    const folders = this.getWorkspaceFolders() ?? [];
    let touched = 0;
    for (const folder of folders) {
      const list = await readBindingsForFolder(this.fsApi, folder);
      const next: ConfigurationBinding[] = [];
      let folderChanged = false;
      for (const b of list) {
        const ids = b.infobaseIds.filter((x) => x !== id);
        if (ids.length !== b.infobaseIds.length) {
          touched += 1;
          folderChanged = true;
        }
        next.push({ ...b, infobaseIds: ids });
      }
      if (folderChanged) {
        await writeBindingsForFolder(this.fsApi, folder, next.map((x) => normalizeBinding(x)));
      }
    }
    return touched;
  }
}
