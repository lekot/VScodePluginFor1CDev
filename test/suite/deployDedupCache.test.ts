import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  checkRecentDeploy,
  computeFilesContentSignature,
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

  test('same file paths with different contentSignature within window returns isDuplicate false (#185)', () => {
    const inputV1 = { relativeFiles: FILES_A.relativeFiles, contentSignature: 'sig-v1' };
    const inputV2 = { relativeFiles: FILES_A.relativeFiles, contentSignature: 'sig-v2' };

    recordDeploy(KEY_A, inputV1, 1000);
    // 500ms later, user deployed modified content of the same files
    const result = checkRecentDeploy(KEY_A, inputV2, 1500);
    assert.strictEqual(result.isDuplicate, false, 'Modified content must not be dropped as duplicate');
  });

  test('same file paths with matching contentSignature within window returns isDuplicate true (#185)', () => {
    const inputV1 = { relativeFiles: FILES_A.relativeFiles, contentSignature: 'sig-v1' };

    recordDeploy(KEY_A, inputV1, 1000);
    const result = checkRecentDeploy(KEY_A, inputV1, 1500);
    assert.strictEqual(result.isDuplicate, true);
    assert.strictEqual(result.ageMs, 500);
  });

  test('computeFilesContentSignature changes when file content/mtime changes (#185 broad test)', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-dedup-sig-'));
    try {
      const relPath = 'module.bsl';
      const absPath = path.join(tmp, relPath);
      await fs.promises.writeFile(absPath, 'Procedure A() EndProcedure', 'utf-8');

      const sig1 = await computeFilesContentSignature(tmp, [relPath]);
      assert.ok(typeof sig1 === 'string' && sig1.length > 0);

      // Same unchanged file produces identical signature
      const sig1Again = await computeFilesContentSignature(tmp, [relPath]);
      assert.strictEqual(sig1Again, sig1);

      // Modify file content and mtime
      await new Promise((r) => setTimeout(r, 15));
      await fs.promises.writeFile(absPath, 'Procedure A() // modified\nEndProcedure', 'utf-8');

      const sig2 = await computeFilesContentSignature(tmp, [relPath]);
      assert.notStrictEqual(sig2, sig1, 'Signature must change after file content is updated');

      // Order of files does not affect signature
      const rel2 = 'other.bsl';
      await fs.promises.writeFile(path.join(tmp, rel2), '// other', 'utf-8');
      const sigOrder1 = await computeFilesContentSignature(tmp, [relPath, rel2]);
      const sigOrder2 = await computeFilesContentSignature(tmp, [rel2, relPath]);
      assert.strictEqual(sigOrder1, sigOrder2, 'Signature must be deterministic regardless of array order');

      // Missing file handled gracefully
      const sigMissing = await computeFilesContentSignature(tmp, ['nonexistent.bsl']);
      assert.ok(typeof sigMissing === 'string');
    } finally {
      await fs.promises.rm(tmp, { recursive: true, force: true });
    }
  });
});


