import type * as vscode from 'vscode';
import type { InfobaseEntry, InfobaseStorageRoot } from './models/infobaseEntry';
import { Logger } from '../utils/logger';
import {
  INFOBASE_GLOBAL_STATE_KEY,
  INFOBASE_LEGACY_GLOBAL_STATE_KEY,
  infobaseLegacyPasswordSecretKey,
  infobasePasswordSecretKey,
} from './constants';
import { migrateStorageRoot } from './infobaseMigration';
import { validateInfobaseEntry, validateInfobaseEntryList } from './infobaseValidator';

function sortEntries(entries: InfobaseEntry[]): InfobaseEntry[] {
  const order = (t: InfobaseEntry['type']) => (t === 'file' ? 0 : t === 'server' ? 1 : 2);
  return [...entries].sort((a, b) => {
    const ta = order(a.type);
    const tb = order(b.type);
    if (ta !== tb) {
      return ta - tb;
    }
    return a.name.localeCompare(b.name);
  });
}

/**
 * Reads/writes the global infobase catalog in `globalState`, keeps passwords in `SecretStorage`.
 * Migrates legacy `1cInfobaseManager.v1` + password keys once into design namespace.
 */
export class InfobaseStorageService {
  /** Entries in last persisted order (not necessarily sorted). */
  private storedEntries: InfobaseEntry[] | null = null;

  private legacyMigrationPromise: Promise<void> | null = null;

  constructor(
    private readonly globalState: vscode.Memento,
    private readonly secretStorage: vscode.SecretStorage,
  ) {}

  private readRootFromMemento(): InfobaseStorageRoot {
    try {
      const raw = this.globalState.get(INFOBASE_GLOBAL_STATE_KEY);
      if (raw !== undefined && raw !== null) {
        return migrateStorageRoot(raw);
      }
      const legacy = this.globalState.get(INFOBASE_LEGACY_GLOBAL_STATE_KEY);
      if (legacy !== undefined && legacy !== null) {
        return migrateStorageRoot(legacy);
      }
      return migrateStorageRoot(undefined);
    } catch (err) {
      Logger.warn(
        `InfobaseStorageService: failed to read globalState keys ${INFOBASE_GLOBAL_STATE_KEY} / legacy`,
        err,
      );
      return { rootSchemaVersion: 2, entries: [] };
    }
  }

  /**
   * One-time: persist migrated root under the new key, re-key secrets, drop legacy memento.
   */
  private async ensurePersistedDesignNamespace(): Promise<void> {
    const hasNew = this.globalState.keys().includes(INFOBASE_GLOBAL_STATE_KEY);
    if (hasNew) {
      return;
    }
    const legacyRaw = this.globalState.get(INFOBASE_LEGACY_GLOBAL_STATE_KEY);
    if (legacyRaw === undefined || legacyRaw === null) {
      return;
    }
    const root = migrateStorageRoot(legacyRaw);
    for (const e of root.entries) {
      if (!e.hasStoredPassword) {
        continue;
      }
      const oldKey = infobaseLegacyPasswordSecretKey(e.id);
      const newKey = infobasePasswordSecretKey(e.id);
      const secret = await this.secretStorage.get(oldKey);
      if (secret !== undefined) {
        await this.secretStorage.store(newKey, secret);
        await this.secretStorage.delete(oldKey);
      }
    }
    await this.globalState.update(INFOBASE_GLOBAL_STATE_KEY, root);
    await this.globalState.update(INFOBASE_LEGACY_GLOBAL_STATE_KEY, undefined);
  }

  private async ensureLegacyMigrated(): Promise<void> {
    if (!this.legacyMigrationPromise) {
      this.legacyMigrationPromise = this.ensurePersistedDesignNamespace()
        .catch((err) => {
          Logger.warn('InfobaseStorageService: legacy migration failed', err);
          this.legacyMigrationPromise = null;
        })
        .then(() => undefined);
    }
    await this.legacyMigrationPromise;
  }

  private getStoredOrRead(): InfobaseEntry[] {
    if (this.storedEntries) {
      return this.storedEntries;
    }
    const root = this.readRootFromMemento();
    this.storedEntries = [...root.entries];
    return this.storedEntries;
  }

  /**
   * Loads entries, applies migration, returns a list sorted by type then name.
   */
  async load(): Promise<InfobaseEntry[]> {
    await this.ensureLegacyMigrated();
    const entries = this.getStoredOrRead();
    return sortEntries(entries);
  }

  async getById(id: string): Promise<InfobaseEntry | undefined> {
    const list = await this.load();
    return list.find((e) => e.id === id);
  }

  /**
   * Replaces the entire list. Removes secrets for dropped ids; clears password secret when `hasStoredPassword` is false.
   */
  async saveAll(entries: InfobaseEntry[]): Promise<void> {
    await this.ensureLegacyMigrated();
    validateInfobaseEntryList(entries);
    const previous = this.readRootFromMemento().entries;
    await this.syncSecrets(previous, entries);
    await this.globalState.update(INFOBASE_GLOBAL_STATE_KEY, {
      rootSchemaVersion: 2,
      entries,
    });
    this.storedEntries = [...entries];
  }

  /**
   * Inserts or updates one entry by `id`.
   */
  async upsert(entry: InfobaseEntry): Promise<void> {
    await this.ensureLegacyMigrated();
    validateInfobaseEntry(entry);
    const current = [...this.getStoredOrRead()];
    const idx = current.findIndex((e) => e.id === entry.id);
    if (idx >= 0) {
      current[idx] = entry;
    } else {
      current.push(entry);
    }
    validateInfobaseEntryList(current);
    await this.saveAll(current);
  }

  /**
   * Removes an entry and deletes its password secret (idempotent).
   */
  async remove(id: string): Promise<void> {
    await this.ensureLegacyMigrated();
    await this.secretStorage.delete(infobasePasswordSecretKey(id));
    await this.secretStorage.delete(infobaseLegacyPasswordSecretKey(id));
    const current = [...this.getStoredOrRead()];
    const filtered = current.filter((e) => e.id !== id);
    if (filtered.length === current.length) {
      return;
    }
    await this.globalState.update(INFOBASE_GLOBAL_STATE_KEY, {
      rootSchemaVersion: 2,
      entries: filtered,
    });
    this.storedEntries = filtered;
  }

  private async syncSecrets(previous: InfobaseEntry[], next: InfobaseEntry[]): Promise<void> {
    const prevIds = new Set(previous.map((e) => e.id));
    const nextIds = new Set(next.map((e) => e.id));
    for (const pid of prevIds) {
      if (!nextIds.has(pid)) {
        await this.secretStorage.delete(infobasePasswordSecretKey(pid));
        await this.secretStorage.delete(infobaseLegacyPasswordSecretKey(pid));
      }
    }
    for (const e of next) {
      if (!e.hasStoredPassword) {
        await this.secretStorage.delete(infobasePasswordSecretKey(e.id));
        await this.secretStorage.delete(infobaseLegacyPasswordSecretKey(e.id));
      }
    }
  }
}
