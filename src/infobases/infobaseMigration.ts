import * as path from 'path';
import type { InfobaseEntry, InfobaseLaunchSettings, InfobaseStorageRoot } from './models/infobaseEntry';

function isoNow(): string {
  return new Date().toISOString();
}

const CURRENT_ROOT_SCHEMA = 2 as const;

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object';
}

/** True if object looks like pre-alignment v1 entry (`displayName`, `kind`, `ibcmdConfigYamlPath`). */
function isLegacyV1EntryShape(o: Record<string, unknown>): boolean {
  return (
    typeof o.displayName === 'string' &&
    o.kind === 'file' &&
    typeof o.ibcmdConfigYamlPath === 'string'
  );
}

/** True if object looks like design-shaped entry (`name`, `type`). */
function isDesignEntryShape(o: Record<string, unknown>): boolean {
  return typeof o.name === 'string' && (o.type === 'file' || o.type === 'server' || o.type === 'web');
}

/**
 * Converts legacy WOW 1A row into design §4.1 entry (file-only).
 */
export function migrateLegacyV1EntryToDesign(raw: Record<string, unknown>): InfobaseEntry | null {
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) {
    return null;
  }
  if (raw.schemaVersion !== 1 && raw.schemaVersion !== undefined) {
    return null;
  }
  if (raw.kind !== 'file') {
    return null;
  }
  const displayName = typeof raw.displayName === 'string' ? raw.displayName.trim() : '';
  const yaml =
    typeof raw.ibcmdConfigYamlPath === 'string' ? raw.ibcmdConfigYamlPath.trim() : '';
  if (!displayName || !yaml) {
    return null;
  }
  const hasStoredPassword =
    typeof raw.hasStoredPassword === 'boolean' ? raw.hasStoredPassword : false;
  const now = isoNow();
  const createdAt =
    typeof raw.createdAt === 'string' && raw.createdAt.trim().length > 0 ? raw.createdAt : now;
  const lastUsedAt =
    typeof raw.updatedAt === 'string' && raw.updatedAt.trim().length > 0
      ? raw.updatedAt
      : typeof raw.lastUsedAt === 'string' && raw.lastUsedAt.trim().length > 0
        ? raw.lastUsedAt
        : undefined;
  const ibcmdUser =
    typeof raw.ibcmdUser === 'string' && raw.ibcmdUser.trim().length > 0
      ? raw.ibcmdUser.trim()
      : undefined;

  const filePath = path.dirname(yaml);

  return {
    id,
    name: displayName,
    type: 'file',
    filePath,
    ibcmdConfigYamlPath: yaml,
    user: ibcmdUser,
    hasStoredPassword,
    createdAt,
    lastUsedAt,
  };
}

/**
 * Normalizes a design v2 row (or partial) from storage.
 */
export function migrateDesignEntry(raw: unknown): InfobaseEntry | null {
  if (!isRecord(raw)) {
    return null;
  }
  const o = raw;
  const id = typeof o.id === 'string' ? o.id.trim() : '';
  if (!id) {
    return null;
  }
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  const type = o.type;
  if (!name || (type !== 'file' && type !== 'server' && type !== 'web')) {
    return null;
  }
  const filePath =
    typeof o.filePath === 'string' && o.filePath.trim().length > 0 ? o.filePath.trim() : undefined;
  const ibcmdConfigYamlPath =
    typeof o.ibcmdConfigYamlPath === 'string' && o.ibcmdConfigYamlPath.trim().length > 0
      ? o.ibcmdConfigYamlPath.trim()
      : undefined;
  if (type === 'file' && !filePath && !ibcmdConfigYamlPath) {
    return null;
  }
  const server =
    typeof o.server === 'string' && o.server.trim().length > 0 ? o.server.trim() : undefined;
  const database =
    typeof o.database === 'string' && o.database.trim().length > 0 ? o.database.trim() : undefined;
  const webUrl =
    typeof o.webUrl === 'string' && o.webUrl.trim().length > 0 ? o.webUrl.trim() : undefined;
  const user = typeof o.user === 'string' && o.user.trim().length > 0 ? o.user.trim() : undefined;
  const hasStoredPassword =
    typeof o.hasStoredPassword === 'boolean' ? o.hasStoredPassword : false;
  const now = isoNow();
  const createdAt =
    typeof o.createdAt === 'string' && o.createdAt.trim().length > 0 ? o.createdAt : now;
  const lastUsedAt =
    typeof o.lastUsedAt === 'string' && o.lastUsedAt.trim().length > 0 ? o.lastUsedAt : undefined;

  let launchSettings = o.launchSettings;
  if (launchSettings !== null && launchSettings !== undefined && typeof launchSettings !== 'object') {
    launchSettings = undefined;
  }
  const ls = launchSettings as Record<string, unknown> | undefined;
  let launchSettingsOut: InfobaseLaunchSettings | undefined;
  if (ls && Object.keys(ls).length > 0) {
    const out: InfobaseLaunchSettings = {};
    if (typeof ls.platformVersion === 'string' && ls.platformVersion.trim()) {
      out.platformVersion = ls.platformVersion.trim();
    }
    if (ls.clientType === 'thin' || ls.clientType === 'thick' || ls.clientType === 'web') {
      out.clientType = ls.clientType;
    }
    if (ls.bitness === '32' || ls.bitness === '64') {
      out.bitness = ls.bitness;
    }
    launchSettingsOut = Object.keys(out).length > 0 ? out : undefined;
  } else {
    launchSettingsOut = undefined;
  }

  return {
    id,
    name,
    type,
    filePath,
    server,
    database,
    webUrl,
    user,
    hasStoredPassword,
    launchSettings: launchSettingsOut,
    createdAt,
    lastUsedAt,
    ibcmdConfigYamlPath,
  };
}

/**
 * Normalizes one stored entry from unknown JSON (legacy v1 or design v2).
 */
export function migrateInfobaseEntry(raw: unknown): InfobaseEntry | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (isLegacyV1EntryShape(raw)) {
    return migrateLegacyV1EntryToDesign(raw);
  }
  if (isDesignEntryShape(raw)) {
    return migrateDesignEntry(raw);
  }
  return null;
}

/**
 * Parses unknown memento payload into {@link InfobaseStorageRoot} (v2).
 * Recognizes legacy rootSchemaVersion 1 and migrates entries.
 */
export function migrateStorageRoot(raw: unknown): InfobaseStorageRoot {
  if (raw === null || raw === undefined) {
    return { rootSchemaVersion: CURRENT_ROOT_SCHEMA, entries: [] };
  }
  if (!isRecord(raw)) {
    return { rootSchemaVersion: CURRENT_ROOT_SCHEMA, entries: [] };
  }
  const ver = raw.rootSchemaVersion;
  const entriesRaw = raw.entries;
  if (!Array.isArray(entriesRaw)) {
    return { rootSchemaVersion: CURRENT_ROOT_SCHEMA, entries: [] };
  }
  const entries: InfobaseEntry[] = [];
  if (ver === CURRENT_ROOT_SCHEMA) {
    for (const item of entriesRaw) {
      const migrated = migrateInfobaseEntry(item);
      if (migrated) {
        entries.push(migrated);
      }
    }
    return { rootSchemaVersion: CURRENT_ROOT_SCHEMA, entries };
  }
  if (ver === 1) {
    for (const item of entriesRaw) {
      const migrated = migrateInfobaseEntry(item);
      if (migrated) {
        entries.push(migrated);
      }
    }
    return { rootSchemaVersion: CURRENT_ROOT_SCHEMA, entries };
  }
  return { rootSchemaVersion: CURRENT_ROOT_SCHEMA, entries: [] };
}
