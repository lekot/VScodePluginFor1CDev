import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { Memento, SecretStorage } from 'vscode';
import * as vscode from 'vscode';
import { INFOBASE_STORAGE_MAX_ENTRIES } from '../../src/infobases/constants';
import {
  runAddExistingInfobase,
  runCreateInfobase,
  runEditInfobase,
  runImportV8i,
  runRemoveInfobase,
} from '../../src/infobases/infobaseCommands';
import { parseV8iContent } from '../../src/infobases/v8iParser';
import { getIbcmdService, resetIbcmdServiceSingletonForTests } from '../../src/services/ibcmd/ibcmdServiceSingleton';
import { BindingManager } from '../../src/bindings/bindingManager';
import { InfobaseManager } from '../../src/infobases/infobaseManager';
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

/** §3B: первый шаг при добавлении/редактировании серверной ИБ — выбор «строка / по полям». */
const SERVER_INPUT_FIELDS_MODE = { label: 'fields', mode: 'fields' as const };
const SERVER_INPUT_CONNECTION_STRING_MODE = { label: 'conn', mode: 'connectionString' as const };

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

function stubInfobaseCreate(
  impl: (dbPath: string) => Promise<{ stdout: string; stderr: string }>,
): () => void {
  const svc = getIbcmdService();
  const original = svc.runInfobaseCreateFileDb.bind(svc);
  (svc as { runInfobaseCreateFileDb: typeof original }).runInfobaseCreateFileDb = async (dbPath: string) =>
    impl(dbPath);
  return () => {
    (svc as { runInfobaseCreateFileDb: typeof original }).runInfobaseCreateFileDb = original;
  };
}

suite('infobaseCommands runCreateInfobase', () => {
  let memento: MapMemento;
  let secrets: MapSecretStorage;
  let service: InfobaseStorageService;
  let tempDir: string;
  let savedIbcmdPath: string | undefined;
  let restoreCreate: (() => void) | undefined;

  setup(() => {
    resetVscodeTestState();
    resetIbcmdServiceSingletonForTests();
    savedIbcmdPath = process.env.IBCMD_PATH;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-create-'));
    const exe = path.join(tempDir, 'stub-ibcmd');
    fs.writeFileSync(exe, '');
    process.env.IBCMD_PATH = exe;
    memento = new MapMemento();
    secrets = new MapSecretStorage();
    service = new InfobaseStorageService(memento, secrets);
    restoreCreate = undefined;
  });

  teardown(() => {
    if (restoreCreate) {
      restoreCreate();
      restoreCreate = undefined;
    }
    resetIbcmdServiceSingletonForTests();
    if (savedIbcmdPath === undefined) {
      delete process.env.IBCMD_PATH;
    } else {
      process.env.IBCMD_PATH = savedIbcmdPath;
    }
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    resetVscodeTestState();
  });

  test('shows error when storage is null', async () => {
    await runCreateInfobase(null);
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

    await runCreateInfobase(maxed);
    assert.strictEqual(vscodeTestState.warningLog.length, 1);
    assert.ok(vscodeTestState.warningLog[0].includes('лимит'));
  });

  test('returns early when user cancels type quick pick', async () => {
    vscodeTestState.quickPickQueue.push(undefined);
    await runCreateInfobase(service);
    assert.deepStrictEqual(await service.load(), []);
  });

  test('server type shows stub and does not change catalog', async () => {
    vscodeTestState.quickPickQueue.push({ label: 'srv', type: 'server' as const });
    await runCreateInfobase(service);
    assert.deepStrictEqual(await service.load(), []);
    assert.ok(
      vscodeTestState.informationLog.some(
        (m) => m.includes('Добавить существующую') && m.includes('Srvr'),
      ),
    );
  });

  test('web type shows §3C stub and does not change catalog', async () => {
    vscodeTestState.quickPickQueue.push({ label: 'web', type: 'web' as const });
    await runCreateInfobase(service);
    assert.deepStrictEqual(await service.load(), []);
    assert.ok(vscodeTestState.informationLog.some((m) => m.includes('§3C')));
  });

  test('creates file infobase: ibcmd success, catalog upsert, success notification', async () => {
    restoreCreate = stubInfobaseCreate(async (dbPath) => {
      assert.strictEqual(dbPath, path.resolve(path.join(tempDir, 'newib')));
      return { stdout: 'ok', stderr: '' };
    });
    vscodeTestState.quickPickQueue.push({ label: 'file', type: 'file' as const });
    vscodeTestState.openDialogQueue.push([{ fsPath: path.join(tempDir, 'newib'), scheme: 'file' }]);
    vscodeTestState.inputBoxQueue.push('ListedCreated');
    await runCreateInfobase(service);
    const list = await service.load();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].name, 'ListedCreated');
    assert.strictEqual(list[0].type, 'file');
    assert.strictEqual(list[0].filePath, path.resolve(path.join(tempDir, 'newib')));
    assert.ok(vscodeTestState.informationLog.some((m) => m.includes('База «ListedCreated» создана')));
  });

  test('shows ibcmd not found and does not upsert when path unresolved', async () => {
    resetIbcmdServiceSingletonForTests();
    delete process.env.IBCMD_PATH;
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.autoDetect'] = false;
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.path'] = path.join(tempDir, 'missing-ibcmd-exe');
    vscodeTestState.quickPickQueue.push({ label: 'file', type: 'file' as const });
    vscodeTestState.openDialogQueue.push([{ fsPath: path.join(tempDir, 'newdb'), scheme: 'file' }]);
    vscodeTestState.inputBoxQueue.push('NewDb');
    await runCreateInfobase(service);
    assert.deepStrictEqual(await service.load(), []);
    assert.ok(vscodeTestState.warningLog.some((m) => m.includes('ibcmd не найден')));
  });

  test('duplicate file path shows validation error and does not call create stub', async () => {
    const dupDir = path.join(tempDir, 'dup');
    await service.saveAll([
      makeEntry({
        name: 'First',
        filePath: dupDir,
        ibcmdConfigYamlPath: path.join(dupDir, 'y.yaml'),
      }),
    ]);
    let createCalls = 0;
    restoreCreate = stubInfobaseCreate(async () => {
      createCalls += 1;
      return { stdout: '', stderr: '' };
    });
    vscodeTestState.quickPickQueue.push({ label: 'file', type: 'file' as const });
    vscodeTestState.openDialogQueue.push([{ fsPath: dupDir, scheme: 'file' }]);
    vscodeTestState.inputBoxQueue.push('Second');
    await runCreateInfobase(service);
    assert.strictEqual(createCalls, 0);
    assert.strictEqual((await service.load()).length, 1);
    assert.ok(vscodeTestState.errorLog.some((m) => m.includes('уже есть')));
  });

  test('ibcmd failure shows error with stderr excerpt', async () => {
    restoreCreate = stubInfobaseCreate(async () => {
      throw Object.assign(new Error('fail'), { stderr: 'ibcmd failed here' });
    });
    vscodeTestState.quickPickQueue.push({ label: 'file', type: 'file' as const });
    vscodeTestState.openDialogQueue.push([{ fsPath: path.join(tempDir, 'faildb'), scheme: 'file' }]);
    vscodeTestState.inputBoxQueue.push('FailName');
    await runCreateInfobase(service);
    assert.deepStrictEqual(await service.load(), []);
    assert.ok(vscodeTestState.errorLog.some((m) => m.includes('ibcmd failed here')));
  });

  test('ibcmd failure uses stdout when stderr property is absent', async () => {
    restoreCreate = stubInfobaseCreate(async () => {
      throw Object.assign(new Error('x'), { stdout: 'only on stdout' });
    });
    vscodeTestState.quickPickQueue.push({ label: 'file', type: 'file' as const });
    vscodeTestState.openDialogQueue.push([{ fsPath: path.join(tempDir, 'stdouterr'), scheme: 'file' }]);
    vscodeTestState.inputBoxQueue.push('OutName');
    await runCreateInfobase(service);
    assert.deepStrictEqual(await service.load(), []);
    assert.ok(vscodeTestState.errorLog.some((m) => m.includes('only on stdout')));
  });

  test('long ibcmd stderr is truncated in error message', async () => {
    const long = 'e'.repeat(900);
    restoreCreate = stubInfobaseCreate(async () => {
      throw Object.assign(new Error('x'), { stderr: long });
    });
    vscodeTestState.quickPickQueue.push({ label: 'file', type: 'file' as const });
    vscodeTestState.openDialogQueue.push([{ fsPath: path.join(tempDir, 'longerr'), scheme: 'file' }]);
    vscodeTestState.inputBoxQueue.push('LongErr');
    await runCreateInfobase(service);
    const msg = vscodeTestState.errorLog.find((m) => m.includes('Не удалось создать'));
    assert.ok(msg);
    assert.ok(msg!.includes('…'));
    assert.ok(msg!.length < long.length);
  });

  test('invalidates ibcmd path cache when create fails with ENOENT', async () => {
    const svc = getIbcmdService();
    let invalidateCalls = 0;
    const origInvalidate = svc.invalidatePathCache.bind(svc);
    svc.invalidatePathCache = () => {
      invalidateCalls += 1;
      origInvalidate();
    };
    restoreCreate = stubInfobaseCreate(async () => {
      throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' as const });
    });
    try {
      vscodeTestState.quickPickQueue.push({ label: 'file', type: 'file' as const });
      vscodeTestState.openDialogQueue.push([{ fsPath: path.join(tempDir, 'enodb'), scheme: 'file' }]);
      vscodeTestState.inputBoxQueue.push('Eno');
      await runCreateInfobase(service);
      assert.strictEqual(invalidateCalls, 1);
      assert.ok(vscodeTestState.errorLog.some((m) => m.includes('Не удалось создать')));
    } finally {
      svc.invalidatePathCache = origInvalidate;
    }
  });

  test('invalidates path cache on ENOTDIR like ENOENT', async () => {
    const svc = getIbcmdService();
    let invalidateCalls = 0;
    const origInvalidate = svc.invalidatePathCache.bind(svc);
    svc.invalidatePathCache = () => {
      invalidateCalls += 1;
      origInvalidate();
    };
    restoreCreate = stubInfobaseCreate(async () => {
      throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' as const });
    });
    try {
      vscodeTestState.quickPickQueue.push({ label: 'file', type: 'file' as const });
      vscodeTestState.openDialogQueue.push([{ fsPath: path.join(tempDir, 'enotdir'), scheme: 'file' }]);
      vscodeTestState.inputBoxQueue.push('Enotdir');
      await runCreateInfobase(service);
      assert.strictEqual(invalidateCalls, 1);
    } finally {
      svc.invalidatePathCache = origInvalidate;
    }
  });

  test('returns early when folder dialog dismissed', async () => {
    restoreCreate = stubInfobaseCreate(async () => assert.fail('create must not run'));
    vscodeTestState.quickPickQueue.push({ label: 'file', type: 'file' as const });
    vscodeTestState.openDialogQueue.push([]);
    await runCreateInfobase(service);
    assert.deepStrictEqual(await service.load(), []);
  });

  test('returns early when name input cancelled', async () => {
    restoreCreate = stubInfobaseCreate(async () => assert.fail('create must not run'));
    vscodeTestState.quickPickQueue.push({ label: 'file', type: 'file' as const });
    vscodeTestState.openDialogQueue.push([{ fsPath: path.join(tempDir, 'x'), scheme: 'file' }]);
    await runCreateInfobase(service);
    assert.deepStrictEqual(await service.load(), []);
  });

  test('generic ibcmd failure without stderr falls back to default message', async () => {
    restoreCreate = stubInfobaseCreate(async () => {
      throw Object.assign(new Error(''), { message: '' });
    });
    vscodeTestState.quickPickQueue.push({ label: 'file', type: 'file' as const });
    vscodeTestState.openDialogQueue.push([{ fsPath: path.join(tempDir, 'gen'), scheme: 'file' }]);
    vscodeTestState.inputBoxQueue.push('G');
    await runCreateInfobase(service);
    assert.ok(vscodeTestState.errorLog.some((m) => m.includes('Не удалось создать базу (ibcmd).')));
  });
});

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
    vscodeTestState.quickPickQueue.push(
      { label: 'srv', type: 'server' as const },
      SERVER_INPUT_FIELDS_MODE,
    );
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
    vscodeTestState.quickPickQueue.push(
      { label: 'srv', type: 'server' as const },
      SERVER_INPUT_FIELDS_MODE,
    );
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

  /** WOW §3C #53 — validateWebClientUrlInput: только http(s), разбор через URL. */
  test('add web: URL step skips empty, bad parse, non-http scheme until valid https', async () => {
    vscodeTestState.quickPickQueue.push({ label: 'web', type: 'web' as const });
    vscodeTestState.inputBoxQueue.push(
      '   ',
      'not a url at all',
      'ftp://files.example/pub',
      'https://host/app/',
      'WebName',
    );
    await runAddExistingInfobase(service);
    const list = await service.load();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].webUrl, 'https://host/app/');
    assert.deepStrictEqual(
      vscodeTestState.inputBoxValidationFailures.map((x) => x.message),
      [
        'Введите URL',
        'Некорректный URL',
        'Используйте адрес с протоколом http:// или https://',
      ],
    );
  });

  test('add web: accepts http URL and trims whitespace', async () => {
    vscodeTestState.quickPickQueue.push({ label: 'web', type: 'web' as const });
    vscodeTestState.inputBoxQueue.push('  http://intranet.local/base/  ', 'HttpWeb');
    await runAddExistingInfobase(service);
    const list = await service.load();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].webUrl, 'http://intranet.local/base/');
    assert.strictEqual(vscodeTestState.inputBoxValidationFailures.length, 0);
  });

  test('add web: only invalid URL values in queue does not upsert', async () => {
    vscodeTestState.quickPickQueue.push({ label: 'web', type: 'web' as const });
    vscodeTestState.inputBoxQueue.push('javascript:alert(1)');
    await runAddExistingInfobase(service);
    assert.deepStrictEqual(await service.load(), []);
    assert.ok(
      vscodeTestState.inputBoxValidationFailures.some((x) =>
        x.message.includes('http://') && x.message.includes('https://'),
      ),
    );
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
    vscodeTestState.quickPickQueue.push(
      { label: 'srv', type: 'server' as const },
      SERVER_INPUT_FIELDS_MODE,
    );
    vscodeTestState.inputBoxQueue.push('srv1', 'db1', '', undefined, 'NoPwd');
    await runAddExistingInfobase(service);
    const list = await service.load();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].hasStoredPassword, false);
    assert.strictEqual(await secrets.get(`1cMetadataTree.infobase.password.${list[0].id}`), undefined);
  });

  test('add server: cancel at server input mode does not add entry', async () => {
    vscodeTestState.quickPickQueue.push({ label: 'srv', type: 'server' as const }, undefined);
    await runAddExistingInfobase(service);
    assert.deepStrictEqual(await service.load(), []);
  });

  test('add server via connection string with Pwd stores secret', async () => {
    vscodeTestState.quickPickQueue.push(
      { label: 'srv', type: 'server' as const },
      SERVER_INPUT_CONNECTION_STRING_MODE,
    );
    vscodeTestState.inputBoxQueue.push('Srvr="cs-srv";Ref="cs-ref";Usr="u";Pwd="cs-secret";', 'ListedCs');
    await runAddExistingInfobase(service);
    const list = await service.load();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].type, 'server');
    assert.strictEqual(list[0].server, 'cs-srv');
    assert.strictEqual(list[0].database, 'cs-ref');
    assert.strictEqual(list[0].user, 'u');
    assert.strictEqual(list[0].hasStoredPassword, true);
    const stored = await secrets.get(`1cMetadataTree.infobase.password.${list[0].id}`);
    assert.strictEqual(stored, 'cs-secret');
  });

  test('add server via connection string without Pwd asks user and optional password', async () => {
    vscodeTestState.quickPickQueue.push(
      { label: 'srv', type: 'server' as const },
      SERVER_INPUT_CONNECTION_STRING_MODE,
    );
    vscodeTestState.inputBoxQueue.push('Srvr="line-srv";Ref="line-ref";', 'line-user', 'line-pwd', 'LineName');
    await runAddExistingInfobase(service);
    const list = await service.load();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].server, 'line-srv');
    assert.strictEqual(list[0].database, 'line-ref');
    assert.strictEqual(list[0].user, 'line-user');
    assert.strictEqual(list[0].hasStoredPassword, true);
    assert.strictEqual(
      await secrets.get(`1cMetadataTree.infobase.password.${list[0].id}`),
      'line-pwd',
    );
  });

  test('add server via connection string rejects invalid line', async () => {
    vscodeTestState.quickPickQueue.push(
      { label: 'srv', type: 'server' as const },
      SERVER_INPUT_CONNECTION_STRING_MODE,
    );
    vscodeTestState.inputBoxQueue.push('Srvr="only";');
    await runAddExistingInfobase(service);
    assert.deepStrictEqual(await service.load(), []);
  });

  test('add server via connection string with empty Pwd key: no secret, hasStoredPassword false', async () => {
    vscodeTestState.quickPickQueue.push(
      { label: 'srv', type: 'server' as const },
      SERVER_INPUT_CONNECTION_STRING_MODE,
    );
    vscodeTestState.inputBoxQueue.push('Srvr="ep";Ref="er";Pwd="";', '', 'EmptyPwdName');
    await runAddExistingInfobase(service);
    const list = await service.load();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].hasStoredPassword, false);
    assert.strictEqual(
      await secrets.get(`1cMetadataTree.infobase.password.${list[0].id}`),
      undefined,
    );
  });
});

suite('infobaseCommands runRemoveInfobase', () => {
  let service: InfobaseStorageService;
  let manager: InfobaseManager;

  setup(() => {
    resetVscodeTestState();
    service = new InfobaseStorageService(new MapMemento(), new MapSecretStorage());
    manager = new InfobaseManager(service, new BindingManager());
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
    await runRemoveInfobase(manager, undefined);
    assert.ok(vscodeTestState.warningLog.some((m) => m.includes('выберите базу')));
  });

  test('does not remove when user dismisses confirm dialog', async () => {
    const e = makeEntry({ name: 'Keep' });
    await service.saveAll([e]);
    vscodeTestState.warningMessageReturnQueue.push(undefined);
    await runRemoveInfobase(manager, e);
    assert.strictEqual((await service.load()).length, 1);
  });

  test('removes after confirm', async () => {
    const e = makeEntry({ name: 'Gone' });
    await service.saveAll([e]);
    await runRemoveInfobase(manager, e);
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
    vscodeTestState.quickPickQueue.push(SERVER_INPUT_FIELDS_MODE);
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

  test('edit web: invalid URL attempts abort before upsert (name and URL unchanged)', async () => {
    const e = makeEntry({
      type: 'web',
      name: 'Keep',
      filePath: undefined,
      ibcmdConfigYamlPath: undefined,
      webUrl: 'https://stable/url',
    });
    await service.saveAll([e]);
    vscodeTestState.inputBoxQueue.push('Keep', 'file:///C:/secret');
    await runEditInfobase(service, e);
    const one = await service.getById(e.id);
    assert.strictEqual(one?.name, 'Keep');
    assert.strictEqual(one?.webUrl, 'https://stable/url');
    assert.ok(
      vscodeTestState.inputBoxValidationFailures.some((x) => x.attempted === 'file:///C:/secret'),
    );
  });

  test('edit server: cancel at input mode leaves entry unchanged', async () => {
    const e = makeEntry({
      type: 'server',
      name: 'Keep',
      filePath: undefined,
      ibcmdConfigYamlPath: undefined,
      server: 's0',
      database: 'd0',
    });
    await service.saveAll([e]);
    vscodeTestState.quickPickQueue.push(undefined);
    await runEditInfobase(service, e);
    const one = await service.getById(e.id);
    assert.strictEqual(one?.name, 'Keep');
    assert.strictEqual(one?.server, 's0');
    assert.strictEqual(one?.database, 'd0');
  });

  test('edit server fields: cancel password step does not upsert', async () => {
    const e = makeEntry({
      type: 'server',
      name: 'N',
      filePath: undefined,
      ibcmdConfigYamlPath: undefined,
      server: 's1',
      database: 'd1',
    });
    await service.saveAll([e]);
    vscodeTestState.quickPickQueue.push(SERVER_INPUT_FIELDS_MODE);
    vscodeTestState.inputBoxQueue.push('N2', 's2', 'd2', '', undefined);
    await runEditInfobase(service, e);
    const one = await service.getById(e.id);
    assert.strictEqual(one?.name, 'N');
    assert.strictEqual(one?.server, 's1');
    assert.strictEqual(one?.database, 'd1');
  });

  test('edit server via connection string updates cluster and database', async () => {
    const e = makeEntry({
      type: 'server',
      name: 'Srv',
      filePath: undefined,
      ibcmdConfigYamlPath: undefined,
      server: 'old',
      database: 'odb',
      user: 'u0',
      hasStoredPassword: false,
    });
    await service.saveAll([e]);
    vscodeTestState.quickPickQueue.push(SERVER_INPUT_CONNECTION_STRING_MODE);
    vscodeTestState.inputBoxQueue.push(
      'Srv2',
      'Srvr="newcl";Ref="ndb";Usr="u1";',
      '',
    );
    await runEditInfobase(service, e);
    const one = await service.getById(e.id);
    assert.strictEqual(one?.name, 'Srv2');
    assert.strictEqual(one?.server, 'newcl');
    assert.strictEqual(one?.database, 'ndb');
    assert.strictEqual(one?.user, 'u1');
  });

  test('edit server via connection string with Pwd updates secret', async () => {
    const e = makeEntry({
      type: 'server',
      name: 'P',
      filePath: undefined,
      ibcmdConfigYamlPath: undefined,
      server: 's',
      database: 'd',
      hasStoredPassword: false,
    });
    await service.saveAll([e]);
    const key = `1cMetadataTree.infobase.password.${e.id}`;
    vscodeTestState.quickPickQueue.push(SERVER_INPUT_CONNECTION_STRING_MODE);
    vscodeTestState.inputBoxQueue.push('P', 'Srvr="s";Ref="d";Pwd="newpw";');
    await runEditInfobase(service, e);
    const one = await service.getById(e.id);
    assert.strictEqual(one?.hasStoredPassword, true);
    assert.strictEqual(await secrets.get(key), 'newpw');
  });

  test('edit server fields: empty password keeps hasStoredPassword and existing secret', async () => {
    const e = makeEntry({
      type: 'server',
      name: 'KeepPwd',
      filePath: undefined,
      ibcmdConfigYamlPath: undefined,
      server: 'cl',
      database: 'db',
      hasStoredPassword: true,
    });
    await service.saveAll([e]);
    const key = `1cMetadataTree.infobase.password.${e.id}`;
    await secrets.store(key, 'unchanged');
    vscodeTestState.quickPickQueue.push(SERVER_INPUT_FIELDS_MODE);
    vscodeTestState.inputBoxQueue.push('KeepPwd', 'cl', 'db', '', '');
    await runEditInfobase(service, e);
    const one = await service.getById(e.id);
    assert.strictEqual(one?.hasStoredPassword, true);
    assert.strictEqual(await secrets.get(key), 'unchanged');
  });

  test('edit server fields: new non-empty password writes secret', async () => {
    const e = makeEntry({
      type: 'server',
      name: 'SetPwd',
      filePath: undefined,
      ibcmdConfigYamlPath: undefined,
      server: 's',
      database: 'd',
      hasStoredPassword: false,
    });
    await service.saveAll([e]);
    const key = `1cMetadataTree.infobase.password.${e.id}`;
    vscodeTestState.quickPickQueue.push(SERVER_INPUT_FIELDS_MODE);
    vscodeTestState.inputBoxQueue.push('SetPwd', 's', 'd', '', 'fresh-secret');
    await runEditInfobase(service, e);
    const one = await service.getById(e.id);
    assert.strictEqual(one?.hasStoredPassword, true);
    assert.strictEqual(await secrets.get(key), 'fresh-secret');
  });

  test('edit server connection string: cancel optional password step leaves entry unchanged', async () => {
    const e = makeEntry({
      type: 'server',
      name: 'NoChange',
      filePath: undefined,
      ibcmdConfigYamlPath: undefined,
      server: 'orig',
      database: 'odb',
      user: 'u0',
      hasStoredPassword: false,
    });
    await service.saveAll([e]);
    vscodeTestState.quickPickQueue.push(SERVER_INPUT_CONNECTION_STRING_MODE);
    vscodeTestState.inputBoxQueue.push('NoChange', 'Srvr="new";Ref="ndb";Usr="u1";', undefined);
    await runEditInfobase(service, e);
    const one = await service.getById(e.id);
    assert.strictEqual(one?.name, 'NoChange');
    assert.strictEqual(one?.server, 'orig');
    assert.strictEqual(one?.database, 'odb');
    assert.strictEqual(one?.user, 'u0');
  });

  test('edit server connection string: Pwd="" clears hasStoredPassword and secret', async () => {
    const e = makeEntry({
      type: 'server',
      name: 'Clr',
      filePath: undefined,
      ibcmdConfigYamlPath: undefined,
      server: 's',
      database: 'd',
      hasStoredPassword: true,
    });
    await service.saveAll([e]);
    const key = `1cMetadataTree.infobase.password.${e.id}`;
    await secrets.store(key, 'will-clear');
    vscodeTestState.quickPickQueue.push(SERVER_INPUT_CONNECTION_STRING_MODE);
    vscodeTestState.inputBoxQueue.push('Clr', 'Srvr="s";Ref="d";Pwd="";');
    await runEditInfobase(service, e);
    const one = await service.getById(e.id);
    assert.strictEqual(one?.hasStoredPassword, false);
    assert.strictEqual(await secrets.get(key), undefined);
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
    assert.strictEqual(d.length, 17);
    assert.deepStrictEqual(ids, [
      '1c-metadata-tree.infobases.refresh',
      '1c-metadata-tree.infobases.create',
      '1c-metadata-tree.infobases.add',
      '1c-metadata-tree.infobases.importV8i',
      '1c-metadata-tree.infobases.exportV8i',
      '1c-metadata-tree.infobases.newFolder',
      '1c-metadata-tree.infobase.deleteFolder',
      '1c-metadata-tree.infobase.renameFolder',
      '1c-metadata-tree.infobase.moveToFolder',
      '1c-metadata-tree.infobase.compareConfig',
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

  test('create command refreshes tree after successful file infobase create', async () => {
    resetIbcmdServiceSingletonForTests();
    const td = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-reg-create-'));
    const savedPath = process.env.IBCMD_PATH;
    try {
      const exe = path.join(td, 'ibcmd');
      fs.writeFileSync(exe, '');
      process.env.IBCMD_PATH = exe;

      const storage = new InfobaseStorageService(new MapMemento(), new MapSecretStorage());
      let refreshCalls = 0;
      const state = {
        infobaseStorage: storage,
        infobaseTreeProvider: { refresh: () => (refreshCalls += 1) },
      } as unknown as ExtensionState;

      const handlers = new Map<string, () => Promise<void>>();
      (vscode.commands as any).registerCommand = (id: string, fn: () => Promise<void>) => {
        handlers.set(id, fn);
        return { dispose: () => undefined };
      };

      const svc = getIbcmdService();
      const origCreate = svc.runInfobaseCreateFileDb.bind(svc);
      (svc as { runInfobaseCreateFileDb: typeof origCreate }).runInfobaseCreateFileDb = async () => ({
        stdout: '',
        stderr: '',
      });

      registerInfobaseTreeCommands(state);
      vscodeTestState.quickPickQueue.push({ label: 'file', type: 'file' as const });
      vscodeTestState.openDialogQueue.push([{ fsPath: path.join(td, 'newib'), scheme: 'file' }]);
      vscodeTestState.inputBoxQueue.push('FromCommand');

      await handlers.get('1c-metadata-tree.infobases.create')?.();

      (svc as { runInfobaseCreateFileDb: typeof origCreate }).runInfobaseCreateFileDb = origCreate;
      assert.strictEqual(refreshCalls, 1);
      assert.strictEqual((await storage.load()).length, 1);
      assert.strictEqual((await storage.load())[0].name, 'FromCommand');
    } finally {
      if (savedPath === undefined) {
        delete process.env.IBCMD_PATH;
      } else {
        process.env.IBCMD_PATH = savedPath;
      }
      resetIbcmdServiceSingletonForTests();
      fs.rmSync(td, { recursive: true, force: true });
    }
  });

  test('remove with non-entry arg shows warning', async () => {
    const storage = new InfobaseStorageService(new MapMemento(), new MapSecretStorage());
    const infobaseManager = new InfobaseManager(storage, new BindingManager());
    const state = {
      infobaseStorage: storage,
      infobaseManager,
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

  test('create command with null storage shows error', async () => {
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
    await handlers.get('1c-metadata-tree.infobases.create')?.();
    assert.ok(vscodeTestState.errorLog.some((m) => m.includes('не инициализировано')));
  });

  test('importV8i command with null storage shows error', async () => {
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
    await handlers.get('1c-metadata-tree.infobases.importV8i')?.();
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

suite('infobaseCommands runImportV8i', () => {
  let memento: MapMemento;
  let secrets: MapSecretStorage;
  let service: InfobaseStorageService;
  let tempDir: string;

  function quickPickFromEntries(text: string) {
    const { entries } = parseV8iContent(text);
    return entries.map((e) => ({
      label: e.name,
      description: '',
      detail: '',
      picked: true as const,
      v8i: e,
    }));
  }

  setup(() => {
    resetVscodeTestState();
    memento = new MapMemento();
    secrets = new MapSecretStorage();
    service = new InfobaseStorageService(memento, secrets);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8i-import-'));
  });

  teardown(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    resetVscodeTestState();
  });

  test('shows error when storage is null', async () => {
    await runImportV8i(null);
    assert.ok(vscodeTestState.errorLog.some((m) => m.includes('не инициализировано')));
  });

  test('shows warning when catalog is full', async () => {
    const entries = Array.from({ length: INFOBASE_STORAGE_MAX_ENTRIES }, (_, i) =>
      makeEntry({
        name: `e${i}`,
        filePath: `C:/cap/${i}`,
        ibcmdConfigYamlPath: `C:/cap/${i}/c.yaml`,
      }),
    );
    await service.saveAll(entries);
    await runImportV8i(service);
    assert.ok(vscodeTestState.warningLog.some((m) => m.includes('лимит')));
  });

  test('returns when open dialog cancelled', async () => {
    vscodeTestState.openDialogQueue.push([]);
    await runImportV8i(service);
    assert.deepStrictEqual(await service.load(), []);
  });

  test('imports selected file base from v8i file', async () => {
    const p = path.join(tempDir, 'list.v8i');
    const body = '[MyBase]\nConnect=File="C:/imported/ib";\n';
    fs.writeFileSync(p, body, 'utf8');
    vscodeTestState.openDialogQueue.push([{ fsPath: p, scheme: 'file' }]);
    vscodeTestState.quickPickQueue.push(quickPickFromEntries(body));
    let refreshed = 0;
    await runImportV8i(service, { onCatalogChanged: () => (refreshed += 1) });
    const list = await service.load();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].name, 'MyBase');
    assert.strictEqual(list[0].type, 'file');
    assert.strictEqual(list[0].filePath, path.resolve('C:/imported/ib'));
    assert.strictEqual(refreshed, 1);
    assert.ok(vscodeTestState.informationLog.some((m) => m.includes('Импорт .v8i')));
  });

  test('returns when quick pick dismissed', async () => {
    const p = path.join(tempDir, 'q.v8i');
    fs.writeFileSync(p, '[A]\nConnect=File="C:/a";\n', 'utf8');
    vscodeTestState.openDialogQueue.push([{ fsPath: p, scheme: 'file' }]);
    vscodeTestState.quickPickQueue.push(undefined);
    await runImportV8i(service);
    assert.deepStrictEqual(await service.load(), []);
  });

  test('returns when quick pick empty array', async () => {
    const p = path.join(tempDir, 'e.v8i');
    fs.writeFileSync(p, '[A]\nConnect=File="C:/a";\n', 'utf8');
    vscodeTestState.openDialogQueue.push([{ fsPath: p, scheme: 'file' }]);
    vscodeTestState.quickPickQueue.push([]);
    await runImportV8i(service);
    assert.deepStrictEqual(await service.load(), []);
  });

  test('error when selection exceeds remaining slots', async () => {
    const p = path.join(tempDir, 'two.v8i');
    const body = '[A]\nConnect=File="C:/a";\n[B]\nConnect=File="C:/b";\n';
    fs.writeFileSync(p, body, 'utf8');
    const almost = INFOBASE_STORAGE_MAX_ENTRIES - 1;
    await service.saveAll(
      Array.from({ length: almost }, (_, i) =>
        makeEntry({
          name: `x${i}`,
          filePath: `C:/x/${i}`,
          ibcmdConfigYamlPath: `C:/x/${i}/y.yaml`,
        }),
      ),
    );
    vscodeTestState.openDialogQueue.push([{ fsPath: p, scheme: 'file' }]);
    vscodeTestState.quickPickQueue.push(quickPickFromEntries(body));
    await runImportV8i(service);
    assert.strictEqual((await service.load()).length, almost);
    assert.ok(vscodeTestState.errorLog.some((m) => m.includes('Можно добавить не более 1')));
  });

  test('showErrorMessage when file read fails', async () => {
    vscodeTestState.openDialogQueue.push([{ fsPath: path.join(tempDir, 'missing.v8i'), scheme: 'file' }]);
    await runImportV8i(service);
    assert.ok(vscodeTestState.errorLog.some((m) => m.includes('Не удалось прочитать')));
  });

  test('error when nothing valid to import', async () => {
    const p = path.join(tempDir, 'bad.v8i');
    fs.writeFileSync(p, '[X]\nConnect=;\n', 'utf8');
    vscodeTestState.openDialogQueue.push([{ fsPath: p, scheme: 'file' }]);
    await runImportV8i(service);
    assert.ok(vscodeTestState.errorLog.some((m) => m.includes('нечего добавить')));
  });

  test('warning on partial parse errors then imports valid', async () => {
    const p = path.join(tempDir, 'mix.v8i');
    const body = '[Bad]\nNope=1\n[Good]\nConnect=File="C:/good";\n';
    fs.writeFileSync(p, body, 'utf8');
    vscodeTestState.openDialogQueue.push([{ fsPath: p, scheme: 'file' }]);
    vscodeTestState.quickPickQueue.push(quickPickFromEntries(fs.readFileSync(p, 'utf8')));
    await runImportV8i(service);
    assert.ok(vscodeTestState.warningLog.some((m) => m.includes('пропущено записей')));
    const list = await service.load();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].name, 'Good');
  });

  test('password modal dismiss cancels import', async () => {
    const p = path.join(tempDir, 'pwd.v8i');
    const body = '[S]\nConnect=Srvr="cl";Ref="db";Pwd="secret";\n';
    fs.writeFileSync(p, body, 'utf8');
    vscodeTestState.openDialogQueue.push([{ fsPath: p, scheme: 'file' }]);
    vscodeTestState.quickPickQueue.push(quickPickFromEntries(body));
    vscodeTestState.warningMessageReturnQueue.push(undefined);
    await runImportV8i(service);
    assert.deepStrictEqual(await service.load(), []);
  });

  test('server with password stores secret when user confirms', async () => {
    const p = path.join(tempDir, 'pw2.v8i');
    const body = '[S]\nConnect=Srvr="cl";Ref="db";Pwd="secret";\n';
    fs.writeFileSync(p, body, 'utf8');
    vscodeTestState.openDialogQueue.push([{ fsPath: p, scheme: 'file' }]);
    vscodeTestState.quickPickQueue.push(quickPickFromEntries(body));
    await runImportV8i(service);
    const list = await service.load();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].hasStoredPassword, true);
    const key = `1cMetadataTree.infobase.password.${list[0].id}`;
    assert.strictEqual(await secrets.get(key), 'secret');
  });

  test('skips duplicate target with validation warning', async () => {
    const dup = 'C:/same/ib';
    await service.saveAll([
      makeEntry({ name: 'Existing', filePath: dup, ibcmdConfigYamlPath: `${dup}/y.yaml` }),
    ]);
    const p = path.join(tempDir, 'dup.v8i');
    const body = `[New]\nConnect=File="${dup}";\n`;
    fs.writeFileSync(p, body, 'utf8');
    vscodeTestState.openDialogQueue.push([{ fsPath: p, scheme: 'file' }]);
    vscodeTestState.quickPickQueue.push(quickPickFromEntries(body));
    await runImportV8i(service);
    assert.strictEqual((await service.load()).length, 1);
    assert.ok(vscodeTestState.warningLog.some((m) => m.includes('не импортирована')));
  });

  test('imports web base without password modal', async () => {
    const p = path.join(tempDir, 'web.v8i');
    const body = '[W]\nConnect=ws="https://app.example/h";\n';
    fs.writeFileSync(p, body, 'utf8');
    vscodeTestState.openDialogQueue.push([{ fsPath: p, scheme: 'file' }]);
    vscodeTestState.quickPickQueue.push(quickPickFromEntries(body));
    await runImportV8i(service);
    const list = await service.load();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].type, 'web');
    assert.strictEqual(list[0].webUrl, 'https://app.example/h');
    assert.ok(vscodeTestState.informationLog.some((m) => m.includes('Импорт .v8i')));
    assert.strictEqual(vscodeTestState.warningMessageReturnQueue.length, 0);
  });

  test('server with empty Pwd imports without modal', async () => {
    const p = path.join(tempDir, 'srv-empty-pwd.v8i');
    const body = '[S]\nConnect=Srvr="cl";Ref="db";Pwd="";\n';
    fs.writeFileSync(p, body, 'utf8');
    vscodeTestState.openDialogQueue.push([{ fsPath: p, scheme: 'file' }]);
    vscodeTestState.quickPickQueue.push(quickPickFromEntries(body));
    await runImportV8i(service);
    const list = await service.load();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].type, 'server');
    assert.strictEqual(list[0].hasStoredPassword, false);
    assert.strictEqual(await secrets.get(`1cMetadataTree.infobase.password.${list[0].id}`), undefined);
  });

  test('imports multiple file bases in one pass', async () => {
    const p = path.join(tempDir, 'multi.v8i');
    const body = '[A]\nConnect=File="C:/m/a";\n[B]\nConnect=File="C:/m/b";\n';
    fs.writeFileSync(p, body, 'utf8');
    vscodeTestState.openDialogQueue.push([{ fsPath: p, scheme: 'file' }]);
    vscodeTestState.quickPickQueue.push(quickPickFromEntries(body));
    await runImportV8i(service);
    const list = await service.load();
    assert.strictEqual(list.length, 2);
    const names = new Set(list.map((e) => e.name));
    assert.ok(names.has('A'));
    assert.ok(names.has('B'));
  });

  test('reads UTF-16 LE .v8i from disk', async () => {
    const p = path.join(tempDir, 'u16.v8i');
    const inner = '[U16]\nConnect=File="C:/utf16ib";\n';
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(inner, 'utf16le')]);
    fs.writeFileSync(p, buf);
    vscodeTestState.openDialogQueue.push([{ fsPath: p, scheme: 'file' }]);
    vscodeTestState.quickPickQueue.push(quickPickFromEntries(inner));
    await runImportV8i(service);
    const list = await service.load();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].name, 'U16');
    assert.strictEqual(list[0].filePath, path.resolve('C:/utf16ib'));
  });
});
