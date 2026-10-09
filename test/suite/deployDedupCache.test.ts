import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  checkRecentDeploy,
  computeFilesContentHash,
  recordDeploy,
  resetDeployDedupCacheForTests,
} from '../../src/bindings/deployDedupCache';

const KEY_A = { bindingId: '/cfg/Configuration.xml', infobaseId: 'base-1' };
const KEY_B = { bindingId: '/cfg/Configuration.xml', infobaseId: 'base-2' };
const FILES_A = { relativeFiles: ['CommonModules/Foo.xml', 'CommonModules/Foo/Ext/Module.bsl'] };
const FILES_B = { relativeFiles: ['Documents/Doc1.xml'] };

suite('deployDedupCache', () => {
  setup(() => {
    resetDeployDedupCacheForTests();
  });

  test('first check without record returns isDuplicate false', () => {
    const result = checkRecentDeploy(KEY_A, FILES_A, 1000);
    assert.strictEqual(result.isDuplicate, false);
  });

  test('check immediately after record returns isDuplicate true with ageMs', () => {
    recordDeploy(KEY_A, FILES_A, 1000);
    const result = checkRecentDeploy(KEY_A, FILES_A, 1500);
    assert.strictEqual(result.isDuplicate, true);
    assert.strictEqual(result.ageMs, 500);
  });

  test('check after dedup window expires returns isDuplicate false', () => {
    recordDeploy(KEY_A, FILES_A, 1000);
    const result = checkRecentDeploy(KEY_A, FILES_A, 3500); // 2500 ms later
    assert.strictEqual(result.isDuplicate, false);
  });

  test('different file set returns isDuplicate false', () => {
    recordDeploy(KEY_A, FILES_A, 1000);
    const result = checkRecentDeploy(KEY_A, FILES_B, 1500);
    assert.strictEqual(result.isDuplicate, false);
  });

  test('different infobaseId is independent', () => {
    recordDeploy(KEY_A, FILES_A, 1000);
    const result = checkRecentDeploy(KEY_B, FILES_A, 1500);
    assert.strictEqual(result.isDuplicate, false);
  });

  test('hash is order-insensitive (sorted)', () => {
    const filesReordered = { relativeFiles: [...FILES_A.relativeFiles].reverse() };
    recordDeploy(KEY_A, FILES_A, 1000);
    const result = checkRecentDeploy(KEY_A, filesReordered, 1500);
    assert.strictEqual(result.isDuplicate, true);
  });

  test('reset clears all entries', () => {
    recordDeploy(KEY_A, FILES_A, 1000);
    resetDeployDedupCacheForTests();
    const result = checkRecentDeploy(KEY_A, FILES_A, 1500);
    assert.strictEqual(result.isDuplicate, false);
  });

  test('boundary: exactly at window edge (nowMs - timestamp === 2000) is not duplicate', () => {
    recordDeploy(KEY_A, FILES_A, 1000);
    const result = checkRecentDeploy(KEY_A, FILES_A, 3000); // exactly 2000 ms
    assert.strictEqual(result.isDuplicate, false);
  });

  test('different contentHash for same files is not duplicate (#185)', () => {
    const inputV1 = { relativeFiles: FILES_A.relativeFiles, contentHash: 'hash-v1' };
    const inputV2 = { relativeFiles: FILES_A.relativeFiles, contentHash: 'hash-v2' };
    recordDeploy(KEY_A, inputV1, 1000);
    const result = checkRecentDeploy(KEY_A, inputV2, 1500);
    assert.strictEqual(result.isDuplicate, false);
  });

  test('same contentHash for same files within window is duplicate (#185)', () => {
    const inputV1 = { relativeFiles: FILES_A.relativeFiles, contentHash: 'hash-v1' };
    recordDeploy(KEY_A, inputV1, 1000);
    const result = checkRecentDeploy(KEY_A, inputV1, 1500);
    assert.strictEqual(result.isDuplicate, true);
    assert.strictEqual(result.ageMs, 500);
  });

  test('computeFilesContentHash computes deterministic hash and reflects file modifications (#185)', async () => {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cv-dedup-hash-'));
    try {
      const relPath = 'module.bsl';
      const fullPath = path.join(tmpDir, relPath);
      await fs.promises.writeFile(fullPath, 'Код 1', 'utf8');

      const hash1 = await computeFilesContentHash(tmpDir, [relPath]);
      assert.ok(typeof hash1 === 'string' && hash1.length > 0);

      // Same content produces same hash
      const hash1Repeat = await computeFilesContentHash(tmpDir, [relPath]);
      assert.strictEqual(hash1, hash1Repeat);

      // Modified content produces different hash
      await fs.promises.writeFile(fullPath, 'Код 2', 'utf8');
      const hash2 = await computeFilesContentHash(tmpDir, [relPath]);
      assert.notStrictEqual(hash1, hash2);
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
