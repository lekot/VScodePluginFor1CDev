import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

interface BslIndentationConfiguration {
  readonly indentationRules: {
    readonly increaseIndentPattern: string;
    readonly decreaseIndentPattern: string;
  };
}

suite('BSL indentation configuration', () => {
  const rules = readConfiguration().indentationRules;
  const increaseIndent = new RegExp(rules.increaseIndentPattern);
  const decreaseIndent = new RegExp(rules.decreaseIndentPattern);

  test('increases indentation after Russian procedure, function, condition, loops, and try blocks', () => {
    for (const line of [
      'Процедура Выполнить()',
      'Функция Рассчитать()',
      'Если Условие Тогда',
      'Иначе',
      'ИначеЕсли Условие Тогда',
      'Для Каждого Объект Из ЧтоТо Цикл',
      'Для Счетчик = 1 По 10 Цикл',
      'Пока Условие Цикл',
      'Попытка',
      'Исключение',
    ]) {
      assert.ok(increaseIndent.test(line), `Expected increased indentation after: ${line}`);
    }
  });

  test('increases indentation after English procedure, function, condition, loops, and try blocks', () => {
    for (const line of [
      'Procedure Run()',
      'Function Calculate()',
      'If Condition Then',
      'Else',
      'ElsIf Condition Then',
      'For Each Item In Items Do',
      'For Counter = 1 To 10 Do',
      'While Condition Do',
      'Try',
      'Except',
    ]) {
      assert.ok(increaseIndent.test(line), `Expected increased indentation after: ${line}`);
    }
  });

  test('decreases indentation at Russian and English block endings and branch clauses', () => {
    for (const line of [
      'КонецПроцедуры',
      'КонецФункции',
      'КонецЕсли',
      'КонецЦикла',
      'КонецПопытки',
      'Иначе',
      'ИначеЕсли Условие Тогда',
      'Исключение',
      'EndProcedure',
      'EndFunction',
      'EndIf',
      'EndDo',
      'EndTry',
      'Else',
      'ElsIf Condition Then',
      'Except',
    ]) {
      assert.ok(decreaseIndent.test(line), `Expected decreased indentation before: ${line}`);
    }
  });

  test('does not treat comments, strings, or identifiers containing keywords as block headers', () => {
    for (const line of [
      '// Процедура Выполнить()',
      '// Если Условие Тогда',
      '"Для Каждого Объект Из ЧтоТо Цикл"',
      'Текст = "Функция Рассчитать()";',
      'ПроцедураВыполнить()',
      'ФункцияРассчитать()',
      'ИначеЕслиЗначение = Истина;',
      'IfConditionThen()',
      'ProcedureHelper()',
      'ДляКаждогоОбъекта()',
      'Если Условие // Тогда',
      'If Condition // Then',
      'Если Условие = "Тогда"',
      'If Condition = "Then"',
      'Если Условие ТогдаЛожь',
      'Пока Значение // Цикл',
      'For Items // Do',
      'Сообщить("Если Условие Тогда");',
    ]) {
      assert.ok(!increaseIndent.test(line), `Must not increase indentation after: ${line}`);
      assert.ok(!decreaseIndent.test(line), `Must not decrease indentation before: ${line}`);
    }
  });

  test('recognizes real block terminators after condition strings and trailing comments', () => {
    assert.ok(increaseIndent.test('Если Значение = "Тогда" Тогда'));
    assert.ok(increaseIndent.test('If Value = "Then" Then // explanation'));
    assert.ok(increaseIndent.test('Пока Значение = "Цикл" Цикл'));
    assert.ok(increaseIndent.test('While Value = "Do" Do // explanation'));
  });
});

function readConfiguration(): BslIndentationConfiguration {
  const configurationPath = path.resolve(__dirname, '../../..', 'syntaxes', 'bsl-language-configuration.json');
  return JSON.parse(fs.readFileSync(configurationPath, 'utf-8')) as BslIndentationConfiguration;
}
