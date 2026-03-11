import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
  vscode.window.showInformationMessage('Start all tests.');

  test('Extension should be present', () => {
    assert.ok(vscode.extensions.getExtension('1c-dev.1c-metadata-tree-vscode'));
  });

  test('Extension should activate', async () => {
    const extension = vscode.extensions.getExtension('1c-dev.1c-metadata-tree-vscode');
    assert.ok(extension);
    if (extension) {
      await extension.activate();
      assert.ok(extension.isActive);
    }
  });
});
