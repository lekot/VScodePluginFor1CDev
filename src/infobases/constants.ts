/** Primary `globalState` key (WOW design namespace). */
export const INFOBASE_GLOBAL_STATE_KEY = '1cMetadataTree.infobases.v1';

/** Current `SecretStorage` key prefix; full key = prefix + entry id. */
export const INFOBASE_PASSWORD_SECRET_PREFIX = '1cMetadataTree.infobase.password.';

/** Hard cap to avoid oversized memento and slow activation. */
export const INFOBASE_STORAGE_MAX_ENTRIES = 500;

export function infobasePasswordSecretKey(entryId: string): string {
  return `${INFOBASE_PASSWORD_SECRET_PREFIX}${entryId}`;
}
