import * as path from 'path';
import type { InfobaseEntry } from './models/infobaseEntry';
import { INFOBASE_STORAGE_MAX_ENTRIES } from './constants';

/** Optional UUID v4 check (recommended for new records). */
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class InfobaseValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InfobaseValidationError';
  }
}

export function validateInfobaseEntry(entry: InfobaseEntry): void {
  const id = entry.id?.trim() ?? '';
  if (!id) {
    throw new InfobaseValidationError('Infobase entry id is empty.');
  }
  if (!UUID_V4_RE.test(id)) {
    throw new InfobaseValidationError('Infobase entry id must be a UUID v4.');
  }
  const name = entry.name?.trim() ?? '';
  if (!name) {
    throw new InfobaseValidationError('name must be non-empty.');
  }
  const t = entry.type;
  if (t !== 'file' && t !== 'server' && t !== 'web') {
    throw new InfobaseValidationError(`Unsupported infobase type: ${String(t)}.`);
  }
  if (t === 'file') {
    const fp = entry.filePath?.trim() ?? '';
    const yaml = entry.ibcmdConfigYamlPath?.trim() ?? '';
    if (!fp && !yaml) {
      throw new InfobaseValidationError(
        'file infobase requires filePath and/or ibcmdConfigYamlPath (at least one).',
      );
    }
  }
  if (t === 'server') {
    const s = entry.server?.trim() ?? '';
    const d = entry.database?.trim() ?? '';
    if (!s || !d) {
      throw new InfobaseValidationError('server infobase requires server and database.');
    }
  }
  if (t === 'web') {
    const u = entry.webUrl?.trim() ?? '';
    if (!u) {
      throw new InfobaseValidationError('web infobase requires webUrl.');
    }
  }
  const createdAt = entry.createdAt?.trim() ?? '';
  if (!createdAt) {
    throw new InfobaseValidationError('createdAt must be a non-empty ISO string.');
  }
}

/** Normalized path for duplicate checks (Windows drive letter lowercased, slashes unified). */
export function normalizeFsPathForCompare(p: string): string {
  const t = p.trim();
  if (!t) {
    return '';
  }
  let n = path.normalize(t).replace(/\\/g, '/').toLowerCase();
  while (n.length > 1 && n.endsWith('/')) {
    n = n.slice(0, -1);
  }
  return n;
}

/**
 * Stable key for “same physical infobase” detection (plan §1D #14).
 * Empty string if the entry has no comparable target yet (should not happen after {@link validateInfobaseEntry}).
 */
export function infobaseDuplicateTargetKey(entry: InfobaseEntry): string {
  if (entry.type === 'file') {
    const fp = entry.filePath?.trim();
    if (fp) {
      return `file:path:${normalizeFsPathForCompare(fp)}`;
    }
    const yaml = entry.ibcmdConfigYamlPath?.trim();
    if (yaml) {
      return `file:yaml:${normalizeFsPathForCompare(yaml)}`;
    }
    return '';
  }
  if (entry.type === 'server') {
    const s = entry.server?.trim().toLowerCase() ?? '';
    const d = entry.database?.trim().toLowerCase() ?? '';
    return `server:${s}|${d}`;
  }
  if (entry.type === 'web') {
    const u = entry.webUrl?.trim() ?? '';
    try {
      const url = new URL(u);
      const pathname = url.pathname.replace(/\/+$/, '') || '/';
      return `web:${url.protocol}//${url.host.toLowerCase()}${pathname}${url.search}`;
    } catch {
      return `web:raw:${u.toLowerCase()}`;
    }
  }
  return '';
}

function validateDuplicateTargets(entries: InfobaseEntry[]): void {
  const keyToId = new Map<string, string>();
  for (const e of entries) {
    const k = infobaseDuplicateTargetKey(e);
    if (!k) {
      continue;
    }
    const existingId = keyToId.get(k);
    if (existingId !== undefined && existingId !== e.id) {
      throw new InfobaseValidationError(
        `Дублируется расположение базы (тот же целевой объект, что у записи id ${existingId}).`,
      );
    }
    keyToId.set(k, e.id);
  }
}

/**
 * Ensures {@link candidate} does not share a target key with any row in {@link existing} (excluding {@link excludeId}).
 */
export function assertNoConflictingInfobaseTarget(
  candidate: InfobaseEntry,
  existing: InfobaseEntry[],
  excludeId?: string,
): void {
  const key = infobaseDuplicateTargetKey(candidate);
  if (!key) {
    return;
  }
  for (const e of existing) {
    if (excludeId !== undefined && e.id === excludeId) {
      continue;
    }
    if (infobaseDuplicateTargetKey(e) === key) {
      throw new InfobaseValidationError(
        `Такая база уже есть в списке («${e.name}»). Укажите другой каталог, сервер или URL.`,
      );
    }
  }
}

/**
 * Validates a full list before persistence: caps, duplicates, per-entry rules.
 */
export function validateInfobaseEntryList(entries: InfobaseEntry[]): void {
  if (entries.length > INFOBASE_STORAGE_MAX_ENTRIES) {
    throw new InfobaseValidationError(
      `At most ${INFOBASE_STORAGE_MAX_ENTRIES} infobase entries are allowed.`,
    );
  }
  const seen = new Set<string>();
  for (const e of entries) {
    validateInfobaseEntry(e);
    if (seen.has(e.id)) {
      throw new InfobaseValidationError(`Duplicate infobase id: ${e.id}.`);
    }
    seen.add(e.id);
  }
  validateDuplicateTargets(entries);
}
