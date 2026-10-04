import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';
import {
  appendIbcmdOutputLine,
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
}

const runnerModule = module.require('../../src/services/ibcmd/IbcmdStreamingRunner') as MutableIbcmdRunnerModule;
const ibcmdServiceModule = module.require('../../src/services/ibcmd/ibcmdServiceSingleton') as MutableIbcmdServiceModule;
const versionSupportModule = module.require('../../src/services/ibcmd/ibcmdVersionSupport') as MutableIbcmdVersionSupportModule;
const originalRunIbcmdStreaming = runnerModule.runIbcmdStreaming;
const originalGetIbcmdService = ibcmdServiceModule.getIbcmdService;
const originalGetYamlUnsupportedMessage = versionSupportModule.getIbcmdYamlInfobaseConfigUnsupportedMessage;

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
    resetVscodeTestState();
  });

  test('passes stored password explicitly to import and post-import apply streaming calls', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-ibcmd-redaction-'));
    const sourceDir = path.join(tempRoot, 'source');
    await fs.mkdir(sourceDir);
    const password = 'ui-stored-ibcmd-secret';
    const options: IbcmdStreamingRunnerOptions[] = [];
    runnerModule.runIbcmdStreaming = async (runOptions) => {
      options.push(runOptions);
      return {
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
});
