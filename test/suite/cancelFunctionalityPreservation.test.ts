import * as assert from 'assert';
import * as fc from 'fast-check';
import * as vscode from 'vscode';
import { TypeEditorProvider } from '../../src/providers/typeEditorProvider';
import { TypeDefinition } from '../../src/types/typeDefinitions';

/**
 * Preservation Property Tests for Cancel Functionality
 * 
 * **Validates: Requirements 3.5**
 * 
 * IMPORTANT: Follow observation-first methodology
 * These tests observe behavior on UNFIXED code for other editor interactions
 * 
 * Property 2: Preservation - Existing Editor Behavior
 * These tests ensure that other editor features (non-Cancel-related) continue to work
 * after the fix is implemented.
 * 
 * EXPECTED OUTCOME: Tests PASS on unfixed code (confirms baseline behavior to preserve)
 */
suite('Preservation Property Tests: Existing Editor Behavior (Non-Cancel)', () => {
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

    typeEditorProvider = new TypeEditorProvider(mockContext);
  });

  teardown(() => {
    typeEditorProvider.dispose();
  });

  /**
   * Test 2.1: Editor opens and displays type configuration correctly
   * EXPECTED: PASS on unfixed code
   * Requirement 3.5: Other editor features continue to function correctly
   */
  test('Property 2.1: Editor opens and displays primitive type configuration', () => {
    const typeDefinition: TypeDefinition = {
      category: 'primitive',
      types: [{
        kind: 'string',
        qualifiers: {
          length: 100,
          allowedLength: 'Variable'
        }
      }]
    };

    const getWebviewContent = (typeEditorProvider as any).getWebviewContent.bind(typeEditorProvider);
    const html = getWebviewContent(typeDefinition);

    // Verify editor renders correctly
    assert.ok(
      html.includes('value="primitive" checked'),
      'Primitive category should be selected'
    );
    assert.ok(
      html.includes('id="config-primitive"'),
      'Primitive config section should exist'
    );
    assert.ok(
      html.includes('id="preview-value"'),
      'Preview section should exist'
    );
  });

  /**
   * Test 2.2: Category switching works correctly
   * EXPECTED: PASS on unfixed code
   * Ensures category radio buttons continue to function
   */
  test('Property 2.2: Category selector displays all categories', () => {
    const typeDefinition: TypeDefinition = {
      category: 'primitive',
      types: [{
        kind: 'boolean'
      }]
    };

    const getWebviewContent = (typeEditorProvider as any).getWebviewContent.bind(typeEditorProvider);
    const html = getWebviewContent(typeDefinition);

    // Verify all category options exist
    assert.ok(
      html.includes('value="primitive"'),
      'Primitive category option should exist'
    );
    assert.ok(
      html.includes('value="reference"'),
      'Reference category option should exist'
    );
    assert.ok(
      html.includes('value="composite"'),
      'Composite category option should exist'
    );
    assert.ok(
      html.includes('type="radio" name="category"'),
      'Category options should be radio buttons'
    );
  });

  /**
   * Test 2.3: Type selector displays available types
   * EXPECTED: PASS on unfixed code
   * Ensures type selection continues to work
   */
  test('Property 2.3: Primitive type selector displays all type options', () => {
    const typeDefinition: TypeDefinition = {
      category: 'primitive',
      types: [{
        kind: 'string',
        qualifiers: {
          length: 50,
          allowedLength: 'Variable'
        }
      }]
    };

    const getWebviewContent = (typeEditorProvider as any).getWebviewContent.bind(typeEditorProvider);
    const html = getWebviewContent(typeDefinition);

    // Verify all primitive type options are available
    const primitiveTypeMatch = html.match(/<select id="primitive-type">([\s\S]*?)<\/select>/);
    assert.ok(primitiveTypeMatch, 'Primitive type selector should exist');

    const selectContent = primitiveTypeMatch![1];
    assert.ok(selectContent.includes('value="string"'), 'String option should be available');
    assert.ok(selectContent.includes('value="number"'), 'Number option should be available');
    assert.ok(selectContent.includes('value="boolean"'), 'Boolean option should be available');
    assert.ok(selectContent.includes('value="date"'), 'Date option should be available');
  });

  /**
   * Test 2.4: Preview updates correctly
   * EXPECTED: PASS on unfixed code
   * Ensures preview functionality continues to work
   */
  test('Property 2.4: Preview displays current type configuration', () => {
    const typeDefinition: TypeDefinition = {
      category: 'primitive',
      types: [{
        kind: 'number',
        qualifiers: {
          digits: 10,
          fractionDigits: 2,
          allowedSign: 'Any'
        }
      }]
    };

    const getWebviewContent = (typeEditorProvider as any).getWebviewContent.bind(typeEditorProvider);
    const html = getWebviewContent(typeDefinition);

    // Verify preview shows the type
    assert.ok(html.includes('id="preview-value"'), 'Preview section should exist');
    assert.ok(html.includes('Number(10,2)'), 'Preview should show Number type with qualifiers');
  });

  /**
   * Test 2.5: Save button is present and functional
   * EXPECTED: PASS on unfixed code
   * Ensures Save button continues to exist
   */
  test('Property 2.5: Save button is present in the editor', () => {
    const typeDefinition: TypeDefinition = {
      category: 'primitive',
      types: [{
        kind: 'boolean'
      }]
    };

    const getWebviewContent = (typeEditorProvider as any).getWebviewContent.bind(typeEditorProvider);
    const html = getWebviewContent(typeDefinition);

    // Verify Save button exists
    assert.ok(html.includes('id="save-btn"'), 'Save button should exist');
    assert.ok(html.includes('Save'), 'Save button should have "Save" text');
  });

  /**
   * Test 2.6: Reference type configuration displays correctly
   * EXPECTED: PASS on unfixed code
   * Ensures reference type editing continues to work
   */
  test('Property 2.6: Reference type configuration displays correctly', () => {
    const typeDefinition: TypeDefinition = {
      category: 'reference',
      types: [{
        kind: 'reference',
        referenceType: {
          referenceKind: 'CatalogRef',
          objectName: 'Products'
        }
      }]
    };

    const getWebviewContent = (typeEditorProvider as any).getWebviewContent.bind(typeEditorProvider);
    const html = getWebviewContent(typeDefinition);

    // Verify reference configuration is displayed
    assert.ok(
      html.includes('value="reference" checked'),
      'Reference category should be selected'
    );
    assert.ok(
      html.includes('id="config-reference"'),
      'Reference config section should exist'
    );
    assert.ok(
      html.includes('id="reference-kind"'),
      'Reference kind selector should exist'
    );
    assert.ok(
      html.includes('id="reference-object"'),
      'Reference object input should exist'
    );
    assert.ok(
      html.includes('value="Products"'),
      'Object name should be populated'
    );
  });

  /**
   * Test 2.7: Composite type configuration displays correctly
   * EXPECTED: PASS on unfixed code
   * Ensures composite type editing continues to work
   */
  test('Property 2.7: Composite type configuration displays all types', () => {
    const typeDefinition: TypeDefinition = {
      category: 'composite',
      types: [
        {
          kind: 'string',
          qualifiers: {
            length: 50,
            allowedLength: 'Variable'
          }
        },
        {
          kind: 'number',
          qualifiers: {
            digits: 10,
            fractionDigits: 2,
            allowedSign: 'Any'
          }
        }
      ]
    };

    const getWebviewContent = (typeEditorProvider as any).getWebviewContent.bind(typeEditorProvider);
    const html = getWebviewContent(typeDefinition);

    // Verify composite configuration is displayed
    assert.ok(
      html.includes('value="composite" checked'),
      'Composite category should be selected'
    );
    assert.ok(
      html.includes('id="config-composite"'),
      'Composite config section should exist'
    );
    assert.ok(
      html.includes('id="composite-list"'),
      'Composite list should exist'
    );

    // Verify preview shows all types
    const previewMatch = html.match(/<div id="preview-value" class="preview-value">(.*?)<\/div>/);
    assert.ok(previewMatch, 'Preview should exist');
    
    const previewContent = previewMatch![1];
    assert.ok(previewContent.includes('String(50)'), 'Preview should show String type');
    assert.ok(previewContent.includes('Number(10,2)'), 'Preview should show Number type');
    assert.ok(previewContent.includes('|'), 'Preview should separate types with |');
  });

  /**
   * Test 2.8: Message handler processes save messages correctly
   * EXPECTED: PASS on unfixed code
   * Ensures save functionality continues to work
   */
  test('Property 2.8: Message handler processes save messages', async () => {
    const typeDefinition: TypeDefinition = {
      category: 'primitive',
      types: [{
        kind: 'string',
        qualifiers: {
          length: 100,
          allowedLength: 'Variable'
        }
      }]
    };

    const handleMessage = (typeEditorProvider as any).handleMessage.bind(typeEditorProvider);
    
    let savedDefinition: TypeDefinition | null = null;
    (typeEditorProvider as any).resolvePromise = (result: TypeDefinition) => {
      savedDefinition = result;
    };

    // Send save message
    await handleMessage({
      type: 'save',
      typeDefinition: typeDefinition
    });

    // Verify save was processed
    assert.ok(savedDefinition !== null, 'Save message should be processed');
    const saved = savedDefinition as TypeDefinition;
    assert.strictEqual(saved.category, 'primitive', 'Category should be preserved');
  });

  /**
   * Test 2.9: Editor state management works for non-Cancel operations
   * EXPECTED: PASS on unfixed code
   * Ensures editor state tracking continues to work
   */
  test('Property 2.9: Editor tracks state for different type categories', () => {
    const primitiveType: TypeDefinition = {
      category: 'primitive',
      types: [{
        kind: 'string',
        qualifiers: {
          length: 50,
          allowedLength: 'Variable'
        }
      }]
    };

    const referenceType: TypeDefinition = {
      category: 'reference',
      types: [{
        kind: 'reference',
        referenceType: {
          referenceKind: 'CatalogRef',
          objectName: 'Items'
        }
      }]
    };

    const getWebviewContent = (typeEditorProvider as any).getWebviewContent.bind(typeEditorProvider);
    
    // Test primitive type state
    const primitiveHtml = getWebviewContent(primitiveType);
    assert.ok(
      primitiveHtml.includes('value="primitive" checked'),
      'Primitive state should be tracked'
    );

    // Test reference type state
    const referenceHtml = getWebviewContent(referenceType);
    assert.ok(
      referenceHtml.includes('value="reference" checked'),
      'Reference state should be tracked'
    );
  });

  /**
   * Test 2.10: Button row layout is preserved
   * EXPECTED: PASS on unfixed code
   * Ensures button layout continues to work
   */
  test('Property 2.10: Button row contains both Save and Cancel buttons', () => {
    const typeDefinition: TypeDefinition = {
      category: 'primitive',
      types: [{
        kind: 'boolean'
      }]
    };

    const getWebviewContent = (typeEditorProvider as any).getWebviewContent.bind(typeEditorProvider);
    const html = getWebviewContent(typeDefinition);

    // Verify button row exists with both buttons
    assert.ok(html.includes('class="button-row"'), 'Button row should exist');
    assert.ok(html.includes('id="save-btn"'), 'Save button should be in button row');
    assert.ok(html.includes('id="cancel-btn"'), 'Cancel button should be in button row');
  });

  /**
   * Property-Based Test 2.11: Editor displays any primitive type correctly
   * EXPECTED: PASS on unfixed code
   * Tests that for ANY primitive type, the editor displays correctly
   */
  test('Property 2.11: Editor displays any primitive type configuration (Property-Based)', () => {
    // Generator for any primitive type
    const primitiveTypeArb = fc.oneof(
      // String types
      fc.record({
        kind: fc.constant('string' as const),
        qualifiers: fc.record({
          length: fc.integer({ min: 1, max: 1024 }),
          allowedLength: fc.constantFrom('Fixed' as const, 'Variable' as const)
        })
      }),
      // Number types
      fc.record({
        kind: fc.constant('number' as const),
        qualifiers: fc.record({
          digits: fc.integer({ min: 1, max: 38 }),
          fractionDigits: fc.integer({ min: 0, max: 10 }),
          allowedSign: fc.constantFrom('Any' as const, 'Nonnegative' as const)
        })
      }),
      // Boolean types
      fc.record({
        kind: fc.constant('boolean' as const)
      }),
      // Date types
      fc.record({
        kind: fc.constant('date' as const),
        qualifiers: fc.record({
          dateFractions: fc.constantFrom('Date' as const, 'DateTime' as const, 'Time' as const)
        })
      })
    );

    fc.assert(
      fc.property(primitiveTypeArb, (typeEntry) => {
        const typeDefinition: TypeDefinition = {
          category: 'primitive',
          types: [typeEntry as any]
        };

        const getWebviewContent = (typeEditorProvider as any).getWebviewContent.bind(typeEditorProvider);
        const html = getWebviewContent(typeDefinition);

        // Property: The editor should display correctly
        const hasPrimitiveChecked = html.includes('value="primitive" checked');
        const hasPrimitiveActive = html.includes('id="config-primitive"');
        const hasTypeSelector = html.includes('id="primitive-type"');
        const hasPreview = html.includes('id="preview-value"');
        const hasSaveButton = html.includes('id="save-btn"');
        const hasCancelButton = html.includes('id="cancel-btn"');

        return hasPrimitiveChecked && hasPrimitiveActive && hasTypeSelector && 
               hasPreview && hasSaveButton && hasCancelButton;
      }),
      { numRuns: 50 }
    );
  });

  /**
   * Property-Based Test 2.12: Editor handles any reference type correctly
   * EXPECTED: PASS on unfixed code
   */
  test('Property 2.12: Editor handles any reference type configuration (Property-Based)', () => {
    // Generator for reference types
    const referenceTypeArb = fc.record({
      referenceKind: fc.constantFrom(
        'CatalogRef' as const,
        'DocumentRef' as const,
        'EnumRef' as const,
        'ChartOfCharacteristicTypesRef' as const,
        'ChartOfAccountsRef' as const,
        'ChartOfCalculationTypesRef' as const
      ),
      objectName: fc.string({ minLength: 1, maxLength: 50 }).filter(s => !s.includes('"') && !s.includes('<'))
    });

    fc.assert(
      fc.property(referenceTypeArb, (refType) => {
        const typeDefinition: TypeDefinition = {
          category: 'reference',
          types: [{
            kind: 'reference',
            referenceType: refType
          }]
        };

        const getWebviewContent = (typeEditorProvider as any).getWebviewContent.bind(typeEditorProvider);
        const html = getWebviewContent(typeDefinition);

        // Property: The editor should display reference type correctly
        const hasReferenceChecked = html.includes('value="reference" checked');
        const hasReferenceConfig = html.includes('id="config-reference"');
        const hasReferenceKind = html.includes('id="reference-kind"');
        const hasObjectName = html.includes('id="reference-object"') && 
                              html.includes(`value="${refType.objectName}"`);
        const hasSaveButton = html.includes('id="save-btn"');
        const hasCancelButton = html.includes('id="cancel-btn"');

        return hasReferenceChecked && hasReferenceConfig && hasReferenceKind && 
               hasObjectName && hasSaveButton && hasCancelButton;
      }),
      { numRuns: 30 }
    );
  });

  /**
   * Property-Based Test 2.13: Editor handles any composite type correctly
   * EXPECTED: PASS on unfixed code
   */
  test('Property 2.13: Editor handles any composite type configuration (Property-Based)', () => {
    // Generator for composite type with multiple entries
    const compositeTypeArb = fc.array(
      fc.oneof(
        fc.record({
          kind: fc.constant('string' as const),
          qualifiers: fc.record({
            length: fc.integer({ min: 1, max: 1024 }),
            allowedLength: fc.constantFrom('Fixed' as const, 'Variable' as const)
          })
        }),
        fc.record({
          kind: fc.constant('number' as const),
          qualifiers: fc.record({
            digits: fc.integer({ min: 1, max: 38 }),
            fractionDigits: fc.integer({ min: 0, max: 10 }),
            allowedSign: fc.constantFrom('Any' as const, 'Nonnegative' as const)
          })
        }),
        fc.record({
          kind: fc.constant('boolean' as const)
        }),
        fc.record({
          kind: fc.constant('date' as const),
          qualifiers: fc.record({
            dateFractions: fc.constantFrom('Date' as const, 'DateTime' as const, 'Time' as const)
          })
        })
      ),
      { minLength: 2, maxLength: 4 } // Composite must have at least 2 types
    );

    fc.assert(
      fc.property(compositeTypeArb, (types) => {
        const typeDefinition: TypeDefinition = {
          category: 'composite',
          types: types as any[]
        };

        const getWebviewContent = (typeEditorProvider as any).getWebviewContent.bind(typeEditorProvider);
        const html = getWebviewContent(typeDefinition);

        // Property: The editor should display composite type correctly
        const hasCompositeChecked = html.includes('value="composite" checked');
        const hasCompositeActive = html.includes('id="config-composite"');
        const hasPreview = html.includes('id="preview-value"');
        const hasPipeSeparator = html.includes('|'); // Multiple types separated by |
        const hasSaveButton = html.includes('id="save-btn"');
        const hasCancelButton = html.includes('id="cancel-btn"');

        return hasCompositeChecked && hasCompositeActive && hasPreview && 
               hasPipeSeparator && hasSaveButton && hasCancelButton;
      }),
      { numRuns: 30 }
    );
  });

  /**
   * Property-Based Test 2.14: Save message handler preserves any type definition
   * EXPECTED: PASS on unfixed code
   * Tests that save functionality works for any type definition
   */
  test('Property 2.14: Save handler preserves any type definition (Property-Based)', async () => {
    // Generator for any type definition
    const typeDefinitionArb = fc.oneof(
      // Primitive types
      fc.record({
        category: fc.constant('primitive' as const),
        types: fc.array(
          fc.oneof(
            fc.record({
              kind: fc.constant('string' as const),
              qualifiers: fc.record({
                length: fc.integer({ min: 1, max: 1024 }),
                allowedLength: fc.constantFrom('Fixed' as const, 'Variable' as const)
              })
            }),
            fc.record({
              kind: fc.constant('boolean' as const)
            })
          ),
          { minLength: 1, maxLength: 1 }
        )
      }),
      // Reference types
      fc.record({
        category: fc.constant('reference' as const),
        types: fc.array(
          fc.record({
            kind: fc.constant('reference' as const),
            referenceType: fc.record({
              referenceKind: fc.constantFrom('CatalogRef' as const, 'DocumentRef' as const),
              objectName: fc.string({ minLength: 1, maxLength: 20 }).filter(s => !s.includes('"'))
            })
          }),
          { minLength: 1, maxLength: 1 }
        )
      })
    );

    await fc.assert(
      fc.asyncProperty(typeDefinitionArb, async (typeDefinition) => {
        const handleMessage = (typeEditorProvider as any).handleMessage.bind(typeEditorProvider);
        
        let savedDefinition: TypeDefinition | null = null;
        (typeEditorProvider as any).resolvePromise = (result: TypeDefinition) => {
          savedDefinition = result;
        };

        await handleMessage({
          type: 'save',
          typeDefinition: typeDefinition as any
        });

        // Property: Save handler should preserve the type definition
        if (!savedDefinition) return false;
        const saved = savedDefinition as TypeDefinition;
        
        const isPreserved = 
          saved.category === typeDefinition.category &&
          saved.types.length === typeDefinition.types.length;

        return isPreserved;
      }),
      { numRuns: 30 }
    );
  });

  /**
   * Test 2.15: Editor JavaScript event handlers are wired correctly
   * EXPECTED: PASS on unfixed code
   * Ensures event handling continues to work
   */
  test('Property 2.15: Editor JavaScript has event handlers for UI interactions', () => {
    const typeDefinition: TypeDefinition = {
      category: 'primitive',
      types: [{
        kind: 'string',
        qualifiers: {
          length: 50,
          allowedLength: 'Variable'
        }
      }]
    };

    const getWebviewContent = (typeEditorProvider as any).getWebviewContent.bind(typeEditorProvider);
    const html = getWebviewContent(typeDefinition);

    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch, 'Script section should exist');
    
    const scriptContent = scriptMatch![1];
    
    // Verify event listeners are set up
    assert.ok(
      scriptContent.includes('addEventListener'),
      'Event listeners should be set up'
    );
    
    // Verify vscode API is used for messaging
    assert.ok(
      scriptContent.includes('vscode.postMessage'),
      'vscode.postMessage should be used for communication'
    );
    
    // Verify Save button has event listener
    assert.ok(
      scriptContent.includes('save-btn'),
      'Save button should have event handling'
    );
  });
});
