import * as assert from 'assert';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { writeUtf8FileWithBackup, type WriteUtf8FileWithBackupOptions } from '../../src/utils/xml/xmlFileIo';
import { XMLWriter } from '../../src/utils/XMLWriter';

suite('xmlFileIo: writeUtf8FileWithBackup & Backup Preservation', () => {
  let tempDir: string;

  setup(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xml-file-io-backup-'));
  });

  teardown(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  test('successful write updates target file and cleans up backup', async () => {
    const target = path.join(tempDir, 'sample.xml');
    const original = '<Root>Original</Root>';
    const updated = '<Root>Updated</Root>';
    await fsp.writeFile(target, original, 'utf-8');

    await writeUtf8FileWithBackup(target, original, updated);

    assert.strictEqual(await fsp.readFile(target, 'utf-8'), updated);
    const files = await fsp.readdir(tempDir);
    assert.deepStrictEqual(files, ['sample.xml'], 'No backup files should remain on success');
  });

  test('write failure with successful rollback restores original content and cleans up backup', async () => {
    const target = path.join(tempDir, 'sample.xml');
    const original = '<Root>Original</Root>';
    const updated = '<Root>Updated</Root>';
    await fsp.writeFile(target, original, 'utf-8');

    let writeCount = 0;
    const options: WriteUtf8FileWithBackupOptions = {
      hooks: {
        writeFile: async (filePath, data, enc) => {
          if (path.resolve(filePath) === path.resolve(target)) {
            writeCount++;
            if (writeCount === 1) {
              // Simulate write failure on target
              throw new Error('Disk full during target write');
            }
          }
          await fsp.writeFile(filePath, data, enc);
        },
      },
    };

    await assert.rejects(
      async () => {
        await writeUtf8FileWithBackup(target, original, updated, options);
      },
      (err: Error) => {
        assert.ok(err.message.includes('Disk full during target write') || err.message.includes('Unable to write to file'));
        return true;
      }
    );

    assert.strictEqual(await fsp.readFile(target, 'utf-8'), original, 'Original content must be restored by rollback');
    const files = await fsp.readdir(tempDir);
    assert.deepStrictEqual(files, ['sample.xml'], 'Backup should be removed after successful rollback');
  });

  test('reproduction: write failure with failed rollback MUST preserve intact backup on disk and report its path', async () => {
    const target = path.join(tempDir, 'sample.xml');
    const original = '<Root>Original Content To Preserve</Root>';
    const updated = '<Root>Updated Content</Root>';
    await fsp.writeFile(target, original, 'utf-8');

    const options: WriteUtf8FileWithBackupOptions = {
      hooks: {
        writeFile: async (filePath, data, enc) => {
          if (path.resolve(filePath) === path.resolve(target)) {
            // Write partial/corrupted content to simulate crash/aborted write, then throw
            await fsp.writeFile(filePath, 'partial', 'utf-8');
            throw new Error('EIO: target write failed');
          }
          await fsp.writeFile(filePath, data, enc);
        },
      },
    };

    let caughtError: (Error & { backupPath?: string }) | undefined;
    try {
      await writeUtf8FileWithBackup(target, original, updated, options);
    } catch (err) {
      caughtError = err as Error & { backupPath?: string };
    }

    assert.ok(caughtError, 'Expected writeUtf8FileWithBackup to reject on failure');
    assert.strictEqual(await fsp.readFile(target, 'utf-8'), 'partial', 'Target is in partial state');

    // Find any backup files in tempDir
    const files = await fsp.readdir(tempDir);
    const backupFiles = files.filter((f) => f.includes('.bak'));
    assert.ok(
      backupFiles.length > 0,
      `A recoverable backup file must remain on disk when rollback fails! Found files: ${JSON.stringify(files)}`
    );

    const preservedBackupPath = path.join(tempDir, backupFiles[0]);
    const preservedContent = await fsp.readFile(preservedBackupPath, 'utf-8');
    assert.strictEqual(preservedContent, original, 'Preserved backup must contain intact original content');

    // Error must report where the backup is retained
    assert.ok(
      caughtError.message.includes('Recovery backup preserved at:') ||
      (caughtError.backupPath && fs.existsSync(caughtError.backupPath)),
      `Error must report where backup is retained. Actual error message: ${caughtError.message}`
    );
  });

  test('backup creation failure aborts write, leaves target untouched, and does not attempt rollback', async () => {
    const target = path.join(tempDir, 'sample.xml');
    const original = '<Root>Untouched Original</Root>';
    const updated = '<Root>Updated Content</Root>';
    await fsp.writeFile(target, original, 'utf-8');

    let targetWriteAttempted = false;
    const options: WriteUtf8FileWithBackupOptions = {
      hooks: {
        writeFile: async (filePath, data, enc) => {
          if (filePath.includes('.bak')) {
            throw new Error('ENOSPC: cannot create backup');
          }
          if (path.resolve(filePath) === path.resolve(target)) {
            targetWriteAttempted = true;
          }
          await fsp.writeFile(filePath, data, enc);
        },
      },
    };

    await assert.rejects(
      async () => {
        await writeUtf8FileWithBackup(target, original, updated, options);
      },
      /cannot create backup|Failed to create backup/
    );

    assert.strictEqual(targetWriteAttempted, false, 'Target write must NOT be attempted if backup creation fails');
    assert.strictEqual(await fsp.readFile(target, 'utf-8'), original, 'Target file must remain untouched');
  });

  test('stale pre-existing backup is not restored when backup creation fails', async () => {
    const target = path.join(tempDir, 'sample.xml');
    const staleBackup = path.join(tempDir, 'sample.xml.bak');
    const original = '<Root>Current Original</Root>';
    const staleContent = '<Root>Stale Content From Previous Session</Root>';
    await fsp.writeFile(target, original, 'utf-8');
    await fsp.writeFile(staleBackup, staleContent, 'utf-8');

    const options: WriteUtf8FileWithBackupOptions = {
      hooks: {
        writeFile: async (filePath, data, enc) => {
          if (filePath !== target && filePath !== staleBackup) {
            throw new Error('Failed to create new backup file');
          }
          await fsp.writeFile(filePath, data, enc);
        },
      },
    };

    await assert.rejects(
      async () => {
        await writeUtf8FileWithBackup(target, original, '<Root>New</Root>', options);
      }
    );

    assert.strictEqual(
      await fsp.readFile(target, 'utf-8'),
      original,
      'Target must NOT be overwritten with stale backup content'
    );
    assert.strictEqual(
      await fsp.readFile(staleBackup, 'utf-8'),
      staleContent,
      'Pre-existing stale backup file must remain as-is'
    );
  });

  test('concurrent operations on same file use distinct backup paths and serialize without collisions', async () => {
    const target = path.join(tempDir, 'sample.xml');
    const original = '<Root>Initial</Root>';
    await fsp.writeFile(target, original, 'utf-8');

    const seenBackupPaths = new Set<string>();
    const createOptions = (): WriteUtf8FileWithBackupOptions => ({
      hooks: {
        writeFile: async (filePath, data, enc) => {
          if (filePath.includes('.bak')) {
            seenBackupPaths.add(filePath);
          }
          await fsp.writeFile(filePath, data, enc);
        },
      },
    });

    // Run two concurrent writes
    const op1 = writeUtf8FileWithBackup(target, original, '<Root>Version1</Root>', createOptions());
    const op2 = writeUtf8FileWithBackup(target, '<Root>Version1</Root>', '<Root>Version2</Root>', createOptions());

    await Promise.all([op1, op2]);

    assert.strictEqual(await fsp.readFile(target, 'utf-8'), '<Root>Version2</Root>');
    assert.strictEqual(seenBackupPaths.size, 2, 'Each operation must use its own distinct backup path');
  });

  test('XMLWriter integration: updateProperty preserves recoverable backup on write and rollback failure', async () => {
    const target = path.join(tempDir, 'Catalog.xml');
    const xmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.17">
  <Catalog uuid="11111111-1111-1111-1111-111111111111">
    <Properties>
      <Name>Products</Name>
      <Comment>Original Comment</Comment>
    </Properties>
  </Catalog>
</MetaDataObject>`;
    await fsp.writeFile(target, xmlContent, 'utf-8');

    // Monkey-patch fs.promises.writeFile to simulate write + rollback failure specifically on target
    const originalWriteFile = fs.promises.writeFile;
    let targetWrites = 0;
    (fs.promises as any).writeFile = async (filePath: string, data: any, enc: any) => {
      if (path.resolve(filePath) === path.resolve(target)) {
        targetWrites++;
        // Write corrupted content, then fail both initial write and rollback
        await originalWriteFile.call(fs.promises, filePath, 'corrupted xml', enc);
        throw new Error('Injected failure during XMLWriter target update');
      }
      return originalWriteFile.call(fs.promises, filePath, data, enc);
    };

    try {
      await assert.rejects(
        async () => {
          await XMLWriter.updateProperty(target, 'Comment', 'New Comment');
        },
        /Injected failure during XMLWriter target update/
      );

      const files = await fsp.readdir(tempDir);
      const backupFiles = files.filter((f) => f.includes('.bak'));
      assert.ok(
        backupFiles.length > 0,
        `XMLWriter must leave intact backup when write & rollback fail. Found files: ${JSON.stringify(files)}`
      );
      const backupPath = path.join(tempDir, backupFiles[0]);
      const content = await fsp.readFile(backupPath, 'utf-8');
      assert.ok(content.includes('Original Comment'), 'Backup must contain original XML content');
    } finally {
      (fs.promises as any).writeFile = originalWriteFile;
    }
  });
});
