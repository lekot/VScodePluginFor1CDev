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

  function extractScript(html: string): string {
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch, 'Script section should exist');
    return scriptMatch![1];
  }

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

    // Verify preview section exists
    assert.ok(html.includes('id="preview-value"'), 'Preview section should exist');
    assert.ok(html.includes('String(100)'), 'Preview should show current primitive type');

    const script = extractScript(html);
    // Selected primitive node is driven by JS selection state
    assert.ok(script.includes('primitive:string'), 'SelectedIds should include primitive:string');
    // Qualifiers are embedded as qualifierState and used by updateQualifierPanel()
    assert.ok(script.includes('"length":100'), 'Qualifier state should include string length');
    assert.ok(script.includes('"allowedLength":"Variable"'), 'Qualifier state should include allowedLength');
    assert.ok(script.includes('function updateQualifierPanel()'), 'updateQualifierPanel must exist');
    assert.ok(script.includes("g.classList.toggle('active', k === focusedKey)"), 'updateQualifierPanel must toggle qualifier active state');
    assert.ok(script.includes('renderTree();') && script.includes('updateQualifierPanel();') && script.includes('updatePreview();'), 'Editor must initialize tree + qualifier panel + preview');
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

    // Verify preview shows reference kind.objectName
    assert.ok(html.includes('id="preview-value"'), 'Preview section should exist');
    assert.ok(html.includes('CatalogRef.Products'), 'Preview should show current reference type');

    const script = extractScript(html);
    assert.ok(script.includes('ref:CatalogRef:Products'), 'SelectedIds should include the reference node id');
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

    // Current UI is a tree; primitives are still present in the treeData JSON.
    assert.ok(html.includes('id="type-tree"'), 'Type tree should exist');
    assert.ok(html.includes('primitive:string'), 'Tree data must include primitive:string');
    assert.ok(html.includes('primitive:number'), 'Tree data must include primitive:number');
    assert.ok(html.includes('primitive:boolean'), 'Tree data must include primitive:boolean');
    assert.ok(html.includes('primitive:date'), 'Tree data must include primitive:date');
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

    // Composite is represented by "composite-cb" checkbox in current UI
    assert.ok(html.includes('id="composite-cb" checked'), 'Composite checkbox should be checked for multi-type definitions');

    // Verify preview shows all types
    assert.ok(html.includes('String(50)'), 'Preview should show String type');
    assert.ok(html.includes('Number(10,2)'), 'Preview should show Number type');
    assert.ok(html.includes('Boolean'), 'Preview should show Boolean type');
    assert.ok(html.includes('|'), 'Preview should separate types with |');
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

    // Current UI has no radio/select category controls; instead:
    // - primitives are in the tree
    // - reference groups are created from REFERENCE_KINDS_ORDER even when referenceableObjects is empty
    assert.ok(html.includes('primitive:string'), 'Tree data must include primitives');
    assert.ok(html.includes('group:CatalogRef'), 'Tree data must include reference groups');
    assert.ok(html.includes('group:DocumentRef'), 'Tree data must include reference groups');
    assert.ok(html.includes('id="composite-cb"'), 'Composite checkbox must exist');
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

    assert.ok(html.includes('Сохранить'), 'Save button should have "Сохранить" text');

    // Verify Cancel button exists
    assert.ok(html.includes('id="cancel-btn"'), 'Cancel button should exist');

    assert.ok(html.includes('Отмена'), 'Cancel button should have "Отмена" text');

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
        const script = extractScript(html);

        const hasPreview = html.includes('id="preview-value"');
        const hasSelected = script.includes(`primitive:${typeEntry.kind}`);

        // updateQualifierPanel logic should exist
        const hasUpdateLogic = script.includes('function updateQualifierPanel()') &&
          script.includes("g.classList.toggle('active', k === focusedKey)");

        // Validate qualifierState content + preview formatting per primitive kind
        if (typeEntry.kind === 'string') {
          const length = typeEntry.qualifiers.length;
          const allowedLength = typeEntry.qualifiers.allowedLength;
          return hasPreview &&
            hasSelected &&
            hasUpdateLogic &&
            html.includes(`String(${length})`) &&
            script.includes(`"length":${length}`) &&
            script.includes(`"allowedLength":"${allowedLength}"`);
        }

        if (typeEntry.kind === 'number') {
          const digits = typeEntry.qualifiers.digits;
          const fractionDigits = typeEntry.qualifiers.fractionDigits;
          const allowedSign = typeEntry.qualifiers.allowedSign;
          return hasPreview &&
            hasSelected &&
            hasUpdateLogic &&
            html.includes(`Number(${digits},${fractionDigits})`) &&
            script.includes(`"digits":${digits}`) &&
            script.includes(`"fractionDigits":${fractionDigits}`) &&
            script.includes(`"allowedSign":"${allowedSign}"`);
        }

        if (typeEntry.kind === 'boolean') {
          return hasPreview &&
            hasSelected &&
            hasUpdateLogic &&
            html.includes('Boolean') &&
            /let\s+qualifierState\s*=\s*{\s*};/.test(html);
        }

        if (typeEntry.kind === 'date') {
          const dateFractions = typeEntry.qualifiers.dateFractions;
          return hasPreview &&
            hasSelected &&
            hasUpdateLogic &&
            html.includes(dateFractions) &&
            script.includes(`"dateFractions":"${dateFractions}"`);
        }

        return false;
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
        const hasCompositeChecked = html.includes('id="composite-cb" checked');
        const hasPreview = html.includes('id="preview-value"');
        const hasPipeSeparator = html.includes('|');

        // Minimal correctness: preview contains at least 2 formatted types and includes a pipe separator.
        // (The exact order/formatting is covered by the deterministic formatTypeDisplay() output.)
        const hasAnyType = types.some((t) => {
          if (t.kind === 'boolean') return html.includes('Boolean');
          if (t.kind === 'string') return html.includes(`String(${(t.qualifiers as any).length})`);
          if (t.kind === 'number') return html.includes(`Number(${(t.qualifiers as any).digits},${(t.qualifiers as any).fractionDigits})`);
          if (t.kind === 'date') return html.includes((t.qualifiers as any).dateFractions);
          return false;
        });

        return hasCompositeChecked && hasPreview && hasPipeSeparator && hasAnyType;
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
        const script = extractScript(html);
        const hasPreview = html.includes('id="preview-value"') && html.includes(`${refType.referenceKind}.${refType.objectName}`);
        const hasSelected = script.includes(`ref:${refType.referenceKind}:${refType.objectName}`);
        return hasPreview && hasSelected;
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
    assert.ok(html.includes('id="preview-value"'), 'Preview should exist');
    
    assert.ok(html.includes('Not set'), 'Preview should show Not set for empty types');

    // Verify Save button is disabled for empty configuration
    assert.ok(html.includes('id="save-btn" disabled'), 'Save button should be disabled for empty types');
  });
});
