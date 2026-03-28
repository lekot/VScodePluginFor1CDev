import type { InfobaseEntry } from '../models/infobaseEntry';
import { SUPPORTED_INFOBASE_ENTRY_SCHEMA_VERSION } from '../models/infobaseEntry';
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
  if (entry.schemaVersion !== SUPPORTED_INFOBASE_ENTRY_SCHEMA_VERSION) {
    throw new InfobaseValidationError(`Unsupported entry schemaVersion: ${entry.schemaVersion}.`);
  }
  if (entry.kind !== 'file') {
    throw new InfobaseValidationError(`Unsupported infobase kind: ${entry.kind}.`);
  }
  const displayName = entry.displayName?.trim() ?? '';
  if (!displayName) {
    throw new InfobaseValidationError('displayName must be non-empty.');
  }
  const yamlPath = entry.ibcmdConfigYamlPath?.trim() ?? '';
  if (!yamlPath) {
    throw new InfobaseValidationError('ibcmdConfigYamlPath must be non-empty.');
  }
  if (typeof entry.sortOrder !== 'number' || !Number.isInteger(entry.sortOrder)) {
    throw new InfobaseValidationError('sortOrder must be an integer.');
  }
  const createdAt = entry.createdAt?.trim() ?? '';
  const updatedAt = entry.updatedAt?.trim() ?? '';
  if (!createdAt || !updatedAt) {
    throw new InfobaseValidationError('createdAt and updatedAt must be non-empty ISO strings.');
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
}
