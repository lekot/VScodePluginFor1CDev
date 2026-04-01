import * as assert from 'assert';
import * as vscode from 'vscode';
import { MetadataTreeDataProvider } from '../../src/providers/treeDataProvider';
import { MetadataType, TreeNode } from '../../src/models/treeNode';
import { extractChildSubsystems, findChildObjects } from '../../src/parsers/xmlChildObjects';
import { buildSubsystemTree } from '../../src/parsers/subsystemTreeBuilder';

suite('Subsystems (hierarchy + filter) Tests', () => {
  test('extractChildSubsystems returns names from ChildObjects.Subsystem', () => {
    const xml: Record<string, unknown> = {
      MetaDataObject: {
        Subsystem: {
          ChildObjects: {
            Subsystem: ['A', { '#text': 'B' }],
          },
        },
      },
    };

    const childObjects = findChildObjects(xml as any);
    const names = extractChildSubsystems(childObjects);
    assert.deepStrictEqual(names, ['A', 'B']);
  });

  test('buildSubsystemTree supports child subsystem with same name as parent', () => {
    const rootParent: TreeNode = {
      id: 'Subsystems',
      name: 'Subsystems',
      type: MetadataType.Subsystem,
      properties: {},
      children: [],
    };
    const parent: TreeNode = {
      id: 'p',
      name: 'X',
      type: MetadataType.Subsystem,
      properties: {},
      children: [],
    };
    const child: TreeNode = {
      id: 'c',
      name: 'X',
      type: MetadataType.Subsystem,
      properties: { parentSubsystemRef: 'X' },
      children: [],
    };

    buildSubsystemTree([parent, child], rootParent);
    assert.strictEqual(parent.id, 'Subsystems.X');
    assert.strictEqual(child.id, 'Subsystems.X.X');
    assert.strictEqual(rootParent.children?.[0], parent);
    assert.strictEqual(parent.children?.[0], child);
  });

  test('subsystem filter includes Content of descendant subsystems', async () => {
    const mockContext: vscode.ExtensionContext = {
      subscriptions: [],
      extensionPath: '',
      extensionUri: vscode.Uri.file(''),
      globalState: {} as any,
      workspaceState: {} as any,
      secrets: {} as any,
      storageUri: undefined,
      storagePath: undefined,
      globalStorageUri: vscode.Uri.file(''),
      globalStoragePath: '',
      logUri: vscode.Uri.file(''),
      logPath: '',
      extensionMode: vscode.ExtensionMode.Test,
      extension: {} as any,
      environmentVariableCollection: {} as any,
      languageModelAccessInformation: {} as any,
      asAbsolutePath: (relativePath: string) => relativePath,
    };

    const provider = new MetadataTreeDataProvider();

    const parentSubsystem: TreeNode = {
      id: 'sub-parent',
      name: 'Parent',
      type: MetadataType.Subsystem,
      properties: {},
      children: [],
    };

    const childSubsystem: TreeNode = {
      id: 'sub-child',
      name: 'Child',
      type: MetadataType.Subsystem,
      properties: {
        Content: {
          'xr:Item': [{ '#text': 'Catalog.MyCatalog' }],
        },
      },
      children: [],
    };

    const catalog: TreeNode = {
      id: 'cat-1',
      name: 'MyCatalog',
      type: MetadataType.Catalog,
      properties: {},
    };

    const root: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      children: [parentSubsystem, catalog],
    };

    parentSubsystem.parent = root;
    catalog.parent = root;
    parentSubsystem.children = [childSubsystem];
    childSubsystem.parent = parentSubsystem;

    provider.setRootNode(root);
    await provider.setSubsystemFilter(parentSubsystem.id, parentSubsystem.name);

    // Root-level nodes should include the selected subsystem node and any referenced objects.
    const top = await provider.getChildren();
    const rootChildren = top[0]?.children ?? [];
    const ids = new Set([...top.map((n) => n.id), ...rootChildren.map((n) => n.id)]);
    assert.ok(ids.has(parentSubsystem.id), 'selected subsystem should be visible');
    assert.ok(ids.has(catalog.id), 'catalog from descendant Content should be visible');
  });
});

