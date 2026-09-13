import * as assert from 'assert';
import {
  ExpressionNode,
  CompoundIdentifierNode,
  IdentifierNode,
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
  SelectStatement,
} from '../../../src/queryBuilder/sdbl/sdblAst';
import {
  traverseExpression,
  transformExpression,
  replaceAliasInExpression,
  replaceAliasInRawString,
  isAggregateExpression,
  extractParametersFromExpression,
} from '../../../src/queryBuilder/sdbl/sdblAstVisitor';
import { parseSdbl } from '../../../src/queryBuilder/sdbl/sdblParser';
import { extractParameters } from '../../../src/queryBuilder/sdbl/sdblFormatter';

suite('SDBL AST Visitor & Expression Transformers', () => {
  test('traverseExpression visits all 13 AST node types without omission', () => {
    const visitedTypes: string[] = [];

    const complexExpr: ExpressionNode = {
      type: 'CaseWhen',
      cases: [
        {
          when: {
            type: 'BinaryOp',
            operator: 'AND',
            left: {
              type: 'In',
              expression: { type: 'CompoundIdentifier', parts: ['T', 'Category'] },
              values: [
                { type: 'Literal', valueType: 'string', value: 'Cat1', raw: '"Cat1"' },
                { type: 'Parameter', name: 'Param1' },
              ],
            },
            right: {
              type: 'Between',
              expression: { type: 'Identifier', name: 'Score' },
              from: { type: 'Literal', valueType: 'number', value: 10, raw: '10' },
              to: { type: 'Literal', valueType: 'number', value: 50, raw: '50' },
            },
          },
          then: {
            type: 'FunctionCall',
            name: 'SUBSTRING',
            args: [
              {
                type: 'UnaryOp',
                operator: '-',
                operand: {
                  type: 'Aggregate',
                  aggregateType: 'Sum',
                  expression: { type: 'CompoundIdentifier', parts: ['T', 'Amount'] },
                },
              },
              { type: 'Literal', valueType: 'number', value: 1, raw: '1' },
            ],
          },
        },
      ],
      else: {
        type: 'Like',
        expression: { type: 'RawExpression', raw: 'T.Description' },
        pattern: { type: 'Literal', valueType: 'string', value: '%text%', raw: '"%text%"' },
        escape: { type: 'Literal', valueType: 'string', value: '\\', raw: '"\\"' },
      },
    };

    traverseExpression(complexExpr, {
      enter: (node: ExpressionNode) => {
        if (!visitedTypes.includes(node.type)) {
          visitedTypes.push(node.type);
        }
      },
    });

    const expectedAll13Types = [
      'CaseWhen',
      'BinaryOp',
      'In',
      'CompoundIdentifier',
      'Literal',
      'Parameter',
      'Between',
      'Identifier',
      'FunctionCall',
      'UnaryOp',
      'Aggregate',
      'Like',
      'RawExpression',
    ];

    for (const expectedType of expectedAll13Types) {
      assert.ok(
        visitedTypes.includes(expectedType),
        `traverseExpression must visit ${expectedType}. Visited: ${visitedTypes.join(', ')}`
      );
    }
  });

  test('transformExpression creates updated clones with structural integrity', () => {
    const expr: ExpressionNode = {
      type: 'BinaryOp',
      operator: '=',
      left: { type: 'CompoundIdentifier', parts: ['OldTable', 'FieldA'] },
      right: { type: 'Literal', valueType: 'number', value: 42, raw: '42' },
    };

    const transformed = transformExpression(expr, (node: ExpressionNode) => {
      if (node.type === 'CompoundIdentifier' && node.parts[0] === 'OldTable') {
        return {
          ...node,
          parts: ['NewTable', ...node.parts.slice(1)],
        };
      }
      return node;
    });

    assert.strictEqual(transformed.type, 'BinaryOp');
    if (transformed.type === 'BinaryOp') {
      assert.strictEqual(transformed.left.type, 'CompoundIdentifier');
      if (transformed.left.type === 'CompoundIdentifier') {
        assert.deepStrictEqual(transformed.left.parts, ['NewTable', 'FieldA']);
      }
    }
    // Ensure original node is not mutated if immutably transformed
    if (expr.type === 'BinaryOp' && expr.left.type === 'CompoundIdentifier') {
      assert.deepStrictEqual(expr.left.parts, ['OldTable', 'FieldA']);
    }
  });

  test('replaceAliasInExpression updates CompoundIdentifier and Identifier while preserving literals and parameters', () => {
    const expr: ExpressionNode = {
      type: 'CaseWhen',
      cases: [
        {
          when: {
            type: 'BinaryOp',
            operator: '=',
            left: { type: 'CompoundIdentifier', parts: ['T', 'Code'] },
            right: { type: 'Literal', valueType: 'string', value: 'T.Code', raw: '"T.Code"' },
          },
          then: {
            type: 'FunctionCall',
            name: 'ISNULL',
            args: [
              { type: 'CompoundIdentifier', parts: ['T', 'Ref'] },
              { type: 'Parameter', name: 'T' },
            ],
          },
        },
      ],
      else: {
        type: 'Identifier',
        name: 'T',
      },
    };

    const updated = replaceAliasInExpression(expr, 'T', 'NewT');

    assert.strictEqual(updated.type, 'CaseWhen');
    if (updated.type === 'CaseWhen') {
      const case0 = updated.cases[0];
      assert.strictEqual(case0.when.type, 'BinaryOp');
      if (case0.when.type === 'BinaryOp') {
        // Target field updated
        assert.strictEqual(case0.when.left.type, 'CompoundIdentifier');
        if (case0.when.left.type === 'CompoundIdentifier') {
          assert.deepStrictEqual(case0.when.left.parts, ['NewT', 'Code']);
        }
        // String literal preserved
        assert.strictEqual(case0.when.right.type, 'Literal');
        if (case0.when.right.type === 'Literal') {
          assert.strictEqual(case0.when.right.raw, '"T.Code"');
        }
      }

      assert.strictEqual(case0.then.type, 'FunctionCall');
      if (case0.then.type === 'FunctionCall') {
        assert.strictEqual(case0.then.args[0].type, 'CompoundIdentifier');
        if (case0.then.args[0].type === 'CompoundIdentifier') {
          assert.deepStrictEqual(case0.then.args[0].parts, ['NewT', 'Ref']);
        }
        // Parameter &T preserved
        assert.strictEqual(case0.then.args[1].type, 'Parameter');
        if (case0.then.args[1].type === 'Parameter') {
          assert.strictEqual(case0.then.args[1].name, 'T');
        }
      }

      // Standalone identifier updated
      assert.strictEqual(updated.else?.type, 'Identifier');
      if (updated.else?.type === 'Identifier') {
        assert.strictEqual(updated.else.name, 'NewT');
      }
    }
  });

  test('replaceAliasInExpression handles Between, In, Like, and RawExpression', () => {
    const expr: ExpressionNode = {
      type: 'BinaryOp',
      operator: 'OR',
      left: {
        type: 'Between',
        expression: { type: 'CompoundIdentifier', parts: ['A', 'Val'] },
        from: { type: 'CompoundIdentifier', parts: ['A', 'Min'] },
        to: { type: 'CompoundIdentifier', parts: ['A', 'Max'] },
      },
      right: {
        type: 'In',
        expression: {
          type: 'Like',
          expression: { type: 'RawExpression', raw: 'A.Name + " (A.Name)"' },
          pattern: { type: 'Literal', valueType: 'string', value: '%test%', raw: '"%test%"' },
        },
        values: [
          { type: 'CompoundIdentifier', parts: ['A', 'Expected'] },
          { type: 'Literal', valueType: 'string', value: 'Constant', raw: '"Constant"' },
        ],
      },
    };

    const updated = replaceAliasInExpression(expr, 'A', 'RenamedA');

    assert.strictEqual(updated.type, 'BinaryOp');
    if (updated.type === 'BinaryOp') {
      assert.strictEqual(updated.left.type, 'Between');
      if (updated.left.type === 'Between') {
        assert.deepStrictEqual((updated.left.expression as CompoundIdentifierNode).parts, ['RenamedA', 'Val']);
        assert.deepStrictEqual((updated.left.from as CompoundIdentifierNode).parts, ['RenamedA', 'Min']);
        assert.deepStrictEqual((updated.left.to as CompoundIdentifierNode).parts, ['RenamedA', 'Max']);
      }

      assert.strictEqual(updated.right.type, 'In');
      if (updated.right.type === 'In') {
        assert.strictEqual(updated.right.expression.type, 'Like');
        if (updated.right.expression.type === 'Like') {
          assert.strictEqual(updated.right.expression.expression.type, 'RawExpression');
          if (updated.right.expression.expression.type === 'RawExpression') {
            assert.strictEqual(
              updated.right.expression.expression.raw,
              'RenamedA.Name + " (A.Name)"',
              'RawExpression must rename outside quotes while preserving literal in quotes'
            );
          }
        }
        if (Array.isArray(updated.right.values)) {
          assert.deepStrictEqual((updated.right.values[0] as CompoundIdentifierNode).parts, ['RenamedA', 'Expected']);
        }
      }
    }
  });

  test('isAggregateExpression detects aggregates at arbitrary depth and ignores normal fields', () => {
    // 1. Direct aggregate
    const agg: ExpressionNode = {
      type: 'Aggregate',
      aggregateType: 'Sum',
      expression: { type: 'CompoundIdentifier', parts: ['T', 'Amount'] },
    };
    assert.strictEqual(isAggregateExpression(agg), true);

    // 2. Nested aggregate in binary operation
    const binaryWithAgg: ExpressionNode = {
      type: 'BinaryOp',
      operator: '>',
      left: agg,
      right: { type: 'Literal', valueType: 'number', value: 0, raw: '0' },
    };
    assert.strictEqual(isAggregateExpression(binaryWithAgg), true);

    // 3. Deeply nested in CaseWhen
    const caseWithAgg: ExpressionNode = {
      type: 'CaseWhen',
      cases: [
        {
          when: { type: 'CompoundIdentifier', parts: ['T', 'Active'] },
          then: {
            type: 'FunctionCall',
            name: 'ROUND',
            args: [agg, { type: 'Literal', valueType: 'number', value: 2, raw: '2' }],
          },
        },
      ],
    };
    assert.strictEqual(isAggregateExpression(caseWithAgg), true);

    // 4. Normal field named "Сумма" (T.Сумма) is NOT an aggregate
    const normalField: ExpressionNode = {
      type: 'CompoundIdentifier',
      parts: ['T', 'Сумма'],
    };
    assert.strictEqual(isAggregateExpression(normalField), false);

    // 5. Binary op with normal fields is NOT an aggregate
    const normalBinary: ExpressionNode = {
      type: 'BinaryOp',
      operator: '=',
      left: normalField,
      right: { type: 'Literal', valueType: 'number', value: 100, raw: '100' },
    };
    assert.strictEqual(isAggregateExpression(normalBinary), false);
  });

  test('extractParametersFromExpression gathers unique parameters in sorted order', () => {
    const expr: ExpressionNode = {
      type: 'CaseWhen',
      cases: [
        {
          when: {
            type: 'Between',
            expression: { type: 'Parameter', name: 'EndDate' },
            from: { type: 'Parameter', name: 'BeginDate' },
            to: { type: 'Parameter', name: 'EndDate' }, // duplicate
          },
          then: {
            type: 'FunctionCall',
            name: 'ISNULL',
            args: [
              { type: 'Parameter', name: 'Warehouse' },
              { type: 'Parameter', name: 'Organization' },
            ],
          },
        },
      ],
      else: {
        type: 'Parameter',
        name: 'DefaultAccount',
      },
    };

    const params = extractParametersFromExpression(expr);
    assert.deepStrictEqual(params, [
      'BeginDate',
      'DefaultAccount',
      'EndDate',
      'Organization',
      'Warehouse',
    ]);
  });

  test('Finding 1 (cafa34d): replaceAliasInRawString preserves parameter names and string literals', () => {
    // 1. Example from review: table alias matching parameter name exactly
    const rawReview = 'Т.Код = &Т И Т.Родитель.Код = "Т.Код"';
    const replacedReview = replaceAliasInRawString(rawReview, 'Т', 'Новое');
    assert.strictEqual(
      replacedReview,
      'Новое.Код = &Т И Новое.Родитель.Код = "Т.Код"',
      'Parameter &Т and string literal "Т.Код" must be preserved, only table prefix replaced'
    );

    // 2. Broad edge cases:
    // 2a. Multiple parameters &Т with operators, compound paths, and star
    const rawComplex = 'Т.Поле.Подполе = &Т + &Т И Т.* = ИСТИНА И Т.Сумма > &Т';
    const replacedComplex = replaceAliasInRawString(rawComplex, 'Т', 'NewT');
    assert.strictEqual(
      replacedComplex,
      'NewT.Поле.Подполе = &Т + &Т И NewT.* = ИСТИНА И NewT.Сумма > &Т',
      'Parameters must never be renamed, compound paths and star must be renamed'
    );

    // 2b. Escaped quotes inside string literals
    const rawQuotes = 'Т.Наим = """Т.Код""" И Т.Комментарий = "Строка с &Т внутри"';
    const replacedQuotes = replaceAliasInRawString(rawQuotes, 'Т', 'NewT');
    assert.strictEqual(
      replacedQuotes,
      'NewT.Наим = """Т.Код""" И NewT.Комментарий = "Строка с &Т внутри"',
      'String literals with escaped quotes must be completely preserved'
    );

    // 2c. Sub-property access with dot before alias (e.g. A.Т.Код, where Т is property not table alias)
    const rawProperty = 'Документ.Т.Код = Т.Код';
    const replacedProperty = replaceAliasInRawString(rawProperty, 'Т', 'NewT');
    assert.strictEqual(
      replacedProperty,
      'Документ.Т.Код = NewT.Код',
      'Sub-property preceded by dot must not be treated as table alias'
    );

    // 2d. Parity between structured AST and RawExpression
    const structuredExpr: ExpressionNode = {
      type: 'BinaryOp',
      operator: '=',
      left: { type: 'CompoundIdentifier', parts: ['Т', 'Код'] },
      right: { type: 'Parameter', name: 'Т' },
    };
    const updatedStructured = replaceAliasInExpression(structuredExpr, 'Т', 'NewT');
    assert.deepStrictEqual(
      updatedStructured,
      {
        type: 'BinaryOp',
        operator: '=',
        left: { type: 'CompoundIdentifier', parts: ['NewT', 'Код'] },
        right: { type: 'Parameter', name: 'Т' },
      },
      'Structured AST preserves ParameterNode unchanged'
    );

    const rawExpr: ExpressionNode = {
      type: 'RawExpression',
      raw: 'Т.Код = &Т',
    };
    const updatedRaw = replaceAliasInExpression(rawExpr, 'Т', 'NewT');
    assert.deepStrictEqual(
      updatedRaw,
      {
        type: 'RawExpression',
        raw: 'NewT.Код = &Т',
      },
      'RawExpression preserves &Т identically to structured AST'
    );
  });

  test('Finding 2 (cafa34d): extractParametersFromExpression collects parameters from subqueries and RawExpression', () => {
    // 1. Example from review: In with subquery
    const queryWithSubquery = 'ВЫБРАТЬ A ИЗ T ГДЕ A В (ВЫБРАТЬ B ИЗ U ГДЕ B = &Парам)';
    const pkg = parseSdbl(queryWithSubquery);
    const select = pkg.queries[0] as SelectStatement;
    assert.ok(select.where, 'where clause must exist');

    const paramsFromExpr = extractParametersFromExpression(select.where);
    assert.deepStrictEqual(
      paramsFromExpr,
      ['Парам'],
      'extractParametersFromExpression must collect parameters from subquery inside InNode'
    );

    // Parity with production extractParameters(pkg)
    const paramsFromPkg = extractParameters(pkg);
    assert.deepStrictEqual(paramsFromExpr, paramsFromPkg, 'Collector parity on subquery in WHERE');

    // 2. Broad edge cases:
    // 2a. Deeply nested subquery with virtual tables, joins, and multiple parameters
    const complexNestedQuery = `
      ВЫБРАТЬ Док.Ссылка
      ИЗ Документ.Заказ КАК Док
      ГДЕ Док.Номенклатура В (
        ВЫБРАТЬ Ост.Номенклатура
        ИЗ РегистрНакопления.ОстаткиТоваров.Остатки(&Период, Организация = &Организация) КАК Ост
        ЛЕВОЕ СОЕДИНЕНИЕ Справочник.Склады КАК Склады
          ПО Склады.Ссылка = Ост.Склад И Склады.Код = &КодСклада
        ГДЕ Ост.Количество > &МинКоличество
          ИЛИ Ост.Номенклатура В (
            ВЫБРАТЬ Цены.Номенклатура
            ИЗ РегистрСведений.Цены.СрезПоследних(&ДатаЦен, ВидЦены = &ВидЦены) КАК Цены
            ГДЕ Цены.Цена > &МинЦена
          )
      )
    `;
    const complexPkg = parseSdbl(complexNestedQuery);
    const complexSelect = complexPkg.queries[0] as SelectStatement;
    assert.ok(complexSelect.where);

    const complexExprParams = extractParametersFromExpression(complexSelect.where);
    assert.deepStrictEqual(complexExprParams, [
      'ВидЦены',
      'ДатаЦен',
      'КодСклада',
      'МинКоличество',
      'МинЦена',
      'Организация',
      'Период',
    ]);
    assert.deepStrictEqual(
      complexExprParams,
      extractParameters(complexPkg),
      'Collector parity on deep nested subquery with multiple sources and joins'
    );

    // 2b. RawExpression with parameters
    const rawExprWithParams: ExpressionNode = {
      type: 'RawExpression',
      raw: 'Сумма >= &МинСумма И Валюта = &ВалютаУчета И Описание = "Текст без &ПараметраВКавычках"',
    };
    const rawParams = extractParametersFromExpression(rawExprWithParams);
    assert.deepStrictEqual(rawParams, ['ВалютаУчета', 'МинСумма']);

    // 2c. Verify that aggregate in subquery does NOT make outer expression aggregate
    const subqueryWithAgg = parseSdbl('ВЫБРАТЬ A ИЗ T ГДЕ A В (ВЫБРАТЬ СУММА(B) ИЗ U)');
    const subqueryWhere = (subqueryWithAgg.queries[0] as SelectStatement).where;
    assert.ok(subqueryWhere);
    assert.strictEqual(
      isAggregateExpression(subqueryWhere),
      false,
      'Aggregate inside subquery must not make outer WHERE expression aggregate'
    );
  });
});
