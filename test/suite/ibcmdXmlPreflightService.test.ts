import * as assert from 'assert';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { PassThrough } from 'stream';
import { resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';
import { resetIbcmdServiceSingletonForTests } from '../../src/services/ibcmd/ibcmdServiceSingleton';
import { runIbcmdXmlImportPreflight } from '../../src/services/ibcmdXmlPreflightService';
import type { InfobaseStorageService } from '../../src/infobases/infobaseStorageService';
import type { InfobaseEntry } from '../../src/infobases/models/infobaseEntry';
import {
  runInfobaseConfigurationOperation,
} from '../../src/infobases/infobaseConfigurationOperationQueue';
import {
  invalidateIbcmdVersionQueryCache,
} from '../../src/services/ibcmd/ibcmdVersionSupport';
import type {
  IbcmdStreamCancellation,
  IbcmdStreamingRunnerOptions,
} from '../../src/services/ibcmd/IbcmdStreamingRunner';

function makeStorage(): InfobaseStorageService {
  return {
    async readPasswordSecret(): Promise<string | undefined> {
      return undefined;
    },
  } as unknown as InfobaseStorageService;
}

type PreflightLifecycleParams = Parameters<typeof runIbcmdXmlImportPreflight>[0] & {
  token?: IbcmdStreamCancellation;
  spawnImpl?: typeof spawn;
  terminateProcessTreeImpl?: IbcmdStreamingRunnerOptions['terminateProcessTreeImpl'];
};

const runPreflightWithLifecycle = runIbcmdXmlImportPreflight as unknown as (
  params: PreflightLifecycleParams,
) => Promise<Awaited<ReturnType<typeof runIbcmdXmlImportPreflight>> & { effectPossible?: boolean }>;

function fileEntry(id: string, filePath: string): InfobaseEntry {
  return {
    id,
    name: id,
    type: 'file',
    filePath,
    hasStoredPassword: false,
    createdAt: '2020-01-01T00:00:00.000Z',
  };
}

function cancellable(): IbcmdStreamCancellation & { cancel(): void } {
  let requested = false;
  const listeners = new Set<() => void>();
  return {
    get isCancellationRequested() { return requested; },
    onCancellationRequested(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    cancel() {
      if (requested) return;
      requested = true;
      listeners.forEach((listener) => listener());
    },
  };
}

interface LifecycleSpawn {
  readonly spawnImpl: typeof spawn;
  readonly importStarted: Promise<ChildProcess>;
  readonly importCalls: () => number;
}

function lifecycleSpawn(importBehavior: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  stayOpen?: boolean;
} = {}): LifecycleSpawn {
  let resolveImport!: (child: ChildProcess) => void;
  const importStarted = new Promise<ChildProcess>((resolve) => { resolveImport = resolve; });
  let importCalls = 0;
  const spawnImpl = ((_executable: string, args: readonly string[], _options: SpawnOptions): ChildProcess => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = new EventEmitter() as ChildProcess;
    (child as unknown as { stdout: PassThrough }).stdout = stdout;
    (child as unknown as { stderr: PassThrough }).stderr = stderr;
    (child as unknown as { exitCode: number | null }).exitCode = null;
    (child as unknown as { killed: boolean }).killed = false;
    (child as unknown as { kill: (signal?: NodeJS.Signals) => boolean }).kill = () => true;

    setImmediate(() => {
      child.emit('spawn');
      if (args[0] === '--version') {
        stdout.end('8.3.27.1\n');
        child.emit('close', 0, null);
        return;
      }
      if (args[0] === 'infobase' && args[1] === 'config' && args[2] === 'import') {
        importCalls += 1;
        resolveImport(child);
        if (importBehavior.stdout) stdout.write(importBehavior.stdout);
        if (importBehavior.stderr) stderr.write(importBehavior.stderr);
        if (importBehavior.stayOpen !== false) {
          stdout.write('preflight import started');
        } else {
          stdout.end();
          stderr.end();
          child.emit('close', importBehavior.exitCode ?? 0, null);
        }
      }
    });
    return child;
  }) as typeof spawn;

  return { spawnImpl, importStarted, importCalls: () => importCalls };
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs)),
  ]);
}

suite('ibcmdXmlPreflightService', () => {
  let tempDir: string;

  setup(() => {
    resetVscodeTestState();
    resetIbcmdServiceSingletonForTests();
    invalidateIbcmdVersionQueryCache();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibcmd-preflight-'));
  });

  teardown(() => {
    resetIbcmdServiceSingletonForTests();
    invalidateIbcmdVersionQueryCache();
    resetVscodeTestState();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test('returns missing ibcmd when executable path is unresolved', async () => {
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.path'] = path.join(tempDir, 'missing-ibcmd');
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.autoDetect'] = false;
    const srcDir = fs.mkdtempSync(path.join(tempDir, 'src-'));
    const r = await runIbcmdXmlImportPreflight({
      entry: {
        id: 'ib1',
        name: 'IB',
        type: 'file',
        filePath: srcDir,
        hasStoredPassword: false,
        createdAt: '2020-01-01T00:00:00.000Z',
      },
      storage: makeStorage(),
      absoluteSourceDir: srcDir,
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'IBCMD_NOT_FOUND');
  });

  test('returns ok when exec runner succeeds', async () => {
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.path'] = process.execPath;
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.autoDetect'] = false;
    const dbDir = fs.mkdtempSync(path.join(tempDir, 'db-'));
    const srcDir = fs.mkdtempSync(path.join(tempDir, 'src-'));
    const r = await runIbcmdXmlImportPreflight({
      entry: {
        id: 'ib2',
        name: 'IB2',
        type: 'file',
        filePath: dbDir,
        hasStoredPassword: false,
        createdAt: '2020-01-01T00:00:00.000Z',
      },
      storage: makeStorage(),
      absoluteSourceDir: srcDir,
      spawnImpl: lifecycleSpawn({ exitCode: 0, stdout: 'ok', stayOpen: false }).spawnImpl,
    });
    assert.strictEqual(r.ok, true);
  });

  test('successful exit with truncated output is typed inDoubt and cannot validate the import', async () => {
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.path'] = process.execPath;
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.autoDetect'] = false;
    const dbDir = fs.mkdtempSync(path.join(tempDir, 'db-truncated-'));
    const srcDir = fs.mkdtempSync(path.join(tempDir, 'src-truncated-'));
    const r = await runPreflightWithLifecycle({
      entry: fileEntry('truncated-output', dbDir),
      storage: makeStorage(),
      absoluteSourceDir: srcDir,
      spawnImpl: lifecycleSpawn({
        exitCode: 0,
        stdout: 'valid prefix\n'.repeat(350_000),
        stayOpen: false,
      }).spawnImpl,
    });

    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'IN_DOUBT');
    assert.strictEqual(r.effectPossible, true);
    assert.ok(r.message.includes('обрезаны'));
  });

  test('returns failure details when exec runner exits non-zero', async () => {
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.path'] = process.execPath;
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.autoDetect'] = false;
    const dbDir = fs.mkdtempSync(path.join(tempDir, 'db-'));
    const srcDir = fs.mkdtempSync(path.join(tempDir, 'src-'));
    const err = Object.assign(new Error('fail'), {
      code: 2,
      stdout: 'out details',
      stderr: 'err details',
    });
    const r = await runIbcmdXmlImportPreflight({
      entry: {
        id: 'ib3',
        name: 'IB3',
        type: 'file',
        filePath: dbDir,
        hasStoredPassword: false,
        createdAt: '2020-01-01T00:00:00.000Z',
      },
      storage: makeStorage(),
      absoluteSourceDir: srcDir,
      spawnImpl: lifecycleSpawn({ exitCode: 2, stdout: 'out details', stderr: 'err details', stayOpen: false }).spawnImpl,
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'IMPORT_FAILED');
    assert.ok(r.message.includes('preflight failed'));
  });

  test('pre-cancelled preflight returns typed cancelled without preparing or spawning ibcmd', async () => {
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.path'] = process.execPath;
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.autoDetect'] = false;
    const source = fs.mkdtempSync(path.join(tempDir, 'cancel-before-source-'));
    const db = fs.mkdtempSync(path.join(tempDir, 'cancel-before-db-'));
    const token = cancellable();
    token.cancel();
    const processBoundary = lifecycleSpawn();

    const result = await runPreflightWithLifecycle({
      entry: fileEntry('cancel-before', db),
      storage: makeStorage(),
      absoluteSourceDir: source,
      token,
      spawnImpl: processBoundary.spawnImpl,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'CANCELLED');
    assert.strictEqual(processBoundary.importCalls(), 0);
  });

  test('cancellation while queued returns promptly and never starts the queued import', async () => {
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.path'] = process.execPath;
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.autoDetect'] = false;
    const source = fs.mkdtempSync(path.join(tempDir, 'cancel-queued-source-'));
    const db = fs.mkdtempSync(path.join(tempDir, 'cancel-queued-db-'));
    const entry = fileEntry('cancel-queued', db);
    let releaseOwner!: () => void;
    let ownerEntered!: () => void;
    const holdOwner = new Promise<void>((resolve) => { releaseOwner = resolve; });
    const ownerStarted = new Promise<void>((resolve) => { ownerEntered = resolve; });
    const owner = runInfobaseConfigurationOperation(entry, async () => {
      ownerEntered();
      await holdOwner;
    });
    await ownerStarted;

    const token = cancellable();
    const processBoundary = lifecycleSpawn();
    const queued = runPreflightWithLifecycle({
      entry,
      storage: makeStorage(),
      absoluteSourceDir: source,
      token,
      spawnImpl: processBoundary.spawnImpl,
    });
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      token.cancel();
      const result = await within(queued, 250);
      assert.ok(result, 'cancelling a FIFO waiter must not wait for the previous lease');
      assert.strictEqual(result.code, 'CANCELLED');
      assert.strictEqual(processBoundary.importCalls(), 0);
    } finally {
      releaseOwner();
      await owner;
      await queued;
    }
  });

  test('cancellation after import spawn is typed inDoubt even when termination is confirmed', async () => {
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.path'] = process.execPath;
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.autoDetect'] = false;
    const source = fs.mkdtempSync(path.join(tempDir, 'cancel-import-source-'));
    const db = fs.mkdtempSync(path.join(tempDir, 'cancel-import-db-'));
    const token = cancellable();
    const processBoundary = lifecycleSpawn();
    let terminationCalls = 0;

    const resultPromise = runPreflightWithLifecycle({
      entry: fileEntry('cancel-import', db),
      storage: makeStorage(),
      absoluteSourceDir: source,
      token,
      spawnImpl: processBoundary.spawnImpl,
      terminateProcessTreeImpl: async (child) => {
        terminationCalls += 1;
        child.emit('close', 0, 'SIGTERM');
        return { terminated: true, hardKillUsed: false, survivingPids: [], errors: [] };
      },
    });

    try {
      const child = await within(processBoundary.importStarted, 1000);
      assert.ok(child, 'the process boundary should observe the import spawn');
      token.cancel();
      const result = await within(resultPromise, 1000);
      assert.ok(result, 'cancellation should settle within the process termination bound');
      assert.strictEqual(terminationCalls, 1);
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.code, 'IN_DOUBT');
      assert.strictEqual(result.effectPossible, true);
    } finally {
      token.cancel();
      await resultPromise;
    }
  });

  test('failed process-tree termination returns typed inDoubt and preserves possible effect', async () => {
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.path'] = process.execPath;
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.autoDetect'] = false;
    const source = fs.mkdtempSync(path.join(tempDir, 'survivor-source-'));
    const db = fs.mkdtempSync(path.join(tempDir, 'survivor-db-'));
    const token = cancellable();
    const processBoundary = lifecycleSpawn();

    const resultPromise = runPreflightWithLifecycle({
      entry: fileEntry('survivor', db),
      storage: makeStorage(),
      absoluteSourceDir: source,
      token,
      spawnImpl: processBoundary.spawnImpl,
      terminateProcessTreeImpl: async () => ({
        terminated: false,
        hardKillUsed: true,
        survivingPids: [9876],
        errors: ['test termination failure'],
      }),
    });

    try {
      const child = await within(processBoundary.importStarted, 1000);
      assert.ok(child, 'the process boundary should observe the import spawn');
      token.cancel();
      const result = await within(resultPromise, 1000);
      assert.ok(result, 'termination failure should not leave preflight waiting for the configured timeout');
      assert.strictEqual(result.code, 'IN_DOUBT');
      assert.strictEqual(result.effectPossible, true);
      assert.ok(result.message.includes('9876') || result.message.includes('test termination failure'));
    } finally {
      token.cancel();
      await resultPromise;
    }
  });
});
