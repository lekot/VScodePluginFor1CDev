import * as vscode from 'vscode';
import type { InfobaseEntry, InfobaseEntryType } from './models/infobaseEntry';
import { formatServerConnectionString } from './models/connectionString';
import { InfobaseStorageService } from './infobaseStorageService';
import { Logger } from '../utils/logger';

/** Explorer view id (package.json `views.explorer`). */
export const INFOBASE_TREE_VIEW_ID = '1c-infobase-manager';

export type InfobaseTreeGroupKind = InfobaseEntryType;

export interface InfobaseTreeGroup {
  readonly kind: 'group';
  readonly group: InfobaseTreeGroupKind;
}

export interface InfobaseTreeEntry {
  readonly kind: 'entry';
  readonly entry: InfobaseEntry;
}

export type InfobaseTreeNode = InfobaseTreeGroup | InfobaseTreeEntry;

const GROUP_LABEL: Record<InfobaseTreeGroupKind, string> = {
  file: '📁 Файловые базы',
  server: '📁 Серверные базы',
  web: '📁 Веб-базы',
};

function contextValueForEntry(type: InfobaseEntryType): string {
  switch (type) {
    case 'file':
      return 'infobaseFile';
    case 'server':
      return 'infobaseServer';
    case 'web':
      return 'infobaseWeb';
    default:
      return 'infobaseFile';
  }
}

function contextValueForGroup(kind: InfobaseTreeGroupKind): string {
  switch (kind) {
    case 'file':
      return 'infobaseGroupFile';
    case 'server':
      return 'infobaseGroupServer';
    case 'web':
      return 'infobaseGroupWeb';
    default:
      return 'infobaseGroupFile';
  }
}

/** Secondary label in the tree (design §6.2: path / Srvr:Ref / URL next to the name). */
export function infobaseEntryDescription(entry: InfobaseEntry): string {
  if (entry.type === 'file') {
    const p = entry.filePath ?? entry.ibcmdConfigYamlPath;
    return p ? p : '';
  }
  if (entry.type === 'server') {
    const s = entry.server ?? '';
    const d = entry.database ?? '';
    return s && d ? `${s}:${d}` : s || d || '';
  }
  return entry.webUrl ?? '';
}

function entryTooltip(entry: InfobaseEntry): string {
  const lines: string[] = [entry.name];
  if (entry.type === 'file') {
    if (entry.filePath) {
      lines.push(`Путь: ${entry.filePath}`);
    }
    if (entry.ibcmdConfigYamlPath) {
      lines.push(`YAML ibcmd: ${entry.ibcmdConfigYamlPath}`);
    }
  } else if (entry.type === 'server') {
    if (entry.server && entry.database) {
      lines.push(formatServerConnectionString({ server: entry.server, ref: entry.database, user: entry.user }));
    } else {
      if (entry.server) {
        lines.push(`Сервер: ${entry.server}`);
      }
      if (entry.database) {
        lines.push(`База: ${entry.database}`);
      }
      if (entry.user) {
        lines.push(`Пользователь: ${entry.user}`);
      }
    }
  } else if (entry.type === 'web' && entry.webUrl) {
    lines.push(`URL: ${entry.webUrl}`);
  }
  return lines.join('\n');
}

/**
 * WOW Infobase Manager — tree under Explorer (design §6.2–6.4, plan §1C).
 */
export class InfobaseTreeDataProvider implements vscode.TreeDataProvider<InfobaseTreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<InfobaseTreeNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly storage: InfobaseStorageService) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: InfobaseTreeNode): vscode.TreeItem {
    if (element.kind === 'group') {
      const item = new vscode.TreeItem(GROUP_LABEL[element.group], vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue = contextValueForGroup(element.group);
      item.iconPath = new vscode.ThemeIcon('folder');
      return item;
    }

    const { entry } = element;
    const item = new vscode.TreeItem(entry.name, vscode.TreeItemCollapsibleState.None);
    item.description = infobaseEntryDescription(entry);
    item.tooltip = entryTooltip(entry);
    item.contextValue = contextValueForEntry(entry.type);
    item.iconPath = new vscode.ThemeIcon('database');
    if (entry.type === 'file' && entry.filePath) {
      item.resourceUri = vscode.Uri.file(entry.filePath);
    }
    return item;
  }

  async getChildren(element?: InfobaseTreeNode): Promise<InfobaseTreeNode[]> {
    if (!element) {
      return [
        { kind: 'group', group: 'file' },
        { kind: 'group', group: 'server' },
        { kind: 'group', group: 'web' },
      ];
    }
    if (element.kind === 'group') {
      let all: InfobaseEntry[];
      try {
        all = await this.storage.load();
      } catch (err) {
        Logger.warn('InfobaseTreeDataProvider: load failed for group children', err);
        return [];
      }
      return all
        .filter((e) => e.type === element.group)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
        .map((entry) => ({ kind: 'entry', entry } satisfies InfobaseTreeEntry));
    }
    return [];
  }

  getParent(element: InfobaseTreeNode): vscode.ProviderResult<InfobaseTreeNode> {
    if (element.kind === 'entry') {
      return { kind: 'group', group: element.entry.type };
    }
    return undefined;
  }
}
