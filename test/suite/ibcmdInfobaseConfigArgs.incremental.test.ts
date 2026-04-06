import * as assert from 'assert';
import {
  buildInfobaseConfigExportStatusArgs,
  buildInfobaseConfigImportFilesArgs,
  type IbcmdOfflineConnection,
} from '../../src/services/ibcmd/ibcmdInfobaseConfigArgs';

const DB_PATH = 'C:/test/db';
const DATA_DIR = 'C:/test/data';
const FILE_CONN: IbcmdOfflineConnection = {
  kind: 'fileDb',
  dbCatalogPath: DB_PATH,
  offlineDataDir: DATA_DIR,
};

suite('ibcmdInfobaseConfigArgs — incremental commands', () => {
  // 1 ─────────────────────────────────────────────────────────────────────────
  test('buildInfobaseConfigImportFilesArgs: arg order — command, connection, files, --base-dir', () => {
    const files = ['CommonModules/тестМодуль.xml', 'CommonModules/тестМодуль/Ext/Module.bsl'];
    const baseDir = 'C:/project/config';

    const args = buildInfobaseConfigImportFilesArgs(FILE_CONN, files, baseDir);

    // Starts with the subcommand sequence
    assert.strictEqual(args[0], 'infobase');
    assert.strictEqual(args[1], 'config');
    assert.strictEqual(args[2], 'import');
    assert.strictEqual(args[3], 'files');

    // Connection args are present
    assert.ok(args.some((a) => a.startsWith('--db-path=')));
    assert.ok(args.some((a) => a.startsWith('--data=')));

    // File paths are included as positional args
    for (const f of files) {
      assert.ok(args.includes(f), `Expected file arg "${f}" in args`);
    }

    // --base-dir is the last arg
    const lastArg = args[args.length - 1];
    assert.ok(lastArg.startsWith('--base-dir='), `Last arg should be --base-dir=, got: ${lastArg}`);
  });

  // 2 ─────────────────────────────────────────────────────────────────────────
  test('buildInfobaseConfigImportFilesArgs: noCheck: true → --no-check present', () => {
    const args = buildInfobaseConfigImportFilesArgs(FILE_CONN, [], 'C:/cfg', {
      noCheck: true,
    });
    assert.ok(args.includes('--no-check'), `Expected --no-check. Got: ${JSON.stringify(args)}`);
  });

  // 3 ─────────────────────────────────────────────────────────────────────────
  test('buildInfobaseConfigImportFilesArgs: noCheck omitted → --no-check absent', () => {
    const args = buildInfobaseConfigImportFilesArgs(FILE_CONN, [], 'C:/cfg');
    assert.ok(!args.includes('--no-check'), `--no-check should not appear without noCheck option`);
  });

  // 4 ─────────────────────────────────────────────────────────────────────────
  test('buildInfobaseConfigImportFilesArgs: extension option → --extension= present', () => {
    const args = buildInfobaseConfigImportFilesArgs(FILE_CONN, [], 'C:/cfg', {
      extension: 'MyExt',
    });
    assert.ok(
      args.some((a) => a === '--extension=MyExt'),
      `Expected --extension=MyExt. Got: ${JSON.stringify(args)}`,
    );
  });

  // 5 ─────────────────────────────────────────────────────────────────────────
  test('buildInfobaseConfigExportStatusArgs: command sequence and --base= present', () => {
    const configDumpInfoPath = 'C:/project/config/ConfigDumpInfo.xml';
    const args = buildInfobaseConfigExportStatusArgs(FILE_CONN, configDumpInfoPath);

    assert.strictEqual(args[0], 'infobase');
    assert.strictEqual(args[1], 'config');
    assert.strictEqual(args[2], 'export');
    assert.strictEqual(args[3], 'status');

    assert.ok(args.some((a) => a.startsWith('--db-path=')));
    assert.ok(args.some((a) => a.startsWith('--data=')));
    assert.ok(
      args.some((a) => a.startsWith('--base=')),
      `Expected --base= arg. Got: ${JSON.stringify(args)}`,
    );
  });

  // 6 ─────────────────────────────────────────────────────────────────────────
  test('buildInfobaseConfigExportStatusArgs: short: true → --short present', () => {
    const args = buildInfobaseConfigExportStatusArgs(
      FILE_CONN,
      'C:/project/config/ConfigDumpInfo.xml',
      { short: true },
    );
    assert.ok(args.includes('--short'), `Expected --short. Got: ${JSON.stringify(args)}`);
  });

  // 7 ─────────────────────────────────────────────────────────────────────────
  test('buildInfobaseConfigExportStatusArgs: short omitted → --short absent', () => {
    const args = buildInfobaseConfigExportStatusArgs(
      FILE_CONN,
      'C:/project/config/ConfigDumpInfo.xml',
    );
    assert.ok(!args.includes('--short'), '--short should not appear when option omitted');
  });
});
