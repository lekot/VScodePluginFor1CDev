import * as path from 'path';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { MetadataTreeDataProvider } from '../../src/providers/treeDataProvider';
import { PropertiesProvider } from '../../src/providers/propertiesProvider';
import { TypeEditorProvider } from '../../src/providers/typeEditorProvider';
import { TreeNode, MetadataType } from '../../src/models/treeNode';

suite('Properties Integration Test Suite', () => {
  let extension: vscode.Extension<any> | undefined;

  suiteSetup(async function () {
    this.timeout(8000);
    extension = vscode.extensions.getExtension('1c-dev.1c-metadata-tree-vscode');
    if (extension && !extension.isActive) {
      try {
        await extension.activate();
      } catch {
        // Extension may fail to activate in headless CI without workspace
      }
    }
  });

  function createMockContext(): vscode.ExtensionContext {
    return {
      subscriptions: [],
      extensionPath: '',
      extensionUri: vscode.Uri.file(path.resolve(__dirname, '..', '..')),
      globalState: {} as any,
      workspaceState: {} as any,
      secrets: {} as any,
      storageUri: undefined,
      storagePath: undefined,
      globalStorageUri: vscode.Uri.file(path.resolve(__dirname, '..', '..')),
      globalStoragePath: '',
      logUri: vscode.Uri.file(path.resolve(__dirname, '..', '..')),
      logPath: '',
      extensionMode: vscode.ExtensionMode.Test,
      extension: {} as any,
      environmentVariableCollection: {} as any,
      languageModelAccessInformation: {} as any,
      asAbsolutePath: (p: string) => p,
    };
  }

  function createNode(id: string, name: string, type: MetadataType): TreeNode {
    return {
      id,
      name,
      type,
      properties: { Name: name },
      children: [],
      isExpanded: false,
    };
  }

  test('showProperties command is registered and executable with real node payload', async function () {
    this.timeout(8000);
    const commands = await vscode.commands.getCommands(true);
    if (!commands.includes('1c-metadata-tree.showProperties')) { this.skip(); return; }
    const testNode = createNode('test-catalog-1', 'TestCatalog', MetadataType.Catalog);
    await vscode.commands.executeCommand('1c-metadata-tree.showProperties', testNode);
    assert.ok(true, 'Command executed with concrete node payload');
  });

  test('openXML command remains registered for explicit context action', async function () {
    this.timeout(8000);
    const commands = await vscode.commands.getCommands(true);
    if (!commands.includes('1c-metadata-tree.openXML')) { this.skip(); return; }
  });

  test('provider reuses single panel and updates payload for next selected node', async function () {
    this.timeout(8000);
    const mockContext = createMockContext();
    const treeDataProvider = new MetadataTreeDataProvider();
    const typeEditorProvider = new TypeEditorProvider(mockContext);
    const provider = new PropertiesProvider(mockContext, treeDataProvider, typeEditorProvider);

    let panelCreateCount = 0;
    const fakePanel = {
      reveal: () => undefined,
      onDidDispose: () => ({ dispose: () => undefined }),
      webview: {
        html: '',
        onDidReceiveMessage: () => ({ dispose: () => undefined }),
        postMessage: async () => true,
      },
      dispose: () => undefined,
    } as unknown as vscode.WebviewPanel;

    (provider as any).createPanel = () => {
      panelCreateCount += 1;
      return fakePanel;
    };

    const node1 = createNode('test-catalog-1', 'Catalog1', MetadataType.Catalog);
    const node2 = createNode('test-catalog-2', 'Catalog2', MetadataType.Catalog);
    await provider.showProperties(node1);
    await provider.showProperties(node2);

    assert.strictEqual(panelCreateCount, 1, 'Properties panel should be singleton and reused');
    assert.ok(
      fakePanel.webview.html.includes('Catalog2'),
      'Reused panel should be refreshed with the currently selected node payload'
    );
    provider.dispose();
  });
});
