/** Schema version of a single entry inside the storage array (for field migrations). */
export type InfobaseEntrySchemaVersion = 1;

export const SUPPORTED_INFOBASE_ENTRY_SCHEMA_VERSION: InfobaseEntrySchemaVersion = 1;

export type InfobaseKind = 'file';

/**
 * Root object persisted in `ExtensionContext.globalState` under key `1cInfobaseManager.v1`.
 */
export interface InfobaseStorageRootV1 {
  rootSchemaVersion: 1;
  entries: InfobaseEntry[];
}

/**
 * User-defined infobase record (Phase 1 — file infobases only).
 * Secrets are not stored on the object: password lives in `SecretStorage` when {@link InfobaseEntry.hasStoredPassword} is true.
 *
 * Maps to ibcmd env-style usage: `--config` from {@link InfobaseEntry.ibcmdConfigYamlPath}, optional `--user` / `--password`.
 */
export interface InfobaseEntry {
  /** Stable id (UUID v4); must not change after creation. */
  id: string;
  schemaVersion: InfobaseEntrySchemaVersion;

  /** Display name in lists and tree. */
  displayName: string;

  /** Logical UI grouping (empty string = ungrouped / root bucket). */
  groupLabel: string;

  kind: InfobaseKind;

  /**
   * Path to YAML infobase config for ibcmd (`--config=`).
   * Prefer absolute paths; resolve at call sites with `path.resolve`.
   */
  ibcmdConfigYamlPath: string;

  /**
   * Metadata / configuration workspace root when it differs from the YAML directory (optional).
   */
  metadataWorkspacePath?: string;

  /** Non-secret; passed to ibcmd as `--user` when non-empty. */
  ibcmdUser?: string;

  /**
   * When true, password is expected in SecretStorage under `1cInfobaseManager.password.{id}`.
   * When false, no password (or interactive / none).
   */
  hasStoredPassword: boolean;

  /** Sort order within a group (lower = higher in UI). */
  sortOrder: number;

  /** ISO-8601 timestamps (UTC). */
  createdAt: string;
  updatedAt: string;
}
