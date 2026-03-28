import type * as vscode from 'vscode';
import type { InfobaseEntry, InfobaseStorageRootV1 } from '../models/infobaseEntry';
import { Logger } from '../utils/logger';
import { INFOBASE_MANAGER_GLOBAL_STATE_KEY, infobasePasswordSecretKey } from './constants';
import { migrateStorageRoot } from './infobaseMigration';
import { validateInfobaseEntry, validateInfobaseEntryList } from './infobaseValidator';

function sortEntries(entries: InfobaseEntry[]): InfobaseEntry[] {
  return [...entries].sort((a, b) => {
    const ga = a.groupLabel.trim();
    const gb = b.groupLabel.trim();
    if (ga !== gb) {
      return ga.localeCompare(gb);
    }
    if (a.sortOrder !== b.sortOrder) {
      return a.sortOrder - b.sortOrder;
    }
    return a.displayName.localeCompare(b.displayName);
  });
}

/**
 * Reads/writes the global infobase catalog in `globalState`, keeps passwords in `SecretStorage`.
 */
export class InfobaseStorageService {
  /** Entries in last persisted order (not necessarily sorted). */
  private storedEntries: InfobaseEntry[] | null = null;

  constructor(
    private readonly globalState: vscode.Memento,
    private readonly secretStorage: vscode.SecretStorage,
  ) {}

  private readRootFromMemento(): InfobaseStorageRootV1 {
    try {
      const raw = this.globalState.get(INFOBASE_MANAGER_GLOBAL_STATE_KEY);
      return migrateStorageRoot(raw);
    } catch (err) {
      Logger.warn(
        `InfobaseStorageService: failed to read globalState key ${INFOBASE_MANAGER_GLOBAL_STATE_KEY}`,
        err,
      );
      return { rootSchemaVersion: 1, entries: [] };
    }
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
   * Loads entries, applies migration, returns a list sorted by `groupLabel`, `sortOrder`, `displayName`.
   */
  async load(): Promise<InfobaseEntry[]> {
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
    validateInfobaseEntryList(entries);
    const previous = this.readRootFromMemento().entries;
    await this.syncSecrets(previous, entries);
    await this.globalState.update(INFOBASE_MANAGER_GLOBAL_STATE_KEY, {
      rootSchemaVersion: 1,
      entries,
    });
    this.storedEntries = [...entries];
  }

  /**
   * Inserts or updates one entry by `id`.
   */
  async upsert(entry: InfobaseEntry): Promise<void> {
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
    await this.secretStorage.delete(infobasePasswordSecretKey(id));
    const current = [...this.getStoredOrRead()];
    const filtered = current.filter((e) => e.id !== id);
    if (filtered.length === current.length) {
      return;
    }
    await this.globalState.update(INFOBASE_MANAGER_GLOBAL_STATE_KEY, {
      rootSchemaVersion: 1,
      entries: filtered,
    });
    this.storedEntries = filtered;
  }

  private async syncSecrets(
    previous: InfobaseEntry[],
    next: InfobaseEntry[],
  ): Promise<void> {
    const prevIds = new Set(previous.map((e) => e.id));
    const nextIds = new Set(next.map((e) => e.id));
    for (const pid of prevIds) {
      if (!nextIds.has(pid)) {
        await this.secretStorage.delete(infobasePasswordSecretKey(pid));
      }
    }
    for (const e of next) {
      if (!e.hasStoredPassword) {
        await this.secretStorage.delete(infobasePasswordSecretKey(e.id));
      }
    }
  }
}
