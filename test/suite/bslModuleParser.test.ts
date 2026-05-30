/**
 * Tests for bslModuleParser — extraction of procedure/function names from BSL module text.
 *
 * The parser reads a .bsl file and returns BslProcedureInfo[] with name + 1-based line number.
 * Shared parser matches Russian and English procedure/function keywords.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { parseBslModuleProcedures } from '../../src/formEditor/bslModuleParser';
import { createTempDir, cleanupTempDir } from '../helpers/testHelpers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function writeBsl(dir: string, content: string): Promise<string> {
  const filePath = path.join(dir, 'Module.bsl');
  await fs.promises.writeFile(filePath, content, 'utf-8');
  return filePath;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('bslModuleParser — parseBslModuleProcedures', () => {
  let tmpDir: string;

  setup(async () => {
    tmpDir = await createTempDir('bslmoduleparser-');
  });

  teardown(async () => {
    await cleanupTempDir(tmpDir);
  });

  // -------------------------------------------------------------------------
  // Basic extraction
  // -------------------------------------------------------------------------

  test('returns empty array for empty module', async () => {
    const filePath = await writeBsl(tmpDir, '');
    const result = await parseBslModuleProcedures(filePath);
    assert.deepStrictEqual(result, []);
  });

  test('extracts single procedure', async () => {
    const bsl = `Процедура ПриОткрытии(Отказ)
  // body
КонецПроцедуры`;
    const filePath = await writeBsl(tmpDir, bsl);
    const result = await parseBslModuleProcedures(filePath);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, 'ПриОткрытии');
    assert.strictEqual(result[0].line, 1);
  });

  test('extracts procedure name from partially typed declaration', async () => {
    const bsl = `Процедура ПриЗаписи(
  Отказ = Истина;`;
    const filePath = await writeBsl(tmpDir, bsl);
    const result = await parseBslModuleProcedures(filePath);
    assert.deepStrictEqual(result, [{ name: 'ПриЗаписи', line: 1 }]);
  });

  test('extracts single function', async () => {
    const bsl = `Функция ПолучитьДанные()
  Возврат Неопределено;
КонецФункции`;
    const filePath = await writeBsl(tmpDir, bsl);
    const result = await parseBslModuleProcedures(filePath);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, 'ПолучитьДанные');
    assert.strictEqual(result[0].line, 1);
  });

  test('extracts multiple procedures and functions', async () => {
    const bsl = `Процедура ПриОткрытии(Отказ)
  // body
КонецПроцедуры

Функция ПолучитьДанные()
  Возврат Неопределено;
КонецФункции

Процедура СохранитьДанные()
  // body
КонецПроцедуры`;
    const filePath = await writeBsl(tmpDir, bsl);
    const result = await parseBslModuleProcedures(filePath);
    assert.strictEqual(result.length, 3);
    assert.strictEqual(result[0].name, 'ПриОткрытии');
    assert.strictEqual(result[0].line, 1);
    assert.strictEqual(result[1].name, 'ПолучитьДанные');
    assert.strictEqual(result[1].line, 5);
    assert.strictEqual(result[2].name, 'СохранитьДанные');
    assert.strictEqual(result[2].line, 9);
  });

  // -------------------------------------------------------------------------
  // Line numbers
  // -------------------------------------------------------------------------

  test('reports correct 1-based line numbers', async () => {
    const bsl = `// File header comment
// Second comment line

Процедура Первая()
КонецПроцедуры

Функция Вторая()
КонецФункции`;
    const filePath = await writeBsl(tmpDir, bsl);
    const result = await parseBslModuleProcedures(filePath);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].line, 4);
    assert.strictEqual(result[1].line, 7);
  });

  // -------------------------------------------------------------------------
  // Leading whitespace (indentation)
  // -------------------------------------------------------------------------

  test('matches procedure with leading whitespace (indented)', async () => {
    const bsl = `  Процедура Отступ(Параметр)
  КонецПроцедуры`;
    const filePath = await writeBsl(tmpDir, bsl);
    const result = await parseBslModuleProcedures(filePath);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, 'Отступ');
  });

  // -------------------------------------------------------------------------
  // Case insensitivity
  // -------------------------------------------------------------------------

  test('matches ПРОЦЕДУРА in uppercase', async () => {
    const bsl = `ПРОЦЕДУРА ВерхнийРегистр()
КонецПроцедуры`;
    const filePath = await writeBsl(tmpDir, bsl);
    const result = await parseBslModuleProcedures(filePath);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, 'ВерхнийРегистр');
  });

  test('matches функция in lowercase', async () => {
    const bsl = `функция нижнийРегистр()
КонецФункции`;
    const filePath = await writeBsl(tmpDir, bsl);
    const result = await parseBslModuleProcedures(filePath);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, 'нижнийРегистр');
  });

  // -------------------------------------------------------------------------
  // Export keyword
  // -------------------------------------------------------------------------

  test('extracts name when procedure declared with Экспорт', async () => {
    // "Экспорт" comes after the closing paren, not on the same token as the name
    // The regex captures name before "(" so Экспорт on the same line does not affect capture
    const bsl = `Процедура ПубличныйМетод() Экспорт
  // body
КонецПроцедуры`;
    const filePath = await writeBsl(tmpDir, bsl);
    const result = await parseBslModuleProcedures(filePath);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, 'ПубличныйМетод');
  });

  test('extracts name when function declared with Экспорт', async () => {
    const bsl = `Функция ПубличнаяФункция(Параметр1, Параметр2) Экспорт
  Возврат Параметр1;
КонецФункции`;
    const filePath = await writeBsl(tmpDir, bsl);
    const result = await parseBslModuleProcedures(filePath);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, 'ПубличнаяФункция');
  });

  // -------------------------------------------------------------------------
  // Compiler directives (&НаКлиенте, &НаСервере, etc.)
  // -------------------------------------------------------------------------

  test('directive on preceding line does not affect extraction', async () => {
    const bsl = `&НаКлиенте
Процедура КлиентскаяПроцедура()
КонецПроцедуры

&НаСервере
Функция СерверноеЧтение()
  Возврат 1;
КонецФункции`;
    const filePath = await writeBsl(tmpDir, bsl);
    const result = await parseBslModuleProcedures(filePath);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].name, 'КлиентскаяПроцедура');
    assert.strictEqual(result[0].line, 2);
    assert.strictEqual(result[1].name, 'СерверноеЧтение');
    assert.strictEqual(result[1].line, 6);
  });

  // -------------------------------------------------------------------------
  // Comments — keywords in comments must NOT be extracted
  // -------------------------------------------------------------------------

  test('ignores keywords inside line comments', async () => {
    // Comment lines do not start with Процедура/Функция
    const bsl = `// Процедура это не объявление
// Функция тоже не объявление
Процедура Настоящая()
КонецПроцедуры`;
    const filePath = await writeBsl(tmpDir, bsl);
    const result = await parseBslModuleProcedures(filePath);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, 'Настоящая');
  });

  // -------------------------------------------------------------------------
  // String literals — keywords inside strings must NOT be extracted
  // -------------------------------------------------------------------------

  test('ignores keywords inside string literals on assignment lines', async () => {
    // Lines with string literals don't start with Процедура/Функция
    const bsl = `Процедура Обёртка()
  Текст = "Процедура СтрокаВнутри()";
  Текст2 = "Функция ТожеСтрока()";
КонецПроцедуры`;
    const filePath = await writeBsl(tmpDir, bsl);
    const result = await parseBslModuleProcedures(filePath);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, 'Обёртка');
  });

  // -------------------------------------------------------------------------
  // English keywords
  // -------------------------------------------------------------------------

  test('matches English keyword Procedure', async () => {
    const bsl = `Procedure EnglishProc()
EndProcedure`;
    const filePath = await writeBsl(tmpDir, bsl);
    const result = await parseBslModuleProcedures(filePath);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, 'EnglishProc');
    assert.strictEqual(result[0].line, 1);
  });

  test('matches English keyword Function', async () => {
    const bsl = `Function EnglishFunc()
  Return Undefined;
EndFunction`;
    const filePath = await writeBsl(tmpDir, bsl);
    const result = await parseBslModuleProcedures(filePath);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, 'EnglishFunc');
    assert.strictEqual(result[0].line, 1);
  });

  // -------------------------------------------------------------------------
  // Mixed: Russian and English in same file
  // -------------------------------------------------------------------------

  test('extracts Russian and English declarations in mixed file', async () => {
    const bsl = `Процедура РусскаяПроцедура()
КонецПроцедуры

Procedure EnglishProc()
EndProcedure

Функция РусскаяФункция()
  Возврат 0;
КонецФункции`;
    const filePath = await writeBsl(tmpDir, bsl);
    const result = await parseBslModuleProcedures(filePath);
    assert.strictEqual(result.length, 3);
    assert.strictEqual(result[0].name, 'РусскаяПроцедура');
    assert.strictEqual(result[1].name, 'EnglishProc');
    assert.strictEqual(result[2].name, 'РусскаяФункция');
  });

  // -------------------------------------------------------------------------
  // Parameters
  // -------------------------------------------------------------------------

  test('extracts name when procedure has multiple parameters', async () => {
    const bsl = `Процедура МногоПараметров(Param1, Param2, Param3 = Неопределено)
КонецПроцедуры`;
    const filePath = await writeBsl(tmpDir, bsl);
    const result = await parseBslModuleProcedures(filePath);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, 'МногоПараметров');
  });

  // -------------------------------------------------------------------------
  // CRLF vs LF line endings
  // -------------------------------------------------------------------------

  test('handles CRLF line endings', async () => {
    const bsl = 'Процедура Первая()\r\nКонецПроцедуры\r\n\r\nФункция Вторая()\r\nКонецФункции';
    const filePath = await writeBsl(tmpDir, bsl);
    const result = await parseBslModuleProcedures(filePath);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].name, 'Первая');
    assert.strictEqual(result[0].line, 1);
    assert.strictEqual(result[1].name, 'Вторая');
    assert.strictEqual(result[1].line, 4);
  });

  // -------------------------------------------------------------------------
  // Non-existent file
  // -------------------------------------------------------------------------

  test('returns empty array for non-existent file', async () => {
    const filePath = path.join(tmpDir, 'does-not-exist.bsl');
    const result = await parseBslModuleProcedures(filePath);
    assert.deepStrictEqual(result, []);
  });

  // -------------------------------------------------------------------------
  // Large module
  // -------------------------------------------------------------------------

  test('extracts all names from large module with many procedures', async () => {
    const names = Array.from({ length: 20 }, (_, i) => `Процедура${i + 1}`);
    const lines: string[] = [];
    for (const name of names) {
      lines.push(`Процедура ${name}()`);
      lines.push(`КонецПроцедуры`);
      lines.push('');
    }
    const bsl = lines.join('\n');
    const filePath = await writeBsl(tmpDir, bsl);
    const result = await parseBslModuleProcedures(filePath);
    assert.strictEqual(result.length, 20);
    for (let i = 0; i < 20; i++) {
      assert.strictEqual(result[i].name, names[i]);
    }
  });
});
