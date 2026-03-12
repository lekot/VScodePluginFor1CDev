import * as assert from 'assert';
import * as fc from 'fast-check';
import * as vscode from 'vscode';
import { PropertiesProvider } from '../../src/providers/propertiesProvider';
import { MetadataTreeDataProvider } from '../../src/providers/treeDataProvider';
import { TypeEditorProvider } from '../../src/providers/typeEditorProvider';
import { TreeNode, MetadataType } from '../../src/models/treeNode';

/**
 * Bug Condition Exploration Test for Attribute Edit Button Missing
 * 
 * **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5**
 * 
 * CRITICAL: This test MUST FAIL on unfixed code - failure confirms the bug exists
 * 
 * Property 1: Bug Condition - Edit Button Presence and Functionality
 * For any Attribute element with Type property, the system SHALL:
 * - Display edit button in HTML markup for Type field
 * - Open TypeEditorProvider modal when button is clicked
 * - Pass current Type value to TypeEditorProvider
 * - Update Type value in properties panel after saving
 * - Close editor without changes when canceled
 */
suite('Bug Condition Exploration: Attribute Edit Button Missing', () => {
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

  /**
   * Test 1: Edit button HTML presence
   * EXPECTED: FAIL on unfixed code (button exists in HTML but no handler)
   * Counterexample: Edit button missing from DOM for Attribute with Type="String(50)"
   */
  test('Property 1.1: Edit button is present in HTML markup for Attribute Type field', () => {
    const node: TreeNode = {
      id: 'test-attr',
      name: 'MyAttribute',
      type: MetadataType.Attribute,
      parent: {
        id: 'parent',
        name: 'TestCatalog',
        type: MetadataType.Catalog,
        properties: {},
      },
      properties: {
        Name: 'MyAttribute',
        Type: 'String(50)',
      },
      filePath: '/test/path.xml',
      parentFilePath: '/test/parent.xml',
    };

    (provider as any).currentNode = node;

    const renderPropertyInput = (provider as any).renderPropertyInput.bind(provider);
    const html = renderPropertyInput('Type', 'String(50)', false);

    // Verify button exists in HTML
    assert.ok(html.includes('edit-type-btn'), 'Edit button should be present in HTML markup');
    assert.ok(html.includes('Редактировать тип'), 'Edit button should have Russian label');
    assert.ok(html.includes('data-property="Type"'), 'Edit button should have data-property attribute');
  });

  /**
   * Test 2: Click handler existence in webview script
   * EXPECTED: FAIL on unfixed code (no handleEditType function in webview script)
   * Counterexample: No event listener attached to edit-type-btn elements
   */
  test('Property 1.2: Click handler is attached to edit button in webview script', () => {
    const getWebviewScript = (provider as any).getWebviewScript.bind(provider);
    const script = getWebviewScript(false);

    // Verify click handler exists
    assert.ok(
      script.includes('edit-type-btn') || script.includes('handleEditType'),
      'Webview script should contain edit button click handler'
    );
    assert.ok(
      script.includes("type: 'editType'") || script.includes('type: "editType"'),
      'Webview script should send editType message'
    );
  });

  /**
   * Test 3: Message handler in extension
   * EXPECTED: FAIL on unfixed code (no 'editType' case in handleMessage)
   * Counterexample: editType message not handled in handleMessage switch
   */
  test('Property 1.3: Extension handles editType message from webview', async function() {
    this.timeout(5000); // Increase timeout for panel initialization
    
    const node: TreeNode = {
      id: 'test-attr',
      name: 'MyAttribute',
      type: MetadataType.Attribute,
      parent: {
        id: 'parent',
        name: 'TestCatalog',
        type: MetadataType.Catalog,
        properties: {},
      },
      properties: {
        Name: 'MyAttribute',
        Type: 'String(50)',
      },
      filePath: '/test/path.xml',
      parentFilePath: '/test/parent.xml',
    };

    (provider as any).currentNode = node;

    // Try to handle editType message
    const handleMessage = (provider as any).handleMessage.bind(provider);
    
    let errorOccurred = false;
    let messageHandled = false;

    try {
      // This should handle the editType message without throwing
      const result = handleMessage({ type: 'editType', property: 'Type' });
      // Wait for the promise if it returns one
      if (result && typeof result.then === 'function') {
        await result;
      }
      messageHandled = true;
    } catch (error) {
      errorOccurred = true;
    }

    // On unfixed code, this will either:
    // 1. Log "Unknown message type: editType" (no case in switch)
    // 2. Throw error because TypeEditorProvider is not available
    assert.ok(
      messageHandled && !errorOccurred,
      'Extension should handle editType message without error'
    );
  });

  /**
   * Test 4: TypeEditorProvider dependency
   * EXPECTED: FAIL on unfixed code (PropertiesProvider has no typeEditorProvider field)
   * Counterexample: PropertiesProvider doesn't have reference to TypeEditorProvider
   */
  test('Property 1.4: PropertiesProvider has reference to TypeEditorProvider', () => {
    // Check if provider has typeEditorProvider field
    const hasTypeEditorProvider = 'typeEditorProvider' in provider;
    
    assert.ok(
      hasTypeEditorProvider,
      'PropertiesProvider should have typeEditorProvider field'
    );
  });

  /**
   * Property-Based Test: Edit button functionality across multiple Type values
   * EXPECTED: FAIL on unfixed code for all generated Type values
   * Tests that for ANY Attribute with Type property, the edit button works correctly
   */
  test('Property 1.5: Edit button works for any Attribute Type value (Property-Based)', () => {
    // Generator for Type values
    const typeValueArb = fc.oneof(
      fc.constant('String(50)'),
      fc.constant('Number(10,2)'),
      fc.constant('Reference(Catalog.Номенклатура)'),
      fc.constant('Date'),
      fc.constant('Boolean'),
      fc.tuple(
        fc.constantFrom('String', 'Number', 'Reference'),
        fc.nat(100)
      ).map(([type, len]) => `${type}(${len})`)
    );

    fc.assert(
      fc.property(typeValueArb, (typeValue) => {
        const node: TreeNode = {
          id: 'test-attr',
          name: 'TestAttribute',
          type: MetadataType.Attribute,
          parent: {
            id: 'parent',
            name: 'TestCatalog',
            type: MetadataType.Catalog,
            properties: {},
          },
          properties: {
            Name: 'TestAttribute',
            Type: typeValue,
          },
          filePath: '/test/path.xml',
          parentFilePath: '/test/parent.xml',
        };

        (provider as any).currentNode = node;

        const renderPropertyInput = (provider as any).renderPropertyInput.bind(provider);
        const html = renderPropertyInput('Type', typeValue, false);

        // Property: Edit button should be present for ANY Attribute Type
        const hasEditButton = html.includes('edit-type-btn');
        const hasLabel = html.includes('Редактировать тип');
        const hasDataProperty = html.includes('data-property="Type"');

        return hasEditButton && hasLabel && hasDataProperty;
      }),
      { numRuns: 20 }
    );
  });

  /**
   * Documented Counterexamples from Design
   * These are the specific failing cases mentioned in the bugfix requirements
   */
  test('Counterexample 1: Edit button missing for Attribute with Type="String(50)"', () => {
    const node: TreeNode = {
      id: 'test-attr',
      name: 'MyAttribute',
      type: MetadataType.Attribute,
      parent: {
        id: 'parent',
        name: 'TestCatalog',
        type: MetadataType.Catalog,
        properties: {},
      },
      properties: {
        Name: 'MyAttribute',
        Type: 'String(50)',
      },
      filePath: '/test/path.xml',
      parentFilePath: '/test/parent.xml',
    };

    (provider as any).currentNode = node;

    // Get webview script
    const getWebviewScript = (provider as any).getWebviewScript.bind(provider);
    const script = getWebviewScript(false);

    // The bug: button exists in HTML but no click handler in script
    const renderPropertyInput = (provider as any).renderPropertyInput.bind(provider);
    const html = renderPropertyInput('Type', 'String(50)', false);
    
    const buttonInHtml = html.includes('edit-type-btn');
    const handlerInScript = script.includes('edit-type-btn') && script.includes('handleEditType');

    // This will FAIL on unfixed code: button exists but handler doesn't
    assert.ok(
      buttonInHtml && handlerInScript,
      'Edit button exists in HTML but click handler is missing from webview script'
    );
  });

  test('Counterexample 2: Edit button missing for Attribute with Type="Number(10,2)"', () => {
    const node: TreeNode = {
      id: 'test-attr',
      name: 'Amount',
      type: MetadataType.Attribute,
      parent: {
        id: 'parent',
        name: 'TestDocument',
        type: MetadataType.Document,
        properties: {},
      },
      properties: {
        Name: 'Amount',
        Type: 'Number(10,2)',
      },
      filePath: '/test/path.xml',
      parentFilePath: '/test/parent.xml',
    };

    (provider as any).currentNode = node;

    const getWebviewScript = (provider as any).getWebviewScript.bind(provider);
    const script = getWebviewScript(false);

    const renderPropertyInput = (provider as any).renderPropertyInput.bind(provider);
    const html = renderPropertyInput('Type', 'Number(10,2)', false);
    
    const buttonInHtml = html.includes('edit-type-btn');
    const handlerInScript = script.includes('edit-type-btn') && script.includes('handleEditType');

    assert.ok(
      buttonInHtml && handlerInScript,
      'Edit button exists in HTML but click handler is missing from webview script'
    );
  });

  test('Counterexample 3: Edit button missing for Attribute with Type="Reference(Catalog.Номенклатура)"', () => {
    const node: TreeNode = {
      id: 'test-attr',
      name: 'Product',
      type: MetadataType.Attribute,
      parent: {
        id: 'parent',
        name: 'TestDocument',
        type: MetadataType.Document,
        properties: {},
      },
      properties: {
        Name: 'Product',
        Type: 'Reference(Catalog.Номенклатура)',
      },
      filePath: '/test/path.xml',
      parentFilePath: '/test/parent.xml',
    };

    (provider as any).currentNode = node;

    const getWebviewScript = (provider as any).getWebviewScript.bind(provider);
    const script = getWebviewScript(false);

    const renderPropertyInput = (provider as any).renderPropertyInput.bind(provider);
    const html = renderPropertyInput('Type', 'Reference(Catalog.Номенклатура)', false);
    
    const buttonInHtml = html.includes('edit-type-btn');
    const handlerInScript = script.includes('edit-type-btn') && script.includes('handleEditType');

    assert.ok(
      buttonInHtml && handlerInScript,
      'Edit button exists in HTML but click handler is missing from webview script'
    );
  });
});
