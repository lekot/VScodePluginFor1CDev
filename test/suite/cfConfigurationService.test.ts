import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildCfFromXmlConfiguration,
  decomposeCfToXmlDirectory,
  type CfConfigurationServiceDeps,
} from '../../src/services/cfConfigurationService';
import type { IbcmdStreamingRawOutcome } from '../../src/services/ibcmd/IbcmdStreamingRunner';

const TOKEN = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
};

const OK: IbcmdStreamingRawOutcome = {
  exitCode: 0,
  signal: null,
  combinedLog: '',
  logTruncated: false,
  cancelled: false,
  timedOut: false,
};

function makeDeps(tempRoot: string, calls: string[][]): CfConfigurationServiceDeps {
  return {
    resolveExecutablePath: () => ({ kind: 'resolved', path: 'ibcmd' }),
    getTimeoutMs: () => 1000,
    getConsoleOutputEncoding: () => 'auto',
    createTempRoot: async () => tempRoot,
    runStreaming: async (options) => {
      calls.push(options.args);
      return OK;
    },
  };
}

suite('cfConfigurationService', () => {
  test('decomposeCfToXmlDirectory uses direct export --file after creating temp infobase', async () => {
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-cf-service-'));
    const cfPath = path.join(tempRoot, '1Cv8.cf');
    const outDir = path.join(tempRoot, 'out');
    const calls: string[][] = [];

    await fs.promises.writeFile(cfPath, Buffer.from([1]));
    await fs.promises.mkdir(outDir);
    const nativeTempRoot = fs.realpathSync.native(tempRoot);

    const result = await decomposeCfToXmlDirectory({ cfPath, outDir, token: TOKEN }, makeDeps(tempRoot, calls));

    assert.strictEqual(result.status, 'success');
    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(calls[0], [
      'infobase',
      'create',
      `--db-path=${path.join(nativeTempRoot, 'db')}`,
      `--data=${path.join(nativeTempRoot, 'data')}`,
      '--force',
    ]);
    assert.deepStrictEqual(calls[1], [
      'infobase',
      'config',
      'export',
      `--db-path=${path.join(nativeTempRoot, 'db')}`,
      `--data=${path.join(nativeTempRoot, 'data')}`,
      `--file=${path.join(nativeTempRoot, '1Cv8.cf')}`,
      '--force',
      path.join(nativeTempRoot, 'out'),
    ]);
  });

  test('buildCfFromXmlConfiguration uses direct import --out after creating temp infobase', async () => {
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-cf-build-'));
    const configRoot = path.join(tempRoot, 'xml');
    const outFile = path.join(tempRoot, '1Cv8.cf');
    const calls: string[][] = [];

    await fs.promises.mkdir(configRoot);
    await fs.promises.writeFile(path.join(configRoot, 'Configuration.xml'), '<Configuration/>', 'utf-8');
    const nativeTempRoot = fs.realpathSync.native(tempRoot);

    const result = await buildCfFromXmlConfiguration({ configRoot, outFile, token: TOKEN }, makeDeps(tempRoot, calls));

    assert.strictEqual(result.status, 'success');
    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(calls[1], [
      'infobase',
      'config',
      'import',
      `--db-path=${path.join(nativeTempRoot, 'db')}`,
      `--data=${path.join(nativeTempRoot, 'data')}`,
      `--out=${outFile}`,
      path.join(nativeTempRoot, 'xml'),
    ]);
  });
});
