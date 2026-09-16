import * as assert from 'assert';
import { parseSdbl } from '../../../src/queryBuilder/sdbl/sdblParser';
import {
  formatSdbl,
  formatExpression,
  formatToBslLiteral,
  extractParameters,
  normalizeUnionColumns,
} from '../../../src/queryBuilder/sdbl/sdblFormatter';
import {
  QueryPackage,
  SelectStatement,
  DropTableStatement,
  IdentifierNode,
  CompoundIdentifierNode,
  LiteralNode,
  ParameterNode,
  FunctionCallNode,
  AggregateNode,
  CaseWhenNode,
  BinaryOpNode,
  UnaryOpNode,
  InNode,
  BetweenNode,
  LikeNode,
} from '../../../src/queryBuilder/sdbl/sdblAst';

suite('SDBL Formatter & BSL Serializer', () => {
  suite('1. formatSdbl: Basic SELECT Queries', () => {
    test('formats minimal query with SELECT and FROM', () => {
      const pkg: QueryPackage = {
        queries: [
          {
            type: 'Select',
            fields: [
              {
                expression: { type: 'Identifier', name: 'Поле1' },
              },
            ],
            from: [
              {
                source: { type: 'Table', name: 'Справочник.Номенклатура' },
              },
            ],
          },
        ],
      };

      const expected = [
        'ВЫБРАТЬ',
        '\tПоле1',
        'ИЗ',
        '\tСправочник.Номенклатура',
      ].join('\n');

      assert.strictEqual(formatSdbl(pkg), expected);
    });

    test('formats multiple fields with aliases and table alias', () => {
      const pkg: QueryPackage = {
        queries: [
          {
            type: 'Select',
            fields: [
              {
                expression: {
                  type: 'CompoundIdentifier',
                  parts: ['Номенклатура', 'Код'],
                },
                alias: 'КодТовара',
              },
              {
                expression: {
                  type: 'CompoundIdentifier',
                  parts: ['Номенклатура', 'Наименование'],
                },
                alias: 'Название',
              },
            ],
            from: [
              {
                source: { type: 'Table', name: 'Справочник.Номенклатура' },
                alias: 'Номенклатура',
              },
            ],
          },
        ],
      };

      const expected = [
        'ВЫБРАТЬ',
        '\tНоменклатура.Код КАК КодТовара,',
        '\tНоменклатура.Наименование КАК Название',
        'ИЗ',
        '\tСправочник.Номенклатура КАК Номенклатура',
      ].join('\n');

      assert.strictEqual(formatSdbl(pkg), expected);
    });

    test('respects custom indentation and newline options', () => {
      const pkg: QueryPackage = {
        queries: [
          {
            type: 'Select',
            fields: [{ expression: { type: 'Identifier', name: 'Поле' } }],
            from: [{ source: { type: 'Table', name: 'Таблица' } }],
          },
        ],
      };

      const formatted = formatSdbl(pkg, { indent: '  ', newline: '\n' });
      const expected = ['ВЫБРАТЬ', '  Поле', 'ИЗ', '  Таблица'].join('\n');
      assert.strictEqual(formatted, expected);
    });
  });

  suite('2. formatSdbl: Modifiers (TOP, ALLOWED, DISTINCT, FOR UPDATE, AUTOORDER)', () => {
    test('formats ПЕРВЫЕ, РАЗРЕШЕННЫЕ, РАЗЛИЧНЫЕ and ДЛЯ ИЗМЕНЕНИЯ', () => {
      const pkg: QueryPackage = {
        queries: [
          {
            type: 'Select',
            allowed: true,
            distinct: true,
            top: 10,
            forUpdate: true,
            fields: [{ expression: { type: 'Identifier', name: 'Поле1' } }],
            from: [{ source: { type: 'Table', name: 'Документ.Заказ' } }],
          },
        ],
      };

      const expected = [
        'ВЫБРАТЬ РАЗРЕШЕННЫЕ РАЗЛИЧНЫЕ ПЕРВЫЕ 10',
        '\tПоле1',
        'ИЗ',
        '\tДокумент.Заказ',
        'ДЛЯ ИЗМЕНЕНИЯ',
      ].join('\n');

      assert.strictEqual(formatSdbl(pkg), expected);
    });

    test('formats ДЛЯ ИЗМЕНЕНИЯ with specific tables list', () => {
      const pkg: QueryPackage = {
        queries: [
          {
            type: 'Select',
            forUpdate: true,
            forUpdateTables: ['Таблица1', 'Таблица2'],
            fields: [{ expression: { type: 'Identifier', name: 'Поле1' } }],
            from: [{ source: { type: 'Table', name: 'Документ.Заказ' } }],
          },
        ],
      };

      const expected = [
        'ВЫБРАТЬ',
        '\tПоле1',
        'ИЗ',
        '\tДокумент.Заказ',
        'ДЛЯ ИЗМЕНЕНИЯ Таблица1, Таблица2',
      ].join('\n');

      assert.strictEqual(formatSdbl(pkg), expected);
    });

    test('formats standalone АВТОУПОРЯДОЧИВАНИЕ when autoOrder is true without explicit ORDER BY', () => {
      const pkg: QueryPackage = {
        queries: [
          {
            type: 'Select',
            autoOrder: true,
            fields: [{ expression: { type: 'Identifier', name: 'Поле1' } }],
            from: [{ source: { type: 'Table', name: 'Таблица' } }],
          },
        ],
      };

      const expected = [
        'ВЫБРАТЬ',
        '\tПоле1',
        'ИЗ',
        '\tТаблица',
        'АВТОУПОРЯДОЧИВАНИЕ',
      ].join('\n');

      assert.strictEqual(formatSdbl(pkg), expected);
    });
  });

  suite('3. formatSdbl: Temp Tables and Indexes (ПОМЕСТИТЬ, ИНДЕКСИРОВАТЬ ПО)', () => {
    test('formats ПОМЕСТИТЬ with ИНДЕКСИРОВАТЬ ПО in canonical position after FROM', () => {
      const pkg: QueryPackage = {
        queries: [
          {
            type: 'Select',
            into: 'ВТТовары',
            indexBy: ['Код', 'Наименование'],
            fields: [
              { expression: { type: 'Identifier', name: 'Код' } },
              { expression: { type: 'Identifier', name: 'Наименование' } },
            ],
            from: [
              { source: { type: 'Table', name: 'Справочник.Номенклатура' } },
            ],
          },
        ],
      };

      const expected = [
        'ВЫБРАТЬ',
        '\tКод,',
        '\tНаименование',
        'ПОМЕСТИТЬ ВТТовары',
        'ИЗ',
        '\tСправочник.Номенклатура',
        'ИНДЕКСИРОВАТЬ ПО',
        '\tКод,',
        '\tНаименование',
      ].join('\n');

      assert.strictEqual(formatSdbl(pkg), expected);
    });

    test('formats ИНДЕКСИРОВАТЬ ПО after WHERE, GROUP BY, and HAVING', () => {
      const pkg: QueryPackage = {
        queries: [
          {
            type: 'Select',
            into: 'ВТТовары',
            fields: [{ expression: { type: 'Identifier', name: 'Код' } }],
            from: [{ source: { type: 'Table', name: 'Справочник.Номенклатура' } }],
            where: {
              type: 'BinaryOp',
              operator: '>',
              left: { type: 'Identifier', name: 'Код' },
              right: { type: 'Literal', valueType: 'number', value: 10, raw: '10' },
            },
            groupBy: [{ type: 'Identifier', name: 'Код' }],
            having: {
              type: 'BinaryOp',
              operator: '>',
              left: { type: 'Identifier', name: 'Код' },
              right: { type: 'Literal', valueType: 'number', value: 0, raw: '0' },
            },
            indexBy: ['Код'],
          },
        ],
      };

      const expected = [
        'ВЫБРАТЬ',
        '\tКод',
        'ПОМЕСТИТЬ ВТТовары',
        'ИЗ',
        '\tСправочник.Номенклатура',
        'ГДЕ',
        '\tКод > 10',
        'СГРУППИРОВАТЬ ПО',
        '\tКод',
        'ИМЕЮЩИЕ',
        '\tКод > 0',
        'ИНДЕКСИРОВАТЬ ПО',
        '\tКод',
      ].join('\n');

      assert.strictEqual(formatSdbl(pkg), expected);
    });
  });

  suite('4. formatSdbl: DROP Table (УНИЧТОЖИТЬ)', () => {
    test('formats УНИЧТОЖИТЬ statement', () => {
      const pkg: QueryPackage = {
        queries: [
          {
            type: 'DropTable',
            tableName: 'ВТТовары',
          },
        ],
      };

      assert.strictEqual(formatSdbl(pkg), 'УНИЧТОЖИТЬ ВТТовары');
    });
  });

  suite('5. formatSdbl: Query Packages (Semicolon Delimiter)', () => {
    test('formats multi-statement query package separated by semicolon and newline', () => {
      const pkg: QueryPackage = {
        queries: [
          {
            type: 'Select',
            into: 'ВТ',
            fields: [{ expression: { type: 'Identifier', name: 'Ссылка' } }],
            from: [{ source: { type: 'Table', name: 'Справочник.Номенклатура' } }],
          },
          {
            type: 'Select',
            fields: [{ expression: { type: 'Identifier', name: '*' } }],
            from: [{ source: { type: 'Table', name: 'ВТ' } }],
          },
          {
            type: 'DropTable',
            tableName: 'ВТ',
          },
        ],
      };

      const expected = [
        'ВЫБРАТЬ',
        '\tСсылка',
        'ПОМЕСТИТЬ ВТ',
        'ИЗ',
        '\tСправочник.Номенклатура',
        ';',
        '',
        'ВЫБРАТЬ',
        '\t*',
        'ИЗ',
        '\tВТ',
        ';',
        '',
        'УНИЧТОЖИТЬ ВТ',
      ].join('\n');

      assert.strictEqual(formatSdbl(pkg), expected);
    });
  });

  suite('6. formatSdbl: Virtual Tables with Parameters', () => {
    test('formats virtual table with parameter expressions', () => {
      const pkg: QueryPackage = {
        queries: [
          {
            type: 'Select',
            fields: [{ expression: { type: 'Identifier', name: 'КоличествоОстаток' } }],
            from: [
              {
                source: {
                  type: 'Table',
                  name: 'РегистрНакопления.ТоварыНаСкладах.Остатки',
                  params: [
                    { type: 'Parameter', name: 'Период' },
                    {
                      type: 'BinaryOp',
                      operator: '=',
                      left: { type: 'Identifier', name: 'Организация' },
                      right: { type: 'Parameter', name: 'Орг' },
                    },
                  ],
                },
                alias: 'Таб',
              },
            ],
          },
        ],
      };

      const expected = [
        'ВЫБРАТЬ',
        '\tКоличествоОстаток',
        'ИЗ',
        '\tРегистрНакопления.ТоварыНаСкладах.Остатки(&Период, Организация = &Орг) КАК Таб',
      ].join('\n');

      assert.strictEqual(formatSdbl(pkg), expected);
    });

    test('formats virtual table with omitted/empty parameters', () => {
      const pkg: QueryPackage = {
        queries: [
          {
            type: 'Select',
            fields: [{ expression: { type: 'Identifier', name: 'Остаток' } }],
            from: [
              {
                source: {
                  type: 'Table',
                  name: 'Регистр.Остатки',
                  params: [
                    { type: 'Literal', valueType: 'null', value: null, raw: '' },
                    {
                      type: 'BinaryOp',
                      operator: '=',
                      left: { type: 'Identifier', name: 'Склад' },
                      right: { type: 'Parameter', name: 'Склад' },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const expected = [
        'ВЫБРАТЬ',
        '\tОстаток',
        'ИЗ',
        '\tРегистр.Остатки(, Склад = &Склад)',
      ].join('\n');

      assert.strictEqual(formatSdbl(pkg), expected);
    });
  });

  suite('7. formatSdbl: Joins (LEFT, RIGHT, FULL, INNER)', () => {
    test('formats joins with correct indentation', () => {
      const pkg: QueryPackage = {
        queries: [
          {
            type: 'Select',
            fields: [
              {
                expression: {
                  type: 'CompoundIdentifier',
                  parts: ['Номенклатура', 'Наименование'],
                },
              },
              {
                expression: {
                  type: 'CompoundIdentifier',
                  parts: ['Остатки', 'КоличествоОстаток'],
                },
              },
            ],
            from: [
              {
                source: { type: 'Table', name: 'Справочник.Номенклатура' },
                alias: 'Номенклатура',
                joins: [
                  {
                    joinType: 'Left',
                    source: {
                      type: 'Table',
                      name: 'РегистрНакопления.Остатки',
                    },
                    alias: 'Остатки',
                    on: {
                      type: 'BinaryOp',
                      operator: '=',
                      left: {
                        type: 'CompoundIdentifier',
                        parts: ['Номенклатура', 'Ссылка'],
                      },
                      right: {
                        type: 'CompoundIdentifier',
                        parts: ['Остатки', 'Номенклатура'],
                      },
                    },
                  },
                ],
              },
            ],
          },
        ],
      };

      const expected = [
        'ВЫБРАТЬ',
        '\tНоменклатура.Наименование,',
        '\tОстатки.КоличествоОстаток',
        'ИЗ',
        '\tСправочник.Номенклатура КАК Номенклатура',
        '\t\tЛЕВОЕ СОЕДИНЕНИЕ РегистрНакопления.Остатки КАК Остатки',
        '\t\tПО Номенклатура.Ссылка = Остатки.Номенклатура',
      ].join('\n');

      assert.strictEqual(formatSdbl(pkg), expected);
    });

    test('formats all join types: Left, Right, Full, Inner', () => {
      const makeJoinPkg = (joinType: 'Left' | 'Right' | 'Full' | 'Inner'): QueryPackage => ({
        queries: [
          {
            type: 'Select',
            fields: [{ expression: { type: 'Identifier', name: 'Поле' } }],
            from: [
              {
                source: { type: 'Table', name: 'Таб1' },
                joins: [
                  {
                    joinType,
                    source: { type: 'Table', name: 'Таб2' },
                    on: {
                      type: 'BinaryOp',
                      operator: '=',
                      left: { type: 'CompoundIdentifier', parts: ['Таб1', 'ID'] },
                      right: { type: 'CompoundIdentifier', parts: ['Таб2', 'ID'] },
                    },
                  },
                ],
              },
            ],
          },
        ],
      });

      const kwMap = {
        Left: 'ЛЕВОЕ СОЕДИНЕНИЕ',
        Full: 'ПОЛНОЕ СОЕДИНЕНИЕ',
        Inner: 'ВНУТРЕННЕЕ СОЕДИНЕНИЕ',
      };

      for (const [jt, kw] of Object.entries(kwMap)) {
        const formatted = formatSdbl(makeJoinPkg(jt as any));
        assert.ok(
          formatted.includes(`\t\t${kw} Таб2`),
          `Expected '${kw}' in formatted text`
        );
      }

      // SDBL platform rule: RIGHT JOIN does not exist in 1C SDBL syntax!
      // Any Right join must unfold into a LEFT JOIN with T2 in ИЗ and T1 joined to it.
      const rightFormatted = formatSdbl(makeJoinPkg('Right'));
      assert.strictEqual(
        rightFormatted.includes('ПРАВОЕ СОЕДИНЕНИЕ'),
        false,
        'ПРАВОЕ СОЕДИНЕНИЕ must NEVER appear in SDBL output'
      );
      assert.ok(
        rightFormatted.includes('ИЗ\r\n\tТаб2') || rightFormatted.includes('ИЗ\n\tТаб2'),
        'Таб2 must become the base table in ИЗ'
      );
      assert.ok(
        rightFormatted.includes('ЛЕВОЕ СОЕДИНЕНИЕ Таб1'),
        'Таб1 must be joined to Таб2 via ЛЕВОЕ СОЕДИНЕНИЕ'
      );
    });

    test('unfolds Right Join with aliases and conditions into canonical Left Join in SDBL', () => {
      const pkg: QueryPackage = {
        queries: [
          {
            type: 'Select',
            fields: [
              {
                expression: { type: 'CompoundIdentifier', parts: ['СтарееСтарых', 'Ссылка'] },
                alias: 'Ссылка',
              },
            ],
            from: [
              {
                source: { type: 'Table', name: 'Справочник.СтарееСтарых' },
                alias: 'СтарееСтарых',
                joins: [
                  {
                    joinType: 'Right',
                    source: { type: 'Table', name: 'Справочник.Справочник55' },
                    alias: 'Справочник55',
                    on: {
                      type: 'BinaryOp',
                      operator: '=',
                      left: { type: 'CompoundIdentifier', parts: ['СтарееСтарых', 'Реквизит'] },
                      right: { type: 'CompoundIdentifier', parts: ['Справочник55', 'Реквизит'] },
                    },
                  },
                ],
              },
            ],
          },
        ],
      };

      const formatted = formatSdbl(pkg);
      assert.strictEqual(
        formatted.includes('ПРАВОЕ СОЕДИНЕНИЕ'),
        false,
        'Must never emit ПРАВОЕ СОЕДИНЕНИЕ'
      );
      assert.ok(
        formatted.includes('Справочник.Справочник55 КАК Справочник55'),
        'Справочник55 must be present'
      );
      assert.ok(
        formatted.includes('ЛЕВОЕ СОЕДИНЕНИЕ Справочник.СтарееСтарых КАК СтарееСтарых'),
        'СтарееСтарых must be joined via ЛЕВОЕ СОЕДИНЕНИЕ'
      );
    });

    test('deduplicates joined tables in FROM clause: joined table is NOT repeated with comma in ИЗ', () => {
      // Recreating the exact user bug:
      // Tab 1 had added both СтарееСтарых and Справочник55 to from,
      // and Tab 2 configured a join between them.
      const pkgWithDuplicate: QueryPackage = {
        queries: [
          {
            type: 'Select',
            fields: [
              {
                expression: { type: 'CompoundIdentifier', parts: ['СтарееСтарых', 'Ссылка'] },
                alias: 'Ссылка',
              },
            ],
            from: [
              {
                source: { type: 'Table', name: 'Справочник.СтарееСтарых' },
                alias: 'СтарееСтарых',
                joins: [
                  {
                    joinType: 'Right',
                    source: { type: 'Table', name: 'Справочник.Справочник55' },
                    alias: 'Справочник55',
                    on: {
                      type: 'BinaryOp',
                      operator: '=',
                      left: { type: 'CompoundIdentifier', parts: ['СтарееСтарых', 'Реквизит'] },
                      right: { type: 'CompoundIdentifier', parts: ['Справочник55', 'Реквизит'] },
                    },
                  },
                ],
              },
              {
                source: { type: 'Table', name: 'Справочник.Справочник55' },
                alias: 'Справочник55',
              },
            ],
          },
        ],
      };

      const formatted = formatSdbl(pkgWithDuplicate);
      // Справочник55 must appear exactly ONCE in FROM clause (as the base table in ИЗ), NOT duplicated with comma
      const matches = formatted.match(/Справочник\.Справочник55/g);
      assert.strictEqual(
        matches ? matches.length : 0,
        1,
        `Expected Справочник.Справочник55 to appear exactly once in FROM, got ${matches?.length}:\n${formatted}`
      );
      assert.strictEqual(
        formatted.includes(',\r\n\tСправочник.Справочник55') || formatted.includes(',\n\tСправочник.Справочник55'),
        false,
        'Must not contain trailing comma-separated duplicate table'
      );
    });

    test('deduplicates Left Join when joined table is also in from roots, and preserves truly unjoined tables', () => {
      const pkg: QueryPackage = {
        queries: [
          {
            type: 'Select',
            fields: [{ expression: { type: 'Identifier', name: 'Поле' } }],
            from: [
              {
                source: { type: 'Table', name: 'Справочник.Номенклатура' },
                alias: 'Ном',
                joins: [
                  {
                    joinType: 'Left',
                    source: { type: 'Table', name: 'Справочник.ЕдиницыИзмерения' },
                    alias: 'Ед',
                    on: {
                      type: 'BinaryOp',
                      operator: '=',
                      left: { type: 'CompoundIdentifier', parts: ['Ном', 'Единица'] },
                      right: { type: 'CompoundIdentifier', parts: ['Ед', 'Ссылка'] },
                    },
                  },
                ],
              },
              // Duplicate joined table from Tab 1
              {
                source: { type: 'Table', name: 'Справочник.ЕдиницыИзмерения' },
                alias: 'Ед',
              },
              // Truly unjoined third table
              {
                source: { type: 'Table', name: 'Справочник.Организации' },
                alias: 'Орг',
              },
            ],
          },
        ],
      };

      const formatted = formatSdbl(pkg);
      // Ед must appear once
      const edMatches = formatted.match(/Справочник\.ЕдиницыИзмерения/g);
      assert.strictEqual(edMatches ? edMatches.length : 0, 1, 'ЕдиницыИзмерения must not be duplicated');
      // Орг must be present as a comma table
      assert.ok(formatted.includes('Справочник.Организации КАК Орг'), 'Unjoined Организации must remain');
    });

    test('unfolds Right Join when right table is a virtual table with parameters', () => {
      const pkg: QueryPackage = {
        queries: [
          {
            type: 'Select',
            fields: [{ expression: { type: 'Identifier', name: 'Количество' } }],
            from: [
              {
                source: { type: 'Table', name: 'Справочник.Номенклатура' },
                alias: 'Ном',
                joins: [
                  {
                    joinType: 'Right',
                    source: {
                      type: 'Table',
                      name: 'РегистрНакопления.ОстаткиНоменклатуры.Остатки',
                      params: [{ type: 'Parameter', name: 'Период' }],
                    },
                    alias: 'Остатки',
                    on: {
                      type: 'BinaryOp',
                      operator: '=',
                      left: { type: 'CompoundIdentifier', parts: ['Ном', 'Ссылка'] },
                      right: { type: 'CompoundIdentifier', parts: ['Остатки', 'Номенклатура'] },
                    },
                  },
                ],
              },
            ],
          },
        ],
      };

      const formatted = formatSdbl(pkg);
      assert.strictEqual(formatted.includes('ПРАВОЕ'), false);
      assert.ok(
        formatted.includes('РегистрНакопления.ОстаткиНоменклатуры.Остатки(&Период) КАК Остатки'),
        'Virtual table with params must become base table'
      );
      assert.ok(
        formatted.includes('ЛЕВОЕ СОЕДИНЕНИЕ Справочник.Номенклатура КАК Ном'),
        'Original left table must be left-joined'
      );
    });

    test('Rereview Finding 4: grouped joins wrap conditions with OR in parentheses', () => {
      const pkg: QueryPackage = {
        queries: [
          {
            type: 'Select',
            fields: [{ expression: { type: 'CompoundIdentifier', parts: ['А', 'Код'] } }],
            from: [
              {
                source: { type: 'Table', name: 'Справочник.А' },
                alias: 'А',
                joins: [
                  {
                    joinType: 'Left',
                    source: { type: 'Table', name: 'Справочник.Б' },
                    alias: 'Б',
                    on: {
                      type: 'BinaryOp',
                      operator: 'ИЛИ',
                      left: {
                        type: 'BinaryOp',
                        operator: '=',
                        left: { type: 'CompoundIdentifier', parts: ['А', 'Код'] },
                        right: { type: 'CompoundIdentifier', parts: ['Б', 'Код'] },
                      },
                      right: {
                        type: 'BinaryOp',
                        operator: '=',
                        left: { type: 'CompoundIdentifier', parts: ['А', 'Ссылка'] },
                        right: { type: 'CompoundIdentifier', parts: ['Б', 'Ссылка'] },
                      },
                    },
                  },
                  {
                    joinType: 'Left',
                    source: { type: 'Table', name: 'Справочник.Б' },
                    alias: 'Б',
                    on: {
                      type: 'BinaryOp',
                      operator: '=',
                      left: { type: 'CompoundIdentifier', parts: ['Б', 'Активен'] },
                      right: { type: 'Literal', valueType: 'boolean', value: true, raw: 'ИСТИНА' },
                    },
                  },
                ],
              },
            ],
          },
        ],
      };

      const formatted = formatSdbl(pkg);
      const expectedJoin = 'ПО (А.Код = Б.Код ИЛИ А.Ссылка = Б.Ссылка) И Б.Активен = ИСТИНА';
      assert.ok(formatted.includes(expectedJoin), `Expected formatted query to include: "${expectedJoin}", got:\n${formatted}`);
    });
  });

  suite('8. formatSdbl: Conditions in WHERE and HAVING (AND, OR, NOT, IN, BETWEEN, LIKE, IS NULL)', () => {
    test('formats WHERE with multiple conditions broken across lines with И and ИЛИ', () => {
      const pkg: QueryPackage = {
        queries: [
          {
            type: 'Select',
            fields: [{ expression: { type: 'Identifier', name: 'Поле' } }],
            from: [{ source: { type: 'Table', name: 'Таблица' } }],
            where: {
              type: 'BinaryOp',
              operator: 'AND',
              left: {
                type: 'BinaryOp',
                operator: '=',
                left: { type: 'Identifier', name: 'Поле1' },
                right: { type: 'Parameter', name: 'Парам1' },
              },
              right: {
                type: 'BinaryOp',
                operator: '>',
                left: { type: 'Identifier', name: 'Поле2' },
                right: { type: 'Literal', valueType: 'number', value: 10, raw: '10' },
              },
            },
          },
        ],
      };

      const expected = [
        'ВЫБРАТЬ',
        '\tПоле',
        'ИЗ',
        '\tТаблица',
        'ГДЕ',
        '\tПоле1 = &Парам1',
        '\tИ Поле2 > 10',
      ].join('\n');

      assert.strictEqual(formatSdbl(pkg), expected);
    });

    test('formats WHERE with chained AND and OR conditions', () => {
      const pkg: QueryPackage = {
        queries: [
          {
            type: 'Select',
            fields: [{ expression: { type: 'Identifier', name: 'Поле' } }],
            from: [{ source: { type: 'Table', name: 'Таблица' } }],
            where: {
              type: 'BinaryOp',
              operator: 'OR',
              left: {
                type: 'BinaryOp',
                operator: 'AND',
                left: {
                  type: 'BinaryOp',
                  operator: '=',
                  left: { type: 'Identifier', name: 'A' },
                  right: { type: 'Literal', valueType: 'number', value: 1, raw: '1' },
                },
                right: {
                  type: 'BinaryOp',
                  operator: '=',
                  left: { type: 'Identifier', name: 'B' },
                  right: { type: 'Literal', valueType: 'number', value: 2, raw: '2' },
                },
              },
              right: {
                type: 'BinaryOp',
                operator: '=',
                left: { type: 'Identifier', name: 'C' },
                right: { type: 'Literal', valueType: 'number', value: 3, raw: '3' },
              },
            },
          },
        ],
      };

      const expected = [
        'ВЫБРАТЬ',
        '\tПоле',
        'ИЗ',
        '\tТаблица',
        'ГДЕ',
        '\tA = 1',
        '\tИ B = 2',
        '\tИЛИ C = 3',
      ].join('\n');

      assert.strictEqual(formatSdbl(pkg), expected);
    });

    test('preserves parentheses in WHERE with mixed AND and OR: A = 1 AND (B = 2 OR C = 3) (P1.5)', () => {
      const pkg: QueryPackage = {
        queries: [
          {
            type: 'Select',
            fields: [{ expression: { type: 'Identifier', name: 'Поле' } }],
            from: [{ source: { type: 'Table', name: 'Таблица' } }],
            where: {
              type: 'BinaryOp',
              operator: 'AND',
              left: {
                type: 'BinaryOp',
                operator: '=',
                left: { type: 'Identifier', name: 'A' },
                right: { type: 'Literal', valueType: 'number', value: 1, raw: '1' },
              },
              right: {
                type: 'BinaryOp',
                operator: 'OR',
                left: {
                  type: 'BinaryOp',
                  operator: '=',
                  left: { type: 'Identifier', name: 'B' },
                  right: { type: 'Literal', valueType: 'number', value: 2, raw: '2' },
                },
                right: {
                  type: 'BinaryOp',
                  operator: '=',
                  left: { type: 'Identifier', name: 'C' },
                  right: { type: 'Literal', valueType: 'number', value: 3, raw: '3' },
                },
              },
            },
          },
        ],
      };

      const expected = [
        'ВЫБРАТЬ',
        '\tПоле',
        'ИЗ',
        '\tТаблица',
        'ГДЕ',
        '\tA = 1',
        '\tИ (B = 2 ИЛИ C = 3)',
      ].join('\n');

      assert.strictEqual(formatSdbl(pkg), expected);
    });

    test('preserves parentheses when OR is first condition in AND chain: (A = 1 OR B = 2) AND C = 3 (P1.5)', () => {
      const pkg: QueryPackage = {
        queries: [
          {
            type: 'Select',
            fields: [{ expression: { type: 'Identifier', name: 'Поле' } }],
            from: [{ source: { type: 'Table', name: 'Таблица' } }],
            where: {
              type: 'BinaryOp',
              operator: 'AND',
              left: {
                type: 'BinaryOp',
                operator: 'OR',
                left: {
                  type: 'BinaryOp',
                  operator: '=',
                  left: { type: 'Identifier', name: 'A' },
                  right: { type: 'Literal', valueType: 'number', value: 1, raw: '1' },
                },
                right: {
                  type: 'BinaryOp',
                  operator: '=',
                  left: { type: 'Identifier', name: 'B' },
                  right: { type: 'Literal', valueType: 'number', value: 2, raw: '2' },
                },
              },
              right: {
                type: 'BinaryOp',
                operator: '=',
                left: { type: 'Identifier', name: 'C' },
                right: { type: 'Literal', valueType: 'number', value: 3, raw: '3' },
              },
            },
          },
        ],
      };

      const expected = [
        'ВЫБРАТЬ',
        '\tПоле',
        'ИЗ',
        '\tТаблица',
        'ГДЕ',
        '\t(A = 1 ИЛИ B = 2)',
        '\tИ C = 3',
      ].join('\n');

      assert.strictEqual(formatSdbl(pkg), expected);
    });

    test('preserves parentheses in HAVING with mixed AND and OR (P1.5)', () => {
      const pkg: QueryPackage = {
        queries: [
          {
            type: 'Select',
            fields: [{ expression: { type: 'Identifier', name: 'Поле' } }],
            from: [{ source: { type: 'Table', name: 'Таблица' } }],
            having: {
              type: 'BinaryOp',
              operator: 'AND',
              left: {
                type: 'BinaryOp',
                operator: '>',
                left: {
                  type: 'Aggregate',
                  aggregateType: 'Sum',
                  expression: { type: 'Identifier', name: 'A' },
                },
                right: { type: 'Literal', valueType: 'number', value: 0, raw: '0' },
              },
              right: {
                type: 'BinaryOp',
                operator: 'OR',
                left: {
                  type: 'BinaryOp',
                  operator: '>',
                  left: {
                    type: 'Aggregate',
                    aggregateType: 'Sum',
                    expression: { type: 'Identifier', name: 'B' },
                  },
                  right: { type: 'Literal', valueType: 'number', value: 0, raw: '0' },
                },
                right: {
                  type: 'BinaryOp',
                  operator: '>',
                  left: {
                    type: 'Aggregate',
                    aggregateType: 'Sum',
                    expression: { type: 'Identifier', name: 'C' },
                  },
                  right: { type: 'Literal', valueType: 'number', value: 0, raw: '0' },
                },
              },
            },
          },
        ],
      };

      const expected = [
        'ВЫБРАТЬ',
        '\tПоле',
        'ИЗ',
        '\tТаблица',
        'ИМЕЮЩИЕ',
        '\tСУММА(A) > 0',
        '\tИ (СУММА(B) > 0 ИЛИ СУММА(C) > 0)',
      ].join('\n');

      assert.strictEqual(formatSdbl(pkg), expected);
    });

    test('round-trips mixed AND and OR preserving precedence and parentheses (P1.5)', () => {
      const sql = 'ВЫБРАТЬ Поле ИЗ Таблица ГДЕ A = 1 И (B = 2 ИЛИ C = 3)';
      const pkg = parseSdbl(sql);
      const formatted = formatSdbl(pkg);

      assert.ok(formatted.includes('A = 1'));
      assert.ok(formatted.includes('И (B = 2 ИЛИ C = 3)'));

      const reparsed = parseSdbl(formatted);
      const sel = reparsed.queries[0] as SelectStatement;
      assert.ok(sel.where);
      assert.strictEqual(sel.where.type, 'BinaryOp');
      const whereOp = sel.where as BinaryOpNode;
      assert.strictEqual(whereOp.operator, 'AND');
      assert.strictEqual(whereOp.right.type, 'BinaryOp');
      assert.strictEqual((whereOp.right as BinaryOpNode).operator, 'OR');
    });

    test('formats HAVING clause with aggregates and line break', () => {
      const pkg: QueryPackage = {
        queries: [
          {
            type: 'Select',
            fields: [
              { expression: { type: 'Identifier', name: 'Склад' } },
              {
                expression: {
                  type: 'Aggregate',
                  aggregateType: 'Sum',
                  expression: { type: 'Identifier', name: 'Сумма' },
                },
                alias: 'Всего',
              },
            ],
            from: [{ source: { type: 'Table', name: 'Таб' } }],
            groupBy: [{ type: 'Identifier', name: 'Склад' }],
            having: {
              type: 'BinaryOp',
              operator: '>',
              left: {
                type: 'Aggregate',
                aggregateType: 'Sum',
                expression: { type: 'Identifier', name: 'Сумма' },
              },
              right: { type: 'Literal', valueType: 'number', value: 1000, raw: '1000' },
            },
          },
        ],
      };

      const expected = [
        'ВЫБРАТЬ',
        '\tСклад,',
        '\tСУММА(Сумма) КАК Всего',
        'ИЗ',
        '\tТаб',
        'СГРУППИРОВАТЬ ПО',
        '\tСклад',
        'ИМЕЮЩИЕ',
        '\tСУММА(Сумма) > 1000',
      ].join('\n');

      assert.strictEqual(formatSdbl(pkg), expected);
    });

    test('formats IS NULL and IS NOT NULL conditions', () => {
      const pkg: QueryPackage = {
        queries: [
          {
            type: 'Select',
            fields: [{ expression: { type: 'Identifier', name: 'Поле' } }],
            from: [{ source: { type: 'Table', name: 'Таблица' } }],
            where: {
              type: 'BinaryOp',
              operator: 'AND',
              left: {
                type: 'BinaryOp',
                operator: 'IS NULL',
                left: { type: 'Identifier', name: 'Поле1' },
                right: { type: 'Literal', valueType: 'null', value: null, raw: 'NULL' },
              },
              right: {
                type: 'BinaryOp',
                operator: 'IS NOT NULL',
                left: { type: 'Identifier', name: 'Поле2' },
                right: { type: 'Literal', valueType: 'null', value: null, raw: 'NULL' },
              },
            },
          },
        ],
      };

      const expected = [
        'ВЫБРАТЬ',
        '\tПоле',
        'ИЗ',
        '\tТаблица',
        'ГДЕ',
        '\tПоле1 ЕСТЬ NULL',
        '\tИ Поле2 ЕСТЬ НЕ NULL',
      ].join('\n');

      assert.strictEqual(formatSdbl(pkg), expected);
    });

    test('formats IN, NOT IN, IN HIERARCHY, and NOT IN HIERARCHY', () => {
      const inNode: InNode = {
        type: 'In',
        expression: { type: 'Identifier', name: 'Поле' },
        values: [
          { type: 'Literal', valueType: 'number', value: 1, raw: '1' },
          { type: 'Literal', valueType: 'number', value: 2, raw: '2' },
        ],
      };
      assert.strictEqual(formatExpression(inNode), 'Поле В (1, 2)');

      const notInNode: InNode = {
        type: 'In',
        expression: { type: 'Identifier', name: 'Поле' },
        values: [{ type: 'Parameter', name: 'Список' }],
        not: true,
      };
      assert.strictEqual(formatExpression(notInNode), 'Поле НЕ В (&Список)');

      const hierarchyNode: InNode = {
        type: 'In',
        expression: { type: 'Identifier', name: 'Группа' },
        values: [{ type: 'Parameter', name: 'Родитель' }],
        inHierarchy: true,
      };
      assert.strictEqual(formatExpression(hierarchyNode), 'Группа В ИЕРАРХИИ (&Родитель)');

      const notHierarchyNode: InNode = {
        type: 'In',
        expression: { type: 'Identifier', name: 'Группа' },
        values: [{ type: 'Parameter', name: 'Родитель' }],
        not: true,
        inHierarchy: true,
      };
      assert.strictEqual(formatExpression(notHierarchyNode), 'Группа НЕ В ИЕРАРХИИ (&Родитель)');
    });

    test('formats BETWEEN and NOT BETWEEN', () => {
      const betweenNode: BetweenNode = {
        type: 'Between',
        expression: { type: 'Identifier', name: 'Дата' },
        from: { type: 'Parameter', name: 'ДатаНачала' },
        to: { type: 'Parameter', name: 'ДатаКонца' },
      };
      assert.strictEqual(
        formatExpression(betweenNode),
        'Дата МЕЖДУ &ДатаНачала И &ДатаКонца'
      );

      const notBetweenNode: BetweenNode = {
        type: 'Between',
        expression: { type: 'Identifier', name: 'Дата' },
        from: { type: 'Parameter', name: 'ДатаНачала' },
        to: { type: 'Parameter', name: 'ДатаКонца' },
        not: true,
      };
      assert.strictEqual(
        formatExpression(notBetweenNode),
        'Дата НЕ МЕЖДУ &ДатаНачала И &ДатаКонца'
      );
    });

    test('formats LIKE with optional ESCAPE', () => {
      const likeNode: LikeNode = {
        type: 'Like',
        expression: { type: 'Identifier', name: 'Наименование' },
        pattern: { type: 'Literal', valueType: 'string', value: '%товар%', raw: '"%товар%"' },
        escape: { type: 'Literal', valueType: 'string', value: '\\', raw: '"\\"' },
      };
      assert.strictEqual(
        formatExpression(likeNode),
        'Наименование ПОДОБНО "%товар%" СПЕЦСИМВОЛ "\\"'
      );

      const notLikeNode: LikeNode = {
        type: 'Like',
        expression: { type: 'Identifier', name: 'Код' },
        pattern: { type: 'Literal', valueType: 'string', value: 'Т-%', raw: '"Т-%"' },
        not: true,
      };
      assert.strictEqual(formatExpression(notLikeNode), 'Код НЕ ПОДОБНО "Т-%"');
    });
  });

  suite('9. formatSdbl: Grouping, Aggregates, and Functions', () => {
    test('formats GROUP BY with multiple expressions', () => {
      const pkg: QueryPackage = {
        queries: [
          {
            type: 'Select',
            fields: [
              { expression: { type: 'Identifier', name: 'Склад' } },
              { expression: { type: 'Identifier', name: 'Номенклатура' } },
            ],
            from: [{ source: { type: 'Table', name: 'Регистр' } }],
            groupBy: [
              { type: 'Identifier', name: 'Склад' },
              { type: 'Identifier', name: 'Номенклатура' },
            ],
          },
        ],
      };

      const expected = [
        'ВЫБРАТЬ',
        '\tСклад,',
        '\tНоменклатура',
        'ИЗ',
        '\tРегистр',
        'СГРУППИРОВАТЬ ПО',
        '\tСклад,',
        '\tНоменклатура',
      ].join('\n');

      assert.strictEqual(formatSdbl(pkg), expected);
    });

    test('formats aggregates: SUM, COUNT, AVG, MIN, MAX, COUNT(DISTINCT ...)', () => {
      const sumAgg: AggregateNode = {
        type: 'Aggregate',
        aggregateType: 'Sum',
        expression: { type: 'Identifier', name: 'Сумма' },
      };
      assert.strictEqual(formatExpression(sumAgg), 'СУММА(Сумма)');

      const countDistinct: AggregateNode = {
        type: 'Aggregate',
        aggregateType: 'Count',
        distinct: true,
        expression: { type: 'Identifier', name: 'Документ' },
      };
      assert.strictEqual(formatExpression(countDistinct), 'КОЛИЧЕСТВО(РАЗЛИЧНЫЕ Документ)');

      const avgAgg: AggregateNode = {
        type: 'Aggregate',
        aggregateType: 'Avg',
        expression: { type: 'Identifier', name: 'Цена' },
      };
      assert.strictEqual(formatExpression(avgAgg), 'СРЕДНЕЕ(Цена)');

      const minAgg: AggregateNode = {
        type: 'Aggregate',
        aggregateType: 'Min',
        expression: { type: 'Identifier', name: 'Цена' },
      };
      assert.strictEqual(formatExpression(minAgg), 'МИНИМУМ(Цена)');

      const maxAgg: AggregateNode = {
        type: 'Aggregate',
        aggregateType: 'Max',
        expression: { type: 'Identifier', name: 'Цена' },
      };
      assert.strictEqual(formatExpression(maxAgg), 'МАКСИМУМ(Цена)');
    });

    test('formats functions: ВЫРАЗИТЬ and ЕСТЬNULL', () => {
      const isNullFunc: FunctionCallNode = {
        type: 'FunctionCall',
        name: 'ЕСТЬNULL',
        args: [
          { type: 'Identifier', name: 'Поле' },
          { type: 'Literal', valueType: 'number', value: 0, raw: '0' },
        ],
      };
      assert.strictEqual(formatExpression(isNullFunc), 'ЕСТЬNULL(Поле, 0)');

      const castFunc: FunctionCallNode = {
        type: 'FunctionCall',
        name: 'ВЫРАЗИТЬ',
        args: [
          { type: 'Identifier', name: 'Поле' },
          {
            type: 'FunctionCall',
            name: 'Число',
            args: [
              { type: 'Literal', valueType: 'number', value: 10, raw: '10' },
              { type: 'Literal', valueType: 'number', value: 2, raw: '2' },
            ],
          },
        ],
      };
      assert.strictEqual(formatExpression(castFunc), 'ВЫРАЗИТЬ(Поле КАК Число(10, 2))');
    });

    test('preserves precision of large numbers via raw representation (P1.7)', () => {
      const largeNumNode: LiteralNode = {
        type: 'Literal',
        valueType: 'number',
        value: Number('12345678901234567890'),
        raw: '12345678901234567890',
      };
      assert.strictEqual(formatExpression(largeNumNode), '12345678901234567890');
    });

    test('preserves trailing zeros and exact format of decimal fractions via raw (P1.7)', () => {
      const decimalNode1: LiteralNode = {
        type: 'Literal',
        valueType: 'number',
        value: 12.345,
        raw: '12.345000',
      };
      assert.strictEqual(formatExpression(decimalNode1), '12.345000');

      const decimalNode2: LiteralNode = {
        type: 'Literal',
        valueType: 'number',
        value: 0.0001,
        raw: '0.000100',
      };
      assert.strictEqual(formatExpression(decimalNode2), '0.000100');
    });

    test('round-trips large numbers and exact decimal fractions without precision loss (P1.7)', () => {
      const sql = 'ВЫБРАТЬ 12345678901234567890 КАК БольшоеЧисло, 0.000100 КАК Дробь ИЗ Таблица';
      const pkg = parseSdbl(sql);
      const formatted = formatSdbl(pkg);
      assert.ok(formatted.includes('12345678901234567890 КАК БольшоеЧисло'));
      assert.ok(formatted.includes('0.000100 КАК Дробь'));
    });
  });

  suite('10. formatSdbl: CASE WHEN / ВЫБОР КОГДА', () => {
    test('formats CASE WHEN with multiple WHEN clauses and ELSE', () => {
      const caseWhen: CaseWhenNode = {
        type: 'CaseWhen',
        cases: [
          {
            when: {
              type: 'BinaryOp',
              operator: '>',
              left: { type: 'Identifier', name: 'Сумма' },
              right: { type: 'Literal', valueType: 'number', value: 1000, raw: '1000' },
            },
            then: {
              type: 'Literal',
              valueType: 'string',
              value: 'VIP',
              raw: '"VIP"',
            },
          },
          {
            when: {
              type: 'BinaryOp',
              operator: '>',
              left: { type: 'Identifier', name: 'Сумма' },
              right: { type: 'Literal', valueType: 'number', value: 500, raw: '500' },
            },
            then: {
              type: 'Literal',
              valueType: 'string',
              value: 'Standard',
              raw: '"Standard"',
            },
          },
        ],
        else: {
          type: 'Literal',
          valueType: 'string',
          value: 'Economy',
          raw: '"Economy"',
        },
      };

      const expected =
        'ВЫБОР КОГДА Сумма > 1000 ТОГДА "VIP" КОГДА Сумма > 500 ТОГДА "Standard" ИНАЧЕ "Economy" КОНЕЦ';
      assert.strictEqual(formatExpression(caseWhen), expected);
    });
  });

  suite('11. formatSdbl: UNIONS and ORDER BY', () => {
    test('formats UNION and UNION ALL', () => {
      const pkg: QueryPackage = {
        queries: [
          {
            type: 'Select',
            fields: [
              {
                expression: { type: 'Literal', valueType: 'number', value: 1, raw: '1' },
                alias: 'Номер',
              },
            ],
            from: [{ source: { type: 'Table', name: 'Справочник.Склады' } }],
            unions: [
              {
                unionType: 'Union',
                statement: {
                  type: 'Select',
                  fields: [
                    {
                      expression: { type: 'Literal', valueType: 'number', value: 2, raw: '2' },
                      alias: 'Номер',
                    },
                  ],
                  from: [{ source: { type: 'Table', name: 'Справочник.Склады' } }],
                },
              },
              {
                unionType: 'UnionAll',
                statement: {
                  type: 'Select',
                  fields: [
                    {
                      expression: { type: 'Literal', valueType: 'number', value: 3, raw: '3' },
                      alias: 'Номер',
                    },
                  ],
                  from: [{ source: { type: 'Table', name: 'Справочник.Склады' } }],
                },
              },
            ],
          },
        ],
      };

      const expected = [
        'ВЫБРАТЬ',
        '\t1 КАК Номер',
        'ИЗ',
        '\tСправочник.Склады',
        '',
        'ОБЪЕДИНИТЬ',
        '',
        'ВЫБРАТЬ',
        '\t2 КАК Номер',
        'ИЗ',
        '\tСправочник.Склады',
        '',
        'ОБЪЕДИНИТЬ ВСЕ',
        '',
        'ВЫБРАТЬ',
        '\t3 КАК Номер',
        'ИЗ',
        '\tСправочник.Склады',
      ].join('\n');

      assert.strictEqual(formatSdbl(pkg), expected);
    });

    test('formats ORDER BY with ASC, DESC and AUTOORDER', () => {
      const pkg: QueryPackage = {
        queries: [
          {
            type: 'Select',
            fields: [
              { expression: { type: 'Identifier', name: 'Код' } },
              { expression: { type: 'Identifier', name: 'Наименование' } },
            ],
            from: [{ source: { type: 'Table', name: 'Справочник.Номенклатура' } }],
            orderBy: [
              {
                expression: { type: 'Identifier', name: 'Код' },
                direction: 'Asc',
              },
              {
                expression: { type: 'Identifier', name: 'Наименование' },
                direction: 'Desc',
              },
            ],
            autoOrder: true,
          },
        ],
      };

      const expected = [
        'ВЫБРАТЬ',
        '\tКод,',
        '\tНаименование',
        'ИЗ',
        '\tСправочник.Номенклатура',
        'УПОРЯДОЧИТЬ ПО',
        '\tКод ВОЗР,',
        '\tНаименование УБЫВ',
        'АВТОУПОРЯДОЧИВАНИЕ',
      ].join('\n');

      assert.strictEqual(formatSdbl(pkg), expected);
    });
  });

  suite('12. formatSdbl: TOTALS (ИТОГИ)', () => {
    test('formats TOTALS with aggregate fields, OVERALL, HIERARCHY, and PERIODS', () => {
      const pkg: QueryPackage = {
        queries: [
          {
            type: 'Select',
            fields: [
              { expression: { type: 'Identifier', name: 'Номенклатура' } },
              { expression: { type: 'Identifier', name: 'Период' } },
              { expression: { type: 'Identifier', name: 'Сумма' } },
            ],
            from: [{ source: { type: 'Table', name: 'Регистр.Продажи' } }],
            totals: {
              fields: [
                {
                  expression: {
                    type: 'Aggregate',
                    aggregateType: 'Sum',
                    expression: { type: 'Identifier', name: 'Сумма' },
                  },
                },
              ],
              overall: true,
              by: [
                {
                  expression: { type: 'Identifier', name: 'Номенклатура' },
                  hierarchy: true,
                },
                {
                  expression: { type: 'Identifier', name: 'Период' },
                  periods: true,
                },
              ],
            },
          },
        ],
      };

      const expected = [
        'ВЫБРАТЬ',
        '\tНоменклатура,',
        '\tПериод,',
        '\tСумма',
        'ИЗ',
        '\tРегистр.Продажи',
        'ИТОГИ',
        '\tСУММА(Сумма)',
        'ПО',
        '\tОБЩИЕ,',
        '\tНоменклатура ИЕРАРХИЯ,',
        '\tПериод ПЕРИОДАМИ',
      ].join('\n');

      assert.strictEqual(formatSdbl(pkg), expected);
    });

    test('formats TOTALS with ТОЛЬКО ИЕРАРХИЯ and ПЕРИОДАМИ(ДЕНЬ,,) (P2.20)', () => {
      const pkg: QueryPackage = {
        queries: [
          {
            type: 'Select',
            fields: [
              { expression: { type: 'Identifier', name: 'Номенклатура' } },
              { expression: { type: 'Identifier', name: 'Период' } },
            ],
            from: [{ source: { type: 'Table', name: 'Регистр.Продажи' } }],
            totals: {
              by: [
                {
                  expression: { type: 'Identifier', name: 'Номенклатура' },
                  hierarchy: true,
                  hierarchyType: 'OnlyHierarchy',
                },
                {
                  expression: { type: 'Identifier', name: 'Период' },
                  period: true,
                  periodDefinition: {
                    periodType: 'ДЕНЬ',
                  },
                },
              ],
            },
          },
        ],
      };

      const expected = [
        'ВЫБРАТЬ',
        '\tНоменклатура,',
        '\tПериод',
        'ИЗ',
        '\tРегистр.Продажи',
        'ИТОГИ',
        'ПО',
        '\tНоменклатура ТОЛЬКО ИЕРАРХИЯ,',
        '\tПериод ПЕРИОДАМИ(ДЕНЬ,,)',
      ].join('\n');

      assert.strictEqual(formatSdbl(pkg), expected);
    });

    test('formats TOTALS with ПЕРИОДАМИ(ДЕНЬ, &Нач, &Кон) with parameters (P2.20)', () => {
      const pkg: QueryPackage = {
        queries: [
          {
            type: 'Select',
            fields: [{ expression: { type: 'Identifier', name: 'Период' } }],
            from: [{ source: { type: 'Table', name: 'Таб' } }],
            totals: {
              by: [
                {
                  expression: { type: 'Identifier', name: 'Период' },
                  period: true,
                  periodDefinition: {
                    periodType: 'ДЕНЬ',
                    from: { type: 'Parameter', name: 'Нач' },
                    to: { type: 'Parameter', name: 'Кон' },
                  },
                },
              ],
            },
          },
        ],
      };

      const expected = [
        'ВЫБРАТЬ',
        '\tПериод',
        'ИЗ',
        '\tТаб',
        'ИТОГИ',
        'ПО',
        '\tПериод ПЕРИОДАМИ(ДЕНЬ, &Нач, &Кон)',
      ].join('\n');

      assert.strictEqual(formatSdbl(pkg), expected);
    });

    test('round-trips totals with ТОЛЬКО ИЕРАРХИЯ and ПЕРИОДАМИ(ДЕНЬ,,) (P2.20)', () => {
      const sql = 'ВЫБРАТЬ Номенклатура, Период ИЗ Регистр.Продажи ИТОГИ ПО Номенклатура ТОЛЬКО ИЕРАРХИЯ, Период ПЕРИОДАМИ(ДЕНЬ,,)';
      const pkg = parseSdbl(sql);
      const formatted = formatSdbl(pkg);

      assert.ok(formatted.includes('ТОЛЬКО ИЕРАРХИЯ'));
      assert.ok(formatted.includes('ПЕРИОДАМИ(ДЕНЬ,,)'));

      const reparsed = parseSdbl(formatted);
      const sel = reparsed.queries[0] as SelectStatement;
      assert.ok(sel.totals);
      assert.strictEqual(sel.totals.by[0].hierarchyType, 'OnlyHierarchy');
      assert.strictEqual(sel.totals.by[1].periodDefinition?.periodType, 'ДЕНЬ');
    });
  });

  suite('13. Round-trip Idempotency (parseSdbl -> formatSdbl -> parseSdbl)', () => {
    const testCases: Array<{ name: string; sql: string }> = [
      {
        name: 'simple query with alias',
        sql: 'ВЫБРАТЬ Поле1 КАК П1 ИЗ Таблица КАК Т',
      },
      {
        name: 'modifiers and where condition',
        sql: 'ВЫБРАТЬ ПЕРВЫЕ 10 РАЗРЕШЕННЫЕ РАЗЛИЧНЫЕ Поле1 ИЗ Документ.Заказ ГДЕ Поле1 = &Парам ДЛЯ ИЗМЕНЕНИЯ',
      },
      {
        name: 'temporary table with indexes',
        sql: 'ВЫБРАТЬ Код, Наименование ПОМЕСТИТЬ ВТТовары ИНДЕКСИРОВАТЬ ПО Код, Наименование ИЗ Справочник.Номенклатура',
      },
      {
        name: 'multi-statement query package',
        sql: 'ВЫБРАТЬ Поле ПОМЕСТИТЬ ВТ ИЗ Таб; ВЫБРАТЬ * ИЗ ВТ; УНИЧТОЖИТЬ ВТ',
      },
      {
        name: 'joins with conditions',
        sql: 'ВЫБРАТЬ Т1.А, Т2.Б ИЗ Таб1 КАК Т1 ЛЕВОЕ СОЕДИНЕНИЕ Таб2 КАК Т2 ПО Т1.Id = Т2.Id',
      },
      {
        name: 'virtual table with parameters',
        sql: 'ВЫБРАТЬ Кол ИЗ Регистр.Остатки(&Период, Орг = &Орг) КАК Т',
      },
      {
        name: 'complex expressions (CASE WHEN, aggregates, IN, BETWEEN, LIKE)',
        sql: 'ВЫБРАТЬ СУММА(Сумма) КАК Всего, ВЫБОР КОГДА Сумма > 100 ТОГДА 1 ИНАЧЕ 0 КОНЕЦ КАК Флаг ИЗ Таб ГДЕ Поле В (1, 2) И Дата МЕЖДУ &Д1 И &Д2 И Название ПОДОБНО "%тест%" СГРУППИРОВАТЬ ПО ВЫБОР КОГДА Сумма > 100 ТОГДА 1 ИНАЧЕ 0 КОНЕЦ',
      },
      {
        name: 'order by and totals',
        sql: 'ВЫБРАТЬ Ном, Сумма ИЗ Таб УПОРЯДОЧИТЬ ПО Ном ВОЗР ИТОГИ СУММА(Сумма) ПО ОБЩИЕ, Ном ИЕРАРХИЯ',
      },
      {
        name: 'subqueries in FROM and WHERE IN',
        sql: 'ВЫБРАТЬ Вл.Код ИЗ (ВЫБРАТЬ Код ИЗ Таб) КАК Вл ГДЕ Вл.Код В (ВЫБРАТЬ Код ИЗ Таб2)',
      },
    ];

    for (const tc of testCases) {
      test(`round-trip: ${tc.name}`, () => {
        const ast1 = parseSdbl(tc.sql);
        const formatted = formatSdbl(ast1);
        const ast2 = parseSdbl(formatted);
        assert.deepStrictEqual(ast2, ast1);
      });
    }
  });

  suite('14. formatToBslLiteral', () => {
    test('formats single-line statement into BSL literal', () => {
      const bsl = formatToBslLiteral('УНИЧТОЖИТЬ ВТ');
      assert.strictEqual(bsl, '"УНИЧТОЖИТЬ ВТ"');
    });

    test('formats multiline query with pipe prefixes and indentation', () => {
      const sql = 'ВЫБРАТЬ Поле КАК Поле ИЗ Справочник.Номенклатура КАК Номенклатура';
      const pkg = parseSdbl(sql);
      const bsl = formatToBslLiteral(pkg);

      const expected =
        '"ВЫБРАТЬ\n|\tПоле КАК Поле\n|ИЗ\n|\tСправочник.Номенклатура КАК Номенклатура"';
      assert.strictEqual(bsl, expected);
    });

    test('escapes internal double quotes by doubling them', () => {
      const sql = 'ВЫБРАТЬ "Привет, ""мир""" КАК Строка ИЗ Таблица';
      const bsl = formatToBslLiteral(sql);
      assert.ok(bsl.startsWith('"ВЫБРАТЬ'));
      assert.ok(bsl.includes('""Привет, """"мир""""""'));
    });

    test('accepts raw multiline string as input', () => {
      const text = 'ВЫБРАТЬ\n\tПоле\nИЗ\n\tТаб';
      const bsl = formatToBslLiteral(text);
      assert.strictEqual(bsl, '"ВЫБРАТЬ\n|\tПоле\n|ИЗ\n|\tТаб"');
    });
  });

  suite('15. extractParameters', () => {
    test('extracts unique parameters from WHERE, virtual tables, fields, and subqueries', () => {
      const sql = `
        ВЫБРАТЬ
          ВЫБОР КОГДА Поле = &Условие ТОГДА &Константа ИНАЧЕ 0 КОНЕЦ КАК Поле1
        ИЗ
          РегистрНакопления.Товары.Остатки(&Период, Организация = &Организация) КАК Таб
          ЛЕВОЕ СОЕДИНЕНИЕ (
            ВЫБРАТЬ Ссылка ИЗ Справочник.Номенклатура ГДЕ Склад = &Склад
          ) КАК Вл
          ПО Таб.Номенклатура = Вл.Ссылка И Таб.Счет = &Счет
        ГДЕ
          Таб.Количество > &МинКоличество
          И Таб.Номенклатура В (&СписокНоменклатуры)
          И Таб.Дата МЕЖДУ &Дата1 И &Дата2
      `;

      const pkg = parseSdbl(sql);
      const params = extractParameters(pkg);

      const expected = [
        'Дата1',
        'Дата2',
        'Константа',
        'МинКоличество',
        'Организация',
        'Период',
        'Склад',
        'СписокНоменклатуры',
        'Счет',
        'Условие',
      ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

      assert.deepStrictEqual(params, expected);
    });

    test('returns empty array when query has no parameters', () => {
      const sql = 'ВЫБРАТЬ 1 КАК Поле ИЗ Справочник.Номенклатура';
      const pkg = parseSdbl(sql);
      const params = extractParameters(pkg);
      assert.deepStrictEqual(params, []);
    });

    test('deduplicates parameters used multiple times in query package', () => {
      const sql = `
        ВЫБРАТЬ Поле ИЗ Таб ГДЕ Поле = &Парам;
        ВЫБРАТЬ Поле2 ИЗ Таб2 ГДЕ Поле2 = &Парам И Поле3 = &Другой;
      `;
      const pkg = parseSdbl(sql);
      const params = extractParameters(pkg);
      assert.deepStrictEqual(params, ['Другой', 'Парам'].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    });

    test('R11: extracts parameters from PERIODS clause in totals', () => {
      const sql = `
        ВЫБРАТЬ Номенклатура, Сумма ИЗ Документ.Продажи
        ИТОГИ СУММА(Сумма) ПО Период ПЕРИОДАМИ(ДЕНЬ, &ДатаНач, &ДатаКон)
      `;
      const pkg = parseSdbl(sql);
      const params = extractParameters(pkg);
      assert.deepStrictEqual(params, ['ДатаКон', 'ДатаНач']);
    });

    test('R4: formats asterisk when fields array is empty', () => {
      const pkg: QueryPackage = {
        queries: [
          {
            type: 'Select',
            fields: [],
            from: [{ source: { type: 'Table', name: 'Справочник.Номенклатура' } }],
          },
        ],
      };
      const formatted = formatSdbl(pkg);
      assert.ok(formatted.includes('ВЫБРАТЬ\n\t*'));
    });

    test('R5: formats raw string expression in orderBy', () => {
      const pkg: QueryPackage = {
        queries: [
          {
            type: 'Select',
            fields: [{ expression: { type: 'Identifier', name: 'Поле1' } }],
            from: [{ source: { type: 'Table', name: 'Таб' } }],
            orderBy: [{ expression: 'Таб.Поле1' as any, direction: 'Desc' }],
          },
        ],
      };
      const formatted = formatSdbl(pkg);
      assert.ok(formatted.includes('УПОРЯДОЧИТЬ ПО\n\tТаб.Поле1 УБЫВ'));
    });
  });

  suite('16. normalizeUnionColumns: Positional alignment and equal column counts', () => {
    test('does not modify queries when column counts are already equal', () => {
      const stmt: SelectStatement = {
        type: 'Select',
        fields: [{ expression: { type: 'Literal', valueType: 'number', value: 1, raw: '1' }, alias: 'А' }],
        unions: [
          {
            unionType: 'UnionAll',
            statement: {
              type: 'Select',
              fields: [{ expression: { type: 'Literal', valueType: 'number', value: 2, raw: '2' }, alias: 'Б' }],
            },
          },
        ],
      };

      normalizeUnionColumns(stmt);
      assert.strictEqual(stmt.fields?.length, 1);
      assert.strictEqual(stmt.unions?.[0].statement.fields?.length, 1);
    });

    test('pads main query with NULL when union branch has more columns', () => {
      const stmt: SelectStatement = {
        type: 'Select',
        fields: [{ expression: { type: 'Literal', valueType: 'number', value: 1, raw: '1' }, alias: 'А' }],
        unions: [
          {
            unionType: 'UnionAll',
            statement: {
              type: 'Select',
              fields: [
                { expression: { type: 'Literal', valueType: 'number', value: 2, raw: '2' }, alias: 'Б' },
                { expression: { type: 'Literal', valueType: 'number', value: 3, raw: '3' }, alias: 'В' },
              ],
            },
          },
        ],
      };

      normalizeUnionColumns(stmt);
      assert.strictEqual(stmt.fields?.length, 2);
      assert.strictEqual(stmt.unions?.[0].statement.fields?.length, 2);
      assert.strictEqual(stmt.fields?.[1].alias, 'В');
      assert.strictEqual((stmt.fields?.[1].expression as LiteralNode).type, 'Literal');
      assert.strictEqual((stmt.fields?.[1].expression as LiteralNode).raw, 'NULL');

      // Test formatSdbl output
      const pkg: QueryPackage = { queries: [stmt] };
      const formatted = formatSdbl(pkg);
      assert.ok(formatted.includes('ВЫБРАТЬ\n\t1 КАК А,\n\tNULL КАК В'));
      assert.ok(formatted.includes('ВЫБРАТЬ\n\t2 КАК Б,\n\t3 КАК В'));
    });

    test('pads union branch with NULL when main query has more columns', () => {
      const stmt: SelectStatement = {
        type: 'Select',
        fields: [
          { expression: { type: 'Literal', valueType: 'number', value: 1, raw: '1' }, alias: 'А' },
          { expression: { type: 'Literal', valueType: 'number', value: 2, raw: '2' }, alias: 'Б' },
        ],
        unions: [
          {
            unionType: 'UnionAll',
            statement: {
              type: 'Select',
              fields: [{ expression: { type: 'Literal', valueType: 'number', value: 3, raw: '3' }, alias: 'В' }],
            },
          },
        ],
      };

      normalizeUnionColumns(stmt);
      assert.strictEqual(stmt.fields?.length, 2);
      assert.strictEqual(stmt.unions?.[0].statement.fields?.length, 2);
      assert.strictEqual((stmt.unions?.[0].statement.fields?.[1].expression as LiteralNode).type, 'Literal');
      assert.strictEqual((stmt.unions?.[0].statement.fields?.[1].expression as LiteralNode).raw, 'NULL');
    });
  });
});

