import * as assert from 'assert';
import {
  formatServerConnectionString,
  parseServerConnectionString,
} from '../../src/infobases/models/connectionString';

suite('connectionString parseServerConnectionString', () => {
  test('rejects empty and whitespace-only input', () => {
    for (const raw of ['', '   ', '\n\t']) {
      const r = parseServerConnectionString(raw);
      assert.strictEqual(r.ok, false);
      if (!r.ok) {
        assert.ok(r.error.length > 0);
      }
    }
  });

  test('rejects when Srvr or Ref missing or empty', () => {
    const cases = [
      'Srvr="a";',
      'Ref="b";',
      'srvr=;ref=x;',
      'Srvr="x";Ref=;',
      'foo=1;bar=2;',
    ];
    for (const raw of cases) {
      const r = parseServerConnectionString(raw);
      assert.strictEqual(r.ok, false, raw);
      if (!r.ok) {
        assert.ok(r.error.includes('Srvr') || r.error.includes('Ref'), raw);
      }
    }
  });

  test('parses quoted Srvr and Ref', () => {
    const r = parseServerConnectionString('Srvr="host1";Ref="Demo";');
    assert.strictEqual(r.ok, true);
    if (r.ok) {
      assert.strictEqual(r.server, 'host1');
      assert.strictEqual(r.ref, 'Demo');
      assert.strictEqual(r.pwdKeyPresent, false);
      assert.strictEqual(r.password, undefined);
    }
  });

  test('parses unquoted values until semicolon', () => {
    const r = parseServerConnectionString('Srvr=cl;Ref=ib');
    assert.strictEqual(r.ok, true);
    if (r.ok) {
      assert.strictEqual(r.server, 'cl');
      assert.strictEqual(r.ref, 'ib');
    }
  });

  test('keys are case-insensitive', () => {
    const r = parseServerConnectionString('SRVR=h;ref=r;');
    assert.strictEqual(r.ok, true);
    if (r.ok) {
      assert.strictEqual(r.server, 'h');
      assert.strictEqual(r.ref, 'r');
    }
  });

  test('strips UTF-8 BOM and Connect= prefix', () => {
    const r = parseServerConnectionString('\ufeffConnect=Srvr="a";Ref="b";');
    assert.strictEqual(r.ok, true);
    if (r.ok) {
      assert.strictEqual(r.server, 'a');
      assert.strictEqual(r.ref, 'b');
    }
  });

  test('Connect= prefix is case-insensitive and tolerates spaces', () => {
    const r = parseServerConnectionString('CONNECT = Srvr="x";Ref="y"');
    assert.strictEqual(r.ok, true);
    if (r.ok) {
      assert.strictEqual(r.server, 'x');
      assert.strictEqual(r.ref, 'y');
    }
  });

  test('Usr is optional', () => {
    const r = parseServerConnectionString('Srvr="s";Ref="r";Usr="u";');
    assert.strictEqual(r.ok, true);
    if (r.ok) {
      assert.strictEqual(r.user, 'u');
    }
  });

  test('empty Usr value yields undefined user', () => {
    const r = parseServerConnectionString('Srvr="s";Ref="r";Usr="";');
    assert.strictEqual(r.ok, true);
    if (r.ok) {
      assert.strictEqual(r.user, undefined);
    }
  });

  test('Pwd key present with empty quoted value: pwdKeyPresent true, password undefined', () => {
    const r = parseServerConnectionString('Srvr="s";Ref="r";Pwd="";');
    assert.strictEqual(r.ok, true);
    if (r.ok) {
      assert.strictEqual(r.pwdKeyPresent, true);
      assert.strictEqual(r.password, undefined);
    }
  });

  test('Pwd key present with non-empty password', () => {
    const r = parseServerConnectionString('Srvr="s";Ref="r";Pwd="secret";');
    assert.strictEqual(r.ok, true);
    if (r.ok) {
      assert.strictEqual(r.pwdKeyPresent, true);
      assert.strictEqual(r.password, 'secret');
    }
  });

  test('Pwd key is matched case-insensitively', () => {
    const r = parseServerConnectionString('Srvr="s";Ref="r";PWD="x";');
    assert.strictEqual(r.ok, true);
    if (r.ok) {
      assert.strictEqual(r.pwdKeyPresent, true);
      assert.strictEqual(r.password, 'x');
    }
  });

  test('unquoted Pwd value until semicolon', () => {
    const r = parseServerConnectionString('Srvr=s;Ref=r;Pwd=nosemi');
    assert.strictEqual(r.ok, true);
    if (r.ok) {
      assert.strictEqual(r.pwdKeyPresent, true);
      assert.strictEqual(r.password, 'nosemi');
    }
  });

  test('ignores unrelated keys between Srvr and Ref', () => {
    const r = parseServerConnectionString('Srvr="a";Foo=bar;Ref="b";');
    assert.strictEqual(r.ok, true);
    if (r.ok) {
      assert.strictEqual(r.server, 'a');
      assert.strictEqual(r.ref, 'b');
    }
  });

});

suite('connectionString formatServerConnectionString', () => {
  test('builds Srvr and Ref with YAML-style escaping', () => {
    const s = formatServerConnectionString({ server: 'h', ref: 'r' });
    assert.strictEqual(s, 'Srvr="h";Ref="r"');
  });

  test('escapes backslash and double quote in server and ref', () => {
    const s = formatServerConnectionString({ server: 'a\\b"c', ref: 'x"y' });
    assert.strictEqual(s, 'Srvr="a\\\\b\\"c";Ref="x\\"y"');
  });

  test('trims server and ref', () => {
    const s = formatServerConnectionString({ server: '  s  ', ref: '  r  ' });
    assert.strictEqual(s, 'Srvr="s";Ref="r"');
  });

  test('adds Usr when user is non-empty after trim', () => {
    const s = formatServerConnectionString({ server: 's', ref: 'r', user: '  u  ' });
    assert.strictEqual(s, 'Srvr="s";Ref="r";Usr="u"');
  });

  test('omits Usr when user empty or whitespace', () => {
    assert.strictEqual(
      formatServerConnectionString({ server: 's', ref: 'r', user: '' }),
      'Srvr="s";Ref="r"',
    );
    assert.strictEqual(
      formatServerConnectionString({ server: 's', ref: 'r', user: '  ' }),
      'Srvr="s";Ref="r"',
    );
  });

  test('round-trip: format then parse restores server, ref, user', () => {
    const built = formatServerConnectionString({ server: 'cl', ref: 'ib', user: 'adm' });
    const r = parseServerConnectionString(built);
    assert.strictEqual(r.ok, true);
    if (r.ok) {
      assert.strictEqual(r.server, 'cl');
      assert.strictEqual(r.ref, 'ib');
      assert.strictEqual(r.user, 'adm');
      assert.strictEqual(r.pwdKeyPresent, false);
    }
  });
});
