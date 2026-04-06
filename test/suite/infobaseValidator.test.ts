import * as assert from 'assert';
import { randomUUID } from 'crypto';
import {
  InfobaseValidationError,
  assertNoConflictingInfobaseTarget,
  infobaseDuplicateTargetKey,
  normalizeFsPathForCompare,
  validateInfobaseCatalog,
  validateInfobaseEntry,
  validateInfobaseEntryList,
  validateInfobaseFolders,
} from '../../src/infobases/infobaseValidator';
import { INFOBASE_STORAGE_MAX_ENTRIES } from '../../src/infobases/constants';
import type { InfobaseEntry, InfobaseFolder } from '../../src/infobases/models/infobaseEntry';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<InfobaseEntry> = {}): InfobaseEntry {
  const id = overrides.id ?? randomUUID();
  const base: InfobaseEntry = {
    id,
    name: 'TestBase',
    type: 'file',
    filePath: `C:/bases/${id}`,
    hasStoredPassword: false,
    createdAt: new Date().toISOString(),
  };
  return { ...base, ...overrides };
}

function makeFolder(overrides: Partial<InfobaseFolder> = {}): InfobaseFolder {
  return {
    id: randomUUID(),
    name: 'Folder',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// normalizeFsPathForCompare
// ---------------------------------------------------------------------------

suite('normalizeFsPathForCompare', () => {
  test('empty string returns empty', () => {
    assert.strictEqual(normalizeFsPathForCompare(''), '');
  });

  test('whitespace-only returns empty', () => {
    assert.strictEqual(normalizeFsPathForCompare('   '), '');
  });

  test('lowercases drive letter', () => {
    const result = normalizeFsPathForCompare('C:/Foo/Bar');
    assert.ok(result.startsWith('c:'), `expected lowercase drive, got: ${result}`);
  });

  test('unifies backslashes to forward slashes', () => {
    const withBackslash = normalizeFsPathForCompare('C:\\a\\b\\c');
    const withSlash = normalizeFsPathForCompare('C:/a/b/c');
    assert.strictEqual(withBackslash, withSlash);
  });

  test('strips trailing slash', () => {
    const withTrailing = normalizeFsPathForCompare('C:/foo/bar/');
    const withoutTrailing = normalizeFsPathForCompare('C:/foo/bar');
    assert.strictEqual(withTrailing, withoutTrailing);
  });

  test('strips multiple trailing slashes', () => {
    const result = normalizeFsPathForCompare('C:/foo///');
    assert.ok(!result.endsWith('/'));
  });

  test('case-insensitive comparison: same path different case produces same result', () => {
    const a = normalizeFsPathForCompare('C:/Users/Admin/MyBase');
    const b = normalizeFsPathForCompare('c:/users/admin/mybase');
    assert.strictEqual(a, b);
  });

  test('preserves root slash (single char path)', () => {
    const result = normalizeFsPathForCompare('/');
    assert.strictEqual(result, '/');
  });
});

// ---------------------------------------------------------------------------
// infobaseDuplicateTargetKey
// ---------------------------------------------------------------------------

suite('infobaseDuplicateTargetKey', () => {
  test('file with filePath returns file:path: prefix', () => {
    const e = makeEntry({ type: 'file', filePath: 'C:/base', ibcmdConfigYamlPath: undefined });
    const key = infobaseDuplicateTargetKey(e);
    assert.ok(key.startsWith('file:path:'), `got: ${key}`);
  });

  test('file with yaml only (no filePath) returns file:yaml: prefix', () => {
    const e = makeEntry({ type: 'file', filePath: undefined, ibcmdConfigYamlPath: 'C:/conf.yaml' });
    const key = infobaseDuplicateTargetKey(e);
    assert.ok(key.startsWith('file:yaml:'), `got: ${key}`);
  });

  test('file with both filePath and yaml prefers filePath', () => {
    const e = makeEntry({ type: 'file', filePath: 'C:/base', ibcmdConfigYamlPath: 'C:/conf.yaml' });
    const key = infobaseDuplicateTargetKey(e);
    assert.ok(key.startsWith('file:path:'), `got: ${key}`);
  });

  test('file with no filePath and no yaml returns empty string', () => {
    const e = makeEntry({ type: 'file', filePath: undefined, ibcmdConfigYamlPath: undefined });
    assert.strictEqual(infobaseDuplicateTargetKey(e), '');
  });

  test('server returns server: prefix with lowercased server and database', () => {
    const e = makeEntry({ type: 'server', filePath: undefined, server: 'MyServer', database: 'MyDB' });
    const key = infobaseDuplicateTargetKey(e);
    assert.ok(key.startsWith('server:'), `got: ${key}`);
    assert.ok(key.includes('myserver'), `server not lowercased: ${key}`);
    assert.ok(key.includes('mydb'), `database not lowercased: ${key}`);
  });

  test('server key is stable across case variations', () => {
    const a = makeEntry({ type: 'server', filePath: undefined, server: 'SERVER', database: 'DB' });
    const b = makeEntry({ type: 'server', filePath: undefined, server: 'server', database: 'db' });
    assert.strictEqual(infobaseDuplicateTargetKey(a), infobaseDuplicateTargetKey(b));
  });

  test('web returns web: prefix with normalized URL', () => {
    const e = makeEntry({ type: 'web', filePath: undefined, webUrl: 'http://localhost/app' });
    const key = infobaseDuplicateTargetKey(e);
    assert.ok(key.startsWith('web:'), `got: ${key}`);
  });

  test('web host is lowercased in key', () => {
    const a = makeEntry({ type: 'web', filePath: undefined, webUrl: 'http://MyHost/app' });
    const b = makeEntry({ type: 'web', filePath: undefined, webUrl: 'http://myhost/app' });
    assert.strictEqual(infobaseDuplicateTargetKey(a), infobaseDuplicateTargetKey(b));
  });

  test('web trailing slash is stripped from pathname', () => {
    const a = makeEntry({ type: 'web', filePath: undefined, webUrl: 'http://host/app/' });
    const b = makeEntry({ type: 'web', filePath: undefined, webUrl: 'http://host/app' });
    assert.strictEqual(infobaseDuplicateTargetKey(a), infobaseDuplicateTargetKey(b));
  });

  test('web with invalid URL falls back to web:raw: prefix', () => {
    const e = makeEntry({ type: 'web', filePath: undefined, webUrl: 'not-a-url' });
    const key = infobaseDuplicateTargetKey(e);
    assert.ok(key.startsWith('web:raw:'), `got: ${key}`);
  });

  test('file:path and file:yaml keys differ for same path value', () => {
    const byPath = makeEntry({ type: 'file', filePath: 'C:/base', ibcmdConfigYamlPath: undefined });
    const byYaml = makeEntry({ type: 'file', filePath: undefined, ibcmdConfigYamlPath: 'C:/base' });
    assert.notStrictEqual(infobaseDuplicateTargetKey(byPath), infobaseDuplicateTargetKey(byYaml));
  });
});

// ---------------------------------------------------------------------------
// validateInfobaseEntry
// ---------------------------------------------------------------------------

suite('validateInfobaseEntry', () => {
  test('valid file entry passes without throwing', () => {
    assert.doesNotThrow(() => validateInfobaseEntry(makeEntry()));
  });

  test('valid server entry passes', () => {
    const e = makeEntry({ type: 'server', filePath: undefined, server: 'srv', database: 'db' });
    assert.doesNotThrow(() => validateInfobaseEntry(e));
  });

  test('valid web entry passes', () => {
    const e = makeEntry({ type: 'web', filePath: undefined, webUrl: 'http://host/app' });
    assert.doesNotThrow(() => validateInfobaseEntry(e));
  });

  test('empty id throws InfobaseValidationError', () => {
    assert.throws(() => validateInfobaseEntry(makeEntry({ id: '' })), InfobaseValidationError);
  });

  test('whitespace-only id throws', () => {
    assert.throws(() => validateInfobaseEntry(makeEntry({ id: '   ' })), InfobaseValidationError);
  });

  test('non-UUID id throws', () => {
    assert.throws(() => validateInfobaseEntry(makeEntry({ id: 'not-a-uuid' })), InfobaseValidationError);
  });

  test('UUID v1 (version bit 1) throws', () => {
    // UUID v1: third group starts with 1
    const uuidV1 = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
    assert.throws(() => validateInfobaseEntry(makeEntry({ id: uuidV1 })), InfobaseValidationError);
  });

  test('valid UUID v4 passes', () => {
    const id = randomUUID();
    assert.doesNotThrow(() => validateInfobaseEntry(makeEntry({ id })));
  });

  test('empty name throws', () => {
    assert.throws(() => validateInfobaseEntry(makeEntry({ name: '' })), InfobaseValidationError);
  });

  test('whitespace-only name throws', () => {
    assert.throws(() => validateInfobaseEntry(makeEntry({ name: '  ' })), InfobaseValidationError);
  });

  test('unsupported type throws', () => {
    assert.throws(
      () => validateInfobaseEntry({ ...makeEntry(), type: 'ftp' as InfobaseEntry['type'] }),
      InfobaseValidationError,
    );
  });

  test('file entry without filePath and ibcmdConfigYamlPath throws', () => {
    const e = makeEntry({ type: 'file', filePath: undefined, ibcmdConfigYamlPath: undefined });
    assert.throws(() => validateInfobaseEntry(e), InfobaseValidationError);
  });

  test('file entry with only ibcmdConfigYamlPath (no filePath) passes', () => {
    const e = makeEntry({ type: 'file', filePath: undefined, ibcmdConfigYamlPath: 'C:/conf.yaml' });
    assert.doesNotThrow(() => validateInfobaseEntry(e));
  });

  test('file entry with whitespace-only filePath and no yaml throws', () => {
    const e = makeEntry({ type: 'file', filePath: '   ', ibcmdConfigYamlPath: undefined });
    assert.throws(() => validateInfobaseEntry(e), InfobaseValidationError);
  });

  test('server entry without server throws', () => {
    const e = makeEntry({ type: 'server', filePath: undefined, server: '', database: 'db' });
    assert.throws(() => validateInfobaseEntry(e), InfobaseValidationError);
  });

  test('server entry without database throws', () => {
    const e = makeEntry({ type: 'server', filePath: undefined, server: 'srv', database: '' });
    assert.throws(() => validateInfobaseEntry(e), InfobaseValidationError);
  });

  test('web entry without webUrl throws', () => {
    const e = makeEntry({ type: 'web', filePath: undefined, webUrl: '' });
    assert.throws(() => validateInfobaseEntry(e), InfobaseValidationError);
  });

  test('empty createdAt throws', () => {
    assert.throws(() => validateInfobaseEntry(makeEntry({ createdAt: '' })), InfobaseValidationError);
  });

  test('whitespace createdAt throws', () => {
    assert.throws(() => validateInfobaseEntry(makeEntry({ createdAt: '   ' })), InfobaseValidationError);
  });
});

// ---------------------------------------------------------------------------
// assertNoConflictingInfobaseTarget
// ---------------------------------------------------------------------------

suite('assertNoConflictingInfobaseTarget', () => {
  test('no conflict when existing list is empty', () => {
    const candidate = makeEntry({ filePath: 'C:/base' });
    assert.doesNotThrow(() => assertNoConflictingInfobaseTarget(candidate, []));
  });

  test('conflict when same file path exists in list', () => {
    const a = makeEntry({ filePath: 'C:/base' });
    const b = makeEntry({ filePath: 'C:/base' });
    assert.throws(() => assertNoConflictingInfobaseTarget(b, [a]), InfobaseValidationError);
  });

  test('no conflict when paths differ', () => {
    const a = makeEntry({ filePath: 'C:/base1' });
    const b = makeEntry({ filePath: 'C:/base2' });
    assert.doesNotThrow(() => assertNoConflictingInfobaseTarget(b, [a]));
  });

  test('excludeId skips the matching entry (edit scenario)', () => {
    const e = makeEntry({ filePath: 'C:/base' });
    assert.doesNotThrow(() => assertNoConflictingInfobaseTarget(e, [e], e.id));
  });

  test('conflict still raised when excludeId does not match conflicting entry', () => {
    const a = makeEntry({ filePath: 'C:/base' });
    const b = makeEntry({ filePath: 'C:/base' });
    assert.throws(
      () => assertNoConflictingInfobaseTarget(b, [a], randomUUID()),
      InfobaseValidationError,
    );
  });

  test('no conflict when candidate duplicate key is empty (no target set)', () => {
    const incomplete = makeEntry({ type: 'file', filePath: undefined, ibcmdConfigYamlPath: undefined });
    assert.doesNotThrow(() => assertNoConflictingInfobaseTarget(incomplete, []));
  });

  test('web URL conflict with trailing-slash normalization', () => {
    const a = makeEntry({ type: 'web', filePath: undefined, webUrl: 'http://host/app' });
    const b = makeEntry({ type: 'web', filePath: undefined, webUrl: 'http://host/app/' });
    assert.throws(() => assertNoConflictingInfobaseTarget(b, [a]), InfobaseValidationError);
  });

  test('web URL conflict with host case normalization', () => {
    const a = makeEntry({ type: 'web', filePath: undefined, webUrl: 'http://MyHost/app' });
    const b = makeEntry({ type: 'web', filePath: undefined, webUrl: 'http://myhost/app' });
    assert.throws(() => assertNoConflictingInfobaseTarget(b, [a]), InfobaseValidationError);
  });

  test('server conflict with case-different server name', () => {
    const a = makeEntry({ type: 'server', filePath: undefined, server: 'SRV', database: 'DB' });
    const b = makeEntry({ type: 'server', filePath: undefined, server: 'srv', database: 'db' });
    assert.throws(() => assertNoConflictingInfobaseTarget(b, [a]), InfobaseValidationError);
  });
});

// ---------------------------------------------------------------------------
// validateInfobaseEntryList
// ---------------------------------------------------------------------------

suite('validateInfobaseEntryList', () => {
  test('empty list passes', () => {
    assert.doesNotThrow(() => validateInfobaseEntryList([]));
  });

  test('single valid entry passes', () => {
    assert.doesNotThrow(() => validateInfobaseEntryList([makeEntry()]));
  });

  test('two entries with different paths pass', () => {
    const a = makeEntry({ filePath: 'C:/base1' });
    const b = makeEntry({ filePath: 'C:/base2' });
    assert.doesNotThrow(() => validateInfobaseEntryList([a, b]));
  });

  test('duplicate id throws', () => {
    const id = randomUUID();
    const a = makeEntry({ id, filePath: 'C:/base1' });
    const b = makeEntry({ id, filePath: 'C:/base2' });
    assert.throws(() => validateInfobaseEntryList([a, b]), InfobaseValidationError);
  });

  test('duplicate file path throws', () => {
    const a = makeEntry({ filePath: 'C:/base' });
    const b = makeEntry({ filePath: 'C:/base' });
    assert.throws(() => validateInfobaseEntryList([a, b]), InfobaseValidationError);
  });

  test('duplicate yaml-only path throws', () => {
    const a = makeEntry({ filePath: undefined, ibcmdConfigYamlPath: 'C:/conf.yaml' });
    const b = makeEntry({ filePath: undefined, ibcmdConfigYamlPath: 'C:/conf.yaml' });
    assert.throws(() => validateInfobaseEntryList([a, b]), InfobaseValidationError);
  });

  test('duplicate server target throws', () => {
    const a = makeEntry({ type: 'server', filePath: undefined, server: 'srv', database: 'db' });
    const b = makeEntry({ type: 'server', filePath: undefined, server: 'SRV', database: 'DB' });
    assert.throws(() => validateInfobaseEntryList([a, b]), InfobaseValidationError);
  });

  test('list at max entries passes', () => {
    const list: InfobaseEntry[] = [];
    for (let i = 0; i < INFOBASE_STORAGE_MAX_ENTRIES; i++) {
      list.push(makeEntry({ filePath: `C:/base${i}` }));
    }
    assert.doesNotThrow(() => validateInfobaseEntryList(list));
  });

  test('list exceeding max entries throws', () => {
    const list: InfobaseEntry[] = [];
    for (let i = 0; i <= INFOBASE_STORAGE_MAX_ENTRIES; i++) {
      list.push(makeEntry({ filePath: `C:/base${i}` }));
    }
    assert.throws(() => validateInfobaseEntryList(list), InfobaseValidationError);
  });

  test('invalid entry within list throws', () => {
    const bad = makeEntry({ name: '' });
    assert.throws(() => validateInfobaseEntryList([bad]), InfobaseValidationError);
  });
});

// ---------------------------------------------------------------------------
// validateInfobaseFolders
// ---------------------------------------------------------------------------

suite('validateInfobaseFolders', () => {
  test('empty folder list passes', () => {
    assert.doesNotThrow(() => validateInfobaseFolders([]));
  });

  test('single valid folder passes', () => {
    assert.doesNotThrow(() => validateInfobaseFolders([makeFolder()]));
  });

  test('nested folders without cycle pass', () => {
    const parent = makeFolder({ name: 'Parent' });
    const child = makeFolder({ name: 'Child', parentId: parent.id });
    assert.doesNotThrow(() => validateInfobaseFolders([parent, child]));
  });

  test('duplicate folder id throws', () => {
    const id = randomUUID();
    const a = makeFolder({ id, name: 'A' });
    const b = makeFolder({ id, name: 'B' });
    assert.throws(() => validateInfobaseFolders([a, b]), InfobaseValidationError);
  });

  test('folder as its own parent throws', () => {
    const id = randomUUID();
    const f = makeFolder({ id, parentId: id });
    assert.throws(() => validateInfobaseFolders([f]), InfobaseValidationError);
  });

  test('missing parent id reference throws', () => {
    const f = makeFolder({ parentId: randomUUID() });
    assert.throws(() => validateInfobaseFolders([f]), InfobaseValidationError);
  });

  test('circular parent chain throws', () => {
    const idA = randomUUID();
    const idB = randomUUID();
    const a: InfobaseFolder = { id: idA, name: 'A', parentId: idB };
    const b: InfobaseFolder = { id: idB, name: 'B', parentId: idA };
    assert.throws(() => validateInfobaseFolders([a, b]), InfobaseValidationError);
  });

  test('folder with empty id throws', () => {
    const f: InfobaseFolder = { id: '', name: 'NoId' };
    assert.throws(() => validateInfobaseFolders([f]), InfobaseValidationError);
  });

  test('folder with non-UUID id throws', () => {
    const f: InfobaseFolder = { id: 'not-a-uuid', name: 'Bad' };
    assert.throws(() => validateInfobaseFolders([f]), InfobaseValidationError);
  });

  test('folder with empty name throws', () => {
    const f = makeFolder({ name: '' });
    assert.throws(() => validateInfobaseFolders([f]), InfobaseValidationError);
  });

  test('three-level chain without cycle passes', () => {
    const grandparent = makeFolder({ name: 'GP' });
    const parent = makeFolder({ name: 'P', parentId: grandparent.id });
    const child = makeFolder({ name: 'C', parentId: parent.id });
    assert.doesNotThrow(() => validateInfobaseFolders([grandparent, parent, child]));
  });
});

// ---------------------------------------------------------------------------
// validateInfobaseCatalog
// ---------------------------------------------------------------------------

suite('validateInfobaseCatalog', () => {
  test('empty entries and empty folders passes', () => {
    assert.doesNotThrow(() => validateInfobaseCatalog([], []));
  });

  test('valid entry with matching folderId passes', () => {
    const folder = makeFolder();
    const entry = makeEntry({ folderId: folder.id });
    assert.doesNotThrow(() => validateInfobaseCatalog([entry], [folder]));
  });

  test('entry referencing non-existent folderId throws', () => {
    const entry = makeEntry({ folderId: randomUUID() });
    assert.throws(() => validateInfobaseCatalog([entry], []), InfobaseValidationError);
  });

  test('invalid folder causes catalog validation to fail', () => {
    const id = randomUUID();
    const dupFolders = [makeFolder({ id }), makeFolder({ id })];
    assert.throws(() => validateInfobaseCatalog([], dupFolders), InfobaseValidationError);
  });

  test('invalid entry causes catalog validation to fail', () => {
    const bad = makeEntry({ name: '' });
    assert.throws(() => validateInfobaseCatalog([bad], []), InfobaseValidationError);
  });

  test('duplicate entry ids cause catalog validation to fail', () => {
    const id = randomUUID();
    const a = makeEntry({ id, filePath: 'C:/a' });
    const b = makeEntry({ id, filePath: 'C:/b' });
    assert.throws(() => validateInfobaseCatalog([a, b], []), InfobaseValidationError);
  });

  test('entry without folderId passes even when folders exist', () => {
    const folder = makeFolder();
    const entry = makeEntry({ folderId: undefined });
    assert.doesNotThrow(() => validateInfobaseCatalog([entry], [folder]));
  });
});
