/**
 * Tests for formEventHandlerCreator — appending BSL procedure stubs to module files.
 *
 * Uses fs/path/os for temp files. No vscode dependency.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHandlerInModule } from '../../src/formEditor/formEventHandlerCreator';
import {
  ConfigurationMutationEngine,
  getConfigurationMutationEngine,
  setConfigurationMutationEngine,
} from '../../src/services/configurationSession/ConfigurationMutationEngine';
import { MutationReceiptError } from '../../src/services/configurationSession/mutationReceiptError';
import type { AtomicFileSystem } from '../../src/services/configurationSession/atomicFileStorage';
import { installDirectConfigurationMutationEngineForTests } from '../helpers/directConfigurationMutationEngine';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uniqueTmp(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.bsl`);
}

function createAtomicFileSystem(overrides: Partial<AtomicFileSystem> = {}): AtomicFileSystem {
  return {
    readFile: (filePath) => fs.promises.readFile(filePath),
    open: async (filePath, flags) => {
      const handle = await fs.promises.open(filePath, flags);
      return {
        writeFile: async (data) => { await handle.writeFile(data); },
        sync: () => handle.sync(),
        close: () => handle.close(),
      };
    },
    link: (existingPath, newPath) => fs.promises.link(existingPath, newPath),
    rename: (oldPath, newPath) => fs.promises.rename(oldPath, newPath),
    rm: (filePath, options) => fs.promises.rm(filePath, options),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('formEventHandlerCreator — createHandlerInModule', () => {
  const tempFiles: string[] = [];
  let restoreTestEngine: (() => void) | undefined;

  suiteSetup(() => {
    restoreTestEngine = installDirectConfigurationMutationEngineForTests();
  });

  suiteTeardown(async () => {
    restoreTestEngine?.();
    for (const f of tempFiles) {
      try { await fs.promises.unlink(f); } catch { /* ignore */ }
    }
  });

  // -------------------------------------------------------------------------
  // New file creation
  // -------------------------------------------------------------------------

  test('creates new file with BOM, procedure declaration, КонецПроцедуры; returns line > 0', async () => {
    const filePath = uniqueTmp('handler-new');
    tempFiles.push(filePath);

    const result = await createHandlerInModule(filePath, 'ПриОткрытии', 'OnOpen', true);

    assert.ok(fs.existsSync(filePath), 'file must be created');
    const content = await fs.promises.readFile(filePath, { encoding: 'utf8' });
    assert.ok(content.startsWith('\uFEFF'), 'file must start with BOM');
    assert.ok(content.includes('Процедура ПриОткрытии(Отказ)'), 'must contain procedure declaration with params');
    assert.ok(content.includes('КонецПроцедуры'), 'must contain КонецПроцедуры');
    assert.ok(result.line > 0, 'returned line number must be > 0');
  });

  // -------------------------------------------------------------------------
  // Append to existing file
  // -------------------------------------------------------------------------

  test('appends procedure to existing file; original content preserved; line > original line count', async () => {
    const filePath = uniqueTmp('handler-append');
    tempFiles.push(filePath);

    const initialContent = '\uFEFF\r\n// existing module content\r\n';
    await fs.promises.writeFile(filePath, initialContent, { encoding: 'utf8' });
    const originalLineCount = initialContent.split(/\r?\n/).length;

    const result = await createHandlerInModule(filePath, 'КонтрагентПриИзменении', 'OnChange', false);

    const content = await fs.promises.readFile(filePath, { encoding: 'utf8' });
    assert.ok(content.includes('// existing module content'), 'original content must be preserved');
    assert.ok(content.includes('Процедура КонтрагентПриИзменении(Элемент)'), 'new procedure must be appended with params');
    assert.ok(result.line > originalLineCount, 'new procedure line must be after original content');
  });

  // -------------------------------------------------------------------------
  // Correct directive in stub
  // -------------------------------------------------------------------------

  test('OnCreateAtServer stub contains &НаСервере directive', async () => {
    const filePath = uniqueTmp('handler-server');
    tempFiles.push(filePath);

    await createHandlerInModule(filePath, 'ПриСозданииНаСервере', 'OnCreateAtServer', true);

    const content = await fs.promises.readFile(filePath, { encoding: 'utf8' });
    assert.ok(content.includes('&НаСервере'), 'must contain &НаСервере for server event');
    assert.ok(!content.includes('&НаКлиенте'), 'must NOT contain &НаКлиенте for server event');
  });

  test('OnChange stub contains &НаКлиенте directive', async () => {
    const filePath = uniqueTmp('handler-client');
    tempFiles.push(filePath);

    await createHandlerInModule(filePath, 'ПриИзменении', 'OnChange', false);

    const content = await fs.promises.readFile(filePath, { encoding: 'utf8' });
    assert.ok(content.includes('&НаКлиенте'), 'must contain &НаКлиенте for client event');
    assert.ok(!content.includes('&НаСервере'), 'must NOT contain &НаСервере for client event');
  });

  // -------------------------------------------------------------------------
  // Two procedures appended
  // -------------------------------------------------------------------------

  test('two sequential calls append two separate procedures', async () => {
    const filePath = uniqueTmp('handler-two');
    tempFiles.push(filePath);

    await createHandlerInModule(filePath, 'ПервыйОбработчик', 'OnOpen', true);
    await createHandlerInModule(filePath, 'ВторойОбработчик', 'OnChange', false);

    const content = await fs.promises.readFile(filePath, { encoding: 'utf8' });
    assert.ok(content.includes('Процедура ПервыйОбработчик('), 'first procedure must be present');
    assert.ok(content.includes('Процедура ВторойОбработчик('), 'second procedure must be present');
  });

  test('builds the stub from admitted module contents and publishes it once after a concurrent edit', async () => {
    const filePath = uniqueTmp('handler-concurrent-edit');
    tempFiles.push(filePath);
    const originalContent = '\uFEFF// base module\r\n';
    const foreignContent = '\uFEFF// base module\r\n// editor update & keep\r\n';
    await fs.promises.writeFile(filePath, originalContent, 'utf8');
    const canonicalFilePath = await fs.promises.realpath(filePath);

    let admitted = 0;
    let editBarrierRan = false;
    let targetPublications = 0;
    let contentAtPublication: string | undefined;
    const renameTargets: string[] = [];
    const injectConcurrentEdit = async () => {
      if (editBarrierRan) {
        return;
      }
      editBarrierRan = true;
      await fs.promises.writeFile(filePath, foreignContent, 'utf8');
    };
    const previousEngine = getConfigurationMutationEngine();
    const engine = new ConfigurationMutationEngine({
      runMutation: async <T>(_resourcePath: string, _kind: string, operation: () => Promise<T>): Promise<T> => {
        admitted++;
        await injectConcurrentEdit();
        return operation();
      },
      fileSystem: createAtomicFileSystem({
        rename: async (oldPath, newPath) => {
          const target = await fs.promises.realpath(newPath).catch(() => path.resolve(newPath));
          renameTargets.push(target);
          if (target.toLocaleLowerCase() === canonicalFilePath.toLocaleLowerCase()) {
            targetPublications++;
            contentAtPublication = await fs.promises.readFile(filePath, 'utf8');
          }
          await fs.promises.rename(oldPath, newPath);
        },
      }),
    });
    setConfigurationMutationEngine(engine);
    const mutableFsPromises = fs.promises as unknown as { readFile: (...args: any[]) => Promise<any> };
    const originalReadFile = mutableFsPromises.readFile;
    mutableFsPromises.readFile = async (...args: any[]) => {
      const content = await originalReadFile.apply(fs.promises, args);
      if (admitted === 0 && path.resolve(String(args[0])) === path.resolve(filePath)) {
        await injectConcurrentEdit();
      }
      return content;
    };

    try {
      const result = await createHandlerInModule(filePath, 'ПриИзмененииПослеПравки', 'OnChange', false);
      const content = await fs.promises.readFile(filePath, 'utf8');
      const handlerLine = content.split(/\r?\n/).findIndex((line) => line.startsWith('Процедура ПриИзмененииПослеПравки(')) + 1;

      assert.deepStrictEqual(
        {
          admitted,
          editBarrierRan,
          exactInputAtPublication: contentAtPublication === foreignContent,
          targetPublications,
          concurrentEditPreserved: content.startsWith(foreignContent),
        },
        {
          admitted: 1,
          editBarrierRan: true,
          exactInputAtPublication: true,
          targetPublications: 1,
          concurrentEditPreserved: true,
        },
        `the admitted creator reads the edited module and commits one atomic append; rename targets=${renameTargets.join(' | ')}`,
      );
      assert.ok(content.includes('&НаКлиенте'));
      assert.ok(content.includes('КонецПроцедуры'));
      assert.ok(handlerLine > 0);
      assert.strictEqual(result.line, handlerLine, 'the reported line points into the committed module content');
    } finally {
      mutableFsPromises.readFile = originalReadFile;
      setConfigurationMutationEngine(previousEngine);
    }
  });

  test('does not report a handler line or change the module when atomic publication fails before commit', async () => {
    const filePath = uniqueTmp('handler-publication-failure');
    tempFiles.push(filePath);
    const initialContent = '\uFEFF// committed module\r\n';
    await fs.promises.writeFile(filePath, initialContent, 'utf8');
    const previousEngine = getConfigurationMutationEngine();
    let publicationFailureInjected = false;
    setConfigurationMutationEngine(new ConfigurationMutationEngine({
      runMutation: async <T>(_resourcePath: string, _kind: string, operation: () => Promise<T>): Promise<T> => operation(),
      fileSystem: createAtomicFileSystem({
        open: async () => {
          publicationFailureInjected = true;
          throw Object.assign(new Error('ENOSPC: temp publication failed'), { code: 'ENOSPC' });
        },
      }),
    }));
    const mutableFsPromises = fs.promises as unknown as { writeFile: (...args: any[]) => Promise<any> };
    const originalWriteFile = mutableFsPromises.writeFile;
    mutableFsPromises.writeFile = async (...args: any[]) => {
      if (path.resolve(String(args[0])) === path.resolve(filePath)) {
        publicationFailureInjected = true;
        throw Object.assign(new Error('ENOSPC: legacy publication failed'), { code: 'ENOSPC' });
      }
      return originalWriteFile.apply(fs.promises, args);
    };

    try {
      let failure: unknown;
      try {
        await createHandlerInModule(filePath, 'НеСохраненныйОбработчик', 'OnOpen', true);
      } catch (error) {
        failure = error;
      }
      assert.deepStrictEqual(
        {
          publicationFailureInjected,
          typedReceipt: failure instanceof MutationReceiptError && failure.code === 'WRITE_FAILED',
        },
        { publicationFailureInjected: true, typedReceipt: true },
        'a failed publication must surface through the existing typed mutation receipt',
      );
      assert.strictEqual(await fs.promises.readFile(filePath, 'utf8'), initialContent,
        'failure before commit leaves the last committed module bytes intact');
    } finally {
      mutableFsPromises.writeFile = originalWriteFile;
      setConfigurationMutationEngine(previousEngine);
    }
  });
});
