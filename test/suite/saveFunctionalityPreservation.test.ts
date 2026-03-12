import * as assert from 'assert';
import * as fc from 'fast-check';
import * as vscode from 'vscode';
import { TypeEditorProvider } from '../../src/providers/typeEditorProvider';
import { TypeDefinition, TypeEntry } from '../../src/types/typeDefinitions';

/**
 * Preservation Property Tests for Save Functionality
 * 
 * **Validates: Requirements 3.3**
 * 
 * IMPORTANT: Follow observation-first methodology
 * These tests observe behavior on UNFIXED code for save-related functionality
 * 
 * Property 2: Preservation - Existing Save Behavior
 * These tests ensure that existing save functionality (when it works) continues to work
 * after the fix is implemented.
 * 
 * EXPECTED OUTCOME: Tests PASS on unfixed code (confirms baseline behavior to preserve)
 */
suite('Preservation Property Tests: Existing Save Behavior', () => {
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
   * Test 2.1: Save message handler accepts valid type definitions
   * EXPECTED: PASS on unfixed code
   * Requirement 3.3: WHEN the user saves valid changes THEN the system SHALL CONTINUE TO 
   * persist the type configuration to the metadata file
   */
  test('Property 2.1: Save handler accepts valid primitive type definitions', async () => {
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

    // Simulate the save flow
    const handleMessage = (typeEditorProvider as any).handleMessage.bind(typeEditorProvider);
    
    // Set up a promise to capture the result
    let savedDefinition: TypeDefinition | null = null;
    (typeEditorProvider as any).resolvePromise = (result: TypeDefinition) => {
      savedDefinition = result;
    };

    // Send save message
    await handleMessage({
      type: 'save',
      typeDefinition: typeDefinition
    });

    // Verify the type definition was accepted
    assert.ok(savedDefinition !== null, 'Save handler should accept valid type definition');
    assert.ok(savedDefinition, 'Saved definition should exist');
    const saved = savedDefinition as TypeDefinition;
    assert.strictEqual(saved.category, 'primitive', 'Category should be preserved');
    assert.strictEqual(saved.types.length, 1, 'Type count should be preserved');
    assert.strictEqual(saved.types[0].kind, 'string', 'Type kind should be preserved');
  });

  /**
   * Test 2.2: Save handler rejects empty type definitions
   * EXPECTED: PASS on unfixed code
   * Ensures validation logic continues to work
   */
  test('Property 2.2: Save handler rejects empty type definitions', async () => {
    const typeDefinition: TypeDefinition = {
      category: 'primitive',
      types: [] // Empty types array
    };

    // Simulate the save flow
    const handleMessage = (typeEditorProvider as any).handleMessage.bind(typeEditorProvider);
    
    // Set up a promise to capture the result
    let savedDefinition: TypeDefinition | null = null;
    (typeEditorProvider as any).resolvePromise = (result: TypeDefinition) => {
      savedDefinition = result;
    };

    // Send save message
    await handleMessage({
      type: 'save',
      typeDefinition: typeDefinition
    });

    // Verify the empty type definition was rejected
    assert.strictEqual(savedDefinition, null, 'Save handler should reject empty type definitions');
  });

  /**
   * Test 2.3: Save handler preserves all type qualifiers
   * EXPECTED: PASS on unfixed code
   * Ensures qualifier data is not lost during save
   */
  test('Property 2.3: Save handler preserves string type qualifiers', async () => {
    const typeDefinition: TypeDefinition = {
      category: 'primitive',
      types: [{
        kind: 'string',
        qualifiers: {
          length: 250,
          allowedLength: 'Fixed'
        }
      }]
    };

    const handleMessage = (typeEditorProvider as any).handleMessage.bind(typeEditorProvider);
    
    let savedDefinition: TypeDefinition | null = null;
    (typeEditorProvider as any).resolvePromise = (result: TypeDefinition) => {
      savedDefinition = result;
    };

    await handleMessage({
      type: 'save',
      typeDefinition: typeDefinition
    });

    // Verify qualifiers are preserved
    assert.ok(savedDefinition !== null, 'Type definition should be saved');
    const saved = savedDefinition as TypeDefinition;
    const qualifiers = saved.types[0].qualifiers as any;
    assert.strictEqual(qualifiers?.length, 250, 'Length qualifier should be preserved');
    assert.strictEqual(qualifiers?.allowedLength, 'Fixed', 'AllowedLength qualifier should be preserved');
  });

  /**
   * Test 2.4: Save handler preserves number type qualifiers
   * EXPECTED: PASS on unfixed code
   */
  test('Property 2.4: Save handler preserves number type qualifiers', async () => {
    const typeDefinition: TypeDefinition = {
      category: 'primitive',
      types: [{
        kind: 'number',
        qualifiers: {
          digits: 15,
          fractionDigits: 4,
          allowedSign: 'Nonnegative'
        }
      }]
    };

    const handleMessage = (typeEditorProvider as any).handleMessage.bind(typeEditorProvider);
    
    let savedDefinition: TypeDefinition | null = null;
    (typeEditorProvider as any).resolvePromise = (result: TypeDefinition) => {
      savedDefinition = result;
    };

    await handleMessage({
      type: 'save',
      typeDefinition: typeDefinition
    });

    // Verify qualifiers are preserved
    assert.ok(savedDefinition !== null, 'Type definition should be saved');
    const saved = savedDefinition as TypeDefinition;
    const qualifiers = saved.types[0].qualifiers as any;
    assert.strictEqual(qualifiers?.digits, 15, 'Digits qualifier should be preserved');
    assert.strictEqual(qualifiers?.fractionDigits, 4, 'FractionDigits qualifier should be preserved');
    assert.strictEqual(qualifiers?.allowedSign, 'Nonnegative', 'AllowedSign qualifier should be preserved');
  });

  /**
   * Test 2.5: Save handler preserves date type qualifiers
   * EXPECTED: PASS on unfixed code
   */
  test('Property 2.5: Save handler preserves date type qualifiers', async () => {
    const typeDefinition: TypeDefinition = {
      category: 'primitive',
      types: [{
        kind: 'date',
        qualifiers: {
          dateFractions: 'DateTime'
        }
      }]
    };

    const handleMessage = (typeEditorProvider as any).handleMessage.bind(typeEditorProvider);
    
    let savedDefinition: TypeDefinition | null = null;
    (typeEditorProvider as any).resolvePromise = (result: TypeDefinition) => {
      savedDefinition = result;
    };

    await handleMessage({
      type: 'save',
      typeDefinition: typeDefinition
    });

    // Verify qualifiers are preserved
    assert.ok(savedDefinition !== null, 'Type definition should be saved');
    const saved = savedDefinition as TypeDefinition;
    const qualifiers = saved.types[0].qualifiers as any;
    assert.strictEqual(qualifiers?.dateFractions, 'DateTime', 'DateFractions qualifier should be preserved');
  });

  /**
   * Test 2.6: Save handler preserves reference type configuration
   * EXPECTED: PASS on unfixed code
   */
  test('Property 2.6: Save handler preserves reference type configuration', async () => {
    const typeDefinition: TypeDefinition = {
      category: 'reference',
      types: [{
        kind: 'reference',
        referenceType: {
          referenceKind: 'DocumentRef',
          objectName: 'SalesOrder'
        }
      }]
    };

    const handleMessage = (typeEditorProvider as any).handleMessage.bind(typeEditorProvider);
    
    let savedDefinition: TypeDefinition | null = null;
    (typeEditorProvider as any).resolvePromise = (result: TypeDefinition) => {
      savedDefinition = result;
    };

    await handleMessage({
      type: 'save',
      typeDefinition: typeDefinition
    });

    // Verify reference configuration is preserved
    assert.ok(savedDefinition !== null, 'Type definition should be saved');
    const saved = savedDefinition as TypeDefinition;
    assert.strictEqual(saved.types[0].referenceType?.referenceKind, 'DocumentRef', 'Reference kind should be preserved');
    assert.strictEqual(saved.types[0].referenceType?.objectName, 'SalesOrder', 'Object name should be preserved');
  });

  /**
   * Test 2.7: Save handler preserves composite type configurations
   * EXPECTED: PASS on unfixed code
   */
  test('Property 2.7: Save handler preserves composite type configurations', async () => {
    const typeDefinition: TypeDefinition = {
      category: 'composite',
      types: [
        {
          kind: 'string',
          qualifiers: {
            length: 100,
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
        },
        {
          kind: 'boolean'
        }
      ]
    };

    const handleMessage = (typeEditorProvider as any).handleMessage.bind(typeEditorProvider);
    
    let savedDefinition: TypeDefinition | null = null;
    (typeEditorProvider as any).resolvePromise = (result: TypeDefinition) => {
      savedDefinition = result;
    };

    await handleMessage({
      type: 'save',
      typeDefinition: typeDefinition
    });

    // Verify all types in composite are preserved
    assert.ok(savedDefinition !== null, 'Type definition should be saved');
    const saved = savedDefinition as TypeDefinition;
    assert.strictEqual(saved.category, 'composite', 'Composite category should be preserved');
    assert.strictEqual(saved.types.length, 3, 'All types should be preserved');
    assert.strictEqual(saved.types[0].kind, 'string', 'First type should be string');
    assert.strictEqual(saved.types[1].kind, 'number', 'Second type should be number');
    assert.strictEqual(saved.types[2].kind, 'boolean', 'Third type should be boolean');
  });

  /**
   * Property-Based Test 2.8: Save handler preserves any valid primitive type
   * EXPECTED: PASS on unfixed code
   * Tests that for ANY valid primitive type, the save handler preserves all data correctly
   */
  test('Property 2.8: Save handler preserves any valid primitive type (Property-Based)', async () => {
    // Generator for any primitive type with qualifiers
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

    await fc.assert(
      fc.asyncProperty(primitiveTypeArb, async (typeEntry) => {
        const typeDefinition: TypeDefinition = {
          category: 'primitive',
          types: [typeEntry as any]
        };

        const handleMessage = (typeEditorProvider as any).handleMessage.bind(typeEditorProvider);
        
        let savedDefinition: TypeDefinition | null = null;
        (typeEditorProvider as any).resolvePromise = (result: TypeDefinition) => {
          savedDefinition = result;
        };

        await handleMessage({
          type: 'save',
          typeDefinition: typeDefinition
        });

        // Property: The save handler should preserve the type definition
        if (!savedDefinition) return false;
        const saved = savedDefinition as TypeDefinition;
        
        const isPreserved = 
          saved.category === 'primitive' &&
          saved.types.length === 1 &&
          saved.types[0].kind === typeEntry.kind;

        // Property: Qualifiers should be preserved if they exist
        let qualifiersPreserved = true;
        if ('qualifiers' in typeEntry && typeEntry.qualifiers) {
          qualifiersPreserved = JSON.stringify(saved.types[0].qualifiers) === 
                                JSON.stringify(typeEntry.qualifiers);
        }

        return isPreserved && qualifiersPreserved;
      }),
      { numRuns: 50 }
    );
  });

  /**
   * Property-Based Test 2.9: Save handler preserves any valid composite type
   * EXPECTED: PASS on unfixed code
   * Tests that for ANY valid composite type, the save handler preserves all types
   */
  test('Property 2.9: Save handler preserves any valid composite type (Property-Based)', async () => {
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

    await fc.assert(
      fc.asyncProperty(compositeTypeArb, async (types) => {
        const typeDefinition: TypeDefinition = {
          category: 'composite',
          types: types as any[]
        };

        const handleMessage = (typeEditorProvider as any).handleMessage.bind(typeEditorProvider);
        
        let savedDefinition: TypeDefinition | null = null;
        (typeEditorProvider as any).resolvePromise = (result: TypeDefinition) => {
          savedDefinition = result;
        };

        await handleMessage({
          type: 'save',
          typeDefinition: typeDefinition
        });

        // Property: The save handler should preserve all types in the composite
        if (!savedDefinition) return false;
        const saved = savedDefinition as TypeDefinition;
        
        const isPreserved = 
          saved.category === 'composite' &&
          saved.types.length === types.length;

        // Property: Each type should be preserved with its qualifiers
        let allTypesPreserved = true;
        for (let i = 0; i < types.length; i++) {
          if (saved.types[i].kind !== types[i].kind) {
            allTypesPreserved = false;
            break;
          }
          if ('qualifiers' in types[i] && (types[i] as any).qualifiers) {
            const savedQualifiers = JSON.stringify(saved.types[i].qualifiers);
            const originalQualifiers = JSON.stringify((types[i] as any).qualifiers);
            if (savedQualifiers !== originalQualifiers) {
              allTypesPreserved = false;
              break;
            }
          }
        }

        return isPreserved && allTypesPreserved;
      }),
      { numRuns: 30 }
    );
  });

  /**
   * Property-Based Test 2.10: Save handler preserves any valid reference type
   * EXPECTED: PASS on unfixed code
   */
  test('Property 2.10: Save handler preserves any valid reference type (Property-Based)', async () => {
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

    await fc.assert(
      fc.asyncProperty(referenceTypeArb, async (refType) => {
        const typeDefinition: TypeDefinition = {
          category: 'reference',
          types: [{
            kind: 'reference',
            referenceType: refType
          }]
        };

        const handleMessage = (typeEditorProvider as any).handleMessage.bind(typeEditorProvider);
        
        let savedDefinition: TypeDefinition | null = null;
        (typeEditorProvider as any).resolvePromise = (result: TypeDefinition) => {
          savedDefinition = result;
        };

        await handleMessage({
          type: 'save',
          typeDefinition: typeDefinition
        });

        // Property: The save handler should preserve the reference type configuration
        if (!savedDefinition) return false;
        const saved = savedDefinition as TypeDefinition;
        
        const isPreserved = 
          saved.category === 'reference' &&
          saved.types.length === 1 &&
          saved.types[0].kind === 'reference' &&
          saved.types[0].referenceType?.referenceKind === refType.referenceKind &&
          saved.types[0].referenceType?.objectName === refType.objectName;

        return isPreserved;
      }),
      { numRuns: 30 }
    );
  });

  /**
   * Test 2.11: Save button is present in the webview
   * EXPECTED: PASS on unfixed code
   * Ensures the Save button UI element exists
   */
  test('Property 2.11: Save button is present in the webview', () => {
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

    // Verify Save button exists
    assert.ok(html.includes('id="save-btn"'), 'Save button should exist in webview');
    
    // Verify Save button has proper structure
    assert.ok(html.includes('<button'), 'Save button should be a button element');
    assert.ok(html.includes('Save'), 'Save button should have "Save" text');
  });

  /**
   * Test 2.12: Save button click handler is wired up
   * EXPECTED: PASS on unfixed code
   * Ensures the Save button has a click handler
   */
  test('Property 2.12: Save button has click handler in JavaScript', () => {
    const typeDefinition: TypeDefinition = {
      category: 'primitive',
      types: [{
        kind: 'boolean'
      }]
    };

    const getWebviewContent = (typeEditorProvider as any).getWebviewContent.bind(typeEditorProvider);
    const html = getWebviewContent(typeDefinition);

    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch, 'Script section should exist');
    
    const scriptContent = scriptMatch![1];
    
    // Verify Save button has event listener
    assert.ok(
      scriptContent.includes('save-btn') && scriptContent.includes('addEventListener'),
      'Save button should have event listener'
    );
    
    // Verify Save button click handler posts message
    assert.ok(
      scriptContent.includes('vscode.postMessage') && scriptContent.includes('save'),
      'Save button click handler should post save message'
    );
  });
});
