/** Primary `globalState` key (WOW design namespace). */
export const INFOBASE_GLOBAL_STATE_KEY = '1cMetadataTree.infobases.v1';

/** Legacy bucket from pre-alignment builds; migrated once into {@link INFOBASE_GLOBAL_STATE_KEY}. */
export const INFOBASE_LEGACY_GLOBAL_STATE_KEY = '1cInfobaseManager.v1';

/** Current `SecretStorage` key prefix; full key = prefix + entry id. */
export const INFOBASE_PASSWORD_SECRET_PREFIX = '1cMetadataTree.infobase.password.';

/** Legacy password prefix (secrets copied on migration). */
export const INFOBASE_LEGACY_PASSWORD_SECRET_PREFIX = '1cInfobaseManager.password.';

/** Hard cap to avoid oversized memento and slow activation. */
export const INFOBASE_STORAGE_MAX_ENTRIES = 500;

export function infobasePasswordSecretKey(entryId: string): string {
  return `${INFOBASE_PASSWORD_SECRET_PREFIX}${entryId}`;
}

export function infobaseLegacyPasswordSecretKey(entryId: string): string {
  return `${INFOBASE_LEGACY_PASSWORD_SECRET_PREFIX}${entryId}`;
}
