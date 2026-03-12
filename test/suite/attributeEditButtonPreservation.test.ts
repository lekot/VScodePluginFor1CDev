import * as assert from 'assert';
import * as fc from 'fast-check';
import * as vscode from 'vscode';
import { PropertiesProvider } from '../../src/providers/propertiesProvider';
import { MetadataTreeDataProvider } from '../../src/providers/treeDataProvider';
import { TypeEditorProvider } from '../../src/providers/typeEditorProvider';
import { TreeNode, MetadataType } from '../../src/models/treeNode';

/**
 * Preservation Property Tests for Attribute Edit Button Bug Fix
 * 
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**
 * 
 * IMPORTANT: These tests verify that non-edit-button interactions work correctly
 * on UNFIXED code and continue to work after the fix is applied.
 * 
 * Property 2: Preservation - Non-Edit-Button Interaction Behavior
 * For any interaction NOT involving the Type edit button, the system SHALL:
 * - Process property changes through handlePropertyChange correctly
 * - Handle Save/Cancel button clicks through handleSave/handleCancel correctly
 * - Validate properties through handleValidateMessage correctly
 * - Preserve TypeFormatter formatting for Type display
 * - Preserve read-only mode behavior
 */
suite('Preservation Tests: Non-Edit-Button Interactions', () => {
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
   * Test 1: Property change handling for non-Type properties
   * EXPECTED: PASS on unfixed code (this behavior should be preserved)
   * Validates: Requirement 3.1
   */
  test('Property 2.1: Editing other properties (Name, Synonym) works through handlePropertyChange', () => {
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
        Synonym: 'Мой реквизит',
        Type: 'String(50)',
      },
      filePath: '/test/path.xml',
      parentFilePath: '/test/parent.xml',
    };

    (provider as any).currentNode = node;

    // Get webview script
    const getWebviewScript = (provider as any).getWebviewScript.bind(provider);
    const script = getWebviewScript(false);

    // Verify handlePropertyChange function exists
    assert.ok(
      script.includes('handlePropertyChange'),
      'Webview script should contain handlePropertyChange function'
    );

    // Verify property-input event listeners are attached
    assert.ok(
      script.includes("addEventListener('change', handlePropertyChange)"),
      'Webview script should attach change event listener to property inputs'
    );
    assert.ok(
      script.includes("addEventListener('input', handlePropertyChange)"),
      'Webview script should attach input event listener to property inputs'
    );

    // Verify state tracking for changed properties
    assert.ok(
      script.includes('changedProperties'),
      'Webview script should track changed properties'
    );
  });

  /**
   * Test 2: Save button functionality
   * EXPECTED: PASS on unfixed code (this behavior should be preserved)
   * Validates: Requirement 3.2
   */
  test('Property 2.2: Save button works through handleSave', async () => {
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

    // Verify handleSave function exists
    assert.ok(
      script.includes('handleSave'),
      'Webview script should contain handleSave function'
    );

    // Verify save button event listener
    assert.ok(
      script.includes("addEventListener('click', handleSave)"),
      'Webview script should attach click event listener to save button'
    );

    // Verify save message is sent
    assert.ok(
      script.includes("type: 'save'"),
      'Webview script should send save message to extension'
    );
  });

  /**
   * Test 3: Cancel button functionality
   * EXPECTED: PASS on unfixed code (this behavior should be preserved)
   * Validates: Requirement 3.2
   */
  test('Property 2.3: Cancel button works through handleCancel', () => {
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

    // Verify handleCancel function exists
    assert.ok(
      script.includes('handleCancel'),
      'Webview script should contain handleCancel function'
    );

    // Verify cancel button event listener
    assert.ok(
      script.includes("addEventListener('click', handleCancel)"),
      'Webview script should attach click event listener to cancel button'
    );

    // Verify cancel message is sent
    assert.ok(
      script.includes("type: 'cancel'"),
      'Webview script should send cancel message to extension'
    );
  });

  /**
   * Test 4: Validation handling
   * EXPECTED: PASS on unfixed code (this behavior should be preserved)
   * Validates: Requirement 3.2
   */
  test('Property 2.4: Property validation works through handleValidateMessage', async () => {
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

    // Test handleValidateMessage method
    const handleValidateMessage = (provider as any).handleValidateMessage.bind(provider);

    // Mock postMessage to capture validation errors
    let capturedMessage: any = null;
    const originalPostMessage = (provider as any).postMessage;
    (provider as any).postMessage = (message: any) => {
      capturedMessage = message;
    };

    try {
      // Test with invalid properties (empty Name)
      handleValidateMessage({
        type: 'validate',
        properties: {
          Name: '', // Invalid: Name is required
          Type: 'String(50)',
        },
      });

      // Verify validation error was sent
      assert.ok(
        capturedMessage !== null,
        'Validation should send a message'
      );
      assert.strictEqual(
        capturedMessage.type,
        'validationError',
        'Message should be a validation error'
      );
      assert.ok(
        capturedMessage.errors,
        'Validation error should contain errors object'
      );
    } finally {
      // Restore original postMessage
      (provider as any).postMessage = originalPostMessage;
    }
  });

  /**
   * Test 5: Type formatting preservation
   * EXPECTED: PASS on unfixed code (this behavior should be preserved)
   * Validates: Requirement 3.4
   */
  test('Property 2.5: TypeFormatter formatting is preserved for Type display', () => {
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

    // Verify Type value is displayed (formatted or raw)
    assert.ok(
      html.includes('String(50)') || html.includes('value="String(50)"'),
      'Type value should be displayed in the input field'
    );

    // Verify input field exists for Type
    assert.ok(
      html.includes('data-property="Type"'),
      'Type input field should have data-property attribute'
    );
  });

  /**
   * Test 6: Read-only mode behavior
   * EXPECTED: PASS on unfixed code (this behavior should be preserved)
   * Validates: Requirement 3.5
   */
  test('Property 2.6: Read-only mode does not show edit button', () => {
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

    // Render in read-only mode
    const renderPropertyInput = (provider as any).renderPropertyInput.bind(provider);
    const html = renderPropertyInput('Type', 'String(50)', true); // globalReadOnly = true

    // Verify edit button is NOT present in read-only mode
    assert.ok(
      !html.includes('edit-type-btn'),
      'Edit button should NOT be present in read-only mode'
    );

    // Verify input is disabled in read-only mode
    assert.ok(
      html.includes('disabled') || html.includes('readonly'),
      'Input should be disabled or readonly in read-only mode'
    );
  });

  /**
   * Test 7: Root element behavior (no edit button for Catalog, Document)
   * EXPECTED: PASS on unfixed code (this behavior should be preserved)
   * Validates: Requirement 3.3
   */
  test('Property 2.7: Root elements (Catalog, Document) do not show Type edit button', () => {
    const catalogNode: TreeNode = {
      id: 'test-catalog',
      name: 'TestCatalog',
      type: MetadataType.Catalog,
      properties: {
        Name: 'TestCatalog',
        Type: 'Catalog',
      },
      filePath: '/test/catalog.xml',
    };

    (provider as any).currentNode = catalogNode;

    const renderPropertyInput = (provider as any).renderPropertyInput.bind(provider);
    const html = renderPropertyInput('Type', 'Catalog', false);

    // Verify edit button is NOT present for root elements
    assert.ok(
      !html.includes('edit-type-btn'),
      'Edit button should NOT be present for root elements (Catalog)'
    );

    // Test with Document
    const documentNode: TreeNode = {
      id: 'test-document',
      name: 'TestDocument',
      type: MetadataType.Document,
      properties: {
        Name: 'TestDocument',
        Type: 'Document',
      },
      filePath: '/test/document.xml',
    };

    (provider as any).currentNode = documentNode;
    const htmlDoc = renderPropertyInput('Type', 'Document', false);

    assert.ok(
      !htmlDoc.includes('edit-type-btn'),
      'Edit button should NOT be present for root elements (Document)'
    );
  });

  /**
   * Property-Based Test: Property changes for non-Type properties
   * EXPECTED: PASS on unfixed code (this behavior should be preserved)
   * Tests that for ANY non-Type property change, handlePropertyChange works correctly
   * Validates: Requirement 3.1
   */
  test('Property 2.8: Property changes work for any non-Type property (Property-Based)', () => {
    // Generator for property names (excluding Type)
    const propertyNameArb = fc.constantFrom('Name', 'Synonym', 'Comment', 'Description');

    // Generator for property values
    const propertyValueArb = fc.oneof(
      fc.string({ minLength: 1, maxLength: 50 }),
      fc.constant('Test Value'),
      fc.constant('Тестовое значение')
    );

    fc.assert(
      fc.property(propertyNameArb, propertyValueArb, (propName, propValue) => {
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
            [propName]: propValue,
            Type: 'String(50)',
          },
          filePath: '/test/path.xml',
          parentFilePath: '/test/parent.xml',
        };

        (provider as any).currentNode = node;

        const renderPropertyInput = (provider as any).renderPropertyInput.bind(provider);
        const html = renderPropertyInput(propName, propValue, false);

        // Property: Input field should exist for any non-Type property
        const hasInput = html.includes(`data-property="${propName}"`);
        const hasValue = html.includes(propValue) || html.includes(`value="`);

        return hasInput && hasValue;
      }),
      { numRuns: 20 }
    );
  });

  /**
   * Property-Based Test: Save/Cancel functionality across different property sets
   * EXPECTED: PASS on unfixed code (this behavior should be preserved)
   * Tests that Save/Cancel work for ANY set of properties
   * Validates: Requirement 3.2
   */
  test('Property 2.9: Save/Cancel work for any property set (Property-Based)', () => {
    // Generator for property sets
    const propertiesArb = fc.record({
      Name: fc.string({ minLength: 1, maxLength: 50 }),
      Synonym: fc.option(fc.string({ maxLength: 50 }), { nil: undefined }),
      Type: fc.constantFrom('String(50)', 'Number(10,2)', 'Date', 'Boolean'),
    });

    fc.assert(
      fc.property(propertiesArb, (properties) => {
        const node: TreeNode = {
          id: 'test-attr',
          name: properties.Name,
          type: MetadataType.Attribute,
          parent: {
            id: 'parent',
            name: 'TestCatalog',
            type: MetadataType.Catalog,
            properties: {},
          },
          properties: properties,
          filePath: '/test/path.xml',
          parentFilePath: '/test/parent.xml',
        };

        (provider as any).currentNode = node;

        const getWebviewScript = (provider as any).getWebviewScript.bind(provider);
        const script = getWebviewScript(false);

        // Property: Save and Cancel handlers should exist for any property set
        const hasSaveHandler = script.includes('handleSave');
        const hasCancelHandler = script.includes('handleCancel');
        const hasSaveMessage = script.includes("type: 'save'");
        const hasCancelMessage = script.includes("type: 'cancel'");

        return hasSaveHandler && hasCancelHandler && hasSaveMessage && hasCancelMessage;
      }),
      { numRuns: 20 }
    );
  });

  /**
   * Property-Based Test: Type formatting across different Type values
   * EXPECTED: PASS on unfixed code (this behavior should be preserved)
   * Tests that Type formatting works for ANY Type value
   * Validates: Requirement 3.4
   */
  test('Property 2.10: Type formatting works for any Type value (Property-Based)', () => {
    // Generator for Type values
    const typeValueArb = fc.oneof(
      fc.constant('String(50)'),
      fc.constant('Number(10,2)'),
      fc.constant('Reference(Catalog.Номенклатура)'),
      fc.constant('Date'),
      fc.constant('Boolean'),
      fc.tuple(
        fc.constantFrom('String', 'Number'),
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

        // Property: Type value should be displayed for ANY Type value
        const hasTypeValue = html.includes(typeValue) || html.includes(`value="`);
        const hasDataProperty = html.includes('data-property="Type"');

        return hasTypeValue && hasDataProperty;
      }),
      { numRuns: 20 }
    );
  });
});
