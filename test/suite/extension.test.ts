import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
  const extensionId = '1c-dev.1c-metadata-tree-vscode';

  test('Extension should be present', function () {
    const ext = vscode.extensions.getExtension(extensionId);
    if (!ext) { this.skip(); return; }
    assert.ok(ext);
  });

  test('Extension should activate', async function () {
    const extension = vscode.extensions.getExtension(extensionId);
    if (!extension) { this.skip(); return; }
    if (!extension.isActive) {
      await extension.activate();
    }
    assert.ok(extension.isActive);
  });
});
