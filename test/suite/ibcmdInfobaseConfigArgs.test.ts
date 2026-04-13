import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildInfobaseConfigCheckArgs,
  buildInfobaseConfigExportArgs,
  buildInfobaseConfigImportArgs,
  ibcmdOfflineConnectionFromPrepared,
  resolveIbcmdCliPathForWindowsSpawn,
} from '../../src/services/ibcmd/ibcmdInfobaseConfigArgs';

const DATA = path.resolve('/tmp/ibcmd-data');

suite('ibcmdInfobaseConfigArgs', () => {
  test('resolveIbcmdCliPathForWindowsSpawn: non-existent path unchanged', () => {
    const p = path.join(os.tmpdir(), `ibcmd-arg-missing-${Date.now()}.yaml`);
    assert.strictEqual(resolveIbcmdCliPathForWindowsSpawn(p), p);
  });

  test('resolveIbcmdCliPathForWindowsSpawn: existing file returns absolute realpath on win32', function () {
    if (process.platform !== 'win32') {
      this.skip();
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibcmd-long-'));
    const f = path.join(dir, 'x.yaml');
    fs.writeFileSync(f, 'x', 'utf8');
    try {
      const r = resolveIbcmdCliPathForWindowsSpawn(f);
      assert.ok(path.isAbsolute(r));
      assert.ok(fs.existsSync(r));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('ibcmdOfflineConnectionFromPrepared: yaml', () => {
    const c = ibcmdOfflineConnectionFromPrepared({
      ok: true,
      kind: 'yaml',
      absoluteConfigPath: '/a.yaml',
      offlineDataDir: DATA,
      isTemporary: false,
      dispose: async () => {},
    });
    assert.strictEqual(c.kind, 'yaml');
    if (c.kind === 'yaml') {
      assert.strictEqual(c.absoluteConfigPath, '/a.yaml');
    }
  });

  test('buildInfobaseConfigCheckArgs: yaml + data + force', () => {
    const args = buildInfobaseConfigCheckArgs(
      { kind: 'yaml', absoluteConfigPath: '/x/y.yaml', offlineDataDir: DATA },
      { force: true, credentials: { user: 'Admin', password: 'p' } },
    );
    assert.deepStrictEqual(args, [
      'infobase',
      'config',
      'check',
      '--config=/x/y.yaml',
      '--user=Admin',
      '--password=p',
      `--data=${DATA}`,
      '--force',
    ]);
  });

  test('buildInfobaseConfigCheckArgs: fileDb', () => {
    const args = buildInfobaseConfigCheckArgs({
      kind: 'fileDb',
      dbCatalogPath: 'C:\\Bases\\X',
      offlineDataDir: DATA,
    });
    assert.ok(args.includes('--db-path=C:\\Bases\\X'));
    assert.ok(args.includes(`--data=${DATA}`));
  });

  test('buildInfobaseConfigImportArgs: yaml connection', () => {
    const args = buildInfobaseConfigImportArgs(
      { kind: 'yaml', absoluteConfigPath: '/abs/conn.yaml', offlineDataDir: DATA },
      '/project/ERP',
    );
    assert.deepStrictEqual(args, [
      'infobase',
      'config',
      'import',
      '--config=/abs/conn.yaml',
      `--data=${DATA}`,
      '/project/ERP',
    ]);
  });

  test('buildInfobaseConfigImportArgs: fileDb + extension + credentials', () => {
    const args = buildInfobaseConfigImportArgs(
      { kind: 'fileDb', dbCatalogPath: '/ib', offlineDataDir: DATA },
      '/src',
      { extension: 'Ext1', credentials: { user: ' U ', password: 'x' } },
    );
    assert.ok(args.includes('--db-path=/ib'));
    assert.ok(args.includes('--user=U'));
    assert.ok(args.includes('--password=x'));
    assert.ok(args.includes('--extension=Ext1'));
    assert.strictEqual(args[args.length - 1], '/src');
    assert.ok(!args.includes('-F'));
  });

  test('buildInfobaseConfigExportArgs: positional out dir', () => {
    const args = buildInfobaseConfigExportArgs(
      { kind: 'yaml', absoluteConfigPath: 'D:\\a.yaml', offlineDataDir: DATA },
      'D:\\out\\cfg',
    );
    assert.ok(args.includes('--config=D:\\a.yaml'));
    assert.ok(args.includes(`--data=${DATA}`));
    assert.strictEqual(args[args.length - 1], 'D:\\out\\cfg');
    assert.ok(!args.some((a) => a.startsWith('--out=')));
  });

  test('buildInfobaseConfigExportArgs optional extension and format', () => {
    const args = buildInfobaseConfigExportArgs(
      { kind: 'yaml', absoluteConfigPath: '/c.yaml', offlineDataDir: DATA },
      '/o',
      {
        extension: 'Ext1',
        format: 'xml',
      },
    );
    assert.ok(args.includes('--extension=Ext1'));
    assert.ok(args.includes('--format=xml'));
  });

  test('import: paths with spaces in db-path', () => {
    const args = buildInfobaseConfigImportArgs(
      {
        kind: 'fileDb',
        dbCatalogPath: 'C:\\Test IB\\base',
        offlineDataDir: DATA,
      },
      'D:\\My Dump\\ERP',
    );
    assert.ok(args.some((a) => a.startsWith('--db-path=')));
    assert.strictEqual(args[args.length - 1], 'D:\\My Dump\\ERP');
  });
});
