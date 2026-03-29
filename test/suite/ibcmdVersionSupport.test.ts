import * as assert from 'assert';
import {
  IBCMD_MIN_YAML_INFOBASE_PATCH,
  ibcmdYamlInfobaseTooOldUserMessage,
  invalidateIbcmdVersionQueryCache,
  isIbcmdVersionYamlInfobaseConfigSupported,
  tryParseIbcmdVersionOutput,
  getIbcmdYamlInfobaseConfigUnsupportedMessage,
  type ParsedIbcmdVersion,
} from '../../src/services/ibcmd/ibcmdVersionSupport';

suite('ibcmdVersionSupport', () => {
  teardown(() => {
    invalidateIbcmdVersionQueryCache();
  });

  test('tryParseIbcmdVersionOutput: single line', () => {
    const v = tryParseIbcmdVersionOutput('8.3.27.1000\n');
    assert.ok(v);
    assert.strictEqual(v!.major, 8);
    assert.strictEqual(v!.minor, 3);
    assert.strictEqual(v!.patch, 27);
    assert.strictEqual(v!.build, 1000);
    assert.strictEqual(v!.raw, '8.3.27.1000');
  });

  test('tryParseIbcmdVersionOutput: ignores second line', () => {
    const v = tryParseIbcmdVersionOutput('8.3.23.2157\nextra');
    assert.ok(v);
    assert.strictEqual(v!.patch, 23);
  });

  test('tryParseIbcmdVersionOutput: rejects garbage', () => {
    assert.strictEqual(tryParseIbcmdVersionOutput(''), undefined);
    assert.strictEqual(tryParseIbcmdVersionOutput('8.3'), undefined);
  });

  test(`isIbcmdVersionYamlInfobaseConfigSupported: patch >= ${IBCMD_MIN_YAML_INFOBASE_PATCH}`, () => {
    const ok = (major: number, minor: number, patch: number): ParsedIbcmdVersion => ({
      major,
      minor,
      patch,
      build: 1,
      raw: `${major}.${minor}.${patch}.1`,
    });
    assert.strictEqual(isIbcmdVersionYamlInfobaseConfigSupported(ok(8, 3, 27)), true);
    assert.strictEqual(isIbcmdVersionYamlInfobaseConfigSupported(ok(8, 3, 26)), false);
    assert.strictEqual(isIbcmdVersionYamlInfobaseConfigSupported(ok(8, 4, 0)), true);
    assert.strictEqual(isIbcmdVersionYamlInfobaseConfigSupported(ok(9, 0, 0)), true);
    assert.strictEqual(isIbcmdVersionYamlInfobaseConfigSupported(ok(7, 3, 99)), false);
  });

  test('ibcmdYamlInfobaseTooOldUserMessage mentions standalone-server', () => {
    const m = ibcmdYamlInfobaseTooOldUserMessage('8.3.23.2157');
    assert.ok(m.includes('8.3.23.2157'));
    assert.ok(m.includes('8.3.27'));
    assert.ok(m.includes('standalone-server'));
  });

  test('getIbcmdYamlInfobaseConfigUnsupportedMessage: old version via stub exec', async () => {
    invalidateIbcmdVersionQueryCache();
    const msg = await getIbcmdYamlInfobaseConfigUnsupportedMessage('C:\\ibcmd.exe', async () => ({
      stdout: '8.3.23.2157\n',
      stderr: '',
    }));
    assert.ok(msg);
    assert.ok(msg!.includes('8.3.23.2157'));
  });

  test('getIbcmdYamlInfobaseConfigUnsupportedMessage: new version → undefined', async () => {
    invalidateIbcmdVersionQueryCache();
    const msg = await getIbcmdYamlInfobaseConfigUnsupportedMessage('C:\\ibcmd.exe', async () => ({
      stdout: '8.3.27.1\n',
      stderr: '',
    }));
    assert.strictEqual(msg, undefined);
  });
});
