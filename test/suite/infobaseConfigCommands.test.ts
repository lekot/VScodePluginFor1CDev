import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';
import {
  appendIbcmdOutputLine,
  runInfobaseConfigImportFromDirectory,
  runInfobaseConfigIncrementalImport,
  runInfobaseConfigImport,
  serializeInfobaseConfigIbcmdOp,
} from '../../src/infobases/infobaseConfigCommands';
import type { InfobaseEntry } from '../../src/infobases/models/infobaseEntry';
import type { InfobaseStorageService } from '../../src/infobases/infobaseStorageService';
import type {
  IbcmdStreamingRawOutcome,
  IbcmdStreamingRunnerOptions,
} from '../../src/services/ibcmd/IbcmdStreamingRunner';
import type { IbcmdService } from '../../src/services/ibcmd/IbcmdService';

interface MutableIbcmdRunnerModule {
  runIbcmdStreaming(options: IbcmdStreamingRunnerOptions): Promise<IbcmdStreamingRawOutcome>;
}

interface MutableIbcmdServiceModule {
  getIbcmdService(): IbcmdService;
}

interface MutableIbcmdVersionSupportModule {
  getIbcmdYamlInfobaseConfigUnsupportedMessage(executablePath: string): Promise<string | undefined>;
  probeIncrementalSupport(executablePath: string): Promise<{
    importFiles: boolean;
    exportStatus: boolean;
    exportSync: boolean;
    exportObjects: boolean;
  }>;
}

const runnerModule = module.require('../../src/services/ibcmd/IbcmdStreamingRunner') as MutableIbcmdRunnerModule;
const ibcmdServiceModule = module.require('../../src/services/ibcmd/ibcmdServiceSingleton') as MutableIbcmdServiceModule;
const versionSupportModule = module.require('../../src/services/ibcmd/ibcmdVersionSupport') as MutableIbcmdVersionSupportModule;
const originalRunIbcmdStreaming = runnerModule.runIbcmdStreaming;
const originalGetIbcmdService = ibcmdServiceModule.getIbcmdService;
const originalGetYamlUnsupportedMessage = versionSupportModule.getIbcmdYamlInfobaseConfigUnsupportedMessage;
const originalProbeIncrementalSupport = versionSupportModule.probeIncrementalSupport;

function rawOutcome(overrides: Partial<IbcmdStreamingRawOutcome> = {}): IbcmdStreamingRawOutcome {
  return {
    started: false,
    effectPossible: false,
    exitCode: 0,
    signal: null,
    combinedLog: '',
    logTruncated: false,
    cancelled: false,
    timedOut: false,
    ...overrides,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

suite('infobaseConfigCommands appendIbcmdOutputLine', () => {
  teardown(() => {
    resetVscodeTestState();
  });

  test('writes line to stub output channel', () => {
    appendIbcmdOutputLine('[тест] строка');
    assert.ok(vscodeTestState.outputChannelLines.some((l) => l === '[тест] строка'));
  });

  test('appends multiple lines in order', () => {
    appendIbcmdOutputLine('[тест] a');
    appendIbcmdOutputLine('[тест] b');
    assert.deepStrictEqual(
      vscodeTestState.outputChannelLines.filter((l) => l.startsWith('[тест]')),
      ['[тест] a', '[тест] b'],
    );
  });
});

suite('infobaseConfigCommands serializeInfobaseConfigIbcmdOp', () => {
  test('serializes concurrent callers: second runs after first completes', async () => {
    const order: string[] = [];
    const p1 = serializeInfobaseConfigIbcmdOp(async () => {
      order.push('1-start');
      await delay(25);
      order.push('1-end');
    });
    const p2 = serializeInfobaseConfigIbcmdOp(async () => {
      order.push('2');
    });
    await Promise.all([p1, p2]);
    assert.deepStrictEqual(order, ['1-start', '1-end', '2']);
  });

  test('rejected op is swallowed on chain but caller still rejects; next op runs', async () => {
    const order: string[] = [];
    const e1 = await serializeInfobaseConfigIbcmdOp(async () => {
      order.push('a');
      throw new Error('planned');
    }).catch((e) => e as Error);
    assert.ok(e1 instanceof Error);
    assert.strictEqual(e1.message, 'planned');

    await serializeInfobaseConfigIbcmdOp(async () => {
      order.push('b');
    });
    assert.deepStrictEqual(order, ['a', 'b']);
  });

  test('returns resolved value to caller', async () => {
    const v = await serializeInfobaseConfigIbcmdOp(async () => 42);
    assert.strictEqual(v, 42);
  });
});

suite('infobaseConfigCommands explicit ibcmd output redaction', () => {
  teardown(() => {
    runnerModule.runIbcmdStreaming = originalRunIbcmdStreaming;
    ibcmdServiceModule.getIbcmdService = originalGetIbcmdService;
    versionSupportModule.getIbcmdYamlInfobaseConfigUnsupportedMessage = originalGetYamlUnsupportedMessage;
    versionSupportModule.probeIncrementalSupport = originalProbeIncrementalSupport;
    resetVscodeTestState();
  });

  function configureIbcmdMocks(): void {
    ibcmdServiceModule.getIbcmdService = () => ({
      resolveExecutablePathAsync: async () => ({ kind: 'resolved', path: 'ibcmd-test' }),
      getTimeoutMs: () => 30_000,
    } as unknown as IbcmdService);
    versionSupportModule.getIbcmdYamlInfobaseConfigUnsupportedMessage = async () => undefined;
  }

  function testEntry(tempRoot: string): InfobaseEntry {
    return {
      id: 'ib-in-doubt',
      name: 'In doubt test',
      type: 'file',
      filePath: tempRoot,
      hasStoredPassword: false,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
  }

  const testStorage = {
    readPasswordSecret: async () => undefined,
  } as unknown as InfobaseStorageService;

  test('passes stored password explicitly to import and post-import apply streaming calls', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-ibcmd-redaction-'));
    const sourceDir = path.join(tempRoot, 'source');
    await fs.mkdir(sourceDir);
    const password = 'ui-stored-ibcmd-secret';
    const options: IbcmdStreamingRunnerOptions[] = [];
    runnerModule.runIbcmdStreaming = async (runOptions) => {
      options.push(runOptions);
      return {
        started: true,
        effectPossible: true,
        exitCode: 0,
        signal: null,
        combinedLog: '',
        logTruncated: false,
        cancelled: false,
        timedOut: false,
      };
    };
    ibcmdServiceModule.getIbcmdService = () => ({
      resolveExecutablePathAsync: async () => ({ kind: 'resolved', path: 'ibcmd-test' }),
      getTimeoutMs: () => 30_000,
    } as unknown as IbcmdService);
    versionSupportModule.getIbcmdYamlInfobaseConfigUnsupportedMessage = async () => undefined;

    const entry: InfobaseEntry = {
      id: 'ib-redaction-ui',
      name: 'Redaction UI test',
      type: 'file',
      filePath: tempRoot,
      user: 'operator',
      hasStoredPassword: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const storage = {
      readPasswordSecret: async () => password,
    } as unknown as InfobaseStorageService;
    vscodeTestState.quickPickQueue.push({ _kind: 'browse', label: 'Выбрать папку…' });
    vscodeTestState.openDialogQueue.push([{ fsPath: sourceDir, scheme: 'file' }]);

    try {
      await runInfobaseConfigImport(storage, entry);

      assert.strictEqual(options.length, 2);
      assert.ok(options.every((runOptions) => runOptions.redactedValues?.includes(password)));
      assert.ok(options.every((runOptions) => runOptions.args.some((argument) => argument.includes(password))));
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('started import cancellation returns typed inDoubt and never starts apply', async () => {
    configureIbcmdMocks();
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-ibcmd-import-indoubt-'));
    const sourceDir = path.join(tempRoot, 'source');
    await fs.mkdir(sourceDir);
    const termination = {
      terminated: false,
      hardKillUsed: true,
      survivingPids: [7124],
      errors: ['tree stop not confirmed'],
    };
    let calls = 0;
    runnerModule.runIbcmdStreaming = async () => {
      calls += 1;
      return rawOutcome({
        started: true,
        effectPossible: true,
        exitCode: null,
        signal: 'SIGTERM',
        cancelled: true,
        termination,
      });
    };

    try {
      const result = await runInfobaseConfigImportFromDirectory({
        storage: testStorage,
        entry: testEntry(tempRoot),
        absoluteSourceDir: sourceDir,
        token: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) },
      });
      assert.strictEqual(calls, 1, 'apply must not run after an uncertain import');
      assert.strictEqual(result.status as string, 'inDoubt');
      assert.strictEqual((result as unknown as { effectPossible?: boolean }).effectPossible, true);
      assert.deepStrictEqual((result as unknown as { termination?: unknown }).termination, termination);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('cancellation after successful import but before apply reports a partial inDoubt receipt', async () => {
    configureIbcmdMocks();
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-ibcmd-between-steps-'));
    const sourceDir = path.join(tempRoot, 'source');
    await fs.mkdir(sourceDir);
    let cancelled = false;
    let calls = 0;
    runnerModule.runIbcmdStreaming = async () => {
      calls += 1;
      if (calls === 1) {
        cancelled = true;
        return rawOutcome({ started: true, effectPossible: true, exitCode: 0 });
      }
      return rawOutcome({ cancelled: true, exitCode: null });
    };

    try {
      const result = await runInfobaseConfigImportFromDirectory({
        storage: testStorage,
        entry: testEntry(tempRoot),
        absoluteSourceDir: sourceDir,
        token: {
          get isCancellationRequested() { return cancelled; },
          onCancellationRequested: () => ({ dispose: () => undefined }),
        },
      });
      assert.strictEqual(calls, 1, 'the cancellation checkpoint must prevent the apply spawn');
      assert.strictEqual(result.status as string, 'inDoubt');
      assert.strictEqual((result as unknown as { effectPossible?: boolean }).effectPossible, true);
      assert.ok(result.userMessage.toLowerCase().includes('apply'));
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('incremental import cancellation after spawn returns inDoubt without running apply', async () => {
    configureIbcmdMocks();
    versionSupportModule.probeIncrementalSupport = async () => ({
      importFiles: true,
      exportStatus: false,
      exportSync: false,
      exportObjects: false,
    });
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-ibcmd-incremental-indoubt-'));
    const configRoot = path.join(tempRoot, 'config');
    await fs.mkdir(configRoot);
    let calls = 0;
    runnerModule.runIbcmdStreaming = async () => {
      calls += 1;
      return rawOutcome({ started: true, effectPossible: true, cancelled: true, exitCode: null });
    };

    try {
      const result = await runInfobaseConfigIncrementalImport({
        storage: testStorage,
        entry: testEntry(tempRoot),
        configRoot,
        relativeFiles: ['Catalogs/Account.xml'],
        token: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) },
      });
      assert.strictEqual(calls, 1, 'incremental import must not continue into apply');
      assert.strictEqual(result.status as string, 'inDoubt');
      assert.strictEqual((result as unknown as { effectPossible?: boolean }).effectPossible, true);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('UI import-to-apply path warns on post-spawn uncertainty and does not start apply', async () => {
    configureIbcmdMocks();
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-ibcmd-ui-indoubt-'));
    const sourceDir = path.join(tempRoot, 'source');
    await fs.mkdir(sourceDir);
    vscodeTestState.quickPickQueue.push({ _kind: 'browse', label: 'Выбрать папку…' });
    vscodeTestState.openDialogQueue.push([{ fsPath: sourceDir, scheme: 'file' }]);
    vscodeTestState.warningMessageReturnQueue.push('Продолжить');
    let calls = 0;
    runnerModule.runIbcmdStreaming = async () => {
      calls += 1;
      return rawOutcome({ started: true, effectPossible: true, cancelled: true, exitCode: null });
    };

    try {
      await runInfobaseConfigImport(testStorage, testEntry(tempRoot));
      assert.strictEqual(calls, 1, 'the UI command must stop before apply');
      assert.ok(vscodeTestState.warningLog.some((message) => message.toLowerCase().includes('неопредел')));
      assert.ok(!vscodeTestState.errorLog.some((message) => message.toLowerCase().includes('неопредел')));
      assert.ok(!vscodeTestState.informationLog.some((message) => message.includes('Операция завершена')));
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('UI import-to-apply path reports partial uncertainty when cancelled between steps', async () => {
    configureIbcmdMocks();
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-ibcmd-ui-between-steps-'));
    const sourceDir = path.join(tempRoot, 'source');
    await fs.mkdir(sourceDir);
    vscodeTestState.quickPickQueue.push({ _kind: 'browse', label: 'Выбрать папку…' });
    vscodeTestState.openDialogQueue.push([{ fsPath: sourceDir, scheme: 'file' }]);
    vscodeTestState.warningMessageReturnQueue.push('Продолжить');

    const vscodeWindow = (module.require('vscode') as { window: object }).window;
    const originalWithProgress = Reflect.get(vscodeWindow, 'withProgress') as (
      options: unknown,
      task: (...args: unknown[]) => Promise<unknown>,
    ) => Promise<unknown>;
    let cancelProgress: (() => void) | undefined;
    Reflect.set(vscodeWindow, 'withProgress', async (
      _options: unknown,
      task: (...args: unknown[]) => Promise<unknown>,
    ) => {
      let cancelled = false;
      const listeners = new Set<() => void>();
      cancelProgress = () => {
        cancelled = true;
        for (const listener of listeners) {
          listener();
        }
      };
      const token = {
        get isCancellationRequested() { return cancelled; },
        onCancellationRequested(listener: () => void) {
          listeners.add(listener);
          return { dispose: () => listeners.delete(listener) };
        },
      };
      return task({ report: () => undefined }, token);
    });

    let calls = 0;
    runnerModule.runIbcmdStreaming = async () => {
      calls += 1;
      if (calls === 1) {
        cancelProgress?.();
        return rawOutcome({ started: true, effectPossible: true, exitCode: 0 });
      }
      return rawOutcome({ cancelled: true, exitCode: null });
    };

    try {
      await runInfobaseConfigImport(testStorage, testEntry(tempRoot));
      assert.strictEqual(calls, 1, 'the current cancellation token must prevent apply from starting');
      assert.ok(vscodeTestState.warningLog.some((message) => message.toLowerCase().includes('неопредел')));
      assert.ok(!vscodeTestState.informationLog.some((message) => message.includes('Операция завершена')));
    } finally {
      Reflect.set(vscodeWindow, 'withProgress', originalWithProgress);
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
