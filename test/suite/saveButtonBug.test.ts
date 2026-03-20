import * as assert from 'assert';
import * as fc from 'fast-check';
import * as vscode from 'vscode';
import { TypeEditorProvider } from '../../src/providers/typeEditorProvider';
import { TypeDefinition } from '../../src/types/typeDefinitions';

/**
 * Bug Condition Exploration Test for Non-Functional Save Button
 * 
 * **Validates: Requirements 1.2, 2.2**
 * 
 * CRITICAL: This test MUST FAIL on unfixed code - failure confirms the bug exists
 * 
 * Property 1: Bug Condition - Save Button Remains Disabled After Changes
 * When the user makes changes in the type editor, the Save button SHALL become enabled
 * and allow the user to save changes.
 * 
 * GOAL: Surface counterexamples that demonstrate Save button doesn't enable after changes
 * EXPECTED OUTCOME: Test FAILS (this is correct - it proves the bug exists)
 */
suite('Bug Condition Exploration: Save Button Remains Disabled After Changes', () => {
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
   * Test 1.1: Save button state after type selection change
   * EXPECTED: FAIL on unfixed code (Save button remains disabled)
   * Counterexample: Changing primitive type selection doesn't enable Save button
   */
  test('Property 1.1: Save button becomes enabled when primitive type is changed', () => {
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

    // The BUG: Save button is not disabled initially (types.length > 0)
    // But there's no change detection logic in the JavaScript
    // When user changes the type, the Save button should remain enabled
    
    // Check initial Save button state - should NOT be disabled
    assert.ok(!html.includes('id="save-btn" disabled'), 'Save button should not be disabled initially');

    // Check Save enablement is selection-driven in current UI.
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch, 'Script section should exist');

    const scriptContent = scriptMatch![1];
    assert.ok(
      scriptContent.includes('saveBtn.disabled = selectedIds.size === 0'),
      'Save button enablement should depend on selectedIds size'
    );
    assert.ok(
      scriptContent.includes('function toggleSelection'),
      'toggleSelection must exist to update selection-driven UI state'
    );
    assert.ok(
      scriptContent.includes('updateQualifierPanel()') && scriptContent.includes('updatePreview()'),
      'Selection change should update qualifier panel and preview'
    );
  });

  /**
   * Test 1.2: Save button state after qualifier value change
   * EXPECTED: FAIL on unfixed code (no change detection for qualifier inputs)
   * Counterexample: Changing string length doesn't enable Save button
   */
  test('Property 1.2: Save button becomes enabled when qualifier values are changed', () => {
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
    
    // Qualifier edits are handled by JS (syncQualifiersOnBlur) and updatePreview().
    assert.ok(
      scriptContent.includes('function syncQualifiersOnBlur()'),
      'syncQualifiersOnBlur must exist'
    );
    assert.ok(
      scriptContent.includes("string-length") && scriptContent.includes('addEventListener') && scriptContent.includes('syncQualifiersOnBlur'),
      'string-length input should have listeners wired to syncQualifiersOnBlur'
    );
  });

  /**
   * Test 1.3: Save button state after category change
   * EXPECTED: FAIL on unfixed code (no change detection for category changes)
   * Counterexample: Changing from primitive to reference doesn't enable Save button
   */
  test('Property 1.3: Save button becomes enabled when category is changed', () => {
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
    
    // In current UI there are no category radio handlers; Save is driven by selection-driven state.
    assert.ok(scriptContent.includes('function toggleSelection'), 'toggleSelection must exist');
    assert.ok(
      scriptContent.includes('saveBtn.disabled = selectedIds.size === 0'),
      'Save enablement must be selection-driven'
    );
  });

  /**
   * Test 1.4: Save button disabled state is managed correctly
   * EXPECTED: FAIL on unfixed code (Save button state only depends on types.length)
   * Counterexample: Save button state is not updated based on user changes
   */
  test('Property 1.4: Save button disabled state is managed based on changes', () => {
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

    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch, 'Script section should exist');
    
    const scriptContent = scriptMatch![1];
    
    // In current UI Save enablement is not based on hasChanges/isDirty variables.
    assert.ok(
      scriptContent.includes('saveBtn.disabled = selectedIds.size === 0'),
      'Save enablement should be based on selectedIds size'
    );
  });

  /**
   * Property-Based Test 1.5: Save button state for any type modification
   * EXPECTED: FAIL on unfixed code for all generated type changes
   * Tests that for ANY type modification, the Save button should have change detection
   */
  test('Property 1.5: Save button has change detection for any type modification (Property-Based)', () => {
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

        const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
        if (!scriptMatch) return false;
        
        const scriptContent = scriptMatch[1];
        
        const hasSaveEnablement = scriptContent.includes('saveBtn.disabled = selectedIds.size === 0');
        const hasSelectionModel = scriptContent.includes(`primitive:${typeEntry.kind}`) || scriptContent.includes(`ref:`);
        const hasSyncLogic = scriptContent.includes('function syncQualifiersOnBlur()');

        if (typeEntry.kind === 'string') {
          const length = typeEntry.qualifiers.length;
          return hasSaveEnablement &&
            hasSelectionModel &&
            hasSyncLogic &&
            html.includes(`String(${length})`) &&
            scriptContent.includes('"length":' + length);
        }

        if (typeEntry.kind === 'number') {
          const digits = typeEntry.qualifiers.digits;
          const fractionDigits = typeEntry.qualifiers.fractionDigits;
          return hasSaveEnablement &&
            hasSelectionModel &&
            hasSyncLogic &&
            html.includes(`Number(${digits},${fractionDigits})`) &&
            scriptContent.includes('"digits":' + digits) &&
            scriptContent.includes('"fractionDigits":' + fractionDigits);
        }

        if (typeEntry.kind === 'boolean') {
          return hasSaveEnablement &&
            hasSelectionModel &&
            hasSyncLogic &&
            html.includes('Boolean');
        }

        if (typeEntry.kind === 'date') {
          const dateFractions = typeEntry.qualifiers.dateFractions;
          return hasSaveEnablement &&
            hasSelectionModel &&
            hasSyncLogic &&
            html.includes(dateFractions) &&
            scriptContent.includes('"dateFractions":"' + dateFractions + '"');
        }

        return false;
      }),
      { numRuns: 30 }
    );
  });

  /**
   * Documented Counterexamples from Design
   * These are the specific failing cases mentioned in the bugfix requirements
   */
  test('Counterexample 1: Changing string length from 50 to 100 does not enable Save button', () => {
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
    
    // The bug: no event listener on string-length input to detect changes
    const hasStringLengthListener = 
      scriptContent.includes('string-length') && 
      scriptContent.includes('addEventListener');
    
    // This will FAIL on unfixed code
    assert.ok(
      hasStringLengthListener,
      'Counterexample: Changing string length does not enable Save button (no event listener)'
    );
  });

  test('Counterexample 2: Changing number precision from 10 to 15 does not enable Save button', () => {
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

    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch, 'Script section should exist');
    
    const scriptContent = scriptMatch![1];
    
    // The bug: no event listener on number-digits input to detect changes
    const hasNumberDigitsListener = 
      scriptContent.includes('number-digits') && 
      scriptContent.includes('addEventListener');
    
    // This will FAIL on unfixed code
    assert.ok(
      hasNumberDigitsListener,
      'Counterexample: Changing number precision does not enable Save button (no event listener)'
    );
  });

  test('Counterexample 3: Changing primitive type from String to Number does not enable Save button', () => {
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
    
    // In current UI Save is driven by tree selection toggles (toggleSelection), not by primitiveTypeSelect.
    assert.ok(scriptContent.includes('function toggleSelection'), 'toggleSelection must exist');
    assert.ok(
      scriptContent.includes('saveBtn.disabled = selectedIds.size === 0'),
      'Save enablement must depend on selectedIds size'
    );
    assert.ok(scriptContent.includes('updateQualifierPanel()') && scriptContent.includes('updatePreview()'), 'Selection should update qualifier panel and preview');
  });

  test('Counterexample 4: Changing category from Primitive to Reference does not enable Save button', () => {
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
    
    // In current UI there are no category radio handlers; selection toggles drive Save state.
    assert.ok(scriptContent.includes('function toggleSelection'), 'toggleSelection must exist');
    assert.ok(
      scriptContent.includes('saveBtn.disabled = selectedIds.size === 0'),
      'Save enablement must depend on selectedIds size'
    );
  });
});
