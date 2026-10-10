import * as assert from 'assert';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { buildV8iFileContent, infobaseEntryToV8iConnect } from '../../src/infobases/v8iBuilder';
import type { InfobaseEntry, InfobaseFolder } from '../../src/infobases/models/infobaseEntry';
import { InfobaseValidationError } from '../../src/infobases/infobaseValidator';

function entry(overrides: Partial<InfobaseEntry> & Pick<InfobaseEntry, 'id' | 'name' | 'type'>): InfobaseEntry {
  return {
    hasStoredPassword: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

suite('v8iBuilder infobaseEntryToV8iConnect', () => {
  test('file uses normalized path and escapes quotes', () => {
    const raw = entry({
      id: randomUUID(),
      name: 'F',
      type: 'file',
      filePath: 'C:\\Data\\ib "x"',
    });
    const c = infobaseEntryToV8iConnect(raw);
    const norm = path.normalize('C:\\Data\\ib "x"').replace(/"/g, '""');
    assert.ok(c.startsWith('File='));
    assert.ok(c.includes(norm));
    assert.ok(c.endsWith(';'));
  });

  test('file resolves infobase directory from yaml when no filePath (#189)', () => {
    const raw = entry({
      id: randomUUID(),
      name: 'Y',
      type: 'file',
      ibcmdConfigYamlPath: 'D:\\cfg\\ib.yaml',
    });
    const fakeReader = (p: string) => {
      if (p === 'D:\\cfg\\ib.yaml') {
        return 'infobase:\n  file: "D:\\bases\\real_db"\n';
      }
      throw new Error('not found');
    };
    const c = infobaseEntryToV8iConnect(raw, fakeReader);
    const expected = path.normalize('D:\\bases\\real_db').replace(/"/g, '""');
    assert.ok(c.includes(`File="${expected}";`));
    assert.ok(!c.includes('ib.yaml'), 'Must not contain yaml path in Connect string');
  });

  test('file resolves relative path from yaml relative to yaml directory (#189)', () => {
    const raw = entry({
      id: randomUUID(),
      name: 'Rel',
      type: 'file',
      ibcmdConfigYamlPath: path.join('C:', 'bases', 'config', 'ib.yaml'),
    });
    const fakeReader = () => 'infobase:\n  file: ../actual_db\n';
    const c = infobaseEntryToV8iConnect(raw, fakeReader);
    const expected = path.normalize(path.resolve(path.join('C:', 'bases', 'config'), '../actual_db'));
    assert.ok(c.includes(`File="${expected}";`));
  });

  test('file throws InfobaseValidationError when yaml is missing or unreadable (#189)', () => {
    const raw = entry({
      id: randomUUID(),
      name: 'BrokenYaml',
      type: 'file',
      ibcmdConfigYamlPath: 'D:\\missing\\config.yml',
    });
    assert.throws(
      () =>
        infobaseEntryToV8iConnect(raw, () => {
          throw new Error('ENOENT');
        }),
      InfobaseValidationError,
    );
  });

  test('file throws InfobaseValidationError when yaml contains no file scalar (#189)', () => {
    const raw = entry({
      id: randomUUID(),
      name: 'ServerInYaml',
      type: 'file',
      ibcmdConfigYamlPath: 'D:\\cfg\\server.yml',
    });
    assert.throws(
      () => infobaseEntryToV8iConnect(raw, () => 'infobase:\n  server: srv\n  ref: db\n'),
      InfobaseValidationError,
    );
  });

  test('file prefers entry.filePath over yaml when both are present', () => {
    const raw = entry({
      id: randomUUID(),
      name: 'Both',
      type: 'file',
      filePath: 'C:\\direct\\path',
      ibcmdConfigYamlPath: 'D:\\cfg\\ib.yaml',
    });
    const c = infobaseEntryToV8iConnect(raw, () => 'infobase:\n  file: "D:\\ignored"\n');
    assert.ok(c.includes('File="C:\\direct\\path";'));
  });

  test('server builds Srvr/Ref fragment', () => {
    const raw = entry({
      id: randomUUID(),
      name: 'S',
      type: 'server',
      server: 'host',
      database: 'db',
      user: 'u1',
    });
    const c = infobaseEntryToV8iConnect(raw);
    assert.ok(c.toLowerCase().includes('srvr='));
    assert.ok(c.toLowerCase().includes('ref='));
    assert.ok(c.endsWith(';'));
  });

  test('web uses ws= and escapes quotes in URL', () => {
    const raw = entry({
      id: randomUUID(),
      name: 'W',
      type: 'web',
      webUrl: 'https://h/p?q="a"',
    });
    const c = infobaseEntryToV8iConnect(raw);
    assert.ok(c.startsWith('ws='));
    assert.ok(c.includes('""'));
  });
});

suite('v8iBuilder buildV8iFileContent', () => {
  test('builds CRLF sections with ID, OrderInList, App=Auto', () => {
    const id = randomUUID();
    const e = entry({ id, name: 'Demo', type: 'file', filePath: 'C:\\ib' });
    const text = buildV8iFileContent([e], [], { includeOrderInList: true });
    assert.ok(text.includes('\r\n'));
    assert.ok(text.startsWith('; Exported by CDT 41'));
    assert.ok(text.includes(`[Demo]`));
    assert.ok(text.includes(`ID=${id}`));
    assert.ok(text.includes('OrderInList=1'));
    assert.ok(text.includes('App=Auto'));
    assert.ok(text.includes('Connect='));
  });

  test('escapes ] in section name', () => {
    const e = entry({
      id: randomUUID(),
      name: 'A]B',
      type: 'file',
      filePath: '/tmp/x',
    });
    const text = buildV8iFileContent([e], []);
    assert.ok(text.includes('[A]]B]'));
  });

  test('omit OrderInList when includeOrderInList is false', () => {
    const e = entry({ id: randomUUID(), name: 'X', type: 'file', filePath: '/a' });
    const text = buildV8iFileContent([e], [], { includeOrderInList: false });
    assert.ok(!text.includes('OrderInList'));
  });

  test('Folder= path from nested folders and entry.folderId', () => {
    const parentId = randomUUID();
    const childId = randomUUID();
    const folders: InfobaseFolder[] = [
      { id: parentId, name: 'Work' },
      { id: childId, name: 'Clients', parentId },
    ];
    const e = entry({
      id: randomUUID(),
      name: 'Ib',
      type: 'file',
      filePath: '/ib',
      folderId: childId,
    });
    const text = buildV8iFileContent([e], folders);
    assert.ok(text.includes('Folder=/Work/Clients'));
  });

  test('multiple entries increment OrderInList', () => {
    const a = entry({ id: randomUUID(), name: 'A', type: 'file', filePath: '/a' });
    const b = entry({ id: randomUUID(), name: 'B', type: 'file', filePath: '/b' });
    const text = buildV8iFileContent([a, b], []);
    assert.ok(text.includes('OrderInList=1'));
    assert.ok(text.includes('OrderInList=2'));
  });

  test('omits Folder= when folderId points to unknown folder (orphan)', () => {
    const e = entry({
      id: randomUUID(),
      name: 'Orphan',
      type: 'file',
      filePath: '/ib',
      folderId: randomUUID(),
    });
    const text = buildV8iFileContent([e], []);
    assert.ok(!text.includes('Folder='));
  });

  test('breaks folder chain on cycle guard (does not infinite-loop)', () => {
    const a = randomUUID();
    const b = randomUUID();
    const folders: InfobaseFolder[] = [
      { id: a, name: 'A', parentId: b },
      { id: b, name: 'B', parentId: a },
    ];
    const e = entry({ id: randomUUID(), name: 'X', type: 'file', filePath: '/x', folderId: a });
    const text = buildV8iFileContent([e], folders);
    assert.ok(text.includes('Folder='));
  });

  test('buildV8iFileContent resolves yaml-only file base correctly (#189)', () => {
    const e = entry({
      id: randomUUID(),
      name: 'YamlOnly',
      type: 'file',
      ibcmdConfigYamlPath: 'C:\\cfg\\app.yaml',
    });
    const text = buildV8iFileContent([e], [], {
      readYaml: () => 'infobase:\n  file: "C:\\databases\\app_db"\n',
    });
    const expected = path.normalize('C:\\databases\\app_db').replace(/"/g, '""');
    assert.ok(text.includes(`Connect=File="${expected}";`));
    assert.ok(!text.includes('app.yaml'));
  });
});
