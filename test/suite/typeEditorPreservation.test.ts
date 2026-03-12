import * as assert from 'assert';
import * as fc from 'fast-check';
import * as vscode from 'vscode';
import { TypeEditorProvider } from '../../src/providers/typeEditorProvider';
import { TypeDefinition, TypeEntry } from '../../src/types/typeDefinitions';

/**
 * Preservation Property Tests for Type Editor
 * 
 * **Validates: Requirements 3.1, 3.2, 3.4**
 * 
 * IMPORTANT: Follow observation-first methodology
 * These tests observe behavior on UNFIXED code for non-qualifier-related functionality
 * 
 * Property 2: Preservation - Existing Type Editor Behavior
 * These tests ensure that existing functionality (non-qualifier-related) continues to work
 * after the fix is implemented.
 * 
 * EXPECTED OUTCOME: Tests PASS on unfixed code (confirms baseline behavior to preserve)
 */
suite('Preservation Property Tests: Existing Type Editor Behavior', () => {
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
   * Test 2.1: Type editor opens and displays current type configuration correctly
   * EXPECTED: PASS on unfixed code
   * Requirement 3.1: WHEN the user opens the type editor THEN the system SHALL CONTINUE TO 
   * display the current type configuration correctly
   */
  test('Property 2.1: Type editor displays current primitive type configuration correctly', () => {
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

    // Verify category is correctly set
    assert.ok(
      html.includes('value="primitive" checked'),
      'Primitive category should be selected'
    );

    // Verify type configuration area exists
    assert.ok(
      html.includes('id="config-primitive"'),
      'Primitive config section should exist'
    );
    assert.ok(
      html.includes('class="config-section active"'),
      'Primitive config section should be active'
    );

    // Verify type selector exists with options
    assert.ok(html.includes('id="primitive-type"'), 'Primitive type selector should exist');
    assert.ok(html.includes('value="string"'), 'String option should exist');
    assert.ok(html.includes('value="number"'), 'Number option should exist');
    assert.ok(html.includes('value="boolean"'), 'Boolean option should exist');
    assert.ok(html.includes('value="date"'), 'Date option should exist');

    // Verify preview section exists
    assert.ok(html.includes('id="preview-value"'), 'Preview section should exist');
    assert.ok(html.includes('String(100)'), 'Preview should show current type');
  });

  /**
   * Test 2.2: Type editor displays reference type configuration correctly
   * EXPECTED: PASS on unfixed code
   */
  test('Property 2.2: Type editor displays current reference type configuration correctly', () => {
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

    // Verify category is correctly set
    assert.ok(
      html.includes('value="reference" checked'),
      'Reference category should be selected'
    );

    // Verify reference config section is active
    assert.ok(
      html.includes('id="config-reference"'),
      'Reference config section should exist'
    );

    // Verify reference kind selector exists
    assert.ok(html.includes('id="reference-kind"'), 'Reference kind selector should exist');
    assert.ok(html.includes('value="CatalogRef"'), 'CatalogRef option should exist');
    assert.ok(html.includes('value="DocumentRef"'), 'DocumentRef option should exist');

    // Verify object name input exists
    assert.ok(html.includes('id="reference-object"'), 'Reference object input should exist');
    assert.ok(html.includes('value="Products"'), 'Object name should be populated');
  });

  /**
   * Test 2.3: Selecting different primitive types updates available options
   * EXPECTED: PASS on unfixed code
   * Requirement 3.2: WHEN the user selects different primitive types THEN the system SHALL 
   * CONTINUE TO update the available type options appropriately
   */
  test('Property 2.3: Primitive type selector contains all expected type options', () => {
    const typeDefinition: TypeDefinition = {
      category: 'primitive',
      types: [{
        kind: 'boolean'
      }]
    };

    const getWebviewContent = (typeEditorProvider as any).getWebviewContent.bind(typeEditorProvider);
    const html = getWebviewContent(typeDefinition);

    // Verify all primitive type options are available
    const primitiveTypeMatch = html.match(/<select id="primitive-type">([\s\S]*?)<\/select>/);
    assert.ok(primitiveTypeMatch, 'Primitive type selector should exist');

    const selectContent = primitiveTypeMatch![1];
    
    // Check all expected options exist
    assert.ok(selectContent.includes('value="string"'), 'String option should be available');
    assert.ok(selectContent.includes('value="number"'), 'Number option should be available');
    assert.ok(selectContent.includes('value="boolean"'), 'Boolean option should be available');
    assert.ok(selectContent.includes('value="date"'), 'Date option should be available');

    // Verify the selector has proper structure
    assert.ok(selectContent.includes('<option'), 'Options should be properly formatted');
  });

  /**
   * Test 2.4: Composite types display all selected types in the list
   * EXPECTED: PASS on unfixed code
   * Requirement 3.4: WHEN the type editor displays composite types THEN the system SHALL 
   * CONTINUE TO show all selected types in the type list
   */
  test('Property 2.4: Composite type editor displays all types in the list', () => {
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
        },
        {
          kind: 'boolean'
        }
      ]
    };

    const getWebviewContent = (typeEditorProvider as any).getWebviewContent.bind(typeEditorProvider);
    const html = getWebviewContent(typeDefinition);

    // Verify category is correctly set
    assert.ok(
      html.includes('value="composite" checked'),
      'Composite category should be selected'
    );

    // Verify composite config section is active
    assert.ok(
      html.includes('id="config-composite"'),
      'Composite config section should exist'
    );

    // Verify composite list exists
    assert.ok(html.includes('id="composite-list"'), 'Composite list should exist');

    // Verify preview shows all types
    const previewMatch = html.match(/<div id="preview-value" class="preview-value">(.*?)<\/div>/);
    assert.ok(previewMatch, 'Preview should exist');
    
    const previewContent = previewMatch![1];
    assert.ok(previewContent.includes('String(50)'), 'Preview should show String type');
    assert.ok(previewContent.includes('Number(10,2)'), 'Preview should show Number type');
    assert.ok(previewContent.includes('Boolean'), 'Preview should show Boolean type');
    assert.ok(previewContent.includes('|'), 'Preview should separate types with |');
  });

  /**
   * Test 2.5: Category selector displays all three categories
   * EXPECTED: PASS on unfixed code
   */
  test('Property 2.5: Category selector displays all available categories', () => {
    const typeDefinition: TypeDefinition = {
      category: 'primitive',
      types: [{
        kind: 'string',
        qualifiers: {
          length: 10,
          allowedLength: 'Fixed'
        }
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

    // Verify they are radio buttons
    assert.ok(
      html.includes('type="radio" name="category"'),
      'Category options should be radio buttons'
    );
  });

  /**
   * Test 2.6: Save and Cancel buttons are present
   * EXPECTED: PASS on unfixed code
   */
  test('Property 2.6: Save and Cancel buttons are present in the editor', () => {
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
    
    // Verify Cancel button exists
    assert.ok(html.includes('id="cancel-btn"'), 'Cancel button should exist');

    // Verify button row exists
    assert.ok(html.includes('class="button-row"'), 'Button row should exist');
  });

  /**
   * Property-Based Test 2.7: Type editor correctly displays any primitive type configuration
   * EXPECTED: PASS on unfixed code
   * Tests that for ANY primitive type, the editor displays the configuration correctly
   */
  test('Property 2.7: Type editor displays any primitive type configuration (Property-Based)', () => {
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

        // Property: The editor should display the primitive category as selected
        const hasPrimitiveChecked = html.includes('value="primitive" checked');
        
        // Property: The primitive config section should be active
        const hasPrimitiveActive = html.includes('id="config-primitive"') && 
                                    html.includes('class="config-section active"');
        
        // Property: The type selector should exist
        const hasTypeSelector = html.includes('id="primitive-type"');
        
        // Property: The preview should exist
        const hasPreview = html.includes('id="preview-value"');

        return hasPrimitiveChecked && hasPrimitiveActive && hasTypeSelector && hasPreview;
      }),
      { numRuns: 50 }
    );
  });

  /**
   * Property-Based Test 2.8: Composite types display all types in preview
   * EXPECTED: PASS on unfixed code
   * Tests that for ANY composite type configuration, all types are shown in preview
   */
  test('Property 2.8: Composite types display all types in preview (Property-Based)', () => {
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

        // Property: The editor should display the composite category as selected
        const hasCompositeChecked = html.includes('value="composite" checked');
        
        // Property: The composite config section should be active
        const hasCompositeActive = html.includes('id="config-composite"');
        
        // Property: The preview should contain the pipe separator (for multiple types)
        const previewMatch = html.match(/<div id="preview-value" class="preview-value">(.*?)<\/div>/);
        const hasPreview = previewMatch !== null;
        const hasPipeSeparator = previewMatch ? previewMatch[1].includes('|') : false;

        return hasCompositeChecked && hasCompositeActive && hasPreview && hasPipeSeparator;
      }),
      { numRuns: 30 }
    );
  });

  /**
   * Property-Based Test 2.9: Reference types display configuration correctly
   * EXPECTED: PASS on unfixed code
   */
  test('Property 2.9: Reference types display configuration correctly (Property-Based)', () => {
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

        // Property: The editor should display the reference category as selected
        const hasReferenceChecked = html.includes('value="reference" checked');
        
        // Property: The reference config section should exist
        const hasReferenceConfig = html.includes('id="config-reference"');
        
        // Property: The reference kind selector should exist
        const hasReferenceKind = html.includes('id="reference-kind"');
        
        // Property: The object name input should exist and contain the value
        const hasObjectName = html.includes('id="reference-object"') && 
                              html.includes(`value="${refType.objectName}"`);

        return hasReferenceChecked && hasReferenceConfig && hasReferenceKind && hasObjectName;
      }),
      { numRuns: 30 }
    );
  });

  /**
   * Test 2.10: Empty type configuration displays correctly
   * EXPECTED: PASS on unfixed code
   */
  test('Property 2.10: Editor handles empty type configuration correctly', () => {
    const typeDefinition: TypeDefinition = {
      category: 'primitive',
      types: []
    };

    const getWebviewContent = (typeEditorProvider as any).getWebviewContent.bind(typeEditorProvider);
    const html = getWebviewContent(typeDefinition);

    // Verify editor still renders
    assert.ok(html.includes('id="config-primitive"'), 'Primitive config should exist');
    assert.ok(html.includes('id="preview-value"'), 'Preview should exist');
    
    // Verify Save button is disabled for empty configuration
    assert.ok(html.includes('id="save-btn" disabled'), 'Save button should be disabled for empty types');
  });
});
