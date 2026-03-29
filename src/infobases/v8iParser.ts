/**
 * WOW Infobase Manager §3D #56–57 — разбор `.v8i` (INI-подобный список баз 1С).
 *
 * @see docs/WOW/v8i-format-spec.md
 */

import * as path from 'path';
import type { InfobaseEntry } from './models/infobaseEntry';
import { parseServerConnectionString } from './models/connectionString';
import { normalizeFsPathForCompare } from './infobaseValidator';

export type V8iConnectParsed =
  | { kind: 'file'; filePath: string; user?: string }
  | {
      kind: 'server';
      server: string;
      ref: string;
      user?: string;
      password?: string;
      pwdKeyPresent: boolean;
    }
  | { kind: 'web'; webUrl: string };

export interface V8iParsedEntry {
  name: string;
  connect: string;
  parsed: V8iConnectParsed;
  id?: string;
  orderInList?: number;
  orderInTree?: number;
  folder?: string;
}

export interface V8iParseError {
  line: number;
  message: string;
}

export interface V8iParseResult {
  entries: V8iParsedEntry[];
  errors: V8iParseError[];
}

/** §2 — BOM UTF-16 LE → `utf16le`, иначе UTF-8 (включая UTF-8 BOM). */
export function detectV8iBufferEncoding(buffer: Buffer): 'utf8' | 'utf16le' {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return 'utf16le';
  }
  return 'utf8';
}

/** Декодирование буфера файла `.v8i` в строку (с учётом BOM). */
export function decodeV8iBuffer(buffer: Buffer): string {
  const enc = detectV8iBufferEncoding(buffer);
  let raw: string;
  if (enc === 'utf16le') {
    raw = buffer.subarray(2).toString('utf16le');
  } else {
    raw = buffer.toString('utf8');
  }
  return raw.replace(/^\ufeff/, '');
}

/**
 * Разбор строки `Connect=…` в параметры файловой / серверной / веб-базы.
 */
export function parseV8iConnectString(connectRaw: string): V8iConnectParsed | { error: string } {
  const trimmed = connectRaw.trim().replace(/^\ufeff/, '');
  if (!trimmed) {
    return { error: 'Пустая строка Connect' };
  }

  const params: Record<string, string> = {};
  const re = /(\w+)\s*=\s*(?:"([^"]*)"|([^;]*))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(trimmed)) !== null) {
    const key = m[1].toLowerCase();
    const value = (m[2] ?? m[3] ?? '').trim();
    params[key] = value;
  }

  const filePath = (params.file ?? '').trim();
  if (filePath) {
    return {
      kind: 'file',
      filePath,
      user: params.usr?.trim() || undefined,
    };
  }

  const srvr = (params.srvr ?? '').trim();
  const ref = (params.ref ?? '').trim();
  if (srvr && ref) {
    const r = parseServerConnectionString(trimmed);
    if (!r.ok) {
      return { error: r.error };
    }
    return {
      kind: 'server',
      server: r.server,
      ref: r.ref,
      user: r.user,
      password: r.password,
      pwdKeyPresent: r.pwdKeyPresent,
    };
  }

  const ws = (params.ws ?? '').trim();
  if (ws) {
    try {
      const url = new URL(ws);
      const scheme = url.protocol.replace(/:$/, '').toLowerCase();
      if (scheme !== 'http' && scheme !== 'https') {
        return { error: 'Для веб-клиента в Connect нужен URL с http:// или https://' };
      }
      return { kind: 'web', webUrl: ws };
    } catch {
      return { error: 'Некорректный URL в ws=' };
    }
  }

  return { error: 'Не удалось распознать Connect (ожидались File=, Srvr/Ref или ws=)' };
}

function parseIntSafe(raw: string): number | undefined {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

function flushSection(
  current: Partial<{
    name: string;
    connect: string;
    id: string;
    orderInList: number;
    orderInTree: number;
    folder: string;
  }> | null,
  lineNumber: number,
  entries: V8iParsedEntry[],
  errors: V8iParseError[],
): void {
  if (!current?.name) {
    return;
  }
  if (!current.connect?.trim()) {
    errors.push({ line: lineNumber, message: `Секция «${current.name}»: нет строки Connect` });
    return;
  }
  const parsed = parseV8iConnectString(current.connect);
  if ('error' in parsed) {
    errors.push({ line: lineNumber, message: `Секция «${current.name}»: ${parsed.error}` });
    return;
  }
  entries.push({
    name: current.name,
    connect: current.connect.trim(),
    parsed,
    id: current.id,
    orderInList: current.orderInList,
    orderInTree: current.orderInTree,
    folder: current.folder,
  });
}

/**
 * Парсинг текста `.v8i` после декодирования ({@link decodeV8iBuffer}).
 */
export function parseV8iContent(content: string): V8iParseResult {
  const entries: V8iParsedEntry[] = [];
  const errors: V8iParseError[] = [];
  const lines = content.split(/\r?\n/);

  let current: Partial<{
    name: string;
    connect: string;
    id: string;
    orderInList: number;
    orderInTree: number;
    folder: string;
  }> | null = null;

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) {
      continue;
    }

    const sectionMatch = trimmed.match(/^\[(.+)]$/);
    if (sectionMatch) {
      flushSection(current, lineNumber, entries, errors);
      current = { name: sectionMatch[1].trim() };
      if (!current.name) {
        errors.push({ line: lineNumber, message: 'Пустое имя секции' });
        current = null;
      }
      continue;
    }

    const kvMatch = trimmed.match(/^(\w+)=(.*)$/);
    if (kvMatch && current) {
      const [, key, value] = kvMatch;
      switch (key.toLowerCase()) {
        case 'connect':
          current.connect = value;
          break;
        case 'id':
          current.id = value.trim();
          break;
        case 'orderinlist':
          current.orderInList = parseIntSafe(value);
          break;
        case 'orderintree':
          current.orderInTree = parseIntSafe(value);
          break;
        case 'folder':
          current.folder = value;
          break;
        default:
          break;
      }
    }
  }

  flushSection(current, lines.length, entries, errors);
  return { entries, errors };
}

export function parseV8iBuffer(buffer: Buffer): V8iParseResult {
  return parseV8iContent(decodeV8iBuffer(buffer));
}

/** Краткая строка для Quick Pick / превью. */
export function formatV8iEntryPreview(entry: V8iParsedEntry): string {
  const p = entry.parsed;
  if (p.kind === 'file') {
    return p.filePath;
  }
  if (p.kind === 'server') {
    return `Srvr="${p.server}"; Ref="${p.ref}"`;
  }
  return p.webUrl;
}

/**
 * Путь каталога ИБ из `.v8i` для поля {@link InfobaseEntry.filePath}.
 * На Windows — полный `path.resolve`. На POSIX пути вида `C:/...` и UNC не должны
 * превращаться в `cwd/C:/...`, иначе {@link infobaseDuplicateTargetKey} не совпадёт
 * с уже сохранёнными записями (CI Linux). См. `infobaseDuplicateTargetKey`.
 */
export function filePathFromV8iForInfobase(raw: string): string {
  const t = raw.trim();
  if (!t) {
    return t;
  }
  const winDrive = /^[A-Za-z]:[/\\]/.test(t);
  const unc = /^\\\\[^\\/]+[/\\]/.test(t);
  if (process.platform === 'win32') {
    return path.resolve(t);
  }
  if (winDrive || unc) {
    return normalizeFsPathForCompare(t);
  }
  return path.resolve(t);
}

/** Преобразование успешно разобранной записи `.v8i` в черновик {@link InfobaseEntry} (без `id` / `createdAt`). */
export function v8iParsedEntryToInfobaseDraft(entry: V8iParsedEntry): Omit<InfobaseEntry, 'id' | 'createdAt'> {
  const p = entry.parsed;
  if (p.kind === 'file') {
    return {
      name: entry.name,
      type: 'file',
      filePath: filePathFromV8iForInfobase(p.filePath),
      hasStoredPassword: false,
    };
  }
  if (p.kind === 'server') {
    const hasStoredPassword = p.pwdKeyPresent ? !!p.password : false;
    return {
      name: entry.name,
      type: 'server',
      server: p.server,
      database: p.ref,
      user: p.user,
      hasStoredPassword,
    };
  }
  return {
    name: entry.name,
    type: 'web',
    webUrl: p.webUrl,
    hasStoredPassword: false,
    launchSettings: { clientType: 'web' },
  };
}
