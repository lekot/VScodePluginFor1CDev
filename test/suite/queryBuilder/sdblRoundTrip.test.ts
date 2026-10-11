import * as assert from 'assert';
import { parseSdbl } from '../../../src/queryBuilder/sdbl/sdblParser';
import { formatSdbl } from '../../../src/queryBuilder/sdbl/sdblFormatter';
import { semanticallyEqual } from '../../../src/queryBuilder/sdbl/sdblAstEquivalence';
import { alignUnionColumns } from '../../../src/queryBuilder/sdbl/sdblUnionAlign';
import { SelectStatement } from '../../../src/queryBuilder/sdbl/sdblAst';

interface SdblError extends Error {
  sdblLine: number;
  sdblColumn: number;
  sdblLength: number;
}

suite('SDBL round trip: comments, errors, unions', () => {
  test('comments survive formatting and stay with their tokens', () => {
    const text =
      'ВЫБРАТЬ\n' +
      '\tТ.Ссылка КАК Ссылка, // ключ\n' +
      '\tТ.Сумма КАК Сумма\n' +
      'ИЗ\n' +
      '\t// документы\n' +
      '\tДокумент.Заказ КАК Т';
    const ast = parseSdbl(text);
    const formatted = formatSdbl(ast);
    assert.ok(formatted.includes('КАК Ссылка, // ключ'), formatted);
    assert.ok(formatted.includes('// документы'), formatted);
    assert.strictEqual(formatSdbl(parseSdbl(formatted)), formatted);
  });

  test('leading comments stay with each query after the package AST is reordered', () => {
    const text =
      '// комментарий запроса А\n' +
      'ВЫБРАТЬ 1 КАК ЗначениеА ИЗ Справочник.А КАК А;\n' +
      '// комментарий запроса Б\n' +
      'ВЫБРАТЬ 2 КАК ЗначениеБ ИЗ Справочник.Б КАК Б';
    const ast = parseSdbl(text);
    assert.strictEqual(ast.queries.length, 2);
    [ast.queries[0], ast.queries[1]] = [ast.queries[1], ast.queries[0]];

    const formatted = formatSdbl(ast);
    const queryB = formatted.indexOf('2 КАК ЗначениеБ');
    const commentB = formatted.indexOf('// комментарий запроса Б');
    const queryA = formatted.indexOf('1 КАК ЗначениеА');
    const commentA = formatted.indexOf('// комментарий запроса А');

    assert.ok(queryB >= 0 && queryA > queryB, formatted);
    assert.ok(commentB >= 0 && commentB < queryB, formatted);
    assert.ok(commentA > queryB && commentA < queryA, formatted);
  });

  test('semantic equality ignores layout and literal spelling but not meaning', () => {
    const a = parseSdbl('ВЫБРАТЬ Т.А ИЗ Т КАК Т ГДЕ Т.Б = НЕОПРЕДЕЛЕНО И НЕ Т.В В (1, 2)');
    const b = parseSdbl('ВЫБРАТЬ\n\tТ.А\nИЗ\n\tТ КАК Т\nГДЕ\n\tТ.Б = НЕОПРЕДЕЛЕНО\n\tИ НЕ Т.В В (1, 2)');
    const c = parseSdbl('ВЫБРАТЬ Т.А ИЗ Т КАК Т ГДЕ Т.Б = НЕОПРЕДЕЛЕНО И Т.В В (1, 2)');
    assert.ok(semanticallyEqual(a, b));
    assert.ok(!semanticallyEqual(a, c));
  });

  test('ВЫБОР of a selected field is laid out one КОГДА, ТОГДА, ИНАЧЕ per line', () => {
    const text =
      'ВЫБРАТЬ ВЫБОР КОГДА С.А = 1 И &П ТОГДА &Сделка ИНАЧЕ ВЫБОР КОГДА С.Б ТОГДА 1 КОНЕЦ КОНЕЦ КАК Сделка, // поле\n' +
      'ЕСТЬNULL(ВЫБОР КОГДА С.Д ТОГДА 1 КОНЕЦ, 0) КАК Ю ИЗ С КАК С';
    const ast = parseSdbl(text);
    const formatted = formatSdbl(ast);
    assert.strictEqual(
      formatted,
      'ВЫБРАТЬ\n' +
        '\tВЫБОР\n' +
        '\t\tКОГДА С.А = 1 И &П\n' +
        '\t\t\tТОГДА &Сделка\n' +
        '\t\tИНАЧЕ ВЫБОР\n' +
        '\t\t\tКОГДА С.Б\n' +
        '\t\t\t\tТОГДА 1\n' +
        '\t\tКОНЕЦ\n' +
        '\tКОНЕЦ КАК Сделка, // поле\n' +
        '\tЕСТЬNULL(ВЫБОР КОГДА С.Д ТОГДА 1 КОНЕЦ, 0) КАК Ю\n' +
        'ИЗ\n' +
        '\tС КАК С'
    );
    assert.strictEqual(formatSdbl(parseSdbl(formatted)), formatted);
    assert.ok(semanticallyEqual(ast, parseSdbl(formatted)));
  });

  test('a broken query names the error in Russian and points at the place', () => {
    const base =
      'ВЫБРАТЬ ПЕРВЫЕ 10\n\tТ.Ссылка КАК Ссылка,\n\tСУММА(Т.Сумма) КАК Сумма\nПОМЕСТИТЬ ВТ\nИЗ\n\tДокумент.Заказ КАК Т\n' +
      '\t\tЛЕВОЕ СОЕДИНЕНИЕ Справочник.Партнеры КАК П\n\t\tПО Т.Партнер = П.Ссылка\nГДЕ\n\tТ.Склад В (&Склады)\n\tИ Т.Имя ПОДОБНО "%а%"\n' +
      'СГРУППИРОВАТЬ ПО\n\tТ.Ссылка\n;\nВЫБРАТЬ ВТ.Ссылка ИЗ ВТ КАК ВТ\nУПОРЯДОЧИТЬ ПО Ссылка';
    parseSdbl(base);
    const cases: Array<[string, string, RegExp, string]> = [
      ['СОЕДИНЕНИЕ Справочник', 'СОЕДИНЕНИЕ И Справочник', /^Ожидается имя таблицы/, 'И'],
      ['\t\tПО Т.Партнер = П.Ссылка\n', '', /^Ожидается ПО с условием соединения/, 'ГДЕ'],
      ['КАК Сумма', 'КАК Сумма,', /^Ожидается выражение/, 'ПОМЕСТИТЬ'],
      ['КАК Ссылка,', 'КАК Ссылка', /^Ожидается запятая между полями или ИЗ/, 'СУММА'],
      [
        'Т.Сумма) КАК',
        'Т.Сумма КАК',
        /^Ожидается «\)» после аргумента агрегатной функции \(скобка открыта в строке 3, колонке 7\)/,
        'КАК',
      ],
      ['Т.Сумма) КАК', 'Т.Сумма)) КАК', /^Лишняя закрывающая скобка/, ')'],
      ['"%а%"', '"%а%', /^Не закрыта строка/, '"'],
      ['\tИ Т.Имя', '\tИ И Т.Имя', /^Ожидается выражение/, 'И'],
      ['СГРУППИРОВАТЬ ПО', 'СГРУППИРОВАТЬ', /^После СГРУППИРОВАТЬ ожидается ПО/, 'Т'],
      ['УПОРЯДОЧИТЬ ПО', 'УПОРЯДОЧИТЬ', /^После УПОРЯДОЧИТЬ ожидается ПО/, 'Ссылка'],
      ['\n;\n', '\n', /^Между запросами пакета ожидается «;»/, 'ВЫБРАТЬ'],
      ['Справочник.Партнеры КАК П', 'Справочник. КАК П', /^После точки ожидается имя/, 'КАК'],
      [
        'ИЗ ВТ КАК ВТ',
        'ИЗ (ВЫБРАТЬ 1 КАК Ссылка ИЗ ВТ КАК ВТ',
        /^Не закрыта скобка: ожидается «\)» после вложенного запроса/,
        '(',
      ],
    ];
    for (const [from, to, message, token] of cases) {
      const text = base.replace(from, to);
      let caught: SdblError | undefined;
      try {
        parseSdbl(text);
      } catch (e) {
        caught = e as SdblError;
      }
      assert.ok(caught, `no error for ${to}`);
      assert.match(caught.message, message, to);
      const line = text.split('\n')[caught.sdblLine - 1];
      assert.strictEqual(line.substr(caught.sdblColumn - 1, caught.sdblLength), token, to);
    }
  });

  test('the parser accepts what configurations write: КАК Конец, a comma before a join', () => {
    parseSdbl('ВЫБРАТЬ Т.Дата КАК Конец ИЗ Документ.Order КАК Т');
    parseSdbl('ВЫБРАТЬ Конец.Счет ИЗ РегистрБухгалтерии.Хозрасчетный КАК Конец');
    const joined = parseSdbl(
      'ВЫБРАТЬ А.Ссылка ИЗ Справочник.А КАК А, ЛЕВОЕ СОЕДИНЕНИЕ Справочник.Б КАК Б ПО А.Ссылка = Б.Ссылка'
    );
    const select = joined.queries[0] as SelectStatement;
    assert.strictEqual(select.from?.length, 1);
    assert.strictEqual(select.from?.[0].joins?.length, 1);
  });

  test('a field added to one query of a union gets NULL in the others', () => {
    const previous = parseSdbl('ВЫБРАТЬ А.Х КАК Х ИЗ А КАК А ОБЪЕДИНИТЬ ВСЕ ВЫБРАТЬ Б.Х ИЗ Б КАК Б');
    const pkg = parseSdbl('ВЫБРАТЬ А.Х КАК Х, А.У КАК У ИЗ А КАК А ОБЪЕДИНИТЬ ВСЕ ВЫБРАТЬ Б.Х ИЗ Б КАК Б');
    alignUnionColumns(pkg, previous);
    const formatted = formatSdbl(pkg);
    assert.ok(/ВЫБРАТЬ\s+Б\.Х,\s+NULL\s+ИЗ/.test(formatted), formatted);
  });
});
