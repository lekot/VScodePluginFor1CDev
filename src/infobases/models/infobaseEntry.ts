/**
 * WOW Infobase Manager — persisted catalog entry (design §4.1).
 * Password is never on this object; use SecretStorage when {@link InfobaseEntry.hasStoredPassword} is true.
 */

export type InfobaseEntryType = 'file' | 'server' | 'web';

export interface InfobaseLaunchSettings {
  platformVersion?: string;
  clientType?: 'thin' | 'thick' | 'web';
  bitness?: '32' | '64';
}

/**
 * Optional override for ibcmd `--config` when it is not a conventional file under {@link filePath}.
 * Set when migrating from pre-design storage that stored only a YAML path (WOW implementation detail).
 */
export interface InfobaseEntry {
  id: string;
  name: string;
  type: InfobaseEntryType;

  filePath?: string;
  server?: string;
  database?: string;
  webUrl?: string;

  user?: string;

  /** When true, password is stored under {@link infobasePasswordSecretKey}. */
  hasStoredPassword: boolean;

  launchSettings?: InfobaseLaunchSettings;

  createdAt: string;
  lastUsedAt?: string;

  /** ibcmd `--config` when not derived from {@link filePath} alone (non-standard layout). */
  ibcmdConfigYamlPath?: string;
}

/** Root persisted in `globalState` under {@link INFOBASE_GLOBAL_STATE_KEY}. */
export interface InfobaseStorageRoot {
  rootSchemaVersion: 2;
  entries: InfobaseEntry[];
}
