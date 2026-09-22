import * as assert from 'assert';
import {
  TokenType,
  SdblKeyword,
  SdblToken,
  getCanonicalKeyword,
  getRussianKeyword,
} from '../../../src/queryBuilder/sdbl/sdblTokens';
import { tokenizeSdbl } from '../../../src/queryBuilder/sdbl/sdblTokenizer';

suite('SDBL Tokenizer', () => {
  suite('Keywords - Russian and English', () => {
    test('tokenizes primary keywords in Russian and English with canonical representation', () => {
      const cases: Array<{ ru: string; en: string; canonical: SdblKeyword }> = [
        { ru: 'ВЫБРАТЬ', en: 'SELECT', canonical: SdblKeyword.Select },
        { ru: 'ИЗ', en: 'FROM', canonical: SdblKeyword.From },
        { ru: 'ГДЕ', en: 'WHERE', canonical: SdblKeyword.Where },
        { ru: 'И', en: 'AND', canonical: SdblKeyword.And },
        { ru: 'ИЛИ', en: 'OR', canonical: SdblKeyword.Or },
        { ru: 'НЕ', en: 'NOT', canonical: SdblKeyword.Not },
        { ru: 'КАК', en: 'AS', canonical: SdblKeyword.As },
        { ru: 'ЛЕВОЕ', en: 'LEFT', canonical: SdblKeyword.Left },
        { ru: 'СОЕДИНЕНИЕ', en: 'JOIN', canonical: SdblKeyword.Join },
        { ru: 'ПО', en: 'ON', canonical: SdblKeyword.On },
        { ru: 'СГРУППИРОВАТЬ', en: 'GROUP', canonical: SdblKeyword.Group },
        { ru: 'УПОРЯДОЧИТЬ', en: 'ORDER', canonical: SdblKeyword.Order },
        { ru: 'ИТОГИ', en: 'TOTALS', canonical: SdblKeyword.Totals },
        { ru: 'ОБЪЕДИНИТЬ', en: 'UNION', canonical: SdblKeyword.Union },
        { ru: 'ВСЕ', en: 'ALL', canonical: SdblKeyword.All },
        { ru: 'РАЗРЕШЕННЫЕ', en: 'ALLOWED', canonical: SdblKeyword.Allowed },
        { ru: 'РАЗЛИЧНЫЕ', en: 'DISTINCT', canonical: SdblKeyword.Distinct },
        { ru: 'ПЕРВЫЕ', en: 'TOP', canonical: SdblKeyword.Top },
        { ru: 'ПОМЕСТИТЬ', en: 'INTO', canonical: SdblKeyword.Into },
        { ru: 'УНИЧТОЖИТЬ', en: 'DROP', canonical: SdblKeyword.Drop },
        { ru: 'ИНДЕКСИРОВАТЬ', en: 'INDEX', canonical: SdblKeyword.Index },
        { ru: 'ИМЕЮЩИЕ', en: 'HAVING', canonical: SdblKeyword.Having },
        { ru: 'АВТОУПОРЯДОЧИВАНИЕ', en: 'AUTOORDER', canonical: SdblKeyword.Autoorder },
      ];

      for (const { ru, en, canonical } of cases) {
        const ruTokens = tokenizeSdbl(ru);
        assert.strictEqual(ruTokens.length, 1, `Expected 1 token for Russian keyword: ${ru}`);
        assert.strictEqual(ruTokens[0].type, TokenType.Keyword);
        assert.strictEqual(ruTokens[0].raw, ru);
        assert.strictEqual(ruTokens[0].value, canonical);

        const enTokens = tokenizeSdbl(en);
        assert.strictEqual(enTokens.length, 1, `Expected 1 token for English keyword: ${en}`);
        assert.strictEqual(enTokens[0].type, TokenType.Keyword);
        assert.strictEqual(enTokens[0].raw, en);
        assert.strictEqual(enTokens[0].value, canonical);
      }
    });

    test('tokenizes compound keywords: ДЛЯ ИЗМЕНЕНИЯ / FOR UPDATE', () => {
      const ruTokens = tokenizeSdbl('ДЛЯ ИЗМЕНЕНИЯ');
      assert.strictEqual(ruTokens.length, 1);
      assert.strictEqual(ruTokens[0].type, TokenType.Keyword);
      assert.strictEqual(ruTokens[0].raw, 'ДЛЯ ИЗМЕНЕНИЯ');
      assert.strictEqual(ruTokens[0].value, SdblKeyword.ForUpdate);

      const ruMultiWhitespace = tokenizeSdbl('ДЛЯ   ИЗМЕНЕНИЯ');
      assert.strictEqual(ruMultiWhitespace.length, 1);
      assert.strictEqual(ruMultiWhitespace[0].type, TokenType.Keyword);
      assert.strictEqual(ruMultiWhitespace[0].raw, 'ДЛЯ   ИЗМЕНЕНИЯ');
      assert.strictEqual(ruMultiWhitespace[0].value, SdblKeyword.ForUpdate);

      const enTokens = tokenizeSdbl('FOR UPDATE');
      assert.strictEqual(enTokens.length, 1);
      assert.strictEqual(enTokens[0].type, TokenType.Keyword);
      assert.strictEqual(enTokens[0].raw, 'FOR UPDATE');
      assert.strictEqual(enTokens[0].value, SdblKeyword.ForUpdate);

      const enMultiWhitespace = tokenizeSdbl('FOR  \t  UPDATE');
      assert.strictEqual(enMultiWhitespace.length, 1);
      assert.strictEqual(enMultiWhitespace[0].type, TokenType.Keyword);
      assert.strictEqual(enMultiWhitespace[0].raw, 'FOR  \t  UPDATE');
      assert.strictEqual(enMultiWhitespace[0].value, SdblKeyword.ForUpdate);
    });

    test('treats ДЛЯ or FOR as identifier when not followed by ИЗМЕНЕНИЯ/UPDATE', () => {
      const tokens1 = tokenizeSdbl('ДЛЯ Клиент');
      assert.strictEqual(tokens1.length, 2);
      assert.strictEqual(tokens1[0].type, TokenType.Identifier);
      assert.strictEqual(tokens1[0].raw, 'ДЛЯ');
      assert.strictEqual(tokens1[1].type, TokenType.Identifier);
      assert.strictEqual(tokens1[1].raw, 'Клиент');

      const tokens2 = tokenizeSdbl('FOR Client');
      assert.strictEqual(tokens2.length, 2);
      assert.strictEqual(tokens2[0].type, TokenType.Identifier);
      assert.strictEqual(tokens2[0].raw, 'FOR');
      assert.strictEqual(tokens2[1].type, TokenType.Identifier);
      assert.strictEqual(tokens2[1].raw, 'Client');
    });

    test('handles case-insensitivity for keywords and preserves raw case', () => {
      const lower = tokenizeSdbl('выбрать из где');
      assert.strictEqual(lower.length, 3);
      assert.strictEqual(lower[0].type, TokenType.Keyword);
      assert.strictEqual(lower[0].raw, 'выбрать');
      assert.strictEqual(lower[0].value, SdblKeyword.Select);
      assert.strictEqual(lower[1].raw, 'из');
      assert.strictEqual(lower[1].value, SdblKeyword.From);
      assert.strictEqual(lower[2].raw, 'где');
      assert.strictEqual(lower[2].value, SdblKeyword.Where);

      const mixed = tokenizeSdbl('ВыБрАтЬ Select');
      assert.strictEqual(mixed[0].raw, 'ВыБрАтЬ');
      assert.strictEqual(mixed[0].value, SdblKeyword.Select);
      assert.strictEqual(mixed[1].raw, 'Select');
      assert.strictEqual(mixed[1].value, SdblKeyword.Select);
    });

    test('tokenizes additional SDBL keywords (joins, case-when, null, booleans)', () => {
      const query = 'ПРАВОЕ ПОЛНОЕ ВНУТРЕННЕЕ RIGHT FULL INNER ВЫБОР КОГДА ТОГДА ИНАЧЕ КОНЕЦ CASE WHEN THEN ELSE END МЕЖДУ BETWEEN ЕСТЬ IS NULL ИСТИНА TRUE ЛОЖЬ FALSE';
      const tokens = tokenizeSdbl(query);
      for (const token of tokens) {
        assert.strictEqual(token.type, TokenType.Keyword, `Expected keyword for ${token.raw}`);
      }
    });

    test('keyword helper functions work correctly', () => {
      assert.strictEqual(getCanonicalKeyword('выбрать'), SdblKeyword.Select);
      assert.strictEqual(getCanonicalKeyword('select'), SdblKeyword.Select);
      assert.strictEqual(getCanonicalKeyword('для изменения'), SdblKeyword.ForUpdate);
      assert.strictEqual(getRussianKeyword(SdblKeyword.Select), 'ВЫБРАТЬ');
      assert.strictEqual(getRussianKeyword(SdblKeyword.ForUpdate), 'ДЛЯ ИЗМЕНЕНИЯ');
    });
  });

  suite('Aggregate Functions', () => {
    test('tokenizes all aggregate functions in Russian and English as Keywords', () => {
      const cases: Array<{ ru: string; en: string; canonical: SdblKeyword }> = [
        { ru: 'СУММА', en: 'SUM', canonical: SdblKeyword.Sum },
        { ru: 'КОЛИЧЕСТВО', en: 'COUNT', canonical: SdblKeyword.Count },
        { ru: 'МАКСИМУМ', en: 'MAX', canonical: SdblKeyword.Max },
        { ru: 'МИНИМУМ', en: 'MIN', canonical: SdblKeyword.Min },
        { ru: 'СРЕДНЕЕ', en: 'AVG', canonical: SdblKeyword.Avg },
      ];

      for (const { ru, en, canonical } of cases) {
        const ruTokens = tokenizeSdbl(ru);
        assert.strictEqual(ruTokens.length, 1);
        assert.strictEqual(ruTokens[0].type, TokenType.Keyword);
        assert.strictEqual(ruTokens[0].raw, ru);
        assert.strictEqual(ruTokens[0].value, canonical);

        const enTokens = tokenizeSdbl(en);
        assert.strictEqual(enTokens.length, 1);
        assert.strictEqual(enTokens[0].type, TokenType.Keyword);
        assert.strictEqual(enTokens[0].raw, en);
        assert.strictEqual(enTokens[0].value, canonical);
      }
    });

    test('tokenizes aggregates in expression context with parentheses', () => {
      const tokens = tokenizeSdbl('СУММА(СуммаДокумента), COUNT(Code_1)');
      assert.strictEqual(tokens[0].type, TokenType.Keyword);
      assert.strictEqual(tokens[0].value, SdblKeyword.Sum);
      assert.strictEqual(tokens[1].type, TokenType.Symbol);
      assert.strictEqual(tokens[1].raw, '(');
      assert.strictEqual(tokens[2].type, TokenType.Identifier);
      assert.strictEqual(tokens[2].raw, 'СуммаДокумента');
      assert.strictEqual(tokens[3].type, TokenType.Symbol);
      assert.strictEqual(tokens[3].raw, ')');
      assert.strictEqual(tokens[4].type, TokenType.Symbol);
      assert.strictEqual(tokens[4].raw, ',');
      assert.strictEqual(tokens[5].type, TokenType.Keyword);
      assert.strictEqual(tokens[5].value, SdblKeyword.Count);
      assert.strictEqual(tokens[6].type, TokenType.Symbol);
      assert.strictEqual(tokens[6].raw, '(');
      assert.strictEqual(tokens[7].type, TokenType.Identifier);
      assert.strictEqual(tokens[7].raw, 'Code_1');
      assert.strictEqual(tokens[8].type, TokenType.Symbol);
      assert.strictEqual(tokens[8].raw, ')');
    });
  });

  suite('Identifiers', () => {
    test('tokenizes Russian identifiers', () => {
      const tokens = tokenizeSdbl('Номенклатура Справочник ТоварыНаСкладах _СлужебныйПоле');
      assert.strictEqual(tokens.length, 4);
      for (const token of tokens) {
        assert.strictEqual(token.type, TokenType.Identifier);
        assert.strictEqual(token.value, token.raw);
      }
      assert.strictEqual(tokens[0].raw, 'Номенклатура');
      assert.strictEqual(tokens[1].raw, 'Справочник');
      assert.strictEqual(tokens[2].raw, 'ТоварыНаСкладах');
      assert.strictEqual(tokens[3].raw, '_СлужебныйПоле');
    });

    test('tokenizes Latin and alphanumeric identifiers', () => {
      const tokens = tokenizeSdbl('Code_1 CatalogItem _item123 v8_Table');
      assert.strictEqual(tokens.length, 4);
      for (const token of tokens) {
        assert.strictEqual(token.type, TokenType.Identifier);
      }
      assert.strictEqual(tokens[0].raw, 'Code_1');
      assert.strictEqual(tokens[1].raw, 'CatalogItem');
      assert.strictEqual(tokens[2].raw, '_item123');
      assert.strictEqual(tokens[3].raw, 'v8_Table');
    });

    test('tokenizes dotted field paths as identifiers and symbols', () => {
      const tokens = tokenizeSdbl('Справочник.Номенклатура.Код');
      assert.strictEqual(tokens.length, 5);
      assert.strictEqual(tokens[0].type, TokenType.Identifier);
      assert.strictEqual(tokens[0].raw, 'Справочник');
      assert.strictEqual(tokens[1].type, TokenType.Symbol);
      assert.strictEqual(tokens[1].raw, '.');
      assert.strictEqual(tokens[2].type, TokenType.Identifier);
      assert.strictEqual(tokens[2].raw, 'Номенклатура');
      assert.strictEqual(tokens[3].type, TokenType.Symbol);
      assert.strictEqual(tokens[3].raw, '.');
      assert.strictEqual(tokens[4].type, TokenType.Identifier);
      assert.strictEqual(tokens[4].raw, 'Код');
    });
  });

  suite('String Literals', () => {
    test('tokenizes simple string literals', () => {
      const tokens = tokenizeSdbl('"строка"');
      assert.strictEqual(tokens.length, 1);
      assert.strictEqual(tokens[0].type, TokenType.StringLiteral);
      assert.strictEqual(tokens[0].raw, '"строка"');
      assert.strictEqual(tokens[0].value, 'строка');
    });

    test('tokenizes empty string literals', () => {
      const tokens = tokenizeSdbl('""');
      assert.strictEqual(tokens.length, 1);
      assert.strictEqual(tokens[0].type, TokenType.StringLiteral);
      assert.strictEqual(tokens[0].raw, '""');
      assert.strictEqual(tokens[0].value, '');
    });

    test('tokenizes strings with escaped quotes ("""внутри кавычки""")', () => {
      const tokens = tokenizeSdbl('"""внутри кавычки"""');
      assert.strictEqual(tokens.length, 1);
      assert.strictEqual(tokens[0].type, TokenType.StringLiteral);
      assert.strictEqual(tokens[0].raw, '"""внутри кавычки"""');
      assert.strictEqual(tokens[0].value, '"внутри кавычки"');
    });

    test('tokenizes strings with embedded doubled quotes', () => {
      const tokens = tokenizeSdbl('"Строка ""1"" и ""2"""');
      assert.strictEqual(tokens.length, 1);
      assert.strictEqual(tokens[0].type, TokenType.StringLiteral);
      assert.strictEqual(tokens[0].raw, '"Строка ""1"" и ""2"""');
      assert.strictEqual(tokens[0].value, 'Строка "1" и "2"');
    });

    test('tokenizes multiline string literal', () => {
      const tokens = tokenizeSdbl('"строка 1\nстрока 2"');
      assert.strictEqual(tokens.length, 1);
      assert.strictEqual(tokens[0].type, TokenType.StringLiteral);
      assert.strictEqual(tokens[0].raw, '"строка 1\nстрока 2"');
      assert.strictEqual(tokens[0].value, 'строка 1\nстрока 2');
    });

    test('handles unclosed string at EOF gracefully', () => {
      const tokens = tokenizeSdbl('"незакрытая');
      assert.strictEqual(tokens.length, 1);
      assert.strictEqual(tokens[0].type, TokenType.StringLiteral);
      assert.strictEqual(tokens[0].raw, '"незакрытая');
      assert.strictEqual(tokens[0].value, 'незакрытая');
    });
  });

  suite('Number Literals', () => {
    test('tokenizes integer literals', () => {
      const tokens = tokenizeSdbl('0 42 100500');
      assert.strictEqual(tokens.length, 3);
      assert.strictEqual(tokens[0].type, TokenType.NumberLiteral);
      assert.strictEqual(tokens[0].raw, '0');
      assert.strictEqual(tokens[0].value, '0');
      assert.strictEqual(tokens[1].raw, '42');
      assert.strictEqual(tokens[2].raw, '100500');
    });

    test('tokenizes floating point literals', () => {
      const tokens = tokenizeSdbl('123.45 0.5 3.14159');
      assert.strictEqual(tokens.length, 3);
      assert.strictEqual(tokens[0].type, TokenType.NumberLiteral);
      assert.strictEqual(tokens[0].raw, '123.45');
      assert.strictEqual(tokens[0].value, '123.45');
      assert.strictEqual(tokens[1].raw, '0.5');
      assert.strictEqual(tokens[2].raw, '3.14159');
    });

    test('distinguishes integer before dot member access from float', () => {
      const tokens = tokenizeSdbl('123.Поле');
      assert.strictEqual(tokens.length, 3);
      assert.strictEqual(tokens[0].type, TokenType.NumberLiteral);
      assert.strictEqual(tokens[0].raw, '123');
      assert.strictEqual(tokens[1].type, TokenType.Symbol);
      assert.strictEqual(tokens[1].raw, '.');
      assert.strictEqual(tokens[2].type, TokenType.Identifier);
      assert.strictEqual(tokens[2].raw, 'Поле');
    });
  });

  suite('Query Parameters', () => {
    test('tokenizes parameters with Russian names: &Организация, &Период', () => {
      const tokens = tokenizeSdbl('&Организация &Период');
      assert.strictEqual(tokens.length, 2);
      assert.strictEqual(tokens[0].type, TokenType.Parameter);
      assert.strictEqual(tokens[0].raw, '&Организация');
      assert.strictEqual(tokens[0].value, 'Организация');

      assert.strictEqual(tokens[1].type, TokenType.Parameter);
      assert.strictEqual(tokens[1].raw, '&Период');
      assert.strictEqual(tokens[1].value, 'Период');
    });

    test('tokenizes parameters with Latin names and underscores', () => {
      const tokens = tokenizeSdbl('&Org_Id &_StartDate');
      assert.strictEqual(tokens.length, 2);
      assert.strictEqual(tokens[0].type, TokenType.Parameter);
      assert.strictEqual(tokens[0].raw, '&Org_Id');
      assert.strictEqual(tokens[0].value, 'Org_Id');

      assert.strictEqual(tokens[1].type, TokenType.Parameter);
      assert.strictEqual(tokens[1].raw, '&_StartDate');
      assert.strictEqual(tokens[1].value, '_StartDate');
    });
  });

  suite('Comments', () => {
    test('tokenizes single-line comments: // комментарий', () => {
      const tokens = tokenizeSdbl('// комментарий\nВЫБРАТЬ');
      assert.strictEqual(tokens.length, 2);
      assert.strictEqual(tokens[0].type, TokenType.Comment);
      assert.strictEqual(tokens[0].raw, '// комментарий');
      assert.strictEqual(tokens[0].value, ' комментарий');

      assert.strictEqual(tokens[1].type, TokenType.Keyword);
      assert.strictEqual(tokens[1].value, SdblKeyword.Select);
    });

    test('tokenizes comment at end of input without trailing newline', () => {
      const tokens = tokenizeSdbl('ВЫБРАТЬ // конец запроса');
      assert.strictEqual(tokens.length, 2);
      assert.strictEqual(tokens[0].type, TokenType.Keyword);
      assert.strictEqual(tokens[1].type, TokenType.Comment);
      assert.strictEqual(tokens[1].raw, '// конец запроса');
    });

    test('can optionally exclude comments', () => {
      const tokens = tokenizeSdbl('// комментарий\nВЫБРАТЬ', { includeComments: false });
      assert.strictEqual(tokens.length, 1);
      assert.strictEqual(tokens[0].type, TokenType.Keyword);
    });
  });

  suite('Special Symbols and Operators', () => {
    test('tokenizes punctuation symbols: , . ; ( )', () => {
      const tokens = tokenizeSdbl(', . ; ( )');
      assert.strictEqual(tokens.length, 5);
      const expected = [',', '.', ';', '(', ')'];
      for (let i = 0; i < expected.length; i++) {
        assert.strictEqual(tokens[i].type, TokenType.Symbol);
        assert.strictEqual(tokens[i].raw, expected[i]);
        assert.strictEqual(tokens[i].value, expected[i]);
      }
    });

    test('tokenizes arithmetic operators: + - * /', () => {
      const tokens = tokenizeSdbl('+ - * /');
      assert.strictEqual(tokens.length, 4);
      const expected = ['+', '-', '*', '/'];
      for (let i = 0; i < expected.length; i++) {
        assert.strictEqual(tokens[i].type, TokenType.Operator);
        assert.strictEqual(tokens[i].raw, expected[i]);
        assert.strictEqual(tokens[i].value, expected[i]);
      }
    });

    test('tokenizes comparison operators: = <> < > <= >=', () => {
      const tokens = tokenizeSdbl('= <> < > <= >=');
      assert.strictEqual(tokens.length, 6);
      const expected = ['=', '<>', '<', '>', '<=', '>='];
      for (let i = 0; i < expected.length; i++) {
        assert.strictEqual(tokens[i].type, TokenType.Operator);
        assert.strictEqual(tokens[i].raw, expected[i]);
        assert.strictEqual(tokens[i].value, expected[i]);
      }
    });
  });

  suite('Whitespace, Newlines, and Position Tracking', () => {
    test('skips spaces, tabs, and newlines properly', () => {
      const text = '   \t  \r\n   ВЫБРАТЬ   \t\n   ИЗ   ';
      const tokens = tokenizeSdbl(text);
      assert.strictEqual(tokens.length, 2);
      assert.strictEqual(tokens[0].value, SdblKeyword.Select);
      assert.strictEqual(tokens[1].value, SdblKeyword.From);
    });

    test('tracks accurate line, column, and offset numbers', () => {
      const text = 'ВЫБРАТЬ\n  Код,\n  Наименование';
      const tokens = tokenizeSdbl(text);
      assert.strictEqual(tokens.length, 4);

      // ВЫБРАТЬ at line 1, column 1, offset 0
      assert.strictEqual(tokens[0].raw, 'ВЫБРАТЬ');
      assert.strictEqual(tokens[0].line, 1);
      assert.strictEqual(tokens[0].column, 1);
      assert.strictEqual(tokens[0].offset, 0);

      // Код at line 2, column 3, offset 10 ('ВЫБРАТЬ\n  ')
      assert.strictEqual(tokens[1].raw, 'Код');
      assert.strictEqual(tokens[1].line, 2);
      assert.strictEqual(tokens[1].column, 3);
      assert.strictEqual(tokens[1].offset, 10);

      // , at line 2, column 6, offset 13
      assert.strictEqual(tokens[2].raw, ',');
      assert.strictEqual(tokens[2].line, 2);
      assert.strictEqual(tokens[2].column, 6);
      assert.strictEqual(tokens[2].offset, 13);

      // Наименование at line 3, column 3, offset 17 ('ВЫБРАТЬ\n  Код,\n  ')
      assert.strictEqual(tokens[3].raw, 'Наименование');
      assert.strictEqual(tokens[3].line, 3);
      assert.strictEqual(tokens[3].column, 3);
      assert.strictEqual(tokens[3].offset, 17);
    });

    test('handles CRLF line endings in position tracking', () => {
      const text = 'ВЫБРАТЬ\r\n  Поле';
      const tokens = tokenizeSdbl(text);
      assert.strictEqual(tokens.length, 2);
      assert.strictEqual(tokens[1].line, 2);
      assert.strictEqual(tokens[1].column, 3);
      assert.strictEqual(tokens[1].offset, 11); // 'ВЫБРАТЬ' (7) + '\r\n' (2) + '  ' (2) = 11
    });
  });

  suite('EOF Token Support', () => {
    test('does not include EOF token by default', () => {
      const tokens = tokenizeSdbl('ВЫБРАТЬ 1');
      assert.strictEqual(tokens.length, 2);
      assert.strictEqual(tokens[tokens.length - 1].type, TokenType.NumberLiteral);
    });

    test('includes EOF token when includeEof is true', () => {
      const text = 'ВЫБРАТЬ 1';
      const tokens = tokenizeSdbl(text, { includeEof: true });
      assert.strictEqual(tokens.length, 3);
      const eof = tokens[2];
      assert.strictEqual(eof.type, TokenType.EOF);
      assert.strictEqual(eof.raw, '');
      assert.strictEqual(eof.value, '');
      assert.strictEqual(eof.offset, text.length);
      assert.strictEqual(eof.line, 1);
      assert.strictEqual(eof.column, 10);
    });

    test('empty string with includeEof returns single EOF token', () => {
      const tokens = tokenizeSdbl('', { includeEof: true });
      assert.strictEqual(tokens.length, 1);
      assert.strictEqual(tokens[0].type, TokenType.EOF);
      assert.strictEqual(tokens[0].line, 1);
      assert.strictEqual(tokens[0].column, 1);
      assert.strictEqual(tokens[0].offset, 0);
    });

    test('empty string without includeEof returns empty array', () => {
      const tokens = tokenizeSdbl('');
      assert.strictEqual(tokens.length, 0);
    });
  });

  suite('Full Realistic SDBL Query', () => {
    test('tokenizes complete realistic query with joins, conditions, groupings, and parameters', () => {
      const query = `
        // Основной запрос остатков
        ВЫБРАТЬ РАЗРЕШЕННЫЕ ПЕРВЫЕ 100
          Номенклатура.Ссылка КАК Ссылка,
          Номенклатура.Код КАК Код,
          СУММА(Остатки.КоличествоОстаток) КАК Остаток
        ИЗ
          Справочник.Номенклатура КАК Номенклатура
          ЛЕВОЕ СОЕДИНЕНИЕ РегистрНакопления.ТоварыНаСкладах.Остатки(&Период, Склад = &Склад) КАК Остатки
          ПО Номенклатура.Ссылка = Остатки.Номенклатура
        ГДЕ
          Номенклатура.ПометкаУдаления = ЛОЖЬ
          И Номенклатура.Цена > 10.5
        СГРУППИРОВАТЬ ПО
          Номенклатура.Ссылка,
          Номенклатура.Код
        УПОРЯДОЧИТЬ ПО
          Номенклатура.Код
        АВТОУПОРЯДОЧИВАНИЕ
      `;

      const tokens = tokenizeSdbl(query);
      assert.ok(tokens.length > 30, 'Should tokenize rich query into many tokens');

      // Check first tokens
      assert.strictEqual(tokens[0].type, TokenType.Comment);
      assert.strictEqual(tokens[1].type, TokenType.Keyword);
      assert.strictEqual(tokens[1].value, SdblKeyword.Select);
      assert.strictEqual(tokens[2].type, TokenType.Keyword);
      assert.strictEqual(tokens[2].value, SdblKeyword.Allowed);
      assert.strictEqual(tokens[3].type, TokenType.Keyword);
      assert.strictEqual(tokens[3].value, SdblKeyword.Top);
      assert.strictEqual(tokens[4].type, TokenType.NumberLiteral);
      assert.strictEqual(tokens[4].value, '100');

      // Check parameter tokens exist
      const params = tokens.filter((t: SdblToken) => t.type === TokenType.Parameter);
      assert.strictEqual(params.length, 2);
      assert.strictEqual(params[0].value, 'Период');
      assert.strictEqual(params[1].value, 'Склад');

      // Check aggregate function token exists
      const sumToken = tokens.find((t: SdblToken) => t.raw === 'СУММА');
      assert.ok(sumToken);
      assert.strictEqual(sumToken.type, TokenType.Keyword);
      assert.strictEqual(sumToken.value, SdblKeyword.Sum);

      // Check compound JOIN keywords
      const leftToken = tokens.find((t: SdblToken) => t.raw === 'ЛЕВОЕ');
      const joinToken = tokens.find((t: SdblToken) => t.raw === 'СОЕДИНЕНИЕ');
      assert.ok(leftToken && joinToken);
      assert.strictEqual(leftToken.value, SdblKeyword.Left);
      assert.strictEqual(joinToken.value, SdblKeyword.Join);
    });
  });
});
