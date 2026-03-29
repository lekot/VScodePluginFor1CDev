import type {
  InfobaseEntry,
  InfobaseFolder,
  InfobaseLaunchSettings,
  InfobaseStorageRoot,
} from './models/infobaseEntry';

const CURRENT_ROOT_SCHEMA = 3 as const;

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object';
}

/** True if object looks like design-shaped entry (`name`, `type`). */
function isDesignEntryShape(o: Record<string, unknown>): boolean {
  return typeof o.name === 'string' && (o.type === 'file' || o.type === 'server' || o.type === 'web');
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
  const now = new Date().toISOString();
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

  const folderId =
    typeof o.folderId === 'string' && o.folderId.trim().length > 0 ? o.folderId.trim() : undefined;

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
    folderId,
  };
}

/**
 * Normalizes one stored entry from unknown JSON (design v2 shape only).
 */
export function migrateInfobaseEntry(raw: unknown): InfobaseEntry | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (isDesignEntryShape(raw)) {
    return migrateDesignEntry(raw);
  }
  return null;
}

function migrateFolder(raw: unknown): InfobaseFolder | null {
  if (!isRecord(raw)) {
    return null;
  }
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!id || !name) {
    return null;
  }
  const parentId =
    typeof raw.parentId === 'string' && raw.parentId.trim().length > 0 ? raw.parentId.trim() : undefined;
  return { id, name, parentId };
}

/**
 * Parses unknown memento payload into {@link InfobaseStorageRoot} (v3).
 * Принимает v2 (только entries) и v3 (entries + folders); иное — пустой каталог.
 */
export function migrateStorageRoot(raw: unknown): InfobaseStorageRoot {
  if (raw === null || raw === undefined) {
    return { rootSchemaVersion: CURRENT_ROOT_SCHEMA, entries: [], folders: [] };
  }
  if (!isRecord(raw)) {
    return { rootSchemaVersion: CURRENT_ROOT_SCHEMA, entries: [], folders: [] };
  }
  const ver = raw.rootSchemaVersion;
  const entriesRaw = raw.entries;
  if ((ver !== 2 && ver !== 3) || !Array.isArray(entriesRaw)) {
    return { rootSchemaVersion: CURRENT_ROOT_SCHEMA, entries: [], folders: [] };
  }
  const entries: InfobaseEntry[] = [];
  for (const item of entriesRaw) {
    const migrated = migrateInfobaseEntry(item);
    if (migrated) {
      entries.push(migrated);
    }
  }
  const folders: InfobaseFolder[] = [];
  if (ver === 3 && Array.isArray(raw.folders)) {
    for (const item of raw.folders) {
      const f = migrateFolder(item);
      if (f) {
        folders.push(f);
      }
    }
  }
  return { rootSchemaVersion: CURRENT_ROOT_SCHEMA, entries, folders };
}
