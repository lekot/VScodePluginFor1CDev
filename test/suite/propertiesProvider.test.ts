import * as path from 'path';
import * as fs from 'fs';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { PropertiesProvider } from '../../src/providers/propertiesProvider';
import { MetadataTreeDataProvider } from '../../src/providers/treeDataProvider';
import { TypeEditorProvider } from '../../src/providers/typeEditorProvider';
import { TreeNode, MetadataType } from '../../src/models/treeNode';
import { MESSAGES } from '../../src/constants/messages';
import { validateProperties } from '../../src/providers/propertiesValidation';
import {
  detectPropertyType,
  escapeHtml,
  isRootElement,
  renderPropertyInput,
} from '../../src/providers/propertiesWebviewContent';
import {
  handleMessage,
  isMatchingCurrentFormSelection,
  parseDisplayTypeString,
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
      maxLength: 'not a number',
    }, node);

    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.maxLength);
    assert.strictEqual(result.errors.maxLength, 'Must be a number');
  });

  test('Validation rejects Name through generic property edits, including an empty value', () => {
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
    assert.match(result.errors.name, /Переименовать элемент/);
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

suite('PropertiesProvider isOpen / updateIfOpen Test Suite', () => {
  let provider: PropertiesProvider;
  let mockContext: vscode.ExtensionContext;

  setup(() => {
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
    provider = new PropertiesProvider(
      mockContext,
      new MetadataTreeDataProvider(),
      new TypeEditorProvider(mockContext)
    );
  });

  teardown(() => {
    provider.dispose();
  });

  test('isOpen() returns false before any panel is created', () => {
    assert.strictEqual(provider.isOpen(), false, 'panel should not exist before showProperties');
  });

  test('updateIfOpen() is a no-op when panel is closed — does not throw', async () => {
    const node: TreeNode = {
      id: 'n1',
      name: 'TestCatalog',
      type: MetadataType.Catalog,
      properties: { Name: 'TestCatalog' },
      filePath: '/fake/path.xml',
    };
    // Should not throw even though panel is undefined
    await assert.doesNotReject(async () => {
      await provider.updateIfOpen(node);
    });
    // currentNode should remain undefined — update was skipped
    assert.strictEqual((provider as any).currentNode, undefined, 'currentNode must not be set when panel is closed');
  });

  test('updateIfOpen() updates currentNode when panel is artificially open', async () => {
    // Inject a fake panel so we can test without real VS Code UI
    const fakePanelDisposed: boolean[] = [];
    const fakePanel: any = {
      webview: { html: '' },
      reveal: () => { /* no-op */ },
      onDidDispose: () => ({ dispose: () => undefined }),
      webview_onDidReceiveMessage: () => ({ dispose: () => undefined }),
      dispose: () => { fakePanelDisposed.push(true); },
    };
    (provider as any).panel = fakePanel;

    const node: TreeNode = {
      id: 'n2',
      name: 'UpdatedCatalog',
      type: MetadataType.Catalog,
      properties: { Name: 'UpdatedCatalog' },
    };

    assert.strictEqual(provider.isOpen(), true, 'panel should be seen as open after injection');
    await provider.updateIfOpen(node);
    assert.strictEqual((provider as any).currentNode, node, 'currentNode must be updated to the new node');
    // panel.reveal must NOT have been called — updateIfOpen does not reveal
    // (no assertion needed beyond checking panel.reveal was not invoked with side effects)
  });

  test('isOpen() returns false after dispose()', () => {
    // Inject a fake panel and then dispose
    (provider as any).panel = { webview: { html: '' }, dispose: () => undefined, reveal: () => undefined };
    assert.strictEqual(provider.isOpen(), true);
    provider.dispose();
    assert.strictEqual(provider.isOpen(), false, 'panel should be undefined after dispose');
  });

  test('Finding 3: race condition between rapid selections discards stale picture of previous node', async () => {
    let htmlContent = '';
    const fakePanel: any = {
      webview: {
        get html() { return htmlContent; },
        set html(val: string) { htmlContent = val; },
        postMessage: async () => true,
        onDidReceiveMessage: () => ({ dispose: () => undefined }),
      },
      reveal: () => undefined,
      onDidDispose: () => ({ dispose: () => undefined }),
      dispose: () => undefined,
    };
    (provider as any).panel = fakePanel;

    const node1: TreeNode = {
      id: 'CommonPictures.FirstPic',
      name: 'FirstPic',
      type: MetadataType.CommonPicture,
      properties: { Name: 'FirstPic' },
      filePath: '/nonexistent/FirstPic.xml',
    };

    const node2: TreeNode = {
      id: 'CommonPictures.SecondPic',
      name: 'SecondPic',
      type: MetadataType.CommonPicture,
      properties: { Name: 'SecondPic' },
      filePath: '/nonexistent/SecondPic.xml',
    };

    let resolveFirstPromise: (value: any) => void;
    const delayedFirstPromise = new Promise((resolve) => {
      resolveFirstPromise = resolve;
    });

    const pictureResolver = await import('../../src/services/picture/commonPictureResolver');
    const origResolve = pictureResolver.resolveCommonPicture;

    try {
      (pictureResolver as any).resolveCommonPicture = async (node: TreeNode) => {
        if (node.id === node1.id) {
          await delayedFirstPromise;
          return {
            success: true,
            format: 'PNG',
            dataUri: 'data:image/png;base64,FIRST',
            resolvedFilePath: '/fake/first.png',
          };
        }
        return {
          success: true,
          format: 'PNG',
          dataUri: 'data:image/png;base64,SECOND',
          resolvedFilePath: '/fake/second.png',
        };
      };

      // node1 begins updateWebviewContent and waits on resolveCommonPicture
      (provider as any).currentNode = node1;
      const p1 = (provider as any).updateWebviewContent();

      // Immediately switch to node2
      (provider as any).currentNode = node2;
      const p2 = (provider as any).updateWebviewContent();

      await p2;
      assert.ok(htmlContent.includes('SecondPic'), 'panel must display SecondPic after node2 is shown');
      assert.ok(htmlContent.includes('SECOND'), 'panel must contain picture of SecondPic');

      // Now node1's delayed picture finishes
      resolveFirstPromise!({});
      await p1;

      // Stale node1 resolution MUST NOT overwrite node2's webview with node1's picture
      assert.ok(htmlContent.includes('SecondPic'), 'panel must still display SecondPic');
      assert.strictEqual(
        htmlContent.includes('data:image/png;base64,FIRST'),
        false,
        'stale first picture must not overwrite webview under second node'
      );
    } finally {
      (pictureResolver as any).resolveCommonPicture = origResolve;
    }
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
    objectTypeEditorProvider: (p as any).objectTypeEditorProvider ?? {} as any,
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
        await saveProperties(node, { Synonym: 'UpdatedCatalog' }, ctx);
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

      const newProperties = { Synonym: 'Updated Synonym' };

      const ctx = makeSaveCtx(provider);
      await saveProperties(node, newProperties, ctx);

      // Verify node properties were updated
      assert.strictEqual(node.properties.Name, 'TestCatalog');
      assert.strictEqual(node.properties.Synonym, 'Updated Synonym');

      // Verify file was actually written
      const { XMLWriter } = await import('../../src/utils/XMLWriter');
      const savedProperties = await XMLWriter.readProperties(tempXmlPath);
      assert.strictEqual(savedProperties.Name, 'TestCatalog');
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
        await saveProperties(node, { Synonym: 'UpdatedCatalog' }, ctx);
      },
      {
        message: /Failed to write properties/,
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Issue #165: Navigation Guard & Dirty State
// ---------------------------------------------------------------------------

suite('PropertiesProvider — Issue #165 Navigation Guard & Dirty State', () => {
  let provider: PropertiesProvider;
  let treeDataProvider: MetadataTreeDataProvider;
  let typeEditorProvider: TypeEditorProvider;
  let mockContext: vscode.ExtensionContext;
  let defaultShowWarningMessage: any;
  let defaultCreateWebviewPanel: any;
  let mockWebview: any;
  let tempXmlPath: string;

  setup(async () => {
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

    defaultShowWarningMessage = vscode.window.showWarningMessage;
    defaultCreateWebviewPanel = vscode.window.createWebviewPanel;

    mockWebview = {
      html: '',
      onDidReceiveMessage: () => ({ dispose: () => {} }),
      postMessage: async () => true,
      asWebviewUri: (uri: vscode.Uri) => uri,
      cspSource: 'https://test',
    };

    (vscode.window as any).createWebviewPanel = () => ({
      webview: mockWebview,
      onDidDispose: (cb: () => void) => ({ dispose: () => {} }),
      reveal: () => {},
      dispose: () => {},
    });

    const fixturesPath = path.join(__dirname, '../../../test/fixtures');
    const testXmlPath = path.join(fixturesPath, 'test-properties.xml');
    tempXmlPath = path.join(fixturesPath, `temp-guard-test-${Date.now()}.xml`);
    fs.copyFileSync(testXmlPath, tempXmlPath);
  });

  teardown(() => {
    provider.dispose();
    (vscode.window as any).showWarningMessage = defaultShowWarningMessage;
    (vscode.window as any).createWebviewPanel = defaultCreateWebviewPanel;
    if (fs.existsSync(tempXmlPath)) {
      try {
        fs.unlinkSync(tempXmlPath);
      } catch {
        // ignore
      }
    }
  });

  test('dirtyChange message updates provider.isDirty() state', async () => {
    const node: TreeNode = {
      id: 'node-1',
      name: 'Catalog1',
      type: MetadataType.Catalog,
      properties: { Name: 'Catalog1' },
      filePath: tempXmlPath,
    };

    await provider.showProperties(node);
    assert.strictEqual(provider.isDirty(), false);

    // Simulate dirtyChange true
    provider.setIsDirty(true, { Synonym: 'ModifiedCatalog' });
    assert.strictEqual(provider.isDirty(), true);

    // Simulate dirtyChange false
    provider.setIsDirty(false);
    assert.strictEqual(provider.isDirty(), false);
  });

  test('updateIfOpen prompts when dirty: choice "Сохранить" saves and navigates to new node', async () => {
    const nodeA: TreeNode = {
      id: 'node-a',
      name: 'CatalogA',
      type: MetadataType.Catalog,
      properties: { Name: 'CatalogA', Synonym: 'Initial Synonym' },
      filePath: tempXmlPath,
    };
    const nodeB: TreeNode = {
      id: 'node-b',
      name: 'CatalogB',
      type: MetadataType.Catalog,
      properties: { Name: 'CatalogB' },
      filePath: tempXmlPath,
    };

    await provider.showProperties(nodeA);
    provider.setIsDirty(true, { Synonym: 'Saved Before Navigation' });

    let promptCalled = false;
    (vscode.window as any).showWarningMessage = async (msg: string, ...items: any[]) => {
      promptCalled = true;
      assert.ok(msg.includes('CatalogA'), 'Message must contain current node name');
      return 'Сохранить';
    };

    await provider.updateIfOpen(nodeB);

    assert.ok(promptCalled, 'showWarningMessage must be called');
    assert.strictEqual(provider.isDirty(), false, 'Dirty flag must be cleared after save');
    assert.strictEqual((provider as any).currentNode, nodeB, 'Current node must be updated to nodeB');

    // Verify nodeA changes were persisted to XML
    const { XMLWriter } = await import('../../src/utils/XMLWriter');
    const saved = await XMLWriter.readProperties(tempXmlPath);
    assert.strictEqual(saved.Synonym, 'Saved Before Navigation');
  });

  test('updateIfOpen prompts when dirty: choice "Не сохранять" discards and navigates to new node', async () => {
    const nodeA: TreeNode = {
      id: 'node-a',
      name: 'CatalogA',
      type: MetadataType.Catalog,
      properties: { Name: 'CatalogA', Synonym: 'Initial Synonym' },
      filePath: tempXmlPath,
    };
    const nodeB: TreeNode = {
      id: 'node-b',
      name: 'CatalogB',
      type: MetadataType.Catalog,
      properties: { Name: 'CatalogB' },
      filePath: tempXmlPath,
    };

    await provider.showProperties(nodeA);
    provider.setIsDirty(true, { Synonym: 'Discarded Synonym' });

    let promptCalled = false;
    (vscode.window as any).showWarningMessage = async (msg: string, ...items: any[]) => {
      promptCalled = true;
      return 'Не сохранять';
    };

    await provider.updateIfOpen(nodeB);

    assert.ok(promptCalled, 'showWarningMessage must be called');
    assert.strictEqual(provider.isDirty(), false, 'Dirty flag must be cleared');
    assert.strictEqual((provider as any).currentNode, nodeB, 'Current node must be updated to nodeB');

    // Verify nodeA changes were NOT written to disk
    const { XMLWriter } = await import('../../src/utils/XMLWriter');
    const saved = await XMLWriter.readProperties(tempXmlPath);
    assert.strictEqual(saved.Synonym, 'Test Catalog Synonym');
  });

  test('updateIfOpen prompts when dirty: choice "Отмена" aborts navigation and stays on currentNode', async () => {
    const nodeA: TreeNode = {
      id: 'node-a',
      name: 'CatalogA',
      type: MetadataType.Catalog,
      properties: { Name: 'CatalogA' },
      filePath: tempXmlPath,
    };
    const nodeB: TreeNode = {
      id: 'node-b',
      name: 'CatalogB',
      type: MetadataType.Catalog,
      properties: { Name: 'CatalogB' },
      filePath: tempXmlPath,
    };

    await provider.showProperties(nodeA);
    provider.setIsDirty(true, { Synonym: 'Pending' });

    (vscode.window as any).showWarningMessage = async () => 'Отмена';

    await provider.updateIfOpen(nodeB);

    assert.strictEqual(provider.isDirty(), true, 'Dirty flag must remain true');
    assert.strictEqual((provider as any).currentNode, nodeA, 'Current node must remain nodeA');
  });

  test('updateIfOpen on identical node does not prompt even if dirty', async () => {
    const nodeA: TreeNode = {
      id: 'node-a',
      name: 'CatalogA',
      type: MetadataType.Catalog,
      properties: { Name: 'CatalogA' },
      filePath: tempXmlPath,
    };

    await provider.showProperties(nodeA);
    provider.setIsDirty(true, { Synonym: 'Pending' });

    (vscode.window as any).showWarningMessage = async () => {
      assert.fail('Should not prompt when staying on same node');
    };

    await provider.updateIfOpen(nodeA);
    assert.strictEqual((provider as any).currentNode, nodeA);
  });

  test('showProperties prompts when dirty: choice "Отмена" aborts and stays on currentNode', async () => {
    const nodeA: TreeNode = {
      id: 'node-a',
      name: 'CatalogA',
      type: MetadataType.Catalog,
      properties: { Name: 'CatalogA' },
      filePath: tempXmlPath,
    };
    const nodeB: TreeNode = {
      id: 'node-b',
      name: 'CatalogB',
      type: MetadataType.Catalog,
      properties: { Name: 'CatalogB' },
      filePath: tempXmlPath,
    };

    await provider.showProperties(nodeA);
    provider.setIsDirty(true, { Synonym: 'Pending' });

    (vscode.window as any).showWarningMessage = async () => 'Отмена';

    await provider.showProperties(nodeB);

    assert.strictEqual(provider.isDirty(), true);
    assert.strictEqual((provider as any).currentNode, nodeA);
  });

  test('showProperties prompts when dirty: choice "Сохранить" saves and navigates to new node', async () => {
    const nodeA: TreeNode = {
      id: 'node-a',
      name: 'CatalogA',
      type: MetadataType.Catalog,
      properties: { Name: 'CatalogA' },
      filePath: tempXmlPath,
    };
    const nodeB: TreeNode = {
      id: 'node-b',
      name: 'CatalogB',
      type: MetadataType.Catalog,
      properties: { Name: 'CatalogB' },
      filePath: tempXmlPath,
    };

    await provider.showProperties(nodeA);
    provider.setIsDirty(true, { Synonym: 'SavedViaShow' });

    (vscode.window as any).showWarningMessage = async () => 'Сохранить';

    await provider.showProperties(nodeB);

    assert.strictEqual(provider.isDirty(), false);
    assert.strictEqual((provider as any).currentNode, nodeB);

    const { XMLWriter } = await import('../../src/utils/XMLWriter');
    const saved = await XMLWriter.readProperties(tempXmlPath);
    assert.strictEqual(saved.Synonym, 'SavedViaShow');
  });

  test('showFormSelectionProperties prompts when dirty: choice "Отмена" aborts navigation', async () => {
    const nodeA: TreeNode = {
      id: 'node-a',
      name: 'CatalogA',
      type: MetadataType.Catalog,
      properties: { Name: 'CatalogA' },
      filePath: tempXmlPath,
    };

    await provider.showProperties(nodeA);
    provider.setIsDirty(true, { Synonym: 'FormPending' });

    (vscode.window as any).showWarningMessage = async () => 'Отмена';

    await provider.showFormSelectionProperties({
      source: 'form-editor',
      docUri: 'file:///form.xml',
      entityType: 'element',
      id: 'el-1',
      name: 'El1',
      tag: 'InputField',
      properties: {},
      events: {},
      selectedIds: ['el-1'],
    });

    assert.strictEqual(provider.isDirty(), true);
    assert.strictEqual((provider as any).currentNode, nodeA);
  });

  test('guard aborts navigation when properties fail validation on "Сохранить"', async () => {
    const nodeA: TreeNode = {
      id: 'node-a',
      name: 'CatalogA',
      type: MetadataType.Catalog,
      properties: { Name: 'CatalogA' },
      filePath: tempXmlPath,
    };
    const nodeB: TreeNode = {
      id: 'node-b',
      name: 'CatalogB',
      type: MetadataType.Catalog,
      properties: { Name: 'CatalogB' },
      filePath: tempXmlPath,
    };

    await provider.showProperties(nodeA);
    // Invalid empty Name fails validation
    provider.setIsDirty(true, { Name: '' });

    (vscode.window as any).showWarningMessage = async (msg: string) => {
      if (msg.includes('несохранённые')) {
        return 'Сохранить';
      }
      return undefined;
    };

    await provider.updateIfOpen(nodeB);

    // Save failed validation, so navigation must be aborted and node remains nodeA
    assert.strictEqual(provider.isDirty(), true);
    assert.strictEqual((provider as any).currentNode, nodeA);
  });

  test('two consecutive dirtyChange message dispatches update pendingProperties with both edits', async () => {
    const nodeA: TreeNode = {
      id: 'node-a',
      name: 'CatalogA',
      type: MetadataType.Catalog,
      properties: { Name: 'CatalogA', Synonym: 'Orig', Comment: 'Orig' },
      filePath: tempXmlPath,
    };

    await provider.showProperties(nodeA);

    const { handleMessage } = await import('../../src/providers/propertiesMessageHandler');
    const ctx = (provider as any).buildHandlerContext();

    // 1st edit: Synonym changed
    await handleMessage(
          { type: 'dirtyChange', isDirty: true, properties: { Synonym: 'First Edit', Comment: 'Orig' } },
      ctx
    );
    assert.strictEqual(provider.isDirty(), true);
    assert.deepStrictEqual((provider as any).pendingProperties, { Synonym: 'First Edit', Comment: 'Orig' });

    // 2nd edit: Comment changed as well
    await handleMessage(
          { type: 'dirtyChange', isDirty: true, properties: { Synonym: 'First Edit', Comment: 'Second Edit' } },
      ctx
    );
    assert.strictEqual(provider.isDirty(), true);
    assert.deepStrictEqual((provider as any).pendingProperties, { Synonym: 'First Edit', Comment: 'Second Edit' });
  });

  test('refreshIfCurrentNode re-reads disk content on same node when file changed externally', async () => {
    const nodeA: TreeNode = {
      id: 'node-a',
      name: 'CatalogA',
      type: MetadataType.Catalog,
      properties: { Name: 'CatalogA', Synonym: 'Test Catalog Synonym' },
      filePath: tempXmlPath,
    };

    await provider.showProperties(nodeA);
    assert.strictEqual(nodeA.properties.Synonym, 'Test Catalog Synonym');

    // Externally modify XML on disk
    const { XMLWriter } = await import('../../src/utils/XMLWriter');
    await XMLWriter.updateProperty(tempXmlPath, 'Synonym', 'Externally Modified Synonym');

    // refreshIfCurrentNode should force reload from disk even though node === currentNode
    await provider.refreshIfCurrentNode(tempXmlPath);

    assert.strictEqual(nodeA.properties.Synonym, 'Externally Modified Synonym', 'properties must be re-read from disk');
  });

  test('refreshIfCurrentNode preserves unsaved edit guard when panel is dirty', async () => {
    const nodeA: TreeNode = {
      id: 'node-a',
      name: 'CatalogA',
      type: MetadataType.Catalog,
      properties: { Name: 'CatalogA', Synonym: 'Test Catalog Synonym' },
      filePath: tempXmlPath,
    };

    await provider.showProperties(nodeA);
    provider.setIsDirty(true, { Synonym: 'Unsaved Edit' });

    // User chooses "Отмена" on guard prompt
    (vscode.window as any).showWarningMessage = async () => 'Отмена';

    // External change happens and triggers refresh
    await provider.refreshIfCurrentNode(tempXmlPath);

    // Refresh was aborted, dirty state and pending properties preserved
    assert.strictEqual(provider.isDirty(), true);
    assert.strictEqual((provider as any).pendingProperties?.Synonym, 'Unsaved Edit');
  });

  test('refreshIfCurrentNode re-reads nested element properties from parentFilePath when file changed externally', async () => {
    const parentXml = path.join(path.dirname(tempXmlPath), `temp-nested-${Date.now()}.xml`);
    await fs.promises.writeFile(
      parentXml,
      `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core" version="2.20">
  <Catalog uuid="cat-1">
    <Properties><Name>CatalogWithAttrs</Name></Properties>
    <ChildObjects>
      <Attribute uuid="attr-1">
        <Properties>
          <Name>TestAttr</Name>
          <Synonym><v8:item><v8:lang>ru</v8:lang><v8:content>Original Synonym</v8:content></v8:item></Synonym>
          <Comment>Original Comment</Comment>
        </Properties>
      </Attribute>
    </ChildObjects>
  </Catalog>
</MetaDataObject>`,
      'utf8'
    );

    try {
      const nestedNode: TreeNode = {
        id: 'Catalog.CatalogWithAttrs.Attribute.TestAttr',
        name: 'TestAttr',
        type: MetadataType.Attribute,
        properties: { Name: 'TestAttr', Synonym: 'Original Synonym', Comment: 'Original Comment' },
        filePath: undefined,
        parentFilePath: parentXml,
      };

      await provider.showProperties(nestedNode);
      assert.strictEqual(nestedNode.properties.Comment, 'Original Comment');

      // Externally update attribute in parentXml
      const { XMLWriter } = await import('../../src/utils/XMLWriter');
      await XMLWriter.writeNestedElementProperties(
        parentXml,
        'Attribute',
        'TestAttr',
        { Comment: 'Externally Updated Comment' },
        ['Comment']
      );

      // Refresh should re-read nested properties from parentFilePath
      await provider.refreshIfCurrentNode(parentXml);

      assert.strictEqual(
        nestedNode.properties.Comment,
        'Externally Updated Comment',
        'nested node properties must be re-read from parentFilePath on refresh'
      );
    } finally {
      if (fs.existsSync(parentXml)) {
        await fs.promises.unlink(parentXml);
      }
    }
  });

  test('delayed dirtyChange message from previous node does not pollute newly opened node', async () => {
    const nodeA: TreeNode = {
      id: 'node-a',
      name: 'CatalogA',
      type: MetadataType.Catalog,
      properties: { Name: 'CatalogA', Synonym: 'Synonym A' },
      filePath: tempXmlPath,
    };

    const nodeBXml = path.join(path.dirname(tempXmlPath), `temp-node-b-${Date.now()}.xml`);
    await fs.promises.writeFile(nodeBXml, '<Catalog><Properties><Name>CatalogB</Name></Properties></Catalog>', 'utf8');

    try {
      const nodeB: TreeNode = {
        id: 'node-b',
        name: 'CatalogB',
        type: MetadataType.Catalog,
        properties: { Name: 'CatalogB', Synonym: 'Synonym B' },
        filePath: nodeBXml,
      };

      // Open Node A
      await provider.showProperties(nodeA);

      // User navigates to Node B
      await provider.showProperties(nodeB);
      assert.strictEqual(provider.isDirty(), false);
      assert.strictEqual((provider as any).pendingProperties, undefined);

      // Delayed dirtyChange from Node A arrives late
      const { handleMessage } = await import('../../src/providers/propertiesMessageHandler');
      const ctx = (provider as any).buildHandlerContext();

      await handleMessage(
        {
          type: 'dirtyChange',
          isDirty: true,
          properties: { Name: 'CatalogA', Synonym: 'Polluted From A' },
          nodeId: 'node-a',
          sessionToken: 'node-a:session-1',
        },
        ctx
      );

      // Node B must NOT be dirty and must NOT contain Node A's properties
      assert.strictEqual(provider.isDirty(), false, 'delayed message from node A must not mark node B as dirty');
      assert.strictEqual((provider as any).pendingProperties, undefined, 'pendingProperties must not be set from node A');
    } finally {
      if (fs.existsSync(nodeBXml)) {
        await fs.promises.unlink(nodeBXml);
      }
    }
  });

  test('delayed dirtyChange from node A via intermediate empty panel is rejected and does not pollute node B', async () => {
    const nodeA: TreeNode = {
      id: 'node-a',
      name: 'CatalogA',
      type: MetadataType.Catalog,
      properties: { Name: 'CatalogA', Synonym: 'Synonym A' },
      filePath: tempXmlPath,
    };

    const nodeBXml = path.join(path.dirname(tempXmlPath), `temp-node-b-empty-${Date.now()}.xml`);
    await fs.promises.writeFile(nodeBXml, '<Catalog><Properties><Name>CatalogB</Name></Properties></Catalog>', 'utf8');

    try {
      const nodeB: TreeNode = {
        id: 'node-b',
        name: 'CatalogB',
        type: MetadataType.Catalog,
        properties: { Name: 'CatalogB', Synonym: 'Synonym B' },
        filePath: nodeBXml,
      };

      // Open Node A and capture session token
      await provider.showProperties(nodeA);
      const sessionTokenA = (provider as any).currentSessionToken;
      assert.ok(sessionTokenA, 'sessionTokenA should exist');

      // User navigates to empty panel (node undefined)
      await provider.showProperties(undefined);
      assert.strictEqual((provider as any).currentNode, undefined);
      assert.strictEqual(provider.isDirty(), false);

      // Delayed dirtyChange from Node A arrives while on empty panel
      const { handleMessage } = await import('../../src/providers/propertiesMessageHandler');
      const ctx = (provider as any).buildHandlerContext();

      await handleMessage(
        {
          type: 'dirtyChange',
          isDirty: true,
          properties: { Name: 'CatalogA', Synonym: 'Polluted Through Empty Panel' },
          nodeId: 'node-a',
          sessionToken: sessionTokenA,
        },
        ctx
      );

      // Delayed message for dead session A MUST NOT set pendingProperties
      assert.strictEqual(provider.isDirty(), false, 'delayed message on empty panel must not set isDirty');
      assert.strictEqual((provider as any).pendingProperties, undefined, 'delayed message must not set pendingProperties on empty panel');

      // User navigates to Node B
      await provider.showProperties(nodeB);
      assert.strictEqual(provider.isDirty(), false);
      assert.strictEqual((provider as any).pendingProperties, undefined, 'Node B must not inherit dirty state from A');
    } finally {
      if (fs.existsSync(nodeBXml)) {
        await fs.promises.unlink(nodeBXml);
      }
    }
  });

  test('delayed dirtyChange from node A via intermediate form selection panel is rejected and does not pollute node B', async () => {
    const nodeA: TreeNode = {
      id: 'node-a',
      name: 'CatalogA',
      type: MetadataType.Catalog,
      properties: { Name: 'CatalogA', Synonym: 'Synonym A' },
      filePath: tempXmlPath,
    };

    const nodeBXml = path.join(path.dirname(tempXmlPath), `temp-node-b-form-${Date.now()}.xml`);
    await fs.promises.writeFile(nodeBXml, '<Catalog><Properties><Name>CatalogB</Name></Properties></Catalog>', 'utf8');

    try {
      const nodeB: TreeNode = {
        id: 'node-b',
        name: 'CatalogB',
        type: MetadataType.Catalog,
        properties: { Name: 'CatalogB', Synonym: 'Synonym B' },
        filePath: nodeBXml,
      };

      // Open Node A and capture session token
      await provider.showProperties(nodeA);
      const sessionTokenA = (provider as any).currentSessionToken;

      // User switches to form selection properties
      await provider.showFormSelectionProperties({ entityType: 'form' } as any);
      assert.strictEqual((provider as any).currentNode, undefined);
      assert.strictEqual(provider.isDirty(), false);

      // Delayed dirtyChange from Node A arrives while on form panel
      const { handleMessage } = await import('../../src/providers/propertiesMessageHandler');
      const ctx = (provider as any).buildHandlerContext();

      await handleMessage(
        {
          type: 'dirtyChange',
          isDirty: true,
          properties: { Name: 'CatalogA', Synonym: 'Polluted Through Form Panel' },
          nodeId: 'node-a',
          sessionToken: sessionTokenA,
        },
        ctx
      );

      assert.strictEqual(provider.isDirty(), false, 'delayed message on form panel must not set isDirty');
      assert.strictEqual((provider as any).pendingProperties, undefined, 'delayed message must not set pendingProperties on form panel');

      // User switches to Node B
      await provider.showProperties(nodeB);
      assert.strictEqual(provider.isDirty(), false);
      assert.strictEqual((provider as any).pendingProperties, undefined, 'Node B must not inherit dirty state from A');
    } finally {
      if (fs.existsSync(nodeBXml)) {
        await fs.promises.unlink(nodeBXml);
      }
    }
  });

  test('refreshIfCurrentNode reports failure and does not show success notification when reading nested element properties fails', async () => {
    const parentXml = path.join(path.dirname(tempXmlPath), `temp-nested-fail-${Date.now()}.xml`);
    await fs.promises.writeFile(
      parentXml,
      `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20">
  <Catalog uuid="cat-1">
    <Properties><Name>CatalogWithAttrs</Name></Properties>
    <ChildObjects>
      <Attribute uuid="attr-1">
        <Properties><Name>TestAttr</Name></Properties>
      </Attribute>
    </ChildObjects>
  </Catalog>
</MetaDataObject>`,
      'utf8'
    );

    try {
      const nestedNode: TreeNode = {
        id: 'Catalog.CatalogWithAttrs.Attribute.TestAttr',
        name: 'TestAttr',
        type: MetadataType.Attribute,
        properties: { Name: 'TestAttr' },
        filePath: undefined,
        parentFilePath: parentXml,
      };

      await provider.showProperties(nestedNode);

      // Corrupt parent file so reading nested properties throws an XML parsing error
      await fs.promises.writeFile(parentXml, '<CorruptedXML not closed', 'utf8');

      let notificationShown = false;
      const originalShowInfo = vscode.window.showInformationMessage;
      (vscode.window as any).showInformationMessage = async (msg: string) => {
        if (msg === MESSAGES.FILE_CHANGED_PANEL_REFRESHED) {
          notificationShown = true;
        }
        return undefined;
      };

      try {
        await provider.refreshIfCurrentNode(parentXml);
        assert.strictEqual(
          notificationShown,
          false,
          'FILE_CHANGED_PANEL_REFRESHED notification must NOT be shown when nested property re-read fails'
        );
      } finally {
        vscode.window.showInformationMessage = originalShowInfo;
      }
    } finally {
      if (fs.existsSync(parentXml)) {
        await fs.promises.unlink(parentXml);
      }
    }
  });

  test('opening container nodes with parentFilePath shows empty state instead of error panel', async () => {
    const parentXml = path.join(path.dirname(tempXmlPath), `temp-container-test-${Date.now()}.xml`);
    await fs.promises.writeFile(
      parentXml,
      `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20">
  <Catalog uuid="cat-1">
    <Properties><Name>CatalogWithContainers</Name></Properties>
    <ChildObjects>
      <Attribute uuid="attr-1">
        <Properties><Name>Attr1</Name></Properties>
      </Attribute>
    </ChildObjects>
  </Catalog>
</MetaDataObject>`,
      'utf8'
    );

    try {
      // 1. Attributes container node
      const attrsContainer: TreeNode = {
        id: 'Attributes',
        name: 'Attributes',
        type: MetadataType.Attribute,
        properties: {},
        children: [],
        parentFilePath: parentXml,
      };

      const openedAttrs = await provider.showProperties(attrsContainer);
      assert.strictEqual(openedAttrs, true, 'Attributes container should open successfully');
      const htmlAttrs = (provider as any).panel?.webview.html || '';
      assert.ok(!htmlAttrs.includes('error-panel'), 'Attributes container must NOT show error panel');
      assert.ok(
        htmlAttrs.includes(MESSAGES.EMPTY_STATE_NO_PROPERTIES_TITLE),
        'Attributes container must show empty state'
      );

      // 2. TabularSections container node
      const tsContainer: TreeNode = {
        id: 'TabularSections',
        name: 'Tabular Sections',
        type: MetadataType.TabularSection,
        properties: {},
        children: [],
        parentFilePath: parentXml,
      };

      const openedTs = await provider.showProperties(tsContainer);
      assert.strictEqual(openedTs, true, 'TabularSections container should open successfully');
      const htmlTs = (provider as any).panel?.webview.html || '';
      assert.ok(!htmlTs.includes('error-panel'), 'TabularSections container must NOT show error panel');
      assert.ok(
        htmlTs.includes(MESSAGES.EMPTY_STATE_NO_PROPERTIES_TITLE),
        'TabularSections container must show empty state'
      );

      // 3. Tabular section columns placeholder container (isTabularSectionColumnsContainer)
      const tsInstanceNode: TreeNode = {
        id: 'TabularSections.Items',
        name: 'Items',
        type: MetadataType.TabularSection,
        properties: { Name: 'Items' },
        parentFilePath: parentXml,
      };
      const columnsContainer: TreeNode = {
        id: 'TabularSections.Items.Attributes',
        name: 'Реквизиты',
        type: MetadataType.Attribute,
        properties: { type: 'TabularSectionColumns' },
        children: [],
        parent: tsInstanceNode,
        parentFilePath: parentXml,
      };

      const openedCols = await provider.showProperties(columnsContainer);
      assert.strictEqual(openedCols, true, 'Columns container should open successfully');
      const htmlCols = (provider as any).panel?.webview.html || '';
      assert.ok(!htmlCols.includes('error-panel'), 'Columns container must NOT show error panel');
      assert.ok(
        htmlCols.includes(MESSAGES.EMPTY_STATE_NO_PROPERTIES_TITLE),
        'Columns container must show empty state'
      );
    } finally {
      if (fs.existsSync(parentXml)) {
        await fs.promises.unlink(parentXml);
      }
    }
  });

  test('opening EDT PredefinedItem with parentFilePath preserves properties without error panel', async () => {
    const predefinedXml = path.join(path.dirname(tempXmlPath), `temp-predefined-test-${Date.now()}.xml`);
    await fs.promises.writeFile(
      predefinedXml,
      `<?xml version="1.0" encoding="UTF-8"?>
<PredefinedData xmlns="http://v8.1c.ru/8.3/MDClasses">
  <Item>
    <Name>MainItem</Name>
    <Code>001</Code>
    <Description>Main Description</Description>
  </Item>
</PredefinedData>`,
      'utf8'
    );

    try {
      const predefinedNode: TreeNode = {
        id: 'PredefinedData.MainItem',
        name: 'MainItem',
        type: MetadataType.PredefinedItem,
        properties: {
          code: '001',
          description: 'Main Description',
        },
        parentFilePath: predefinedXml,
      };

      const opened = await provider.showProperties(predefinedNode);
      assert.strictEqual(opened, true, 'PredefinedItem should open successfully');
      const html = (provider as any).panel?.webview.html || '';
      assert.ok(!html.includes('error-panel'), 'PredefinedItem must NOT show error panel');
      assert.strictEqual(predefinedNode.properties.code, '001');
      assert.strictEqual(predefinedNode.properties.description, 'Main Description');
    } finally {
      if (fs.existsSync(predefinedXml)) {
        await fs.promises.unlink(predefinedXml);
      }
    }
  });

  test('showProperties scopes tabular section column read when column name collides with another element', async () => {
    const multiTsXml = path.join(path.dirname(tempXmlPath), `temp-scoped-col-${Date.now()}.xml`);
    const fixturePath = path.join(__dirname, '../fixtures/designer-config/Catalogs/CatalogTovaryIZakazyNomenklatura.xml');
    await fs.promises.copyFile(fixturePath, multiTsXml);

    try {
      // Optimistic column node under TabularSection 'Заказы' without nestedPath
      const zakazyTsNode: TreeNode = {
        id: 'TabularSections.Заказы',
        name: 'Заказы',
        type: MetadataType.TabularSection,
        properties: { Name: 'Заказы' },
        parentFilePath: multiTsXml,
      };
      const zakazyColsContainer: TreeNode = {
        id: 'TabularSections.Заказы.Attributes',
        name: 'Реквизиты',
        type: MetadataType.Attribute,
        properties: { type: 'TabularSectionColumns' },
        parent: zakazyTsNode,
        parentFilePath: multiTsXml,
      };
      const columnNode: TreeNode = {
        id: 'TabularSections.Заказы.Номенклатура',
        name: 'Номенклатура',
        type: MetadataType.Attribute,
        properties: { Name: 'Номенклатура' },
        parent: zakazyColsContainer,
        parentFilePath: multiTsXml,
      };

      const opened = await provider.showProperties(columnNode);
      assert.strictEqual(opened, true, 'Column should open successfully');
      assert.strictEqual(
        columnNode.properties.uuid,
        'c0000000-0000-0000-0000-000000000321',
        'Properties must be loaded from section Заказы, not Товары'
      );
    } finally {
      if (fs.existsSync(multiTsXml)) {
        await fs.promises.unlink(multiTsXml);
      }
    }
  });

  test('opening register Dimensions, Resources, and EnumValues container nodes shows empty state without error', async () => {
    const parentXml = path.join(path.dirname(tempXmlPath), `temp-reg-containers-${Date.now()}.xml`);
    await fs.promises.writeFile(
      parentXml,
      `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses">
  <InformationRegister uuid="ir-1">
    <Properties><Name>TestRegister</Name></Properties>
    <ChildObjects>
      <Dimension uuid="dim-1"><Properties><Name>Dim1</Name></Properties></Dimension>
      <Resource uuid="res-1"><Properties><Name>Res1</Name></Properties></Resource>
    </ChildObjects>
  </InformationRegister>
</MetaDataObject>`,
      'utf8'
    );

    try {
      // Dimensions container
      const dimContainer: TreeNode = {
        id: 'Dimensions',
        name: 'Измерения',
        type: MetadataType.Dimension,
        properties: {},
        children: [],
        parentFilePath: parentXml,
      };
      assert.strictEqual(await provider.showProperties(dimContainer), true);
      const htmlDim = (provider as any).panel?.webview.html || '';
      assert.ok(!htmlDim.includes('error-panel'));
      assert.ok(htmlDim.includes(MESSAGES.EMPTY_STATE_NO_PROPERTIES_TITLE));

      // Resources container
      const resContainer: TreeNode = {
        id: 'Resources',
        name: 'Ресурсы',
        type: MetadataType.Resource,
        properties: {},
        children: [],
        parentFilePath: parentXml,
      };
      assert.strictEqual(await provider.showProperties(resContainer), true);
      const htmlRes = (provider as any).panel?.webview.html || '';
      assert.ok(!htmlRes.includes('error-panel'));
      assert.ok(htmlRes.includes(MESSAGES.EMPTY_STATE_NO_PROPERTIES_TITLE));

      // EnumValues container
      const enumContainer: TreeNode = {
        id: 'EnumValues',
        name: 'Значения',
        type: MetadataType.EnumValue,
        properties: {},
        children: [],
        parentFilePath: parentXml,
      };
      assert.strictEqual(await provider.showProperties(enumContainer), true);
      const htmlEnum = (provider as any).panel?.webview.html || '';
      assert.ok(!htmlEnum.includes('error-panel'));
      assert.ok(htmlEnum.includes(MESSAGES.EMPTY_STATE_NO_PROPERTIES_TITLE));

      // PredefinedData container
      const predefContainer: TreeNode = {
        id: 'PredefinedData',
        name: 'Предопределённые',
        type: MetadataType.PredefinedItem,
        properties: {},
        children: [],
        parentFilePath: parentXml,
      };
      assert.strictEqual(await provider.showProperties(predefContainer), true);
      const htmlPredef = (provider as any).panel?.webview.html || '';
      assert.ok(!htmlPredef.includes('error-panel'));
      assert.ok(htmlPredef.includes(MESSAGES.EMPTY_STATE_NO_PROPERTIES_TITLE));
    } finally {
      if (fs.existsSync(parentXml)) {
        await fs.promises.unlink(parentXml);
      }
    }
  });

  test('showProperties distinguishes TS column from colliding root-level attribute', async () => {
    const parentXml = path.join(path.dirname(tempXmlPath), `temp-root-vs-ts-${Date.now()}.xml`);
    await fs.promises.writeFile(
      parentXml,
      `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses">
  <Catalog uuid="cat-1">
    <Properties><Name>CatCollision</Name></Properties>
    <ChildObjects>
      <Attribute uuid="root-attr-uuid">
        <Properties>
          <Name>Количество</Name>
          <Comment>RootComment</Comment>
        </Properties>
      </Attribute>
      <TabularSection uuid="ts-uuid">
        <Properties><Name>Состав</Name></Properties>
        <ChildObjects>
          <Attribute uuid="ts-attr-uuid">
            <Properties>
              <Name>Количество</Name>
              <Comment>TsComment</Comment>
            </Properties>
          </Attribute>
        </ChildObjects>
      </TabularSection>
    </ChildObjects>
  </Catalog>
</MetaDataObject>`,
      'utf8'
    );

    try {
      const tsNode: TreeNode = {
        id: 'TabularSections.Состав',
        name: 'Состав',
        type: MetadataType.TabularSection,
        properties: { Name: 'Состав' },
        parentFilePath: parentXml,
      };
      const tsColsContainer: TreeNode = {
        id: 'TabularSections.Состав.Attributes',
        name: 'Реквизиты',
        type: MetadataType.Attribute,
        properties: { type: 'TabularSectionColumns' },
        parent: tsNode,
        parentFilePath: parentXml,
      };
      const colNode: TreeNode = {
        id: 'TabularSections.Состав.Количество',
        name: 'Количество',
        type: MetadataType.Attribute,
        properties: { Name: 'Количество' },
        parent: tsColsContainer,
        parentFilePath: parentXml,
      };

      const opened = await provider.showProperties(colNode);
      assert.strictEqual(opened, true);
      assert.strictEqual(colNode.properties.uuid, 'ts-attr-uuid');
      assert.strictEqual(colNode.properties.Comment, 'TsComment');
    } finally {
      if (fs.existsSync(parentXml)) {
        await fs.promises.unlink(parentXml);
      }
    }
  });

  suite('Target node isolation during in-flight Type/Source editor (#191)', () => {
    test('editType result is discarded if selected node changes while TypeEditor is open', async () => {
      const nodeA: TreeNode = {
        id: 'Attributes.AttrA',
        name: 'AttrA',
        type: MetadataType.Attribute,
        properties: {
          Name: 'AttrA',
          Type: '<Type xmlns="http://v8.1c.ru/8.1/data/core" xmlns:xs="http://www.w3.org/2001/XMLSchema"><Type>xs:string</Type></Type>',
        },
      };
      const nodeB: TreeNode = {
        id: 'Attributes.AttrB',
        name: 'AttrB',
        type: MetadataType.Attribute,
        properties: { Name: 'AttrB', Type: '<Type/>' },
      };
      const lookupModule = treeDataProvider as any;
      const originalLookup = lookupModule.getReferenceableObjectsForTypeEditor;
      const originalShow = (typeEditorProvider as any).show;
      const originalPostMessage = (provider as any).postMessage;
      const lookupStarted = createDeferredValue<void>();
      const lookupResult = createDeferredValue<any>();
      const editorStarted = createDeferredValue<void>();
      const editorResult = createDeferredValue<any>();
      const postedMessages: unknown[] = [];
      let edit: Promise<void> | undefined;

      try {
        await provider.showProperties(nodeA);
        lookupModule.getReferenceableObjectsForTypeEditor = async () => {
          lookupStarted.resolve(undefined);
          return lookupResult.promise;
        };
        (typeEditorProvider as any).show = async () => {
          editorStarted.resolve(undefined);
          return editorResult.promise;
        };
        (provider as any).postMessage = (message: unknown) => postedMessages.push(message);

        const ctx = (provider as any).buildHandlerContext() as MessageHandlerContext;
        edit = handleMessage(
          {
            type: 'editType',
            propertyName: 'Type',
            nodeId: nodeA.id,
            sessionToken: ctx.currentSessionToken,
          },
          ctx
        );
        await lookupStarted.promise;
        lookupResult.resolve([]);
        await editorStarted.promise;
        await provider.showProperties(nodeB);
        editorResult.resolve({
          category: 'primitive',
          types: [{ kind: 'date', qualifiers: { dateFractions: 'Date' } }],
        });
        await edit;

        assert.strictEqual(
          postedMessages.some((message) => (message as { type?: string }).type === 'typeUpdated'),
          false,
          'a captured A editor result must not be published into the B presentation'
        );
      } finally {
        lookupResult.resolve([]);
        editorResult.resolve(null);
        if (edit) {
          await edit.catch(() => undefined);
        }
        lookupModule.getReferenceableObjectsForTypeEditor = originalLookup;
        (typeEditorProvider as any).show = originalShow;
        (provider as any).postMessage = originalPostMessage;
      }
    });

    test('editSource result is discarded if selected node changes while ObjectTypeEditor is open', async () => {
      const nodeA: TreeNode = {
        id: 'EventSubscriptions.SubA',
        name: 'SubA',
        type: MetadataType.EventSubscription,
        properties: { Name: 'SubA', Source: '<Source/>' },
      };
      const nodeB: TreeNode = {
        id: 'EventSubscriptions.SubB',
        name: 'SubB',
        type: MetadataType.EventSubscription,
        properties: { Name: 'SubB', Source: '<Source/>' },
      };
      const lookupModule = treeDataProvider as any;
      const objectEditorProvider = (provider as any).objectTypeEditorProvider;
      const originalLookup = lookupModule.getObjectableObjectsForEditor;
      const originalShow = objectEditorProvider.show;
      const originalPostMessage = (provider as any).postMessage;
      const lookupStarted = createDeferredValue<void>();
      const lookupResult = createDeferredValue<any>();
      const editorStarted = createDeferredValue<void>();
      const editorResult = createDeferredValue<any>();
      const postedMessages: unknown[] = [];
      let edit: Promise<void> | undefined;

      try {
        await provider.showProperties(nodeA);
        lookupModule.getObjectableObjectsForEditor = async () => {
          lookupStarted.resolve(undefined);
          return lookupResult.promise;
        };
        objectEditorProvider.show = async () => {
          editorStarted.resolve(undefined);
          return editorResult.promise;
        };
        (provider as any).postMessage = (message: unknown) => postedMessages.push(message);

        const ctx = (provider as any).buildHandlerContext() as MessageHandlerContext;
        edit = handleMessage(
          {
            type: 'editSource',
            propertyName: 'Source',
            nodeId: nodeA.id,
            sessionToken: ctx.currentSessionToken,
          },
          ctx
        );
        await lookupStarted.promise;
        lookupResult.resolve([]);
        await editorStarted.promise;
        await provider.showProperties(nodeB);
        editorResult.resolve({
          types: [{ objectKind: 'CatalogObject', objectName: 'Goods' }],
        });
        await edit;

        assert.strictEqual(
          postedMessages.some((message) => (message as { type?: string }).type === 'sourceUpdated'),
          false,
          'a captured A editor result must not be published into the B presentation'
        );
      } finally {
        lookupResult.resolve([]);
        editorResult.resolve(null);
        if (edit) {
          await edit.catch(() => undefined);
        }
        lookupModule.getObjectableObjectsForEditor = originalLookup;
        objectEditorProvider.show = originalShow;
        (provider as any).postMessage = originalPostMessage;
      }
    });

    test('editType result is applied when node remains unchanged', async () => {
      const nodeA: TreeNode = {
        id: 'Attributes.AttrA',
        name: 'AttrA',
        type: MetadataType.Attribute,
        properties: {
          Name: 'AttrA',
          Type: '<Type xmlns="http://v8.1c.ru/8.1/data/core" xmlns:xs="http://www.w3.org/2001/XMLSchema"><Type>xs:string</Type></Type>',
        },
      };

      const mockTypeEditor = {
        show: async () => ({
          category: 'primitive',
          types: [{ kind: 'date', qualifiers: { dateFractions: 'Date' } }],
        }),
      } as unknown as TypeEditorProvider;

      const postedMessages: any[] = [];
      const ctx: MessageHandlerContext = {
        currentNode: nodeA,
        currentFormSelection: null,
        currentFormSelectionRevision: 0,
        currentSessionToken: 'session-node-A',
        isSaving: false,
        treeDataProvider: {
          getReferenceableObjectsForTypeEditor: async () => [],
        } as any,
        typeEditorProvider: mockTypeEditor,
        objectTypeEditorProvider: {} as any,
        postMessage: (msg) => postedMessages.push(msg),
        updateWebviewContent: () => {},
        setIsSaving: () => {},
      };

      await handleMessage(
        {
          type: 'editType',
          propertyName: 'Type',
          nodeId: 'Attributes.AttrA',
          sessionToken: 'session-node-A',
        },
        ctx
      );

      const typeUpdated = postedMessages.find((m) => m.type === 'typeUpdated');
      assert.ok(typeUpdated, 'typeUpdated message must be posted');
      assert.strictEqual(typeUpdated.nodeId, 'Attributes.AttrA');
      assert.strictEqual(typeUpdated.sessionToken, 'session-node-A');
    });

    test('editSource result is applied when node remains unchanged', async () => {
      const nodeA: TreeNode = {
        id: 'EventSubscriptions.SubA',
        name: 'SubA',
        type: MetadataType.EventSubscription,
        properties: { Name: 'SubA', Source: '<Source/>' },
      };

      const mockObjectTypeEditor = {
        show: async () => ({
          types: [{ objectKind: 'CatalogObject', objectName: 'Goods' }],
        }),
      } as any;

      const postedMessages: any[] = [];
      const ctx: MessageHandlerContext = {
        currentNode: nodeA,
        currentFormSelection: null,
        currentFormSelectionRevision: 0,
        currentSessionToken: 'session-node-A',
        isSaving: false,
        treeDataProvider: {
          getObjectableObjectsForEditor: async () => [],
        } as any,
        typeEditorProvider: {} as any,
        objectTypeEditorProvider: mockObjectTypeEditor,
        postMessage: (msg) => postedMessages.push(msg),
        updateWebviewContent: () => {},
        setIsSaving: () => {},
      };

      await handleMessage(
        {
          type: 'editSource',
          propertyName: 'Source',
          nodeId: 'EventSubscriptions.SubA',
          sessionToken: 'session-node-A',
        },
        ctx
      );

      const sourceUpdated = postedMessages.find((m) => m.type === 'sourceUpdated');
      assert.ok(sourceUpdated, 'sourceUpdated message must be posted');
      assert.strictEqual(sourceUpdated.nodeId, 'EventSubscriptions.SubA');
      assert.strictEqual(sourceUpdated.sessionToken, 'session-node-A');
    });

    test('slow getReferenceableObjects lookup for Node A does not invoke typeEditorProvider.show if switched to Node B', async () => {
      const nodeA: TreeNode = {
        id: 'Attributes.AttrA',
        name: 'AttrA',
        type: MetadataType.Attribute,
        properties: { Name: 'AttrA', Type: '<Type/>' },
      };
      const nodeB: TreeNode = {
        id: 'Attributes.AttrB',
        name: 'AttrB',
        type: MetadataType.Attribute,
        properties: { Name: 'AttrB', Type: '<Type/>' },
      };
      const lookupModule = treeDataProvider as any;
      const originalLookup = lookupModule.getReferenceableObjectsForTypeEditor;
      const originalShow = (typeEditorProvider as any).show;
      const lookupStarted = createDeferredValue<void>();
      const lookupResult = createDeferredValue<any>();
      let typeEditorShowCalled = false;
      let edit: Promise<void> | undefined;

      try {
        await provider.showProperties(nodeA);
        lookupModule.getReferenceableObjectsForTypeEditor = async () => {
          lookupStarted.resolve(undefined);
          return lookupResult.promise;
        };
        (typeEditorProvider as any).show = async () => {
          typeEditorShowCalled = true;
          return null;
        };

        const ctx = (provider as any).buildHandlerContext() as MessageHandlerContext;
        edit = handleMessage(
          {
            type: 'editType',
            propertyName: 'Type',
            nodeId: nodeA.id,
            sessionToken: ctx.currentSessionToken,
          },
          ctx
        );
        await lookupStarted.promise;
        await provider.showProperties(nodeB);
        lookupResult.resolve([]);
        await edit;

        assert.strictEqual(
          typeEditorShowCalled,
          false,
          'the real captured A context must stop before opening its editor after public navigation to B'
        );
      } finally {
        lookupResult.resolve([]);
        if (edit) {
          await edit.catch(() => undefined);
        }
        lookupModule.getReferenceableObjectsForTypeEditor = originalLookup;
        (typeEditorProvider as any).show = originalShow;
      }
    });

    test('slow getObjectableObjects lookup for Node A does not invoke objectTypeEditorProvider.show if switched to Node B', async () => {
      const nodeA: TreeNode = {
        id: 'EventSubscriptions.SubA',
        name: 'SubA',
        type: MetadataType.EventSubscription,
        properties: { Name: 'SubA', Source: '<Source/>' },
      };
      const nodeB: TreeNode = {
        id: 'EventSubscriptions.SubB',
        name: 'SubB',
        type: MetadataType.EventSubscription,
        properties: { Name: 'SubB', Source: '<Source/>' },
      };
      const lookupModule = treeDataProvider as any;
      const originalLookup = lookupModule.getObjectableObjectsForEditor;
      const objectEditorProvider = (provider as any).objectTypeEditorProvider;
      const originalShow = objectEditorProvider.show;
      const lookupStarted = createDeferredValue<void>();
      const lookupResult = createDeferredValue<any>();
      let objectEditorShowCalled = false;
      let edit: Promise<void> | undefined;

      try {
        await provider.showProperties(nodeA);
        lookupModule.getObjectableObjectsForEditor = async () => {
          lookupStarted.resolve(undefined);
          return lookupResult.promise;
        };
        objectEditorProvider.show = async () => {
          objectEditorShowCalled = true;
          return null;
        };

        const ctx = (provider as any).buildHandlerContext() as MessageHandlerContext;
        edit = handleMessage(
          {
            type: 'editSource',
            propertyName: 'Source',
            nodeId: nodeA.id,
            sessionToken: ctx.currentSessionToken,
          },
          ctx
        );
        await lookupStarted.promise;
        await provider.showProperties(nodeB);
        lookupResult.resolve([]);
        await edit;

        assert.strictEqual(
          objectEditorShowCalled,
          false,
          'the real captured A context must stop before opening its editor after public navigation to B'
        );
      } finally {
        lookupResult.resolve([]);
        if (edit) {
          await edit.catch(() => undefined);
        }
        lookupModule.getObjectableObjectsForEditor = originalLookup;
        objectEditorProvider.show = originalShow;
      }
    });

    test('reverse completion order: slow lookup A resolving after fast lookup B does not overwrite or show editor A', async () => {
      const nodeA: TreeNode = {
        id: 'Attributes.AttrA',
        name: 'AttrA',
        type: MetadataType.Attribute,
        properties: { Name: 'AttrA', Type: '<Type/>' },
      };
      const nodeB: TreeNode = {
        id: 'Attributes.AttrB',
        name: 'AttrB',
        type: MetadataType.Attribute,
        properties: { Name: 'AttrB', Type: '<Type/>' },
      };

      const lookupModule = treeDataProvider as any;
      const originalLookup = lookupModule.getReferenceableObjectsForTypeEditor;
      const originalShow = (typeEditorProvider as any).show;
      const lookupAStarted = createDeferredValue<void>();
      const lookupA = createDeferredValue<any>();
      const shownXmls: string[] = [];
      let editA: Promise<void> | undefined;
      let editB: Promise<void> | undefined;

      try {
        await provider.showProperties(nodeA);
        lookupModule.getReferenceableObjectsForTypeEditor = async (node: TreeNode) => {
          if (node === nodeA) {
            lookupAStarted.resolve(undefined);
            return lookupA.promise;
          }
          return [];
        };
        (typeEditorProvider as any).show = async (xml: string) => {
          shownXmls.push(xml);
          return null;
        };

        const ctxA = (provider as any).buildHandlerContext() as MessageHandlerContext;
        editA = handleMessage(
          {
            type: 'editType',
            propertyName: 'Type',
            nodeId: nodeA.id,
            sessionToken: ctxA.currentSessionToken,
          },
          ctxA
        );
        await lookupAStarted.promise;

        await provider.showProperties(nodeB);
        const ctxB = (provider as any).buildHandlerContext() as MessageHandlerContext;
        editB = handleMessage(
          {
            type: 'editType',
            propertyName: 'Type',
            nodeId: nodeB.id,
            sessionToken: ctxB.currentSessionToken,
          },
          ctxB
        );
        await editB;
        assert.deepStrictEqual(shownXmls, ['<Type/>'], 'only the active B editor should be shown first');

        lookupA.resolve([]);
        await editA;

        assert.deepStrictEqual(
          shownXmls,
          ['<Type/>'],
          'the old A lookup must not open its editor after the real provider has navigated to B'
        );
      } finally {
        lookupA.resolve([]);
        if (editA) {
          await editA.catch(() => undefined);
        }
        if (editB) {
          await editB.catch(() => undefined);
        }
        lookupModule.getReferenceableObjectsForTypeEditor = originalLookup;
        (typeEditorProvider as any).show = originalShow;
      }
    });

    test('parseDisplayTypeString parses numeric and string qualifiers correctly', () => {
      const numType = parseDisplayTypeString('Number(15,2)');
      assert.strictEqual(numType?.category, 'primitive');
      assert.deepStrictEqual(numType?.types[0].qualifiers, {
        digits: 15,
        fractionDigits: 2,
        allowedSign: 'Any',
      });

      const strType = parseDisplayTypeString('String(50)');
      assert.strictEqual(strType?.category, 'primitive');
      assert.deepStrictEqual(strType?.types[0].qualifiers, {
        length: 50,
        allowedLength: 'Variable',
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Issue #379: async navigation ownership and dirty-guard session isolation
// ---------------------------------------------------------------------------

interface DeferredValue<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function createDeferredValue<T>(): DeferredValue<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function formParseResultWithHandler(handlerName: string): Record<string, unknown> {
  return {
    model: {
      childItemsRoot: [],
      attributes: [],
      commands: [],
      formEvents: [{ name: 'OnOpen', method: handlerName }],
    },
  };
}

suite('PropertiesProvider — Issue #379 async navigation ownership', () => {
  let provider: PropertiesProvider;
  let mockContext: vscode.ExtensionContext;
  let defaultShowWarningMessage: any;
  let defaultCreateWebviewPanel: any;
  let tempXmlA: string;
  let tempXmlB: string;
  let tempXmlC: string;
  let mockHtml: string;
  let postedMessages: unknown[];
  let panelCreateCount: number;
  let panelDidDispose: (() => void) | undefined;

  setup(() => {
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
    provider = new PropertiesProvider(
      mockContext,
      new MetadataTreeDataProvider(),
      new TypeEditorProvider(mockContext)
    );

    defaultShowWarningMessage = vscode.window.showWarningMessage;
    defaultCreateWebviewPanel = vscode.window.createWebviewPanel;
    mockHtml = '';
    postedMessages = [];
    panelCreateCount = 0;
    panelDidDispose = undefined;

    (vscode.window as any).createWebviewPanel = () => {
      panelCreateCount += 1;
      return {
        webview: {
          get html(): string { return mockHtml; },
          set html(value: string) { mockHtml = value; },
          onDidReceiveMessage: () => ({ dispose: () => undefined }),
          postMessage: async (message: unknown) => {
            postedMessages.push(message);
            return true;
          },
          asWebviewUri: (uri: vscode.Uri) => uri,
          cspSource: 'https://test',
        },
        onDidDispose: (callback: () => void) => {
          panelDidDispose = callback;
          return { dispose: () => undefined };
        },
        reveal: () => undefined,
        dispose: () => undefined,
      };
    };
    const fixturesPath = path.join(__dirname, '../../../test/fixtures');
    const testXmlPath = path.join(fixturesPath, 'test-properties.xml');
    const uniqueId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    tempXmlA = path.join(fixturesPath, `temp-issue379-a-${uniqueId}.xml`);
    tempXmlB = path.join(fixturesPath, `temp-issue379-b-${uniqueId}.xml`);
    tempXmlC = path.join(fixturesPath, `temp-issue379-c-${uniqueId}.xml`);
    fs.copyFileSync(testXmlPath, tempXmlA);
    fs.copyFileSync(testXmlPath, tempXmlB);
    fs.copyFileSync(testXmlPath, tempXmlC);
  });

  teardown(() => {
    provider.dispose();
    (vscode.window as any).showWarningMessage = defaultShowWarningMessage;
    (vscode.window as any).createWebviewPanel = defaultCreateWebviewPanel;
    for (const tempFile of [tempXmlA, tempXmlB, tempXmlC]) {
      if (tempFile && fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    }
  });

  test('late Form parse result cannot replace the active same-id form across A to B to A navigation', async () => {
    const formNodeA: TreeNode = {
      id: 'Forms.Shared',
      name: 'SharedA',
      type: MetadataType.Form,
      properties: {},
      filePath: path.join(path.resolve('config-root-a'), 'Forms', 'Shared.xml'),
    };
    const formNodeB: TreeNode = {
      id: 'Forms.Shared',
      name: 'SharedB',
      type: MetadataType.Form,
      properties: {},
      filePath: path.join(path.resolve('config-root-b'), 'Forms', 'Shared.xml'),
    };
    assert.notStrictEqual(formNodeA, formNodeB);
    assert.strictEqual(formNodeA.id, formNodeB.id);
    assert.notStrictEqual(path.dirname(formNodeA.filePath!), path.dirname(formNodeB.filePath!));

    const parser = await import('../../src/formEditor/formXmlParser');
    const originalParseFormXml = parser.parseFormXml;
    const firstAStarted = createDeferredValue<void>();
    const firstA = createDeferredValue<any>();
    let parseACount = 0;
    let firstNavigation: Promise<boolean> | undefined;

    try {
      (parser as any).parseFormXml = async (formXmlPath: string) => {
        if (formXmlPath.includes('config-root-a')) {
          parseACount += 1;
          if (parseACount === 1) {
            firstAStarted.resolve(undefined);
            return firstA.promise;
          }
          return formParseResultWithHandler('LatestAHandler');
        }
        return formParseResultWithHandler('RootBHandler');
      };

      firstNavigation = provider.showProperties(formNodeA);
      await firstAStarted.promise;

      await provider.showProperties(formNodeB);
      assert.ok(mockHtml.includes('config-root-b'), 'the second root should be visible while A is still parsing');
      assert.ok(mockHtml.includes('RootBHandler'));

      await provider.showProperties(formNodeA);
      assert.ok(mockHtml.includes('LatestAHandler'), 'the latest A navigation should display its own parse result');

      firstA.resolve(formParseResultWithHandler('StaleAHandler'));
      await firstNavigation;

      assert.ok(mockHtml.includes('LatestAHandler'), 'the older A parse must not replace the latest A panel');
      assert.ok(!mockHtml.includes('StaleAHandler'), 'the stale parse result must not be published');
    } finally {
      firstA.resolve(formParseResultWithHandler('CleanupAHandler'));
      if (firstNavigation) {
        await firstNavigation.catch(() => false);
      }
      (parser as any).parseFormXml = originalParseFormXml;
    }
  });

  test('updateIfOpen on the same Form node preserves its pending successful presentation', async () => {
    const node: TreeNode = {
      id: 'Forms.Pending',
      name: 'PendingForm',
      type: MetadataType.Form,
      properties: {},
      filePath: tempXmlA,
    };
    const parser = await import('../../src/formEditor/formXmlParser');
    const originalParseFormXml = parser.parseFormXml;
    const parseStarted = createDeferredValue<void>();
    const parseResult = createDeferredValue<any>();
    let navigation: Promise<boolean> | undefined;

    try {
      (parser as any).parseFormXml = async () => {
        parseStarted.resolve(undefined);
        return parseResult.promise;
      };

      navigation = provider.showProperties(node);
      await parseStarted.promise;

      const refresh = provider.updateIfOpen(node);
      parseResult.resolve(formParseResultWithHandler('SameNodeUpdateHandler'));
      await refresh;
      await navigation;

      assert.ok(
        mockHtml.includes('SameNodeUpdateHandler'),
        'a same-node refresh must not strand the Form presentation already in progress'
      );
    } finally {
      parseResult.resolve(formParseResultWithHandler('CleanupSameNodeUpdateHandler'));
      if (navigation) {
        await navigation.catch(() => false);
      }
      (parser as any).parseFormXml = originalParseFormXml;
    }
  });

  test('updateIfOpen on the same Form node preserves fallback after a pending parse error', async () => {
    const node: TreeNode = {
      id: 'Forms.Pending',
      name: 'PendingForm',
      type: MetadataType.Form,
      properties: {},
      filePath: tempXmlA,
    };
    const parser = await import('../../src/formEditor/formXmlParser');
    const writerModule = await import('../../src/utils/XMLWriter');
    const originalParseFormXml = parser.parseFormXml;
    const originalReadProperties = writerModule.XMLWriter.readProperties;
    const parseStarted = createDeferredValue<void>();
    const parseResult = createDeferredValue<any>();
    let navigation: Promise<boolean> | undefined;

    try {
      (parser as any).parseFormXml = async () => {
        parseStarted.resolve(undefined);
        return parseResult.promise;
      };
      (writerModule.XMLWriter as any).readProperties = async () => ({
        Name: 'RecoveredAfterSameNodeUpdate',
      });

      navigation = provider.showProperties(node);
      await parseStarted.promise;

      const refresh = provider.updateIfOpen(node);
      parseResult.resolve({ error: 'Malformed Form.xml' });
      await refresh;
      await navigation;

      assert.strictEqual(node.properties.Name, 'RecoveredAfterSameNodeUpdate');
      assert.ok(
        mockHtml.includes('RecoveredAfterSameNodeUpdate'),
        'a same-node refresh must not suppress the regular properties fallback after a parse error'
      );
    } finally {
      parseResult.resolve({ error: 'cleanup parse result' });
      if (navigation) {
        await navigation.catch(() => false);
      }
      (parser as any).parseFormXml = originalParseFormXml;
      (writerModule.XMLWriter as any).readProperties = originalReadProperties;
    }
  });

  test('repeated showProperties on a pending Form node publishes the latest successful parse', async () => {
    const node: TreeNode = {
      id: 'Forms.Pending',
      name: 'PendingForm',
      type: MetadataType.Form,
      properties: {},
      filePath: tempXmlA,
    };
    const parser = await import('../../src/formEditor/formXmlParser');
    const originalParseFormXml = parser.parseFormXml;
    const firstParseStarted = createDeferredValue<void>();
    const firstParse = createDeferredValue<any>();
    let parseCount = 0;
    let firstNavigation: Promise<boolean> | undefined;
    let latestNavigation: Promise<boolean> | undefined;

    try {
      (parser as any).parseFormXml = async () => {
        parseCount += 1;
        if (parseCount === 1) {
          firstParseStarted.resolve(undefined);
          return firstParse.promise;
        }
        return formParseResultWithHandler('LatestRepeatedShowHandler');
      };

      firstNavigation = provider.showProperties(node);
      await firstParseStarted.promise;
      latestNavigation = provider.showProperties(node);
      await latestNavigation;

      assert.ok(mockHtml.includes('LatestRepeatedShowHandler'));
      firstParse.resolve(formParseResultWithHandler('StaleRepeatedShowHandler'));
      await firstNavigation;

      assert.ok(mockHtml.includes('LatestRepeatedShowHandler'));
      assert.ok(!mockHtml.includes('StaleRepeatedShowHandler'));
    } finally {
      firstParse.resolve(formParseResultWithHandler('CleanupRepeatedShowHandler'));
      if (firstNavigation) {
        await firstNavigation.catch(() => false);
      }
      if (latestNavigation) {
        await latestNavigation.catch(() => false);
      }
      (parser as any).parseFormXml = originalParseFormXml;
    }
  });

  test('repeated showProperties on a pending Form node preserves fallback after the latest parse errors', async () => {
    const node: TreeNode = {
      id: 'Forms.Pending',
      name: 'PendingForm',
      type: MetadataType.Form,
      properties: {},
      filePath: tempXmlA,
    };
    const parser = await import('../../src/formEditor/formXmlParser');
    const writerModule = await import('../../src/utils/XMLWriter');
    const originalParseFormXml = parser.parseFormXml;
    const originalReadProperties = writerModule.XMLWriter.readProperties;
    const firstParseStarted = createDeferredValue<void>();
    const firstParse = createDeferredValue<any>();
    let parseCount = 0;
    let fallbackReadCount = 0;
    let firstNavigation: Promise<boolean> | undefined;
    let latestNavigation: Promise<boolean> | undefined;

    try {
      (parser as any).parseFormXml = async () => {
        parseCount += 1;
        if (parseCount === 1) {
          firstParseStarted.resolve(undefined);
          return firstParse.promise;
        }
        return { error: 'Malformed latest Form.xml' };
      };
      (writerModule.XMLWriter as any).readProperties = async () => {
        fallbackReadCount += 1;
        return { Name: 'LatestRepeatedShowFallback' };
      };

      firstNavigation = provider.showProperties(node);
      await firstParseStarted.promise;
      latestNavigation = provider.showProperties(node);
      await latestNavigation;

      assert.strictEqual(fallbackReadCount, 1, 'the active parse error should use the ordinary properties fallback');
      assert.ok(mockHtml.includes('LatestRepeatedShowFallback'));

      firstParse.resolve(formParseResultWithHandler('StaleAfterRepeatedShowErrorHandler'));
      await firstNavigation;

      assert.ok(mockHtml.includes('LatestRepeatedShowFallback'));
      assert.ok(!mockHtml.includes('StaleAfterRepeatedShowErrorHandler'));
    } finally {
      firstParse.resolve(formParseResultWithHandler('CleanupRepeatedShowErrorHandler'));
      if (firstNavigation) {
        await firstNavigation.catch(() => false);
      }
      if (latestNavigation) {
        await latestNavigation.catch(() => false);
      }
      (parser as any).parseFormXml = originalParseFormXml;
      (writerModule.XMLWriter as any).readProperties = originalReadProperties;
    }
  });

  test('late Form metadata read error cannot replace a newer A navigation', async () => {
    const nodeA: TreeNode = {
      id: 'Forms.Shared',
      name: 'SharedA',
      type: MetadataType.Form,
      properties: {},
      filePath: tempXmlA,
    };
    const nodeB: TreeNode = {
      id: 'Forms.Other',
      name: 'CatalogB',
      type: MetadataType.Catalog,
      properties: { Name: 'CatalogB' },
      filePath: tempXmlB,
    };

    const parser = await import('../../src/formEditor/formXmlParser');
    const writerModule = await import('../../src/utils/XMLWriter');
    const originalParseFormXml = parser.parseFormXml;
    const originalReadProperties = writerModule.XMLWriter.readProperties;
    const firstParseStarted = createDeferredValue<void>();
    const firstParse = createDeferredValue<any>();
    const secondParseStarted = createDeferredValue<void>();
    const secondParse = createDeferredValue<any>();
    const firstReadStarted = createDeferredValue<void>();
    const firstRead = createDeferredValue<Record<string, unknown>>();
    let parseCount = 0;
    let readDeferred = false;
    let firstNavigation: Promise<boolean> | undefined;
    let latestNavigation: Promise<boolean> | undefined;

    try {
      (parser as any).parseFormXml = async () => {
        parseCount += 1;
        if (parseCount === 1) {
          firstParseStarted.resolve(undefined);
          return firstParse.promise;
        }
        secondParseStarted.resolve(undefined);
        return secondParse.promise;
      };
      (writerModule.XMLWriter as any).readProperties = async (filePath: string, ...args: unknown[]) => {
        if (filePath === nodeA.filePath && !readDeferred) {
          readDeferred = true;
          firstReadStarted.resolve(undefined);
          return firstRead.promise;
        }
        return (originalReadProperties as (...values: unknown[]) => Promise<unknown>).apply(
          writerModule.XMLWriter,
          [filePath, ...args]
        );
      };

      firstNavigation = provider.showProperties(nodeA);
      await firstParseStarted.promise;
      firstParse.resolve({ error: 'Malformed Form.xml' });
      await firstReadStarted.promise;

      await provider.showProperties(nodeB);
      assert.ok(mockHtml.includes('CatalogB'));

      latestNavigation = provider.showProperties(nodeA);
      await secondParseStarted.promise;
      firstRead.reject(new Error('stale Form metadata read failed'));
      await firstNavigation;

      assert.ok(mockHtml.includes('CatalogB'), 'an old error must not replace the panel while the newer A parse is pending');
      assert.ok(!mockHtml.includes('Failed to read properties from file'));

      secondParse.resolve(formParseResultWithHandler('LatestAHandler'));
      await latestNavigation;
      assert.ok(mockHtml.includes('LatestAHandler'));
    } finally {
      if (!readDeferred) {
        firstParse.resolve({ error: 'cleanup parse result' });
        await firstReadStarted.promise;
      }
      firstRead.reject(new Error('cleanup read failure'));
      secondParse.resolve(formParseResultWithHandler('CleanupAHandler'));
      if (firstNavigation) {
        await firstNavigation.catch(() => false);
      }
      if (latestNavigation) {
        await latestNavigation.catch(() => false);
      }
      (parser as any).parseFormXml = originalParseFormXml;
      (writerModule.XMLWriter as any).readProperties = originalReadProperties;
    }
  });

  for (const resolutionOrder of ['older-first', 'newer-first'] as const) {
    for (const olderChoice of [MESSAGES.SAVE, MESSAGES.DONT_SAVE, MESSAGES.CANCEL]) {
      test(`an older ${olderChoice} dialog cannot overtake a newer navigation (${resolutionOrder})`, async () => {
        const nodeA: TreeNode = {
          id: 'node-a',
          name: 'CatalogA',
          type: MetadataType.Catalog,
          properties: { Name: 'CatalogA' },
          filePath: tempXmlA,
        };
        const nodeB: TreeNode = {
          id: 'node-b',
          name: 'CatalogB',
          type: MetadataType.Catalog,
          properties: { Name: 'CatalogB' },
          filePath: tempXmlB,
        };
        const nodeC: TreeNode = {
          id: 'node-c',
          name: 'CatalogC',
          type: MetadataType.Catalog,
          properties: { Name: 'CatalogC' },
          filePath: tempXmlC,
        };
        const dialogs: Array<DeferredValue<any>> = [];
        let olderNavigation: Promise<boolean> | undefined;
        let newerNavigation: Promise<boolean> | undefined;
        (vscode.window as any).showWarningMessage = () => {
          const dialog = createDeferredValue<any>();
          dialogs.push(dialog);
          return dialog.promise;
        };

        try {
          await provider.showProperties(nodeA);
          provider.setIsDirty(true, { Synonym: 'PendingA' });
          olderNavigation = provider.showProperties(nodeB);
          newerNavigation = provider.showProperties(nodeC);
          assert.strictEqual(dialogs.length, 2, 'both navigation intents should be waiting on their own dialog result');

          if (resolutionOrder === 'older-first') {
            provider.setIsDirty(true, { Synonym: 'NewerPendingA' });
            dialogs[0].resolve(olderChoice);
            await olderNavigation;
            assert.strictEqual((provider as any).currentNode, nodeA, 'the stale decision must not navigate to B');
            assert.strictEqual(provider.isDirty(), true, 'the stale decision must preserve newer A edits');
            assert.strictEqual((provider as any).pendingProperties?.Synonym, 'NewerPendingA');

            dialogs[1].resolve(MESSAGES.CANCEL);
            await newerNavigation;
            assert.strictEqual((provider as any).currentNode, nodeA, 'cancelling the newest intent should leave A selected');
            assert.strictEqual(provider.isDirty(), true);
            assert.strictEqual((provider as any).pendingProperties?.Synonym, 'NewerPendingA');
          } else {
            dialogs[1].resolve(MESSAGES.DONT_SAVE);
            await newerNavigation;
            assert.strictEqual((provider as any).currentNode, nodeC, 'the newest intent should reach C');
            provider.setIsDirty(true, { Synonym: 'PendingC' });

            dialogs[0].resolve(olderChoice);
            await olderNavigation;
            assert.strictEqual((provider as any).currentNode, nodeC, 'the late decision must not navigate back to B');
            assert.strictEqual(provider.isDirty(), true, 'the late decision must preserve edits in C');
            assert.strictEqual((provider as any).pendingProperties?.Synonym, 'PendingC');
            assert.strictEqual(
              fs.readFileSync(tempXmlC, 'utf8'),
              fs.readFileSync(path.join(__dirname, '../../../test/fixtures/test-properties.xml'), 'utf8'),
              'an older Save decision must not save the newly active C session'
            );
          }
        } finally {
          for (const dialog of dialogs) {
            dialog.resolve(MESSAGES.CANCEL);
          }
          if (olderNavigation) {
            await olderNavigation.catch(() => false);
          }
          if (newerNavigation) {
            await newerNavigation.catch(() => false);
          }
        }
      });
    }
  }

  for (const choice of [MESSAGES.SAVE, MESSAGES.DONT_SAVE]) {
    test(`a ${choice} decision cannot consume edits made after its dirty prompt opened`, async () => {
      const nodeA: TreeNode = {
        id: 'node-a',
        name: 'CatalogA',
        type: MetadataType.Catalog,
        properties: { Name: 'CatalogA' },
        filePath: tempXmlA,
      };
      const nodeB: TreeNode = {
        id: 'node-b',
        name: 'CatalogB',
        type: MetadataType.Catalog,
        properties: { Name: 'CatalogB' },
        filePath: tempXmlB,
      };
      const dialog = createDeferredValue<any>();
      (vscode.window as any).showWarningMessage = () => dialog.promise;
      let navigation: Promise<boolean> | undefined;

      try {
        await provider.showProperties(nodeA);
        provider.setIsDirty(true, { Synonym: 'First edit' });
        const before = fs.readFileSync(tempXmlA, 'utf8');
        navigation = provider.showProperties(nodeB);
        provider.setIsDirty(true, { Synonym: 'Newer edit' });

        dialog.resolve(choice);
        await navigation;

        assert.strictEqual((provider as any).currentNode, nodeA, 'navigation must remain pending for the newer edit');
        assert.strictEqual(provider.isDirty(), true, 'the newer edit must remain dirty');
        assert.strictEqual((provider as any).pendingProperties?.Synonym, 'Newer edit');
        assert.strictEqual(fs.readFileSync(tempXmlA, 'utf8'), before, 'an old choice must not save newer edits');
      } finally {
        dialog.resolve(MESSAGES.CANCEL);
        if (navigation) {
          await navigation.catch(() => false);
        }
      }
    });
  }

  test('a late Save completion does not publish into or clear a newer dirty session', async () => {
    const nodeA: TreeNode = {
      id: 'node-a',
      name: 'CatalogA',
      type: MetadataType.Catalog,
      properties: { Name: 'CatalogA' },
      filePath: tempXmlA,
    };
    const nodeB: TreeNode = {
      id: 'node-b',
      name: 'CatalogB',
      type: MetadataType.Catalog,
      properties: { Name: 'CatalogB' },
      filePath: tempXmlB,
    };
    const nodeC: TreeNode = {
      id: 'node-c',
      name: 'CatalogC',
      type: MetadataType.Catalog,
      properties: { Name: 'CatalogC' },
      filePath: tempXmlC,
    };
    const dialogs: Array<DeferredValue<any>> = [];
    (vscode.window as any).showWarningMessage = () => {
      const dialog = createDeferredValue<any>();
      dialogs.push(dialog);
      return dialog.promise;
    };
    await provider.showProperties(nodeA);
    provider.setIsDirty(true, { Synonym: 'SavedA' });

    const writerModule = await import('../../src/utils/XMLWriter');
    const originalWriteProperties = writerModule.XMLWriter.writeProperties;
    const writeStarted = createDeferredValue<void>();
    const releaseWrite = createDeferredValue<void>();
    (writerModule.XMLWriter as any).writeProperties = async (...args: unknown[]) => {
      writeStarted.resolve(undefined);
      await releaseWrite.promise;
      return (originalWriteProperties as (...values: unknown[]) => Promise<unknown>).apply(
        writerModule.XMLWriter,
        args
      );
    };

    let olderNavigation: Promise<boolean> | undefined;
    let newerNavigation: Promise<boolean> | undefined;
    try {
      olderNavigation = provider.showProperties(nodeB);
      assert.strictEqual(dialogs.length, 1);
      dialogs[0].resolve(MESSAGES.SAVE);
      await writeStarted.promise;

      newerNavigation = provider.showProperties(nodeC);
      assert.strictEqual(dialogs.length, 2);
      dialogs[1].resolve(MESSAGES.DONT_SAVE);
      await newerNavigation;
      provider.setIsDirty(true, { Synonym: 'NewerC' });

      releaseWrite.resolve(undefined);
      await olderNavigation;

      assert.strictEqual((provider as any).currentNode, nodeC, 'the old navigation must not replace C after Save completes');
      assert.strictEqual(provider.isDirty(), true, 'the old save acknowledgement must not clear C dirty state');
      assert.strictEqual((provider as any).pendingProperties?.Synonym, 'NewerC');
      assert.strictEqual((nodeA.properties as Record<string, unknown>).Synonym, 'SavedA', 'the captured A save should finish');
      assert.strictEqual(
        postedMessages.some((message) => (message as { type?: string }).type === 'saved'),
        false,
        'the completed A save must not acknowledge success in the current C webview'
      );
    } finally {
      for (const dialog of dialogs) {
        dialog.resolve(MESSAGES.CANCEL);
      }
      releaseWrite.resolve(undefined);
      if (olderNavigation) {
        await olderNavigation.catch(() => false);
      }
      if (newerNavigation) {
        await newerNavigation.catch(() => false);
      }
      (writerModule.XMLWriter as any).writeProperties = originalWriteProperties;
    }
  });

  test('a late captured Save success does not acknowledge the newer presentation', async () => {
    const nodeA: TreeNode = {
      id: 'node-a',
      name: 'CatalogA',
      type: MetadataType.Catalog,
      properties: { Name: 'CatalogA', Synonym: 'OriginalA' },
      filePath: tempXmlA,
    };
    const nodeB: TreeNode = {
      id: 'node-b',
      name: 'CatalogB',
      type: MetadataType.Catalog,
      properties: { Name: 'CatalogB', Synonym: 'OriginalB' },
      filePath: tempXmlB,
    };
    const writerModule = await import('../../src/utils/XMLWriter');
    const originalWriteProperties = writerModule.XMLWriter.writeProperties;
    const originalShowInformationMessage = vscode.window.showInformationMessage;
    const writeStarted = createDeferredValue<void>();
    const releaseWrite = createDeferredValue<void>();
    const informationMessages: unknown[] = [];
    (vscode.window as any).showWarningMessage = async () => MESSAGES.DONT_SAVE;
    (vscode.window as any).showInformationMessage = (message: unknown) => {
      informationMessages.push(message);
      return Promise.resolve(undefined);
    };
    (writerModule.XMLWriter as any).writeProperties = async (...args: unknown[]) => {
      writeStarted.resolve(undefined);
      await releaseWrite.promise;
      return (originalWriteProperties as (...values: unknown[]) => Promise<unknown>).apply(
        writerModule.XMLWriter,
        args
      );
    };

    let save: Promise<void> | undefined;
    let newerContext: MessageHandlerContext | undefined;
    let newerSaveGeneration: number | undefined;
    try {
      await provider.showProperties(nodeA);
      provider.setIsDirty(true, { Synonym: 'SavedA' });
      const ctx = (provider as any).buildHandlerContext() as MessageHandlerContext;
      save = handleMessage(
        {
          type: 'save',
          nodeId: nodeA.id,
          sessionToken: ctx.currentSessionToken,
          properties: { Synonym: 'SavedA' },
        },
        ctx
      );
      await writeStarted.promise;

      await provider.showProperties(nodeB);
      provider.setIsDirty(true, { Synonym: 'PendingB' });
      newerContext = (provider as any).buildHandlerContext() as MessageHandlerContext;
      newerSaveGeneration = newerContext.beginSave?.();
      assert.notStrictEqual(newerSaveGeneration, undefined, 'the current B session can start its own save window');
      releaseWrite.resolve(undefined);
      await save;

      assert.strictEqual(nodeA.properties.Synonym, 'SavedA', 'the captured A mutation may finish');
      assert.strictEqual((provider as any).currentNode, nodeB);
      assert.strictEqual(provider.isDirty(), true, 'the late A acknowledgement must preserve B edits');
      assert.strictEqual((provider as any).pendingProperties?.Synonym, 'PendingB');
      assert.strictEqual(
        postedMessages.some((message) => (message as { type?: string }).type === 'saved'),
        false,
        'the captured save must not acknowledge success in B'
      );
      assert.strictEqual(
        informationMessages.includes(MESSAGES.SAVE_SUCCESS),
        false,
        'the captured save must not show a success notification after B becomes current'
      );
      assert.strictEqual((provider as any)._isSaving, true, 'the older A completion must not clear B save tracking');
    } finally {
      releaseWrite.resolve(undefined);
      if (save) {
        await save.catch(() => undefined);
      }
      if (newerSaveGeneration !== undefined) {
        newerContext?.endSave?.(newerSaveGeneration, 0);
      }
      (writerModule.XMLWriter as any).writeProperties = originalWriteProperties;
      (vscode.window as any).showWarningMessage = defaultShowWarningMessage;
      (vscode.window as any).showInformationMessage = originalShowInformationMessage;
    }
  });

  test('a late captured Save failure does not show an error in the newer presentation', async () => {
    const nodeA: TreeNode = {
      id: 'node-a',
      name: 'CatalogA',
      type: MetadataType.Catalog,
      properties: { Name: 'CatalogA', Synonym: 'OriginalA' },
      filePath: tempXmlA,
    };
    const nodeB: TreeNode = {
      id: 'node-b',
      name: 'CatalogB',
      type: MetadataType.Catalog,
      properties: { Name: 'CatalogB', Synonym: 'OriginalB' },
      filePath: tempXmlB,
    };
    const writerModule = await import('../../src/utils/XMLWriter');
    const originalWriteProperties = writerModule.XMLWriter.writeProperties;
    const originalShowErrorMessage = vscode.window.showErrorMessage;
    const writeStarted = createDeferredValue<void>();
    const releaseWrite = createDeferredValue<void>();
    const errorMessages: unknown[] = [];
    (vscode.window as any).showWarningMessage = async () => MESSAGES.DONT_SAVE;
    (vscode.window as any).showErrorMessage = (message: unknown) => {
      errorMessages.push(message);
      return Promise.resolve(undefined);
    };
    (writerModule.XMLWriter as any).writeProperties = async () => {
      writeStarted.resolve(undefined);
      await releaseWrite.promise;
      throw new Error('Unable to write captured A');
    };

    let save: Promise<void> | undefined;
    let newerContext: MessageHandlerContext | undefined;
    let newerSaveGeneration: number | undefined;
    try {
      await provider.showProperties(nodeA);
      provider.setIsDirty(true, { Synonym: 'SavedA' });
      const ctx = (provider as any).buildHandlerContext() as MessageHandlerContext;
      save = handleMessage(
        {
          type: 'save',
          nodeId: nodeA.id,
          sessionToken: ctx.currentSessionToken,
          properties: { Synonym: 'SavedA' },
        },
        ctx
      );
      await writeStarted.promise;

      await provider.showProperties(nodeB);
      provider.setIsDirty(true, { Synonym: 'PendingB' });
      newerContext = (provider as any).buildHandlerContext() as MessageHandlerContext;
      newerSaveGeneration = newerContext.beginSave?.();
      assert.notStrictEqual(newerSaveGeneration, undefined, 'the current B session can start its own save window');
      releaseWrite.resolve(undefined);
      await save;

      assert.strictEqual((provider as any).currentNode, nodeB);
      assert.strictEqual(provider.isDirty(), true, 'the late A error must preserve B edits');
      assert.strictEqual((provider as any).pendingProperties?.Synonym, 'PendingB');
      assert.strictEqual(
        errorMessages.length,
        0,
        'a failed captured A write must not show an error after B becomes current'
      );
      assert.strictEqual(
        postedMessages.some((message) => (message as { type?: string }).type === 'update'),
        false,
        'a late rollback must not publish an A update into B'
      );
      assert.strictEqual((provider as any)._isSaving, true, 'the older A failure must not clear B save tracking');
    } finally {
      releaseWrite.resolve(undefined);
      if (save) {
        await save.catch(() => undefined);
      }
      if (newerSaveGeneration !== undefined) {
        newerContext?.endSave?.(newerSaveGeneration, 0);
      }
      (writerModule.XMLWriter as any).writeProperties = originalWriteProperties;
      (vscode.window as any).showWarningMessage = defaultShowWarningMessage;
      (vscode.window as any).showErrorMessage = originalShowErrorMessage;
    }
  });

  test('a Save error dialog cannot open output after navigation changes', async () => {
    const nodeA: TreeNode = {
      id: 'node-a',
      name: 'CatalogA',
      type: MetadataType.Catalog,
      properties: { Name: 'CatalogA', Synonym: 'OriginalA' },
      filePath: tempXmlA,
    };
    const nodeB: TreeNode = {
      id: 'node-b',
      name: 'CatalogB',
      type: MetadataType.Catalog,
      properties: { Name: 'CatalogB', Synonym: 'OriginalB' },
      filePath: tempXmlB,
    };
    const writerModule = await import('../../src/utils/XMLWriter');
    const loggerModule = await import('../../src/utils/logger');
    const originalWriteProperties = writerModule.XMLWriter.writeProperties;
    const originalShowErrorMessage = vscode.window.showErrorMessage;
    const originalLoggerShow = loggerModule.Logger.show;
    const errorDialog = createDeferredValue<unknown>();
    const shownErrors: unknown[] = [];
    let loggerShowCount = 0;
    (vscode.window as any).showErrorMessage = (message: unknown) => {
      shownErrors.push(message);
      return errorDialog.promise;
    };
    (writerModule.XMLWriter as any).writeProperties = async () => {
      throw new Error('Unable to write current A');
    };
    (loggerModule.Logger as any).show = () => {
      loggerShowCount += 1;
    };

    let save: Promise<void> | undefined;
    try {
      await provider.showProperties(nodeA);
      const ctx = (provider as any).buildHandlerContext() as MessageHandlerContext;
      save = handleMessage(
        {
          type: 'save',
          nodeId: nodeA.id,
          sessionToken: ctx.currentSessionToken,
          properties: { Synonym: 'SavedA' },
        },
        ctx
      );
      await save;

      assert.strictEqual(shownErrors.length, 1, 'the current A session can show its write error');
      await provider.showProperties(nodeB);
      errorDialog.resolve('Show Output');
      await errorDialog.promise;
      await Promise.resolve();

      assert.strictEqual(loggerShowCount, 0, 'a stale error-dialog choice must not reveal the output channel');
    } finally {
      errorDialog.resolve(undefined);
      if (save) {
        await save.catch(() => undefined);
      }
      (writerModule.XMLWriter as any).writeProperties = originalWriteProperties;
      (vscode.window as any).showErrorMessage = originalShowErrorMessage;
      (loggerModule.Logger as any).show = originalLoggerShow;
    }
  });

  test('a Save preflight finishing after navigation does not begin saving on the new presentation', async () => {
    const nodeA: TreeNode = {
      id: 'node-a',
      name: 'CatalogA',
      type: MetadataType.Catalog,
      properties: { Name: 'CatalogA', Synonym: 'OriginalA' },
      filePath: tempXmlA,
    };
    const nodeB: TreeNode = {
      id: 'node-b',
      name: 'CatalogB',
      type: MetadataType.Catalog,
      properties: { Name: 'CatalogB', Synonym: 'OriginalB' },
      filePath: tempXmlB,
    };
    const mutationPolicy = await import('../../src/extensionSupport/cfeProject/mutationPolicy');
    const writerModule = await import('../../src/utils/XMLWriter');
    const originalAssertAllowed = mutationPolicy.assertCfeGenericMutationAllowed;
    const originalWriteProperties = writerModule.XMLWriter.writeProperties;
    const originalBeginSave = provider.beginSave;
    const preflightStarted = createDeferredValue<void>();
    const releasePreflight = createDeferredValue<void>();
    let beginSaveOnB = false;
    (mutationPolicy as any).assertCfeGenericMutationAllowed = async () => {
      preflightStarted.resolve(undefined);
      await releasePreflight.promise;
    };
    (writerModule.XMLWriter as any).writeProperties = async () => undefined;
    (provider as any).beginSave = () => {
      if ((provider as any).currentNode === nodeB) {
        beginSaveOnB = true;
      }
      return originalBeginSave.call(provider);
    };

    let save: Promise<void> | undefined;
    try {
      await provider.showProperties(nodeA);
      const ctx = (provider as any).buildHandlerContext() as MessageHandlerContext;
      save = handleMessage(
        {
          type: 'save',
          nodeId: nodeA.id,
          sessionToken: ctx.currentSessionToken,
          properties: { Synonym: 'SavedA' },
        },
        ctx
      );
      await preflightStarted.promise;

      await provider.showProperties(nodeB);
      provider.setIsDirty(true, { Synonym: 'PendingB' });
      assert.strictEqual(ctx.isCurrentSession?.(), false, 'the captured A context must report its lost presentation');
      assert.strictEqual(ctx.beginSave?.(), undefined, 'an obsolete context cannot start a save window on B');
      releasePreflight.resolve(undefined);
      await save;

      assert.strictEqual(
        beginSaveOnB,
        false,
        'a captured A operation must not start the provider save window after B becomes current'
      );
      assert.strictEqual((provider as any).currentNode, nodeB);
      assert.strictEqual(provider.isDirty(), true);
      assert.strictEqual((provider as any).pendingProperties?.Synonym, 'PendingB');
    } finally {
      releasePreflight.resolve(undefined);
      if (save) {
        await save.catch(() => undefined);
      }
      (mutationPolicy as any).assertCfeGenericMutationAllowed = originalAssertAllowed;
      (writerModule.XMLWriter as any).writeProperties = originalWriteProperties;
      (provider as any).beginSave = originalBeginSave;
    }
  });

  test('a Form parse finishing after panel disposal cannot recreate or update the panel', async () => {
    const nodeA: TreeNode = {
      id: 'Forms.Shared',
      name: 'SharedA',
      type: MetadataType.Form,
      properties: {},
      filePath: path.join(path.resolve('config-root-a'), 'Forms', 'Shared.xml'),
    };
    const parser = await import('../../src/formEditor/formXmlParser');
    const originalParseFormXml = parser.parseFormXml;
    const parseStarted = createDeferredValue<void>();
    const parseResult = createDeferredValue<any>();
    let navigation: Promise<boolean> | undefined;

    try {
      (parser as any).parseFormXml = async () => {
        parseStarted.resolve(undefined);
        return parseResult.promise;
      };

      navigation = provider.showProperties(nodeA);
      await parseStarted.promise;
      assert.strictEqual(panelCreateCount, 1);

      panelDidDispose?.();
      assert.strictEqual(provider.isOpen(), false);

      parseResult.resolve(formParseResultWithHandler('DisposedHandler'));
      await navigation;

      assert.strictEqual(provider.isOpen(), false, 'a finished operation must not reopen a disposed panel');
      assert.strictEqual(panelCreateCount, 1, 'no replacement panel should be created after disposal');
      assert.ok(!mockHtml.includes('DisposedHandler'));
    } finally {
      parseResult.resolve(formParseResultWithHandler('CleanupDisposedHandler'));
      if (navigation) {
        await navigation.catch(() => false);
      }
      (parser as any).parseFormXml = originalParseFormXml;
    }
  });
});
