import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';
import { resetIbcmdServiceSingletonForTests } from '../../src/services/ibcmd/ibcmdServiceSingleton';
import { runIbcmdXmlImportPreflight } from '../../src/services/ibcmdXmlPreflightService';
import type { InfobaseStorageService } from '../../src/infobases/infobaseStorageService';

function makeStorage(): InfobaseStorageService {
  return {
    async readPasswordSecret(): Promise<string | undefined> {
      return undefined;
    },
  } as unknown as InfobaseStorageService;
}

suite('ibcmdXmlPreflightService', () => {
  let tempDir: string;

  setup(() => {
    resetVscodeTestState();
    resetIbcmdServiceSingletonForTests();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibcmd-preflight-'));
  });

  teardown(() => {
    resetIbcmdServiceSingletonForTests();
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
      execImpl: async () => ({ stdout: 'ok', stderr: '' }),
    });
    assert.strictEqual(r.ok, true);
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
      execImpl: async () => {
        throw err;
      },
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'IMPORT_FAILED');
    assert.ok(r.message.includes('preflight failed'));
  });
});
