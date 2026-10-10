/**
 * WOW Phase 4 #61 — экспорт каталога баз в текст `.v8i` (UTF-8, см. design §9).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { InfobaseEntry, InfobaseFolder } from './models/infobaseEntry';
import { formatServerConnectionString } from './models/connectionString';
import { tryParseInfobaseFileScalarFromYaml } from './ibcmdConfigPathResolver';
import { InfobaseValidationError } from './infobaseValidator';

/**
 * Разрешает реальный каталог данных файловой информационной базы.
 * Если путь к базе не задан явно, пытается прочитать скаляр file: из конфигурационного YAML ibcmd.
 */
export function resolveFileInfobaseDirectory(
  entry: InfobaseEntry,
  readYaml?: (filePath: string) => string,
): string | undefined {
  const fp = entry.filePath?.trim();
  if (fp) {
    return fp;
  }
  const yamlPath = entry.ibcmdConfigYamlPath?.trim();
  if (yamlPath) {
    try {
      const reader = readYaml ?? ((p: string) => fs.readFileSync(p, 'utf8'));
      const content = reader(yamlPath);
      const fileScalar = tryParseInfobaseFileScalarFromYaml(content);
      if (fileScalar && fileScalar.trim()) {
        const trimmed = fileScalar.trim();
        return path.isAbsolute(trimmed) || /^[a-zA-Z]:[\\/]/.test(trimmed)
          ? trimmed
          : path.resolve(path.dirname(yamlPath), trimmed);
      }
    } catch {
      // Файл YAML недоступен или не удалось распарсить
    }
  }
  return undefined;
}

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

export interface BuildV8iOptions {
  includeOrderInList?: boolean;
  readYaml?: (filePath: string) => string;
}

/** Строка Connect= для записи в .v8i (пароли из SecretStorage не подставляются). */
export function infobaseEntryToV8iConnect(
  entry: InfobaseEntry,
  readYaml?: (filePath: string) => string,
): string {
  if (entry.type === 'file') {
    const resolvedDir = resolveFileInfobaseDirectory(entry, readYaml);
    if (!resolvedDir) {
      throw new InfobaseValidationError(
        `Не удалось определить каталог файловой информационной базы "${entry.name}" для экспорта в .v8i. Укажите каталог базы или параметр file в YAML.`,
      );
    }
    const norm = path.normalize(resolvedDir);
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
  options?: BuildV8iOptions,
): string {
  const folderById = new Map(folders.map((f) => [f.id, f] as const));
  const lines: string[] = ['; Exported by CDT 41 Infobase Manager', ''];
  let order = 1;
  const withOrder = options?.includeOrderInList !== false;
  for (const e of entries) {
    const section = escapeIniSectionName(e.name);
    lines.push(`[${section}]`);
    lines.push(`Connect=${infobaseEntryToV8iConnect(e, options?.readYaml)}`);
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
