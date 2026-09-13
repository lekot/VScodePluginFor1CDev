import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import {
  ExpressionNode,
  QueryPackage,
  SelectStatement,
} from '../../../src/queryBuilder/sdbl/sdblAst';
import {
  traverseExpression,
  transformExpression,
  replaceAliasInExpression,
  replaceAliasInRawString,
  isAggregateExpression as backendIsAggregateExpression,
  extractParametersFromPackage,
} from '../../../src/queryBuilder/sdbl/sdblAstVisitor';

suite('Query Builder: Backend & Webview AST Visitor Parity', () => {
  const rootDir = path.resolve(__dirname, '../../../..');
  const sourceHtmlPath = path.join(rootDir, 'src/queryBuilder/ui/queryBuilderWebview.html');
  const htmlSource = fs.readFileSync(sourceHtmlPath, 'utf-8');

  // Extract the main script content from queryBuilderWebview.html
  const scriptMatch = htmlSource.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'Script tag must exist in queryBuilderWebview.html');
  const scriptCode = scriptMatch[1];

  interface WebviewSandbox {
    window: any;
    document: any;
  }

  function createWebviewSandbox(): WebviewSandbox {
    const elementsById: { [id: string]: any } = {};
    const getOrCreateElement = (id: string) => {
      if (!elementsById[id]) {
        elementsById[id] = {
          tagName: 'DIV',
          classList: { add: () => {}, remove: () => {}, contains: () => false },
          style: {},
          setAttribute: () => {},
          getAttribute: () => null,
          appendChild: (c: any) => c,
          removeChild: (c: any) => c,
          addEventListener: () => {},
          querySelectorAll: () => [],
          querySelector: () => null,
        };
      }
      return elementsById[id];
    };

    const mockDocument = {
      getElementById: (id: string) => getOrCreateElement(id),
      createElement: (tag: string) => getOrCreateElement('created-' + tag),
      querySelector: () => null,
      querySelectorAll: () => [],
    };

    const mockWindow: any = {
      document: mockDocument,
      addEventListener: () => {},
    };

    const sandbox: any = {
      window: mockWindow,
      document: mockDocument,
      acquireVsCodeApi: () => ({ postMessage: () => {} }),
      console: console,
      setTimeout: setTimeout,
      clearTimeout: clearTimeout,
      prompt: () => '',
      alert: () => {},
    };

    vm.createContext(sandbox);
    vm.runInContext(scriptCode, sandbox);
    return { window: sandbox.window, document: mockDocument };
  }

  test('Parity 0: Webview exposes bundled SdblAstVisitor on window', () => {
    const env = createWebviewSandbox();
    assert.ok(env.window.SdblAstVisitor, 'window.SdblAstVisitor must be defined in Webview');
    assert.strictEqual(typeof env.window.SdblAstVisitor.traverseExpression, 'function');
    assert.strictEqual(typeof env.window.SdblAstVisitor.transformExpression, 'function');
    assert.strictEqual(typeof env.window.SdblAstVisitor.replaceAliasInExpression, 'function');
    assert.strictEqual(typeof env.window.SdblAstVisitor.replaceAliasInRawString, 'function');
    assert.strictEqual(typeof env.window.SdblAstVisitor.isAggregateExpression, 'function');
    assert.strictEqual(typeof env.window.SdblAstVisitor.extractParametersFromPackage, 'function');
  });

  // Construct a comprehensive AST containing all 13 ExpressionNode types
  function buildAll13TypesExpression(): ExpressionNode {
    return {
      type: 'CaseWhen',
      cases: [
        {
          when: {
            type: 'BinaryOp',
            operator: 'AND',
            left: {
              type: 'Between',
              expression: { type: 'CompoundIdentifier', parts: ['T', 'Amount'] },
              from: { type: 'Literal', valueType: 'number', value: 10, raw: '10' },
              to: { type: 'Literal', valueType: 'number', value: 100, raw: '100' },
            },
            right: {
              type: 'Like',
              expression: { type: 'CompoundIdentifier', parts: ['T', 'Description'] },
              pattern: { type: 'Literal', valueType: 'string', value: '%товар%', raw: '"%товар%"' },
              escape: { type: 'Literal', valueType: 'string', value: '\\', raw: '"\\"' },
            },
          },
          then: {
            type: 'Aggregate',
            aggregateType: 'Sum',
            expression: {
              type: 'FunctionCall',
              name: 'ISNULL',
              args: [
                { type: 'CompoundIdentifier', parts: ['T', 'Total'] },
                { type: 'Literal', valueType: 'number', value: 0, raw: '0' },
              ],
            },
          },
        },
        {
          when: {
            type: 'In',
            expression: { type: 'CompoundIdentifier', parts: ['T', 'Status'] },
            values: [
              { type: 'Parameter', name: 'StatusParam' },
              { type: 'Literal', valueType: 'string', value: 'Active', raw: '"Active"' },
            ],
          },
          then: {
            type: 'UnaryOp',
            operator: '-',
            operand: { type: 'CompoundIdentifier', parts: ['T', 'Discount'] },
          },
        },
      ],
      else: {
        type: 'BinaryOp',
        operator: '+',
        left: { type: 'Identifier', name: 'T' },
        right: { type: 'RawExpression', raw: 'T.CustomField + &ExtraParam + "T.Literal"' },
      },
    };
  }

  test('Parity 1: 13-type AST expression traversal order & visited types match 1:1', () => {
    const env = createWebviewSandbox();
    const testAst = buildAll13TypesExpression();

    const backendVisited: string[] = [];
    traverseExpression(testAst, {
      enter: (node) => backendVisited.push(node.type),
    });

    const webviewVisited: string[] = [];
    env.window.SdblAstVisitor.traverseExpression(testAst, {
      enter: (node: any) => webviewVisited.push(node.type),
    });

    const legacyWebviewVisited: string[] = [];
    if (typeof env.window.traverseAstExpr === 'function') {
      env.window.traverseAstExpr(testAst, {
        enter: (node: any) => legacyWebviewVisited.push(node.type),
      });
    }

    assert.ok(backendVisited.length > 0, 'Backend should visit nodes');
    assert.deepStrictEqual(
      webviewVisited,
      backendVisited,
      'Webview SdblAstVisitor.traverseExpression must match backend traversal byte-for-byte'
    );

    if (legacyWebviewVisited.length > 0) {
      assert.deepStrictEqual(
        legacyWebviewVisited,
        backendVisited,
        'Webview window.traverseAstExpr must match backend traversal'
      );
    }

    // Verify all 13 types were actually tested
    const uniqueTypes = new Set(backendVisited);
    const expectedTypes = [
      'CaseWhen',
      'BinaryOp',
      'Between',
      'CompoundIdentifier',
      'Literal',
      'Like',
      'Aggregate',
      'FunctionCall',
      'In',
      'Parameter',
      'UnaryOp',
      'Identifier',
      'RawExpression',
    ];
    for (const t of expectedTypes) {
      assert.ok(uniqueTypes.has(t), `Comprehensive AST must include node type ${t}`);
    }
  });

  test('Parity 2: replaceAliasInExpression & replaceAliasInRawString produce identical results', () => {
    const env = createWebviewSandbox();
    const testAstBackend = buildAll13TypesExpression();
    const testAstWebview = buildAll13TypesExpression();

    const backendTransformed = replaceAliasInExpression(testAstBackend, 'T', 'NewTable');
    const webviewTransformed = env.window.SdblAstVisitor.replaceAliasInExpression(
      testAstWebview,
      'T',
      'NewTable'
    );

    const normalizedWebviewTransformed = JSON.parse(JSON.stringify(webviewTransformed));
    assert.deepStrictEqual(
      normalizedWebviewTransformed,
      backendTransformed,
      'replaceAliasInExpression must produce identical transformed trees'
    );

    // Tricky raw strings with &T, string literals, compound properties
    const trickyStrings = [
      '&Т + Т.Поле + """Т.Код""" + Документ.Т.Код',
      'ВЫБОР КОГДА Т.Флаг ТОГДА &Т ИНАЧЕ " Т.НеМенять " КОНЕЦ',
      'Т.А + Т.Б * (Т.В - &Т)',
    ];

    for (const raw of trickyStrings) {
      const bRes = replaceAliasInRawString(raw, 'Т', 'НовТаб');
      const wRes = env.window.SdblAstVisitor.replaceAliasInRawString(raw, 'Т', 'НовТаб');
      assert.strictEqual(wRes, bRes, `Raw string alias replacement failed parity on: ${raw}`);
    }
  });

  test('Parity 3: isAggregateExpression produces identical results on AST and string inputs', () => {
    const env = createWebviewSandbox();

    const aggNode: ExpressionNode = {
      type: 'Aggregate',
      aggregateType: 'Sum',
      expression: { type: 'CompoundIdentifier', parts: ['T', 'Amount'] },
    };
    const nonAggNode: ExpressionNode = {
      type: 'FunctionCall',
      name: 'ISNULL',
      args: [{ type: 'CompoundIdentifier', parts: ['T', 'Amount'] }],
    };

    assert.strictEqual(backendIsAggregateExpression(aggNode), true);
    assert.strictEqual(env.window.SdblAstVisitor.isAggregateExpression(aggNode), true);
    assert.strictEqual(env.window.isAggregateExpression(aggNode), true);

    assert.strictEqual(backendIsAggregateExpression(nonAggNode), false);
    assert.strictEqual(env.window.SdblAstVisitor.isAggregateExpression(nonAggNode), false);
    assert.strictEqual(env.window.isAggregateExpression(nonAggNode), false);

    // String expressions via window.isAggregateExpression
    assert.strictEqual(env.window.isAggregateExpression('СУММА(Т.Сумма)'), true);
    assert.strictEqual(env.window.isAggregateExpression('Т.Сумма'), false);
    assert.strictEqual(env.window.isAggregateExpression('МАКСИМУМ(Таблица.Цена)'), true);
    assert.strictEqual(env.window.isAggregateExpression('COUNT(Таблица.Код)'), true);
  });

  test('Parity 4: Parameter extraction parity between backend and Webview visitor', () => {
    const env = createWebviewSandbox();

    const pkg: QueryPackage = {
      queries: [
        {
          type: 'Select',
          fields: [
            { expression: '&ПарамПоля' },
            { expression: { type: 'Parameter', name: 'ПарамAST' } },
          ],
          from: [
            {
              source: {
                type: 'Table',
                name: 'РегистрНакопления.Остатки',
                params: [{ type: 'Parameter', name: 'Период' }],
              },
              alias: 'Ост',
            },
          ],
          where: {
            type: 'BinaryOp',
            operator: '=',
            left: { type: 'CompoundIdentifier', parts: ['Ост', 'Организация'] },
            right: { type: 'Parameter', name: 'Организация' },
          },
        },
      ],
    };

    const bParams = extractParametersFromPackage(pkg);
    const wParams = env.window.SdblAstVisitor.extractParametersFromPackage(pkg);

    assert.deepStrictEqual(Array.from(wParams), bParams, 'Extracted package parameters must match 1:1');
    assert.deepStrictEqual(bParams, ['Организация', 'ПарамПоля', 'ПарамAST', 'Период']);
  });
});
