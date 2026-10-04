import '../helpers/vscodeStubRegister';
import * as assert from 'assert';
import * as fs from 'fs/promises';
import { randomUUID } from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { runCompareInfobaseConfigurations } from '../../src/services/configCompareService';
import type { InfobaseEntry } from '../../src/infobases/models/infobaseEntry';
import type { InfobaseStorageService } from '../../src/infobases/infobaseStorageService';
import type { IbcmdService } from '../../src/services/ibcmd/IbcmdService';
import type {
  IbcmdStreamingRawOutcome,
  IbcmdStreamingRunnerOptions,
} from '../../src/services/ibcmd/IbcmdStreamingRunner';
import { resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';

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

function makeEntry(partial: Partial<InfobaseEntry> & Pick<InfobaseEntry, 'id' | 'name' | 'type'>): InfobaseEntry {
  return {
    hasStoredPassword: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

suite('configCompareService runCompareInfobaseConfigurations (Phase 4 #62)', () => {
  teardown(() => {
    runnerModule.runIbcmdStreaming = originalRunIbcmdStreaming;
    ibcmdServiceModule.getIbcmdService = originalGetIbcmdService;
    versionSupportModule.getIbcmdYamlInfobaseConfigUnsupportedMessage = originalGetYamlUnsupportedMessage;
    resetVscodeTestState();
  });

  test('null storage shows error and does not run progress', async () => {
    const a = makeEntry({ id: randomUUID(), name: 'A', type: 'file', filePath: '/a' });
    const b = makeEntry({ id: randomUUID(), name: 'B', type: 'file', filePath: '/b' });
    await runCompareInfobaseConfigurations({ storage: null, entryA: a, entryB: b });
    assert.ok(vscodeTestState.errorLog.some((m) => m.includes('хранилище не инициализировано')));
    assert.strictEqual(vscodeTestState.informationLog.length, 0);
  });

  test('warning when entryA is web', async () => {
    const storage = {} as InfobaseStorageService;
    const web = makeEntry({ id: randomUUID(), name: 'W', type: 'web', webUrl: 'http://x' });
    const file = makeEntry({ id: randomUUID(), name: 'F', type: 'file', filePath: '/a' });
    await runCompareInfobaseConfigurations({ storage, entryA: web, entryB: file });
    assert.ok(vscodeTestState.warningLog.some((m) => m.includes('веб-баз')));
  });

  test('warning when entryB is web', async () => {
    const storage = {} as InfobaseStorageService;
    const file = makeEntry({ id: randomUUID(), name: 'F', type: 'file', filePath: '/a' });
    const web = makeEntry({ id: randomUUID(), name: 'W', type: 'web', webUrl: 'http://x' });
    await runCompareInfobaseConfigurations({ storage, entryA: file, entryB: web });
    assert.ok(vscodeTestState.warningLog.some((m) => m.includes('веб-баз')));
  });

  test('warning when both entries share the same id', async () => {
    const storage = {} as InfobaseStorageService;
    const id = randomUUID();
    const a = makeEntry({ id, name: 'A', type: 'file', filePath: '/a' });
    const b = makeEntry({ id, name: 'B', type: 'file', filePath: '/b' });
    await runCompareInfobaseConfigurations({ storage, entryA: a, entryB: b });
    assert.ok(vscodeTestState.warningLog.some((m) => m.includes('разные')));
  });

  test('passes each stored server password explicitly to its streaming export', async () => {
    const captured: IbcmdStreamingRunnerOptions[] = [];
    const passwordByEntry = new Map([
      ['server-a', 'compare-secret-a'],
      ['server-b', 'compare-secret-b'],
    ]);
    const storage = {
      readPasswordSecret: async (entryId: string) => passwordByEntry.get(entryId),
    } as unknown as InfobaseStorageService;
    const a = makeEntry({
      id: 'server-a',
      name: 'A',
      type: 'server',
      server: 'localhost',
      database: 'db-a',
      user: 'operator',
      hasStoredPassword: true,
    });
    const b = makeEntry({
      id: 'server-b',
      name: 'B',
      type: 'server',
      server: 'localhost',
      database: 'db-b',
      user: 'operator',
      hasStoredPassword: true,
    });
    runnerModule.runIbcmdStreaming = async (options) => {
      captured.push(options);
      const outputDirectory = options.args.at(-1)!;
      await fs.mkdir(outputDirectory, { recursive: true });
      await fs.writeFile(path.join(outputDirectory, 'Configuration.xml'), '<Configuration/>', 'utf8');
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
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = ((callback: (...args: unknown[]) => void, _delay?: number, ...args: unknown[]) =>
      originalSetTimeout(callback, 0, ...args)) as typeof global.setTimeout;

    try {
      await runCompareInfobaseConfigurations({ storage, entryA: a, entryB: b });

      assert.strictEqual(captured.length, 2);
      assert.deepStrictEqual(captured.map((options) => options.redactedValues), [
        ['compare-secret-a'],
        ['compare-secret-b'],
      ]);
    } finally {
      global.setTimeout = originalSetTimeout;
    }
  });
});
