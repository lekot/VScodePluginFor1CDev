import * as assert from 'assert';
import * as fc from 'fast-check';
import * as vscode from 'vscode';
import { TypeEditorProvider } from '../../src/providers/typeEditorProvider';
import { TypeDefinition } from '../../src/types/typeDefinitions';

/**
 * Bug Condition Exploration Test for Cancel Button Doesn't Close Editor
 * 
 * **Validates: Requirements 1.3, 2.3**
 * 
 * CRITICAL: This test MUST FAIL on unfixed code - failure confirms the bug exists
 * 
 * Property 1: Bug Condition - Cancel Button Doesn't Close Editor
 * When the user clicks the Cancel button in the type editor, the system SHALL close
 * the editor and discard any unsaved changes.
 * 
 * GOAL: Surface counterexamples that demonstrate Cancel button doesn't close editor
 * EXPECTED OUTCOME: Test FAILS (this is correct - it proves the bug exists)
 */
suite('Bug Condition Exploration: Cancel Button Doesn\'t Close Editor', () => {
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
   * Test 1.1: Cancel button exists in webview
   * EXPECTED: PASS on unfixed code (Cancel button exists)
   * This is a control test to verify the Cancel button is present
   */
  test('Property 1.1: Cancel button exists in type editor webview', () => {
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

    // Verify Cancel button exists
    assert.ok(html.includes('id="cancel-btn"'), 'Cancel button should exist in webview');
    assert.ok(html.includes('Cancel'), 'Cancel button should have "Cancel" text');
  });

  /**
   * Test 1.2: Cancel button has click handler
   * EXPECTED: PASS on unfixed code (Cancel button has event listener)
   * This verifies the Cancel button is wired up
   */
  test('Property 1.2: Cancel button has click event handler', () => {
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
    
    // Verify Cancel button has event listener
    assert.ok(
      scriptContent.includes('cancel-btn') && scriptContent.includes('addEventListener'),
      'Cancel button should have event listener'
    );
  });

  /**
   * Test 1.3: Cancel button click handler posts cancel message
   * EXPECTED: FAIL on unfixed code (Cancel handler doesn't close editor)
   * Counterexample: Cancel button posts message but doesn't trigger editor close
   */
  test('Property 1.3: Cancel button click handler posts cancel message to close editor', () => {
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

    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch, 'Script section should exist');
    
    const scriptContent = scriptMatch![1];
    
    // The BUG: Cancel button has event listener but doesn't post 'cancel' message
    // or the message handler doesn't close the editor
    
    // Check if Cancel button click handler posts a message
    const cancelHandlerMatch = scriptContent.match(/cancel-btn[\s\S]*?addEventListener\('click'[\s\S]*?\}\);/);
    assert.ok(cancelHandlerMatch, 'Cancel button click handler should exist');
    
    const cancelHandler = cancelHandlerMatch![0];
    
    // This will FAIL on unfixed code: Cancel handler doesn't post 'cancel' message
    const postsCancelMessage = 
      cancelHandler.includes('vscode.postMessage') && 
      cancelHandler.includes('cancel');
    
    assert.ok(
      postsCancelMessage,
      'Cancel button click handler should post "cancel" message to close editor'
    );
  });

  /**
   * Test 1.4: Cancel message handler closes the editor
   * EXPECTED: FAIL on unfixed code (Cancel message handler doesn't exist or doesn't close)
   * Counterexample: handleMessage doesn't handle 'cancel' message type
   */
  test('Property 1.4: Cancel message handler closes the editor', async () => {
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

    // The BUG: handleMessage doesn't handle 'cancel' message type
    // or doesn't call reject/dispose to close the editor
    
    const handleMessage = (typeEditorProvider as any).handleMessage.bind(typeEditorProvider);
    
    // Set up a flag to track if editor was closed
    let editorClosed = false;
    (typeEditorProvider as any).rejectPromise = () => {
      editorClosed = true;
    };

    // Send cancel message
    await handleMessage({
      type: 'cancel'
    });

    // This will FAIL on unfixed code: editor is not closed
    assert.ok(
      editorClosed,
      'Cancel message handler should close the editor by calling reject/dispose'
    );
  });

  /**
   * Test 1.5: Cancel button closes editor without saving changes
   * EXPECTED: FAIL on unfixed code (Cancel doesn't discard changes)
   * Counterexample: Cancel button doesn't properly discard unsaved changes
   */
  test('Property 1.5: Cancel button discards unsaved changes and closes editor', async () => {
    const originalTypeDefinition: TypeDefinition = {
      category: 'primitive',
      types: [{
        kind: 'string',
        qualifiers: {
          length: 50,
          allowedLength: 'Variable'
        }
      }]
    };

    const handleMessage = (typeEditorProvider as any).handleMessage.bind(typeEditorProvider);
    
    // Track if editor was closed (changes discarded)
    let editorClosed = false;
    let savedDefinition: TypeDefinition | null = null;
    
    (typeEditorProvider as any).rejectPromise = () => {
      editorClosed = true;
    };
    
    (typeEditorProvider as any).resolvePromise = (result: TypeDefinition) => {
      savedDefinition = result;
    };

    // Simulate user making changes (not saved yet)
    // Then clicking Cancel
    await handleMessage({
      type: 'cancel'
    });

    // This will FAIL on unfixed code: editor is not closed
    assert.ok(
      editorClosed,
      'Cancel button should close the editor'
    );
    
    // Verify changes were NOT saved
    assert.strictEqual(
      savedDefinition,
      null,
      'Cancel button should discard changes (not save them)'
    );
  });

  /**
   * Property-Based Test 1.6: Cancel button closes editor for any type definition
   * EXPECTED: FAIL on unfixed code for all generated type definitions
   * Tests that for ANY type definition, Cancel button should close the editor
   */
  test('Property 1.6: Cancel button closes editor for any type definition (Property-Based)', async () => {
    // Generator for primitive types
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
        
        // Track if editor was closed
        let editorClosed = false;
        (typeEditorProvider as any).rejectPromise = () => {
          editorClosed = true;
        };

        // Send cancel message
        await handleMessage({
          type: 'cancel'
        });

        // Property: Cancel message should close the editor
        return editorClosed;
      }),
      { numRuns: 30 }
    );
  });

  /**
   * Documented Counterexamples from Design
   * These are the specific failing cases mentioned in the bugfix requirements
   */
  test('Counterexample 1: Clicking Cancel button with String type doesn\'t close editor', async () => {
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

    const handleMessage = (typeEditorProvider as any).handleMessage.bind(typeEditorProvider);
    
    let editorClosed = false;
    (typeEditorProvider as any).rejectPromise = () => {
      editorClosed = true;
    };

    await handleMessage({
      type: 'cancel'
    });

    // This will FAIL on unfixed code
    assert.ok(
      editorClosed,
      'Counterexample: Clicking Cancel button with String type doesn\'t close editor'
    );
  });

  test('Counterexample 2: Clicking Cancel button with Number type doesn\'t close editor', async () => {
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

    const handleMessage = (typeEditorProvider as any).handleMessage.bind(typeEditorProvider);
    
    let editorClosed = false;
    (typeEditorProvider as any).rejectPromise = () => {
      editorClosed = true;
    };

    await handleMessage({
      type: 'cancel'
    });

    // This will FAIL on unfixed code
    assert.ok(
      editorClosed,
      'Counterexample: Clicking Cancel button with Number type doesn\'t close editor'
    );
  });

  test('Counterexample 3: Clicking Cancel button with Boolean type doesn\'t close editor', async () => {
    const typeDefinition: TypeDefinition = {
      category: 'primitive',
      types: [{
        kind: 'boolean'
      }]
    };

    const handleMessage = (typeEditorProvider as any).handleMessage.bind(typeEditorProvider);
    
    let editorClosed = false;
    (typeEditorProvider as any).rejectPromise = () => {
      editorClosed = true;
    };

    await handleMessage({
      type: 'cancel'
    });

    // This will FAIL on unfixed code
    assert.ok(
      editorClosed,
      'Counterexample: Clicking Cancel button with Boolean type doesn\'t close editor'
    );
  });

  test('Counterexample 4: Clicking Cancel button with Date type doesn\'t close editor', async () => {
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
    
    let editorClosed = false;
    (typeEditorProvider as any).rejectPromise = () => {
      editorClosed = true;
    };

    await handleMessage({
      type: 'cancel'
    });

    // This will FAIL on unfixed code
    assert.ok(
      editorClosed,
      'Counterexample: Clicking Cancel button with Date type doesn\'t close editor'
    );
  });

  test('Counterexample 5: Clicking Cancel button with unsaved changes doesn\'t close editor', async () => {
    const typeDefinition: TypeDefinition = {
      category: 'primitive',
      types: [{
        kind: 'string',
        qualifiers: {
          length: 100, // Changed from 50 to 100
          allowedLength: 'Variable'
        }
      }]
    };

    const handleMessage = (typeEditorProvider as any).handleMessage.bind(typeEditorProvider);
    
    let editorClosed = false;
    let savedDefinition: TypeDefinition | null = null;
    
    (typeEditorProvider as any).rejectPromise = () => {
      editorClosed = true;
    };
    
    (typeEditorProvider as any).resolvePromise = (result: TypeDefinition) => {
      savedDefinition = result;
    };

    // User makes changes but clicks Cancel instead of Save
    await handleMessage({
      type: 'cancel'
    });

    // This will FAIL on unfixed code
    assert.ok(
      editorClosed,
      'Counterexample: Clicking Cancel button with unsaved changes doesn\'t close editor'
    );
    
    assert.strictEqual(
      savedDefinition,
      null,
      'Counterexample: Cancel should discard changes, not save them'
    );
  });

  test('Counterexample 6: Clicking Cancel button with composite type doesn\'t close editor', async () => {
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

    const handleMessage = (typeEditorProvider as any).handleMessage.bind(typeEditorProvider);
    
    let editorClosed = false;
    (typeEditorProvider as any).rejectPromise = () => {
      editorClosed = true;
    };

    await handleMessage({
      type: 'cancel'
    });

    // This will FAIL on unfixed code
    assert.ok(
      editorClosed,
      'Counterexample: Clicking Cancel button with composite type doesn\'t close editor'
    );
  });
});
