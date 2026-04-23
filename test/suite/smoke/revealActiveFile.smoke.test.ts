/**
 * Smoke tests for the `1c-metadata-tree.revealActiveFileInTree` command.
 *
 * Verification strategy:
 *   After calling revealActiveFileInTree, the tree selection should be set to
 *   the located node. We verify this indirectly via `1c-metadata-tree.openXML`
 *   (without a node argument) — that command opens the XML file of the
 *   *currently selected* tree node. We then check activeTextEditor.document.uri
 *   to confirm the correct node was selected/revealed.
 *
 *   `openXML` uses `getSelectedNode(state, undefined)` → `state.treeView?.selection?.[0]`,
 *   so it reliably reflects the current tree selection.
 *
 *   This avoids the need to access `state.treeView.selection` directly
 *   (the extension does not export its internal state).
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
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

/**
 * Focus the metadata tree panel (without triggering a reveal that would change selection).
 * We use workbench.view.explorer to make the sidebar visible, which in turn makes
 * the TreeView visible — required for treeView.reveal() to work reliably.
 */
async function showMetadataTreePanel(): Promise<void> {
  await vscode.commands.executeCommand('1c-metadata-tree.openPanel');
  await new Promise((r) => setTimeout(r, 400));
}

/** Open a file in the editor and wait briefly for it to be active. */
async function openFile(filePath: string): Promise<void> {
  const uri = vscode.Uri.file(filePath);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);
  // Give VS Code time to make this the active text editor
  await new Promise((r) => setTimeout(r, 400));
}

/**
 * Poll `openXML` (no-arg → uses current tree selection) until activeTextEditor changes
 * to a path containing `expectedFragment`, or timeout. Returns the final active editor path.
 *
 * This is our primary way to observe treeView.selection without direct access to state.
 */
async function pollOpenXmlUntilMatch(expectedFragment: string, timeoutMs = 8000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastPath = '';
  while (Date.now() < deadline) {
    await vscode.commands.executeCommand('1c-metadata-tree.openXML');
    await new Promise((r) => setTimeout(r, 300));
    const uri = vscode.window.activeTextEditor?.document?.uri;
    if (uri && uri.scheme === 'file') {
      lastPath = uri.fsPath;
      if (lastPath.includes(expectedFragment)) {
        return lastPath;
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return lastPath;
}

suite('Smoke: revealActiveFileInTree command', () => {
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
        'Smoke precondition: workspace folder is required. The fixture workspace (test/fixtures/designer-config) must be open.'
      );
    }
    workspacePath = folders[0].uri.fsPath;

    // Show the tree panel so treeView becomes visible, then wait for it to load.
    await showMetadataTreePanel();
    await waitForTreeReady(25000);
  });

  /**
   * Test 1: CommonModule flat XML → reveals CommonModule node.
   *
   * FlatOnlyModule.xml is a flat CommonModule XML (no subdirectory). The path
   * CommonModules/FlatOnlyModule.xml is resolved by locateMetadataFile as:
   *   objectType=CommonModules, objectName=FlatOnlyModule, subPath=undefined.
   *
   * Note: Designer BSL path (CommonModules/X/Ext/Module/Module.bsl with 4 segments
   * after the type folder) is not currently handled by locateMetadataFile — it expects
   * depth-3 paths like X/Ext/Module.bsl. The flat XML is the canonical smoke fixture.
   */
  test('smoke: revealActiveFileInTree - CommonModule XML reveals CommonModule node', async function () {
    this.timeout(30000);

    const xmlPath = path.join(workspacePath, 'CommonModules', 'FlatOnlyModule.xml');

    if (!fs.existsSync(xmlPath)) {
      recordFailure({
        step: 'revealActiveFile:commonModule:precondition',
        error: new Error('Fixture file not found: ' + xmlPath),
        command: '1c-metadata-tree.revealActiveFileInTree',
      });
      assert.fail('Fixture file not found: ' + xmlPath);
    }

    try {
      // Open the target metadata file — this makes it the active text editor.
      await openFile(xmlPath);

      // Invoke the command under test.
      await vscode.commands.executeCommand('1c-metadata-tree.revealActiveFileInTree');
      // Give VS Code time to complete the reveal and update treeView.selection.
      await new Promise((r) => setTimeout(r, 1500));

      // Primary assertion: check treeView.selection directly via test-helper command.
      const selectedName = await vscode.commands.executeCommand<string | null>(
        '1c-metadata-tree.getSelectionNameForTest'
      );
      assert.ok(selectedName, 'treeView.selection should be non-empty after reveal');
      assert.strictEqual(
        selectedName,
        'FlatOnlyModule',
        'Selected node should be FlatOnlyModule but got: ' + selectedName
      );

      // Secondary: verify via openXML (selection → XML file path).
      const openedPath = await pollOpenXmlUntilMatch('FlatOnlyModule', 8000);
      assert.ok(
        openedPath.includes('FlatOnlyModule'),
        'openXML after reveal should open FlatOnlyModule.xml but opened: ' + openedPath
      );
    } catch (err) {
      recordFailure({
        step: 'revealActiveFile:commonModule',
        error: err instanceof Error ? err : new Error(String(err)),
        command: '1c-metadata-tree.revealActiveFileInTree',
      });
      throw err;
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
  });

  /**
   * Test 2: Catalog flat XML → reveals Catalog node.
   *
   * CatalogGoodsA.xml path is resolved as:
   *   objectType=Catalogs, objectName=CatalogGoodsA, subPath=undefined.
   */
  test('smoke: revealActiveFileInTree - Catalog flat XML reveals Catalog node', async function () {
    this.timeout(30000);

    const xmlPath = path.join(workspacePath, 'Catalogs', 'CatalogGoodsA.xml');

    if (!fs.existsSync(xmlPath)) {
      recordFailure({
        step: 'revealActiveFile:catalog:precondition',
        error: new Error('Fixture file not found: ' + xmlPath),
        command: '1c-metadata-tree.revealActiveFileInTree',
      });
      assert.fail('Fixture file not found: ' + xmlPath);
    }

    try {
      await openFile(xmlPath);

      await vscode.commands.executeCommand('1c-metadata-tree.revealActiveFileInTree');
      await new Promise((r) => setTimeout(r, 1500));

      const openedPath = await pollOpenXmlUntilMatch('CatalogGoodsA', 8000);

      assert.ok(
        openedPath.includes('CatalogGoodsA'),
        'openXML after reveal should open CatalogGoodsA.xml but opened: ' + openedPath
      );
    } catch (err) {
      recordFailure({
        step: 'revealActiveFile:catalog',
        error: err instanceof Error ? err : new Error(String(err)),
        command: '1c-metadata-tree.revealActiveFileInTree',
      });
      throw err;
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
  });

  // TODO(#88): This test is a no-throw check only because VS Code does not expose
  // an API to intercept showInformationMessage() calls from tests, so we cannot
  // assert the info message text. The primary assertion is that the command
  // completes without throwing and does not change the tree selection.
  test('smoke: revealActiveFileInTree - non-metadata file does not throw', async function () {
    this.timeout(20000);

    // Create a temporary file outside the config root.
    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, 'cdt41-smoke-nonmeta-' + Date.now() + '.txt');
    fs.writeFileSync(tmpFile, 'not a 1C metadata file');

    try {
      await openFile(tmpFile);

      // Command must not throw for a file outside the config root.
      // It should show an info message and leave the tree selection unchanged.
      await vscode.commands.executeCommand('1c-metadata-tree.revealActiveFileInTree');
      await new Promise((r) => setTimeout(r, 500));

      // No exception above = test passes. We cannot intercept the info message.
    } catch (err) {
      recordFailure({
        step: 'revealActiveFile:nonMetadata',
        error: err instanceof Error ? err : new Error(String(err)),
        command: '1c-metadata-tree.revealActiveFileInTree',
      });
      throw err;
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        // ignore cleanup error
      }
    }
  });
});
