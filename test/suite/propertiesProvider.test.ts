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
    provider.setIsDirty(true, { Name: 'ModifiedCatalog' });
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
    provider.setIsDirty(true, { Name: 'CatalogA', Synonym: 'Saved Before Navigation' });

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
    provider.setIsDirty(true, { Name: 'CatalogA', Synonym: 'Discarded Synonym' });

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
    provider.setIsDirty(true, { Name: 'CatalogA', Synonym: 'Pending' });

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
    provider.setIsDirty(true, { Name: 'CatalogA', Synonym: 'Pending' });

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
    provider.setIsDirty(true, { Name: 'CatalogA', Synonym: 'Pending' });

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
    provider.setIsDirty(true, { Name: 'CatalogA', Synonym: 'SavedViaShow' });

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
    provider.setIsDirty(true, { Name: 'CatalogA', Synonym: 'FormPending' });

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
      { type: 'dirtyChange', isDirty: true, properties: { Name: 'CatalogA', Synonym: 'First Edit', Comment: 'Orig' } },
      ctx
    );
    assert.strictEqual(provider.isDirty(), true);
    assert.deepStrictEqual((provider as any).pendingProperties, { Name: 'CatalogA', Synonym: 'First Edit', Comment: 'Orig' });

    // 2nd edit: Comment changed as well
    await handleMessage(
      { type: 'dirtyChange', isDirty: true, properties: { Name: 'CatalogA', Synonym: 'First Edit', Comment: 'Second Edit' } },
      ctx
    );
    assert.strictEqual(provider.isDirty(), true);
    assert.deepStrictEqual((provider as any).pendingProperties, { Name: 'CatalogA', Synonym: 'First Edit', Comment: 'Second Edit' });
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
    provider.setIsDirty(true, { Name: 'CatalogA', Synonym: 'Unsaved Edit' });

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
        properties: {
          Name: 'AttrB',
          Type: '<Type xmlns="http://v8.1c.ru/8.1/data/core" xmlns:xs="http://www.w3.org/2001/XMLSchema"><Type>xs:decimal</Type></Type>',
        },
      };

      let resolveShow!: (value: any) => void;
      const showPromise = new Promise<any>((res) => {
        resolveShow = res;
      });

      const mockTypeEditor = {
        show: async () => showPromise,
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

      const msgPromise = handleMessage(
        {
          type: 'editType',
          propertyName: 'Type',
          nodeId: 'Attributes.AttrA',
          sessionToken: 'session-node-A',
        },
        ctx
      );

      // Node selection changes to Node B while editor is open
      ctx.currentNode = nodeB;
      ctx.currentSessionToken = 'session-node-B';

      // Type editor finishes with Date type
      resolveShow({
        category: 'primitive',
        types: [{ kind: 'date', qualifiers: { dateFractions: 'Date' } }],
      });

      await msgPromise;

      // Stale typeUpdated message must NOT be posted for Node B
      const typeUpdated = postedMessages.find((m) => m.type === 'typeUpdated');
      assert.strictEqual(
        typeUpdated,
        undefined,
        'typeUpdated must not be sent when currentNode has changed during edit'
      );
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

      let resolveShow!: (value: any) => void;
      const showPromise = new Promise<any>((res) => {
        resolveShow = res;
      });

      const mockObjectTypeEditor = {
        show: async () => showPromise,
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

      const msgPromise = handleMessage(
        {
          type: 'editSource',
          propertyName: 'Source',
          nodeId: 'EventSubscriptions.SubA',
          sessionToken: 'session-node-A',
        },
        ctx
      );

      // Node selection changes to Node B while editor is open
      ctx.currentNode = nodeB;
      ctx.currentSessionToken = 'session-node-B';

      // Source editor finishes with new types
      resolveShow({
        types: [{ objectKind: 'CatalogObject', objectName: 'Goods' }],
      });

      await msgPromise;

      // Stale sourceUpdated message must NOT be posted for Node B
      const sourceUpdated = postedMessages.find((m) => m.type === 'sourceUpdated');
      assert.strictEqual(
        sourceUpdated,
        undefined,
        'sourceUpdated must not be sent when currentNode has changed during edit'
      );
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
  });
});



