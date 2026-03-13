import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { MetadataParser } from '../../src/parsers/metadataParser';
import { MetadataTreeDataProvider } from '../../src/providers/treeDataProvider';
import { MetadataType } from '../../src/models/treeNode';
import { ConfigFormat } from '../../src/parsers/formatDetector';

suite('Integration', () => {
  const fixturesPath = path.join(__dirname, '../fixtures', 'designer-config');

  test('load designer config and display in tree', async () => {
    const rootNode = await MetadataParser.parse(fixturesPath);
    assert.ok(rootNode);
    assert.strictEqual(rootNode.name, 'Configuration');
    assert.strictEqual(rootNode.type, MetadataType.Configuration);

    const mockContext = {
      subscriptions: [] as vscode.Disposable[],
      extensionPath: '',
      extensionUri: vscode.Uri.file(''),
      globalState: {} as vscode.Memento,
      workspaceState: {} as vscode.Memento,
      secrets: {} as vscode.SecretStorage,
      storageUri: undefined,
      storagePath: undefined,
      globalStorageUri: vscode.Uri.file(''),
      globalStoragePath: '',
      logUri: vscode.Uri.file(''),
      logPath: '',
      extensionMode: vscode.ExtensionMode.Test,
      extension: {} as vscode.Extension<unknown>,
      environmentVariableCollection: {} as vscode.EnvironmentVariableCollection,
      languageModelAccessInformation: {} as vscode.LanguageModelAccessInformation,
      asAbsolutePath: (p: string) => p,
    };

    const provider = new MetadataTreeDataProvider(mockContext as vscode.ExtensionContext);
    const format = await MetadataParser.getFormat(fixturesPath);
    provider.setRootNode(rootNode, { configPath: fixturesPath, format });

    const children = await provider.getChildren();
    assert.strictEqual(children.length, 1);
    assert.strictEqual(children[0].name, 'Configuration');

    const typeChildren = await provider.getChildren(children[0]);
    assert.ok(typeChildren.length >= 1);
    const catalogs = typeChildren.find((n) => n.name === 'Catalogs');
    assert.ok(catalogs);
    const catalogChildren = await provider.getChildren(catalogs);
    assert.ok(catalogChildren.length >= 1);
    const testCatalog = catalogChildren.find((n) => n.name === 'TestCatalog1');
    assert.ok(testCatalog);
    assert.strictEqual(testCatalog.type, MetadataType.Catalog);
  });
});
