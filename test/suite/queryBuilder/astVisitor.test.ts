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
  RawExpressionNode,
} from '../../../src/queryBuilder/sdbl/sdblAst';
import {
  traverseExpression,
  transformExpression,
  replaceAliasInExpression,
  isAggregateExpression,
  extractParametersFromExpression,
} from '../../../src/queryBuilder/sdbl/sdblAstVisitor';

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
});
