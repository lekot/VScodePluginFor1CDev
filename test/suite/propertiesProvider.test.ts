import * as assert from 'assert';
import * as vscode from 'vscode';
import { PropertiesProvider } from '../../src/providers/propertiesProvider';
import { MetadataTreeDataProvider } from '../../src/providers/treeDataProvider';
import { TreeNode, MetadataType } from '../../src/models/treeNode';

suite('PropertiesProvider Message Protocol Test Suite', () => {
  let provider: PropertiesProvider;
  let treeDataProvider: MetadataTreeDataProvider;
  let mockContext: vscode.ExtensionContext;

  setup(() => {
    // Create mock context
    mockContext = {
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

    treeDataProvider = new MetadataTreeDataProvider(mockContext);
    provider = new PropertiesProvider(mockContext, treeDataProvider);
  });

  teardown(() => {
    provider.dispose();
  });

  test('Provider should be initialized', () => {
    assert.ok(provider);
  });

  test('Validation should pass for valid properties', () => {
    const node: TreeNode = {
      id: 'test',
      name: 'TestCatalog',
      type: MetadataType.Catalog,
      properties: {
        name: 'TestCatalog',
        maxLength: 100,
        autoNumbering: true,
      },
      filePath: '/test/path.xml',
    };

    // Access private method through any cast for testing
    const validateProperties = (provider as any).validateProperties.bind(provider);
    
    // Set current node
    (provider as any).currentNode = node;

    const result = validateProperties({
      name: 'TestCatalog',
      maxLength: 100,
      autoNumbering: true,
    });

    assert.strictEqual(result.valid, true);
    assert.strictEqual(Object.keys(result.errors).length, 0);
  });

  test('Validation should fail for invalid number type', () => {
    const node: TreeNode = {
      id: 'test',
      name: 'TestCatalog',
      type: MetadataType.Catalog,
      properties: {
        name: 'TestCatalog',
        maxLength: 100,
      },
      filePath: '/test/path.xml',
    };

    const validateProperties = (provider as any).validateProperties.bind(provider);
    (provider as any).currentNode = node;

    const result = validateProperties({
      name: 'TestCatalog',
      maxLength: 'not a number',
    });

    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.maxLength);
    assert.strictEqual(result.errors.maxLength, 'Must be a number');
  });

  test('Validation should fail for empty required field', () => {
    const node: TreeNode = {
      id: 'test',
      name: 'TestCatalog',
      type: MetadataType.Catalog,
      properties: {
        name: 'TestCatalog',
        synonym: 'Test',
      },
      filePath: '/test/path.xml',
    };

    const validateProperties = (provider as any).validateProperties.bind(provider);
    (provider as any).currentNode = node;

    const result = validateProperties({
      name: '',
      synonym: 'Test',
    });

    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.name);
    assert.strictEqual(result.errors.name, 'This field is required');
  });

  test('Validation should fail for string exceeding max length', () => {
    const node: TreeNode = {
      id: 'test',
      name: 'TestCatalog',
      type: MetadataType.Catalog,
      properties: {
        name: 'TestCatalog',
        description: 'Short description',
      },
      filePath: '/test/path.xml',
    };

    const validateProperties = (provider as any).validateProperties.bind(provider);
    (provider as any).currentNode = node;

    const longString = 'a'.repeat(1001);
    const result = validateProperties({
      name: 'TestCatalog',
      description: longString,
    });

    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.description);
    assert.strictEqual(result.errors.description, 'Value is too long (max 1000 characters)');
  });

  test('Validation should fail for invalid boolean type', () => {
    const node: TreeNode = {
      id: 'test',
      name: 'TestCatalog',
      type: MetadataType.Catalog,
      properties: {
        name: 'TestCatalog',
        autoNumbering: true,
      },
      filePath: '/test/path.xml',
    };

    const validateProperties = (provider as any).validateProperties.bind(provider);
    (provider as any).currentNode = node;

    const result = validateProperties({
      name: 'TestCatalog',
      autoNumbering: 'yes',
    });

    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.autoNumbering);
    assert.strictEqual(result.errors.autoNumbering, 'Must be a boolean');
  });

  test('Property type detection should work correctly', () => {
    const detectPropertyType = (provider as any).detectPropertyType.bind(provider);

    assert.strictEqual(detectPropertyType('test'), 'string');
    assert.strictEqual(detectPropertyType(123), 'number');
    assert.strictEqual(detectPropertyType(true), 'boolean');
    assert.strictEqual(detectPropertyType(null), 'unknown');
    assert.strictEqual(detectPropertyType(undefined), 'unknown');
  });

  test('HTML escaping should prevent XSS', () => {
    const escapeHtml = (provider as any).escapeHtml.bind(provider);

    assert.strictEqual(escapeHtml('<script>alert("xss")</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    assert.strictEqual(escapeHtml('Test & Co'), 'Test &amp; Co');
    assert.strictEqual(escapeHtml("It's a test"), 'It&#039;s a test');
  });
});
