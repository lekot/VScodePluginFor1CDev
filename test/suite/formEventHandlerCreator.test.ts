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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uniqueTmp(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.bsl`);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('formEventHandlerCreator — createHandlerInModule', () => {
  const tempFiles: string[] = [];

  suiteTeardown(async () => {
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
});
