import * as assert from 'assert';
import { parseSdbl } from '../../../src/queryBuilder/sdbl/sdblParser';
import { tokenizeSdbl } from '../../../src/queryBuilder/sdbl/sdblTokenizer';
import {
  AggregateNode,
  BetweenNode,
  BinaryOpNode,
  CaseWhenNode,
  CompoundIdentifierNode,
  DropTableStatement,
  IdentifierNode,
  InNode,
  LikeNode,
  LiteralNode,
  ParameterNode,
  SelectStatement,
  TableSource,
  UnaryOpNode,
} from '../../../src/queryBuilder/sdbl/sdblAst';

suite('SDBL Parser', () => {
  suite('1. Simple SELECT Query', () => {
    test('parses basic SELECT with fields, aliases, and FROM table', () => {
      const sql = 'ВЫБРАТЬ Поле1, Поле2 КАК Алиас ИЗ Справочник.Номенклатура КАК Таб';
      const pkg = parseSdbl(sql);

      assert.strictEqual(pkg.queries.length, 1);
      assert.strictEqual(pkg.queries[0].type, 'Select');

      const select = pkg.queries[0] as SelectStatement;
      assert.strictEqual(select.fields.length, 2);

      const f1 = select.fields[0];
      assert.strictEqual((f1.expression as IdentifierNode).type, 'Identifier');
      assert.strictEqual((f1.expression as IdentifierNode).name, 'Поле1');
      assert.strictEqual(f1.alias, undefined);

      const f2 = select.fields[1];
      assert.strictEqual((f2.expression as IdentifierNode).type, 'Identifier');
      assert.strictEqual((f2.expression as IdentifierNode).name, 'Поле2');
      assert.strictEqual(f2.alias, 'Алиас');

      assert.ok(select.from);
      assert.strictEqual(select.from.length, 1);
      const fromItem = select.from[0];
      assert.strictEqual(fromItem.source.type, 'Table');
      assert.strictEqual((fromItem.source as TableSource).name, 'Справочник.Номенклатура');
      assert.strictEqual(fromItem.alias, 'Таб');
    });

    test('parses compound field identifier Таблица.Поле', () => {
      const sql = 'ВЫБРАТЬ Номенклатура.Наименование КАК Название ИЗ Справочник.Номенклатура КАК Номенклатура';
      const pkg = parseSdbl(sql);
      const select = pkg.queries[0] as SelectStatement;

      const f = select.fields[0];
      assert.strictEqual((f.expression as CompoundIdentifierNode).type, 'CompoundIdentifier');
      assert.deepStrictEqual((f.expression as CompoundIdentifierNode).parts, ['Номенклатура', 'Наименование']);
      assert.strictEqual(f.alias, 'Название');
    });
  });

  suite('2. Modifiers (TOP, ALLOWED, DISTINCT, FOR UPDATE)', () => {
    test('parses ПЕРВЫЕ, РАЗРЕШЕННЫЕ, РАЗЛИЧНЫЕ and ДЛЯ ИЗМЕНЕНИЯ', () => {
      const sql = 'ВЫБРАТЬ ПЕРВЫЕ 10 РАЗРЕШЕННЫЕ РАЗЛИЧНЫЕ Поле1 ИЗ Документ.Заказ ДЛЯ ИЗМЕНЕНИЯ';
      const pkg = parseSdbl(sql);
      const select = pkg.queries[0] as SelectStatement;

      assert.strictEqual(select.top, 10);
      assert.strictEqual(select.allowed, true);
      assert.strictEqual(select.distinct, true);
      assert.strictEqual(select.forUpdate, true);
    });

    test('parses english modifiers TOP, ALLOWED, DISTINCT, FOR UPDATE', () => {
      const sql = 'SELECT TOP 25 ALLOWED DISTINCT Field1 FROM Document.Order FOR UPDATE';
      const pkg = parseSdbl(sql);
      const select = pkg.queries[0] as SelectStatement;

      assert.strictEqual(select.top, 25);
      assert.strictEqual(select.allowed, true);
      assert.strictEqual(select.distinct, true);
      assert.strictEqual(select.forUpdate, true);
    });

    test('parses ДЛЯ ИЗМЕНЕНИЯ without tables', () => {
      const sql = 'ВЫБРАТЬ * ИЗ Справочник.Товары КАК Товары ДЛЯ ИЗМЕНЕНИЯ';
      const pkg = parseSdbl(sql);
      const select = pkg.queries[0] as SelectStatement;

      assert.strictEqual(select.forUpdate, true);
      assert.strictEqual(select.forUpdateTables, undefined);
    });

    test('parses ДЛЯ ИЗМЕНЕНИЯ with table list', () => {
      const sql = 'ВЫБРАТЬ * ИЗ Справочник.Товары КАК Товары ДЛЯ ИЗМЕНЕНИЯ Товары, Склады';
      const pkg = parseSdbl(sql);
      const select = pkg.queries[0] as SelectStatement;

      assert.strictEqual(select.forUpdate, true);
      assert.deepStrictEqual(select.forUpdateTables, ['Товары', 'Склады']);
    });
  });

  suite('3. Temp Tables and Indexes (ПОМЕСТИТЬ, ИНДЕКСИРОВАТЬ ПО)', () => {
    test('parses ПОМЕСТИТЬ with ИНДЕКСИРОВАТЬ ПО', () => {
      const sql = 'ВЫБРАТЬ Код, Наименование ПОМЕСТИТЬ ВТТовары ИНДЕКСИРОВАТЬ ПО Код, Наименование ИЗ Справочник.Номенклатура';
      const pkg = parseSdbl(sql);
      const select = pkg.queries[0] as SelectStatement;

      assert.strictEqual(select.into, 'ВТТовары');
      assert.deepStrictEqual(select.indexBy, ['Код', 'Наименование']);
      assert.strictEqual(select.fields.length, 2);
    });

    test('parses INTO with INDEX ON in English', () => {
      const sql = 'SELECT Id, Name INTO TempTable INDEX ON Id, Name FROM Catalog.Items';
      const pkg = parseSdbl(sql);
      const select = pkg.queries[0] as SelectStatement;

      assert.strictEqual(select.into, 'TempTable');
      assert.deepStrictEqual(select.indexBy, ['Id', 'Name']);
    });

    test('parses canonical position of ИНДЕКСИРОВАТЬ ПО after FROM, WHERE, GROUP BY, HAVING', () => {
      const sql = `
        ВЫБРАТЬ
          Код,
          Наименование
        ПОМЕСТИТЬ ВТТовары
        ИЗ
          Справочник.Номенклатура
        ГДЕ
          Код > 100
        СГРУППИРОВАТЬ ПО
          Код,
          Наименование
        ИМЕЮЩИЕ
          КОЛИЧЕСТВО(Код) > 1
        ИНДЕКСИРОВАТЬ ПО
          Код,
          Наименование
      `;
      const pkg = parseSdbl(sql);
      const select = pkg.queries[0] as SelectStatement;

      assert.strictEqual(select.into, 'ВТТовары');
      assert.deepStrictEqual(select.indexBy, ['Код', 'Наименование']);
      assert.ok(select.where);
      assert.ok(select.groupBy);
      assert.ok(select.having);
    });

    test('parses canonical position of INDEX BY after FROM in English', () => {
      const sql = 'SELECT Id, Name INTO TempTable FROM Catalog.Items WHERE Id > 100 INDEX BY Id, Name';
      const pkg = parseSdbl(sql);
      const select = pkg.queries[0] as SelectStatement;

      assert.strictEqual(select.into, 'TempTable');
      assert.deepStrictEqual(select.indexBy, ['Id', 'Name']);
    });
  });

  suite('4. Drop Table (УНИЧТОЖИТЬ / DROP)', () => {
    test('parses УНИЧТОЖИТЬ statement', () => {
      const sql = 'УНИЧТОЖИТЬ ВТТовары';
      const pkg = parseSdbl(sql);

      assert.strictEqual(pkg.queries.length, 1);
      assert.strictEqual(pkg.queries[0].type, 'DropTable');
      const drop = pkg.queries[0] as DropTableStatement;
      assert.strictEqual(drop.tableName, 'ВТТовары');
    });

    test('parses DROP statement in English', () => {
      const sql = 'DROP TempItems';
      const pkg = parseSdbl(sql);

      assert.strictEqual(pkg.queries.length, 1);
      assert.strictEqual(pkg.queries[0].type, 'DropTable');
      const drop = pkg.queries[0] as DropTableStatement;
      assert.strictEqual(drop.tableName, 'TempItems');
    });
  });

  suite('5. Query Packages (Multi-query separated by semicolon)', () => {
    test('parses multi-statement query package', () => {
      const sql = `
        ВЫБРАТЬ Ссылка, Код ПОМЕСТИТЬ ВТ ИЗ Справочник.Номенклатура;
        ВЫБРАТЬ * ИЗ ВТ;
        УНИЧТОЖИТЬ ВТ;
      `;
      const pkg = parseSdbl(sql);

      assert.strictEqual(pkg.queries.length, 3);
      assert.strictEqual(pkg.queries[0].type, 'Select');
      assert.strictEqual((pkg.queries[0] as SelectStatement).into, 'ВТ');

      assert.strictEqual(pkg.queries[1].type, 'Select');
      assert.strictEqual((pkg.queries[1] as SelectStatement).from![0].source.type, 'Table');
      assert.strictEqual(((pkg.queries[1] as SelectStatement).from![0].source as TableSource).name, 'ВТ');

      assert.strictEqual(pkg.queries[2].type, 'DropTable');
      assert.strictEqual((pkg.queries[2] as DropTableStatement).tableName, 'ВТ');
    });
  });

  suite('6. Virtual Tables with Parameters', () => {
    test('parses virtual table with parameter expressions in parentheses', () => {
      const sql = 'ВЫБРАТЬ КоличествоОстаток ИЗ РегистрНакопления.ТоварыНаСкладах.Остатки(&Период, Организация = &Орг) КАК Таб';
      const pkg = parseSdbl(sql);
      const select = pkg.queries[0] as SelectStatement;

      const source = select.from![0].source as TableSource;
      assert.strictEqual(source.type, 'Table');
      assert.strictEqual(source.name, 'РегистрНакопления.ТоварыНаСкладах.Остатки');
      assert.ok(source.params);
      assert.strictEqual(source.params.length, 2);

      const p0 = source.params[0] as ParameterNode;
      assert.strictEqual(p0.type, 'Parameter');
      assert.strictEqual(p0.name, 'Период');

      const p1 = source.params[1] as BinaryOpNode;
      assert.strictEqual(p1.type, 'BinaryOp');
      assert.strictEqual(p1.operator, '=');
      assert.strictEqual((p1.left as IdentifierNode).name, 'Организация');
      assert.strictEqual((p1.right as ParameterNode).name, 'Орг');
    });

    test('parses virtual table with empty/omitted parameters: Регистр.Остатки(, Склад = &Склад)', () => {
      const sql = 'ВЫБРАТЬ Остаток ИЗ Регистр.Остатки(, Склад = &Склад)';
      const pkg = parseSdbl(sql);
      const select = pkg.queries[0] as SelectStatement;
      const source = select.from![0].source as TableSource;

      assert.strictEqual(source.name, 'Регистр.Остатки');
      assert.ok(source.params);
      assert.strictEqual(source.params.length, 2);
      assert.strictEqual((source.params[1] as BinaryOpNode).operator, '=');
    });
  });

  suite('7. Joins (LEFT, RIGHT, FULL, INNER)', () => {
    test('parses all join types: ЛЕВОЕ, ПРАВОЕ, ПОЛНОЕ, ВНУТРЕННЕЕ with ON conditions', () => {
      const sql = `
        ВЫБРАТЬ
          Т1.Код, Т2.Сумма, Т3.Номер, Т4.Дата
        ИЗ
          Справочник.Номенклатура КАК Т1
          ЛЕВОЕ СОЕДИНЕНИЕ Документ.Заказ КАК Т2 ПО Т1.Ссылка = Т2.Номенклатура
          ПРАВОЕ СОЕДИНЕНИЕ Регистр.Остатки КАК Т3 ПО Т1.Ссылка = Т3.Товар
          ПОЛНОЕ ВНЕШНЕЕ СОЕДИНЕНИЕ Регистр.Продажи КАК Т4 ПО Т1.Ссылка = Т4.Товар
          ВНУТРЕННЕЕ СОЕДИНЕНИЕ Справочник.Склады КАК Т5 ПО Т1.Склад = Т5.Ссылка
      `;
      const pkg = parseSdbl(sql);
      const select = pkg.queries[0] as SelectStatement;
      const fromItem = select.from![0];

      assert.ok(fromItem.joins);
      assert.strictEqual(fromItem.joins.length, 4);

      assert.strictEqual(fromItem.joins[0].joinType, 'Left');
      assert.strictEqual((fromItem.joins[0].source as TableSource).name, 'Документ.Заказ');
      assert.strictEqual(fromItem.joins[0].alias, 'Т2');
      assert.strictEqual(fromItem.joins[0].on.type, 'BinaryOp');

      assert.strictEqual(fromItem.joins[1].joinType, 'Right');
      assert.strictEqual((fromItem.joins[1].source as TableSource).name, 'Регистр.Остатки');
      assert.strictEqual(fromItem.joins[1].alias, 'Т3');

      assert.strictEqual(fromItem.joins[2].joinType, 'Full');
      assert.strictEqual((fromItem.joins[2].source as TableSource).name, 'Регистр.Продажи');
      assert.strictEqual(fromItem.joins[2].alias, 'Т4');

      assert.strictEqual(fromItem.joins[3].joinType, 'Inner');
      assert.strictEqual((fromItem.joins[3].source as TableSource).name, 'Справочник.Склады');
      assert.strictEqual(fromItem.joins[3].alias, 'Т5');
    });

    test('parses joins without explicit INNER or OUTER: СОЕДИНЕНИЕ / JOIN', () => {
      const sql = 'ВЫБРАТЬ Т1.Код ИЗ Таб1 КАК Т1 СОЕДИНЕНИЕ Таб2 КАК Т2 ПО Т1.Id = Т2.Id';
      const pkg = parseSdbl(sql);
      const select = pkg.queries[0] as SelectStatement;

      assert.strictEqual(select.from![0].joins![0].joinType, 'Inner');
    });
  });

  suite('8. Conditions: WHERE and HAVING (AND, OR, NOT, IN, BETWEEN, LIKE, IS NULL)', () => {
    test('parses complex WHERE with AND, OR, NOT and comparison operators', () => {
      const sql = `
        ВЫБРАТЬ Поле ИЗ Таблица
        ГДЕ
          (Поле > 10 ИЛИ Поле <= 5)
          И НЕ ПометкаУдаления = ИСТИНА
          И Цена <> 0
      `;
      const pkg = parseSdbl(sql);
      const select = pkg.queries[0] as SelectStatement;

      assert.ok(select.where);
      assert.strictEqual(select.where.type, 'BinaryOp');
      assert.strictEqual((select.where as BinaryOpNode).operator, 'AND');
    });

    test('parses IN and IN HIERARCHY (В, В ИЕРАРХИИ, НЕ В)', () => {
      const sql = 'ВЫБРАТЬ Поле ИЗ Таблица ГДЕ Номенклатура В (&СписокНоменклатуры) И Группа В ИЕРАРХИИ (&Родитель) И Категория НЕ В (1, 2, 3)';
      const pkg = parseSdbl(sql);
      const select = pkg.queries[0] as SelectStatement;

      const where = select.where as BinaryOpNode;
      assert.ok(where);

      // Verify that IN nodes are properly structured
      const inNodes: InNode[] = [];
      function collectIn(node: any) {
        if (!node) return;
        if (node.type === 'In') inNodes.push(node);
        if (node.left) collectIn(node.left);
        if (node.right) collectIn(node.right);
      }
      collectIn(where);

      assert.strictEqual(inNodes.length, 3);
      const hierarchyNode = inNodes.find((n) => n.inHierarchy === true);
      assert.ok(hierarchyNode, 'Should find IN HIERARCHY node');

      const notInNode = inNodes.find((n) => n.not === true);
      assert.ok(notInNode, 'Should find NOT IN node');
      assert.strictEqual((notInNode.values as any[]).length, 3);

      const simpleInNode = inNodes.find((n) => !n.inHierarchy && !n.not);
      assert.ok(simpleInNode, 'Should find simple IN node');
    });

    test('parses BETWEEN / МЕЖДУ ... И ...', () => {
      const sql = 'ВЫБРАТЬ Поле ИЗ Таблица ГДЕ Дата МЕЖДУ &ДатаНачала И &ДатаКонца';
      const pkg = parseSdbl(sql);
      const select = pkg.queries[0] as SelectStatement;

      const between = select.where as BetweenNode;
      assert.strictEqual(between.type, 'Between');
      assert.strictEqual((between.expression as IdentifierNode).name, 'Дата');
      assert.strictEqual((between.from as ParameterNode).name, 'ДатаНачала');
      assert.strictEqual((between.to as ParameterNode).name, 'ДатаКонца');
      assert.strictEqual(between.not, undefined);
    });

    test('parses LIKE / ПОДОБНО with optional ESCAPE / СПЕЦСИМВОЛ', () => {
      const sql = 'ВЫБРАТЬ Поле ИЗ Таблица ГДЕ Наименование ПОДОБНО "%товар%" СПЕЦСИМВОЛ "\\"';
      const pkg = parseSdbl(sql);
      const select = pkg.queries[0] as SelectStatement;

      const like = select.where as LikeNode;
      assert.strictEqual(like.type, 'Like');
      assert.strictEqual((like.expression as IdentifierNode).name, 'Наименование');
      assert.strictEqual((like.pattern as LiteralNode).value, '%товар%');
      assert.strictEqual((like.escape as LiteralNode).value, '\\');
    });

    test('parses IS NULL / ЕСТЬ NULL and IS NOT NULL / ЕСТЬ НЕ NULL', () => {
      const sql = 'ВЫБРАТЬ Поле ИЗ Таблица ГДЕ Поле1 ЕСТЬ NULL И Поле2 ЕСТЬ НЕ NULL';
      const pkg = parseSdbl(sql);
      const select = pkg.queries[0] as SelectStatement;

      const where = select.where as BinaryOpNode;
      assert.strictEqual(where.type, 'BinaryOp');
    });

    test('parses HAVING / ИМЕЮЩИЕ clause', () => {
      const sql = 'ВЫБРАТЬ Номенклатура, СУММА(Сумма) КАК Всего ИЗ Таб СГРУППИРОВАТЬ ПО Номенклатура ИМЕЮЩИЕ СУММА(Сумма) > 1000';
      const pkg = parseSdbl(sql);
      const select = pkg.queries[0] as SelectStatement;

      assert.ok(select.having);
      assert.strictEqual(select.having.type, 'BinaryOp');
      const having = select.having as BinaryOpNode;
      assert.strictEqual(having.operator, '>');
      assert.strictEqual((having.left as AggregateNode).aggregateType, 'Sum');
      assert.strictEqual((having.right as LiteralNode).value, 1000);
    });
  });

  suite('9. Grouping and Aggregates', () => {
    test('parses GROUP BY with multiple expressions and aggregate functions', () => {
      const sql = `
        ВЫБРАТЬ
          Склад,
          Номенклатура,
          СУММА(Количество) КАК ОбщКол,
          КОЛИЧЕСТВО(РАЗЛИЧНЫЕ Документ) КАК КолДок,
          СРЕДНЕЕ(Цена) КАК СредЦена,
          МИНИМУМ(Цена) КАК МинЦена,
          МАКСИМУМ(Цена) КАК МаксЦена,
          КОЛИЧЕСТВО(*) КАК ВсегоСтрок
        ИЗ
          Регистр.Продажи
        СГРУППИРОВАТЬ ПО
          Склад,
          Номенклатура
      `;
      const pkg = parseSdbl(sql);
      const select = pkg.queries[0] as SelectStatement;

      assert.ok(select.groupBy);
      assert.strictEqual(select.groupBy.length, 2);
      assert.strictEqual((select.groupBy[0] as IdentifierNode).name, 'Склад');
      assert.strictEqual((select.groupBy[1] as IdentifierNode).name, 'Номенклатура');

      const aggSum = select.fields[2].expression as AggregateNode;
      assert.strictEqual(aggSum.type, 'Aggregate');
      assert.strictEqual(aggSum.aggregateType, 'Sum');

      const aggCountDist = select.fields[3].expression as AggregateNode;
      assert.strictEqual(aggCountDist.aggregateType, 'Count');
      assert.strictEqual(aggCountDist.distinct, true);

      const aggAvg = select.fields[4].expression as AggregateNode;
      assert.strictEqual(aggAvg.aggregateType, 'Avg');

      const aggMin = select.fields[5].expression as AggregateNode;
      assert.strictEqual(aggMin.aggregateType, 'Min');

      const aggMax = select.fields[6].expression as AggregateNode;
      assert.strictEqual(aggMax.aggregateType, 'Max');

      const aggStar = select.fields[7].expression as AggregateNode;
      assert.strictEqual(aggStar.aggregateType, 'Count');
    });
  });

  suite('10. CASE WHEN / ВЫБОР КОГДА', () => {
    test('parses CASE WHEN THEN ELSE END expression', () => {
      const sql = `
        ВЫБРАТЬ
          ВЫБОР
            КОГДА Сумма > 1000 ТОГДА "VIP"
            КОГДА Сумма > 500 ТОГДА "Standard"
            ИНАЧЕ "Economy"
          КОНЕЦ КАК Категория
        ИЗ Документ.Заказ
      `;
      const pkg = parseSdbl(sql);
      const select = pkg.queries[0] as SelectStatement;

      const caseWhen = select.fields[0].expression as CaseWhenNode;
      assert.strictEqual(caseWhen.type, 'CaseWhen');
      assert.strictEqual(caseWhen.cases.length, 2);

      assert.strictEqual(caseWhen.cases[0].when.type, 'BinaryOp');
      assert.strictEqual((caseWhen.cases[0].then as LiteralNode).value, 'VIP');

      assert.strictEqual(caseWhen.cases[1].when.type, 'BinaryOp');
      assert.strictEqual((caseWhen.cases[1].then as LiteralNode).value, 'Standard');

      assert.ok(caseWhen.else);
      assert.strictEqual((caseWhen.else as LiteralNode).value, 'Economy');
    });
  });

  suite('11. Subqueries (in FROM and in WHERE)', () => {
    test('parses subquery in FROM clause', () => {
      const sql = 'ВЫБРАТЬ Вложенный.Код ИЗ (ВЫБРАТЬ Код, Наименование ИЗ Справочник.Номенклатура) КАК Вложенный';
      const pkg = parseSdbl(sql);
      const select = pkg.queries[0] as SelectStatement;

      assert.strictEqual(select.from![0].source.type, 'Subquery');
      const sub = select.from![0].source as any;
      assert.strictEqual(sub.query.type, 'Select');
      assert.strictEqual(sub.query.fields.length, 2);
      assert.strictEqual(select.from![0].alias, 'Вложенный');
    });

    test('parses subquery inside WHERE IN condition', () => {
      const sql = 'ВЫБРАТЬ Ссылка ИЗ Справочник.Номенклатура ГДЕ Ссылка В (ВЫБРАТЬ Номенклатура ИЗ Документ.Заказ)';
      const pkg = parseSdbl(sql);
      const select = pkg.queries[0] as SelectStatement;

      const inNode = select.where as InNode;
      assert.strictEqual(inNode.type, 'In');
      assert.strictEqual((inNode.expression as IdentifierNode).name, 'Ссылка');
      assert.ok(!Array.isArray(inNode.values));
      assert.strictEqual((inNode.values as SelectStatement).type, 'Select');
    });
  });

  suite('12. UNION and UNION ALL', () => {
    test('parses UNION and UNION ALL', () => {
      const sql = `
        ВЫБРАТЬ 1 КАК Номер ИЗ Справочник.Склады
        ОБЪЕДИНИТЬ
        ВЫБРАТЬ 2 КАК Номер ИЗ Справочник.Склады
        ОБЪЕДИНИТЬ ВСЕ
        ВЫБРАТЬ 3 КАК Номер ИЗ Справочник.Склады
      `;
      const pkg = parseSdbl(sql);
      assert.strictEqual(pkg.queries.length, 1);

      const select = pkg.queries[0] as SelectStatement;
      assert.ok(select.unions);
      assert.strictEqual(select.unions.length, 2);

      assert.strictEqual(select.unions[0].unionType, 'Union');
      assert.strictEqual(select.unions[0].statement.type, 'Select');

      assert.strictEqual(select.unions[1].unionType, 'UnionAll');
      assert.strictEqual(select.unions[1].statement.type, 'Select');
    });
  });

  suite('13. ORDER BY and AUTOORDER', () => {
    test('parses ORDER BY with ASC, DESC and AUTOORDER', () => {
      const sql = 'ВЫБРАТЬ Код, Наименование ИЗ Справочник.Номенклатура УПОРЯДОЧИТЬ ПО Код ВОЗР, Наименование УБЫВ АВТОУПОРЯДОЧИВАНИЕ';
      const pkg = parseSdbl(sql);
      const select = pkg.queries[0] as SelectStatement;

      assert.ok(select.orderBy);
      assert.strictEqual(select.orderBy.length, 2);

      assert.strictEqual((select.orderBy[0].expression as IdentifierNode).name, 'Код');
      assert.strictEqual(select.orderBy[0].direction, 'Asc');

      assert.strictEqual((select.orderBy[1].expression as IdentifierNode).name, 'Наименование');
      assert.strictEqual(select.orderBy[1].direction, 'Desc');

      assert.strictEqual(select.autoOrder, true);
    });
  });

  suite('14. TOTALS (ИТОГИ)', () => {
    test('parses TOTALS with aggregates, OVERALL, HIERARCHY, and PERIODS', () => {
      const sql = `
        ВЫБРАТЬ
          Номенклатура,
          Период,
          Сумма
        ИЗ
          Регистр.Продажи
        ИТОГИ
          СУММА(Сумма)
        ПО
          ОБЩИЕ,
          Номенклатура ИЕРАРХИЯ,
          Период ПЕРИОДАМИ
      `;
      const pkg = parseSdbl(sql);
      const select = pkg.queries[0] as SelectStatement;

      assert.ok(select.totals);
      assert.strictEqual(select.totals.overall, true);

      assert.ok(select.totals.fields);
      assert.strictEqual(select.totals.fields.length, 1);
      assert.strictEqual((select.totals.fields[0].expression as AggregateNode).aggregateType, 'Sum');

      assert.strictEqual(select.totals.by.length, 2);
      assert.strictEqual((select.totals.by[0].expression as IdentifierNode).name, 'Номенклатура');
      assert.strictEqual(select.totals.by[0].hierarchy, true);

      assert.strictEqual((select.totals.by[1].expression as IdentifierNode).name, 'Период');
      assert.strictEqual(select.totals.by[1].periods, true);
    });

    test('parses TOTALS with ТОЛЬКО ИЕРАРХИЯ and ПЕРИОДАМИ(ДЕНЬ,,) (P2.20)', () => {
      const sql = `
        ВЫБРАТЬ
          Номенклатура,
          Период,
          Сумма
        ИЗ
          Регистр.Продажи
        ИТОГИ
          СУММА(Сумма)
        ПО
          Номенклатура ТОЛЬКО ИЕРАРХИЯ,
          Период ПЕРИОДАМИ(ДЕНЬ,,)
      `;
      const pkg = parseSdbl(sql);
      const select = pkg.queries[0] as SelectStatement;

      assert.ok(select.totals);
      assert.strictEqual(select.totals.by.length, 2);

      const byItem0 = select.totals.by[0];
      assert.strictEqual((byItem0.expression as IdentifierNode).name, 'Номенклатура');
      assert.strictEqual(byItem0.hierarchy, true);
      assert.strictEqual(byItem0.hierarchyType, 'OnlyHierarchy');

      const byItem1 = select.totals.by[1];
      assert.strictEqual((byItem1.expression as IdentifierNode).name, 'Период');
      assert.strictEqual(byItem1.period, true);
      assert.ok(byItem1.periodDefinition);
      assert.strictEqual(byItem1.periodDefinition.periodType, 'ДЕНЬ');
      assert.strictEqual(byItem1.periodDefinition.from, undefined);
      assert.strictEqual(byItem1.periodDefinition.to, undefined);
    });

    test('parses ПЕРИОДАМИ(ДЕНЬ, &Нач, &Кон) with parameters (P2.20)', () => {
      const sql = 'ВЫБРАТЬ Поле ИЗ Таб ИТОГИ ПО Период ПЕРИОДАМИ(ДЕНЬ, &Нач, &Кон)';
      const pkg = parseSdbl(sql);
      const select = pkg.queries[0] as SelectStatement;

      assert.ok(select.totals);
      assert.strictEqual(select.totals.by.length, 1);
      const def = select.totals.by[0].periodDefinition;
      assert.ok(def);
      assert.strictEqual(def.periodType, 'ДЕНЬ');
      assert.strictEqual((def.from as ParameterNode)?.name, 'Нач');
      assert.strictEqual((def.to as ParameterNode)?.name, 'Кон');
    });

    test('parses English ONLY HIERARCHY and PERIODS(DAY, &Start, &End) (P2.20)', () => {
      const sql = 'SELECT Item FROM Items TOTALS BY Item ONLY HIERARCHY, Period PERIODS(DAY, &Start, &End)';
      const pkg = parseSdbl(sql);
      const select = pkg.queries[0] as SelectStatement;

      assert.ok(select.totals);
      assert.strictEqual(select.totals.by.length, 2);
      assert.strictEqual(select.totals.by[0].hierarchyType, 'OnlyHierarchy');
      assert.strictEqual(select.totals.by[1].periodDefinition?.periodType, 'DAY');
    });
  });

  suite('15. English Syntax Query', () => {
    test('parses full query in English syntax', () => {
      const sql = `
        SELECT TOP 5 DISTINCT
          c.Code AS Code,
          b.Amount AS Amount
        FROM
          Catalog.Items AS c
          LEFT JOIN Register.Balance AS b ON c.Ref = b.Item
        WHERE
          b.Amount > 0
        GROUP BY
          c.Code,
          b.Amount
        ORDER BY
          c.Code ASC
        AUTOORDER
      `;
      const pkg = parseSdbl(sql);
      const select = pkg.queries[0] as SelectStatement;

      assert.strictEqual(select.top, 5);
      assert.strictEqual(select.distinct, true);
      assert.strictEqual(select.fields.length, 2);
      assert.strictEqual(select.from![0].source.type, 'Table');
      assert.strictEqual((select.from![0].source as TableSource).name, 'Catalog.Items');
      assert.strictEqual(select.from![0].joins![0].joinType, 'Left');
      assert.ok(select.where);
      assert.strictEqual(select.groupBy!.length, 2);
      assert.strictEqual(select.orderBy![0].direction, 'Asc');
      assert.strictEqual(select.autoOrder, true);
    });
  });

  suite('16. Accepts Pre-tokenized Token Array', () => {
    test('accepts SdblToken array as input', () => {
      const tokens = tokenizeSdbl('ВЫБРАТЬ 1');
      const pkg = parseSdbl(tokens);

      assert.strictEqual(pkg.queries.length, 1);
      const select = pkg.queries[0] as SelectStatement;
      assert.strictEqual(select.fields.length, 1);
      assert.strictEqual((select.fields[0].expression as LiteralNode).value, 1);
    });
  });

  suite('17. Rejection of ON/BY/JOIN as implicit aliases (Finding 4)', () => {
    test('ИТОГИ СУММА(A) ПО A does not treat ПО as alias', () => {
      const sql = 'ВЫБРАТЬ A ИЗ T ИТОГИ СУММА(A) ПО A';
      const pkg = parseSdbl(sql);
      const select = pkg.queries[0] as SelectStatement;

      assert.ok(select.totals);
      assert.strictEqual(select.totals.fields?.length, 1);
      assert.strictEqual(select.totals.fields[0].alias, undefined, 'Aggregate field must not have alias ПО');
      assert.strictEqual(select.totals.by.length, 1);
      assert.strictEqual((select.totals.by[0].expression as IdentifierNode).name, 'A');
    });

    test('ЛЕВОЕ СОЕДИНЕНИЕ U ПО T.A = U.A does not treat ПО as table alias', () => {
      const sql = 'ВЫБРАТЬ T.A ИЗ T КАК T ЛЕВОЕ СОЕДИНЕНИЕ U ПО T.A = U.A';
      const pkg = parseSdbl(sql);
      const select = pkg.queries[0] as SelectStatement;

      assert.ok(select.from);
      const joins = select.from[0].joins;
      assert.ok(joins);
      assert.strictEqual(joins.length, 1);
      assert.strictEqual((joins[0].source as TableSource).name, 'U');
      assert.strictEqual(joins[0].alias, undefined, 'Join table source must not have alias ПО');
    });

    test('English TOTALS SUM(A) BY A does not treat BY as alias', () => {
      const sql = 'SELECT A FROM T TOTALS SUM(A) BY A';
      const pkg = parseSdbl(sql);
      const select = pkg.queries[0] as SelectStatement;

      assert.ok(select.totals);
      assert.strictEqual(select.totals.fields?.length, 1);
      assert.strictEqual(select.totals.fields[0].alias, undefined, 'Aggregate field must not have alias BY');
      assert.strictEqual(select.totals.by.length, 1);
      assert.strictEqual((select.totals.by[0].expression as IdentifierNode).name, 'A');
    });

    test('English LEFT JOIN U ON T.A = U.A does not treat ON as table alias', () => {
      const sql = 'SELECT T.A FROM T AS T LEFT JOIN U ON T.A = U.A';
      const pkg = parseSdbl(sql);
      const select = pkg.queries[0] as SelectStatement;

      assert.ok(select.from);
      const joins = select.from[0].joins;
      assert.ok(joins);
      assert.strictEqual(joins.length, 1);
      assert.strictEqual((joins[0].source as TableSource).name, 'U');
      assert.strictEqual(joins[0].alias, undefined, 'Join table source must not have alias ON');
    });
  });
});
