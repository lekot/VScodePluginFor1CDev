import * as assert from 'assert';
import * as path from 'path';
import {
  decodeV8iBuffer,
  detectV8iBufferEncoding,
  formatV8iEntryPreview,
  parseV8iBuffer,
  parseV8iConnectString,
  parseV8iContent,
  v8iParsedEntryToInfobaseDraft,
} from '../../src/infobases/v8iParser';

suite('v8iParser detectV8iBufferEncoding / decodeV8iBuffer', () => {
  test('detects utf16le when BOM FF FE present', () => {
    const buf = Buffer.from([0xff, 0xfe, 0x61, 0x00]);
    assert.strictEqual(detectV8iBufferEncoding(buf), 'utf16le');
  });

  test('detects utf8 without UTF-16 BOM', () => {
    assert.strictEqual(detectV8iBufferEncoding(Buffer.from('a', 'utf8')), 'utf8');
    assert.strictEqual(detectV8iBufferEncoding(Buffer.alloc(0)), 'utf8');
    assert.strictEqual(detectV8iBufferEncoding(Buffer.from([0xfe, 0xff])), 'utf8');
  });

  test('decodeV8iBuffer decodes UTF-16 LE body after BOM', () => {
    const inner = '[S]\r\nConnect=File="C:\\\\ib";';
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(inner, 'utf16le')]);
    const text = decodeV8iBuffer(utf16);
    assert.ok(text.includes('[S]'));
    assert.ok(text.includes('Connect=File='));
  });

  test('decodeV8iBuffer strips UTF-8 BOM from utf8 path', () => {
    const buf = Buffer.from('\ufeff[U]\nConnect=File="D:/x";', 'utf8');
    const text = decodeV8iBuffer(buf);
    assert.ok(text.startsWith('['));
  });
});

suite('v8iParser parseV8iConnectString', () => {
  test('parses file connect with optional Usr', () => {
    const r = parseV8iConnectString('File="D:/apps/ib";');
    assert.ok(!('error' in r));
    assert.strictEqual(r.kind, 'file');
    assert.strictEqual(r.filePath, 'D:/apps/ib');
    const r2 = parseV8iConnectString('File=C:/ib;Usr=Admin;');
    assert.ok(!('error' in r2) && r2.kind === 'file');
    assert.strictEqual(r2.user, 'Admin');
  });

  test('parses server Srvr and Ref via connection string parser', () => {
    const r = parseV8iConnectString('Srvr="cl";Ref="db1";Usr="u";Pwd="p";');
    assert.ok(!('error' in r));
    assert.strictEqual(r.kind, 'server');
    assert.strictEqual(r.server, 'cl');
    assert.strictEqual(r.ref, 'db1');
    assert.strictEqual(r.user, 'u');
    assert.strictEqual(r.password, 'p');
    assert.strictEqual(r.pwdKeyPresent, true);
  });

  test('server with empty Pwd key: pwdKeyPresent true, password undefined', () => {
    const r = parseV8iConnectString('Srvr="s";Ref="r";Pwd="";');
    assert.ok(!('error' in r) && r.kind === 'server');
    assert.strictEqual(r.pwdKeyPresent, true);
    assert.strictEqual(r.password, undefined);
  });

  test('parses ws= as web when http(s)', () => {
    const r = parseV8iConnectString('ws="https://host/app/";');
    assert.ok(!('error' in r));
    assert.strictEqual(r.kind, 'web');
    assert.strictEqual(r.webUrl, 'https://host/app/');
    const h = parseV8iConnectString('ws="http://intranet/base/";');
    assert.ok(!('error' in h) && h.kind === 'web');
    assert.strictEqual(h.webUrl, 'http://intranet/base/');
  });

  test('rejects empty connect', () => {
    const r = parseV8iConnectString('   ');
    assert.ok('error' in r);
    assert.ok(r.error.includes('Пустая'));
  });

  test('rejects unrecognized connect', () => {
    const r = parseV8iConnectString('Unknown=1;');
    assert.ok('error' in r);
  });

  test('rejects non-http ws scheme', () => {
    const r = parseV8iConnectString('ws="ftp://x";');
    assert.ok('error' in r);
    assert.ok(r.error.includes('http'));
  });

  test('rejects invalid ws URL', () => {
    const r = parseV8iConnectString('ws=":::not-a-url";');
    assert.ok('error' in r);
  });

  test('file wins when both File and Srvr present', () => {
    const r = parseV8iConnectString('File="C:/f";Srvr="s";Ref="r";');
    assert.ok(!('error' in r));
    assert.strictEqual(r.kind, 'file');
  });
});

suite('v8iParser parseV8iContent / parseV8iBuffer', () => {
  test('parses multiple sections and skips comments', () => {
    const content = `;comment
#hash
[A]
Connect=File="C:/a";
[B]
Connect=Srvr="s";Ref="r";
`;
    const { entries, errors } = parseV8iContent(content);
    assert.strictEqual(errors.length, 0);
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[0].name, 'A');
    assert.strictEqual(entries[0].parsed.kind, 'file');
    assert.strictEqual(entries[1].name, 'B');
    assert.strictEqual(entries[1].parsed.kind, 'server');
  });

  test('records error when Connect missing', () => {
    const { entries, errors } = parseV8iContent('[X]\nId=1\n');
    assert.strictEqual(entries.length, 0);
    assert.strictEqual(errors.length, 1);
    assert.ok(errors[0].message.includes('Connect'));
  });

  test('records error for invalid Connect in section', () => {
    const { entries, errors } = parseV8iContent('[Bad]\nConnect=;\n');
    assert.strictEqual(entries.length, 0);
    assert.ok(errors.some((e) => e.message.includes('Bad')));
  });

  test('parses Id OrderInList OrderInTree Folder', () => {
    const { entries, errors } = parseV8iContent(`[M]
Connect=File="C:/m";
Id=abc
OrderInList=3
OrderInTree=bad
Folder=F1
`);
    assert.strictEqual(errors.length, 0);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].id, 'abc');
    assert.strictEqual(entries[0].orderInList, 3);
    assert.strictEqual(entries[0].orderInTree, undefined);
    assert.strictEqual(entries[0].folder, 'F1');
  });

  test('empty section name yields error', () => {
    const { errors } = parseV8iContent('[ ]\nConnect=File="C:/x";\n');
    assert.ok(errors.length >= 1);
    assert.strictEqual(errors[0].line, 1);
  });

  test('parseV8iBuffer uses UTF-16 when BOM present', () => {
    const inner = '[U]\nConnect=File="C:/u";';
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(inner, 'utf16le')]);
    const { entries, errors } = parseV8iBuffer(buf);
    assert.strictEqual(errors.length, 0);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].name, 'U');
  });
});

suite('v8iParser formatV8iEntryPreview / v8iParsedEntryToInfobaseDraft', () => {
  test('formatV8iEntryPreview for file server web', () => {
    const f: Parameters<typeof formatV8iEntryPreview>[0] = {
      name: 'n',
      connect: '',
      parsed: { kind: 'file', filePath: 'C:/ib' },
    };
    assert.strictEqual(formatV8iEntryPreview(f), 'C:/ib');
    const s: typeof f = {
      name: 'n',
      connect: '',
      parsed: { kind: 'server', server: 'cl', ref: 'db', pwdKeyPresent: false },
    };
    assert.ok(formatV8iEntryPreview(s).includes('cl'));
    assert.ok(formatV8iEntryPreview(s).includes('db'));
    const w: typeof f = {
      name: 'n',
      connect: '',
      parsed: { kind: 'web', webUrl: 'https://h/' },
    };
    assert.strictEqual(formatV8iEntryPreview(w), 'https://h/');
  });

  test('v8iParsedEntryToInfobaseDraft resolves file path', () => {
    const cwd = process.cwd();
    const rel = 'rel_ib';
    const entry = {
      name: 'F',
      connect: `File="${rel}";`,
      parsed: { kind: 'file' as const, filePath: rel },
    };
    const draft = v8iParsedEntryToInfobaseDraft(entry);
    assert.strictEqual(draft.type, 'file');
    assert.strictEqual(draft.filePath, path.resolve(rel));
    assert.strictEqual(draft.name, 'F');
  });

  test('v8iParsedEntryToInfobaseDraft server password flags', () => {
    const noPwdKey = {
      name: 'S1',
      connect: '',
      parsed: {
        kind: 'server' as const,
        server: 'a',
        ref: 'b',
        pwdKeyPresent: false,
      },
    };
    const d1 = v8iParsedEntryToInfobaseDraft(noPwdKey);
    assert.strictEqual(d1.hasStoredPassword, false);

    const emptyPwd = {
      name: 'S2',
      connect: '',
      parsed: {
        kind: 'server' as const,
        server: 'a',
        ref: 'b',
        pwdKeyPresent: true,
      },
    };
    const d2 = v8iParsedEntryToInfobaseDraft(emptyPwd);
    assert.strictEqual(d2.hasStoredPassword, false);

    const withPwd = {
      name: 'S3',
      connect: '',
      parsed: {
        kind: 'server' as const,
        server: 'a',
        ref: 'b',
        pwdKeyPresent: true,
        password: 'x',
      },
    };
    const d3 = v8iParsedEntryToInfobaseDraft(withPwd);
    assert.strictEqual(d3.hasStoredPassword, true);
  });

  test('v8iParsedEntryToInfobaseDraft web sets launchSettings', () => {
    const entry = {
      name: 'W',
      connect: '',
      parsed: { kind: 'web' as const, webUrl: 'https://w/' },
    };
    const d = v8iParsedEntryToInfobaseDraft(entry);
    assert.strictEqual(d.type, 'web');
    assert.strictEqual(d.webUrl, 'https://w/');
    assert.deepStrictEqual(d.launchSettings, { clientType: 'web' });
  });
});
