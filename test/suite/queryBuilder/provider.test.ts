import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  handleQueryBuilderMessage,
  QueryBuilderMessageHandler,
  QueryBuilderMessageContext,
} from '../../../src/queryBuilder/queryBuilderMessageHandler';
import { QueryBuilderProvider } from '../../../src/queryBuilder/queryBuilderProvider';
import { registerQueryBuilderCommands } from '../../../src/queryBuilder/queryBuilderCommands';
import { QueryPackage } from '../../../src/queryBuilder/sdbl/sdblAst';
import { QueryMetadataNode } from '../../../src/queryBuilder/metadata/queryMetadataTypes';

suite('QueryBuilder Provider & Message Handler', () => {
  let warningMessage: string | undefined;
  let statusBarMessage: string | undefined;
  const originalShowWarningMessage = vscode.window.showWarningMessage;
  const originalSetStatusBarMessage = (vscode.window as any).setStatusBarMessage;

  setup(() => {
    warningMessage = undefined;
    statusBarMessage = undefined;
    (vscode.window as any).showWarningMessage = async (msg: string) => {
      warningMessage = msg;
      return undefined;
    };
    (vscode.window as any).setStatusBarMessage = (msg: string) => {
      statusBarMessage = msg;
      return { dispose: () => undefined };
    };
  });

  teardown(() => {
    (vscode.window as any).showWarningMessage = originalShowWarningMessage;
    (vscode.window as any).setStatusBarMessage = originalSetStatusBarMessage;
  });

  function createMockPanel() {
    const postedMessages: any[] = [];
    let disposed = false;
    let messageListener: ((msg: any) => void) | undefined;

    return {
      panel: {
        viewType: '1c-query-builder',
        title: 'Конструктор запроса',
        viewColumn: vscode.ViewColumn.Active,
        webview: {
          html: '',
          postMessage: async (msg: any) => {
            postedMessages.push(msg);
            return true;
          },
          onDidReceiveMessage: (listener: (msg: any) => void) => {
            messageListener = listener;
            return { dispose: () => undefined };
          },
        },
        reveal: () => undefined,
        dispose: () => {
          disposed = true;
        },
        onDidDispose: (_listener: () => void) => {
          return { dispose: () => undefined };
        },
      } as unknown as vscode.WebviewPanel,
      postedMessages,
      isDisposed: () => disposed,
      simulateMessage: (msg: any) => messageListener?.(msg),
    };
  }

  function createMockEditor(docText: string, replaceRangeCallback?: (range: vscode.Range, text: string) => void) {
    const lines = docText.split('\n');

    return {
      document: {
        getText: () => docText,
        positionAt: (offset: number) => {
          let cur = 0;
          for (let l = 0; l < lines.length; l++) {
            const lineLen = lines[l].length + 1;
            if (cur + lineLen > offset || l === lines.length - 1) {
              return new vscode.Position(l, offset - cur);
            }
            cur += lineLen;
          }
          return new vscode.Position(0, 0);
        },
        offsetAt: (pos: vscode.Position) => {
          let offset = 0;
          for (let l = 0; l < pos.line && l < lines.length; l++) {
            offset += lines[l].length + 1;
          }
          return offset + pos.character;
        },
      },
      selection: {
        active: new vscode.Position(0, 0),
        start: new vscode.Position(0, 0),
        end: new vscode.Position(0, 0),
        isEmpty: true,
      },
      edit: async (callback: (builder: any) => void) => {
        const editBuilder = {
          replace: (range: vscode.Range, text: string) => {
            replaceRangeCallback?.(range, text);
          },
        };
        callback(editBuilder);
        return true;
      },
    } as unknown as vscode.TextEditor;
  }

  suite('handleQueryBuilderMessage', () => {
    test('sends init message with AST, metadata, and mode upon "ready"', async () => {
      const mock = createMockPanel();
      const initialAst: QueryPackage = {
        queries: [{ type: 'Select', fields: [], from: [] }],
      };
      const metadata: QueryMetadataNode[] = [
        { id: 'Catalogs', name: 'Catalogs', fullName: 'Справочники', label: 'Справочники', nodeType: 'category' },
      ];

      const context: QueryBuilderMessageContext = {
        panel: mock.panel,
        ast: initialAst,
        metadata,
        mode: 'simple',
        replaceRange: {
          startOffset: 0,
          endOffset: 0,
          startLine: 1,
          startColumn: 1,
          endLine: 1,
          endColumn: 1,
        },
      };

      await handleQueryBuilderMessage({ command: 'ready' }, context);

      assert.strictEqual(mock.postedMessages.length, 1);
      assert.deepStrictEqual(mock.postedMessages[0], {
        command: 'init',
        ast: initialAst,
        metadata,
        mode: 'simple',
      });
    });

    test('updates AST in context upon "updateAst"', async () => {
      const mock = createMockPanel();
      const initialAst: QueryPackage = {
        queries: [{ type: 'Select', fields: [], from: [] }],
      };
      const updatedAst: QueryPackage = {
        queries: [
          {
            type: 'Select',
            fields: [{ expression: { type: 'Identifier', name: 'Ссылка' } }],
            from: [{ source: { type: 'Table', name: 'Справочник.Номенклатура' } }],
          },
        ],
      };

      let callbackAst: QueryPackage | undefined;
      const context: QueryBuilderMessageContext = {
        panel: mock.panel,
        ast: initialAst,
        metadata: [],
        mode: 'simple',
        replaceRange: {
          startOffset: 0,
          endOffset: 0,
          startLine: 1,
          startColumn: 1,
          endLine: 1,
          endColumn: 1,
        },
        onAstUpdated: (ast: QueryPackage) => {
          callbackAst = ast;
        },
      };

      await handleQueryBuilderMessage({ command: 'updateAst', ast: updatedAst }, context);

      assert.deepStrictEqual(context.ast, updatedAst);
      assert.deepStrictEqual(callbackAst, updatedAst);
    });

    test('saves simple mode query: generates BSL literal, performs editor edit, and disposes panel', async () => {
      const mock = createMockPanel();
      let replacedRange: vscode.Range | undefined;
      let replacedText: string | undefined;

      const editor = createMockEditor('// existing code', (range, text) => {
        replacedRange = range;
        replacedText = text;
      });

      const ast: QueryPackage = {
        queries: [
          {
            type: 'Select',
            fields: [{ expression: { type: 'Identifier', name: 'Ссылка' } }],
            from: [{ source: { type: 'Table', name: 'Справочник.Номенклатура' } }],
          },
        ],
      };

      const context: QueryBuilderMessageContext = {
        panel: mock.panel,
        editor,
        ast,
        metadata: [],
        mode: 'simple',
        replaceRange: {
          startOffset: 0,
          endOffset: 5,
          startLine: 1,
          startColumn: 1,
          endLine: 1,
          endColumn: 6,
        },
      };

      await handleQueryBuilderMessage({ command: 'save', ast }, context);

      assert.strictEqual(mock.isDisposed(), true, 'Panel should be disposed on successful save');
      assert.ok(replacedText, 'Editor text should have been replaced');
      assert.ok(replacedText.includes('ВЫБРАТЬ'), 'Generated code should contain ВЫБРАТЬ');
      assert.ok(replacedText.includes('Справочник.Номенклатура'), 'Generated code should contain table name');
      assert.ok(replacedText.startsWith('"') && replacedText.endsWith('"'), 'Simple mode should produce BSL string literal');
      assert.strictEqual(replacedRange?.start.line, 0);
      assert.strictEqual(replacedRange?.start.character, 0);
      assert.strictEqual(replacedRange?.end.line, 0);
      assert.strictEqual(replacedRange?.end.character, 5);
    });

    test('saves withProcessing mode query: generates full execution boilerplate with parameters', async () => {
      const mock = createMockPanel();
      let replacedText: string | undefined;

      const editor = createMockEditor('', (_range, text) => {
        replacedText = text;
      });

      const ast: QueryPackage = {
        queries: [
          {
            type: 'Select',
            fields: [{ expression: { type: 'Identifier', name: 'Ссылка' } }],
            from: [{ source: { type: 'Table', name: 'Справочник.Номенклатура' } }],
            where: {
              type: 'BinaryOp',
              operator: '=',
              left: { type: 'Identifier', name: 'ЭтоГруппа' },
              right: { type: 'Parameter', name: 'ЭтоГруппа' },
            },
          },
        ],
      };

      const context: QueryBuilderMessageContext = {
        panel: mock.panel,
        editor,
        ast,
        metadata: [],
        mode: 'withProcessing',
        replaceRange: {
          startOffset: 0,
          endOffset: 0,
          startLine: 1,
          startColumn: 1,
          endLine: 1,
          endColumn: 1,
        },
        variableName: 'МойЗапрос',
      };

      await handleQueryBuilderMessage({ command: 'save', ast }, context);

      assert.strictEqual(mock.isDisposed(), true);
      assert.ok(replacedText, 'Text must be replaced');
      assert.ok(replacedText.includes('МойЗапрос = Новый Запрос;'), 'Must initialize query variable');
      assert.ok(
        replacedText.includes('МойЗапрос.УстановитьПараметр("ЭтоГруппа", ЭтоГруппа);'),
        'Must set query parameter'
      );
      assert.ok(
        replacedText.includes('ВыборкаДетальныеЗаписи = РезультатЗапроса.Выбрать();'),
        'Must select query results'
      );
      assert.ok(
        replacedText.includes('Пока ВыборкаДетальныеЗаписи.Следующий() Цикл'),
        'Must iterate results'
      );
    });

    test('does not dispose panel if editor.edit fails', async () => {
      const mock = createMockPanel();
      const failingEditor = {
        document: {
          positionAt: () => new vscode.Position(0, 0),
        },
        edit: async () => false,
      } as unknown as vscode.TextEditor;

      const context: QueryBuilderMessageContext = {
        panel: mock.panel,
        editor: failingEditor,
        ast: { queries: [{ type: 'Select', fields: [], from: [] }] },
        metadata: [],
        mode: 'simple',
        replaceRange: {
          startOffset: 0,
          endOffset: 0,
          startLine: 1,
          startColumn: 1,
          endLine: 1,
          endColumn: 1,
        },
      };

      await handleQueryBuilderMessage({ command: 'save' }, context);
      assert.strictEqual(mock.isDisposed(), false, 'Panel must remain open on edit failure');
    });

    test('disposes panel on "cancel"', async () => {
      const mock = createMockPanel();
      const context: QueryBuilderMessageContext = {
        panel: mock.panel,
        ast: { queries: [] },
        metadata: [],
        mode: 'simple',
        replaceRange: {
          startOffset: 0,
          endOffset: 0,
          startLine: 1,
          startColumn: 1,
          endLine: 1,
          endColumn: 1,
        },
      };

      await handleQueryBuilderMessage({ command: 'cancel' }, context);
      assert.strictEqual(mock.isDisposed(), true);
    });

    test('requests and sends metadata upon "requestMetadata"', async () => {
      const mock = createMockPanel();
      const mockTreeNodes: QueryMetadataNode[] = [
        { id: 'Documents', name: 'Documents', fullName: 'Документы', label: 'Документы', nodeType: 'category' },
      ];

      const mockMetadataProvider = {
        buildTreeFromProvider: async () => mockTreeNodes,
        getMetadataCategories: () => mockTreeNodes,
      } as any;

      const context: QueryBuilderMessageContext = {
        panel: mock.panel,
        ast: { queries: [] },
        metadata: [],
        mode: 'simple',
        replaceRange: {
          startOffset: 0,
          endOffset: 0,
          startLine: 1,
          startColumn: 1,
          endLine: 1,
          endColumn: 1,
        },
        metadataProvider: mockMetadataProvider,
      };

      await handleQueryBuilderMessage({ command: 'requestMetadata' }, context);

      assert.strictEqual(mock.postedMessages.length, 1);
      assert.deepStrictEqual(mock.postedMessages[0], {
        command: 'updateMetadata',
        metadata: mockTreeNodes,
      });
      assert.deepStrictEqual(context.metadata, mockTreeNodes);
    });

    test('handles malformed, empty or unknown messages gracefully without throwing', async () => {
      const mock = createMockPanel();
      const context: QueryBuilderMessageContext = {
        panel: mock.panel,
        ast: { queries: [] },
        metadata: [],
        mode: 'simple',
        replaceRange: {
          startOffset: 0,
          endOffset: 0,
          startLine: 1,
          startColumn: 1,
          endLine: 1,
          endColumn: 1,
        },
      };

      await assert.doesNotReject(async () => {
        await handleQueryBuilderMessage(null, context);
        await handleQueryBuilderMessage(undefined, context);
        await handleQueryBuilderMessage({}, context);
        await handleQueryBuilderMessage({ command: 123 }, context);
        await handleQueryBuilderMessage({ command: 'unknownCommand' }, context);
      });
    });

    test('QueryBuilderMessageHandler class forwards messages to handler function', async () => {
      const mock = createMockPanel();
      const context: QueryBuilderMessageContext = {
        panel: mock.panel,
        ast: { queries: [] },
        metadata: [],
        mode: 'simple',
        replaceRange: {
          startOffset: 0,
          endOffset: 0,
          startLine: 1,
          startColumn: 1,
          endLine: 1,
          endColumn: 1,
        },
      };

      const handler = new QueryBuilderMessageHandler(context);
      await handler.handleMessage({ command: 'ready' });

      assert.strictEqual(mock.postedMessages.length, 1);
      assert.strictEqual(mock.postedMessages[0].command, 'init');
    });
  });

  suite('QueryBuilderProvider', () => {
    const fakeContext = {
      extensionUri: vscode.Uri.file('/fake/extension'),
      extensionPath: '/fake/extension',
    } as vscode.ExtensionContext;

    let originalActiveEditor: any;
    let originalCreateWebviewPanel: any;

    setup(() => {
      originalActiveEditor = vscode.window.activeTextEditor;
      originalCreateWebviewPanel = vscode.window.createWebviewPanel;
    });

    teardown(() => {
      (vscode.window as any).activeTextEditor = originalActiveEditor;
      (vscode.window as any).createWebviewPanel = originalCreateWebviewPanel;
    });

    test('shows warning message when no text editor is active and returns undefined', async () => {
      (vscode.window as any).activeTextEditor = undefined;
      const provider = new QueryBuilderProvider(fakeContext, {} as any);

      const panel = await provider.open(undefined);
      assert.strictEqual(panel, undefined);
      assert.strictEqual(
        warningMessage,
        'Откройте модуль 1С или файл запроса для запуска конструктора.'
      );
    });

    test('initializes empty SelectStatement on empty document or new query', async () => {
      const mockPanel = createMockPanel();
      let createdViewType = '';
      let createdTitle = '';
      let createdColumn: any;
      let createdOptions: any;

      (vscode.window as any).createWebviewPanel = (viewType: string, title: string, col: any, opts: any) => {
        createdViewType = viewType;
        createdTitle = title;
        createdColumn = col;
        createdOptions = opts;
        return mockPanel.panel;
      };

      const editor = createMockEditor('');
      const provider = new QueryBuilderProvider(fakeContext, {} as any);

      const panel = await provider.open(editor, 'simple');

      assert.strictEqual(panel, mockPanel.panel);
      assert.strictEqual(createdViewType, '1c-query-builder');
      assert.ok(createdTitle.includes('Конструктор запроса'));
      assert.ok(createdTitle.includes('(новый)'));
      assert.strictEqual(createdColumn, vscode.ViewColumn.Active);
      assert.strictEqual(createdOptions.enableScripts, true);
      assert.strictEqual(createdOptions.retainContextWhenHidden, true);

      // Simulate 'ready' from webview to inspect initialized AST
      mockPanel.simulateMessage({ command: 'ready' });
      assert.strictEqual(mockPanel.postedMessages.length, 1);
      const initMsg = mockPanel.postedMessages[0];
      assert.strictEqual(initMsg.command, 'init');
      assert.strictEqual(initMsg.mode, 'simple');
      assert.strictEqual(initMsg.ast.queries.length, 1);
      assert.strictEqual(initMsg.ast.queries[0].type, 'Select');
      assert.deepStrictEqual(initMsg.ast.queries[0].fields, []);
      assert.deepStrictEqual(initMsg.ast.queries[0].from, []);
    });

    test('parses existing SDBL query in active editor and sets title without (новый)', async () => {
      const mockPanel = createMockPanel();
      let createdTitle = '';

      (vscode.window as any).createWebviewPanel = (_vt: string, title: string) => {
        createdTitle = title;
        return mockPanel.panel;
      };

      const bslCode = 'Запрос.Текст = "ВЫБРАТЬ Ссылка ИЗ Справочник.Номенклатура";';
      const editor = createMockEditor(bslCode);
      // Place cursor inside the query literal
      editor.selection = {
        active: new vscode.Position(0, 20),
        start: new vscode.Position(0, 20),
        end: new vscode.Position(0, 20),
        isEmpty: true,
      } as any;

      const provider = new QueryBuilderProvider(fakeContext, {} as any);
      await provider.open(editor, 'withProcessing');

      assert.strictEqual(createdTitle, 'Конструктор запроса');
      assert.strictEqual(createdTitle.includes('(новый)'), false);

      // Verify AST on ready
      mockPanel.simulateMessage({ command: 'ready' });
      assert.strictEqual(mockPanel.postedMessages.length, 1);
      const initMsg = mockPanel.postedMessages[0];
      assert.strictEqual(initMsg.mode, 'withProcessing');
      assert.strictEqual(initMsg.ast.queries.length, 1);
      const sel = initMsg.ast.queries[0];
      assert.strictEqual(sel.type, 'Select');
      assert.strictEqual(sel.fields.length, 1);
      assert.strictEqual(sel.from.length, 1);
    });

    test('reuses existing webview panel if already opened', async () => {
      const mockPanel = createMockPanel();
      let createCallCount = 0;
      let revealed = false;

      (mockPanel.panel as any).reveal = () => {
        revealed = true;
      };

      (vscode.window as any).createWebviewPanel = () => {
        createCallCount++;
        return mockPanel.panel;
      };

      const editor = createMockEditor('');
      const provider = new QueryBuilderProvider(fakeContext, {} as any);

      await provider.open(editor);
      assert.strictEqual(createCallCount, 1);

      // Second open call
      await provider.open(editor);
      assert.strictEqual(createCallCount, 1, 'Should not create a second panel');
      assert.strictEqual(revealed, true, 'Should reveal existing panel');
    });
  });

  suite('registerQueryBuilderCommands', () => {
    test('registers 1c-metadata-tree.queryBuilder and queryBuilderWithProcessing commands', () => {
      const registeredCommands: Array<{ id: string; handler: (...args: any[]) => any }> = [];
      const originalRegisterCommand = vscode.commands.registerCommand;

      (vscode.commands as any).registerCommand = (id: string, handler: (...args: any[]) => any) => {
        registeredCommands.push({ id, handler });
        return { dispose: () => undefined };
      };

      try {
        const fakeContext = {} as vscode.ExtensionContext;
        const fakeDeps = { state: {} as any };
        const disposables = registerQueryBuilderCommands(fakeContext, fakeDeps);

        assert.strictEqual(disposables.length, 2);
        assert.strictEqual(registeredCommands.length, 2);
        assert.strictEqual(registeredCommands[0].id, '1c-metadata-tree.queryBuilder');
        assert.strictEqual(registeredCommands[1].id, '1c-metadata-tree.queryBuilderWithProcessing');
      } finally {
        (vscode.commands as any).registerCommand = originalRegisterCommand;
      }
    });
  });
});