import * as assert from 'assert';
import {
  extractBslQuery,
  cleanBslLiteral,
  ExtractedQueryInfo,
} from '../../../src/queryBuilder/editor/bslQueryExtractor';
import {
  generateBslSimpleQuery,
  generateBslQueryWithProcessing,
} from '../../../src/queryBuilder/editor/queryCodeTemplates';
import { parseSdbl } from '../../../src/queryBuilder/sdbl/sdblParser';
import { QueryPackage } from '../../../src/queryBuilder/sdbl/sdblAst';

suite('BSL Query Extractor & Templates', () => {
  suite('1. cleanBslLiteral', () => {
    test('removes outer double quotes from single-line literal', () => {
      const input = '"ВЫБРАТЬ 1 КАК Поле"';
      assert.strictEqual(cleanBslLiteral(input), 'ВЫБРАТЬ 1 КАК Поле');
    });

    test('removes outer quotes and leading pipe characters with indentation', () => {
      const input = [
        '"ВЫБРАТЬ',
        '|\tПоле',
        '|ИЗ',
        '|\tТаблица"',
      ].join('\n');

      const expected = [
        'ВЫБРАТЬ',
        '\tПоле',
        'ИЗ',
        '\tТаблица',
      ].join('\n');

      assert.strictEqual(cleanBslLiteral(input), expected);
    });

    test('handles whitespace/tabs preceding the pipe delimiter', () => {
      const input = [
        '\t"ВЫБРАТЬ',
        '\t|\tПоле1',
        '\t|ИЗ',
        '\t|\tСправочник.Номенклатура"',
      ].join('\n');

      const expected = [
        'ВЫБРАТЬ',
        '\tПоле1',
        'ИЗ',
        '\tСправочник.Номенклатура',
      ].join('\n');

      assert.strictEqual(cleanBslLiteral(input), expected);
    });

    test('unescapes double quotes ("" -> ")', () => {
      const input = '"ВЫБРАТЬ ""Текст"" КАК Поле"';
      assert.strictEqual(cleanBslLiteral(input), 'ВЫБРАТЬ "Текст" КАК Поле');
    });

    test('handles Windows CRLF line breaks', () => {
      const input = '"ВЫБРАТЬ\r\n|\tПоле\r\n|ИЗ\r\n|\tТаблица"';
      const expected = 'ВЫБРАТЬ\n\tПоле\nИЗ\n\tТаблица';
      assert.strictEqual(cleanBslLiteral(input), expected);
    });

    test('handles text without outer quotes or pure SDBL', () => {
      const input = 'ВЫБРАТЬ 1 КАК Поле';
      assert.strictEqual(cleanBslLiteral(input), 'ВЫБРАТЬ 1 КАК Поле');
    });

    test('handles multiline lines starting with pipe without outer quotes', () => {
      const input = 'ВЫБРАТЬ\n|\tПоле\n|ИЗ\n|\tТаблица';
      const expected = 'ВЫБРАТЬ\n\tПоле\nИЗ\n\tТаблица';
      assert.strictEqual(cleanBslLiteral(input), expected);
    });
  });

  suite('2. extractBslQuery: Selection', () => {
    test('extracts query when user selects pure SDBL text', () => {
      const code = [
        '// Префиксный код',
        'ВЫБРАТЬ',
        '\tСсылка',
        'ИЗ',
        '\tСправочник.Номенклатура',
        '// Постфиксный код',
      ].join('\n');

      const sdblStart = code.indexOf('ВЫБРАТЬ');
      const sdblEnd = code.indexOf('// Постфиксный код') - 1;

      const result = extractBslQuery(code, sdblStart, {
        start: sdblStart,
        end: sdblEnd,
      });

      assert.strictEqual(result.isNewQuery, false);
      assert.ok(result.sdblText.startsWith('ВЫБРАТЬ'));
      assert.ok(result.sdblText.includes('Справочник.Номенклатура'));
      assert.strictEqual(result.replaceRange.startOffset, sdblStart);
      assert.strictEqual(result.replaceRange.endOffset, sdblEnd);
    });

    test('extracts query when user selects BSL string literal with pipes', () => {
      const code = [
        'Запрос = Новый Запрос;',
        'Запрос.Текст = "ВЫБРАТЬ',
        '|\tНоменклатура.Ссылка КАК Ссылка',
        '|ИЗ',
        '|\tСправочник.Номенклатура КАК Номенклатура";',
      ].join('\n');

      const litStart = code.indexOf('"ВЫБРАТЬ');
      const litEnd = code.lastIndexOf('"') + 1;

      const result = extractBslQuery(code, litStart, {
        start: litStart,
        end: litEnd,
      });

      assert.strictEqual(result.isNewQuery, false);
      assert.strictEqual(result.variableName, 'Запрос');
      assert.ok(!result.sdblText.includes('|'));
      assert.ok(result.sdblText.includes('Номенклатура.Ссылка КАК Ссылка'));
      assert.strictEqual(result.replaceRange.startOffset, litStart);
      assert.strictEqual(result.replaceRange.endOffset, litEnd);
    });

    test('extracts query for DROP/УНИЧТОЖИТЬ selection', () => {
      const code = 'УНИЧТОЖИТЬ ВременнаяТаблица;';
      const result = extractBslQuery(code, 0, { start: 0, end: code.length - 1 });
      assert.strictEqual(result.isNewQuery, false);
      assert.strictEqual(result.sdblText, 'УНИЧТОЖИТЬ ВременнаяТаблица');
    });

    test('extracts query for SELECT (English) selection', () => {
      const code = 'SELECT Id, Name FROM Catalog_Goods';
      const result = extractBslQuery(code, 0, { start: 0, end: code.length });
      assert.strictEqual(result.isNewQuery, false);
      assert.strictEqual(result.sdblText, 'SELECT Id, Name FROM Catalog_Goods');
    });
  });

  suite('3. extractBslQuery: Cursor inside BSL String Literal', () => {
    test('extracts single-line query when cursor is inside literal', () => {
      const code = 'Запрос.Текст = "ВЫБРАТЬ 1 КАК Поле";';
      const cursorOffset = code.indexOf('Поле');

      const result = extractBslQuery(code, cursorOffset);

      assert.strictEqual(result.isNewQuery, false);
      assert.strictEqual(result.variableName, 'Запрос');
      assert.strictEqual(result.sdblText, 'ВЫБРАТЬ 1 КАК Поле');
      assert.strictEqual(result.rawBslText, '"ВЫБРАТЬ 1 КАК Поле"');
      assert.strictEqual(result.replaceRange.startOffset, code.indexOf('"'));
      assert.strictEqual(result.replaceRange.endOffset, code.lastIndexOf('"') + 1);
    });

    test('extracts multiline query with pipes and escaped quotes when cursor is inside', () => {
      const code = [
        'МойЗапрос = Новый Запрос;',
        'МойЗапрос.Текст = "ВЫБРАТЬ',
        '|\t""Специальный текст"" КАК ТекстПоле,',
        '|\tТовары.Цена КАК Цена',
        '|ИЗ',
        '|\tСправочник.Номенклатура КАК Товары";',
      ].join('\n');

      const cursorOffset = code.indexOf('ТекстПоле');
      const result = extractBslQuery(code, cursorOffset);

      assert.strictEqual(result.isNewQuery, false);
      assert.strictEqual(result.variableName, 'МойЗапрос');
      assert.ok(result.sdblText.includes('"Специальный текст" КАК ТекстПоле'));
      assert.ok(!result.sdblText.includes('""'));
      assert.ok(!result.sdblText.includes('|'));
      assert.strictEqual(result.replaceRange.startOffset, code.indexOf('"ВЫБРАТЬ'));
      assert.strictEqual(result.replaceRange.endOffset, code.lastIndexOf('"') + 1);
    });

    test('detects variableName from Variable.Text = ... (English)', () => {
      const code = 'q.Text = "SELECT 1 AS Num";';
      const result = extractBslQuery(code, code.indexOf('Num'));

      assert.strictEqual(result.isNewQuery, false);
      assert.strictEqual(result.variableName, 'q');
      assert.strictEqual(result.sdblText, 'SELECT 1 AS Num');
    });

    test('detects variableName from Variable = Новый Запрос(...)', () => {
      const code = 'ЗапросОстатков = Новый Запрос("ВЫБРАТЬ Ссылка ИЗ Справочник.Склады");';
      const result = extractBslQuery(code, code.indexOf('Склады'));

      assert.strictEqual(result.isNewQuery, false);
      assert.strictEqual(result.variableName, 'ЗапросОстатков');
      assert.strictEqual(result.sdblText, 'ВЫБРАТЬ Ссылка ИЗ Справочник.Склады');
    });

    test('detects variableName when Variable = Новый Запрос; precedes Variable.Текст =', () => {
      const code = [
        'ЗапросПоВыборке = Новый Запрос;',
        '// Комментарий разработчика',
        'ЗапросПоВыборке.Текст = "ВЫБРАТЬ 100";',
      ].join('\n');

      const result = extractBslQuery(code, code.indexOf('100'));

      assert.strictEqual(result.isNewQuery, false);
      assert.strictEqual(result.variableName, 'ЗапросПоВыборке');
    });
  });

  suite('4. extractBslQuery: Empty Position, Non-Query Strings, and Comments', () => {
    test('returns isNewQuery: true for empty document or empty line', () => {
      const code = '\n\n   \n\n';
      const cursorOffset = 3; // On whitespace line

      const result = extractBslQuery(code, cursorOffset);

      assert.strictEqual(result.isNewQuery, true);
      assert.strictEqual(result.sdblText, '');
      assert.strictEqual(result.rawBslText, '');
      assert.strictEqual(result.replaceRange.startOffset, cursorOffset);
      assert.strictEqual(result.replaceRange.endOffset, cursorOffset);
    });

    test('ignores regular non-query BSL string literals ("Привет, мир!")', () => {
      const code = 'Сообщить("Привет, мир! Это просто строка.");';
      const cursorOffset = code.indexOf('мир');

      const result = extractBslQuery(code, cursorOffset);

      assert.strictEqual(result.isNewQuery, true);
      assert.strictEqual(result.sdblText, '');
      assert.strictEqual(result.rawBslText, '');
      assert.strictEqual(result.replaceRange.startOffset, cursorOffset);
      assert.strictEqual(result.replaceRange.endOffset, cursorOffset);
    });

    test('ignores comments containing query keywords', () => {
      const code = [
        '// ВЫБРАТЬ 1 КАК Поле ИЗ Таблица - это просто комментарий',
        'Значение = 42;',
      ].join('\n');

      const cursorOffset = code.indexOf('Поле');
      const result = extractBslQuery(code, cursorOffset);

      assert.strictEqual(result.isNewQuery, true);
      assert.strictEqual(result.sdblText, '');
      assert.strictEqual(result.rawBslText, '');
    });

    test('ignores quotes inside comments', () => {
      const code = '// "ВЫБРАТЬ Ссылка ИЗ Справочник.Номенклатура"\n';
      const cursorOffset = code.indexOf('Ссылка');

      const result = extractBslQuery(code, cursorOffset);
      assert.strictEqual(result.isNewQuery, true);
    });
  });

  suite('5. extractBslQuery: Line and Column Calculations in replaceRange', () => {
    test('calculates accurate 1-based startLine, startColumn, endLine, endColumn', () => {
      const code = [
        '// Строка 1: комментарий',
        '// Строка 2: ещё комментарий',
        'Запрос.Текст = "ВЫБРАТЬ',
        '|\tПоле1";',
      ].join('\n');

      const litStart = code.indexOf('"ВЫБРАТЬ');
      const litEnd = code.lastIndexOf('"') + 1;

      const result = extractBslQuery(code, litStart + 5);

      assert.strictEqual(result.isNewQuery, false);
      assert.strictEqual(result.replaceRange.startOffset, litStart);
      assert.strictEqual(result.replaceRange.endOffset, litEnd);
      // Line 3: "Запрос.Текст = " has length 15. The quote is at column 16.
      assert.strictEqual(result.replaceRange.startLine, 3);
      assert.strictEqual(result.replaceRange.startColumn, 16);
      // Line 4: "|\tПоле1" has length 8. End offset is after the quote: column 9.
      assert.strictEqual(result.replaceRange.endLine, 4);
      assert.strictEqual(result.replaceRange.endColumn, 9);
    });

    test('calculates accurate replaceRange for empty cursor position', () => {
      const code = 'Строка1\nСтрока2\nСтрока3';
      const offset = code.indexOf('Строка2') + 2; // on 'р' of Строка2 (column 3)

      const result = extractBslQuery(code, offset);

      assert.strictEqual(result.isNewQuery, true);
      assert.strictEqual(result.replaceRange.startLine, 2);
      assert.strictEqual(result.replaceRange.startColumn, 3);
      assert.strictEqual(result.replaceRange.endLine, 2);
      assert.strictEqual(result.replaceRange.endColumn, 3);
    });
  });

  suite('6. queryCodeTemplates: generateBslSimpleQuery', () => {
    test('generates BSL literal from string with pipe prefix', () => {
      const sdbl = 'ВЫБРАТЬ\n\tПоле\nИЗ\n\tТаблица';
      const bsl = generateBslSimpleQuery(sdbl);
      assert.strictEqual(bsl, '"ВЫБРАТЬ\n|\tПоле\n|ИЗ\n|\tТаблица"');
    });

    test('generates BSL literal from QueryPackage AST', () => {
      const sdbl = 'ВЫБРАТЬ Поле1 КАК Поле ИЗ Справочник.Номенклатура';
      const pkg = parseSdbl(sdbl);
      const bsl = generateBslSimpleQuery(pkg);
      assert.ok(bsl.startsWith('"ВЫБРАТЬ'));
      assert.ok(bsl.includes('|\tПоле1 КАК Поле'));
      assert.ok(bsl.endsWith('"'));
    });
  });

  suite('7. queryCodeTemplates: generateBslQueryWithProcessing', () => {
    test('generates processing skeleton for simple query with parameters', () => {
      const sdbl = [
        'ВЫБРАТЬ',
        '	Номенклатура.Ссылка КАК Номенклатура,',
        '	Номенклатура.Артикул КАК Артикул',
        'ИЗ',
        '	Справочник.Номенклатура КАК Номенклатура',
        'ГДЕ',
        '	Номенклатура.ПометкаУдаления = &ПометкаУдаления',
        '	И Номенклатура.Родитель = &Родитель',
      ].join('\n');

      const pkg = parseSdbl(sdbl);
      const code = generateBslQueryWithProcessing(pkg);

      // 1. Creation and text assignment
      assert.ok(code.includes('Запрос = Новый Запрос;'));
      assert.ok(code.includes('Запрос.Текст ='));

      // 2. Setting parameters
      assert.ok(code.includes('Запрос.УстановитьПараметр("ПометкаУдаления", ПометкаУдаления);'));
      assert.ok(code.includes('Запрос.УстановитьПараметр("Родитель", Родитель);'));

      // 3. Execution
      assert.ok(code.includes('РезультатЗапроса = Запрос.Выполнить();'));

      // 4. Detail iteration loop
      assert.ok(code.includes('ВыборкаДетальныеЗаписи = РезультатЗапроса.Выбрать();'));
      assert.ok(code.includes('Пока ВыборкаДетальныеЗаписи.Следующий() Цикл'));
      assert.ok(code.includes('// Обработка строки результата'));
      assert.ok(code.includes('КонецЦикла;'));

      // Should NOT have totals loop
      assert.ok(!code.includes('ОбходРезультатаЗапроса.ПоГруппировкам'));
    });

    test('generates processing skeleton with totals iteration for query with TOTALS', () => {
      const sdbl = [
        'ВЫБРАТЬ',
        '	Номенклатура.Родитель КАК Группа,',
        '	Номенклатура.Ссылка КАК Товар,',
        '	Номенклатура.Цена КАК Цена',
        'ИЗ',
        '	Справочник.Номенклатура КАК Номенклатура',
        'ИТОГИ',
        '	СУММА(Цена)',
        'ПО',
        '	Группа',
      ].join('\n');

      const pkg = parseSdbl(sdbl);
      const code = generateBslQueryWithProcessing(pkg);

      // Should have totals iteration loop
      assert.ok(code.includes('ВыборкаИтоги = РезультатЗапроса.Выбрать(ОбходРезультатаЗапроса.ПоГруппировкам);'));
      assert.ok(code.includes('Пока ВыборкаИтоги.Следующий() Цикл'));
      assert.ok(code.includes('// Обработка итогов'));
      assert.ok(code.includes('ВыборкаДетали = ВыборкаИтоги.Выбрать();'));
      assert.ok(code.includes('Пока ВыборкаДетали.Следующий() Цикл'));
      assert.ok(code.includes('// Обработка детальных записей'));

      // Should NOT have simple ВыборкаДетальныеЗаписи
      assert.ok(!code.includes('ВыборкаДетальныеЗаписи'));
    });

    test('supports custom variableName option', () => {
      const sdbl = 'ВЫБРАТЬ Ссылка ИЗ Документ.ЗаказКлиента ГДЕ Дата >= &ДатаНачала';
      const pkg = parseSdbl(sdbl);

      const code = generateBslQueryWithProcessing(pkg, { variableName: 'ЗапросПоЗаказам' });

      assert.ok(code.includes('ЗапросПоЗаказам = Новый Запрос;'));
      assert.ok(code.includes('ЗапросПоЗаказам.Текст ='));
      assert.ok(code.includes('ЗапросПоЗаказам.УстановитьПараметр("ДатаНачала", ДатаНачала);'));
      assert.ok(code.includes('РезультатЗапроса = ЗапросПоЗаказам.Выполнить();'));
    });

    test('supports custom indent option', () => {
      const sdbl = 'ВЫБРАТЬ 1 КАК Цифра';
      const pkg = parseSdbl(sdbl);

      const code = generateBslQueryWithProcessing(pkg, { indent: '  ' });

      // Indented comment in loop should have 2 spaces
      assert.ok(code.includes('  // Обработка строки результата'));
    });
  });

  suite('8. statementRange calculation (P1.3)', () => {
    test('calculates statementRange for Запрос.Текст = "..."', () => {
      const code = 'Запрос.Текст = "ВЫБРАТЬ 1 КАК Поле";';
      const cursorOffset = code.indexOf('Поле');
      const result = extractBslQuery(code, cursorOffset);

      assert.strictEqual(result.isNewQuery, false);
      assert.ok(result.statementRange, 'statementRange should be defined');
      assert.strictEqual(result.statementRange?.startOffset, 0);
      assert.strictEqual(result.statementRange?.endOffset, code.length);
      assert.strictEqual(result.statementRange?.startLine, 1);
      assert.strictEqual(result.statementRange?.startColumn, 1);
      assert.strictEqual(result.statementRange?.endLine, 1);
      assert.strictEqual(result.statementRange?.endColumn, code.length + 1);
    });

    test('calculates statementRange when Запрос = Новый Запрос; precedes Запрос.Текст = "..."', () => {
      const code = [
        'Запрос = Новый Запрос;',
        'Запрос.Текст = "ВЫБРАТЬ 1 КАК Поле";',
      ].join('\n');

      const cursorOffset = code.indexOf('Поле');
      const result = extractBslQuery(code, cursorOffset);

      assert.strictEqual(result.isNewQuery, false);
      assert.ok(result.statementRange, 'statementRange should be defined');
      assert.strictEqual(result.statementRange?.startOffset, 0);
      assert.strictEqual(result.statementRange?.endOffset, code.length);
      assert.strictEqual(result.statementRange?.startLine, 1);
      assert.strictEqual(result.statementRange?.startColumn, 1);
      assert.strictEqual(result.statementRange?.endLine, 2);
      assert.strictEqual(
        result.statementRange?.endColumn,
        'Запрос.Текст = "ВЫБРАТЬ 1 КАК Поле";'.length + 1
      );
    });

    test('calculates statementRange for Запрос = Новый Запрос("...") constructor', () => {
      const code = 'Запрос = Новый Запрос("ВЫБРАТЬ 1 КАК Поле");';
      const cursorOffset = code.indexOf('Поле');
      const result = extractBslQuery(code, cursorOffset);

      assert.strictEqual(result.isNewQuery, false);
      assert.ok(result.statementRange, 'statementRange should be defined');
      assert.strictEqual(result.statementRange?.startOffset, 0);
      assert.strictEqual(result.statementRange?.endOffset, code.length);
      assert.strictEqual(result.statementRange?.startLine, 1);
      assert.strictEqual(result.statementRange?.startColumn, 1);
      assert.strictEqual(result.statementRange?.endLine, 1);
      assert.strictEqual(result.statementRange?.endColumn, code.length + 1);
    });

    test('calculates statementRange for standalone Новый Запрос("...") constructor without assignment', () => {
      const code = 'Новый Запрос("ВЫБРАТЬ 1 КАК Поле");';
      const cursorOffset = code.indexOf('Поле');
      const result = extractBslQuery(code, cursorOffset);

      assert.strictEqual(result.isNewQuery, false);
      assert.ok(result.statementRange, 'statementRange should be defined');
      assert.strictEqual(result.statementRange?.startOffset, 0);
      assert.strictEqual(result.statementRange?.endOffset, code.length);
    });

    test('calculates statementRange when selecting query literal inside assignment', () => {
      const code = 'Запрос.Текст = "ВЫБРАТЬ 1 КАК Поле";';
      const litStart = code.indexOf('"ВЫБРАТЬ');
      const litEnd = code.lastIndexOf('"') + 1;
      const result = extractBslQuery(code, litStart, { start: litStart, end: litEnd });

      assert.strictEqual(result.isNewQuery, false);
      assert.ok(result.statementRange, 'statementRange should be defined');
      assert.strictEqual(result.statementRange?.startOffset, 0);
      assert.strictEqual(result.statementRange?.endOffset, code.length);
    });

    test('leaves statementRange undefined for standalone query literal without assignment', () => {
      const code = '"ВЫБРАТЬ 1 КАК Поле"';
      const result = extractBslQuery(code, 5);

      assert.strictEqual(result.isNewQuery, false);
      assert.strictEqual(result.statementRange, undefined);
    });

    test('R6: supports multiline constructor closing ) and ;', () => {
      const code = [
        'Запрос = Новый Запрос(',
        '    "ВЫБРАТЬ 1 КАК Поле"',
        ');',
      ].join('\n');

      const cursorOffset = code.indexOf('Поле');
      const result = extractBslQuery(code, cursorOffset);

      assert.strictEqual(result.isNewQuery, false);
      assert.ok(result.statementRange, 'statementRange should be defined');
      assert.strictEqual(result.statementRange?.startOffset, 0);
      assert.strictEqual(result.statementRange?.endOffset, code.length);
      assert.strictEqual(result.statementRange?.endLine, 3);
    });

    test('R6: leaves statementRange undefined for Return statement (Возврат Новый Запрос)', () => {
      const code = 'Возврат Новый Запрос("ВЫБРАТЬ 1 КАК Поле");';
      const cursorOffset = code.indexOf('Поле');
      const result = extractBslQuery(code, cursorOffset);

      assert.strictEqual(result.isNewQuery, false);
      assert.strictEqual(result.statementRange, undefined, 'Must not replace Return statement');
    });

    test('R6: leaves statementRange undefined for compound object access (Объект.Запрос.Текст = ...)', () => {
      const code = 'Объект.Запрос.Текст = "ВЫБРАТЬ 1 КАК Поле";';
      const cursorOffset = code.indexOf('Поле');
      const result = extractBslQuery(code, cursorOffset);

      assert.strictEqual(result.isNewQuery, false);
      assert.strictEqual(result.statementRange, undefined, 'Must not replace compound object access');
    });

    test('R6: leaves statementRange undefined for string concatenation assignment (+ Дополнение)', () => {
      const code = 'Запрос.Текст = "ВЫБРАТЬ 1 КАК Поле" + Дополнение;';
      const cursorOffset = code.indexOf('Поле');
      const result = extractBslQuery(code, cursorOffset);

      assert.strictEqual(result.isNewQuery, false);
      assert.strictEqual(result.statementRange, undefined, 'Must not replace when expression is concatenated');
    });

    test('Finding 1: leaves statementRange undefined for chained member calls (.Выполнить())', () => {
      const code = 'Запрос = Новый Запрос("ВЫБРАТЬ 1 КАК Поле").Выполнить();';
      const cursorOffset = code.indexOf('Поле');
      const result = extractBslQuery(code, cursorOffset);

      assert.strictEqual(result.isNewQuery, false);
      assert.strictEqual(result.statementRange, undefined, 'Must not replace statement when followed by method call');
    });
  });

  suite('9. Broad testing of selection inside BSL (R1 / P1)', () => {
    test('1. Selection without quotes in single-line literal expands to enclosing literal and prevents double quotes', () => {
      const code = 'Запрос.Текст = "ВЫБРАТЬ 1 КАК Поле";';
      const litStart = code.indexOf('"ВЫБРАТЬ');
      const litEnd = code.lastIndexOf('"') + 1;
      const selStart = code.indexOf('ВЫБРАТЬ');
      const selEnd = code.lastIndexOf('Поле') + 4;

      const result = extractBslQuery(code, selStart, { start: selStart, end: selEnd });

      assert.strictEqual(result.isNewQuery, false);
      assert.strictEqual(result.variableName, 'Запрос');
      assert.strictEqual(result.sdblText, 'ВЫБРАТЬ 1 КАК Поле');
      assert.strictEqual(result.replaceRange.startOffset, litStart);
      assert.strictEqual(result.replaceRange.endOffset, litEnd);
      assert.ok(result.statementRange, 'statementRange must be defined');
      assert.strictEqual(result.statementRange?.startOffset, 0);
      assert.strictEqual(result.statementRange?.endOffset, code.length);

      const generated = generateBslSimpleQuery(parseSdbl(result.sdblText));
      const replaced =
        code.slice(0, result.replaceRange.startOffset) +
        generated +
        code.slice(result.replaceRange.endOffset);
      assert.strictEqual(replaced, 'Запрос.Текст = "ВЫБРАТЬ\n|\t1 КАК Поле";');
      assert.strictEqual(replaced.includes('""'), false, 'Must not produce double quotes');
    });

    test('2. Selection without outer quotes in multiline literal with pipes', () => {
      const code = [
        'Запрос = Новый Запрос;',
        'Запрос.Текст = "ВЫБРАТЬ',
        '|\t1 КАК Поле',
        '|ИЗ',
        '|\tСправочник.Номенклатура";',
      ].join('\n');

      const litStart = code.indexOf('"ВЫБРАТЬ');
      const litEnd = code.lastIndexOf('"') + 1;
      const selStart = code.indexOf('ВЫБРАТЬ');
      const selEnd = code.indexOf('Номенклатура') + 'Номенклатура'.length;

      const result = extractBslQuery(code, selStart, { start: selStart, end: selEnd });

      assert.strictEqual(result.isNewQuery, false);
      assert.strictEqual(result.variableName, 'Запрос');
      assert.strictEqual(result.replaceRange.startOffset, litStart);
      assert.strictEqual(result.replaceRange.endOffset, litEnd);
      assert.ok(result.sdblText.startsWith('ВЫБРАТЬ'));
      assert.ok(!result.sdblText.includes('|'));
      assert.ok(result.statementRange, 'statementRange must be defined');
      assert.strictEqual(result.statementRange?.startOffset, 0);
      assert.strictEqual(result.statementRange?.endOffset, code.length);
    });

    test('3. Selection inside literal with escaped quotes unescapes and replaces full literal', () => {
      const code = 'Запрос.Текст = "ВЫБРАТЬ ""Специальный текст"" КАК Поле";';
      const litStart = code.indexOf('"ВЫБРАТЬ');
      const litEnd = code.lastIndexOf('"') + 1;
      const selStart = code.indexOf('ВЫБРАТЬ');
      const selEnd = code.lastIndexOf('Поле') + 4;

      const result = extractBslQuery(code, selStart, { start: selStart, end: selEnd });

      assert.strictEqual(result.isNewQuery, false);
      assert.strictEqual(result.variableName, 'Запрос');
      assert.strictEqual(result.replaceRange.startOffset, litStart);
      assert.strictEqual(result.replaceRange.endOffset, litEnd);
      assert.strictEqual(result.sdblText, 'ВЫБРАТЬ "Специальный текст" КАК Поле');
      assert.strictEqual(result.rawBslText, '"ВЫБРАТЬ ""Специальный текст"" КАК Поле"');
    });

    test('4. Selection inside constructor call without quotes detects statementRange', () => {
      const code = 'Запрос = Новый Запрос("ВЫБРАТЬ 1");';
      const litStart = code.indexOf('"ВЫБРАТЬ');
      const litEnd = code.lastIndexOf('"') + 1;
      const selStart = code.indexOf('ВЫБРАТЬ');
      const selEnd = code.indexOf('1') + 1;

      const result = extractBslQuery(code, selStart, { start: selStart, end: selEnd });

      assert.strictEqual(result.isNewQuery, false);
      assert.strictEqual(result.variableName, 'Запрос');
      assert.strictEqual(result.replaceRange.startOffset, litStart);
      assert.strictEqual(result.replaceRange.endOffset, litEnd);
      assert.strictEqual(result.sdblText, 'ВЫБРАТЬ 1');
      assert.ok(result.statementRange, 'statementRange must be defined for constructor');
      assert.strictEqual(result.statementRange?.startOffset, 0);
      assert.strictEqual(result.statementRange?.endOffset, code.length);
    });

    test('5. Selection with outer whitespace matching literal trims and targets literal', () => {
      const code = '   "ВЫБРАТЬ 1"   ';
      const litStart = code.indexOf('"');
      const litEnd = code.lastIndexOf('"') + 1;
      const selStart = 0;
      const selEnd = code.length;

      const result = extractBslQuery(code, selStart, { start: selStart, end: selEnd });

      assert.strictEqual(result.isNewQuery, false);
      assert.strictEqual(result.replaceRange.startOffset, litStart);
      assert.strictEqual(result.replaceRange.endOffset, litEnd);
      assert.strictEqual(result.sdblText, 'ВЫБРАТЬ 1');
    });

    test('6. Selection of pure SDBL text without literals preserves existing behavior', () => {
      const code = 'ВЫБРАТЬ 1 КАК Поле ИЗ Справочник.Номенклатура';
      const selStart = 0;
      const selEnd = code.length;

      const result = extractBslQuery(code, selStart, { start: selStart, end: selEnd });

      assert.strictEqual(result.isNewQuery, false);
      assert.strictEqual(result.replaceRange.startOffset, 0);
      assert.strictEqual(result.replaceRange.endOffset, code.length);
      assert.strictEqual(result.sdblText, code);
    });
  });
});

