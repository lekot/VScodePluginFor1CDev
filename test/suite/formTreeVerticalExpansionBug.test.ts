import * as assert from 'assert';
import * as fc from 'fast-check';

/**
 * Bug Condition Exploration Test for Form Tree Vertical Expansion Fix
 * 
 * **Validates: Requirements 2.1, 2.2**
 * 
 * CRITICAL: This test MUST FAIL on unfixed code - failure confirms the bug exists
 * 
 * This test encodes the EXPECTED behavior (after fix):
 * - Tree child containers (.tree-children, .tree-table-columns) should use flex-direction: column
 * - Child elements should be displayed vertically (one below another)
 * - Child elements should have left indentation
 * 
 * On UNFIXED code, this test will FAIL because:
 * - .tree-children and .tree-table-columns use display: block (not flex with column direction)
 * - Child elements are displayed horizontally in a row
 * - The CSS does not enforce vertical stacking
 */
suite('Form Tree Vertical Expansion Bug Condition Exploration', () => {
  /**
   * Helper function to extract CSS rules from HTML
   */
  function extractCSSRules(html: string): Map<string, Map<string, string>> {
    const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
    if (!styleMatch) {
      return new Map();
    }

    const cssText = styleMatch[1];
    const rules = new Map<string, Map<string, string>>();

    // Parse CSS rules (simple parser for our needs)
    const ruleRegex = /([^{]+)\{([^}]+)\}/g;
    let match;

    while ((match = ruleRegex.exec(cssText)) !== null) {
      const selector = match[1].trim();
      const declarations = match[2].trim();

      const properties = new Map<string, string>();
      
      // Parse property: value pairs
      const propRegex = /([^:;]+):([^;]+)/g;
      let propMatch;
      
      while ((propMatch = propRegex.exec(declarations)) !== null) {
        const property = propMatch[1].trim();
        const value = propMatch[2].trim();
        properties.set(property, value);
      }

      rules.set(selector, properties);
    }

    return rules;
  }

  /**
   * Helper function to get FormEditorProvider HTML
   */
  function getFormEditorHTML(): string {
    // Import the FormEditorProvider
    const FormEditorProviderModule = require('../../src/formEditor/formEditorProvider');
    const FormEditorProvider = FormEditorProviderModule.FormEditorProvider;

    // Create a mock context
    const mockContext = {
      subscriptions: [],
      extensionPath: '',
      extensionUri: { fsPath: '' } as any,
      globalState: {} as any,
      workspaceState: {} as any,
      secrets: {} as any,
      storageUri: undefined,
      globalStorageUri: {} as any,
      logUri: {} as any,
      extensionMode: 3,
      storagePath: undefined,
      globalStoragePath: '',
      logPath: '',
      asAbsolutePath: (relativePath: string) => relativePath,
      environmentVariableCollection: {} as any,
      extension: {} as any
    };

    const provider = new FormEditorProvider(mockContext);

    // Access the private getWebviewHtml method
    const getWebviewHtml = (provider as any).getWebviewHtml.bind(provider);
    const mockWebview = {} as any;
    
    return getWebviewHtml(mockWebview);
  }

  /**
   * Property 1: Bug Condition - Vertical Tree Expansion
   * 
   * Test that .tree-children and .tree-table-columns CSS rules enforce vertical layout.
   * 
   * This is a SCOPED property-based test focusing on the concrete failing CSS classes.
   */
  test('Property 1: .tree-children should use flex-direction: column for vertical layout', () => {
    const html = getFormEditorHTML();
    const cssRules = extractCSSRules(html);

    // Check .tree-children CSS rule
    const treeChildrenRule = cssRules.get('.tree-children');
    
    assert.ok(
      treeChildrenRule,
      'Expected .tree-children CSS rule to exist'
    );

    // EXPECTED: display should be flex (or inline-flex)
    const displayValue = treeChildrenRule!.get('display');
    assert.ok(
      displayValue === 'flex' || displayValue === 'inline-flex',
      `Expected .tree-children to have display: flex, but got display: ${displayValue}`
    );

    // EXPECTED: flex-direction should be column for vertical stacking
    const flexDirection = treeChildrenRule!.get('flex-direction');
    assert.strictEqual(
      flexDirection,
      'column',
      `Expected .tree-children to have flex-direction: column for vertical layout, but got flex-direction: ${flexDirection}`
    );

    // Verify margin-left is preserved for indentation
    const marginLeft = treeChildrenRule!.get('margin-left');
    assert.ok(
      marginLeft,
      'Expected .tree-children to have margin-left for indentation'
    );
  });


  test('Property 1: .tree-table-columns should use flex-direction: column for vertical layout', () => {
    const html = getFormEditorHTML();
    const cssRules = extractCSSRules(html);

    // Check .tree-table-columns CSS rule
    const treeTableColumnsRule = cssRules.get('.tree-table-columns');
    
    assert.ok(
      treeTableColumnsRule,
      'Expected .tree-table-columns CSS rule to exist'
    );

    // EXPECTED: display should be flex (or inline-flex)
    const displayValue = treeTableColumnsRule!.get('display');
    assert.ok(
      displayValue === 'flex' || displayValue === 'inline-flex',
      `Expected .tree-table-columns to have display: flex, but got display: ${displayValue}`
    );

    // EXPECTED: flex-direction should be column for vertical stacking
    const flexDirection = treeTableColumnsRule!.get('flex-direction');
    assert.strictEqual(
      flexDirection,
      'column',
      `Expected .tree-table-columns to have flex-direction: column for vertical layout, but got flex-direction: ${flexDirection}`
    );

    // Verify margin-left is preserved for indentation
    const marginLeft = treeTableColumnsRule!.get('margin-left');
    assert.ok(
      marginLeft,
      'Expected .tree-table-columns to have margin-left for indentation'
    );
  });

  /**
   * Concrete test case: UsualGroup expansion
   * 
   * This test demonstrates the bug with a real-world example.
   */
  test('Concrete case: UsualGroup with multiple children should render vertically', () => {
    const html = getFormEditorHTML();
    const cssRules = extractCSSRules(html);

    const treeChildrenRule = cssRules.get('.tree-children');
    assert.ok(treeChildrenRule, '.tree-children rule should exist');

    // The bug: display: block does not enforce vertical stacking
    // The fix: display: flex with flex-direction: column
    const display = treeChildrenRule!.get('display');
    const flexDirection = treeChildrenRule!.get('flex-direction');

    // This assertion will FAIL on unfixed code (display: block, no flex-direction)
    // This assertion will PASS on fixed code (display: flex, flex-direction: column)
    assert.strictEqual(
      display,
      'flex',
      'UsualGroup children container should use display: flex'
    );

    
    assert.strictEqual(
      flexDirection,
      'column',
      'UsualGroup children should be stacked vertically with flex-direction: column'
    );
  });

  /**
   * Concrete test case: Table columns in tree
   */
  test('Concrete case: Table columns in tree should render vertically', () => {
    const html = getFormEditorHTML();
    const cssRules = extractCSSRules(html);

    const treeTableColumnsRule = cssRules.get('.tree-table-columns');
    assert.ok(treeTableColumnsRule, '.tree-table-columns rule should exist');

    // The bug: display: block does not enforce vertical stacking
    // The fix: display: flex with flex-direction: column
    const display = treeTableColumnsRule!.get('display');
    const flexDirection = treeTableColumnsRule!.get('flex-direction');

    // This assertion will FAIL on unfixed code (display: block, no flex-direction)
    // This assertion will PASS on fixed code (display: flex, flex-direction: column)
    assert.strictEqual(
      display,
      'flex',
      'Table columns in tree should use display: flex'
    );
    
    assert.strictEqual(
      flexDirection,
      'column',
      'Table columns in tree should be stacked vertically with flex-direction: column'
    );
  });

  /**
   * Property-based test: Container types should all use vertical layout
   */
  test('Property 1: All container types should enforce vertical child layout', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('UsualGroup', 'Pages', 'Page', 'Table', 'Form', 'Group', 'CollapsibleGroup', 'AutoCommandBar'),
        (containerType) => {
          const html = getFormEditorHTML();
          const cssRules = extractCSSRules(html);

          // All containers use .tree-children (and Table also uses .tree-table-columns)
          const treeChildrenRule = cssRules.get('.tree-children');
          
          assert.ok(
            treeChildrenRule,
            `Expected .tree-children CSS rule to exist for ${containerType}`
          );

          const display = treeChildrenRule!.get('display');
          const flexDirection = treeChildrenRule!.get('flex-direction');

          // EXPECTED: All containers should render children vertically
          assert.strictEqual(
            display,
            'flex',
            `Expected ${containerType} children to use display: flex`
          );

          
          assert.strictEqual(
            flexDirection,
            'column',
            `Expected ${containerType} children to use flex-direction: column for vertical layout`
          );
        }
      ),
      { numRuns: 8 } // Test all 8 container types
    );
  });

  /**
   * Verification test: Preview table columns should remain horizontal
   * 
   * This ensures we don't accidentally break the preview layout.
   */
  test('Preservation: .preview-table-columns should remain horizontal (flex-direction: row)', () => {
    const html = getFormEditorHTML();
    const cssRules = extractCSSRules(html);

    const previewTableColumnsRule = cssRules.get('.preview-table-columns');
    
    assert.ok(
      previewTableColumnsRule,
      'Expected .preview-table-columns CSS rule to exist'
    );

    // CRITICAL: Preview should remain horizontal
    const display = previewTableColumnsRule!.get('display');
    const flexDirection = previewTableColumnsRule!.get('flex-direction');

    assert.strictEqual(
      display,
      'flex',
      'Preview table columns should use display: flex'
    );
    
    assert.strictEqual(
      flexDirection,
      'row',
      'Preview table columns should remain horizontal with flex-direction: row'
    );
  });

  /**
   * Test that indentation is preserved
   */
  test('Property 1: Child containers should have left indentation', () => {
    const html = getFormEditorHTML();
    const cssRules = extractCSSRules(html);

    const treeChildrenRule = cssRules.get('.tree-children');
    const treeTableColumnsRule = cssRules.get('.tree-table-columns');

    // Both should have margin-left for indentation
    assert.ok(
      treeChildrenRule!.get('margin-left'),
      'Expected .tree-children to have margin-left for indentation'
    );

    assert.ok(
      treeTableColumnsRule!.get('margin-left'),
      'Expected .tree-table-columns to have margin-left for indentation'
    );
  });
});
