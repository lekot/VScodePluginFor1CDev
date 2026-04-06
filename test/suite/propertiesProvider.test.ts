import * as path from 'path';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { PropertiesProvider } from '../../src/providers/propertiesProvider';
import { MetadataTreeDataProvider } from '../../src/providers/treeDataProvider';
import { TypeEditorProvider } from '../../src/providers/typeEditorProvider';
import { TreeNode, MetadataType } from '../../src/models/treeNode';
import { validateProperties } from '../../src/providers/propertiesValidation';
import {
  detectPropertyType,
  escapeHtml,
  isRootElement,
  renderPropertyInput,
} from '../../src/providers/propertiesWebviewContent';
import {
  isMatchingCurrentFormSelection,
  saveProperties,
  type MessageHandlerContext,
} from '../../src/providers/propertiesMessageHandler';

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
      asAbsolutePath: (relativePath: string) => relativePath,
    };

    treeDataProvider = new MetadataTreeDataProvider();
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

    const result = validateProperties({
      name: 'TestCatalog',
      maxLength: 100,
      autoNumbering: true,
    }, node);

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

    const result = validateProperties({
      name: 'TestCatalog',
      maxLength: 'not a number',
    }, node);

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

    const result = validateProperties({
      name: '',
      synonym: 'Test',
    }, node);

    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.name);
    assert.strictEqual(result.errors.name, 'This field is required');
  });

  test('Validation allows long strings in free-text fields', () => {
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

    const longString = 'a'.repeat(1001);
    const result = validateProperties({
      name: 'TestCatalog',
      description: longString,
    }, node);

    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.errors.description, undefined);
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

    const result = validateProperties({
      name: 'TestCatalog',
      autoNumbering: 'yes',
    }, node);

    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.autoNumbering);
    assert.strictEqual(result.errors.autoNumbering, 'Must be a boolean');
  });

  test('Property type detection should work correctly', () => {
    assert.strictEqual(detectPropertyType('test'), 'string');
    assert.strictEqual(detectPropertyType(123), 'number');
    assert.strictEqual(detectPropertyType(true), 'boolean');
    assert.strictEqual(detectPropertyType(null), 'unknown');
    assert.strictEqual(detectPropertyType(undefined), 'unknown');
  });

  test('HTML escaping should prevent XSS', () => {
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

    const html = renderPropertyInput('type', 'xs:string', false, node);

    assert.ok(html.includes('disabled'), 'Type property should be disabled for root elements');
    assert.ok(!html.includes('edit-type-btn'), 'Edit Type button should not appear for root elements');
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

    const html = renderPropertyInput('type', 'xs:string', false, node);

    assert.ok(!html.includes('disabled'), 'Type property should be enabled for Attribute');
    assert.ok(html.includes('edit-type-btn') && html.includes('aria-label="Редактировать тип"'), 'Edit Type button (pencil icon) should appear for Attribute');
  });

  // attribute-type-editor bugfix: Type must not display as "[object Object]"
  test('renderPropertyInput Type as object should display formatted string not [object Object]', () => {
    const attrNode: TreeNode = { id: 'a', name: 'A', type: MetadataType.Attribute, properties: {}, filePath: '' };
    const typeObject = {
      'v8:Type': 'xs:string',
      'v8:StringQualifiers': { 'v8:Length': 50 },
    };
    const html = renderPropertyInput('Type', typeObject, false, attrNode);
    assert.ok(html.includes('String(50)'), 'Type object should render as String(50)');
    assert.ok(!html.includes('[object Object]'), 'Must not display [object Object]');
  });

  test('renderPropertyInput Type as string should display as-is', () => {
    const attrNode: TreeNode = { id: 'a', name: 'A', type: MetadataType.Attribute, properties: {}, filePath: '' };
    const html = renderPropertyInput('Type', 'CatalogRef.Products', false, attrNode);
    assert.ok(html.includes('CatalogRef.Products'), 'String Type should be shown as-is');
  });

  test('renderPropertyInput Type null/undefined should display Not set', () => {
    const attrNode: TreeNode = { id: 'a', name: 'A', type: MetadataType.Attribute, properties: {}, filePath: '' };
    const htmlNull = renderPropertyInput('Type', null, false, attrNode);
    const htmlUndef = renderPropertyInput('Type', undefined, false, attrNode);
    assert.ok(htmlNull.includes('Not set'), 'null Type should show Not set');
    assert.ok(htmlUndef.includes('Not set'), 'undefined Type should show Not set');
  });

  test('renderPropertyInput malformed Type object should display [Invalid Type]', () => {
    const attrNode: TreeNode = { id: 'a', name: 'A', type: MetadataType.Attribute, properties: {}, filePath: '' };
    const html = renderPropertyInput('Type', { 'v8:Type': 'cfg:BadRef.Obj' }, false, attrNode);
    assert.ok(html.includes('[Invalid Type]'), 'Malformed type object should show [Invalid Type]');
  });

  test('renderPropertyInput Type property name should be case-insensitive', () => {
    const attrNode: TreeNode = { id: 'a', name: 'A', type: MetadataType.Attribute, properties: {}, filePath: '' };
    const htmlLower = renderPropertyInput('type', 'String(10)', false, attrNode);
    const htmlUpper = renderPropertyInput('TYPE', 'String(10)', false, attrNode);
    assert.ok(htmlLower.includes('String(10)'));
    assert.ok(htmlUpper.includes('String(10)'));
  });

  test('form selection payload is ignored when docUri mismatches current selection', () => {
    const ctx: Pick<MessageHandlerContext, 'currentFormSelection' | 'currentFormSelectionRevision'> = {
      currentFormSelection: {
        source: 'form-editor',
        docUri: 'file:///form-a/Ext/Form.xml',
        entityType: 'element',
        id: 'el-1',
        name: 'Element1',
        tag: 'InputField',
        properties: { Width: '100' },
        events: {},
        selectedIds: ['el-1'],
      },
      currentFormSelectionRevision: 5,
    };

    const result = isMatchingCurrentFormSelection({
      type: 'propertyChanged',
      propertyName: 'Width',
      value: '130',
      selectionRevision: '5',
      docUri: 'file:///form-b/Ext/Form.xml',
      entityType: 'element',
      entityId: 'el-1',
    }, ctx as MessageHandlerContext);
    assert.strictEqual(result, false);
  });

  test('form selection payload is ignored when revision is stale', () => {
    const ctx: Pick<MessageHandlerContext, 'currentFormSelection' | 'currentFormSelectionRevision'> = {
      currentFormSelection: {
        source: 'form-editor',
        docUri: 'file:///form-a/Ext/Form.xml',
        entityType: 'element',
        id: 'el-1',
        name: 'Element1',
        tag: 'InputField',
        properties: { Width: '100' },
        events: {},
        selectedIds: ['el-1'],
      },
      currentFormSelectionRevision: 7,
    };

    const result = isMatchingCurrentFormSelection({
      type: 'propertyChanged',
      propertyName: 'Width',
      value: '130',
      selectionRevision: '6',
      docUri: 'file:///form-a/Ext/Form.xml',
      entityType: 'element',
      entityId: 'el-1',
    }, ctx as MessageHandlerContext);
    assert.strictEqual(result, false);
  });

  test('form selection payload matches only the active context', () => {
    const ctx: Pick<MessageHandlerContext, 'currentFormSelection' | 'currentFormSelectionRevision'> = {
      currentFormSelection: {
        source: 'form-editor',
        docUri: 'file:///form-b/Ext/Form.xml',
        entityType: 'attribute',
        id: 'attr-2',
        name: 'Attr2',
        properties: { Type: 'String(20)' },
        events: {},
        selectedIds: ['attr-2'],
      },
      currentFormSelectionRevision: 9,
    };

    const staleFromOtherContext = isMatchingCurrentFormSelection({
      type: 'propertyChanged',
      propertyName: 'Type',
      value: 'String(30)',
      selectionRevision: '9',
      docUri: 'file:///form-a/Ext/Form.xml',
      entityType: 'attribute',
      entityId: 'attr-2',
    }, ctx as MessageHandlerContext);
    const activeContext = isMatchingCurrentFormSelection({
      type: 'propertyChanged',
      propertyName: 'Type',
      value: 'String(30)',
      selectionRevision: '9',
      docUri: 'file:///form-b/Ext/Form.xml',
      entityType: 'attribute',
      entityId: 'attr-2',
    }, ctx as MessageHandlerContext);
    assert.strictEqual(staleFromOtherContext, false, 'stale payload from other form must be ignored');
    assert.strictEqual(activeContext, true, 'payload for active form context must be accepted');
  });
});

/**
 * Builds a minimal MessageHandlerContext for saveProperties tests.
 * Uses the provider's treeDataProvider for refresh(); other callbacks are no-ops.
 */
function makeSaveCtx(p: PropertiesProvider): MessageHandlerContext {
  return {
    currentNode: (p as any).currentNode,
    currentFormSelection: null,
    currentFormSelectionRevision: 0,
    isSaving: false,
    treeDataProvider: (p as any).treeDataProvider,
    typeEditorProvider: (p as any).typeEditorProvider,
    postMessage: () => undefined,
    updateWebviewContent: () => undefined,
    setIsSaving: () => undefined,
  };
}

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
      asAbsolutePath: (relativePath: string) => relativePath,
    };

    treeDataProvider = new MetadataTreeDataProvider();
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

    const ctx = makeSaveCtx(provider);

    await assert.rejects(
      async () => {
        await saveProperties(node, { name: 'UpdatedCatalog' }, ctx);
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

      const ctx = makeSaveCtx(provider);
      await saveProperties(node, newProperties, ctx);

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

    const ctx = makeSaveCtx(provider);

    await assert.rejects(
      async () => {
        await saveProperties(node, { Name: 'UpdatedCatalog' }, ctx);
      },
      {
        message: /Failed to write properties/,
      }
    );
  });
});
