import * as assert from 'assert';
import * as vscode from 'vscode';
import { PropertiesProvider } from '../../src/providers/propertiesProvider';
import { MetadataTreeDataProvider } from '../../src/providers/treeDataProvider';
import { TypeEditorProvider } from '../../src/providers/typeEditorProvider';
import { TreeNode, MetadataType } from '../../src/models/treeNode';

suite('PropertiesProvider Message Protocol Test Suite', () => {
  let provider: PropertiesProvider;
  let treeDataProvider: MetadataTreeDataProvider;
  let typeEditorProvider: TypeEditorProvider;
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
    typeEditorProvider = new TypeEditorProvider(mockContext);
    provider = new PropertiesProvider(mockContext, treeDataProvider, typeEditorProvider);
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

  test('isRootElement should return false for Attribute (nested element)', () => {
    const node: TreeNode = {
      id: 'test',
      name: 'MyAttribute',
      type: MetadataType.Attribute,
      parent: {
        id: 'parent',
        name: 'TestCatalog',
        type: MetadataType.Catalog,
        parent: {
          id: 'grandparent',
          name: 'Configuration',
          type: MetadataType.Configuration,
          properties: {},
        },
        properties: {},
      },
      properties: {},
      filePath: '/test/path.xml',
      parentFilePath: '/test/parent.xml',
    };

    const isRootElement = (provider as any).isRootElement.bind(provider);
    const result = isRootElement(node);

    assert.strictEqual(result, false, 'Attribute should not be a root element');
  });

  test('isRootElement should return true for Catalog (root element)', () => {
    const node: TreeNode = {
      id: 'test',
      name: 'TestCatalog',
      type: MetadataType.Catalog,
      parent: {
        id: 'parent',
        name: 'Configuration',
        type: MetadataType.Configuration,
        properties: {},
      },
      properties: {},
      filePath: '/test/path.xml',
    };

    const isRootElement = (provider as any).isRootElement.bind(provider);
    const result = isRootElement(node);

    assert.strictEqual(result, true, 'Catalog should be a root element');
  });

  test('renderPropertyInput should disable type for root elements', () => {
    const node: TreeNode = {
      id: 'test',
      name: 'TestCatalog',
      type: MetadataType.Catalog,
      parent: {
        id: 'parent',
        name: 'Configuration',
        type: MetadataType.Configuration,
        properties: {},
      },
      properties: {
        type: 'xs:string',
      },
      filePath: '/test/path.xml',
    };

    (provider as any).currentNode = node;

    const renderPropertyInput = (provider as any).renderPropertyInput.bind(provider);
    const html = renderPropertyInput('type', 'xs:string', false);

    assert.ok(html.includes('disabled'), 'Type property should be disabled for root elements');
    assert.ok(!html.includes('Редактировать тип'), 'Edit Type button should not appear for root elements');
  });

  test('renderPropertyInput should enable type for Attribute (nested element)', () => {
    const node: TreeNode = {
      id: 'test',
      name: 'MyAttribute',
      type: MetadataType.Attribute,
      parent: {
        id: 'parent',
        name: 'TestCatalog',
        type: MetadataType.Catalog,
        properties: {},
      },
      properties: {
        type: 'xs:string',
      },
      filePath: '/test/path.xml',
      parentFilePath: '/test/parent.xml',
    };

    (provider as any).currentNode = node;

    const renderPropertyInput = (provider as any).renderPropertyInput.bind(provider);
    const html = renderPropertyInput('type', 'xs:string', false);

    assert.ok(!html.includes('disabled'), 'Type property should be enabled for Attribute');
    assert.ok(html.includes('Редактировать тип'), 'Edit Type button should appear for Attribute');
  });

  // attribute-type-editor bugfix: Type must not display as "[object Object]"
  test('renderPropertyInput Type as object should display formatted string not [object Object]', () => {
    (provider as any).currentNode = { id: 'a', name: 'A', type: MetadataType.Attribute, properties: {}, filePath: '' };
    const renderPropertyInput = (provider as any).renderPropertyInput.bind(provider);
    const typeObject = {
      'v8:Type': 'xs:string',
      'v8:StringQualifiers': { 'v8:Length': 50 },
    };
    const html = renderPropertyInput('Type', typeObject, false);
    assert.ok(html.includes('String(50)'), 'Type object should render as String(50)');
    assert.ok(!html.includes('[object Object]'), 'Must not display [object Object]');
  });

  test('renderPropertyInput Type as string should display as-is', () => {
    (provider as any).currentNode = { id: 'a', name: 'A', type: MetadataType.Attribute, properties: {}, filePath: '' };
    const renderPropertyInput = (provider as any).renderPropertyInput.bind(provider);
    const html = renderPropertyInput('Type', 'CatalogRef.Products', false);
    assert.ok(html.includes('CatalogRef.Products'), 'String Type should be shown as-is');
  });

  test('renderPropertyInput Type null/undefined should display Not set', () => {
    (provider as any).currentNode = { id: 'a', name: 'A', type: MetadataType.Attribute, properties: {}, filePath: '' };
    const renderPropertyInput = (provider as any).renderPropertyInput.bind(provider);
    const htmlNull = renderPropertyInput('Type', null, false);
    const htmlUndef = renderPropertyInput('Type', undefined, false);
    assert.ok(htmlNull.includes('Not set'), 'null Type should show Not set');
    assert.ok(htmlUndef.includes('Not set'), 'undefined Type should show Not set');
  });

  test('renderPropertyInput malformed Type object should display [Invalid Type]', () => {
    (provider as any).currentNode = { id: 'a', name: 'A', type: MetadataType.Attribute, properties: {}, filePath: '' };
    const renderPropertyInput = (provider as any).renderPropertyInput.bind(provider);
    const html = renderPropertyInput('Type', { 'v8:Type': 'cfg:BadRef.Obj' }, false);
    assert.ok(html.includes('[Invalid Type]'), 'Malformed type object should show [Invalid Type]');
  });

  test('renderPropertyInput Type property name should be case-insensitive', () => {
    (provider as any).currentNode = { id: 'a', name: 'A', type: MetadataType.Attribute, properties: {}, filePath: '' };
    const renderPropertyInput = (provider as any).renderPropertyInput.bind(provider);
    const htmlLower = renderPropertyInput('type', 'String(10)', false);
    const htmlUpper = renderPropertyInput('TYPE', 'String(10)', false);
    assert.ok(htmlLower.includes('String(10)'));
    assert.ok(htmlUpper.includes('String(10)'));
  });
});

suite('PropertiesProvider Save Operation Test Suite', () => {
  let provider: PropertiesProvider;
  let treeDataProvider: MetadataTreeDataProvider;
  let typeEditorProvider: TypeEditorProvider;
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
    typeEditorProvider = new TypeEditorProvider(mockContext);
    provider = new PropertiesProvider(mockContext, treeDataProvider, typeEditorProvider);
  });

  teardown(() => {
    provider.dispose();
  });

  test('Save operation should throw error when node has no file path', async () => {
    const node: TreeNode = {
      id: 'test',
      name: 'TestCatalog',
      type: MetadataType.Catalog,
      properties: {
        name: 'TestCatalog',
      },
      // No filePath
    };

    const saveProperties = (provider as any).saveProperties.bind(provider);

    await assert.rejects(
      async () => {
        await saveProperties(node, { name: 'UpdatedCatalog' });
      },
      {
        message: /Cannot save properties: no file path associated with this element/,
      }
    );
  });

  test('Save operation should update node properties after successful save', async () => {
    const path = require('path');
    const fs = require('fs');
    
    // Use a test fixture file
    const fixturesPath = path.join(__dirname, '../../../test/fixtures');
    const testXmlPath = path.join(fixturesPath, 'test-properties.xml');
    const tempXmlPath = path.join(fixturesPath, 'temp-save-test.xml');

    // Copy test file to temp location
    fs.copyFileSync(testXmlPath, tempXmlPath);

    try {
      const node: TreeNode = {
        id: 'test',
        name: 'TestCatalog',
        type: MetadataType.Catalog,
        properties: {
          Name: 'TestCatalog',
          Synonym: 'Test Catalog Synonym',
        },
        filePath: tempXmlPath,
      };

      const newProperties = {
        Name: 'UpdatedCatalog',
        Synonym: 'Updated Synonym',
      };

      const saveProperties = (provider as any).saveProperties.bind(provider);
      await saveProperties(node, newProperties);

      // Verify node properties were updated
      assert.strictEqual(node.properties.Name, 'UpdatedCatalog');
      assert.strictEqual(node.properties.Synonym, 'Updated Synonym');

      // Verify file was actually written
      const { XMLWriter } = await import('../../src/utils/XMLWriter');
      const savedProperties = await XMLWriter.readProperties(tempXmlPath);
      assert.strictEqual(savedProperties.Name, 'UpdatedCatalog');
      assert.strictEqual(savedProperties.Synonym, 'Updated Synonym');
    } finally {
      // Clean up temp file
      if (fs.existsSync(tempXmlPath)) {
        fs.unlinkSync(tempXmlPath);
      }
    }
  });

  test('Save operation should handle file write errors gracefully', async () => {
    const node: TreeNode = {
      id: 'test',
      name: 'TestCatalog',
      type: MetadataType.Catalog,
      properties: {
        Name: 'TestCatalog',
      },
      filePath: '/non/existent/path/file.xml',
    };

    const saveProperties = (provider as any).saveProperties.bind(provider);

    await assert.rejects(
      async () => {
        await saveProperties(node, { Name: 'UpdatedCatalog' });
      },
      {
        message: /Failed to write properties/,
      }
    );
  });
});
