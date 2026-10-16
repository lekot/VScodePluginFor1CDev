import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  filesystemPathKey,
  configurationPathKey,
  isSamePath,
  isSameOrDescendantPath,
  canonicalizeFsPath,
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

    test('Windows: 8.3 short-name aliases are recognized as same path (#328)', function () {
      if (process.platform !== 'win32' || !process.env.TEMP) {
        this.skip();
        return;
      }
      const shortPath = process.env.TEMP;
      let longPath: string;
      try {
        longPath = fs.realpathSync.native(shortPath);
      } catch {
        this.skip();
        return;
      }
      if (shortPath.toLowerCase() === longPath.toLowerCase()) {
        this.skip();
        return;
      }

      assert.strictEqual(isSamePath(shortPath, longPath, 'win32'), true);
      assert.strictEqual(isSamePath(path.join(shortPath, 'sub'), path.join(longPath, 'sub'), 'win32'), true);
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

    test('Windows: accepts descendant across 8.3 short-name aliases (#328)', function () {
      if (process.platform !== 'win32' || !process.env.TEMP) {
        this.skip();
        return;
      }
      const shortRoot = process.env.TEMP;
      let longRoot: string;
      try {
        longRoot = fs.realpathSync.native(shortRoot);
      } catch {
        this.skip();
        return;
      }
      if (shortRoot.toLowerCase() === longRoot.toLowerCase()) {
        this.skip();
        return;
      }

      const shortChild = path.join(shortRoot, 'SubFolder', 'Child.xml');
      const longChild = path.join(longRoot, 'SubFolder', 'Child.xml');

      // Parent short, child long
      assert.strictEqual(isSameOrDescendantPath(shortRoot, longChild, 'win32'), true);
      // Parent long, child short
      assert.strictEqual(isSameOrDescendantPath(longRoot, shortChild, 'win32'), true);
    });

    test('canonical fallback: handles relative paths where lexical fails but filesystem matches', () => {
      const tempDir = fs.mkdtempSync(path.join(path.resolve('.'), 'tmp-canonical-'));
      try {
        const sub = path.join(tempDir, 'sub');
        fs.mkdirSync(sub, { recursive: true });
        const child = path.join(sub, 'child.xml');
        fs.writeFileSync(child, '<xml/>');
        assert.strictEqual(isSameOrDescendantPath(tempDir, child), true);
        assert.strictEqual(isSameOrDescendantPath(sub, tempDir), false);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  suite('canonicalizeFsPath', () => {
    test('resolves existing path to canonical path', () => {
      const real = canonicalizeFsPath(__dirname);
      assert.ok(real);
      assert.strictEqual(typeof real, 'string');
    });

    test('resolves non-existent file path inside existing ancestor directory', () => {
      const candidate = path.join(__dirname, 'nonexistent-child-file.xml');
      const canonical = canonicalizeFsPath(candidate);
      assert.ok(canonical.endsWith('nonexistent-child-file.xml'));
    });

    test('falls back to resolved path when entire ancestor tree does not exist', () => {
      const synthetic = path.resolve('/nonexistent_root_dir_abc_123/sub/child.xml');
      const canonical = canonicalizeFsPath(synthetic);
      assert.strictEqual(canonical, synthetic);
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
