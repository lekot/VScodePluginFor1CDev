/**
 * WOW Phase 4 #61 — экспорт каталога баз в текст `.v8i` (UTF-8, см. design §9).
 */

import * as path from 'path';
import type { InfobaseEntry, InfobaseFolder } from './models/infobaseEntry';
import { formatServerConnectionString } from './models/connectionString';

function escapeIniSectionName(name: string): string {
  return name.replace(/]/g, ']]');
}

function folderPathLabel(folderId: string | undefined, folderById: ReadonlyMap<string, InfobaseFolder>): string {
  if (!folderId) {
    return '';
  }
  const parts: string[] = [];
  let cur: string | undefined = folderId;
  const guard = new Set<string>();
  while (cur && !guard.has(cur)) {
    guard.add(cur);
    const f = folderById.get(cur);
    if (!f) {
      break;
    }
    parts.unshift(f.name);
    cur = f.parentId?.trim() || undefined;
  }
  return parts.length > 0 ? `/${parts.join('/')}` : '';
}

/** Строка Connect= для записи в .v8i (пароли из SecretStorage не подставляются). */
export function infobaseEntryToV8iConnect(entry: InfobaseEntry): string {
  if (entry.type === 'file') {
    const fp = entry.filePath?.trim() || entry.ibcmdConfigYamlPath?.trim() || '';
    const norm = path.normalize(fp);
    return `File="${norm.replace(/"/g, '""')}";`;
  }
  if (entry.type === 'server') {
    const s = entry.server?.trim() ?? '';
    const r = entry.database?.trim() ?? '';
    return `${formatServerConnectionString({ server: s, ref: r, user: entry.user })};`;
  }
  const u = entry.webUrl?.trim() ?? '';
  return `ws="${u.replace(/"/g, '""')}";`;
}

/**
 * Собирает содержимое `.v8i` для выбранных баз (порядок = порядок в {@link entries}).
 */
export function buildV8iFileContent(
  entries: InfobaseEntry[],
  folders: readonly InfobaseFolder[],
  options?: { includeOrderInList?: boolean },
): string {
  const folderById = new Map(folders.map((f) => [f.id, f] as const));
  const lines: string[] = ['; Exported by CDT 41 Infobase Manager', ''];
  let order = 1;
  const withOrder = options?.includeOrderInList !== false;
  for (const e of entries) {
    const section = escapeIniSectionName(e.name);
    lines.push(`[${section}]`);
    lines.push(`Connect=${infobaseEntryToV8iConnect(e)}`);
    lines.push(`ID=${e.id}`);
    if (withOrder) {
      lines.push(`OrderInList=${order}`);
      order += 1;
    }
    const folder = folderPathLabel(e.folderId, folderById);
    if (folder) {
      lines.push(`Folder=${folder}`);
    }
    lines.push('App=Auto');
    lines.push('');
  }
  return lines.join('\r\n').replace(/\r\n$/, '');
}
