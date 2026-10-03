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
      data?: { line: string; terms: string[]; items: Array<{ name: string }> };
      error?: string;
    }>(AGENT_SYNTAX_HELP_COMMAND, {
      action: 'searchLine', line, cursorColumn, source: 'syntax', limit: 5,
    });
    assert.strictEqual(result.success, true, result.error);
    assert.strictEqual(result.data?.line, line);
    assert.strictEqual(result.data?.terms[0], 'Форма');
    assert.strictEqual(result.data?.items[0]?.name, 'Форма');
  });
});
