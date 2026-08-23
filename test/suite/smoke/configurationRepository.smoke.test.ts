import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Smoke: Configuration Repository command surface', () => {
  test('phase-1 repository commands are registered by the activated extension', async function () {
    this.timeout(15000);
    const extension = vscode.extensions.getExtension('1c-dev.1c-metadata-tree-vscode');
    assert.ok(extension, 'CDT extension must be present');
    if (extension && !extension.isActive) {
      await extension.activate();
    }
    const commands = new Set(await vscode.commands.getCommands(true));
    for (const suffix of [
      'connect',
      'disconnect',
      'lock',
      'unlock',
      'commit',
      'updateObject',
      'updateConfiguration',
    ]) {
      assert.ok(commands.has(`1c-metadata-tree.repository.${suffix}`), `missing repository.${suffix}`);
    }
  });
});
