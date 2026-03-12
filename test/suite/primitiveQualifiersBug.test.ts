import * as assert from 'assert';
import * as fc from 'fast-check';
import * as vscode from 'vscode';
import { TypeEditorProvider } from '../../src/providers/typeEditorProvider';
import { TypeDefinition } from '../../src/types/typeDefinitions';

/**
 * Bug Condition Exploration Test for Missing Primitive Qualifiers
 * 
 * **Validates: Requirements 1.1, 2.1**
 * 
 * CRITICAL: This test MUST FAIL on unfixed code - failure confirms the bug exists
 * 
 * Property 1: Bug Condition - Primitive Type Qualifiers Not Displayed
 * When editing a primitive type attribute, the system SHALL display appropriate
 * qualifier fields based on the primitive type:
 * - String: length qualifier field
 * - Number: precision/scale (digits/fractionDigits) qualifier fields
 * - Date: date parts (dateFractions) qualifier field
 * 
 * GOAL: Surface counterexamples that demonstrate qualifier fields are missing
 * EXPECTED OUTCOME: Test FAILS (this is correct - it proves the bug exists)
 */
suite('Bug Condition Exploration: Primitive Type Qualifiers Not Displayed', () => {
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
   * Test 1: String qualifier fields presence in HTML
   * EXPECTED: FAIL on unfixed code (qualifier fields exist but are hidden)
   * Counterexample: String length qualifier field is not visible in the type editor
   */
  test('Property 1.1: String length qualifier field is visible in type editor', () => {
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

    // Get the webview HTML content
    const getWebviewContent = (typeEditorProvider as any).getWebviewContent.bind(typeEditorProvider);
    const html = getWebviewContent(typeDefinition);

    // Verify qualifier fields exist in HTML
    assert.ok(html.includes('id="string-qualifiers"'), 'String qualifiers section should exist');
    assert.ok(html.includes('id="string-length"'), 'String length input should exist');
    assert.ok(html.includes('id="string-allowed-length"'), 'String allowed length select should exist');

    // The BUG: qualifier fields exist but have CSS class that hides them
    // Check if the qualifier group is marked as active (visible)
    const stringQualifiersMatch = html.match(/<div[^>]*id="string-qualifiers"[^>]*class="([^"]*)"[^>]*>/);
    assert.ok(stringQualifiersMatch, 'String qualifiers div should be found');
    
    const classes = stringQualifiersMatch![1];
    
    // This will FAIL on unfixed code: the 'active' class is missing
    assert.ok(
      classes.includes('active'),
      'String qualifiers should have "active" class to be visible'
    );
  });

  /**
   * Test 2: Number qualifier fields presence in HTML
   * EXPECTED: FAIL on unfixed code (qualifier fields exist but are hidden)
   * Counterexample: Number precision/scale qualifier fields are not visible
   */
  test('Property 1.2: Number precision/scale qualifier fields are visible in type editor', () => {
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

    // Verify qualifier fields exist in HTML
    assert.ok(html.includes('id="number-qualifiers"'), 'Number qualifiers section should exist');
    assert.ok(html.includes('id="number-digits"'), 'Number digits input should exist');
    assert.ok(html.includes('id="number-fraction-digits"'), 'Number fraction digits input should exist');
    assert.ok(html.includes('id="number-allowed-sign"'), 'Number allowed sign select should exist');

    // Check if the qualifier group is marked as active (visible)
    const numberQualifiersMatch = html.match(/<div[^>]*id="number-qualifiers"[^>]*class="([^"]*)"[^>]*>/);
    assert.ok(numberQualifiersMatch, 'Number qualifiers div should be found');
    
    const classes = numberQualifiersMatch![1];
    
    // This will FAIL on unfixed code: the 'active' class is missing
    assert.ok(
      classes.includes('active'),
      'Number qualifiers should have "active" class to be visible'
    );
  });

  /**
   * Test 3: Date qualifier fields presence in HTML
   * EXPECTED: FAIL on unfixed code (qualifier fields exist but are hidden)
   * Counterexample: Date parts qualifier field is not visible
   */
  test('Property 1.3: Date parts qualifier field is visible in type editor', () => {
    const typeDefinition: TypeDefinition = {
      category: 'primitive',
      types: [{
        kind: 'date',
        qualifiers: {
          dateFractions: 'DateTime'
        }
      }]
    };

    const getWebviewContent = (typeEditorProvider as any).getWebviewContent.bind(typeEditorProvider);
    const html = getWebviewContent(typeDefinition);

    // Verify qualifier fields exist in HTML
    assert.ok(html.includes('id="date-qualifiers"'), 'Date qualifiers section should exist');
    assert.ok(html.includes('id="date-fractions"'), 'Date fractions select should exist');

    // Check if the qualifier group is marked as active (visible)
    const dateQualifiersMatch = html.match(/<div[^>]*id="date-qualifiers"[^>]*class="([^"]*)"[^>]*>/);
    assert.ok(dateQualifiersMatch, 'Date qualifiers div should be found');
    
    const classes = dateQualifiersMatch![1];
    
    // This will FAIL on unfixed code: the 'active' class is missing
    assert.ok(
      classes.includes('active'),
      'Date qualifiers should have "active" class to be visible'
    );
  });

  /**
   * Test 4: Boolean type has no qualifiers (control test)
   * EXPECTED: PASS on both fixed and unfixed code
   * Boolean types don't have qualifiers, so no qualifier group should be active
   */
  test('Property 1.4: Boolean type has no qualifier fields (control test)', () => {
    const typeDefinition: TypeDefinition = {
      category: 'primitive',
      types: [{
        kind: 'boolean'
      }]
    };

    const getWebviewContent = (typeEditorProvider as any).getWebviewContent.bind(typeEditorProvider);
    const html = getWebviewContent(typeDefinition);

    // Boolean should not have any active qualifier groups
    const stringQualifiersMatch = html.match(/<div[^>]*id="string-qualifiers"[^>]*class="([^"]*)"[^>]*>/);
    const numberQualifiersMatch = html.match(/<div[^>]*id="number-qualifiers"[^>]*class="([^"]*)"[^>]*>/);
    const dateQualifiersMatch = html.match(/<div[^>]*id="date-qualifiers"[^>]*class="([^"]*)"[^>]*>/);

    // None of the qualifier groups should be active for boolean
    if (stringQualifiersMatch) {
      assert.ok(!stringQualifiersMatch[1].includes('active'), 'String qualifiers should not be active for boolean');
    }
    if (numberQualifiersMatch) {
      assert.ok(!numberQualifiersMatch[1].includes('active'), 'Number qualifiers should not be active for boolean');
    }
    if (dateQualifiersMatch) {
      assert.ok(!dateQualifiersMatch[1].includes('active'), 'Date qualifiers should not be active for boolean');
    }
  });

  /**
   * Property-Based Test: Qualifier fields visibility for any primitive type with qualifiers
   * EXPECTED: FAIL on unfixed code for all generated primitive types
   * Tests that for ANY primitive type with qualifiers, the qualifier fields are visible
   */
  test('Property 1.5: Qualifier fields are visible for any primitive type (Property-Based)', () => {
    // Generator for primitive types with qualifiers
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

        // Determine which qualifier group should be active based on type
        let qualifierIdToCheck: string;
        switch (typeEntry.kind) {
          case 'string':
            qualifierIdToCheck = 'string-qualifiers';
            break;
          case 'number':
            qualifierIdToCheck = 'number-qualifiers';
            break;
          case 'date':
            qualifierIdToCheck = 'date-qualifiers';
            break;
          default:
            return false;
        }

        // Check if the appropriate qualifier group is active
        const regex = new RegExp(`<div[^>]*id="${qualifierIdToCheck}"[^>]*class="([^"]*)"[^>]*>`);
        const match = html.match(regex);
        
        if (!match) return false;
        
        const classes = match[1];
        
        // Property: The qualifier group for the selected type should have 'active' class
        return classes.includes('active');
      }),
      { numRuns: 30 }
    );
  });

  /**
   * Documented Counterexamples from Design
   * These are the specific failing cases mentioned in the bugfix requirements
   */
  test('Counterexample 1: String(50) type does not show length qualifier field', () => {
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

    // The bug: qualifier fields exist in HTML but are hidden (no 'active' class)
    const stringQualifiersMatch = html.match(/<div[^>]*id="string-qualifiers"[^>]*class="([^"]*)"[^>]*>/);
    assert.ok(stringQualifiersMatch, 'String qualifiers div should exist');
    
    const classes = stringQualifiersMatch![1];
    
    // This will FAIL on unfixed code
    assert.ok(
      classes.includes('active'),
      'Counterexample: String length qualifier field is not visible (missing "active" class)'
    );
  });

  test('Counterexample 2: Number(10,2) type does not show precision/scale qualifier fields', () => {
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

    const numberQualifiersMatch = html.match(/<div[^>]*id="number-qualifiers"[^>]*class="([^"]*)"[^>]*>/);
    assert.ok(numberQualifiersMatch, 'Number qualifiers div should exist');
    
    const classes = numberQualifiersMatch![1];
    
    // This will FAIL on unfixed code
    assert.ok(
      classes.includes('active'),
      'Counterexample: Number precision/scale qualifier fields are not visible (missing "active" class)'
    );
  });

  test('Counterexample 3: Date type does not show date parts qualifier field', () => {
    const typeDefinition: TypeDefinition = {
      category: 'primitive',
      types: [{
        kind: 'date',
        qualifiers: {
          dateFractions: 'DateTime'
        }
      }]
    };

    const getWebviewContent = (typeEditorProvider as any).getWebviewContent.bind(typeEditorProvider);
    const html = getWebviewContent(typeDefinition);

    const dateQualifiersMatch = html.match(/<div[^>]*id="date-qualifiers"[^>]*class="([^"]*)"[^>]*>/);
    assert.ok(dateQualifiersMatch, 'Date qualifiers div should exist');
    
    const classes = dateQualifiersMatch![1];
    
    // This will FAIL on unfixed code
    assert.ok(
      classes.includes('active'),
      'Counterexample: Date parts qualifier field is not visible (missing "active" class)'
    );
  });
});
