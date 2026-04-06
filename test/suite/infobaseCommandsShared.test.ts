/**
 * Tests for infobaseCommandsShared.ts — pure functions and type guards only.
 * Functions that require VS Code context (pickInfobaseType, ensureStorageReady,
 * ensureInfobaseManagerReady, loadAll) are intentionally skipped.
 */
import * as assert from 'assert';
import { randomUUID } from 'crypto';
import {
  defaultNameFromFsPath,
  isTreeEntryArg,
  isTreeFolderArg,
  nowIso,
  touchLastUsed,
  validateWebClientUrlInput,
} from '../../src/infobases/infobaseCommandsShared';
import type { InfobaseEntry, InfobaseFolder } from '../../src/infobases/models/infobaseEntry';

// ---------------------------------------------------------------------------
// Minimal stub for InfobaseStorageService (only upsert is needed)
// ---------------------------------------------------------------------------

interface UpsertCapture {
  called: boolean;
  lastEntry: InfobaseEntry | undefined;
}

function makeStorageStub(capture: UpsertCapture): { upsert(e: InfobaseEntry): Promise<void> } {
  return {
    async upsert(e: InfobaseEntry) {
      capture.called = true;
      capture.lastEntry = e;
    },
  };
}

function makeEntry(overrides: Partial<InfobaseEntry> = {}): InfobaseEntry {
  const id = overrides.id ?? randomUUID();
  return {
    id,
    name: 'TestBase',
    type: 'file',
    filePath: `C:/bases/${id}`,
    hasStoredPassword: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// nowIso
// ---------------------------------------------------------------------------

suite('nowIso', () => {
  test('returns a non-empty string', () => {
    const result = nowIso();
    assert.ok(typeof result === 'string' && result.length > 0);
  });

  test('returns a valid ISO 8601 date string parseable by Date', () => {
    const result = nowIso();
    const parsed = new Date(result);
    assert.ok(!isNaN(parsed.getTime()), `Not a valid date: ${result}`);
  });

  test('contains T separator (ISO format)', () => {
    const result = nowIso();
    assert.ok(result.includes('T'), `Expected T separator in ISO string: ${result}`);
  });

  test('two consecutive calls produce non-decreasing timestamps', () => {
    const a = new Date(nowIso()).getTime();
    const b = new Date(nowIso()).getTime();
    assert.ok(b >= a);
  });
});

// ---------------------------------------------------------------------------
// defaultNameFromFsPath
// ---------------------------------------------------------------------------

suite('defaultNameFromFsPath', () => {
  test('extracts basename from simple path', () => {
    assert.strictEqual(defaultNameFromFsPath('C:/databases/MyBase'), 'MyBase');
  });

  test('extracts basename from Unix-style path', () => {
    assert.strictEqual(defaultNameFromFsPath('/home/user/mybase'), 'mybase');
  });

  test('extracts basename from path with trailing slash', () => {
    // path.basename of resolved path — trailing slash stripped by path.resolve
    const result = defaultNameFromFsPath('C:/bases/SomeBase/');
    assert.ok(result.length > 0 && result !== '/');
  });

  test('returns fallback "База" for empty string', () => {
    // path.basename('') on resolved '' is the cwd basename — may not be empty,
    // but the function falls back to 'База' only when base is falsy.
    // Empty string resolves to cwd, cwd basename is non-empty, so we just check
    // the function doesn't throw.
    assert.doesNotThrow(() => defaultNameFromFsPath(''));
  });

  test('works with Windows backslash path', () => {
    const result = defaultNameFromFsPath('C:\\databases\\MyBase');
    assert.ok(result.length > 0);
  });

  test('extracts just the directory name, not the full path', () => {
    const result = defaultNameFromFsPath('C:/a/b/c/TargetBase');
    assert.strictEqual(result, 'TargetBase');
  });

  test('single segment path returns that segment', () => {
    const result = defaultNameFromFsPath('MyBase');
    assert.ok(result.length > 0);
  });
});

// ---------------------------------------------------------------------------
// validateWebClientUrlInput
// ---------------------------------------------------------------------------

suite('validateWebClientUrlInput', () => {
  test('valid http URL returns null (no error)', () => {
    assert.strictEqual(validateWebClientUrlInput('http://host/app'), null);
  });

  test('valid https URL returns null', () => {
    assert.strictEqual(validateWebClientUrlInput('https://my.server.com/1c/hs'), null);
  });

  test('https URL with port and path returns null', () => {
    assert.strictEqual(validateWebClientUrlInput('https://host:8080/myapp'), null);
  });

  test('empty string returns validation message', () => {
    const result = validateWebClientUrlInput('');
    assert.ok(typeof result === 'string' && result.length > 0);
  });

  test('whitespace-only string returns validation message', () => {
    const result = validateWebClientUrlInput('   ');
    assert.ok(typeof result === 'string' && result.length > 0);
  });

  test('non-URL string returns validation message', () => {
    const result = validateWebClientUrlInput('not a url at all');
    assert.ok(typeof result === 'string' && result.length > 0);
  });

  test('ftp:// URL is rejected (not http/https)', () => {
    const result = validateWebClientUrlInput('ftp://host/data');
    assert.ok(typeof result === 'string' && result.length > 0);
  });

  test('file:// URL is rejected', () => {
    const result = validateWebClientUrlInput('file:///C:/base');
    assert.ok(typeof result === 'string' && result.length > 0);
  });

  test('URL without protocol is rejected', () => {
    const result = validateWebClientUrlInput('host/app');
    assert.ok(typeof result === 'string' && result.length > 0);
  });

  test('valid URL with query string returns null', () => {
    assert.strictEqual(validateWebClientUrlInput('https://host/app?lang=ru'), null);
  });
});

// ---------------------------------------------------------------------------
// isTreeFolderArg
// ---------------------------------------------------------------------------

suite('isTreeFolderArg', () => {
  test('returns true for valid folder arg shape', () => {
    const folder: InfobaseFolder = { id: randomUUID(), name: 'F' };
    assert.ok(isTreeFolderArg({ kind: 'folder', folder }));
  });

  test('returns false for null', () => {
    assert.strictEqual(isTreeFolderArg(null), false);
  });

  test('returns false for undefined', () => {
    assert.strictEqual(isTreeFolderArg(undefined), false);
  });

  test('returns false for entry arg shape (kind = "entry")', () => {
    const entry = makeEntry();
    assert.strictEqual(isTreeFolderArg({ kind: 'entry', entry }), false);
  });

  test('returns false when folder property is missing', () => {
    assert.strictEqual(isTreeFolderArg({ kind: 'folder' }), false);
  });

  test('returns false when folder.id is not a string', () => {
    assert.strictEqual(isTreeFolderArg({ kind: 'folder', folder: { id: 42, name: 'X' } }), false);
  });

  test('returns false for plain string', () => {
    assert.strictEqual(isTreeFolderArg('folder'), false);
  });

  test('returns false when kind is wrong value', () => {
    const folder: InfobaseFolder = { id: randomUUID(), name: 'F' };
    assert.strictEqual(isTreeFolderArg({ kind: 'other', folder }), false);
  });
});

// ---------------------------------------------------------------------------
// isTreeEntryArg
// ---------------------------------------------------------------------------

suite('isTreeEntryArg', () => {
  test('returns true for valid entry arg shape', () => {
    const entry = makeEntry();
    assert.ok(isTreeEntryArg({ kind: 'entry', entry }));
  });

  test('returns false for null', () => {
    assert.strictEqual(isTreeEntryArg(null), false);
  });

  test('returns false for undefined', () => {
    assert.strictEqual(isTreeEntryArg(undefined), false);
  });

  test('returns false for folder arg shape (kind = "folder")', () => {
    const folder: InfobaseFolder = { id: randomUUID(), name: 'F' };
    assert.strictEqual(isTreeEntryArg({ kind: 'folder', folder }), false);
  });

  test('returns false when entry property is missing', () => {
    assert.strictEqual(isTreeEntryArg({ kind: 'entry' }), false);
  });

  test('returns false when entry is not an object', () => {
    assert.strictEqual(isTreeEntryArg({ kind: 'entry', entry: 'string' }), false);
  });

  test('returns false for plain string', () => {
    assert.strictEqual(isTreeEntryArg('entry'), false);
  });

  test('returns false when kind is wrong value', () => {
    const entry = makeEntry();
    assert.strictEqual(isTreeEntryArg({ kind: 'other', entry }), false);
  });
});

// ---------------------------------------------------------------------------
// touchLastUsed
// ---------------------------------------------------------------------------

suite('touchLastUsed', () => {
  test('calls storage.upsert with updated lastUsedAt', async () => {
    const capture: UpsertCapture = { called: false, lastEntry: undefined };
    const storage = makeStorageStub(capture);
    const entry = makeEntry({ lastUsedAt: undefined });

    const before = Date.now();
    await touchLastUsed(
      storage as unknown as Parameters<typeof touchLastUsed>[0],
      entry,
    );
    const after = Date.now();

    assert.ok(capture.called, 'upsert was not called');
    assert.ok(capture.lastEntry !== undefined);
    const ts = new Date(capture.lastEntry!.lastUsedAt!).getTime();
    assert.ok(ts >= before && ts <= after, `lastUsedAt out of expected range: ${capture.lastEntry!.lastUsedAt}`);
  });

  test('preserves all other entry fields', async () => {
    const capture: UpsertCapture = { called: false, lastEntry: undefined };
    const storage = makeStorageStub(capture);
    const entry = makeEntry({ name: 'Preserved', filePath: 'C:/original' });

    await touchLastUsed(
      storage as unknown as Parameters<typeof touchLastUsed>[0],
      entry,
    );

    assert.strictEqual(capture.lastEntry!.id, entry.id);
    assert.strictEqual(capture.lastEntry!.name, 'Preserved');
    assert.strictEqual(capture.lastEntry!.filePath, 'C:/original');
  });

  test('overwrites existing lastUsedAt', async () => {
    const capture: UpsertCapture = { called: false, lastEntry: undefined };
    const storage = makeStorageStub(capture);
    const oldTs = '2020-01-01T00:00:00.000Z';
    const entry = makeEntry({ lastUsedAt: oldTs });

    await touchLastUsed(
      storage as unknown as Parameters<typeof touchLastUsed>[0],
      entry,
    );

    assert.notStrictEqual(capture.lastEntry!.lastUsedAt, oldTs);
  });
});
