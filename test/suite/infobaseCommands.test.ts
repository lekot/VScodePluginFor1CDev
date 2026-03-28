import * as assert from 'assert';
import { randomUUID } from 'crypto';
import type { Memento, SecretStorage } from 'vscode';
import * as vscode from 'vscode';
import { INFOBASE_STORAGE_MAX_ENTRIES } from '../../src/infobases/constants';
import {
  runAddExistingInfobase,
  runEditInfobase,
  runRemoveInfobase,
} from '../../src/infobases/infobaseCommands';
import { InfobaseStorageService } from '../../src/infobases/infobaseStorageService';
import { registerInfobaseTreeCommands } from '../../src/infobases/registerInfobaseTreeCommands';
import type { InfobaseEntry } from '../../src/infobases/models/infobaseEntry';
import type { InfobaseTreeEntry } from '../../src/infobases/infobaseTreeProvider';
import type { ExtensionState } from '../../src/state/extensionState';
import { resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';

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

  get onDidChange(): import('vscode').Event<{ key: string }> {
    return () => ({ dispose: () => undefined });
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
  };
  return { ...base, ...overrides };
}

suite('infobaseCommands runAddExistingInfobase', () => {
  let memento: MapMemento;
  let secrets: MapSecretStorage;
  let service: InfobaseStorageService;

  setup(() => {
    resetVscodeTestState();
    memento = new MapMemento();
    secrets = new MapSecretStorage();
    service = new InfobaseStorageService(memento, secrets);
  });

  teardown(() => {
    resetVscodeTestState();
  });

  test('shows error when storage is null', async () => {
    await runAddExistingInfobase(null);
    assert.strictEqual(vscodeTestState.errorLog.length, 1);
    assert.ok(vscodeTestState.errorLog[0].includes('не инициализировано'));
  });

  test('shows warning when catalog is at max capacity', async () => {
    const maxed: InfobaseStorageService = {
      load: async () =>
        Array.from({ length: INFOBASE_STORAGE_MAX_ENTRIES }, (_, i) =>
          makeEntry({
            name: `e${i}`,
            filePath: `C:/cap/${i}`,
            ibcmdConfigYamlPath: `C:/cap/${i}/c.yaml`,
          }),
        ),
      upsert: async () => assert.fail('upsert must not run when full'),
    } as unknown as InfobaseStorageService;

    await runAddExistingInfobase(maxed);
    assert.strictEqual(vscodeTestState.warningLog.length, 1);
    assert.ok(vscodeTestState.warningLog[0].includes('лимит'));
  });

  test('returns early when user cancels type quick pick', async () => {
    vscodeTestState.quickPickQueue.push(undefined);
    await runAddExistingInfobase(service);
    assert.deepStrictEqual(await service.load(), []);
  });

  test('adds file infobase after folder pick and name input', async () => {
    vscodeTestState.quickPickQueue.push({ label: 'file', type: 'file' as const });
    vscodeTestState.openDialogQueue.push([{ fsPath: 'C:/bases/newib', scheme: 'file' }]);
    vscodeTestState.inputBoxQueue.push('ListedName');
    await runAddExistingInfobase(service);
    const list = await service.load();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].name, 'ListedName');
    assert.strictEqual(list[0].type, 'file');
    assert.strictEqual(list[0].filePath, 'C:/bases/newib');
  });

  test('add file: shows error when path duplicates existing entry', async () => {
    const dupPath = 'D:/same/path';
    await service.saveAll([
      makeEntry({ name: 'First', filePath: dupPath, ibcmdConfigYamlPath: 'D:/same/a.yaml' }),
    ]);
    vscodeTestState.quickPickQueue.push({ label: 'file', type: 'file' as const });
    vscodeTestState.openDialogQueue.push([{ fsPath: 'd:\\same\\path\\', scheme: 'file' }]);
    vscodeTestState.inputBoxQueue.push('Second');
    await runAddExistingInfobase(service);
    assert.strictEqual((await service.load()).length, 1);
    assert.strictEqual(vscodeTestState.errorLog.length, 1);
    assert.ok(vscodeTestState.errorLog[0].includes('уже есть'));
  });

  test('adds server infobase and stores password when provided', async () => {
    vscodeTestState.quickPickQueue.push({ label: 'srv', type: 'server' as const });
    vscodeTestState.inputBoxQueue.push('cluster.local', 'db1', '', 'secret', 'SrvTitle');
    await runAddExistingInfobase(service);
    const list = await service.load();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].type, 'server');
    assert.strictEqual(list[0].server, 'cluster.local');
    assert.strictEqual(list[0].database, 'db1');
    assert.strictEqual(list[0].hasStoredPassword, true);
    const stored = await secrets.get(`1cMetadataTree.infobase.password.${list[0].id}`);
    assert.strictEqual(stored, 'secret');
  });

  test('add server: rejects duplicate server+database', async () => {
    await service.saveAll([
      makeEntry({
        type: 'server',
        name: 'A',
        filePath: undefined,
        ibcmdConfigYamlPath: undefined,
        server: 'S',
        database: 'D',
      }),
    ]);
    vscodeTestState.quickPickQueue.push({ label: 'srv', type: 'server' as const });
    vscodeTestState.inputBoxQueue.push('s', 'd', '', undefined, 'B');
    await runAddExistingInfobase(service);
    assert.strictEqual((await service.load()).length, 1);
    assert.ok(vscodeTestState.errorLog.some((m) => m.includes('уже есть')));
  });

  test('adds web infobase', async () => {
    vscodeTestState.quickPickQueue.push({ label: 'web', type: 'web' as const });
    vscodeTestState.inputBoxQueue.push('https://host/app/', 'WebName');
    await runAddExistingInfobase(service);
    const list = await service.load();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].type, 'web');
    assert.strictEqual(list[0].webUrl, 'https://host/app/');
  });

  test('add file: returns early when folder dialog is dismissed (empty result)', async () => {
    vscodeTestState.quickPickQueue.push({ label: 'file', type: 'file' as const });
    vscodeTestState.openDialogQueue.push([]);
    await runAddExistingInfobase(service);
    assert.deepStrictEqual(await service.load(), []);
  });

  test('add file: returns early when name input is cancelled', async () => {
    vscodeTestState.quickPickQueue.push({ label: 'file', type: 'file' as const });
    vscodeTestState.openDialogQueue.push([{ fsPath: 'C:/bases/x', scheme: 'file' }]);
    await runAddExistingInfobase(service);
    assert.deepStrictEqual(await service.load(), []);
  });

  test('add web: rejects duplicate URL (normalized)', async () => {
    await service.saveAll([
      makeEntry({
        type: 'web',
        name: 'First',
        filePath: undefined,
        ibcmdConfigYamlPath: undefined,
        webUrl: 'https://dup.example/base',
      }),
    ]);
    vscodeTestState.quickPickQueue.push({ label: 'web', type: 'web' as const });
    vscodeTestState.inputBoxQueue.push('https://dup.example/base/', 'Second');
    await runAddExistingInfobase(service);
    assert.strictEqual((await service.load()).length, 1);
    assert.ok(vscodeTestState.errorLog.some((m) => m.includes('уже есть')));
  });

  test('add server: no password does not write secret', async () => {
    vscodeTestState.quickPickQueue.push({ label: 'srv', type: 'server' as const });
    vscodeTestState.inputBoxQueue.push('srv1', 'db1', '', undefined, 'NoPwd');
    await runAddExistingInfobase(service);
    const list = await service.load();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].hasStoredPassword, false);
    assert.strictEqual(await secrets.get(`1cMetadataTree.infobase.password.${list[0].id}`), undefined);
  });
});

suite('infobaseCommands runRemoveInfobase', () => {
  let service: InfobaseStorageService;

  setup(() => {
    resetVscodeTestState();
    service = new InfobaseStorageService(new MapMemento(), new MapSecretStorage());
  });

  teardown(() => {
    resetVscodeTestState();
  });

  test('shows error when storage is null', async () => {
    await runRemoveInfobase(null, makeEntry());
    assert.strictEqual(vscodeTestState.errorLog.length, 1);
    assert.ok(vscodeTestState.errorLog[0].includes('не инициализировано'));
  });

  test('warns when entry is missing but storage exists', async () => {
    await runRemoveInfobase(service, undefined);
    assert.ok(vscodeTestState.warningLog.some((m) => m.includes('выберите базу')));
  });

  test('does not remove when user dismisses confirm dialog', async () => {
    const e = makeEntry({ name: 'Keep' });
    await service.saveAll([e]);
    vscodeTestState.warningMessageReturnQueue.push(undefined);
    await runRemoveInfobase(service, e);
    assert.strictEqual((await service.load()).length, 1);
  });

  test('removes after confirm', async () => {
    const e = makeEntry({ name: 'Gone' });
    await service.saveAll([e]);
    await runRemoveInfobase(service, e);
    assert.deepStrictEqual(await service.load(), []);
  });
});

suite('infobaseCommands runEditInfobase', () => {
  let service: InfobaseStorageService;
  let secrets: MapSecretStorage;

  setup(() => {
    resetVscodeTestState();
    secrets = new MapSecretStorage();
    service = new InfobaseStorageService(new MapMemento(), secrets);
  });

  teardown(() => {
    resetVscodeTestState();
  });

  test('shows error when storage is null', async () => {
    await runEditInfobase(null, makeEntry());
    assert.ok(vscodeTestState.errorLog.some((m) => m.includes('не инициализировано')));
  });

  test('warns when entry undefined', async () => {
    await runEditInfobase(service, undefined);
    assert.ok(vscodeTestState.warningLog.some((m) => m.includes('Редактирование')));
  });

  test('edit file: returns early when catalog path quick pick cancelled', async () => {
    const e = makeEntry({ name: 'N', filePath: 'C:/p', ibcmdConfigYamlPath: 'C:/p/y.yaml' });
    await service.saveAll([e]);
    vscodeTestState.inputBoxQueue.push('N2');
    vscodeTestState.quickPickQueue.push(undefined);
    await runEditInfobase(service, e);
    const one = await service.getById(e.id);
    assert.strictEqual(one?.name, 'N');
  });

  test('edit file: returns early when YAML step cancelled', async () => {
    const e = makeEntry({ name: 'N', filePath: 'C:/p', ibcmdConfigYamlPath: 'C:/p/y.yaml' });
    await service.saveAll([e]);
    vscodeTestState.inputBoxQueue.push('N2');
    vscodeTestState.quickPickQueue.push({ label: 'keep', path: null });
    await runEditInfobase(service, e);
    const one = await service.getById(e.id);
    assert.strictEqual(one?.name, 'N');
  });

  test('edit server: password "-" clears stored secret and flag', async () => {
    const e = makeEntry({
      type: 'server',
      name: 'S',
      filePath: undefined,
      ibcmdConfigYamlPath: undefined,
      server: 'cl',
      database: 'db',
      hasStoredPassword: true,
    });
    await service.saveAll([e]);
    const key = `1cMetadataTree.infobase.password.${e.id}`;
    await secrets.store(key, 'old-secret');
    vscodeTestState.inputBoxQueue.push('S', 'cl', 'db', '', '-');
    await runEditInfobase(service, e);
    const one = await service.getById(e.id);
    assert.strictEqual(one?.hasStoredPassword, false);
    assert.strictEqual(await secrets.get(key), undefined);
  });

  test('edit file: conflict with another entry shows error', async () => {
    const a = makeEntry({ name: 'A', filePath: 'C:/a', ibcmdConfigYamlPath: 'C:/a/y.yaml' });
    const b = makeEntry({ name: 'B', filePath: 'C:/b', ibcmdConfigYamlPath: 'C:/b/y.yaml' });
    await service.saveAll([a, b]);
    vscodeTestState.inputBoxQueue.push('B-renamed');
    vscodeTestState.quickPickQueue.push({ label: 'pick', path: '__pick__' as const });
    vscodeTestState.openDialogQueue.push([{ fsPath: 'C:/a', scheme: 'file' }]);
    vscodeTestState.inputBoxQueue.push('');
    await runEditInfobase(service, b);
    const loaded = await service.load();
    assert.strictEqual(loaded.find((x) => x.id === b.id)?.filePath, 'C:/b');
    assert.ok(vscodeTestState.errorLog.some((m) => m.includes('уже есть')));
  });

  test('edit file: keep path updates name', async () => {
    const e = makeEntry({ name: 'Old', filePath: 'C:/keep', ibcmdConfigYamlPath: 'C:/keep/y.yaml' });
    await service.saveAll([e]);
    vscodeTestState.inputBoxQueue.push('NewName');
    vscodeTestState.quickPickQueue.push({ label: 'keep', path: null });
    vscodeTestState.inputBoxQueue.push('');
    await runEditInfobase(service, e);
    const one = await service.getById(e.id);
    assert.strictEqual(one?.name, 'NewName');
    assert.strictEqual(one?.filePath, 'C:/keep');
  });

  test('edit web: same url for same id succeeds', async () => {
    const e = makeEntry({
      type: 'web',
      name: 'W',
      filePath: undefined,
      ibcmdConfigYamlPath: undefined,
      webUrl: 'https://x/y',
    });
    await service.saveAll([e]);
    vscodeTestState.inputBoxQueue.push('W2', 'https://x/y');
    await runEditInfobase(service, e);
    const one = await service.getById(e.id);
    assert.strictEqual(one?.name, 'W2');
  });
});

suite('registerInfobaseTreeCommands', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any -- match elementCommands.test.ts VS Code stub patching */
  const defaultRegister = vscode.commands.registerCommand.bind(vscode.commands);

  setup(() => {
    resetVscodeTestState();
  });

  teardown(() => {
    (vscode.commands as any).registerCommand = defaultRegister;
    resetVscodeTestState();
  });

  test('registers expected command ids', () => {
    const ids: string[] = [];
    (vscode.commands as any).registerCommand = (id: string) => {
      ids.push(id);
      return { dispose: () => undefined };
    };

    const state = {
      infobaseStorage: null,
      infobaseTreeProvider: null,
    } as unknown as ExtensionState;

    const d = registerInfobaseTreeCommands(state);
    assert.strictEqual(d.length, 11);
    assert.deepStrictEqual(ids, [
      '1c-metadata-tree.infobases.refresh',
      '1c-metadata-tree.infobases.create',
      '1c-metadata-tree.infobases.add',
      '1c-metadata-tree.infobases.importV8i',
      '1c-metadata-tree.infobase.openEnterprise',
      '1c-metadata-tree.infobase.openDesigner',
      '1c-metadata-tree.infobase.configImport',
      '1c-metadata-tree.infobase.configExport',
      '1c-metadata-tree.infobase.configCheck',
      '1c-metadata-tree.infobase.edit',
      '1c-metadata-tree.infobase.remove',
    ]);
  });

  test('refresh invokes tree provider refresh', () => {
    let calls = 0;
    const state = {
      infobaseStorage: null,
      infobaseTreeProvider: { refresh: () => (calls += 1) },
    } as unknown as ExtensionState;

    const handlers = new Map<string, () => void>();
    (vscode.commands as any).registerCommand = (id: string, fn: () => void) => {
      handlers.set(id, fn);
      return { dispose: () => undefined };
    };

    registerInfobaseTreeCommands(state);
    handlers.get('1c-metadata-tree.infobases.refresh')?.();
    assert.strictEqual(calls, 1);
  });

  test('remove with non-entry arg shows warning', async () => {
    const state = {
      infobaseStorage: new InfobaseStorageService(new MapMemento(), new MapSecretStorage()),
      infobaseTreeProvider: null,
    } as unknown as ExtensionState;

    const handlers = new Map<string, (arg?: unknown) => Promise<void>>();
    (vscode.commands as any).registerCommand = (id: string, fn: (a?: unknown) => Promise<void>) => {
      handlers.set(id, fn);
      return { dispose: () => undefined };
    };

    registerInfobaseTreeCommands(state);
    await handlers.get('1c-metadata-tree.infobase.remove')?.({ kind: 'group', group: 'file' });
    assert.ok(vscodeTestState.warningLog.some((m) => m.includes('выберите базу')));
  });

  test('add command with null storage shows error', async () => {
    const state = {
      infobaseStorage: null,
      infobaseTreeProvider: null,
    } as unknown as ExtensionState;

    const handlers = new Map<string, () => Promise<void>>();
    (vscode.commands as any).registerCommand = (id: string, fn: () => Promise<void>) => {
      handlers.set(id, fn);
      return { dispose: () => undefined };
    };

    registerInfobaseTreeCommands(state);
    await handlers.get('1c-metadata-tree.infobases.add')?.();
    assert.ok(vscodeTestState.errorLog.some((m) => m.includes('не инициализировано')));
  });

  test('edit command resolves entry from storage before runEditInfobase', async () => {
    const memento = new MapMemento();
    const secrets = new MapSecretStorage();
    const storage = new InfobaseStorageService(memento, secrets);
    const e = makeEntry({
      name: 'Canonical',
      filePath: 'C:/good',
      ibcmdConfigYamlPath: 'C:/good/y.yaml',
    });
    await storage.saveAll([e]);
    const staleNode: InfobaseTreeEntry = {
      kind: 'entry',
      entry: { ...e, name: 'Stale', filePath: 'C:/bad' },
    };

    const state = {
      infobaseStorage: storage,
      infobaseTreeProvider: null,
    } as unknown as ExtensionState;

    const handlers = new Map<string, (arg?: unknown) => Promise<void>>();
    (vscode.commands as any).registerCommand = (id: string, fn: (a?: unknown) => Promise<void>) => {
      handlers.set(id, fn);
      return { dispose: () => undefined };
    };

    registerInfobaseTreeCommands(state);
    vscodeTestState.inputBoxQueue.push('Canonical');
    vscodeTestState.quickPickQueue.push({ label: 'keep', path: null });
    vscodeTestState.inputBoxQueue.push('');
    await handlers.get('1c-metadata-tree.infobase.edit')?.(staleNode);
    const one = await storage.getById(e.id);
    assert.strictEqual(one?.filePath, 'C:/good');
  });
  /* eslint-enable @typescript-eslint/no-explicit-any */
});
