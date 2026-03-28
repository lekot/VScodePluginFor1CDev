import * as assert from 'assert';
import { randomUUID } from 'crypto';
import * as path from 'path';
import type { Memento, SecretStorage } from 'vscode';
import * as vscode from 'vscode';
import {
  infobaseLegacyPasswordSecretKey,
  infobasePasswordSecretKey,
  INFOBASE_GLOBAL_STATE_KEY,
  INFOBASE_LEGACY_GLOBAL_STATE_KEY,
  INFOBASE_LEGACY_PASSWORD_SECRET_PREFIX,
  INFOBASE_PASSWORD_SECRET_PREFIX,
  INFOBASE_STORAGE_MAX_ENTRIES,
} from '../../src/infobases/constants';
import { migrateInfobaseEntry, migrateStorageRoot } from '../../src/infobases/infobaseMigration';
import { InfobaseStorageService } from '../../src/infobases/infobaseStorageService';
import {
  InfobaseValidationError,
  validateInfobaseEntry,
  validateInfobaseEntryList,
} from '../../src/infobases/infobaseValidator';
import type { InfobaseEntry } from '../../src/infobases/models/infobaseEntry';
import { ExtensionState } from '../../src/state/extensionState';

type SecretStorageChangeEvent = { key: string };

class SimpleEventEmitter<T> {
  private readonly listeners: Array<(e: T) => void> = [];

  readonly event = (listener: (e: T) => void): { dispose: () => void } => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const i = this.listeners.indexOf(listener);
        if (i >= 0) {
          this.listeners.splice(i, 1);
        }
      },
    };
  };
}

class MapMemento implements Memento {
  private readonly map = new Map<string, unknown>();

  keys(): readonly string[] {
    return [...this.map.keys()];
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    if (this.map.has(key)) {
      return this.map.get(key) as T;
    }
    return defaultValue as T;
  }

  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) {
      this.map.delete(key);
    } else {
      this.map.set(key, value);
    }
    return Promise.resolve();
  }
}

class MapSecretStorage implements SecretStorage {
  private readonly values = new Map<string, string>();
  private readonly _onDidChange = new SimpleEventEmitter<SecretStorageChangeEvent>();

  get onDidChange(): import('vscode').Event<SecretStorageChangeEvent> {
    return this._onDidChange.event;
  }

  get(key: string): Thenable<string | undefined> {
    return Promise.resolve(this.values.get(key));
  }

  store(key: string, value: string): Thenable<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Thenable<void> {
    this.values.delete(key);
    return Promise.resolve();
  }

  keys(): Thenable<string[]> {
    return Promise.resolve([...this.values.keys()]);
  }
}

/** `globalState.get` throws for a specific key (simulates corrupted memento / VS Code failure). */
class ThrowingGetMemento implements Memento {
  keys(): readonly string[] {
    return [];
  }

  get<T>(_key: string): T | undefined;
  get<T>(_key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    if (key === INFOBASE_GLOBAL_STATE_KEY) {
      throw new Error('globalState.get failed');
    }
    return defaultValue as T | undefined;
  }

  update(): Thenable<void> {
    return Promise.resolve();
  }
}

function makeEntry(overrides: Partial<InfobaseEntry> = {}): InfobaseEntry {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    name: 'Demo',
    type: 'file',
    filePath: 'C:/tmp',
    ibcmdConfigYamlPath: 'C:/tmp/ib.yaml',
    hasStoredPassword: false,
    createdAt: now,
    lastUsedAt: now,
    ...overrides,
  };
}

suite('infobaseConstants', () => {
  test('infobasePasswordSecretKey uses prefix and id', () => {
    const id = 'abc';
    assert.strictEqual(
      infobasePasswordSecretKey(id),
      `${INFOBASE_PASSWORD_SECRET_PREFIX}${id}`,
    );
  });

  test('infobaseLegacyPasswordSecretKey uses legacy prefix', () => {
    assert.strictEqual(
      infobaseLegacyPasswordSecretKey('x'),
      `${INFOBASE_LEGACY_PASSWORD_SECRET_PREFIX}x`,
    );
  });
});

suite('infobaseMigration', () => {
  test('migrateStorageRoot returns empty for null and undefined', () => {
    assert.deepStrictEqual(migrateStorageRoot(null), { rootSchemaVersion: 2, entries: [] });
    assert.deepStrictEqual(migrateStorageRoot(undefined), { rootSchemaVersion: 2, entries: [] });
  });

  test('migrateStorageRoot returns empty for wrong rootSchemaVersion', () => {
    const r = migrateStorageRoot({ rootSchemaVersion: 9, entries: [] });
    assert.deepStrictEqual(r, { rootSchemaVersion: 2, entries: [] });
  });

  test('migrateStorageRoot returns empty when entries is not an array', () => {
    const r = migrateStorageRoot({ rootSchemaVersion: 2, entries: {} });
    assert.deepStrictEqual(r, { rootSchemaVersion: 2, entries: [] });
  });

  test('migrateStorageRoot filters out invalid array items', () => {
    const goodId = randomUUID();
    const raw = {
      rootSchemaVersion: 2,
      entries: [
        {
          id: goodId,
          name: 'OK',
          type: 'file',
          filePath: '/data',
          ibcmdConfigYamlPath: '/ok.yaml',
          hasStoredPassword: false,
          createdAt: '2020-01-01T00:00:00.000Z',
        },
        { id: '', name: 'bad', type: 'file', filePath: '/x', hasStoredPassword: false, createdAt: 'x' },
      ],
    };
    const r = migrateStorageRoot(raw);
    assert.strictEqual(r.entries.length, 1);
    assert.strictEqual(r.entries[0].id, goodId);
  });

  test('migrateInfobaseEntry rejects non-file legacy kind', () => {
    assert.strictEqual(
      migrateInfobaseEntry({
        id: randomUUID(),
        schemaVersion: 1,
        displayName: 'x',
        kind: 'server',
        ibcmdConfigYamlPath: '/p.yaml',
      }),
      null,
    );
  });

  test('migrateInfobaseEntry trims legacy id, displayName, and yaml path', () => {
    const id = randomUUID();
    const m = migrateInfobaseEntry({
      id: `  ${id}  `,
      schemaVersion: 1,
      displayName: '  Name  ',
      groupLabel: 'g',
      kind: 'file',
      ibcmdConfigYamlPath: '  /p.yaml  ',
      hasStoredPassword: false,
      sortOrder: 0,
    });
    assert.ok(m);
    assert.strictEqual(m!.id, id);
    assert.strictEqual(m!.name, 'Name');
    assert.strictEqual(m!.ibcmdConfigYamlPath, '/p.yaml');
    assert.strictEqual(m!.filePath, path.dirname('/p.yaml'));
  });

  test('migrateInfobaseEntry defaults hasStoredPassword and timestamps for legacy', () => {
    const id = randomUUID();
    const m = migrateInfobaseEntry({
      id,
      schemaVersion: 1,
      displayName: 'x',
      groupLabel: '',
      kind: 'file',
      ibcmdConfigYamlPath: '/p.yaml',
    });
    assert.ok(m);
    assert.strictEqual(m!.hasStoredPassword, false);
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(m!.createdAt));
  });

  test('migrateInfobaseEntry maps legacy ibcmdUser to user', () => {
    const id = randomUUID();
    const m = migrateInfobaseEntry({
      id,
      schemaVersion: 1,
      displayName: 'x',
      groupLabel: '',
      kind: 'file',
      ibcmdConfigYamlPath: '/p.yaml',
      ibcmdUser: '  admin  ',
    });
    assert.ok(m);
    assert.strictEqual(m!.user, 'admin');
  });

  test('migrateInfobaseEntry drops empty optional user for legacy', () => {
    const id = randomUUID();
    const m = migrateInfobaseEntry({
      id,
      schemaVersion: 1,
      displayName: 'x',
      groupLabel: '',
      kind: 'file',
      ibcmdConfigYamlPath: '/p.yaml',
      ibcmdUser: '   ',
    });
    assert.ok(m);
    assert.strictEqual(m!.user, undefined);
  });

  test('migrateStorageRoot returns empty for non-object', () => {
    const r = migrateStorageRoot('x');
    assert.deepStrictEqual(r, { rootSchemaVersion: 2, entries: [] });
  });

  test('migrateStorageRoot migrates legacy v1 entries', () => {
    const id = randomUUID();
    const raw = {
      rootSchemaVersion: 1,
      entries: [
        {
          id,
          schemaVersion: 1,
          displayName: 'A',
          groupLabel: 'g',
          kind: 'file',
          ibcmdConfigYamlPath: '/x/y.yaml',
          hasStoredPassword: true,
          sortOrder: 2,
          createdAt: '2020-01-01T00:00:00.000Z',
          updatedAt: '2020-01-02T00:00:00.000Z',
        },
      ],
    };
    const r = migrateStorageRoot(raw);
    assert.strictEqual(r.rootSchemaVersion, 2);
    assert.strictEqual(r.entries.length, 1);
    assert.strictEqual(r.entries[0].id, id);
    assert.strictEqual(r.entries[0].name, 'A');
    assert.strictEqual(r.entries[0].type, 'file');
    assert.strictEqual(r.entries[0].ibcmdConfigYamlPath, '/x/y.yaml');
  });

  test('migrateInfobaseEntry drops invalid rows', () => {
    assert.strictEqual(migrateInfobaseEntry(null), null);
    assert.strictEqual(migrateInfobaseEntry({ id: '' }), null);
    assert.strictEqual(
      migrateInfobaseEntry({
        id: randomUUID(),
        schemaVersion: 2,
        displayName: 'x',
        kind: 'file',
        ibcmdConfigYamlPath: '/p.yaml',
      }),
      null,
    );
  });
});

suite('infobaseValidator', () => {
  test('validateInfobaseEntry rejects non-uuid id', () => {
    const e = makeEntry({ id: 'not-a-uuid' });
    assert.throws(() => validateInfobaseEntry(e), InfobaseValidationError);
  });

  test('validateInfobaseEntry rejects UUID v1 (not v4)', () => {
    const e = makeEntry({ id: '6ba7b810-9dad-11d1-80b4-00c04fd430c8' });
    assert.throws(() => validateInfobaseEntry(e), InfobaseValidationError);
  });

  test('validateInfobaseEntry rejects empty id and whitespace id', () => {
    assert.throws(() => validateInfobaseEntry(makeEntry({ id: '' })), InfobaseValidationError);
    assert.throws(() => validateInfobaseEntry(makeEntry({ id: '   ' })), InfobaseValidationError);
  });

  test('validateInfobaseEntry rejects wrong type', () => {
    assert.throws(
      () => validateInfobaseEntry(makeEntry({ type: 'server' as InfobaseEntry['type'] })),
      InfobaseValidationError,
    );
  });

  test('validateInfobaseEntry rejects empty name', () => {
    assert.throws(() => validateInfobaseEntry(makeEntry({ name: '' })), InfobaseValidationError);
    assert.throws(() => validateInfobaseEntry(makeEntry({ name: '  ' })), InfobaseValidationError);
  });

  test('validateInfobaseEntry rejects file without filePath and yaml', () => {
    assert.throws(
      () =>
        validateInfobaseEntry(
          makeEntry({ filePath: undefined, ibcmdConfigYamlPath: undefined }),
        ),
      InfobaseValidationError,
    );
  });

  test('validateInfobaseEntry rejects empty createdAt', () => {
    assert.throws(() => validateInfobaseEntry(makeEntry({ createdAt: '' })), InfobaseValidationError);
  });

  test('validateInfobaseEntryList rejects duplicates', () => {
    const id = randomUUID();
    const a = makeEntry({ id, name: 'A' });
    const b = makeEntry({ id, name: 'B' });
    assert.throws(() => validateInfobaseEntryList([a, b]), InfobaseValidationError);
  });

  test('validateInfobaseEntryList accepts exactly max entries', () => {
    const list: InfobaseEntry[] = [];
    for (let i = 0; i < INFOBASE_STORAGE_MAX_ENTRIES; i += 1) {
      list.push(
        makeEntry({
          name: `E${i}`,
          ibcmdConfigYamlPath: `/p/${i}.yaml`,
          filePath: `/p`,
        }),
      );
    }
    assert.doesNotThrow(() => validateInfobaseEntryList(list));
  });
});

suite('InfobaseStorageService', () => {
  let memento: MapMemento;
  let secrets: MapSecretStorage;
  let service: InfobaseStorageService;

  setup(() => {
    memento = new MapMemento();
    secrets = new MapSecretStorage();
    service = new InfobaseStorageService(memento, secrets);
  });

  test('load returns empty then sorted by type then name', async () => {
    assert.deepStrictEqual(await service.load(), []);
    const e1 = makeEntry({ name: 'z' });
    const e2 = makeEntry({ name: 'a' });
    await service.saveAll([e1, e2]);
    const loaded = await service.load();
    assert.strictEqual(loaded[0].id, e2.id);
    assert.strictEqual(loaded[1].id, e1.id);
  });

  test('saveAll persists under design global state key with rootSchemaVersion 2', async () => {
    const e = makeEntry();
    await service.saveAll([e]);
    const stored = memento.get(INFOBASE_GLOBAL_STATE_KEY) as {
      rootSchemaVersion: number;
      entries: InfobaseEntry[];
    };
    assert.strictEqual(stored.rootSchemaVersion, 2);
    assert.strictEqual(stored.entries.length, 1);
    assert.strictEqual(stored.entries[0].id, e.id);
  });

  test('upsert merges by id', async () => {
    const e = makeEntry({ name: 'Old' });
    await service.saveAll([e]);
    const updated = { ...e, name: 'New', lastUsedAt: new Date().toISOString() };
    await service.upsert(updated);
    const one = await service.getById(e.id);
    assert.strictEqual(one?.name, 'New');
  });

  test('remove deletes password secret', async () => {
    const e = makeEntry({ hasStoredPassword: true });
    const key = infobasePasswordSecretKey(e.id);
    await secrets.store(key, 'secret');
    await service.saveAll([e]);
    await service.remove(e.id);
    assert.strictEqual(await secrets.get(key), undefined);
    assert.deepStrictEqual(await service.load(), []);
  });

  test('saveAll removes secrets for dropped entries', async () => {
    const a = makeEntry({ hasStoredPassword: true });
    const b = makeEntry({ hasStoredPassword: true });
    await secrets.store(infobasePasswordSecretKey(a.id), 'pa');
    await secrets.store(infobasePasswordSecretKey(b.id), 'pb');
    await service.saveAll([a, b]);
    await service.saveAll([a]);
    assert.strictEqual(await secrets.get(infobasePasswordSecretKey(b.id)), undefined);
    assert.strictEqual(await secrets.get(infobasePasswordSecretKey(a.id)), 'pa');
  });

  test('saveAll clears secret when hasStoredPassword becomes false', async () => {
    const e = makeEntry({ hasStoredPassword: true });
    const key = infobasePasswordSecretKey(e.id);
    await secrets.store(key, 'pw');
    await service.saveAll([e]);
    await service.saveAll([{ ...e, hasStoredPassword: false }]);
    assert.strictEqual(await secrets.get(key), undefined);
  });

  test('saveAll rejects more than max entries', async () => {
    const list: InfobaseEntry[] = [];
    for (let i = 0; i < INFOBASE_STORAGE_MAX_ENTRIES + 1; i += 1) {
      list.push(
        makeEntry({
          name: `E${i}`,
          ibcmdConfigYamlPath: `/p/${i}.yaml`,
          filePath: '/p',
        }),
      );
    }
    await assert.rejects(() => service.saveAll(list), InfobaseValidationError);
  });

  test('load returns empty when globalState.get throws', async () => {
    const broken = new ThrowingGetMemento();
    const s = new InfobaseStorageService(broken, secrets);
    assert.deepStrictEqual(await s.load(), []);
  });

  test('getById returns undefined for missing id', async () => {
    assert.strictEqual(await service.getById(randomUUID()), undefined);
  });

  test('remove for unknown id does not clear existing entries', async () => {
    const e = makeEntry();
    await service.saveAll([e]);
    await service.remove(randomUUID());
    const loaded = await service.load();
    assert.strictEqual(loaded.length, 1);
    assert.strictEqual(loaded[0].id, e.id);
  });

  test('upsert rejects invalid entry', async () => {
    const bad = makeEntry({ id: 'not-uuid' });
    await assert.rejects(() => service.upsert(bad), InfobaseValidationError);
  });

  test('migrates legacy globalState and password secret on first load', async () => {
    const id = randomUUID();
    const legacyEntry = {
      id,
      schemaVersion: 1,
      displayName: 'Legacy',
      groupLabel: '',
      kind: 'file',
      ibcmdConfigYamlPath: 'C:/bases/cfg/ib.yml',
      hasStoredPassword: true,
      sortOrder: 0,
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-02T00:00:00.000Z',
    };
    await memento.update(INFOBASE_LEGACY_GLOBAL_STATE_KEY, {
      rootSchemaVersion: 1,
      entries: [legacyEntry],
    });
    await secrets.store(infobaseLegacyPasswordSecretKey(id), 'secret-value');

    const loaded = await service.load();
    assert.strictEqual(loaded.length, 1);
    assert.strictEqual(loaded[0].name, 'Legacy');
    assert.strictEqual(loaded[0].ibcmdConfigYamlPath, 'C:/bases/cfg/ib.yml');
    assert.strictEqual(loaded[0].filePath, path.dirname('C:/bases/cfg/ib.yml'));

    const newRoot = memento.get(INFOBASE_GLOBAL_STATE_KEY) as { rootSchemaVersion: number };
    assert.strictEqual(newRoot.rootSchemaVersion, 2);
    assert.strictEqual(memento.get(INFOBASE_LEGACY_GLOBAL_STATE_KEY), undefined);
    assert.strictEqual(await secrets.get(infobasePasswordSecretKey(id)), 'secret-value');
    assert.strictEqual(await secrets.get(infobaseLegacyPasswordSecretKey(id)), undefined);
  });
});

suite('ExtensionState infobase wiring', () => {
  test('starts with infobaseStorage null', () => {
    assert.strictEqual(new ExtensionState().infobaseStorage, null);
  });

  test('init creates InfobaseStorageService; dispose clears it', async () => {
    const memento = new MapMemento();
    const secrets = new MapSecretStorage();
    const ctx = {
      globalState: memento,
      secrets,
      subscriptions: [] as vscode.Disposable[],
    } as unknown as vscode.ExtensionContext;

    const state = new ExtensionState();
    state.init(ctx);
    const ib = state.infobaseStorage;
    if (ib === null) {
      assert.fail('expected infobaseStorage after init');
    }

    const e = makeEntry();
    await ib.saveAll([e]);
    const stored = memento.get(INFOBASE_GLOBAL_STATE_KEY) as { entries: InfobaseEntry[] };
    assert.strictEqual(stored.entries.length, 1);

    state.dispose();
    assert.strictEqual(state.infobaseStorage, null);
  });
});
