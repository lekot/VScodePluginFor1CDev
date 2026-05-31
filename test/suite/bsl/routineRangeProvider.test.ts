import * as assert from 'assert';
import { createHash } from 'crypto';

import {
  parseBslRoutines,
  findBslRoutineAtLine,
} from '../../../src/bsl/routineRangeProvider';

suite('routineRangeProvider', () => {
  test('parses Russian procedure and function with export flag, directives and ranges', () => {
    const source = [
      '&НаКлиенте',
      'Процедура ПриОткрытии(Отказ) Экспорт',
      '  Сообщить("ok");',
      'КонецПроцедуры',
      '',
      '&НаСервере',
      'Функция ПолучитьДанные()',
      '  Возврат 1;',
      'КонецФункции',
    ].join('\n');

    const result = parseBslRoutines(source);

    assert.deepStrictEqual(result.diagnostics, []);
    assert.strictEqual(result.routines.length, 2);
    assert.deepStrictEqual(
      result.routines.map((routine) => ({
        name: routine.name,
        kind: routine.kind,
        exported: routine.exported,
        directives: routine.directives,
        range: routine.range,
        signatureRange: routine.signatureRange,
        bodyRange: routine.bodyRange,
      })),
      [
        {
          name: 'ПриОткрытии',
          kind: 'procedure',
          exported: true,
          directives: ['&НаКлиенте'],
          range: { startLine: 2, startColumn: 1, endLine: 4, endColumn: 15 },
          signatureRange: { startLine: 2, startColumn: 1, endLine: 2, endColumn: 37 },
          bodyRange: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 18 },
        },
        {
          name: 'ПолучитьДанные',
          kind: 'function',
          exported: false,
          directives: ['&НаСервере'],
          range: { startLine: 7, startColumn: 1, endLine: 9, endColumn: 13 },
          signatureRange: { startLine: 7, startColumn: 1, endLine: 7, endColumn: 25 },
          bodyRange: { startLine: 8, startColumn: 1, endLine: 8, endColumn: 13 },
        },
      ]
    );
    assert.match(result.routines[0].bodyHash, /^[a-f0-9]{64}$/);
    assert.notStrictEqual(result.routines[0].bodyHash, result.routines[1].bodyHash);
  });

  test('parses English procedure and function keywords', () => {
    const source = [
      '&AtClient',
      'Procedure Handle(Refusal) Export',
      '  Value = 1;',
      'EndProcedure',
      '',
      'Function Calculate()',
      '  Return Value;',
      'EndFunction',
    ].join('\n');

    const result = parseBslRoutines(source);

    assert.deepStrictEqual(result.diagnostics, []);
    assert.deepStrictEqual(
      result.routines.map((routine) => [routine.name, routine.kind, routine.exported]),
      [
        ['Handle', 'procedure', true],
        ['Calculate', 'function', false],
      ]
    );
    assert.deepStrictEqual(result.routines[0].directives, ['&AtClient']);
  });

  test('parses Russian multiline procedure signature with export on closing line', () => {
    const source = [
      'Процедура Foo(',
      '    Param',
      ') Экспорт',
      '  Сообщить(Param);',
      'КонецПроцедуры',
    ].join('\n');

    const result = parseBslRoutines(source);

    assert.deepStrictEqual(result.diagnostics, []);
    assert.strictEqual(result.routines.length, 1);
    const routine = result.routines[0];
    assert.strictEqual(routine.name, 'Foo');
    assert.strictEqual(routine.kind, 'procedure');
    assert.strictEqual(routine.exported, true);
    assert.match(routine.parameterText, /\bParam\b/);
    assert.deepStrictEqual(routine.signatureRange, {
      startLine: 1,
      startColumn: 1,
      endLine: 3,
      endColumn: 10,
    });
    assert.deepStrictEqual(routine.bodyRange, {
      startLine: 4,
      startColumn: 1,
      endLine: 4,
      endColumn: 19,
    });
    assert.strictEqual(
      routine.bodyHash,
      createHash('sha256').update('  Сообщить(Param);').digest('hex')
    );
  });

  test('returns no routines or diagnostics for empty module', () => {
    assert.deepStrictEqual(parseBslRoutines(''), { routines: [], diagnostics: [] });
  });

  test('emits diagnostic for duplicate routine names case-insensitively', () => {
    const source = [
      'Procedure Save()',
      'EndProcedure',
      '',
      'Function save()',
      'EndFunction',
    ].join('\n');

    const result = parseBslRoutines(source);

    assert.strictEqual(result.routines.length, 2);
    assert.deepStrictEqual(
      result.diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        severity: diagnostic.severity,
        routineName: diagnostic.routineName,
        range: diagnostic.range,
      })),
      [
        {
          code: 'duplicate-routine',
          severity: 'error',
          routineName: 'save',
          range: { startLine: 4, startColumn: 1, endLine: 4, endColumn: 16 },
        },
      ]
    );
  });

  test('emits diagnostic and keeps open range for unclosed routine', () => {
    const source = [
      'Процедура Незакрытая()',
      '  Значение = 1;',
    ].join('\n');

    const result = parseBslRoutines(source);

    assert.strictEqual(result.routines.length, 1);
    assert.deepStrictEqual(result.routines[0].range, {
      startLine: 1,
      startColumn: 1,
      endLine: 2,
      endColumn: 16,
    });
    assert.deepStrictEqual(result.diagnostics.map((diagnostic) => diagnostic.code), [
      'unclosed-routine',
    ]);
  });

  test('keeps incomplete declaration visible and reports missing closing parenthesis', () => {
    const source = [
      'Процедура ПриЗаписи(',
      '  Отказ = Истина;',
    ].join('\n');

    const result = parseBslRoutines(source);

    assert.strictEqual(result.routines.length, 1);
    assert.strictEqual(result.routines[0].name, 'ПриЗаписи');
    assert.strictEqual(result.routines[0].range.startLine, 1);
    assert.deepStrictEqual(
      result.diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        routineName: diagnostic.routineName,
        message: diagnostic.message,
      })),
      [
        {
          code: 'unclosed-routine',
          routineName: 'ПриЗаписи',
          message: 'Routine "ПриЗаписи" declaration is incomplete: missing closing ")".',
        },
        {
          code: 'unclosed-routine',
          routineName: 'ПриЗаписи',
          message: 'Routine "ПриЗаписи" has no closing end keyword.',
        },
      ]
    );
  });

  test('finds routine by 1-based line using shared ranges', () => {
    const source = [
      'Procedure First()',
      'EndProcedure',
      '',
      'Function Second()',
      '  Return 1;',
      'EndFunction',
    ].join('\n');

    assert.strictEqual(findBslRoutineAtLine(source, 1)?.name, 'First');
    assert.strictEqual(findBslRoutineAtLine(source, 5)?.name, 'Second');
    assert.strictEqual(findBslRoutineAtLine(source, 3), undefined);
  });
});
