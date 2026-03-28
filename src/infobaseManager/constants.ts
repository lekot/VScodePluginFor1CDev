/** `globalState` key for WOW Infobase Manager payload (versioned bucket). */
export const INFOBASE_MANAGER_GLOBAL_STATE_KEY = '1cInfobaseManager.v1';

/** Prefix for `SecretStorage` keys; full key = prefix + entry id. */
export const INFOBASE_PASSWORD_SECRET_PREFIX = '1cInfobaseManager.password.';

/** Hard cap to avoid oversized memento and slow activation. */
export const INFOBASE_STORAGE_MAX_ENTRIES = 500;

export function infobasePasswordSecretKey(entryId: string): string {
  return `${INFOBASE_PASSWORD_SECRET_PREFIX}${entryId}`;
}
