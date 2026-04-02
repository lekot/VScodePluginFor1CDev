import * as path from 'path';
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

    typeEditorProvider = new TypeEditorProvider(mockContext);
  });

  teardown(() => {
    typeEditorProvider.dispose();
  });

  function extractScript(html: string): string {
    const scriptMatch = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/i);
    assert.ok(scriptMatch, 'Script section should exist');
    return scriptMatch![1];
  }

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

    // Verify editor renders correctly (current UI is tree-based, no radio category controls).
    assert.ok(html.includes('id="preview-value"'), 'Preview section should exist');
    assert.ok(html.includes('String(100)'), 'Preview should include the current primitive qualifier formatting');

    const script = extractScript(html);
    assert.ok(script.includes('primitive:string'), 'SelectedIds should include primitive:string');
    assert.ok(script.includes('"length":100'), 'Qualifier state should include string length');
    assert.ok(script.includes('"allowedLength":"Variable"'), 'Qualifier state should include allowedLength');
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

    // Current UI represents categories as:
    // - primitives inside the type tree
    // - reference kinds as tree groups (even when referenceableObjects is empty)
    // - composite via the composite checkbox
    assert.ok(html.includes('primitive:string'), 'Type tree must include primitive nodes');
    assert.ok(html.includes('group:CatalogRef'), 'Type tree must include reference groups');
    assert.ok(html.includes('group:DocumentRef'), 'Type tree must include reference groups');
    assert.ok(html.includes('id="composite-cb"'), 'Composite checkbox must exist');
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

    assert.ok(html.includes('id="type-tree"'), 'Type tree should exist');
    assert.ok(html.includes('primitive:string'), 'Tree data must include primitive:string');
    assert.ok(html.includes('primitive:number'), 'Tree data must include primitive:number');
    assert.ok(html.includes('primitive:boolean'), 'Tree data must include primitive:boolean');
    assert.ok(html.includes('primitive:date'), 'Tree data must include primitive:date');
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
    assert.ok(html.includes('Сохранить'), 'Save button should have "Сохранить" text');
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

    // Verify reference configuration is displayed (current UI uses JS selection state)
    assert.ok(html.includes('id="preview-value"'), 'Preview section should exist');
    assert.ok(html.includes('CatalogRef.Products'), 'Preview should show current reference type');

    const script = extractScript(html);
    assert.ok(script.includes('ref:CatalogRef:Products'), 'SelectedIds should include ref:CatalogRef:Products');
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

    // Verify composite configuration is displayed (current UI uses composite checkbox)
    assert.ok(
      html.includes('id="composite-cb" checked'),
      'Composite checkbox should be checked for multi-type definitions'
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
    const primitiveScript = extractScript(primitiveHtml);
    assert.ok(
      primitiveScript.includes('primitive:string'),
      'Primitive state should be tracked via selectedIds'
    );

    // Test reference type state
    const referenceHtml = getWebviewContent(referenceType);
    const referenceScript = extractScript(referenceHtml);
    assert.ok(
      referenceScript.includes('ref:CatalogRef:Items'),
      'Reference state should be tracked via selectedIds'
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

        const script = extractScript(html);
        const hasPreview = html.includes('id="preview-value"');
        const hasSelected = script.includes(`primitive:${typeEntry.kind}`);
        const hasSaveButton = html.includes('id="save-btn"');
        const hasCancelButton = html.includes('id="cancel-btn"');

        if (typeEntry.kind === 'string') {
          const length = (typeEntry.qualifiers as any).length;
          return hasPreview && hasSelected && hasSaveButton && hasCancelButton && html.includes(`String(${length})`);
        }
        if (typeEntry.kind === 'number') {
          const digits = (typeEntry.qualifiers as any).digits;
          const fractionDigits = (typeEntry.qualifiers as any).fractionDigits;
          return hasPreview && hasSelected && hasSaveButton && hasCancelButton && html.includes(`Number(${digits},${fractionDigits})`);
        }
        if (typeEntry.kind === 'boolean') {
          return hasPreview && hasSelected && hasSaveButton && hasCancelButton && html.includes('Boolean');
        }
        if (typeEntry.kind === 'date') {
          const dateFractions = (typeEntry.qualifiers as any).dateFractions;
          return hasPreview && hasSelected && hasSaveButton && hasCancelButton && html.includes(dateFractions);
        }

        return false;
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
      objectName: fc.string({ minLength: 1, maxLength: 50 }).filter(
        (s) =>
          !s.includes('"') &&
          !s.includes("'") &&
          !s.includes('<') &&
          !s.includes('&') &&
          !s.includes('>') &&
          !s.includes('\\') &&
          s.trim().length > 0
      )
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

        const script = extractScript(html);
        const hasSaveButton = html.includes('id="save-btn"');
        const hasCancelButton = html.includes('id="cancel-btn"');
        const hasPreview = html.includes('id="preview-value"') && html.includes(`${refType.referenceKind}.${refType.objectName}`);
        const hasSelected = script.includes(`ref:${refType.referenceKind}:${refType.objectName}`);

        return hasPreview && hasSelected && hasSaveButton && hasCancelButton;
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

        const hasCompositeChecked = html.includes('id="composite-cb" checked');
        const hasPreview = html.includes('id="preview-value"');
        const hasPipeSeparator = html.includes('|'); // Multiple types separated by |
        const hasSaveButton = html.includes('id="save-btn"');
        const hasCancelButton = html.includes('id="cancel-btn"');

        return hasCompositeChecked && hasPreview && hasPipeSeparator && hasSaveButton && hasCancelButton;
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
              objectName: fc.string({ minLength: 1, maxLength: 20 }).filter(
                (s) => !s.includes('"') && !s.includes('<') && !s.includes('&') && !s.includes('>') && !s.includes('\\')
              )
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
