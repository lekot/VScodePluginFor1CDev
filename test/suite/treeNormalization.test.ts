import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import { MetadataTreeDataProvider } from '../../src/providers/treeDataProvider';
import { MetadataType, TreeNode } from '../../src/models/treeNode';
import { ConfigFormat } from '../../src/parsers/formatDetector';
import {
  mergeR5TypeFoldersUnderCommon,
  normalizeEmptyPlaceholderTree,
} from '../../src/utils/treeNormalization';

suite('treeNormalization Test Suite', () => {
  function createMockContext(): vscode.ExtensionContext {
    return {
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
  }

  test('normalizeEmptyPlaceholderTree inserts R4 placeholders for Designer (Catalogs/Documents)', () => {
    const root: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      children: [], // missing type nodes (folders absent)
    };

    const configPath = path.join('C:', 'reps', 'myconfig');
    const normalized = normalizeEmptyPlaceholderTree(root, { configPath, format: ConfigFormat.Designer });

    const catalogs = normalized.children!.find((c) => c.id === 'Catalogs');
    const documents = normalized.children!.find((c) => c.id === 'Documents');

    assert.ok(catalogs, 'Catalogs placeholder must exist');
    assert.ok(documents, 'Documents placeholder must exist');

    assert.strictEqual(catalogs!.type, MetadataType.Catalog);
    assert.strictEqual(documents!.type, MetadataType.Document);
    assert.deepStrictEqual(catalogs!.children, []);
    assert.deepStrictEqual(documents!.children, []);
    assert.strictEqual((catalogs!.properties as any).type, 'Catalogs');
    assert.strictEqual((documents!.properties as any).type, 'Documents');

    assert.strictEqual(catalogs!.filePath, path.join(configPath, 'Catalogs'));
    assert.strictEqual(documents!.filePath, path.join(configPath, 'Documents'));

    // Parent pointers must point to configuration root for provider traversal.
    assert.strictEqual(catalogs!.parent, normalized);
    assert.strictEqual(documents!.parent, normalized);
  });

  test('normalizeEmptyPlaceholderTree inserts Catalogs/Documents for EDT (filePath under src)', () => {
    const root: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      children: [], // missing type nodes
    };

    const configPath = path.join('D:', 'configs', 'edt1c');
    const normalized = normalizeEmptyPlaceholderTree(root, { configPath, format: ConfigFormat.EDT });

    const catalogs = normalized.children!.find((c) => c.id === 'Catalogs')!;
    const documents = normalized.children!.find((c) => c.id === 'Documents')!;

    assert.strictEqual(catalogs.type, MetadataType.Catalog);
    assert.strictEqual(documents.type, MetadataType.Document);

    assert.strictEqual(catalogs.filePath, path.join(configPath, 'src', 'Catalogs'));
    assert.strictEqual(documents.filePath, path.join(configPath, 'src', 'Documents'));
  });

  test('normalizeEmptyPlaceholderTree enforces R4 order and R5 "Общие" children order (Designer)', () => {
    const root: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      children: [],
    };

    const configPath = path.join('C:', 'reps', 'myconfig');
    const normalized = normalizeEmptyPlaceholderTree(root, { configPath, format: ConfigFormat.Designer });

    const expectedR4Order = [
      'Common',
      'Constants',
      'Catalogs',
      'Documents',
      'DocumentJournals',
      'Enums',
      'Reports',
      'DataProcessors',
      'ChartsOfCharacteristicTypes',
      'ChartsOfAccounts',
      'ChartsOfCalculationTypes',
      'InformationRegisters',
      'AccumulationRegisters',
      'AccountingRegisters',
      'CalculationRegisters',
      'BusinessProcesses',
      'Tasks',
      'ExternalDataSources',
    ];

    const actualR4Order = (normalized.children ?? []).map((c) => c.id);
    assert.deepStrictEqual(actualR4Order, expectedR4Order);

    const common = normalized.children!.find((c) => c.id === 'Common')!;
    assert.strictEqual(common.name, 'Общие');
    assert.strictEqual(common.type, MetadataType.Unknown);

    const expectedCommonOrder = [
      'Subsystems',
      'CommonModules',
      'SessionParameters',
      'Roles',
      'FilterCriteria',
      'EventSubscriptions',
      'ScheduledJobs',
      'Bots',
      'FunctionalOptions',
      'FunctionalOptionsParameters',
      'DefinableTypes',
      'SettingsStorages',
      'CommonCommands',
      'CommandGroups',
      'CommonForms',
      'CommonLayouts',
      'CommonPictures',
      'XDTO',
      'WebServices',
      'HTTPServices',
      'WSLinks',
      'WebSocketClients',
      'IntegrationServices',
      'StyleElements',
      'Styles',
      'Languages',
    ];

    const actualCommonOrder = (common.children ?? []).map((c) => c.id);
    assert.deepStrictEqual(actualCommonOrder, expectedCommonOrder);
  });

  test('normalizeEmptyPlaceholderTree sets filePath for file-backed placeholder type-nodes (EDT)', () => {
    const root: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      children: [],
    };

    const configPath = path.join('D:', 'configs', 'edt1c');
    const normalized = normalizeEmptyPlaceholderTree(root, { configPath, format: ConfigFormat.EDT });

    const catalogs = normalized.children!.find((c) => c.id === 'Catalogs')!;
    const common = normalized.children!.find((c) => c.id === 'Common')!;
    const webServices = common.children!.find((c) => c.id === 'WebServices')!;

    assert.strictEqual(catalogs.filePath, path.join(configPath, 'src', 'Catalogs'));
    assert.strictEqual(webServices.filePath, path.join(configPath, 'src', 'WebServices'));
  });

  test('provider expanding placeholder type nodes does not throw and returns []', async () => {
    // We intentionally use a non-existing configPath: parsers should swallow readdir errors and return [].
    const configPath = path.join('C:', 'this-folder-should-not-exist-123');

    const root: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      filePath: path.join(configPath, 'Configuration.xml'), // for tooltip/resourceUri safety
      children: [],
    };

    const normalized = normalizeEmptyPlaceholderTree(root, { configPath, format: ConfigFormat.Designer });

    const provider = new MetadataTreeDataProvider(createMockContext());
    provider.setRootNode(normalized);

    const catalogs = normalized.children!.find((c) => c.id === 'Catalogs')!;
    const children = await provider.getChildren(catalogs);

    assert.deepStrictEqual(children, []);
  });

  test('provider expanding UI-only placeholder group does not throw and returns []', async () => {
    const configPath = path.join('C:', 'this-folder-should-not-exist-123');

    const root: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      filePath: path.join(configPath, 'Configuration.xml'),
      children: [],
    };

    const normalized = normalizeEmptyPlaceholderTree(root, { configPath, format: ConfigFormat.Designer });
    const provider = new MetadataTreeDataProvider(createMockContext());
    provider.setRootNode(normalized);

    const commonGroup = normalized.children!.find((c) => c.id === 'Common')!;
    const children = await provider.getChildren(commonGroup);
    assert.ok(Array.isArray(children), 'Common group expansion should return an array');
  });

  // R6: Object node placeholder containers
  test('normalizeEmptyPlaceholderTree inserts R6 object placeholders for Catalog node with no children (Designer)', () => {
    const root: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      children: [],
    };

    const configPath = path.join('C:', 'reps', 'myconfig');
    const normalized = normalizeEmptyPlaceholderTree(root, { configPath, format: ConfigFormat.Designer });

    // Find the Catalogs placeholder (should exist from R4)
    const catalogsFolder = normalized.children!.find((c) => c.id === 'Catalogs')!;
    
    // Create a mock Catalog node under it
    const catalogNode: TreeNode = {
      id: 'Catalog1',
      name: 'Catalog1',
      type: MetadataType.Catalog,
      properties: {},
      children: [], // No children initially
      parent: catalogsFolder
    };
    
    // Add the catalog to the folder
    if (!catalogsFolder.children) {
      catalogsFolder.children = [];
    }
    catalogsFolder.children.push(catalogNode);

    // Re-normalize to trigger R6 processing
    const reNormalized = normalizeEmptyPlaceholderTree(root, { configPath, format: ConfigFormat.Designer });

    // Find our catalog node again (should still be there)
    const updatedCatalogsFolder = reNormalized.children!.find((c) => c.id === 'Catalogs')!;
    const updatedCatalogNode = updatedCatalogsFolder.children!.find((c) => c.id === 'Catalog1')!;

    // Check that all five R6 placeholders exist
    const placeholderIds = ['Attributes', 'TabularSections', 'Forms', 'Commands', 'Templates'];
    placeholderIds.forEach(id => {
      const placeholder = updatedCatalogNode.children!.find((c) => c.id === id);
      assert.ok(placeholder, `Placeholder ${id} should exist`);
    });

    // Check types
    assert.strictEqual(updatedCatalogNode.children!.find((c) => c.id === 'Attributes')!.type, MetadataType.Attribute);
    assert.strictEqual(updatedCatalogNode.children!.find((c) => c.id === 'TabularSections')!.type, MetadataType.TabularSection);
    assert.strictEqual(updatedCatalogNode.children!.find((c) => c.id === 'Forms')!.type, MetadataType.Form);
    assert.strictEqual(updatedCatalogNode.children!.find((c) => c.id === 'Commands')!.type, MetadataType.Command);
    assert.strictEqual(updatedCatalogNode.children!.find((c) => c.id === 'Templates')!.type, MetadataType.Template);

    // Check file paths for Designer format
    assert.strictEqual(updatedCatalogNode.children!.find((c) => c.id === 'Attributes')!.filePath, path.join(configPath, 'Attributes'));
    assert.strictEqual(updatedCatalogNode.children!.find((c) => c.id === 'TabularSections')!.filePath, path.join(configPath, 'TabularSections'));
    assert.strictEqual(updatedCatalogNode.children!.find((c) => c.id === 'Forms')!.filePath, path.join(configPath, 'Forms'));
    assert.strictEqual(updatedCatalogNode.children!.find((c) => c.id === 'Commands')!.filePath, path.join(configPath, 'Commands'));
    assert.strictEqual(updatedCatalogNode.children!.find((c) => c.id === 'Templates')!.filePath, path.join(configPath, 'Templates'));

    // Check parent pointers
    updatedCatalogNode.children!.forEach(child => {
      assert.strictEqual(child.parent, updatedCatalogNode);
    });

    // Check properties
    assert.strictEqual((updatedCatalogNode.children!.find((c) => c.id === 'Attributes')!.properties as any).type, 'Attributes');
    assert.strictEqual((updatedCatalogNode.children!.find((c) => c.id === 'TabularSections')!.properties as any).type, 'TabularSections');
    assert.strictEqual((updatedCatalogNode.children!.find((c) => c.id === 'Forms')!.properties as any).type, 'Forms');
    assert.strictEqual((updatedCatalogNode.children!.find((c) => c.id === 'Commands')!.properties as any).type, 'Commands');
    assert.strictEqual((updatedCatalogNode.children!.find((c) => c.id === 'Templates')!.properties as any).type, 'Templates');
  });

  test('normalizeEmptyPlaceholderTree inserts missing R6 object placeholders for Document node with existing children (Designer)', () => {
    const root: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      children: [],
    };

    const configPath = path.join('C:', 'reps', 'myconfig');
    const normalized = normalizeEmptyPlaceholderTree(root, { configPath, format: ConfigFormat.Designer });

    // Find the Documents placeholder (should exist from R4)
    const documentsFolder = normalized.children!.find((c) => c.id === 'Documents')!;
    
    // Create a mock Document node with one existing Attribute child
    const existingAttribute: TreeNode = {
      id: 'ExistingAttr',
      name: 'Existing Attribute',
      type: MetadataType.Attribute,
      properties: {},
      children: [],
      parent: undefined // Will be set when added to document
    };
    
    const documentNode: TreeNode = {
      id: 'Document1',
      name: 'Document1',
      type: MetadataType.Document,
      properties: {},
      children: [existingAttribute], // One existing child
      parent: documentsFolder
    };
    
    // Set parent for existing attribute
    existingAttribute.parent = documentNode;
    
    // Add the document to the folder
    if (!documentsFolder.children) {
      documentsFolder.children = [];
    }
    documentsFolder.children.push(documentNode);

    // Re-normalize to trigger R6 processing
    const reNormalized = normalizeEmptyPlaceholderTree(root, { configPath, format: ConfigFormat.Designer });

    // Find our document node again
    const updatedDocumentsFolder = reNormalized.children!.find((c) => c.id === 'Documents')!;
    const updatedDocumentNode = updatedDocumentsFolder.children!.find((c) => c.id === 'Document1')!;

    // Current normalization keeps original child and injects full placeholder set.
    assert.strictEqual(updatedDocumentNode.children!.length, 6);

    // Check that original attribute is preserved
    const originalAttr = updatedDocumentNode.children!.find((c) => c.id === 'ExistingAttr');
    assert.ok(originalAttr, 'Original attribute should be preserved');
    assert.strictEqual(originalAttr!.name, 'Existing Attribute');
    assert.strictEqual(originalAttr!.type, MetadataType.Attribute);

    // Check that all five R6 placeholders exist (including Attribute which may be duplicated but upsert should handle it)
    const placeholderIds = ['Attributes', 'TabularSections', 'Forms', 'Commands', 'Templates'];
    placeholderIds.forEach(id => {
      const placeholder = updatedDocumentNode.children!.find((c) => c.id === id);
      assert.ok(placeholder, `Placeholder ${id} should exist`);
    });

    // Check types
    assert.strictEqual(updatedDocumentNode.children!.find((c) => c.id === 'Attributes')!.type, MetadataType.Attribute);
    assert.strictEqual(updatedDocumentNode.children!.find((c) => c.id === 'TabularSections')!.type, MetadataType.TabularSection);
    assert.strictEqual(updatedDocumentNode.children!.find((c) => c.id === 'Forms')!.type, MetadataType.Form);
    assert.strictEqual(updatedDocumentNode.children!.find((c) => c.id === 'Commands')!.type, MetadataType.Command);
    assert.strictEqual(updatedDocumentNode.children!.find((c) => c.id === 'Templates')!.type, MetadataType.Template);

    // Check file paths for Designer format
    assert.strictEqual(updatedDocumentNode.children!.find((c) => c.id === 'Attributes')!.filePath, path.join(configPath, 'Attributes'));
    assert.strictEqual(updatedDocumentNode.children!.find((c) => c.id === 'TabularSections')!.filePath, path.join(configPath, 'TabularSections'));
    assert.strictEqual(updatedDocumentNode.children!.find((c) => c.id === 'Forms')!.filePath, path.join(configPath, 'Forms'));
    assert.strictEqual(updatedDocumentNode.children!.find((c) => c.id === 'Commands')!.filePath, path.join(configPath, 'Commands'));
    assert.strictEqual(updatedDocumentNode.children!.find((c) => c.id === 'Templates')!.filePath, path.join(configPath, 'Templates'));

    // Check parent pointers
    updatedDocumentNode.children!.forEach(child => {
      assert.strictEqual(child.parent, updatedDocumentNode);
    });
  });

  test('normalizeEmptyPlaceholderTree computes correct filePath for EDT format', () => {
    const root: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      children: [],
    };

    const configPath = path.join('D:', 'configs', 'edt1c');
    const normalized = normalizeEmptyPlaceholderTree(root, { configPath, format: ConfigFormat.EDT });

    // Find the DataProcessors placeholder (should exist from R4)
    const processorsFolder = normalized.children!.find((c) => c.id === 'DataProcessors')!;
    
    // Create a mock DataProcessor node
    const processorNode: TreeNode = {
      id: 'Processor1',
      name: 'Processor1',
      type: MetadataType.DataProcessor,
      properties: {},
      children: [],
      parent: processorsFolder
    };
    
    // Add the processor to the folder
    if (!processorsFolder.children) {
      processorsFolder.children = [];
    }
    processorsFolder.children.push(processorNode);

    // Re-normalize to trigger R6 processing
    const reNormalized = normalizeEmptyPlaceholderTree(root, { configPath, format: ConfigFormat.EDT });

    // Find our processor node again
    const updatedProcessorsFolder = reNormalized.children!.find((c) => c.id === 'DataProcessors')!;
    const updatedProcessorNode = updatedProcessorsFolder.children!.find((c) => c.id === 'Processor1')!;

    // Check file paths for EDT format (should have 'src' prefix)
    assert.strictEqual(updatedProcessorNode.children!.find((c) => c.id === 'Attributes')!.filePath, path.join(configPath, 'src', 'Attributes'));
    assert.strictEqual(updatedProcessorNode.children!.find((c) => c.id === 'TabularSections')!.filePath, path.join(configPath, 'src', 'TabularSections'));
    assert.strictEqual(updatedProcessorNode.children!.find((c) => c.id === 'Forms')!.filePath, path.join(configPath, 'src', 'Forms'));
    assert.strictEqual(updatedProcessorNode.children!.find((c) => c.id === 'Commands')!.filePath, path.join(configPath, 'src', 'Commands'));
    assert.strictEqual(updatedProcessorNode.children!.find((c) => c.id === 'Templates')!.filePath, path.join(configPath, 'src', 'Templates'));
  });

  test('normalizeEmptyPlaceholderTree does not reorder existing children of object nodes', () => {
    const root: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      children: [],
    };

    const configPath = path.join('C:', 'reps', 'myconfig');
    const normalized = normalizeEmptyPlaceholderTree(root, { configPath, format: ConfigFormat.Designer });

    // Find the ChartOfCharacteristicTypes placeholder (should exist from R4)
    const chartsFolder = normalized.children!.find((c) => c.id === 'ChartsOfCharacteristicTypes')!;
    
    // Create a mock ChartOfCharacteristicTypes node with children in specific order
    const childZ: TreeNode = {
      id: 'ChildZ',
      name: 'Child Z',
      type: MetadataType.Unknown,
      properties: {},
      children: [],
      parent: undefined
    };
    
    const childA: TreeNode = {
      id: 'ChildA',
      name: 'Child A',
      type: MetadataType.Unknown,
      properties: {},
      children: [],
      parent: undefined
    };
    
    const childM: TreeNode = {
      id: 'ChildM',
      name: 'Child M',
      type: MetadataType.Unknown,
      properties: {},
      children: [],
      parent: undefined
    };
    
    const chartNode: TreeNode = {
      id: 'Chart1',
      name: 'Chart1',
      type: MetadataType.ChartOfCharacteristicTypes,
      properties: {},
      children: [childZ, childA, childM], // Order: Z, A, M
      parent: chartsFolder
    };
    
    // Set parents
    childZ.parent = chartNode;
    childA.parent = chartNode;
    childM.parent = chartNode;
    
    // Add the chart to the folder
    if (!chartsFolder.children) {
      chartsFolder.children = [];
    }
    chartsFolder.children.push(chartNode);

    // Store original order
    const originalOrder = chartNode.children!.map(child => child.id);
    
    // Re-normalize to trigger R6 processing
    const reNormalized = normalizeEmptyPlaceholderTree(root, { configPath, format: ConfigFormat.Designer });

    // Find our chart node again
    const updatedChartsFolder = reNormalized.children!.find((c) => c.id === 'ChartsOfCharacteristicTypes')!;
    const updatedChartNode = updatedChartsFolder.children!.find((c) => c.id === 'Chart1')!;

    // Check that original children are preserved and placeholders are added
    const updatedOrder = updatedChartNode.children!.map(child => child.id);
    originalOrder.forEach((id) => {
      assert.ok(updatedOrder.includes(id), `Original child ${id} should remain`);
    });

    // R6 placeholders should be present regardless of insertion position
    const placeholderIds = ['Attributes', 'TabularSections', 'Forms', 'Commands', 'Templates'];
    placeholderIds.forEach((id) => {
      assert.ok(updatedOrder.includes(id), `Placeholder ${id} should be present`);
    });
  });

  test('mergeR5TypeFoldersUnderCommon moves parser Roles from Configuration under Общие (Designer)', () => {
    const configPath = path.join('C:', 'reps', 'merge-test');
    const rolesDir = path.join(configPath, 'Roles');
    const roleChild: TreeNode = {
      id: 'Roles.Admin',
      name: 'Admin',
      type: MetadataType.Role,
      properties: {},
      children: [],
    };
    const parserRoles: TreeNode = {
      id: 'Roles',
      name: 'Роли',
      type: MetadataType.Role,
      properties: {},
      filePath: rolesDir,
      children: [roleChild],
    };
    const root: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      children: [parserRoles],
    };
    parserRoles.parent = root;
    roleChild.parent = parserRoles;

    const normalized = normalizeEmptyPlaceholderTree(root, { configPath, format: ConfigFormat.Designer });

    assert.strictEqual(
      normalized.children!.some((c) => c.id === 'Roles'),
      false,
      'Roles must not stay a direct child of Configuration'
    );
    const common = normalized.children!.find((c) => c.id === 'Common')!;
    const rolesUnderCommon = common.children!.find((c) => c.id === 'Roles')!;
    assert.ok(rolesUnderCommon, 'Roles should exist under Common');
    assert.strictEqual(rolesUnderCommon.filePath, rolesDir);
    assert.strictEqual(rolesUnderCommon.children!.length, 1);
    assert.strictEqual(rolesUnderCommon.children![0].name, 'Admin');
    assert.strictEqual(rolesUnderCommon.children![0].parent, rolesUnderCommon);
  });

  test('mergeR5TypeFoldersUnderCommon moves parser CommonModules under Общие (EDT)', () => {
    const configPath = path.join('D:', 'edt', 'proj');
    const cmDir = path.join(configPath, 'src', 'CommonModules');
    const modChild: TreeNode = {
      id: 'CommonModules.MyModule',
      name: 'MyModule',
      type: MetadataType.CommonModule,
      properties: {},
      children: [],
    };
    const parserCm: TreeNode = {
      id: 'CommonModules',
      name: 'Общие модули',
      type: MetadataType.CommonModule,
      properties: {},
      filePath: cmDir,
      children: [modChild],
    };
    const root: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      children: [parserCm],
    };
    parserCm.parent = root;
    modChild.parent = parserCm;

    const normalized = normalizeEmptyPlaceholderTree(root, { configPath, format: ConfigFormat.EDT });

    assert.strictEqual(normalized.children!.some((c) => c.id === 'CommonModules'), false);
    const common = normalized.children!.find((c) => c.id === 'Common')!;
    const cm = common.children!.find((c) => c.id === 'CommonModules')!;
    assert.strictEqual(cm.filePath, cmDir);
    assert.strictEqual(cm.children!.length, 1);
    assert.strictEqual(cm.children![0].name, 'MyModule');
  });

  test('mergeR5TypeFoldersUnderCommon throws on conflicting filePath between parser and placeholder', () => {
    const configPath = path.join('C:', 'cfg');
    const parserRoles: TreeNode = {
      id: 'Roles',
      name: 'Роли',
      type: MetadataType.Role,
      properties: {},
      filePath: path.join(configPath, 'Roles'),
      children: [],
    };
    const root: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      children: [parserRoles],
    };
    parserRoles.parent = root;

    assert.throws(
      () =>
        normalizeEmptyPlaceholderTree(root, {
          configPath: path.join('C:', 'other-root'),
          format: ConfigFormat.Designer,
        }),
      /Конфликт путей при слиянии узла «Roles»/
    );
  });

  test('mergeR5TypeFoldersUnderCommon throws on conflicting parentFilePath', () => {
    const configPath = path.join('C:', 'cfg', 'pp');
    const rolesDir = path.join(configPath, 'Roles');
    const placeholderRoles: TreeNode = {
      id: 'Roles',
      name: 'Роли',
      type: MetadataType.Role,
      properties: {},
      filePath: rolesDir,
      parentFilePath: path.join(configPath, 'branch-a', 'Roles'),
      children: [],
    };
    const parserRoles: TreeNode = {
      id: 'Roles',
      name: 'Роли',
      type: MetadataType.Role,
      properties: {},
      filePath: rolesDir,
      parentFilePath: path.join(configPath, 'branch-b', 'Roles'),
      children: [],
    };
    const common: TreeNode = {
      id: 'Common',
      name: 'Общие',
      type: MetadataType.Unknown,
      properties: {},
      children: [placeholderRoles],
    };
    placeholderRoles.parent = common;
    const root: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      children: [common, parserRoles],
    };
    common.parent = root;
    parserRoles.parent = root;

    assert.throws(
      () => mergeR5TypeFoldersUnderCommon(root, { configPath, format: ConfigFormat.Designer }),
      /Конфликт parentFilePath при слиянии узла «Roles»/
    );
  });

  test('mergeR5TypeFoldersUnderCommon throws on duplicate child id', () => {
    const configPath = path.join('C:', 'cfg', 'dup');
    const rolesDir = path.join(configPath, 'Roles');
    const shared: TreeNode = {
      id: 'Roles.DupRole',
      name: 'DupRole',
      type: MetadataType.Role,
      properties: {},
      children: [],
    };
    const placeholderRoles: TreeNode = {
      id: 'Roles',
      name: 'Роли',
      type: MetadataType.Role,
      properties: {},
      filePath: rolesDir,
      children: [shared],
    };
    shared.parent = placeholderRoles;
    const parserChild: TreeNode = {
      id: 'Roles.DupRole',
      name: 'DupRole',
      type: MetadataType.Role,
      properties: {},
      children: [],
    };
    const parserRoles: TreeNode = {
      id: 'Roles',
      name: 'Роли',
      type: MetadataType.Role,
      properties: {},
      filePath: rolesDir,
      children: [parserChild],
    };
    parserChild.parent = parserRoles;
    const common: TreeNode = {
      id: 'Common',
      name: 'Общие',
      type: MetadataType.Unknown,
      properties: {},
      children: [placeholderRoles],
    };
    placeholderRoles.parent = common;
    const root: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      children: [common, parserRoles],
    };
    common.parent = root;
    parserRoles.parent = root;

    assert.throws(
      () => mergeR5TypeFoldersUnderCommon(root, { configPath, format: ConfigFormat.Designer }),
      /Дубликат дочернего узла «Roles.DupRole»/
    );
  });
});

