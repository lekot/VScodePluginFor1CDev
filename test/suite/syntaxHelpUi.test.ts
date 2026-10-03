import * as assert from 'assert';
import '../helpers/vscodeStubRegister';
import * as vscode from 'vscode';
import {
  registerSyntaxHelpCommands,
  renderSyntaxHelpHtml,
  SEARCH_SYNTAX_HELP_COMMAND,
  SHOW_SYNTAX_HELP_COMMAND,
} from '../../src/providers/syntaxHelpProvider';
import type { SyntaxHelpArticle, SyntaxHelpItem } from '../../src/agent/agentSyntaxHelp';
import { resetVscodeTestState, setExecuteCommandHandler, vscodeTestState } from '../helpers/vscodeModuleStub';

function registeredHandler(command: string): (...args: unknown[]) => unknown {
  const handler = vscodeTestState.registeredCommandHandlers.get(command);
  assert.strictEqual(typeof handler, 'function', `Command not registered: ${command}`);
  return handler!;
}

suite('Syntax help UI', () => {
  test('renders only validated internal article IDs as non-navigating links and restricts other content', () => {
    const article: SyntaxHelpArticle = {
      id: 'syntax:1',
      source: 'syntax',
      name: '</title><script>alert(1)</script>',
      path: 'Global context.html',
      markdown: '# Справка\n\n<script>alert(2)</script>\n\n[опасная](javascript:alert(3))\n\n![картинка](https://example.com/image.png)\n\n[внутренняя](bsl-help:syntax:2) [ошибка](bsl-help:javascript:alert(1))',
      sourceUrl: 'https://its.1c.ru/db/v8std/content/1/hdoc',
    };

    const html = renderSyntaxHelpHtml(article, 'vscode-webview://test');

    assert.ok(html.includes("default-src 'none'"));
    assert.ok(html.includes('&lt;script&gt;alert(2)&lt;/script&gt;'));
    assert.ok(!html.includes('<script>'));
    assert.ok(!html.includes('href="javascript:'));
    assert.ok(!html.includes('<img '));
    assert.ok(!html.includes('src="https://example.com/image.png"'));
    assert.ok(html.includes('https://its.1c.ru/db/v8std/content/1/hdoc'));
    assert.ok(html.includes('href="#" data-syntax-help-id="syntax:2"'));
    assert.ok(!html.includes('href="bsl-help:'));
    assert.ok(!html.includes('data-syntax-help-id="javascript:'));
    assert.match(html, /script-src 'nonce-[^']+'/);
    assert.match(html, /<script nonce="[^"]+">/);

    const unsafeSource = renderSyntaxHelpHtml({ ...article, sourceUrl: 'javascript:alert(4)' }, 'vscode-webview://test');
    assert.ok(!unsafeSource.includes('href="javascript:'));
  });

  test('renders an escaped context banner for a matched member inside its parent article', () => {
    const article: SyntaxHelpArticle = {
      id: 'syntax:1', source: 'syntax', name: 'Глобальный контекст', path: 'Global context.html',
      markdown: '# Глобальный контекст\n\nСтатья справки.',
    };

    const html = renderSyntaxHelpHtml(article, 'vscode-webview://test', 'ТекущаяДата (CurrentDate) <script>alert(1)</script>');
    const sameNameHtml = renderSyntaxHelpHtml(article, 'vscode-webview://test', article.name);

    assert.ok(html.includes('Найденный элемент'));
    assert.ok(html.includes('ТекущаяДата (CurrentDate) &lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(html.includes('Статья справки: <strong>Глобальный контекст</strong>'));
    assert.ok(!html.includes('<script>'));
    assert.ok(!sameNameHtml.includes('Найденный элемент'));
  });

  test('Ctrl+F1 sends the complete active BSL line and cursor column to the shared Agent command', async () => {
    resetVscodeTestState();
    const line = 'Сообщить(ТекущийЭлемент);';
    const editor = {
      document: { languageId: 'bsl', lineAt: (_line: number) => ({ text: line }) },
      selection: { active: { line: 4, character: 16 } },
    };
    const windowWithEditor = vscode.window as unknown as { activeTextEditor?: typeof editor };
    Object.defineProperty(windowWithEditor, 'activeTextEditor', { configurable: true, value: editor });
    const disposables = registerSyntaxHelpCommands();
    setExecuteCommandHandler(async () => ({
      success: true,
      data: {
        terms: ['ТекущийЭлемент'], total: 1, limit: 50, hasMore: false,
        items: [{ id: 'syntax:1', source: 'syntax', name: 'ТекущийЭлемент', path: 'context.html', snippet: 'Контекст' }],
      },
    }));

    try {
      await registeredHandler(SHOW_SYNTAX_HELP_COMMAND)();
      const call = vscodeTestState.executeCommandHistory[0];
      assert.strictEqual(call.name, '1c-metadata-tree.agent.syntaxHelp');
      assert.deepStrictEqual(call.args, {
        action: 'searchLine', line, cursorColumn: 16, source: 'all', limit: 50,
      });
      assert.deepStrictEqual(vscodeTestState.informationLog, []);
    } finally {
      disposables.forEach((disposable) => disposable.dispose());
      Reflect.deleteProperty(windowWithEditor, 'activeTextEditor');
      resetVscodeTestState();
    }
  });

  test('an empty BSL line opens the manual query prompt', async () => {
    resetVscodeTestState();
    const editor = {
      document: { languageId: 'bsl', lineAt: (_line: number) => ({ text: '   ' }) },
      selection: { active: { line: 0, character: 1 } },
    };
    const windowWithEditor = vscode.window as unknown as { activeTextEditor?: typeof editor };
    Object.defineProperty(windowWithEditor, 'activeTextEditor', { configurable: true, value: editor });
    const disposables = registerSyntaxHelpCommands();
    setExecuteCommandHandler(async () => ({
      success: true,
      data: { query: 'Форма', total: 0, limit: 50, hasMore: false, items: [] },
    }));
    vscodeTestState.inputBoxQueue.push('Форма');

    try {
      await registeredHandler(SHOW_SYNTAX_HELP_COMMAND)();
      assert.strictEqual(vscodeTestState.executeCommandHistory[0].name, '1c-metadata-tree.agent.syntaxHelp');
      assert.strictEqual((vscodeTestState.executeCommandHistory[0].args as { action: string }).action, 'search');
      assert.strictEqual((vscodeTestState.executeCommandHistory[0].args as { query: string }).query, 'Форма');
    } finally {
      disposables.forEach((disposable) => disposable.dispose());
      Reflect.deleteProperty(windowWithEditor, 'activeTextEditor');
      resetVscodeTestState();
    }
  });

  test('long BSL lines are searched through a bounded window around the cursor', async () => {
    resetVscodeTestState();
    const line = 'А'.repeat(5000);
    const editor = {
      document: { languageId: 'bsl', lineAt: (_line: number) => ({ text: line }) },
      selection: { active: { line: 0, character: 2500 } },
    };
    const windowWithEditor = vscode.window as unknown as { activeTextEditor?: typeof editor };
    Object.defineProperty(windowWithEditor, 'activeTextEditor', { configurable: true, value: editor });
    const disposables = registerSyntaxHelpCommands();
    setExecuteCommandHandler(async () => ({
      success: true,
      data: { terms: ['А'], total: 0, limit: 50, hasMore: false, items: [] },
    }));

    try {
      await registeredHandler(SHOW_SYNTAX_HELP_COMMAND)();
      const args = vscodeTestState.executeCommandHistory[0].args as { line: string; cursorColumn: number };
      assert.strictEqual(args.line.length, 2000);
      assert.strictEqual(args.cursorColumn, 1000);
      assert.strictEqual(vscodeTestState.errorLog.length, 0);
    } finally {
      disposables.forEach((disposable) => disposable.dispose());
      Reflect.deleteProperty(windowWithEditor, 'activeTextEditor');
      resetVscodeTestState();
    }
  });

  test('manual search opens a reusable script-enabled panel and internal navigation stays in that panel', async () => {
    resetVscodeTestState();
    const item: SyntaxHelpItem = {
      id: 'syntax:1',
      source: 'syntax',
      name: 'ТекущаяДата (CurrentDate)',
      path: 'Global context.html',
      snippet: 'ТекущаяДата (CurrentDate)',
    };
    const article: SyntaxHelpArticle = {
      id: item.id,
      source: item.source,
      name: 'Глобальный контекст',
      path: item.path,
      markdown: '# Глобальный контекст\n\nПравила работы.',
    };
    let panelFactoryCalls = 0;
    let revealCalls = 0;
    let disposeListener: (() => void) | undefined;
    let webviewMessageListener: ((message: unknown) => unknown) | undefined;
    const linkedArticle: SyntaxHelpArticle = {
      id: 'syntax:2', source: 'syntax', name: 'Связанная статья', path: 'methods/Linked.html',
      markdown: '# Связанная статья\n\nTarget content.',
    };
    const panel = {
      title: '',
      webview: {
        cspSource: 'vscode-webview://test',
        html: '',
        onDidReceiveMessage: (listener: (message: unknown) => unknown) => {
          webviewMessageListener = listener;
          return { dispose: () => { webviewMessageListener = undefined; } };
        },
      },
      reveal: () => { revealCalls += 1; },
      onDidDispose: (listener: () => void) => { disposeListener = listener; return { dispose: () => undefined }; },
      dispose: () => { disposeListener?.(); },
    };
    const windowObject = vscode.window as unknown as {
      createWebviewPanel: typeof vscode.window.createWebviewPanel;
    };
    const originalCreateWebviewPanel = windowObject.createWebviewPanel;
    windowObject.createWebviewPanel = ((_type, _title, _column, options) => {
      panelFactoryCalls += 1;
      assert.strictEqual(options?.enableScripts, true);
      assert.deepStrictEqual(options?.localResourceRoots, []);
      return panel as unknown as vscode.WebviewPanel;
    }) as typeof vscode.window.createWebviewPanel;
    const disposables = registerSyntaxHelpCommands();
    setExecuteCommandHandler(async (_command, args) => {
      const params = args as { action: string; id?: string };
      if (params.action === 'search') {
        return { success: true, data: { query: 'Транзакции', total: 1, limit: 50, hasMore: false, items: [item] } };
      }
      return { success: true, data: params.id === linkedArticle.id ? linkedArticle : article };
    });
    vscodeTestState.inputBoxQueue.push('ТекущаяДата', 'CurrentDate');
    vscodeTestState.quickPickQueue.push(
      { label: item.name, description: item.path, detail: item.snippet, item },
      { label: item.name, description: item.path, detail: item.snippet, item },
    );

    try {
      await registeredHandler(SEARCH_SYNTAX_HELP_COMMAND)();
      assert.strictEqual(panelFactoryCalls, 1);
      assert.ok(panel.webview.html.includes('Правила работы.'));
      assert.ok(panel.webview.html.includes('Найденный элемент: <strong>ТекущаяДата (CurrentDate)</strong>'));
      assert.ok(panel.webview.html.includes('Статья справки: <strong>Глобальный контекст</strong>'));
      assert.ok(typeof webviewMessageListener === 'function');
      await webviewMessageListener!({ type: 'openArticle', targetId: linkedArticle.id });
      assert.strictEqual(panel.title, linkedArticle.name);
      assert.ok(panel.webview.html.includes('Target content.'));
      assert.ok(panel.webview.html.includes('id="syntax-help-back"'));
      const getCalls = vscodeTestState.executeCommandHistory.filter(({ args }) =>
        (args as { action?: string })?.action === 'get');
      const linkedGet = getCalls[getCalls.length - 1];
      assert.deepStrictEqual(linkedGet?.args, { action: 'get', id: linkedArticle.id, source: 'syntax' });

      await webviewMessageListener!({ type: 'openArticle', targetId: 'javascript:alert(1)' });
      await webviewMessageListener!({ type: 'openArticle', targetId: linkedArticle.id, extra: true });
      assert.strictEqual(vscodeTestState.executeCommandHistory.filter(({ args }) =>
        (args as { action?: string })?.action === 'get').length, 2);

      await webviewMessageListener!({ type: 'back' });
      assert.strictEqual(panel.title, article.name);
      assert.ok(panel.webview.html.includes('Правила работы.'));
      assert.ok(!panel.webview.html.includes('id="syntax-help-back"'));

      await registeredHandler(SEARCH_SYNTAX_HELP_COMMAND)();
      assert.strictEqual(panelFactoryCalls, 1);
      assert.strictEqual(revealCalls, 1);
      assert.strictEqual(panel.title, article.name);
      assert.strictEqual(vscodeTestState.executeCommandHistory.filter(({ args }) =>
        (args as { action?: string })?.action === 'get').length, 3);
    } finally {
      disposables.forEach((disposable) => disposable.dispose());
      windowObject.createWebviewPanel = originalCreateWebviewPanel;
      resetVscodeTestState();
    }
  });

  test('shows an error when retrieving the selected article fails', async () => {
    resetVscodeTestState();
    const item: SyntaxHelpItem = {
      id: 'syntax:1', source: 'syntax', name: 'Глобальный контекст', path: 'Global context.html', snippet: 'Контекст',
    };
    const disposables = registerSyntaxHelpCommands();
    setExecuteCommandHandler(async (_command, args) => {
      const params = args as { action: string };
      if (params.action === 'search') {
        return { success: true, data: { query: 'Контекст', total: 1, limit: 50, hasMore: false, items: [item] } };
      }
      return { success: false, code: 'KNOWLEDGE_ITEM_NOT_FOUND', error: 'Knowledge item was not found.' };
    });
    vscodeTestState.inputBoxQueue.push('Контекст');
    vscodeTestState.quickPickQueue.push({ label: item.name, description: item.path, detail: item.snippet, item });

    try {
      await registeredHandler(SEARCH_SYNTAX_HELP_COMMAND)();
      assert.strictEqual(vscodeTestState.errorLog.length, 1);
      assert.ok(vscodeTestState.errorLog[0].includes('Не удалось открыть статью справки'));
    } finally {
      disposables.forEach((disposable) => disposable.dispose());
      resetVscodeTestState();
    }
  });
});
