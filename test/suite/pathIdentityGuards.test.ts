import * as assert from 'assert';
import * as path from 'path';
import {
  filesystemPathKey,
  configurationPathKey,
  isSamePath,
  isSameOrDescendantPath,
} from '../../src/utils/configurationPathIdentity';
import { getRepositoryStateMutationLockKey } from '../../src/services/configurationRepository/repositoryStores';

suite('Platform-Aware Path Identity & Containment Guards (#207)', () => {
  suite('filesystemPathKey & configurationPathKey', () => {
    test('POSIX: preserves case for distinct directory paths', () => {
      const path1 = '/workspace/Config/src';
      const path2 = '/workspace/config/src';
      const key1 = filesystemPathKey(path1, 'linux');
      const key2 = filesystemPathKey(path2, 'linux');
      assert.notStrictEqual(key1, key2, 'POSIX must preserve case distinction');
      assert.strictEqual(key1, path.posix.resolve(path1));
      assert.strictEqual(key2, path.posix.resolve(path2));
    });

    test('Windows: coalesces case aliases to lowercase', () => {
      const path1 = 'C:\\Workspace\\Config\\src';
      const path2 = 'c:\\workspace\\config\\src';
      const key1 = filesystemPathKey(path1, 'win32');
      const key2 = filesystemPathKey(path2, 'win32');
      assert.strictEqual(key1, key2, 'Windows must fold casing');
      assert.strictEqual(key1, path.win32.resolve(path1).toLowerCase());
    });

    test('configurationPathKey delegates to filesystemPathKey', () => {
      const p = '/test/path/to/config';
      assert.strictEqual(configurationPathKey(p, 'linux'), filesystemPathKey(p, 'linux'));
      assert.strictEqual(configurationPathKey(p, 'win32'), filesystemPathKey(p, 'win32'));
    });

    test('coalesces redundant slashes, trailing slashes and dot-segments', () => {
      const raw = '/workspace//sub/./nested/../nested/';
      const clean = '/workspace/sub/nested';
      assert.strictEqual(filesystemPathKey(raw, 'linux'), filesystemPathKey(clean, 'linux'));
    });
  });

  suite('isSamePath', () => {
    test('POSIX: exact match is same, different case is not same', () => {
      assert.strictEqual(isSamePath('/a/b/C', '/a/b/C', 'linux'), true);
      assert.strictEqual(isSamePath('/a/b/C', '/a/b/c', 'linux'), false);
    });

    test('Windows: case-insensitive aliases are same', () => {
      assert.strictEqual(isSamePath('C:\\a\\b\\C', 'c:\\a\\b\\c', 'win32'), true);
      assert.strictEqual(isSamePath('C:\\a\\b\\c\\', 'c:\\a\\b\\c', 'win32'), true);
    });
  });

  suite('isSameOrDescendantPath (Segment Boundary Containment)', () => {
    test('returns true for identical paths', () => {
      assert.strictEqual(isSameOrDescendantPath('/workspace/config', '/workspace/config', 'linux'), true);
      assert.strictEqual(isSameOrDescendantPath('C:\\workspace\\config', 'c:\\workspace\\config', 'win32'), true);
    });

    test('returns true for direct children and deep descendants', () => {
      assert.strictEqual(isSameOrDescendantPath('/workspace/config', '/workspace/config/Catalogs', 'linux'), true);
      assert.strictEqual(isSameOrDescendantPath('/workspace/config', '/workspace/config/Catalogs/Goods/Ext.xml', 'linux'), true);
      assert.strictEqual(isSameOrDescendantPath('C:\\workspace\\config', 'C:\\workspace\\config\\Catalogs\\Goods', 'win32'), true);
    });

    test('CRITICAL: respects segment boundaries and prevents prefix collisions (e.g. /foo/bar vs /foo/bar2)', () => {
      assert.strictEqual(isSameOrDescendantPath('/workspace/config', '/workspace/config2', 'linux'), false);
      assert.strictEqual(isSameOrDescendantPath('/workspace/config', '/workspace/config_backup', 'linux'), false);
      assert.strictEqual(isSameOrDescendantPath('C:\\workspace\\config', 'C:\\workspace\\config2', 'win32'), false);
      assert.strictEqual(isSameOrDescendantPath('C:\\workspace\\config', 'C:\\workspace\\config-old', 'win32'), false);
    });

    test('returns false for parent paths or sibling paths', () => {
      assert.strictEqual(isSameOrDescendantPath('/workspace/config', '/workspace', 'linux'), false);
      assert.strictEqual(isSameOrDescendantPath('/workspace/config', '/workspace/other', 'linux'), false);
      assert.strictEqual(isSameOrDescendantPath('C:\\workspace\\config', 'C:\\workspace', 'win32'), false);
    });

    test('returns false for traversal escapes', () => {
      assert.strictEqual(isSameOrDescendantPath('/workspace/config', '/workspace/config/../other', 'linux'), false);
      assert.strictEqual(isSameOrDescendantPath('C:\\workspace\\config', 'C:\\workspace\\config\\..\\other', 'win32'), false);
    });

    test('POSIX: rejects descendant if parent casing differs', () => {
      assert.strictEqual(isSameOrDescendantPath('/workspace/Config', '/workspace/config/sub', 'linux'), false);
      assert.strictEqual(isSameOrDescendantPath('/workspace/config', '/workspace/Config/sub', 'linux'), false);
    });

    test('Windows: accepts descendant even if casing differs', () => {
      assert.strictEqual(isSameOrDescendantPath('C:\\Workspace\\Config', 'c:\\workspace\\config\\sub', 'win32'), true);
      assert.strictEqual(isSameOrDescendantPath('c:\\workspace\\config', 'C:\\WORKSPACE\\CONFIG\\SUB\\file.xml', 'win32'), true);
    });
  });

  suite('Repository Stores Mutation Lock Key (#207)', () => {
    test('POSIX: distinct state files do not share lock key', () => {
      const lockKey1 = getRepositoryStateMutationLockKey('/tmp/Config/state.json', 'linux');
      const lockKey2 = getRepositoryStateMutationLockKey('/tmp/config/state.json', 'linux');
      assert.notStrictEqual(lockKey1, lockKey2, 'POSIX repository lock keys must not collide');
    });

    test('Windows: case-variant paths share lock key', () => {
      const lockKey1 = getRepositoryStateMutationLockKey('C:\\tmp\\Config\\state.json', 'win32');
      const lockKey2 = getRepositoryStateMutationLockKey('c:\\tmp\\config\\state.json', 'win32');
      assert.strictEqual(lockKey1, lockKey2, 'Windows repository lock keys must coalesce');
    });
  });
});
