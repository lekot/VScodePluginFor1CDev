import * as assert from 'assert';
import {
  buildInfobaseConfigCheckArgs,
  buildInfobaseConfigExportArgs,
  buildInfobaseConfigImportArgs,
} from '../../src/services/ibcmd/ibcmdInfobaseConfigArgs';

suite('ibcmdInfobaseConfigArgs', () => {
  test('buildInfobaseConfigCheckArgs matches ibcmd-api-reference shape', () => {
    const cfg = 'C:\\tmp\\conn.yaml';
    const args = buildInfobaseConfigCheckArgs(cfg);
    assert.deepStrictEqual(args, ['infobase', 'config', 'check', `--config=${cfg}`]);
  });

  test('buildInfobaseConfigCheckArgs adds force and credentials when set', () => {
    const args = buildInfobaseConfigCheckArgs('/x/y.yaml', {
      force: true,
      credentials: { user: 'Admin', password: 'p' },
    });
    assert.deepStrictEqual(args, [
      'infobase',
      'config',
      'check',
      '--config=/x/y.yaml',
      '--user=Admin',
      '--password=p',
      '--force',
    ]);
  });

  test('buildInfobaseConfigImportArgs: config then optional flags then source path', () => {
    const cfg = '/abs/conn.yaml';
    const src = '/project/ERP';
    const args = buildInfobaseConfigImportArgs(cfg, src);
    assert.deepStrictEqual(args, ['infobase', 'config', 'import', `--config=${cfg}`, src]);
  });

  test('buildInfobaseConfigExportArgs: config and out', () => {
    const cfg = 'D:\\a.yaml';
    const out = 'D:\\out\\cfg';
    const args = buildInfobaseConfigExportArgs(cfg, out);
    assert.deepStrictEqual(args, [
      'infobase',
      'config',
      'export',
      `--config=${cfg}`,
      `--out=${out}`,
    ]);
  });

  test('buildInfobaseConfigExportArgs optional extension and format', () => {
    const args = buildInfobaseConfigExportArgs('/c.yaml', '/o', {
      extension: 'Ext1',
      format: 'xml',
    });
    assert.ok(args.includes('--extension=Ext1'));
    assert.ok(args.includes('--format=xml'));
  });

  test('catalog path: no password in argv when credentials omitted (YAML carries secrets)', () => {
    const args = buildInfobaseConfigImportArgs('/cfg.yaml', '/src');
    const joined = args.join(' ');
    assert.ok(!joined.includes('password'));
    assert.ok(!joined.includes('secret'));
  });

  test('buildInfobaseConfigImportArgs: credentials and force before source path', () => {
    const args = buildInfobaseConfigImportArgs('/c.yaml', '/src', {
      credentials: { user: ' U ', password: 'x' },
      force: true,
    });
    const iSrc = args.indexOf('/src');
    assert.ok(args.includes('--user=U'));
    assert.ok(args.includes('--password=x'));
    assert.ok(args.includes('--force'));
    assert.ok(iSrc > args.indexOf('--force'));
  });

  test('buildInfobaseConfigImportArgs: blank user trim → no --user', () => {
    const args = buildInfobaseConfigImportArgs('/c.yaml', '/src', {
      credentials: { user: '   ', password: 'p' },
    });
    assert.ok(!args.some((a) => a.startsWith('--user=')));
    assert.ok(args.includes('--password=p'));
  });

  test('buildInfobaseConfigImportArgs: empty password string → omitted', () => {
    const args = buildInfobaseConfigImportArgs('/c.yaml', '/src', {
      credentials: { user: 'Admin', password: '' },
    });
    assert.ok(args.includes('--user=Admin'));
    assert.ok(!args.some((a) => a.startsWith('--password=')));
  });

  test('buildInfobaseConfigExportArgs: optional credentials', () => {
    const args = buildInfobaseConfigExportArgs('/c.yaml', '/out', {
      credentials: { user: 'U', password: 'pw' },
    });
    assert.ok(args.includes('--user=U'));
    assert.ok(args.includes('--password=pw'));
  });

  test('buildInfobaseConfigExportArgs: blank extension/format trimmed → omitted', () => {
    const args = buildInfobaseConfigExportArgs('/c.yaml', '/o', {
      extension: '  ',
      format: '\t',
    });
    assert.ok(!args.some((a) => a.startsWith('--extension=')));
    assert.ok(!args.some((a) => a.startsWith('--format=')));
  });
});
