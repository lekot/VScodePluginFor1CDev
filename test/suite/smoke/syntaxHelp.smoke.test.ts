import * as assert from 'assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'Lekot.1c-metadata-tree-vscode';
const AGENT_SYNTAX_HELP_COMMAND = '1c-metadata-tree.agent.syntaxHelp';
const SHOW_SYNTAX_HELP_COMMAND = '1c-metadata-tree.showSyntaxHelp';
const SEARCH_SYNTAX_HELP_COMMAND = '1c-metadata-tree.searchSyntaxHelp';

suite('Smoke: BSL syntax help', () => {
  test('activates user commands and searches the current-line context through Agent API', async function () {
    this.timeout(20000);
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `Extension ${EXTENSION_ID} must be loaded by the smoke runner`);
    if (!extension.isActive) { await extension.activate(); }

    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes(AGENT_SYNTAX_HELP_COMMAND));
    assert.ok(commands.includes(SHOW_SYNTAX_HELP_COMMAND));
    assert.ok(commands.includes(SEARCH_SYNTAX_HELP_COMMAND));

    const manifest = extension.packageJSON as {
      contributes?: {
        commands?: Array<{ command: string }>;
        keybindings?: Array<{ command: string; key: string; when?: string }>;
      };
    };
    assert.ok(manifest.contributes?.commands?.some(({ command }) => command === SHOW_SYNTAX_HELP_COMMAND));
    assert.ok(manifest.contributes?.commands?.some(({ command }) => command === SEARCH_SYNTAX_HELP_COMMAND));
    assert.ok(manifest.contributes?.keybindings?.some(({ command, key, when }) =>
      command === SHOW_SYNTAX_HELP_COMMAND && key.toLowerCase() === 'ctrl+f1'
      && when?.includes('resourceLangId == bsl')));

    const line = 'Переменная = Форма;';
    const cursorColumn = line.indexOf('Форма');
    const result = await vscode.commands.executeCommand<{
      success: boolean;
      data?: { line: string; terms: string[]; items: Array<{ id: string; source: string; name: string; path: string; snippet: string }> };
      error?: string;
    }>(AGENT_SYNTAX_HELP_COMMAND, {
      action: 'searchLine', line, cursorColumn, source: 'syntax', limit: 50,
    });
    assert.strictEqual(result.success, true, result.error);
    assert.strictEqual(result.data?.line, line);
    assert.strictEqual(result.data?.terms[0], 'Форма');

    const match = result.data?.items.find(({ path: itemPath }) =>
      itemPath === 'catalog63/catalog272/catalog1506/object1522/properties/Form6362.html');
    assert.ok(match, 'The detailed Form article should be surfaced alongside other matching Form entries.');
    assert.strictEqual(match.id, 'syntax:20814');
    assert.strictEqual(match.name, 'Форма (Form)');
    assert.strictEqual(match.path, 'catalog63/catalog272/catalog1506/object1522/properties/Form6362.html');
    assert.ok(match.snippet.length > match.name.length, 'The snippet should come from the detailed article.');

    const formArticle = await vscode.commands.executeCommand<{
      success: boolean;
      data?: { id: string; path: string; markdown: string };
      error?: string;
    }>(AGENT_SYNTAX_HELP_COMMAND, { action: 'get', id: match.id, source: 'syntax' });
    assert.strictEqual(formArticle.success, true, formArticle.error);
    assert.strictEqual(formArticle.data?.id, match.id);
    assert.strictEqual(formArticle.data?.path, match.path);
    assert.ok(formArticle.data?.markdown.length);
  });

  test('surfaces the standalone CurrentDate method and reads its detailed article through Agent API', async function () {
    this.timeout(20000);
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `Extension ${EXTENSION_ID} must be loaded by the smoke runner`);
    if (!extension.isActive) { await extension.activate(); }

    const line = 'Результат = ТекущаяДата();';
    const result = await vscode.commands.executeCommand<{
      success: boolean;
      data?: { line: string; terms: string[]; items: Array<{ id: string; source: string; name: string; path: string; snippet: string }> };
      error?: string;
    }>(AGENT_SYNTAX_HELP_COMMAND, {
      action: 'searchLine', line, cursorColumn: line.indexOf('ТекущаяДата') + 3, source: 'syntax', limit: 10,
    });
    assert.strictEqual(result.success, true, result.error);
    assert.strictEqual(result.data?.line, line);
    assert.strictEqual(result.data?.terms[0], 'ТекущаяДата');

    const match = result.data?.items[0];
    assert.ok(match, 'The exact CurrentDate method should be surfaced.');
    assert.strictEqual(match.id, 'syntax:2986');
    assert.strictEqual(match.source, 'syntax');
    assert.strictEqual(match.path, 'Global context/methods/catalog4840/CurrentDate956.html');

    const article = await vscode.commands.executeCommand<{
      success: boolean;
      data?: { id: string; path: string; markdown: string };
      error?: string;
    }>(AGENT_SYNTAX_HELP_COMMAND, { action: 'get', id: match.id, source: 'syntax' });
    assert.strictEqual(article.success, true, article.error);
    assert.strictEqual(article.data?.id, match.id);
    assert.strictEqual(article.data?.path, match.path);
    assert.match(article.data?.markdown ?? '', /Синтаксис:\s*ТекущаяДата\(\)/);
    assert.match(article.data?.markdown ?? '', /Описание:\s*Определяет текущую \(системную\) дату на компьютере\./);
  });
});
