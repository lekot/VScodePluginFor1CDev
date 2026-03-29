import * as assert from 'assert';
import { buildLaunchArgs, openWebInfobaseInBrowser } from '../../src/services/platformLauncher';
import type { InfobaseEntry } from '../../src/infobases/models/infobaseEntry';
import { resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';

suite('platformLauncher buildLaunchArgs', () => {
  test('file + enterprise', () => {
    const entry: InfobaseEntry = {
      id: '1',
      name: 'F',
      type: 'file',
      filePath: String.raw`C:\Bases\Demo`,
      hasStoredPassword: false,
      createdAt: 'x',
    };
    const args = buildLaunchArgs(entry, 'enterprise', 'win32');
    assert.deepStrictEqual(args, ['ENTERPRISE', '/F', String.raw`C:\Bases\Demo`]);
  });

  test('file + designer', () => {
    const entry: InfobaseEntry = {
      id: '1',
      name: 'F',
      type: 'file',
      filePath: '/tmp/base',
      hasStoredPassword: false,
      createdAt: 'x',
    };
    const args = buildLaunchArgs(entry, 'designer', 'linux');
    assert.strictEqual(args[0], 'DESIGNER');
    assert.strictEqual(args[1], '/F');
    assert.ok(args[2].includes('tmp'));
  });

  test('server + credentials', () => {
    const entry: InfobaseEntry = {
      id: '1',
      name: 'S',
      type: 'server',
      server: 'srv:1541',
      database: 'acc',
      hasStoredPassword: false,
      createdAt: 'x',
    };
    const args = buildLaunchArgs(entry, 'enterprise', 'win32', { user: 'Admin', password: 'p' });
    assert.deepStrictEqual(args, [
      'ENTERPRISE',
      String.raw`/S"srv:1541"`,
      String.raw`/IBName"acc"`,
      String.raw`/N"Admin"`,
      String.raw`/P"p"`,
    ]);
  });

  test('web throws', () => {
    const entry: InfobaseEntry = {
      id: '1',
      name: 'W',
      type: 'web',
      webUrl: 'https://x',
      hasStoredPassword: false,
      createdAt: 'x',
    };
    assert.throws(() => buildLaunchArgs(entry, 'enterprise', 'win32'), /Web infobase/);
  });

  test('file infobase throws when filePath empty', () => {
    const entry: InfobaseEntry = {
      id: '1',
      name: 'F',
      type: 'file',
      filePath: '   ',
      hasStoredPassword: false,
      createdAt: 'x',
    };
    assert.throws(() => buildLaunchArgs(entry, 'enterprise', 'win32'), /filePath is empty/);
  });

  test('server infobase throws when server or database missing', () => {
    const entry: InfobaseEntry = {
      id: '1',
      name: 'S',
      type: 'server',
      server: '',
      database: 'db',
      hasStoredPassword: false,
      createdAt: 'x',
    };
    assert.throws(() => buildLaunchArgs(entry, 'enterprise', 'win32'), /server and database/);
    const entry2: InfobaseEntry = {
      ...entry,
      server: 'srv',
      database: '  ',
    };
    assert.throws(() => buildLaunchArgs(entry2, 'enterprise', 'win32'), /server and database/);
  });

  test('strips double quotes from connection segments', () => {
    const entry: InfobaseEntry = {
      id: '1',
      name: 'F',
      type: 'file',
      filePath: String.raw`C:\Bases\weird"name`,
      hasStoredPassword: false,
      createdAt: 'x',
    };
    const args = buildLaunchArgs(entry, 'enterprise', 'win32');
    assert.strictEqual(args[1], '/F');
    assert.ok(!args[2].includes('"'), args[2]);
  });

  test('user without password omits /P', () => {
    const entry: InfobaseEntry = {
      id: '1',
      name: 'S',
      type: 'server',
      server: 'srv',
      database: 'db',
      hasStoredPassword: false,
      createdAt: 'x',
    };
    const args = buildLaunchArgs(entry, 'enterprise', 'win32', { user: 'U' });
    assert.deepStrictEqual(args, ['ENTERPRISE', String.raw`/S"srv"`, String.raw`/IBName"db"`, String.raw`/N"U"`]);
  });

  test('password not added when empty string', () => {
    const entry: InfobaseEntry = {
      id: '1',
      name: 'S',
      type: 'server',
      server: 'srv',
      database: 'db',
      hasStoredPassword: false,
      createdAt: 'x',
    };
    const args = buildLaunchArgs(entry, 'enterprise', 'win32', { user: 'U', password: '' });
    assert.deepStrictEqual(args, ['ENTERPRISE', String.raw`/S"srv"`, String.raw`/IBName"db"`, String.raw`/N"U"`]);
  });
});

suite('platformLauncher openWebInfobaseInBrowser', () => {
  setup(() => {
    resetVscodeTestState();
  });

  test('empty url returns false and does not call openExternal', async () => {
    const ok = await openWebInfobaseInBrowser('  ');
    assert.strictEqual(ok, false);
    assert.strictEqual(vscodeTestState.openExternalLog.length, 0);
  });

  test('valid url delegates to openExternal', async () => {
    const ok = await openWebInfobaseInBrowser('https://example.test/base');
    assert.strictEqual(ok, true);
    assert.strictEqual(vscodeTestState.openExternalLog.length, 1);
    assert.strictEqual(vscodeTestState.openExternalLog[0], 'https://example.test/base');
  });

  test('openExternal failure propagates', async () => {
    vscodeTestState.openExternalResult = false;
    const ok = await openWebInfobaseInBrowser('https://x');
    assert.strictEqual(ok, false);
  });
});
