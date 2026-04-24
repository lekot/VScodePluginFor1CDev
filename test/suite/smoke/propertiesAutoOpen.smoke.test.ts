/**
 * Smoke tests for issue #90: Properties panel must NOT auto-open on tree selection.
 *
 * Verification strategy:
 *   - After reveal/selection change without explicit showProperties, isOpen() must be false.
 *   - After explicit showProperties command, isOpen() must be true.
 *   - After selecting another node, panel content updates (currentNode changes) but panel stays open.
 *
 * We verify isOpen() via the test-helper command
 * `1c-metadata-tree.getPropertiesOpenStateForTest` (registered in utilityCommands.ts).
 */

import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { recordFailure } from './smokeArtifacts';

const EXT_ID = '1c-dev.1c-metadata-tree-vscode';

/** Poll until the metadata tree has a root node, or throw on timeout. */
async function waitForTreeReady(timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await vscode.commands.executeCommand<boolean>(
      '1c-metadata-tree.getTreeReadyForTest'
    );
    if (ready) {
      return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('Metadata tree did not become ready within ' + timeoutMs + 'ms');
}

async function getPropertiesOpen(): Promise<boolean> {
  return vscode.commands.executeCommand<boolean>(
    '1c-metadata-tree.getPropertiesOpenStateForTest'
  );
}

suite('Smoke: Properties panel auto-open prevention (#90)', () => {
  let workspacePath: string;

  suiteSetup(async function () {
    this.timeout(35000);

    const ext = vscode.extensions.getExtension(EXT_ID);
    if (!ext) {
      throw new Error(
        'Extension ' + EXT_ID + ' not loaded. Smoke must run with extensionDevelopmentPath.'
      );
    }
    if (!ext.isActive) {
      await ext.activate();
    }
    const deadline = Date.now() + 15000;
    while (!ext.isActive && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!ext.isActive) {
      throw new Error('Extension failed to activate within 15s.');
    }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      throw new Error(
        'Smoke precondition: workspace folder required. The fixture workspace (test/fixtures/designer-config) must be open.'
      );
    }
    workspacePath = folders[0].uri.fsPath;

    await vscode.commands.executeCommand('1c-metadata-tree.openPanel');
    await new Promise((r) => setTimeout(r, 400));
    await waitForTreeReady(25000);
  });

  /**
   * Test 1: After revealActiveFileInTree, Properties panel must NOT be open.
   * The selection listener no longer auto-opens it.
   */
  test('smoke: Properties panel does NOT auto-open after tree reveal (#90)', async function () {
    this.timeout(30000);

    const xmlPath = path.join(workspacePath, 'Catalogs', 'CatalogGoodsA.xml');

    try {
      // Open a metadata file and reveal it — this triggers tree selection change.
      const uri = vscode.Uri.file(xmlPath);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
      await new Promise((r) => setTimeout(r, 400));

      await vscode.commands.executeCommand('1c-metadata-tree.revealActiveFileInTree');
      // Wait a bit for selection-change event to fire and settle.
      await new Promise((r) => setTimeout(r, 1500));

      const isOpen = await getPropertiesOpen();
      assert.strictEqual(
        isOpen,
        false,
        'Properties panel must NOT auto-open when tree selection changes (issue #90)'
      );
    } catch (err) {
      recordFailure({
        step: 'propertiesAutoOpen:revealDoesNotOpen',
        error: err instanceof Error ? err : new Error(String(err)),
        command: '1c-metadata-tree.revealActiveFileInTree',
      });
      throw err;
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
  });

  /**
   * Test 2: After explicit showProperties command, panel IS open.
   */
  test('smoke: Properties panel opens via explicit showProperties command (#90)', async function () {
    this.timeout(20000);

    const xmlPath = path.join(workspacePath, 'Catalogs', 'CatalogGoodsA.xml');

    try {
      const uri = vscode.Uri.file(xmlPath);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
      await new Promise((r) => setTimeout(r, 400));

      // Reveal to get selection.
      await vscode.commands.executeCommand('1c-metadata-tree.revealActiveFileInTree');
      await new Promise((r) => setTimeout(r, 1000));

      // Explicitly open Properties via command (as user would from context menu).
      await vscode.commands.executeCommand('1c-metadata-tree.showProperties');
      await new Promise((r) => setTimeout(r, 800));

      const isOpen = await getPropertiesOpen();
      assert.strictEqual(
        isOpen,
        true,
        'Properties panel must be open after explicit showProperties command'
      );
    } catch (err) {
      recordFailure({
        step: 'propertiesAutoOpen:explicitOpen',
        error: err instanceof Error ? err : new Error(String(err)),
        command: '1c-metadata-tree.showProperties',
      });
      throw err;
    } finally {
      // Close the Properties panel for cleanup.
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
  });
});
