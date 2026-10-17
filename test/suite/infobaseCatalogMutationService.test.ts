import * as assert from 'assert';
import type { Memento, SecretStorage, WorkspaceFolder, Uri, FileSystem } from 'vscode';
import * as vscode from 'vscode';
import {
  InfobaseCatalogMutationService,
  type SaveInfobaseParams,
  type RemoveInfobaseParams,
  INFOBASE_MUTATION_JOURNAL_KEY,
} from '../../src/infobases/infobaseCatalogMutationService';
import { InfobaseStorageService } from '../../src/infobases/infobaseStorageService';
import { BindingManager } from '../../src/bindings/bindingManager';
import type { InfobaseEntry } from '../../src/infobases/models/infobaseEntry';
import type { ConfigurationBinding } from '../../src/bindings/models/configurationBinding';
import { infobasePasswordSecretKey, INFOBASE_GLOBAL_STATE_KEY } from '../../src/infobases/constants';
import { INFOBASE_BINDINGS_FILE_NAME } from '../../src/bindings/bindingConstants';

class MockMemento implements Memento {
  readonly map = new Map<string, unknown>();
  public failOnUpdate = false;
  public failOnKey?: string;
  public failOnPredicate?: (key: string, value: unknown) => boolean;

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

  async update(key: string, value: unknown): Promise<void> {
    if (
      (this.failOnUpdate && (!this.failOnKey || this.failOnKey === key)) ||
      (this.failOnPredicate && this.failOnPredicate(key, value))
    ) {
      throw new Error('Simulated globalState.update failure');
    }
    if (value === undefined) {
      this.map.delete(key);
    } else {
      this.map.set(key, value);
    }
  }
}

class MockSecretStorage implements SecretStorage {
  readonly values = new Map<string, string>();
  public failOnStore = false;
  public failOnDelete = false;
  public failOnRollback = false;

  readonly onDidChange = new vscode.EventEmitter<{ key: string }>().event;

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    if (this.failOnStore || (this.failOnRollback && value === 'old-password')) {
      throw new Error('Simulated SecretStorage.store failure');
    }
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    if (this.failOnDelete) {
      throw new Error('Simulated SecretStorage.delete failure');
    }
    this.values.delete(key);
  }

  async keys(): Promise<string[]> {
    return [...this.values.keys()];
  }
}

class MockFileSystem {
  readonly files = new Map<string, Uint8Array>();
  public failOnWrite = false;
  public failOnUri: string | null = null;

  async readFile(uri: Uri): Promise<Uint8Array> {
    const data = this.files.get(uri.toString());
    if (!data) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return data;
  }

  async writeFile(uri: Uri, content: Uint8Array): Promise<void> {
    if (this.failOnWrite || (this.failOnUri && uri.toString().includes(this.failOnUri))) {
      throw new Error(`Simulated writeFile failure for ${uri.toString()}`);
    }
    this.files.set(uri.toString(), content);
  }
}

function makeFolder(name: string, fsPath: string): WorkspaceFolder {
  return {
    name,
    index: 0,
    uri: vscode.Uri.file(fsPath),
  };
}

function encodeBindings(bindings: ConfigurationBinding[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, bindings }, null, 2));
}

function decodeBindings(data: Uint8Array): ConfigurationBinding[] {
  return (JSON.parse(new TextDecoder().decode(data)) as { bindings: ConfigurationBinding[] }).bindings;
}

suite('InfobaseCatalogMutationService (#254 Aggregate Consistency)', () => {
  let memento: MockMemento;
  let secrets: MockSecretStorage;
  let mockFs: MockFileSystem;
  let storage: InfobaseStorageService;
  let bindingManager: BindingManager;
  let mutationService: InfobaseCatalogMutationService;
  let workspaceFolders: WorkspaceFolder[];

  const SERVER_IB_ID = '11111111-2222-4333-8444-555555555555';
  const FILE_IB_ID = '66666666-7777-4888-9999-000000000000';

  const testServerEntry: InfobaseEntry = {
    id: SERVER_IB_ID,
    name: 'Test Server Infobase',
    type: 'server',
    server: 'srv:1541',
    database: 'test_db',
    user: 'Administrator',
    hasStoredPassword: true,
    createdAt: new Date().toISOString(),
  };

  const testFileEntry: InfobaseEntry = {
    id: FILE_IB_ID,
    name: 'Test File Infobase',
    type: 'file',
    filePath: 'C:\\data\\db1',
    hasStoredPassword: false,
    createdAt: new Date().toISOString(),
  };

  setup(() => {
    memento = new MockMemento();
    secrets = new MockSecretStorage();
    mockFs = new MockFileSystem();
    workspaceFolders = [
      makeFolder('ws1', 'C:\\workspace\\ws1'),
      makeFolder('ws2', 'C:\\workspace\\ws2'),
    ];

    storage = new InfobaseStorageService(memento, secrets);
    bindingManager = new BindingManager({
      fileSystem: mockFs as unknown as FileSystem,
      getWorkspaceFolders: () => workspaceFolders,
    });

    mutationService = new InfobaseCatalogMutationService({
      storage,
      secretStorage: secrets,
      bindingManager,
      memento,
      fileSystem: mockFs as unknown as FileSystem,
      getWorkspaceFolders: () => workspaceFolders,
    });
  });

  // ─── 1. SaveInfobase — Happy Paths ───────────────────────────────────────────

  test('saveInfobase creates server entry and stores password in a single operation', async () => {
    const outcome = await mutationService.saveInfobase({
      entry: testServerEntry,
      passwordChange: { kind: 'set', password: 'secret-password-123' },
    });

    assert.strictEqual(outcome.success, true);
    if (!outcome.success) return;

    // Verify storage has the entry
    const saved = await storage.getById(testServerEntry.id);
    assert.ok(saved);
    assert.strictEqual(saved.name, testServerEntry.name);
    assert.strictEqual(saved.hasStoredPassword, true);

    // Verify secret was written
    const secret = await secrets.get(infobasePasswordSecretKey(testServerEntry.id));
    assert.strictEqual(secret, 'secret-password-123');

    // Verify no dangling journal remains
    assert.strictEqual(memento.get(INFOBASE_MUTATION_JOURNAL_KEY), undefined);
  });

  test('saveInfobase creates entry without password and ensures no orphan secret exists', async () => {
    const outcome = await mutationService.saveInfobase({
      entry: testFileEntry,
      passwordChange: { kind: 'clear' },
    });

    assert.strictEqual(outcome.success, true);
    const saved = await storage.getById(testFileEntry.id);
    assert.ok(saved);
    assert.strictEqual(saved.hasStoredPassword, false);

    const secret = await secrets.get(infobasePasswordSecretKey(testFileEntry.id));
    assert.strictEqual(secret, undefined);
  });

  test('saveInfobase updates existing entry keeping existing password when kind=keep', async () => {
    // Initial save with password
    await mutationService.saveInfobase({
      entry: testServerEntry,
      passwordChange: { kind: 'set', password: 'existing-password' },
    });

    // Update name but keep password
    const updatedEntry: InfobaseEntry = { ...testServerEntry, name: 'Renamed Server Infobase' };
    const outcome = await mutationService.saveInfobase({
      entry: updatedEntry,
      passwordChange: { kind: 'keep' },
    });

    assert.strictEqual(outcome.success, true);
    const saved = await storage.getById(testServerEntry.id);
    assert.strictEqual(saved?.name, 'Renamed Server Infobase');
    assert.strictEqual(saved?.hasStoredPassword, true);

    const secret = await secrets.get(infobasePasswordSecretKey(testServerEntry.id));
    assert.strictEqual(secret, 'existing-password');
  });

  // ─── 2. SaveInfobase — Validation & Fault Injections ─────────────────────────

  test('saveInfobase rejects contradictory password configuration before any writes', async () => {
    // hasStoredPassword=true but kind=clear
    const outcome = await mutationService.saveInfobase({
      entry: { ...testServerEntry, hasStoredPassword: true },
      passwordChange: { kind: 'clear' },
    });

    assert.strictEqual(outcome.success, false);
    if (outcome.success) return;
    assert.strictEqual(outcome.code, 'VALIDATION_FAILED');

    // No entry or secret should be created
    assert.strictEqual(await storage.getById(testServerEntry.id), undefined);
    assert.strictEqual(await secrets.get(infobasePasswordSecretKey(testServerEntry.id)), undefined);
  });

  test('saveInfobase rolls back when SecretStorage.store fails on new entry', async () => {
    secrets.failOnStore = true;

    const outcome = await mutationService.saveInfobase({
      entry: testServerEntry,
      passwordChange: { kind: 'set', password: 'new-password' },
    });

    assert.strictEqual(outcome.success, false);
    if (outcome.success) return;
    assert.strictEqual(outcome.code, 'SECRET_STORAGE_FAILED');
    assert.strictEqual(outcome.rolledBack, true);

    // Catalog must not have been modified
    assert.strictEqual(await storage.getById(testServerEntry.id), undefined);
    assert.strictEqual(memento.get(INFOBASE_MUTATION_JOURNAL_KEY), undefined);
  });

  test('saveInfobase rolls back SecretStorage to previous password when globalState.update fails', async () => {
    // Save initial state
    await mutationService.saveInfobase({
      entry: testServerEntry,
      passwordChange: { kind: 'set', password: 'old-password' },
    });

    // Now make globalState fail on update
    memento.failOnKey = INFOBASE_GLOBAL_STATE_KEY;
    memento.failOnUpdate = true;

    const outcome = await mutationService.saveInfobase({
      entry: { ...testServerEntry, name: 'Changed Name' },
      passwordChange: { kind: 'set', password: 'new-password' },
    });

    assert.strictEqual(outcome.success, false);
    if (outcome.success) return;
    assert.strictEqual(outcome.code, 'GLOBAL_STATE_FAILED');
    assert.strictEqual(outcome.rolledBack, true);

    // Secret must have been rolled back to old-password!
    const secret = await secrets.get(infobasePasswordSecretKey(testServerEntry.id));
    assert.strictEqual(secret, 'old-password');

    // Catalog has unchanged old name
    memento.failOnUpdate = false;
    memento.failOnKey = undefined;
    const current = await storage.getById(testServerEntry.id);
    assert.strictEqual(current?.name, testServerEntry.name);
  });

  test('saveInfobase deletes newly stored secret when globalState fails on newly inserted entry', async () => {
    memento.failOnKey = INFOBASE_GLOBAL_STATE_KEY;
    memento.failOnUpdate = true;

    const outcome = await mutationService.saveInfobase({
      entry: testServerEntry,
      passwordChange: { kind: 'set', password: 'brand-new-password' },
    });

    assert.strictEqual(outcome.success, false);
    if (outcome.success) return;
    assert.strictEqual(outcome.code, 'GLOBAL_STATE_FAILED');
    assert.strictEqual(outcome.rolledBack, true);

    // Secret must be cleaned up (no orphan secret)
    assert.strictEqual(await secrets.get(infobasePasswordSecretKey(testServerEntry.id)), undefined);
  });

  // ─── 3. RemoveInfobase — Happy Path & Cascade ────────────────────────────────

  test('removeInfobase removes from bindings, catalog, and secrets in a single coordinated operation', async () => {
    // Setup initial infobase with password
    await mutationService.saveInfobase({
      entry: testServerEntry,
      passwordChange: { kind: 'set', password: 'my-pass' },
    });

    // Setup bindings referencing this infobase in ws1 and ws2
    const bindingsWs1Uri = vscode.Uri.file(`C:\\workspace\\ws1\\.vscode\\${INFOBASE_BINDINGS_FILE_NAME}`);
    const bindingsWs2Uri = vscode.Uri.file(`C:\\workspace\\ws2\\.vscode\\${INFOBASE_BINDINGS_FILE_NAME}`);

    mockFs.files.set(bindingsWs1Uri.toString(), encodeBindings([
      { workspaceFolder: 'ws1', configRelativePath: 'src/cf', infobaseIds: [testServerEntry.id, 'other-ib'], massDeployment: false },
    ]));
    mockFs.files.set(bindingsWs2Uri.toString(), encodeBindings([
      { workspaceFolder: 'ws2', configRelativePath: 'ext/cfe', infobaseIds: [testServerEntry.id], massDeployment: false },
    ]));

    const outcome = await mutationService.removeInfobase({ infobaseId: testServerEntry.id });

    assert.strictEqual(outcome.success, true);
    if (!outcome.success) return;
    assert.strictEqual(outcome.removedFromBindingsCount, 2);

    // Verify removed from catalog
    assert.strictEqual(await storage.getById(testServerEntry.id), undefined);

    // Verify secret removed
    assert.strictEqual(await secrets.get(infobasePasswordSecretKey(testServerEntry.id)), undefined);

    // Verify bindings updated without dangling ID
    const updatedWs1 = await bindingManager.listAll();
    const b1 = updatedWs1.find((b) => b.workspaceFolder === 'ws1');
    const b2 = updatedWs1.find((b) => b.workspaceFolder === 'ws2');
    assert.deepStrictEqual(b1?.infobaseIds, ['other-ib']);
    assert.deepStrictEqual(b2?.infobaseIds, []);
  });

  // ─── 4. RemoveInfobase — Preflight Fault Prevention & Rollback ───────────────

  test('removeInfobase fails closed without removing entry or secrets when a bindings file is corrupted', async () => {
    await mutationService.saveInfobase({
      entry: testServerEntry,
      passwordChange: { kind: 'set', password: 'my-pass' },
    });

    // Make ws1 bindings file corrupted JSON
    const bindingsWs1Uri = vscode.Uri.file(`C:\\workspace\\ws1\\.vscode\\${INFOBASE_BINDINGS_FILE_NAME}`);
    mockFs.files.set(bindingsWs1Uri.toString(), new TextEncoder().encode('{ invalid json here'));

    const outcome = await mutationService.removeInfobase({ infobaseId: testServerEntry.id });

    assert.strictEqual(outcome.success, false);
    if (outcome.success) return;
    assert.strictEqual(outcome.code, 'BINDINGS_CORRUPTED');
    assert.strictEqual(outcome.rolledBack, true);

    // Infobase catalog and secret MUST remain untouched!
    const catalogEntry = await storage.getById(testServerEntry.id);
    assert.ok(catalogEntry, 'Catalog entry must not be deleted when bindings are corrupted');
    const secret = await secrets.get(infobasePasswordSecretKey(testServerEntry.id));
    assert.strictEqual(secret, 'my-pass', 'Secret must remain untouched');
  });

  test('removeInfobase rolls back modified bindings when write to a subsequent folder fails', async () => {
    await mutationService.saveInfobase({
      entry: testServerEntry,
      passwordChange: { kind: 'set', password: 'my-pass' },
    });

    const bindingsWs1Uri = vscode.Uri.file(`C:\\workspace\\ws1\\.vscode\\${INFOBASE_BINDINGS_FILE_NAME}`);
    const bindingsWs2Uri = vscode.Uri.file(`C:\\workspace\\ws2\\.vscode\\${INFOBASE_BINDINGS_FILE_NAME}`);

    mockFs.files.set(bindingsWs1Uri.toString(), encodeBindings([
      { workspaceFolder: 'ws1', configRelativePath: 'src/cf', infobaseIds: [testServerEntry.id], massDeployment: false },
    ]));
    mockFs.files.set(bindingsWs2Uri.toString(), encodeBindings([
      { workspaceFolder: 'ws2', configRelativePath: 'ext/cfe', infobaseIds: [testServerEntry.id], massDeployment: false },
    ]));

    // Fail write on ws2
    mockFs.failOnUri = 'ws2';

    const outcome = await mutationService.removeInfobase({ infobaseId: testServerEntry.id });

    assert.strictEqual(outcome.success, false);
    if (outcome.success) return;
    assert.strictEqual(outcome.code, 'BINDINGS_WRITE_FAILED');
    assert.strictEqual(outcome.rolledBack, true);

    // ws1 bindings must have been rolled back to original!
    mockFs.failOnUri = null;
    const ws1Bindings = await bindingManager.listAll();
    const b1 = ws1Bindings.find((b) => b.workspaceFolder === 'ws1');
    assert.deepStrictEqual(b1?.infobaseIds, [testServerEntry.id], 'ws1 bindings must be restored');

    // Catalog and secret remain untouched
    assert.ok(await storage.getById(testServerEntry.id));
    assert.strictEqual(await secrets.get(infobasePasswordSecretKey(testServerEntry.id)), 'my-pass');
  });

  test('removeInfobase rolls back bindings when catalog removal fails in globalState', async () => {
    await mutationService.saveInfobase({
      entry: testServerEntry,
      passwordChange: { kind: 'set', password: 'my-pass' },
    });

    const bindingsWs1Uri = vscode.Uri.file(`C:\\workspace\\ws1\\.vscode\\${INFOBASE_BINDINGS_FILE_NAME}`);
    mockFs.files.set(bindingsWs1Uri.toString(), encodeBindings([
      { workspaceFolder: 'ws1', configRelativePath: 'src/cf', infobaseIds: [testServerEntry.id], massDeployment: false },
    ]));

    // Fail globalState update on catalog
    memento.failOnKey = INFOBASE_GLOBAL_STATE_KEY;
    memento.failOnUpdate = true;

    const outcome = await mutationService.removeInfobase({ infobaseId: testServerEntry.id });

    assert.strictEqual(outcome.success, false);
    if (outcome.success) return;
    assert.strictEqual(outcome.code, 'GLOBAL_STATE_FAILED');
    assert.strictEqual(outcome.rolledBack, true);

    // Bindings restored
    const b1 = (await bindingManager.listAll()).find((b) => b.workspaceFolder === 'ws1');
    assert.deepStrictEqual(b1?.infobaseIds, [testServerEntry.id]);

    // Secret intact
    assert.strictEqual(await secrets.get(infobasePasswordSecretKey(testServerEntry.id)), 'my-pass');
  });

  // ─── 5. Crash Recovery & Idempotence ─────────────────────────────────────────

  test('recoverPendingMutations cleans up orphan secret if crash occurred after store before catalog update', async () => {
    const orphanId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    // Simulate crash state:
    // 1. Secret was stored
    await secrets.store(infobasePasswordSecretKey(orphanId), 'leftover-password');
    // 2. Journal record was left behind
    await memento.update(INFOBASE_MUTATION_JOURNAL_KEY, {
      operationId: 'op-123',
      type: 'save',
      infobaseId: orphanId,
      timestamp: Date.now(),
      hadPasswordBefore: false,
    });
    // 3. But catalog does not have the entry!

    const recoveryOutcome = await mutationService.recoverPendingMutations();
    assert.strictEqual(recoveryOutcome.recoveredCount, 1);

    // Secret must be deleted
    assert.strictEqual(await secrets.get(infobasePasswordSecretKey(orphanId)), undefined);
    // Journal cleared
    assert.strictEqual(memento.get(INFOBASE_MUTATION_JOURNAL_KEY), undefined);
  });

  test('recoverPendingMutations is idempotent when no pending mutations exist', async () => {
    const recoveryOutcome = await mutationService.recoverPendingMutations();
    assert.strictEqual(recoveryOutcome.recoveredCount, 0);
  });

  test('recoverPendingMutations recovers save(clear) by updating catalog entry to hasStoredPassword: false when secret was deleted', async () => {
    // 1. Save entry with password
    await mutationService.saveInfobase({
      entry: testServerEntry,
      passwordChange: { kind: 'set', password: 'my-pass' },
    });

    // 2. Simulate crash after secret deletion: secret is gone, journal recorded secrets_mutated with clear intent
    await secrets.delete(infobasePasswordSecretKey(testServerEntry.id));
    await memento.update(INFOBASE_MUTATION_JOURNAL_KEY, {
      operationId: 'op-save-clear',
      type: 'save',
      phase: 'secrets_mutated',
      infobaseId: testServerEntry.id,
      timestamp: Date.now(),
      hadPasswordBefore: true,
      passwordChangeKind: 'clear',
      targetEntry: { ...testServerEntry, hasStoredPassword: false },
    });

    const recoveryOutcome = await mutationService.recoverPendingMutations();
    assert.strictEqual(recoveryOutcome.recoveredCount, 1);
    assert.deepStrictEqual(recoveryOutcome.errors, []);

    // Catalog entry must now reflect hasStoredPassword: false
    const entryAfter = await storage.getById(testServerEntry.id);
    assert.strictEqual(entryAfter?.hasStoredPassword, false);
    // Secret remains deleted
    assert.strictEqual(await secrets.get(infobasePasswordSecretKey(testServerEntry.id)), undefined);
    // Journal cleared
    assert.strictEqual(memento.get(INFOBASE_MUTATION_JOURNAL_KEY), undefined);
  });

  test('recoverPendingMutations completes removal when crash occurred in bindings_mutated phase', async () => {
    await mutationService.saveInfobase({
      entry: testServerEntry,
      passwordChange: { kind: 'set', password: 'my-pass' },
    });

    // Simulate crash after mutating bindings:
    await memento.update(INFOBASE_MUTATION_JOURNAL_KEY, {
      operationId: 'op-remove-crash',
      type: 'remove',
      phase: 'bindings_mutated',
      infobaseId: testServerEntry.id,
      timestamp: Date.now(),
      hadPasswordBefore: true,
    });

    const recoveryOutcome = await mutationService.recoverPendingMutations();
    assert.strictEqual(recoveryOutcome.recoveredCount, 1);
    assert.deepStrictEqual(recoveryOutcome.errors, []);

    // Entry must be deleted from catalog
    assert.strictEqual(await storage.getById(testServerEntry.id), undefined);
    // Secret deleted
    assert.strictEqual(await secrets.get(infobasePasswordSecretKey(testServerEntry.id)), undefined);
    // Journal cleared
    assert.strictEqual(memento.get(INFOBASE_MUTATION_JOURNAL_KEY), undefined);
  });

  test('recoverPendingMutations does not wipe journal when recovery fails', async () => {
    // 1. Initial entry in storage
    await storage.upsert(testServerEntry);

    // 2. Simulate crash journal record
    const journalRecord = {
      operationId: 'op-unrecoverable',
      type: 'save',
      phase: 'secrets_mutated',
      infobaseId: testServerEntry.id,
      timestamp: Date.now(),
      hadPasswordBefore: true,
      passwordChangeKind: 'clear',
      targetEntry: { ...testServerEntry, hasStoredPassword: false },
    };
    await memento.update(INFOBASE_MUTATION_JOURNAL_KEY, journalRecord);

    // Make globalState update fail during recovery
    memento.failOnKey = INFOBASE_GLOBAL_STATE_KEY;
    memento.failOnUpdate = true;

    const recoveryOutcome = await mutationService.recoverPendingMutations();
    assert.strictEqual(recoveryOutcome.recoveredCount, 0);
    assert.strictEqual(recoveryOutcome.errors.length, 1);

    // Journal must NOT be wiped!
    memento.failOnUpdate = false;
    assert.deepStrictEqual(memento.get(INFOBASE_MUTATION_JOURNAL_KEY), journalRecord);
  });

  test('recoverPendingMutations recovers save(clear) when crash occurred in phase=intent (between secret delete and journal update)', async () => {
    // 1. Initial state: entry has password in storage and secretStorage
    await mutationService.saveInfobase({
      entry: testServerEntry,
      passwordChange: { kind: 'set', password: 'my-pass' },
    });

    // 2. Simulate crash immediately after secretStorage.delete, before recordJournal(secrets_mutated) was written
    // The journal still has phase: 'intent' with passwordChangeKind: 'clear'
    await secrets.delete(infobasePasswordSecretKey(testServerEntry.id));
    await memento.update(INFOBASE_MUTATION_JOURNAL_KEY, {
      operationId: 'op-crash-between-delete-and-journal',
      type: 'save',
      phase: 'intent',
      infobaseId: testServerEntry.id,
      timestamp: Date.now(),
      hadPasswordBefore: true,
      passwordChangeKind: 'clear',
      targetEntry: { ...testServerEntry, hasStoredPassword: false },
    });

    // 3. Recovery must inspect intent and update catalog to hasStoredPassword: false
    const recoveryOutcome = await mutationService.recoverPendingMutations();
    assert.strictEqual(recoveryOutcome.recoveredCount, 1);
    assert.deepStrictEqual(recoveryOutcome.errors, []);

    const entryAfter = await storage.getById(testServerEntry.id);
    assert.strictEqual(entryAfter?.hasStoredPassword, false, 'Catalog entry must be updated to hasStoredPassword: false');
    assert.strictEqual(await secrets.get(infobasePasswordSecretKey(testServerEntry.id)), undefined);
    assert.strictEqual(memento.get(INFOBASE_MUTATION_JOURNAL_KEY), undefined);
  });

  test('recoverPendingMutations cleans up all folders during remove when crash occurred after mutating only first folder', async () => {
    await mutationService.saveInfobase({
      entry: testServerEntry,
      passwordChange: { kind: 'set', password: 'my-pass' },
    });

    // Both ws1 and ws2 have bindings to testServerEntry
    const bindingsWs1Uri = vscode.Uri.file(`C:\\workspace\\ws1\\.vscode\\${INFOBASE_BINDINGS_FILE_NAME}`);
    const bindingsWs2Uri = vscode.Uri.file(`C:\\workspace\\ws2\\.vscode\\${INFOBASE_BINDINGS_FILE_NAME}`);

    // Simulate crash after writing ws1 (ws1 has empty infobaseIds, but ws2 still has testServerEntry.id!)
    mockFs.files.set(bindingsWs1Uri.toString(), encodeBindings([
      { workspaceFolder: 'ws1', configRelativePath: 'src/cf', infobaseIds: [], massDeployment: false },
    ]));
    mockFs.files.set(bindingsWs2Uri.toString(), encodeBindings([
      { workspaceFolder: 'ws2', configRelativePath: 'src/cf', infobaseIds: [testServerEntry.id], massDeployment: false },
    ]));

    await memento.update(INFOBASE_MUTATION_JOURNAL_KEY, {
      operationId: 'op-remove-multi-crash',
      type: 'remove',
      phase: 'bindings_mutated',
      infobaseId: testServerEntry.id,
      timestamp: Date.now(),
      hadPasswordBefore: true,
      targetFolderPaths: [workspaceFolders[0].uri.fsPath, workspaceFolders[1].uri.fsPath],
      modifiedBindings: [
        {
          folderFsPath: workspaceFolders[0].uri.fsPath,
          folderName: 'ws1',
          originalBindings: [{ workspaceFolder: 'ws1', configRelativePath: 'src/cf', infobaseIds: [testServerEntry.id], massDeployment: false }],
        },
      ],
    });

    const recoveryOutcome = await mutationService.recoverPendingMutations();
    assert.strictEqual(recoveryOutcome.recoveredCount, 1);
    assert.deepStrictEqual(recoveryOutcome.errors, []);

    // Both ws1 and ws2 must be cleaned up!
    const allBindings = await bindingManager.listAll();
    const b1 = allBindings.find((b) => b.workspaceFolder === 'ws1');
    const b2 = allBindings.find((b) => b.workspaceFolder === 'ws2');
    assert.deepStrictEqual(b1?.infobaseIds, [], 'ws1 must stay clean');
    assert.deepStrictEqual(b2?.infobaseIds, [], 'ws2 must have target id removed by recovery');

    // Catalog entry deleted, secret deleted, journal cleared
    assert.strictEqual(await storage.getById(testServerEntry.id), undefined);
    assert.strictEqual(await secrets.get(infobasePasswordSecretKey(testServerEntry.id)), undefined);
    assert.strictEqual(memento.get(INFOBASE_MUTATION_JOURNAL_KEY), undefined);
  });

  test('recoverPendingMutations does not delete catalog entry and preserves journal when a folder is inaccessible during remove recovery', async () => {
    await mutationService.saveInfobase({
      entry: testServerEntry,
      passwordChange: { kind: 'set', password: 'my-pass' },
    });

    const bindingsWs1Uri = vscode.Uri.file(`C:\\workspace\\ws1\\.vscode\\${INFOBASE_BINDINGS_FILE_NAME}`);
    const bindingsWs2Uri = vscode.Uri.file(`C:\\workspace\\ws2\\.vscode\\${INFOBASE_BINDINGS_FILE_NAME}`);

    mockFs.files.set(bindingsWs1Uri.toString(), encodeBindings([
      { workspaceFolder: 'ws1', configRelativePath: 'src/cf', infobaseIds: [], massDeployment: false },
    ]));
    mockFs.files.set(bindingsWs2Uri.toString(), encodeBindings([
      { workspaceFolder: 'ws2', configRelativePath: 'src/cf', infobaseIds: [testServerEntry.id], massDeployment: false },
    ]));

    const journalRecord = {
      operationId: 'op-remove-inaccessible-folder',
      type: 'remove',
      phase: 'bindings_mutated' as const,
      infobaseId: testServerEntry.id,
      timestamp: Date.now(),
      hadPasswordBefore: true,
      targetFolderPaths: [workspaceFolders[0].uri.fsPath, workspaceFolders[1].uri.fsPath],
    };
    await memento.update(INFOBASE_MUTATION_JOURNAL_KEY, journalRecord);

    // Make ws2 fail on write
    mockFs.failOnUri = 'ws2';

    const recoveryOutcome = await mutationService.recoverPendingMutations();
    assert.strictEqual(recoveryOutcome.recoveredCount, 0, 'Must not claim recovery success when a folder fails');
    assert.strictEqual(recoveryOutcome.errors.length, 1);

    // Catalog entry and secret must NOT be removed!
    assert.ok(await storage.getById(testServerEntry.id), 'Entry must remain in catalog');
    // Journal must NOT be wiped!
    assert.deepStrictEqual(memento.get(INFOBASE_MUTATION_JOURNAL_KEY), journalRecord, 'Journal must be preserved');

    // When folder becomes accessible again, recovery succeeds on retry:
    mockFs.failOnUri = null;
    const retryOutcome = await mutationService.recoverPendingMutations();
    assert.strictEqual(retryOutcome.recoveredCount, 1, 'Retry must succeed');
    assert.strictEqual(await storage.getById(testServerEntry.id), undefined);
    assert.strictEqual(memento.get(INFOBASE_MUTATION_JOURNAL_KEY), undefined);
  });

  // ─── 6. Journal Write Failure Resilience ──────────────────────────────────────

  test('saveInfobase aborts and preserves state when journal intent write fails', async () => {
    memento.failOnPredicate = (key, val) =>
      key === INFOBASE_MUTATION_JOURNAL_KEY && (val as any)?.phase === 'intent';

    const outcome = await mutationService.saveInfobase({
      entry: testServerEntry,
      passwordChange: { kind: 'set', password: 'secret-pass' },
    });

    assert.strictEqual(outcome.success, false);
    if (outcome.success) return;
    assert.strictEqual(outcome.code, 'GLOBAL_STATE_FAILED');
    assert.strictEqual(outcome.rolledBack, true);

    // No secret or catalog entry should have been written
    assert.strictEqual(await secrets.get(infobasePasswordSecretKey(testServerEntry.id)), undefined);
    assert.strictEqual(await storage.getById(testServerEntry.id), undefined);
  });

  test('saveInfobase rolls back stored secret when journal secrets_mutated write fails', async () => {
    // Save existing entry first
    await mutationService.saveInfobase({
      entry: testServerEntry,
      passwordChange: { kind: 'set', password: 'old-pass' },
    });

    // Make journal write fail on secrets_mutated phase
    memento.failOnPredicate = (key, val) =>
      key === INFOBASE_MUTATION_JOURNAL_KEY && (val as any)?.phase === 'secrets_mutated';

    const outcome = await mutationService.saveInfobase({
      entry: { ...testServerEntry, name: 'Renamed Entry' },
      passwordChange: { kind: 'set', password: 'new-pass' },
    });

    assert.strictEqual(outcome.success, false);
    if (outcome.success) return;
    assert.strictEqual(outcome.code, 'GLOBAL_STATE_FAILED');
    assert.strictEqual(outcome.rolledBack, true);

    // Secret must have been rolled back to old-pass!
    assert.strictEqual(await secrets.get(infobasePasswordSecretKey(testServerEntry.id)), 'old-pass');
    // Catalog unchanged
    const current = await storage.getById(testServerEntry.id);
    assert.strictEqual(current?.name, testServerEntry.name);
  });

  test('removeInfobase aborts and preserves state when journal intent write fails', async () => {
    await mutationService.saveInfobase({
      entry: testServerEntry,
      passwordChange: { kind: 'set', password: 'my-pass' },
    });

    memento.failOnPredicate = (key, val) =>
      key === INFOBASE_MUTATION_JOURNAL_KEY && (val as any)?.phase === 'intent';

    const outcome = await mutationService.removeInfobase({ infobaseId: testServerEntry.id });
    assert.strictEqual(outcome.success, false);
    if (outcome.success) return;
    assert.strictEqual(outcome.code, 'GLOBAL_STATE_FAILED');
    assert.strictEqual(outcome.rolledBack, true);

    // Entry and secret still exist
    assert.ok(await storage.getById(testServerEntry.id));
    assert.strictEqual(await secrets.get(infobasePasswordSecretKey(testServerEntry.id)), 'my-pass');
  });

  test('removeInfobase rolls back modified bindings when journal bindings_mutated write fails', async () => {
    await mutationService.saveInfobase({
      entry: testServerEntry,
      passwordChange: { kind: 'set', password: 'my-pass' },
    });

    const bindingsWs1Uri = vscode.Uri.file(`C:\\workspace\\ws1\\.vscode\\${INFOBASE_BINDINGS_FILE_NAME}`);
    mockFs.files.set(bindingsWs1Uri.toString(), encodeBindings([
      { workspaceFolder: 'ws1', configRelativePath: 'src/cf', infobaseIds: [testServerEntry.id], massDeployment: false },
    ]));

    // Fail journal write when recording bindings_mutated
    memento.failOnPredicate = (key, val) =>
      key === INFOBASE_MUTATION_JOURNAL_KEY && (val as any)?.phase === 'bindings_mutated';

    const outcome = await mutationService.removeInfobase({ infobaseId: testServerEntry.id });
    assert.strictEqual(outcome.success, false);
    if (outcome.success) return;
    assert.strictEqual(outcome.code, 'GLOBAL_STATE_FAILED');
    assert.strictEqual(outcome.rolledBack, true);

    // Bindings must be restored!
    const b1 = (await bindingManager.listAll()).find((b) => b.workspaceFolder === 'ws1');
    assert.deepStrictEqual(b1?.infobaseIds, [testServerEntry.id]);

    // Entry and secret still intact
    assert.ok(await storage.getById(testServerEntry.id));
    assert.strictEqual(await secrets.get(infobasePasswordSecretKey(testServerEntry.id)), 'my-pass');
  });

  // ─── 7. Review Round 2 Edge Cases: First Password & Workspace Change ─────────

  test('recoverPendingMutations recovers save(set) for first password on existing entry when crash occurred in phase=intent (after secret store)', async () => {
    // 1. Existing entry without password
    await storage.upsert(testFileEntry);

    // 2. Simulate crash: secret was stored, but journal is still in phase: 'intent'
    await secrets.store(infobasePasswordSecretKey(testFileEntry.id), 'first-stored-password');
    const targetEntry: InfobaseEntry = { ...testFileEntry, hasStoredPassword: true };

    await memento.update(INFOBASE_MUTATION_JOURNAL_KEY, {
      operationId: 'op-first-pass-crash',
      type: 'save',
      phase: 'intent',
      infobaseId: testFileEntry.id,
      timestamp: Date.now(),
      hadPasswordBefore: false,
      passwordChangeKind: 'set',
      targetEntry,
    });

    const recoveryOutcome = await mutationService.recoverPendingMutations();
    assert.strictEqual(recoveryOutcome.recoveredCount, 1);
    assert.deepStrictEqual(recoveryOutcome.errors, []);

    // Catalog must now have hasStoredPassword: true!
    const updated = await storage.getById(testFileEntry.id);
    assert.ok(updated);
    assert.strictEqual(updated.hasStoredPassword, true, 'Catalog must be brought into consistency with stored secret');

    // Secret must be preserved
    assert.strictEqual(
      await secrets.get(infobasePasswordSecretKey(testFileEntry.id)),
      'first-stored-password',
    );
    // Journal cleared
    assert.strictEqual(memento.get(INFOBASE_MUTATION_JOURNAL_KEY), undefined);
  });

  test('recoverPendingMutations recovers save(set) for brand new entry when crash occurred after secret store', async () => {
    const brandNewId = '11223344-5566-4777-8888-9900aabbccdd';
    const brandNewEntry: InfobaseEntry = {
      id: brandNewId,
      name: 'Brand New Infobase',
      type: 'server',
      server: 'srv1',
      database: 'db1',
      hasStoredPassword: true,
      createdAt: new Date().toISOString(),
    };

    // Secret was stored
    await secrets.store(infobasePasswordSecretKey(brandNewId), 'brand-new-pass');

    // Journal has intent or secrets_mutated with targetEntry
    await memento.update(INFOBASE_MUTATION_JOURNAL_KEY, {
      operationId: 'op-new-entry-crash',
      type: 'save',
      phase: 'secrets_mutated',
      infobaseId: brandNewId,
      timestamp: Date.now(),
      hadPasswordBefore: false,
      passwordChangeKind: 'set',
      targetEntry: brandNewEntry,
    });

    const recoveryOutcome = await mutationService.recoverPendingMutations();
    assert.strictEqual(recoveryOutcome.recoveredCount, 1);
    assert.deepStrictEqual(recoveryOutcome.errors, []);

    // Brand new entry must be saved in catalog!
    const saved = await storage.getById(brandNewId);
    assert.ok(saved, 'Brand new entry must be recovered in catalog');
    assert.strictEqual(saved.name, 'Brand New Infobase');
    assert.strictEqual(saved.hasStoredPassword, true);

    // Secret preserved
    assert.strictEqual(await secrets.get(infobasePasswordSecretKey(brandNewId)), 'brand-new-pass');
    // Journal cleared
    assert.strictEqual(memento.get(INFOBASE_MUTATION_JOURNAL_KEY), undefined);
  });

  test('recoverPendingMutations cleans up bindings and completes removal when workspace folders changed since crash', async () => {
    await mutationService.saveInfobase({
      entry: testServerEntry,
      passwordChange: { kind: 'set', password: 'my-pass' },
    });

    const bindingsWs1Uri = vscode.Uri.file(`C:\\workspace\\ws1\\.vscode\\${INFOBASE_BINDINGS_FILE_NAME}`);
    const bindingsWs2Uri = vscode.Uri.file(`C:\\workspace\\ws2\\.vscode\\${INFOBASE_BINDINGS_FILE_NAME}`);

    mockFs.files.set(bindingsWs1Uri.toString(), encodeBindings([
      { workspaceFolder: 'ws1', configRelativePath: 'src/cf', infobaseIds: [testServerEntry.id], massDeployment: false },
    ]));
    mockFs.files.set(bindingsWs2Uri.toString(), encodeBindings([
      { workspaceFolder: 'ws2', configRelativePath: 'src/cf', infobaseIds: [testServerEntry.id], massDeployment: false },
    ]));

    // Journal recorded both folders during remove
    await memento.update(INFOBASE_MUTATION_JOURNAL_KEY, {
      operationId: 'op-remove-ws-changed',
      type: 'remove',
      phase: 'bindings_mutated',
      infobaseId: testServerEntry.id,
      timestamp: Date.now(),
      hadPasswordBefore: true,
      targetFolderPaths: ['C:\\workspace\\ws1', 'C:\\workspace\\ws2'],
    });

    // Now simulate workspace change: neither ws1 nor ws2 is in current workspace!
    workspaceFolders = [makeFolder('ws3', 'C:\\workspace\\ws3')];

    const recoveryOutcome = await mutationService.recoverPendingMutations();
    assert.strictEqual(recoveryOutcome.recoveredCount, 1);
    assert.deepStrictEqual(recoveryOutcome.errors, []);

    // Both ws1 and ws2 must have been cleaned up via targetFolderPaths!
    const ws1Bindings = decodeBindings(mockFs.files.get(bindingsWs1Uri.toString())!);
    const ws2Bindings = decodeBindings(mockFs.files.get(bindingsWs2Uri.toString())!);
    assert.deepStrictEqual(ws1Bindings[0].infobaseIds, [], 'ws1 bindings must be cleaned up');
    assert.deepStrictEqual(ws2Bindings[0].infobaseIds, [], 'ws2 bindings must be cleaned up');

    // Catalog entry deleted, secret deleted, journal cleared
    assert.strictEqual(await storage.getById(testServerEntry.id), undefined);
    assert.strictEqual(await secrets.get(infobasePasswordSecretKey(testServerEntry.id)), undefined);
    assert.strictEqual(memento.get(INFOBASE_MUTATION_JOURNAL_KEY), undefined);
  });

  test('recoverPendingMutations fails closed when an off-workspace target folder bindings file is corrupted', async () => {
    await mutationService.saveInfobase({
      entry: testServerEntry,
      passwordChange: { kind: 'set', password: 'my-pass' },
    });

    const bindingsWs1Uri = vscode.Uri.file(`C:\\workspace\\ws1\\.vscode\\${INFOBASE_BINDINGS_FILE_NAME}`);
    const bindingsWs2Uri = vscode.Uri.file(`C:\\workspace\\ws2\\.vscode\\${INFOBASE_BINDINGS_FILE_NAME}`);

    mockFs.files.set(bindingsWs1Uri.toString(), encodeBindings([
      { workspaceFolder: 'ws1', configRelativePath: 'src/cf', infobaseIds: [testServerEntry.id], massDeployment: false },
    ]));
    // Corrupt ws2 bindings
    mockFs.files.set(bindingsWs2Uri.toString(), Buffer.from('NOT JSON', 'utf-8'));

    const journalRecord = {
      operationId: 'op-remove-corrupt-off-ws',
      type: 'remove' as const,
      phase: 'bindings_mutated' as const,
      infobaseId: testServerEntry.id,
      timestamp: Date.now(),
      hadPasswordBefore: true,
      targetFolderPaths: ['C:\\workspace\\ws1', 'C:\\workspace\\ws2'],
    };
    await memento.update(INFOBASE_MUTATION_JOURNAL_KEY, journalRecord);

    // Workspace switched to ws3
    workspaceFolders = [makeFolder('ws3', 'C:\\workspace\\ws3')];

    const recoveryOutcome = await mutationService.recoverPendingMutations();
    assert.strictEqual(recoveryOutcome.recoveredCount, 0, 'Must not claim recovery success when an off-workspace folder is corrupted');
    assert.strictEqual(recoveryOutcome.errors.length, 1);

    // Catalog entry and secret preserved
    assert.ok(await storage.getById(testServerEntry.id));
    assert.strictEqual(await secrets.get(infobasePasswordSecretKey(testServerEntry.id)), 'my-pass');
    // Journal preserved
    assert.deepStrictEqual(memento.get(INFOBASE_MUTATION_JOURNAL_KEY), journalRecord);
  });
});
