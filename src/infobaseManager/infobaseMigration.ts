import type { InfobaseEntry, InfobaseStorageRootV1 } from '../models/infobaseEntry';
import { SUPPORTED_INFOBASE_ENTRY_SCHEMA_VERSION } from '../models/infobaseEntry';

function isoNow(): string {
  return new Date().toISOString();
}

/**
 * Normalizes one stored entry; returns `null` if the record cannot be migrated for the current schema.
 */
export function migrateInfobaseEntry(raw: unknown): InfobaseEntry | null {
  if (raw === null || typeof raw !== 'object') {
    return null;
  }
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id.trim() : '';
  if (!id) {
    return null;
  }
  if (o.schemaVersion !== SUPPORTED_INFOBASE_ENTRY_SCHEMA_VERSION) {
    return null;
  }
  const kind = o.kind;
  if (kind !== 'file') {
    return null;
  }
  const displayName = typeof o.displayName === 'string' ? o.displayName.trim() : '';
  const ibcmdConfigYamlPath =
    typeof o.ibcmdConfigYamlPath === 'string' ? o.ibcmdConfigYamlPath.trim() : '';
  if (!displayName || !ibcmdConfigYamlPath) {
    return null;
  }
  const groupLabel = typeof o.groupLabel === 'string' ? o.groupLabel : '';
  const sortOrder =
    typeof o.sortOrder === 'number' && Number.isInteger(o.sortOrder) ? o.sortOrder : 0;
  const hasStoredPassword =
    typeof o.hasStoredPassword === 'boolean' ? o.hasStoredPassword : false;
  const now = isoNow();
  const createdAt =
    typeof o.createdAt === 'string' && o.createdAt.trim().length > 0 ? o.createdAt : now;
  const updatedAt =
    typeof o.updatedAt === 'string' && o.updatedAt.trim().length > 0 ? o.updatedAt : now;
  const ibcmdUser =
    typeof o.ibcmdUser === 'string' && o.ibcmdUser.trim().length > 0
      ? o.ibcmdUser.trim()
      : undefined;
  const metadataWorkspacePath =
    typeof o.metadataWorkspacePath === 'string' && o.metadataWorkspacePath.trim().length > 0
      ? o.metadataWorkspacePath.trim()
      : undefined;

  return {
    id,
    schemaVersion: SUPPORTED_INFOBASE_ENTRY_SCHEMA_VERSION,
    displayName,
    groupLabel,
    kind: 'file',
    ibcmdConfigYamlPath,
    metadataWorkspacePath,
    ibcmdUser,
    hasStoredPassword,
    sortOrder,
    createdAt,
    updatedAt,
  };
}

/**
 * Parses unknown memento payload into {@link InfobaseStorageRootV1}.
 * Unrecognized shapes yield an empty root (callers may log separately).
 */
export function migrateStorageRoot(raw: unknown): InfobaseStorageRootV1 {
  if (raw === null || raw === undefined) {
    return { rootSchemaVersion: 1, entries: [] };
  }
  if (typeof raw !== 'object') {
    return { rootSchemaVersion: 1, entries: [] };
  }
  const o = raw as Record<string, unknown>;
  if (o.rootSchemaVersion !== 1) {
    return { rootSchemaVersion: 1, entries: [] };
  }
  const entriesRaw = o.entries;
  if (!Array.isArray(entriesRaw)) {
    return { rootSchemaVersion: 1, entries: [] };
  }
  const entries: InfobaseEntry[] = [];
  for (const item of entriesRaw) {
    const migrated = migrateInfobaseEntry(item);
    if (migrated) {
      entries.push(migrated);
    }
  }
  return { rootSchemaVersion: 1, entries };
}
