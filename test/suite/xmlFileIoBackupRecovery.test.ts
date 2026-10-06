import * as assert from 'assert';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  writeUtf8FileWithBackup,
  type WriteUtf8FileWithBackupOptions,
  type WriteUtf8BackupHooks,
  XmlWriteRollbackError,
} from '../../src/utils/xml/xmlFileIo';
import { XMLWriter } from '../../src/utils/XMLWriter';
import { configurationPathKey } from '../../src/utils/configurationPathIdentity';

suite('xmlFileIo: writeUtf8FileWithBackup & Backup Preservation', () => {
  let tempDir: string;
  let originalWriteFile: typeof fs.promises.writeFile | undefined;

  setup(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xml-file-io-backup-'));
    originalWriteFile = undefined;
  });

  teardown(async () => {
    if (originalWriteFile) {
      fs.promises.writeFile = originalWriteFile;
      originalWriteFile = undefined;
    }
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
        assert.ok(
          /Unable to write to file/.test(err.message) && /Disk full during target write/.test(err.message),
          `Expected both error prefix and original cause, got: ${err.message}`
        );
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

    let caughtError: unknown;
    try {
      await writeUtf8FileWithBackup(target, original, updated, options);
    } catch (err) {
      caughtError = err;
    }

    assert.ok(caughtError, 'Expected writeUtf8FileWithBackup to reject on failure');
    assert.strictEqual(await fsp.readFile(target, 'utf-8'), 'partial', 'Target is in partial state');

    // Find any backup files in tempDir
    const files = await fsp.readdir(tempDir);
    const backupFiles = files.filter((f) => f.includes('.bak'));
    assert.strictEqual(backupFiles.length, 1, `Exactly one backup file must remain on disk, got: ${JSON.stringify(files)}`);

    const preservedBackupPath = path.join(tempDir, backupFiles[0]);
    const preservedContent = await fsp.readFile(preservedBackupPath, 'utf-8');
    assert.strictEqual(preservedContent, original, 'Preserved backup must contain intact original content');

    assert.ok(caughtError instanceof XmlWriteRollbackError, 'Caught error must be an instance of XmlWriteRollbackError');
    assert.strictEqual(caughtError.backupPath, preservedBackupPath, 'backupPath on error must match preserved backup file');
    assert.ok(caughtError.message.includes(preservedBackupPath), `Error message must explicitly mention preserved backup path: ${caughtError.message}`);
    assert.ok(caughtError.writeError, 'Must preserve writeError');
    assert.ok(caughtError.rollbackError, 'Must preserve rollbackError');
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

  test('stale pre-existing backup is preserved and not touched when fresh write and rollback occur', async () => {
    const target = path.join(tempDir, 'sample.xml');
    const staleBackup = path.join(tempDir, 'sample.xml.bak');
    const original = '<Root>Current Original</Root>';
    const staleContent = '<Root>Stale Content From Previous Session</Root>';
    await fsp.writeFile(target, original, 'utf-8');
    await fsp.writeFile(staleBackup, staleContent, 'utf-8');

    let targetWriteCount = 0;
    const options: WriteUtf8FileWithBackupOptions = {
      hooks: {
        writeFile: async (filePath, data, enc) => {
          if (path.resolve(filePath) === path.resolve(target)) {
            targetWriteCount++;
            if (targetWriteCount === 1) {
              throw new Error('Target write failure during test');
            }
          }
          await fsp.writeFile(filePath, data, enc);
        },
      },
    };

    await assert.rejects(
      async () => {
        await writeUtf8FileWithBackup(target, original, '<Root>New</Root>', options);
      },
      /Target write failure during test/
    );

    assert.strictEqual(
      await fsp.readFile(target, 'utf-8'),
      original,
      'Target must be restored to current original content via rollback'
    );
    assert.strictEqual(
      await fsp.readFile(staleBackup, 'utf-8'),
      staleContent,
      'Pre-existing stale backup file must remain intact and not overwritten'
    );

    const files = await fsp.readdir(tempDir);
    assert.deepStrictEqual(
      files.sort(),
      ['sample.xml', 'sample.xml.bak'].sort(),
      'Temporary unique backup file must be removed after successful rollback, leaving only stale backup'
    );
  });

  test('concurrent operations on same file are strictly serialized by file lock', async () => {
    const target = path.join(tempDir, 'serialized.xml');
    await fsp.writeFile(target, '<Root>0</Root>', 'utf-8');

    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const events: string[] = [];

    const hooksOp1: WriteUtf8BackupHooks = {
      writeFile: async (filePath, data, enc) => {
        if (path.resolve(filePath) === path.resolve(target)) {
          events.push('op1:target:start');
          await gate;
          events.push('op1:target:done');
        }
        await fsp.writeFile(filePath, data, enc);
      },
    };

    const hooksOp2: WriteUtf8BackupHooks = {
      writeFile: async (filePath, data, enc) => {
        if (filePath.includes('.bak')) {
          events.push('op2:backup');
        }
        await fsp.writeFile(filePath, data, enc);
      },
    };

    const op1 = writeUtf8FileWithBackup(target, '<Root>0</Root>', '<Root>1</Root>', { hooks: hooksOp1 });
    // Let op1 run until it enters target write and waits on gate
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(events.includes('op1:target:start'), 'op1 must have started target write');

    const op2 = writeUtf8FileWithBackup(target, '<Root>1</Root>', '<Root>2</Root>', { hooks: hooksOp2 });
    await new Promise((r) => setTimeout(r, 30));

    // op2 must be blocked on the lock and NOT have started writing backup yet!
    assert.ok(!events.includes('op2:backup'), 'op2 must wait for op1 to finish before acquiring lock');

    releaseFirst();
    await Promise.all([op1, op2]);

    assert.strictEqual(await fsp.readFile(target, 'utf-8'), '<Root>2</Root>');
  });

  test('file lock serializes writes across case-insensitive path variants on Windows', async () => {
    const target = path.join(tempDir, 'case-serialized.xml');
    await fsp.writeFile(target, '<Root>0</Root>', 'utf-8');

    // On Windows, drive letter and path casing can differ while targeting the same file
    const targetVariant = process.platform === 'win32'
      ? (/^[a-zA-Z]:/.test(target)
          ? (target[0].toLowerCase() === target[0] ? target[0].toUpperCase() : target[0].toLowerCase()) + target.slice(1)
          : target.toUpperCase())
      : target;

    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const events: string[] = [];

    const hooksOp1: WriteUtf8BackupHooks = {
      writeFile: async (filePath, data, enc) => {
        if (configurationPathKey(filePath) === configurationPathKey(target)) {
          events.push('op1:target:start');
          await gate;
          events.push('op1:target:done');
        }
        await fsp.writeFile(filePath, data, enc);
      },
    };

    const hooksOp2: WriteUtf8BackupHooks = {
      writeFile: async (filePath, data, enc) => {
        if (filePath.includes('.bak')) {
          events.push('op2:backup');
        }
        await fsp.writeFile(filePath, data, enc);
      },
    };

    const op1 = writeUtf8FileWithBackup(target, '<Root>0</Root>', '<Root>1</Root>', { hooks: hooksOp1 });
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(events.includes('op1:target:start'), 'op1 must have started target write');

    // op2 is called with targetVariant (e.g. c:\ instead of C:\)
    const op2 = writeUtf8FileWithBackup(targetVariant, '<Root>1</Root>', '<Root>2</Root>', { hooks: hooksOp2 });
    await new Promise((r) => setTimeout(r, 30));

    // op2 MUST be blocked by file lock on Windows even though targetVariant has different casing!
    if (process.platform === 'win32') {
      assert.ok(!events.includes('op2:backup'), 'op2 with different path casing must wait for op1 file lock on Windows');
    }

    releaseFirst();
    await Promise.all([op1, op2]);

    assert.strictEqual(await fsp.readFile(target, 'utf-8'), '<Root>2</Root>');
  });

  test('file lock is released on error path allowing subsequent writes to same file', async () => {
    const target = path.join(tempDir, 'lock-release.xml');
    await fsp.writeFile(target, '<Root>Initial</Root>', 'utf-8');

    let shouldFail = true;
    const options: WriteUtf8FileWithBackupOptions = {
      hooks: {
        writeFile: async (filePath, data, enc) => {
          if (shouldFail && path.resolve(filePath) === path.resolve(target)) {
            throw new Error('Injected failure to trigger error path');
          }
          await fsp.writeFile(filePath, data, enc);
        },
      },
    };

    // First write fails
    await assert.rejects(
      async () => {
        await writeUtf8FileWithBackup(target, '<Root>Initial</Root>', '<Root>Fail</Root>', options);
      },
      /Injected failure to trigger error path/
    );

    // Second write to the SAME file must succeed without hanging or deadlocking
    shouldFail = false;
    await writeUtf8FileWithBackup(target, '<Root>Initial</Root>', '<Root>Success</Root>', options);

    assert.strictEqual(await fsp.readFile(target, 'utf-8'), '<Root>Success</Root>');
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

    originalWriteFile = fs.promises.writeFile;
    let targetWrites = 0;
    fs.promises.writeFile = (async (filePath: string, data: any, enc: any) => {
      if (path.resolve(filePath) === path.resolve(target)) {
        targetWrites++;
        // Write corrupted content, then fail both initial write and rollback
        await originalWriteFile!.call(fs.promises, filePath, 'corrupted xml', enc);
        throw new Error('Injected failure during XMLWriter target update');
      }
      return originalWriteFile!.call(fs.promises, filePath, data, enc);
    }) as any;

    try {
      await assert.rejects(
        async () => {
          await XMLWriter.updateProperty(target, 'Comment', 'New Comment');
        },
        /Injected failure during XMLWriter target update/
      );

      const files = await fsp.readdir(tempDir);
      const backupFiles = files.filter((f) => f.includes('.bak'));
      assert.strictEqual(
        backupFiles.length,
        1,
        `XMLWriter must leave intact backup when write & rollback fail. Found files: ${JSON.stringify(files)}`
      );
      const backupPath = path.join(tempDir, backupFiles[0]);
      const content = await fsp.readFile(backupPath, 'utf-8');
      assert.ok(content.includes('Original Comment'), 'Backup must contain original XML content');
    } finally {
      if (originalWriteFile) {
        fs.promises.writeFile = originalWriteFile;
        originalWriteFile = undefined;
      }
    }
  });
});
