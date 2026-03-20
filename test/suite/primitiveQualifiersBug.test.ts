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

  function extractScript(html: string): string {
    const scriptMatch = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/i);
    assert.ok(scriptMatch, 'Script section should exist');
    return scriptMatch![1];
  }

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

    assert.ok(html.includes('id="preview-value"'), 'Preview section should exist');
    assert.ok(html.includes('String(50)'), 'Preview should show current String qualifier value');

    const script = extractScript(html);
    // Qualifier visibility is driven by JS (updateQualifierPanel), not static "active" class.
    assert.ok(script.includes('function updateQualifierPanel()'), 'updateQualifierPanel must exist');
    assert.ok(script.includes("g.classList.toggle('active', k === focusedKey)"), 'updateQualifierPanel must toggle qualifier active state');

    // Qualifier state is embedded and used by updateQualifierPanel()
    assert.ok(script.includes('"length":50'), 'Qualifier state should include length');
    assert.ok(script.includes('"allowedLength":"Variable"'), 'Qualifier state should include allowedLength');

    // JS should populate corresponding input values from qualifierState
    assert.ok(script.includes("lenEl.value = (q && q.length) != null ? q.length : ''"), 'string-length should be assigned from qualifierState');
    assert.ok(script.includes("allowedEl.value = (q && q.allowedLength) || 'Variable'"), 'string-allowed-length should be assigned from qualifierState');
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

    assert.ok(html.includes('id="preview-value"'), 'Preview section should exist');
    assert.ok(html.includes('Number(10,2)'), 'Preview should show current Number qualifier values');

    const script = extractScript(html);
    assert.ok(script.includes('function updateQualifierPanel()'), 'updateQualifierPanel must exist');
    assert.ok(script.includes("g.classList.toggle('active', k === focusedKey)"), 'updateQualifierPanel must toggle qualifier active state');

    assert.ok(script.includes('"digits":10'), 'Qualifier state should include digits');
    assert.ok(script.includes('"fractionDigits":2'), 'Qualifier state should include fractionDigits');
    assert.ok(script.includes('"allowedSign":"Any"'), 'Qualifier state should include allowedSign');

    assert.ok(script.includes("d.value = (q && q.digits) != null ? q.digits : ''"), 'number-digits should be assigned from qualifierState');
    assert.ok(script.includes("f.value = (q && q.fractionDigits) != null ? q.fractionDigits : ''"), 'number-fraction-digits should be assigned from qualifierState');
    assert.ok(script.includes("s.value = (q && q.allowedSign) || 'Any'"), 'number-allowed-sign should be assigned from qualifierState');
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

    assert.ok(html.includes('id="preview-value"'), 'Preview section should exist');
    assert.ok(html.includes('DateTime'), 'Preview should show current Date qualifier value');

    const script = extractScript(html);
    assert.ok(script.includes('function updateQualifierPanel()'), 'updateQualifierPanel must exist');
    assert.ok(script.includes("g.classList.toggle('active', k === focusedKey)"), 'updateQualifierPanel must toggle qualifier active state');

    assert.ok(script.includes('"dateFractions":"DateTime"'), 'Qualifier state should include dateFractions');
    assert.ok(script.includes("document.getElementById('date-fractions')"), 'date-fractions select should be populated in JS');
    assert.ok(script.includes("df.value = (q && q.dateFractions) || 'Date'"), 'date-fractions should be assigned from qualifierState');
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

    assert.ok(html.includes('id="preview-value"'), 'Preview section should exist');
    assert.ok(html.includes('Boolean'), 'Preview should show Boolean type');

    const script = extractScript(html);
    // For boolean there are no qualifiers => qualifierState should be an empty object.
    assert.ok(/let\s+qualifierState\s*=\s*{\s*};/.test(script), 'qualifierState should be empty for boolean');
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

        const script = extractScript(html);
        assert.ok(script.includes('function updateQualifierPanel()'), 'updateQualifierPanel must exist');
        assert.ok(script.includes("g.classList.toggle('active', k === focusedKey)"), 'updateQualifierPanel must toggle qualifier active state');

        // Selection should be driven by primitive:<kind> entries.
        if (!script.includes(`primitive:${typeEntry.kind}`)) return false;

        if (typeEntry.kind === 'string') {
          return html.includes(`String(${typeEntry.qualifiers.length})`) &&
            script.includes(`"length":${typeEntry.qualifiers.length}`) &&
            script.includes(`"allowedLength":"${typeEntry.qualifiers.allowedLength}"`);
        }

        if (typeEntry.kind === 'number') {
          return html.includes(`Number(${typeEntry.qualifiers.digits},${typeEntry.qualifiers.fractionDigits})`) &&
            script.includes(`"digits":${typeEntry.qualifiers.digits}`) &&
            script.includes(`"fractionDigits":${typeEntry.qualifiers.fractionDigits}`) &&
            script.includes(`"allowedSign":"${typeEntry.qualifiers.allowedSign}"`);
        }

        if (typeEntry.kind === 'date') {
          return html.includes(typeEntry.qualifiers.dateFractions) &&
            script.includes(`"dateFractions":"${typeEntry.qualifiers.dateFractions}"`);
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

    assert.ok(html.includes('String(50)'), 'Preview should show String(50)');
    const script = extractScript(html);
    assert.ok(script.includes('"length":50'), 'Qualifier state should include length');
    assert.ok(script.includes('"allowedLength":"Variable"'), 'Qualifier state should include allowedLength');
    assert.ok(script.includes('function updateQualifierPanel()'), 'updateQualifierPanel must exist');
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

    assert.ok(html.includes('Number(10,2)'), 'Preview should show Number(10,2)');
    const script = extractScript(html);
    assert.ok(script.includes('"digits":10'), 'Qualifier state should include digits');
    assert.ok(script.includes('"fractionDigits":2'), 'Qualifier state should include fractionDigits');
    assert.ok(script.includes('"allowedSign":"Any"'), 'Qualifier state should include allowedSign');
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

    assert.ok(html.includes('DateTime'), 'Preview should show DateTime');
    const script = extractScript(html);
    assert.ok(script.includes('"dateFractions":"DateTime"'), 'Qualifier state should include dateFractions');
  });
});
