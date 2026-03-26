import * as assert from 'assert';
import * as vscode from 'vscode';
import { registerEditorCommands } from '../../src/commands/editorCommands';

suite('editorCommands', () => {
  const defaultRegisterCommand = vscode.commands.registerCommand.bind(vscode.commands);

  setup(() => {
    (vscode.commands as any).registerCommand = defaultRegisterCommand;
  });

  teardown(() => {
    (vscode.commands as any).registerCommand = defaultRegisterCommand;
  });

  test('registers six editor-related command handlers', () => {
    const ids: string[] = [];
    (vscode.commands as any).registerCommand = (id: string) => {
      ids.push(id);
      return { dispose: () => undefined };
    };

    const disposables = registerEditorCommands({ state: {} as any });

    assert.strictEqual(disposables.length, 6);
    assert.deepStrictEqual(ids, [
      '1c-metadata-tree.showProperties',
      '1c-metadata-tree.openXML',
      '1c-metadata-tree.openBslModule',
      '1c-metadata-tree.openFormEditor',
      '1c-metadata-tree.openRightsEditor',
      '1c-metadata-tree.saveRightsEditor',
    ]);
  });
});
