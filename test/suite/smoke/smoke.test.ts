import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { MetadataParser } from '../../../src/parsers/metadataParser';
import { FormatDetector } from '../../../src/parsers/formatDetector';
import { TreeNode, MetadataType } from '../../../src/models/treeNode';
import { formXmlExists } from '../../../src/formEditor/formPaths';
import { recordFailure } from './smokeArtifacts';

/** Focus 1C Metadata tree view so smoke UI stays in metadata tree, not Explorer. */
async function focusMetadataTree(): Promise<void> {
  await vscode.commands.executeCommand('workbench.view.explorer');
  await new Promise((r) => setTimeout(r, 200));
  await vscode.commands.executeCommand('1c-metadata-tree.focus');
  await new Promise((r) => setTimeout(r, 200));
}

/** Ensure 1C Metadata view is focused and tree expanded; retry until root is loaded. */
async function ensureMetadataTreeFocused(): Promise<void> {
  await vscode.commands.executeCommand('1c-metadata-tree.openPanel');
  await new Promise((r) => setTimeout(r, 2000));
  for (let i = 0; i < 15; i++) {
    await focusMetadataTree();
    await new Promise((r) => setTimeout(r, 300));
  }
}

suite('Smoke: 1C metadata tree, forms, commands', () => {
  let configPath: string | null = null;
  let allNodes: TreeNode[] = [];
  let formNodes: TreeNode[] = [];

  suiteSetup(async function () {
    this.timeout(30000);
    const ext = vscode.extensions.getExtension('1c-dev.1c-metadata-tree-vscode');
    if (!ext) {
      throw new Error(
        'Extension 1c-dev.1c-metadata-tree-vscode not loaded. Ensure runSmoke launches with extensionDevelopmentPath and a workspace.'
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
      configPath = null;
      return;
    }
    const workspacePath = folders[0].uri.fsPath;
    configPath = await FormatDetector.findConfigurationRoot(workspacePath);
    if (!configPath) {
      configPath = null;
      return;
    }

    try {
      const rootNode = await MetadataParser.parse(configPath);
      function collect(node: TreeNode): void {
        allNodes.push(node);
        if (node.children) {
          for (const child of node.children) collect(child);
        }
      }
      collect(rootNode);
      formNodes = allNodes.filter((n) => n.type === MetadataType.Form && n.filePath);
    } catch (err) {
      recordFailure({
        step: 'parse-tree',
        error: err instanceof Error ? err : new Error(String(err)),
      });
      throw err;
    }
  });

  test('smoke: tree parsed and has nodes', function () {
    if (!configPath) {
      this.skip();
      return;
    }
    assert.ok(allNodes.length >= 1, 'At least root node');
    assert.strictEqual(allNodes[0].name, 'Configuration');
  });

  test('smoke: open all Form.xml via metadata tree (openFormEditor)', async function () {
    if (!configPath || formNodes.length === 0) {
      this.skip();
      return;
    }
    this.timeout(Math.max(60000, formNodes.length * 3000));

    await ensureMetadataTreeFocused();

    const treeReady = await vscode.commands.executeCommand(
      '1c-metadata-tree.getTreeReadyForTest'
    ) as boolean;
    if (!treeReady) {
      recordFailure({
        step: 'tree-ready',
        error: new Error('Metadata tree was not loaded; focus/expand did not succeed'),
        command: '1c-metadata-tree.getTreeReadyForTest',
      });
      assert.fail('Metadata tree was not loaded. Test must run against the extension UI (metadata tree focused and expanded).');
    }

    for (const node of formNodes) {
      if (!node.filePath) continue;
      if (!formXmlExists(node.filePath)) continue;
      try {
        await focusMetadataTree();
        await vscode.commands.executeCommand('1c-metadata-tree.openFormEditor', node);
        await new Promise((r) => setTimeout(r, 500));
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        await new Promise((r) => setTimeout(r, 100));
      } catch (err) {
        recordFailure({
          step: `openFormEditor:${node.id}`,
          error: err instanceof Error ? err : new Error(String(err)),
          nodeId: node.id,
          nodeName: node.name,
          command: '1c-metadata-tree.openFormEditor',
        });
        assert.fail(err instanceof Error ? err.message : String(err));
      }
    }
  });

  test('smoke: commands without modal input', async function () {
    this.timeout(15000);
    const commandsNoArg = [
      '1c-metadata-tree.openPanel',
      '1c-metadata-tree.refresh',
      '1c-metadata-tree.clearSearch',
      '1c-metadata-tree.clearCache',
    ];
    for (const cmd of commandsNoArg) {
      try {
        await vscode.commands.executeCommand(cmd);
        await new Promise((r) => setTimeout(r, 200));
      } catch (err) {
        recordFailure({
          step: `command:${cmd}`,
          error: err instanceof Error ? err : new Error(String(err)),
          command: cmd,
        });
        assert.fail(`${cmd}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const sampleNode =
      allNodes.find((n) => n.filePath && n.filePath.endsWith('.xml')) ?? allNodes.find((_, i) => i > 0);
    if (sampleNode) {
      try {
        await vscode.commands.executeCommand('1c-metadata-tree.showProperties', sampleNode);
        await new Promise((r) => setTimeout(r, 200));
      } catch (err) {
        recordFailure({
          step: 'command:showProperties',
          error: err instanceof Error ? err : new Error(String(err)),
          nodeId: sampleNode.id,
          nodeName: sampleNode.name,
          command: '1c-metadata-tree.showProperties',
        });
      }
      try {
        await vscode.commands.executeCommand('1c-metadata-tree.openXML', sampleNode);
        await new Promise((r) => setTimeout(r, 200));
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        await focusMetadataTree();
      } catch (err) {
        recordFailure({
          step: 'command:openXML',
          error: err instanceof Error ? err : new Error(String(err)),
          nodeId: sampleNode.id,
          command: '1c-metadata-tree.openXML',
        });
      }
      try {
        await vscode.commands.executeCommand('1c-metadata-tree.copyPathOrName', sampleNode);
      } catch (err) {
        recordFailure({
          step: 'command:copyPathOrName',
          error: err instanceof Error ? err : new Error(String(err)),
          command: '1c-metadata-tree.copyPathOrName',
        });
      }
    }

    for (const formNode of formNodes.slice(0, 3)) {
      if (!formNode.filePath || !formXmlExists(formNode.filePath)) continue;
      try {
        await vscode.commands.executeCommand('1c-metadata-tree.openFormEditor', formNode);
        await new Promise((r) => setTimeout(r, 300));
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        await focusMetadataTree();
      } catch (err) {
        recordFailure({
          step: `command:openFormEditor:${formNode.id}`,
          error: err instanceof Error ? err : new Error(String(err)),
          nodeId: formNode.id,
          nodeName: formNode.name,
          command: '1c-metadata-tree.openFormEditor',
        });
      }
    }
  });
});
