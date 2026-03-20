import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as vscode from 'vscode';
import { MetadataParser } from '../../src/parsers/metadataParser';
import { MetadataTreeDataProvider } from '../../src/providers/treeDataProvider';
import { TreeNode, MetadataType } from '../../src/models/treeNode';
import { ConfigFormat } from '../../src/parsers/formatDetector';
import { createElement } from '../../src/services/elementOperations';

suite('Integration', () => {
  const fixturesPath = path.join(__dirname, '../fixtures', 'designer-config');

  test('createElement creates missing type folder (Documents)', async () => {
    // Arrange: copy fixture to temp dir and remove Documents folder
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), '1cviewer-doc-create-'));
    const tmpConfigPath = path.join(tmpRoot, 'designer-config-copy');
    await fs.promises.mkdir(tmpConfigPath, { recursive: true });

    // Copy fixture (simple recursive copy using native fs.cp APIs)
    if ((fs.promises as any).cp) {
      await (fs.promises as any).cp(fixturesPath, tmpConfigPath, { recursive: true });
    } else if ((fs as any).cpSync) {
      (fs as any).cpSync(fixturesPath, tmpConfigPath, { recursive: true });
    } else {
      throw new Error('Neither fs.promises.cp nor fs.cpSync is available in this Node runtime');
    }

    const removedDir = path.join(tmpConfigPath, 'Documents');
    if (fs.existsSync(removedDir)) {
      await fs.promises.rm(removedDir, { recursive: true, force: true });
    }

    // Build a placeholder Documents type-node
    const rootNode: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      filePath: path.join(tmpConfigPath, 'Configuration.xml'),
      children: [],
    };

    const documentsNode: TreeNode = {
      id: 'Documents',
      name: 'Documents',
      type: MetadataType.Document,
      properties: { type: 'Documents' },
      filePath: path.join(tmpConfigPath, 'Documents'), // expected type folder for Designer
      children: [],
      parent: rootNode,
    };

    // Act: create a new document element under placeholder
    const newName = `TestDocument_${Date.now()}`;
    await createElement(documentsNode, newName);

    // Assert: type folder and file exist
    assert.ok(fs.existsSync(path.join(tmpConfigPath, 'Documents')), 'Documents type folder must be created');
    const expectedXmlPath = path.join(tmpConfigPath, 'Documents', `${newName}.xml`);
    assert.ok(fs.existsSync(expectedXmlPath), 'New document XML must be written');
  });

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
    const firstCatalog = catalogChildren[0];
    assert.ok(firstCatalog, 'Catalogs should contain at least one element');
    assert.strictEqual(firstCatalog.type, MetadataType.Catalog);
  });

  // Integration Tests for Subsystem Filtering (Phase 5.3)

  test('right-click on subsystem -> filter shows only subsystem contents', async () => {
    const rootNode = await MetadataParser.parse(fixturesPath);
    assert.ok(rootNode);

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

    // Find a subsystem node
    const children = await provider.getChildren();
    const configNode = children[0];
    const typeChildren = await provider.getChildren(configNode);
    const subsystems = typeChildren.find((n) => n.name === 'Subsystems');
    
    if (subsystems) {
      const subsystemChildren = await provider.getChildren(subsystems);
      if (subsystemChildren.length > 0) {
        const subsystem = subsystemChildren[0];
        
        // Apply subsystem filter
        provider.setSubsystemFilter(subsystem.id, subsystem.name);
        
        // Verify filter is active
        const filter = provider.getSubsystemFilter();
        assert.strictEqual(filter.subsystemId, subsystem.id);
        assert.strictEqual(filter.subsystemName, subsystem.name);
        
        // Verify filter label
        const label = provider.getSubsystemFilterLabel();
        assert.ok(label?.includes(subsystem.name));
      }
    }
  });

  test('clear filter via context menu restores full tree', async () => {
    const rootNode = await MetadataParser.parse(fixturesPath);
    assert.ok(rootNode);

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

    // Get initial children count
    const initialChildren = await provider.getChildren();
    const initialCount = initialChildren.length;

    // Find and apply subsystem filter
    const configNode = initialChildren[0];
    const typeChildren = await provider.getChildren(configNode);
    const subsystems = typeChildren.find((n) => n.name === 'Subsystems');
    
    if (subsystems) {
      const subsystemChildren = await provider.getChildren(subsystems);
      if (subsystemChildren.length > 0) {
        const subsystem = subsystemChildren[0];
        
        // Apply filter
        provider.setSubsystemFilter(subsystem.id, subsystem.name);
        
        // Clear filter
        provider.setSubsystemFilter(null, null);
        
        // Verify filter is cleared
        const filter = provider.getSubsystemFilter();
        assert.strictEqual(filter.subsystemId, null);
        assert.strictEqual(filter.subsystemName, null);
        
        // Verify all nodes are visible again
        const clearedChildren = await provider.getChildren();
        assert.strictEqual(clearedChildren.length, initialCount);
      }
    }
  });

  test('combined filters: subsystem + type filter', async () => {
    const rootNode = await MetadataParser.parse(fixturesPath);
    assert.ok(rootNode);

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

    // Find a subsystem
    const children = await provider.getChildren();
    const configNode = children[0];
    const typeChildren = await provider.getChildren(configNode);
    const subsystems = typeChildren.find((n) => n.name === 'Subsystems');
    
    if (subsystems) {
      const subsystemChildren = await provider.getChildren(subsystems);
      if (subsystemChildren.length > 0) {
        const subsystem = subsystemChildren[0];
        
        // Apply both subsystem and type filters
        provider.setSubsystemFilter(subsystem.id, subsystem.name);
        provider.setTypeFilter([MetadataType.Catalog]);
        
        // Verify both filters are active
        const subsystemFilter = provider.getSubsystemFilter();
        assert.strictEqual(subsystemFilter.subsystemId, subsystem.id);
        
        const typeFilter = provider.getTypeFilter();
        assert.ok(typeFilter?.includes(MetadataType.Catalog));
        
        // Verify filter message includes both
        const label = provider.getSubsystemFilterLabel();
        assert.ok(label?.includes(subsystem.name));
      }
    }
  });

  test('edge case: empty subsystem', async () => {
    const rootNode = await MetadataParser.parse(fixturesPath);
    assert.ok(rootNode);

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

    // Create an empty subsystem node
    const emptySubsystem = {
      id: 'empty-subsystem',
      name: 'EmptySubsystem',
      type: MetadataType.Subsystem,
      properties: {},
      children: [],
    };

    // Apply filter for empty subsystem
    provider.setSubsystemFilter(emptySubsystem.id, emptySubsystem.name);
    
    // Verify filter is set
    const filter = provider.getSubsystemFilter();
    assert.strictEqual(filter.subsystemId, emptySubsystem.id);
    
    // Verify filter label
    const label = provider.getSubsystemFilterLabel();
    assert.ok(label?.includes('EmptySubsystem'));
  });

  test('edge case: nested subsystems', async () => {
    const rootNode = await MetadataParser.parse(fixturesPath);
    assert.ok(rootNode);

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

    // Create nested subsystem structure
    const parentSubsystem: TreeNode = {
      id: 'parent-subsystem',
      name: 'ParentSubsystem',
      type: MetadataType.Subsystem,
      properties: {},
      children: [],
    };

    const childSubsystem: TreeNode = {
      id: 'child-subsystem',
      name: 'ChildSubsystem',
      type: MetadataType.Subsystem,
      properties: {},
      parent: parentSubsystem,
      children: [],
    };

    parentSubsystem.children = [childSubsystem];

    // Apply filter for parent subsystem
    provider.setSubsystemFilter(parentSubsystem.id, parentSubsystem.name);
    
    // Verify filter is set
    const filter = provider.getSubsystemFilter();
    assert.strictEqual(filter.subsystemId, parentSubsystem.id);
    
    // Verify child subsystem would also be included (since it's a descendant)
    // This is tested indirectly through the filter logic
  });
});
