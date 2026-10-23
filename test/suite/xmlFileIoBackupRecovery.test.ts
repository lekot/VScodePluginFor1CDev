import * as assert from 'assert';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { writeUtf8FileWithBackup } from '../../src/utils/xml/xmlFileIo';
import { XMLWriter } from '../../src/utils/XMLWriter';
import {
  AtomicFileStorage,
  type AtomicFileHandle,
  type AtomicFileSystem,
} from '../../src/services/configurationSession/atomicFileStorage';
import { MutationReceiptError } from '../../src/services/configurationSession/mutationReceiptError';
import { installDirectConfigurationMutationEngineForTests } from '../helpers/directConfigurationMutationEngine';

function createNodeAtomicFileSystem(
  overrides: Partial<AtomicFileSystem> = {},
): AtomicFileSystem {
  return {
    readFile: (filePath) => fsp.readFile(filePath),
    open: async (filePath, flags) => {
      const handle = await fsp.open(filePath, flags);
      return {
        writeFile: async (data) => { await handle.writeFile(data); },
        sync: () => handle.sync(),
        close: () => handle.close(),
      } satisfies AtomicFileHandle;
    },
    link: (existingPath, newPath) => fsp.link(existingPath, newPath),
    rename: (oldPath, newPath) => fsp.rename(oldPath, newPath),
    rm: (filePath, options) => fsp.rm(filePath, options),
    ...overrides,
  };
}

type MutableReadFile = {
  readFile: (...args: unknown[]) => Promise<unknown>;
};

suite('xmlFileIo: atomic mutation adapter', () => {
  let tempDir: string;
  let restoreTestEngine: (() => void) | undefined;

  setup(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xml-file-io-atomic-'));
    restoreTestEngine = installDirectConfigurationMutationEngineForTests();
  });

  teardown(async () => {
    restoreTestEngine?.();
    restoreTestEngine = undefined;
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  test('compatibility adapter writes through the engine and leaves no backup artifact', async () => {
    const target = path.join(tempDir, 'sample.xml');
    const original = '<Root>Original</Root>';
    const updated = '<Root>Updated</Root>';
    await fsp.writeFile(target, original, 'utf8');

    await writeUtf8FileWithBackup(target, original, updated);

    assert.strictEqual(await fsp.readFile(target, 'utf8'), updated);
    assert.deepStrictEqual(await fsp.readdir(tempDir), ['sample.xml']);
  });

  test('compatibility adapter does not recreate a target deleted after the snapshot', async () => {
    const target = path.join(tempDir, 'sample.xml');
    const original = '<Root>Original</Root>';
    await fsp.writeFile(target, original, 'utf8');
    const mutable = fs.promises as unknown as MutableReadFile;
    const originalReadFile = mutable.readFile;
    let removed = false;
    mutable.readFile = async (...args) => {
      const content = await originalReadFile.apply(fs.promises, args);
      if (!removed && path.resolve(String(args[0])) === path.resolve(target)) {
        removed = true;
        await fsp.rm(target, { force: true });
      }
      return content;
    };

    try {
      await assert.rejects(
        writeUtf8FileWithBackup(target, original, '<Root>Updated</Root>'),
        (error: unknown) => {
          let current = error;
          while (current && typeof current === 'object') {
            if ('code' in current && ['STALE_TARGET_REVISION', 'STALE_TARGET_HASH'].includes(String(current.code))) {
              return true;
            }
            current = 'cause' in current ? current.cause : undefined;
          }
          return false;
        },
      );
      assert.ok(removed, 'The test must delete the target after the engine read its bytes');
      await assert.rejects(fsp.readFile(target), { code: 'ENOENT' });
    } finally {
      mutable.readFile = originalReadFile;
    }
  });

  test('temp-write failure preserves a foreign edit and leaves the old target whole', async () => {
    const target = path.join(tempDir, 'sample.xml');
    const original = '<Root>Original</Root>';
    const foreign = '<Foreign>writer</Foreign>';
    await fsp.writeFile(target, original, 'utf8');
    let injected = false;
    const fileSystem = createNodeAtomicFileSystem({
      open: async (filePath, flags) => {
        const handle = await fsp.open(filePath, flags);
        return {
          writeFile: async (data) => {
            if (!injected && path.basename(filePath).startsWith('.cdt-')) {
              injected = true;
              await fsp.writeFile(target, foreign, 'utf8');
              throw new Error('injected atomic temp write failure');
            }
            await handle.writeFile(data);
          },
          sync: () => handle.sync(),
          close: () => handle.close(),
        };
      },
    });
    const restore = installDirectConfigurationMutationEngineForTests(fileSystem);
    try {
      await assert.rejects(
        writeUtf8FileWithBackup(target, original, '<Root>Updated</Root>'),
        (error: unknown) => error instanceof MutationReceiptError
          && ['rolledBack', 'recoveryRequired', 'inDoubt'].includes(error.status),
      );
      assert.ok(injected, 'The failure must occur in the active atomic temp-file writer');
      assert.strictEqual(await fsp.readFile(target, 'utf8'), foreign);
      assert.deepStrictEqual((await fsp.readdir(tempDir)).filter((name) => name.startsWith('.cdt-')), []);
    } finally {
      restore();
    }
  });

  test('same-path writers serialize against their expected snapshots', async () => {
    const target = path.join(tempDir, 'serialized.xml');
    await fsp.writeFile(target, '<Root>0</Root>', 'utf8');
    let releaseFirst!: () => void;
    let signalFirstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>((resolve) => { signalFirstStarted = resolve; });
    let tempWrites = 0;
    const fileSystem = createNodeAtomicFileSystem({
      open: async (filePath, flags) => {
        const handle = await fsp.open(filePath, flags);
        return {
          writeFile: async (data) => {
            if (path.basename(filePath).startsWith('.cdt-') && tempWrites++ === 0) {
              signalFirstStarted();
              await firstGate;
            }
            await handle.writeFile(data);
          },
          sync: () => handle.sync(),
          close: () => handle.close(),
        };
      },
    });
    const restore = installDirectConfigurationMutationEngineForTests(fileSystem);
    try {
      const first = writeUtf8FileWithBackup(target, '<Root>0</Root>', '<Root>1</Root>');
      await firstStarted;
      const second = writeUtf8FileWithBackup(target, '<Root>1</Root>', '<Root>2</Root>');
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.strictEqual(tempWrites, 1, 'Second writer must wait behind the active path lease');
      releaseFirst();
      await Promise.all([first, second]);
      assert.strictEqual(await fsp.readFile(target, 'utf8'), '<Root>2</Root>');
    } finally {
      releaseFirst();
      restore();
    }
  });

  test('Windows case aliases share the same mutation lease', async () => {
    const target = path.join(tempDir, 'case-serialized.xml');
    await fsp.writeFile(target, '<Root>0</Root>', 'utf8');
    const alias = process.platform === 'win32'
      ? (target[0] === target[0].toLowerCase() ? target[0].toUpperCase() : target[0].toLowerCase()) + target.slice(1)
      : target;
    let releaseFirst!: () => void;
    let signalFirstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>((resolve) => { signalFirstStarted = resolve; });
    let tempWrites = 0;
    const fileSystem = createNodeAtomicFileSystem({
      open: async (filePath, flags) => {
        const handle = await fsp.open(filePath, flags);
        return {
          writeFile: async (data) => {
            if (path.basename(filePath).startsWith('.cdt-') && tempWrites++ === 0) {
              signalFirstStarted();
              await firstGate;
            }
            await handle.writeFile(data);
          },
          sync: () => handle.sync(),
          close: () => handle.close(),
        };
      },
    });
    const restore = installDirectConfigurationMutationEngineForTests(fileSystem);
    try {
      const first = writeUtf8FileWithBackup(target, '<Root>0</Root>', '<Root>1</Root>');
      await firstStarted;
      const second = writeUtf8FileWithBackup(alias, '<Root>1</Root>', '<Root>2</Root>');
      await new Promise((resolve) => setTimeout(resolve, 30));
      if (process.platform === 'win32') {
        assert.strictEqual(tempWrites, 1, 'Different casing must not bypass the active path lease');
      }
      releaseFirst();
      await Promise.all([first, second]);
      assert.strictEqual(await fsp.readFile(target, 'utf8'), '<Root>2</Root>');
    } finally {
      releaseFirst();
      restore();
    }
  });

  test('mutation lease is released after a failed temp write so a retry can succeed', async () => {
    const target = path.join(tempDir, 'retry.xml');
    const original = '<Root>Initial</Root>';
    await fsp.writeFile(target, original, 'utf8');
    let shouldFail = true;
    const fileSystem = createNodeAtomicFileSystem({
      open: async (filePath, flags) => {
        const handle = await fsp.open(filePath, flags);
        return {
          writeFile: async (data) => {
            if (shouldFail && path.basename(filePath).startsWith('.cdt-')) {
              shouldFail = false;
              throw new Error('injected temp write failure');
            }
            await handle.writeFile(data);
          },
          sync: () => handle.sync(),
          close: () => handle.close(),
        };
      },
    });
    const restore = installDirectConfigurationMutationEngineForTests(fileSystem);
    try {
      await assert.rejects(writeUtf8FileWithBackup(target, original, '<Root>Failed</Root>'));
      await writeUtf8FileWithBackup(target, original, '<Root>Retry</Root>');
      assert.strictEqual(await fsp.readFile(target, 'utf8'), '<Root>Retry</Root>');
    } finally {
      restore();
    }
  });

  test('XMLWriter preserves the source when the engine reports an atomic replacement failure', async () => {
    const target = path.join(tempDir, 'Catalog.xml');
    const xmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.17">
  <Catalog uuid="11111111-1111-1111-1111-111111111111">
    <Properties><Name>Products</Name><Comment>Original Comment</Comment></Properties>
  </Catalog>
</MetaDataObject>`;
    await fsp.writeFile(target, xmlContent, 'utf8');
    const originalReplace = AtomicFileStorage.prototype.replace;
    AtomicFileStorage.prototype.replace = async () => ({
      status: 'rolledBack',
      code: 'WRITE_FAILED',
      message: 'Injected failure during XMLWriter atomic replace',
    });

    try {
      await assert.rejects(
        XMLWriter.updateProperty(target, 'Comment', 'New Comment'),
        /Injected failure during XMLWriter atomic replace/,
      );
      assert.strictEqual(await fsp.readFile(target, 'utf8'), xmlContent);
      assert.deepStrictEqual(
        (await fsp.readdir(tempDir)).filter((name) => name.includes('.bak') || name.startsWith('.cdt-')),
        [],
      );
    } finally {
      AtomicFileStorage.prototype.replace = originalReplace;
    }
  });
});
