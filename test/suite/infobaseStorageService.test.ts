import * as assert from 'assert';
import { randomUUID } from 'crypto';
import type { Memento, SecretStorage } from 'vscode';
import * as vscode from 'vscode';
import {
  infobasePasswordSecretKey,
  INFOBASE_GLOBAL_STATE_KEY,
  INFOBASE_PASSWORD_SECRET_PREFIX,
  INFOBASE_STORAGE_MAX_ENTRIES,
} from '../../src/infobases/constants';
import { migrateInfobaseEntry, migrateStorageRoot } from '../../src/infobases/infobaseMigration';
import { InfobaseStorageService } from '../../src/infobases/infobaseStorageService';
import {
  InfobaseValidationError,
  assertNoConflictingInfobaseTarget,
  infobaseDuplicateTargetKey,
  normalizeFsPathForCompare,
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
  const id = overrides.id ?? randomUUID();
  const base: InfobaseEntry = {
    id,
    name: 'Demo',
    type: 'file',
    filePath: `C:/tmp/${id}`,
    ibcmdConfigYamlPath: `C:/tmp/${id}/ib.yaml`,
    hasStoredPassword: false,
    createdAt: now,
    lastUsedAt: now,
  };
  return { ...base, ...overrides };
}

suite('infobaseConstants', () => {
  test('infobasePasswordSecretKey uses prefix and id', () => {
    const id = 'abc';
    assert.strictEqual(
      infobasePasswordSecretKey(id),
      `${INFOBASE_PASSWORD_SECRET_PREFIX}${id}`,
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

  test('migrateStorageRoot returns empty for non-object', () => {
    const r = migrateStorageRoot('x');
    assert.deepStrictEqual(r, { rootSchemaVersion: 2, entries: [] });
  });

  test('migrateStorageRoot returns empty for rootSchemaVersion other than 2', () => {
    const id = randomUUID();
    const raw = {
      rootSchemaVersion: 1,
      entries: [
        {
          id,
          name: 'A',
          type: 'file',
          filePath: '/x',
          ibcmdConfigYamlPath: '/x/y.yaml',
          hasStoredPassword: false,
          createdAt: '2020-01-01T00:00:00.000Z',
        },
      ],
    };
    const r = migrateStorageRoot(raw);
    assert.deepStrictEqual(r, { rootSchemaVersion: 2, entries: [] });
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

  test('validateInfobaseEntry rejects unsupported type string', () => {
    assert.throws(
      () => validateInfobaseEntry({ ...makeEntry(), type: 'bogus' as unknown as InfobaseEntry['type'] }),
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

  test('validateInfobaseEntry accepts file with yaml only (no filePath)', () => {
    assert.doesNotThrow(() =>
      validateInfobaseEntry(
        makeEntry({ filePath: undefined, ibcmdConfigYamlPath: 'C:/cfg/only.yaml' }),
      ),
    );
  });

  test('validateInfobaseEntry rejects server without server or database', () => {
    assert.throws(
      () =>
        validateInfobaseEntry(
          makeEntry({
            type: 'server',
            filePath: undefined,
            ibcmdConfigYamlPath: undefined,
            server: '',
            database: 'db',
          }),
        ),
      InfobaseValidationError,
    );
    assert.throws(
      () =>
        validateInfobaseEntry(
          makeEntry({
            type: 'server',
            filePath: undefined,
            ibcmdConfigYamlPath: undefined,
            server: 'srv',
            database: '  ',
          }),
        ),
      InfobaseValidationError,
    );
  });

  test('validateInfobaseEntry rejects web without webUrl', () => {
    assert.throws(
      () =>
        validateInfobaseEntry(
          makeEntry({
            type: 'web',
            filePath: undefined,
            ibcmdConfigYamlPath: undefined,
            webUrl: '',
          }),
        ),
      InfobaseValidationError,
    );
  });

  test('validateInfobaseEntry accepts valid UUID v4', () => {
    const id = randomUUID();
    assert.doesNotThrow(() => validateInfobaseEntry(makeEntry({ id })));
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
          filePath: `/p/${i}`,
        }),
      );
    }
    assert.doesNotThrow(() => validateInfobaseEntryList(list));
  });

  test('validateInfobaseEntryList rejects duplicate file path', () => {
    const a = makeEntry({ name: 'A', filePath: 'C:/same', ibcmdConfigYamlPath: '/x/a.yaml' });
    const b = makeEntry({ name: 'B', filePath: 'c:\\same\\', ibcmdConfigYamlPath: '/x/b.yaml' });
    assert.throws(() => validateInfobaseEntryList([a, b]), InfobaseValidationError);
  });

  test('validateInfobaseEntryList rejects more than max entries', () => {
    const list: InfobaseEntry[] = [];
    for (let i = 0; i < INFOBASE_STORAGE_MAX_ENTRIES + 1; i += 1) {
      list.push(
        makeEntry({
          name: `E${i}`,
          ibcmdConfigYamlPath: `/p/${i}.yaml`,
          filePath: `/p/${i}`,
        }),
      );
    }
    assert.throws(() => validateInfobaseEntryList(list), InfobaseValidationError);
  });

  test('validateInfobaseEntryList rejects duplicate yaml-only targets', () => {
    const a = makeEntry({
      name: 'A',
      filePath: undefined,
      ibcmdConfigYamlPath: 'D:/shared/ib.yaml',
    });
    const b = makeEntry({
      name: 'B',
      filePath: undefined,
      ibcmdConfigYamlPath: 'd:\\shared\\ib.yaml',
    });
    assert.throws(() => validateInfobaseEntryList([a, b]), InfobaseValidationError);
  });

  test('validateInfobaseEntryList rejects duplicate server target', () => {
    const a = makeEntry({
      type: 'server',
      name: 'A',
      filePath: undefined,
      ibcmdConfigYamlPath: undefined,
      server: 'Srv',
      database: 'db',
    });
    const b = makeEntry({
      type: 'server',
      name: 'B',
      filePath: undefined,
      ibcmdConfigYamlPath: undefined,
      server: 'srv',
      database: 'DB',
    });
    assert.throws(() => validateInfobaseEntryList([a, b]), InfobaseValidationError);
  });

  test('assertNoConflictingInfobaseTarget rejects duplicate file path', () => {
    const existing = makeEntry({ name: 'First', filePath: 'D:/bases/a' });
    const candidate = makeEntry({ name: 'Second', filePath: 'd:\\bases\\a\\' });
    assert.throws(
      () => assertNoConflictingInfobaseTarget(candidate, [existing]),
      (err: unknown) =>
        err instanceof InfobaseValidationError && (err.message as string).includes('First'),
    );
  });

  test('assertNoConflictingInfobaseTarget allows same id when excludeId matches (edit)', () => {
    const e = makeEntry({ name: 'Same', filePath: 'C:/one' });
    assert.doesNotThrow(() => assertNoConflictingInfobaseTarget(e, [e], e.id));
  });

  test('assertNoConflictingInfobaseTarget still conflicts when excludeId is different', () => {
    const a = makeEntry({ name: 'A', filePath: 'E:/dup' });
    const b = makeEntry({ name: 'B', filePath: 'e:/dup' });
    assert.throws(
      () => assertNoConflictingInfobaseTarget(b, [a], randomUUID()),
      InfobaseValidationError,
    );
  });

  test('assertNoConflictingInfobaseTarget no-op when duplicate key is empty', () => {
    const incomplete = {
      ...makeEntry({ filePath: undefined, ibcmdConfigYamlPath: undefined }),
      type: 'file' as const,
    };
    assert.doesNotThrow(() => assertNoConflictingInfobaseTarget(incomplete, []));
  });

  test('assertNoConflictingInfobaseTarget rejects duplicate web URL (normalized)', () => {
    const a = makeEntry({
      type: 'web',
      name: 'A',
      filePath: undefined,
      ibcmdConfigYamlPath: undefined,
      webUrl: 'https://host/path/',
    });
    const b = makeEntry({
      type: 'web',
      name: 'B',
      filePath: undefined,
      ibcmdConfigYamlPath: undefined,
      webUrl: 'https://host/path',
    });
    assert.throws(() => assertNoConflictingInfobaseTarget(b, [a]), InfobaseValidationError);
  });

  test('infobaseDuplicateTargetKey distinguishes file path vs yaml-only', () => {
    const byPath = makeEntry({ name: 'P', filePath: 'C:/ib', ibcmdConfigYamlPath: 'C:/other.yaml' });
    const byYaml = makeEntry({
      name: 'Y',
      filePath: undefined,
      ibcmdConfigYamlPath: 'C:/only.yaml',
    });
    assert.notStrictEqual(infobaseDuplicateTargetKey(byPath), infobaseDuplicateTargetKey(byYaml));
  });

  test('infobaseDuplicateTargetKey normalizes web URL query and host case', () => {
    const a = makeEntry({
      type: 'web',
      name: 'A',
      filePath: undefined,
      ibcmdConfigYamlPath: undefined,
      webUrl: 'https://HOST/base?q=1',
    });
    const b = makeEntry({
      type: 'web',
      name: 'B',
      filePath: undefined,
      ibcmdConfigYamlPath: undefined,
      webUrl: 'https://host/base/?q=1',
    });
    assert.strictEqual(infobaseDuplicateTargetKey(a), infobaseDuplicateTargetKey(b));
  });

  test('infobaseDuplicateTargetKey uses raw fallback for invalid web URL', () => {
    const e = makeEntry({
      type: 'web',
      name: 'W',
      filePath: undefined,
      ibcmdConfigYamlPath: undefined,
      webUrl: 'not a valid url',
    });
    assert.ok(infobaseDuplicateTargetKey(e).startsWith('web:raw:'));
  });
});

suite('normalizeFsPathForCompare', () => {
  test('empty and whitespace', () => {
    assert.strictEqual(normalizeFsPathForCompare(''), '');
    assert.strictEqual(normalizeFsPathForCompare('   '), '');
  });

  test('unifies slashes and trailing separators', () => {
    assert.strictEqual(normalizeFsPathForCompare('C:\\a\\b\\'), normalizeFsPathForCompare('c:/a/b'));
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
          filePath: `/p/${i}`,
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
