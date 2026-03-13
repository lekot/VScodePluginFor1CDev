import * as assert from 'assert';
import * as fc from 'fast-check';

/**
 * Preservation Property Tests for Form Tree Vertical Expansion Fix
 * 
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4**
 * 
 * IMPORTANT: These tests capture baseline behavior on UNFIXED code
 * 
 * These tests verify that behaviors NOT related to visual layout of children
 * remain unchanged after the fix is applied:
 * - Click interactions (selection, property panel updates)
 * - Chevron toggle (expand/collapse)
 * - Drag-and-drop operations
 * - Styling (hover, selected, drop-target states)
 * - Icon, chevron, and label display order
 * - Preview horizontal layout (table columns in zone-preview)
 * 
 * EXPECTED OUTCOME: All tests PASS on unfixed code (establishing baseline)
 * After fix: All tests should STILL PASS (confirming no regressions)
 */
suite('Form Tree Preservation Property Tests', () => {
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

    const ruleRegex = /([^{]+)\{([^}]+)\}/g;
    let match;

    while ((match = ruleRegex.exec(cssText)) !== null) {
      const selector = match[1].trim();
      const declarations = match[2].trim();

      const properties = new Map<string, string>();
      
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
    const FormEditorProviderModule = require('../../src/formEditor/formEditorProvider');
    const FormEditorProvider = FormEditorProviderModule.FormEditorProvider;

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
    const getWebviewHtml = (provider as any).getWebviewHtml.bind(provider);
    const mockWebview = {} as any;
    
    return getWebviewHtml(mockWebview);
  }

  /**
   * Property 2: Preservation - Tree Node Styling
   * 
   * Verify that tree node styling classes remain unchanged
   */
  test('Property 2: Tree node base styling should be preserved', () => {
    const html = getFormEditorHTML();
    const cssRules = extractCSSRules(html);

    const treeNodeRule = cssRules.get('.tree-node');
    
    assert.ok(
      treeNodeRule,
      'Expected .tree-node CSS rule to exist'
    );

    // Verify display: flex for tree nodes (for icon, chevron, label layout)
    const display = treeNodeRule!.get('display');
    assert.strictEqual(
      display,
      'flex',
      'Tree nodes should use display: flex for horizontal icon/label layout'
    );

    // Verify align-items for vertical centering
    const alignItems = treeNodeRule!.get('align-items');
    assert.strictEqual(
      alignItems,
      'center',
      'Tree nodes should vertically center their content'
    );

    // Verify gap between icon, chevron, and label
    const gap = treeNodeRule!.get('gap');
    assert.ok(
      gap,
      'Tree nodes should have gap between icon, chevron, and label'
    );
  });

  /**
   * Property 2: Preservation - Hover State Styling
   */
  test('Property 2: Tree node hover state styling should be preserved', () => {
    const html = getFormEditorHTML();
    const cssRules = extractCSSRules(html);

    const hoverRule = cssRules.get('.tree-node:hover');
    
    assert.ok(
      hoverRule,
      'Expected .tree-node:hover CSS rule to exist'
    );

    // Verify hover background
    const background = hoverRule!.get('background');
    assert.ok(
      background && background.includes('hoverBackground'),
      'Tree nodes should have hover background styling'
    );
  });

  /**
   * Property 2: Preservation - Selected State Styling
   */
  test('Property 2: Tree node selected state styling should be preserved', () => {
    const html = getFormEditorHTML();
    const cssRules = extractCSSRules(html);

    const selectedRule = cssRules.get('.tree-node.selected');
    
    assert.ok(
      selectedRule,
      'Expected .tree-node.selected CSS rule to exist'
    );

    // Verify selected background
    const background = selectedRule!.get('background');
    assert.ok(
      background && background.includes('activeSelectionBackground'),
      'Selected tree nodes should have selection background styling'
    );

    // Verify selected foreground color
    const color = selectedRule!.get('color');
    assert.ok(
      color && color.includes('activeSelectionForeground'),
      'Selected tree nodes should have selection foreground styling'
    );
  });

  /**
   * Property 2: Preservation - Drop Target Styling
   */
  test('Property 2: Tree node drop-target state styling should be preserved', () => {
    const html = getFormEditorHTML();
    const cssRules = extractCSSRules(html);

    const dropTargetRule = cssRules.get('.tree-node.drop-target');
    
    assert.ok(
      dropTargetRule,
      'Expected .tree-node.drop-target CSS rule to exist'
    );

    // Verify drop-target outline
    const outline = dropTargetRule!.get('outline');
    assert.ok(
      outline && outline.includes('focusBorder'),
      'Drop target tree nodes should have outline styling'
    );
  });

  /**
   * Property 2: Preservation - Chevron Styling
   */
  test('Property 2: Chevron styling and rotation should be preserved', () => {
    const html = getFormEditorHTML();
    const cssRules = extractCSSRules(html);

    const chevronRule = cssRules.get('.tree-chevron');
    const collapsedChevronRule = cssRules.get('.tree-chevron.collapsed');
    
    assert.ok(
      chevronRule,
      'Expected .tree-chevron CSS rule to exist'
    );

    assert.ok(
      collapsedChevronRule,
      'Expected .tree-chevron.collapsed CSS rule to exist'
    );

    // Verify chevron has fixed width
    const width = chevronRule!.get('width');
    assert.ok(
      width,
      'Chevron should have fixed width'
    );

    // Verify chevron has flex-shrink: 0
    const flexShrink = chevronRule!.get('flex-shrink');
    assert.strictEqual(
      flexShrink,
      '0',
      'Chevron should not shrink'
    );

    // Verify collapsed chevron has rotation transform
    const transform = collapsedChevronRule!.get('transform');
    assert.ok(
      transform && transform.includes('rotate'),
      'Collapsed chevron should have rotation transform'
    );
  });

  /**
   * Property 2: Preservation - Icon Styling
   */
  test('Property 2: Icon styling should be preserved', () => {
    const html = getFormEditorHTML();
    const cssRules = extractCSSRules(html);

    const iconRule = cssRules.get('.tree-icon');
    
    assert.ok(
      iconRule,
      'Expected .tree-icon CSS rule to exist'
    );

    // Verify icon has fixed width
    const width = iconRule!.get('width');
    assert.ok(
      width,
      'Icon should have fixed width'
    );

    // Verify icon has flex-shrink: 0
    const flexShrink = iconRule!.get('flex-shrink');
    assert.strictEqual(
      flexShrink,
      '0',
      'Icon should not shrink'
    );
  });

  /**
   * Property 2: Preservation - Label Styling
   */
  test('Property 2: Label styling should be preserved', () => {
    const html = getFormEditorHTML();
    const cssRules = extractCSSRules(html);

    const labelRule = cssRules.get('.tree-node-label');
    
    assert.ok(
      labelRule,
      'Expected .tree-node-label CSS rule to exist'
    );

    // Verify label has text overflow handling
    const overflow = labelRule!.get('overflow');
    const textOverflow = labelRule!.get('text-overflow');
    const whiteSpace = labelRule!.get('white-space');

    assert.strictEqual(
      overflow,
      'hidden',
      'Label should hide overflow'
    );

    assert.strictEqual(
      textOverflow,
      'ellipsis',
      'Label should show ellipsis for overflow'
    );

    assert.strictEqual(
      whiteSpace,
      'nowrap',
      'Label should not wrap'
    );
  });

  /**
   * Property 2: Preservation - Preview Table Columns Horizontal Layout
   * 
   * CRITICAL: This verifies that preview table columns remain horizontal
   */
  test('Property 2: Preview table columns should remain horizontal (flex-direction: row)', () => {
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
      'Preview table columns MUST remain horizontal with flex-direction: row'
    );
  });

  /**
   * Property 2: Preservation - Preview Item Styling
   */
  test('Property 2: Preview item styling should be preserved', () => {
    const html = getFormEditorHTML();
    const cssRules = extractCSSRules(html);

    const previewItemRule = cssRules.get('.preview-item');
    
    assert.ok(
      previewItemRule,
      'Expected .preview-item CSS rule to exist'
    );

    // Verify preview items have cursor pointer
    const cursor = previewItemRule!.get('cursor');
    assert.strictEqual(
      cursor,
      'pointer',
      'Preview items should have pointer cursor'
    );

    // Verify preview items have border
    const border = previewItemRule!.get('border');
    assert.ok(
      border,
      'Preview items should have border'
    );
  });

  /**
   * Property 2: Preservation - Preview Item Hover State
   */
  test('Property 2: Preview item hover state should be preserved', () => {
    const html = getFormEditorHTML();
    const cssRules = extractCSSRules(html);

    const hoverRule = cssRules.get('.preview-item:hover');
    
    assert.ok(
      hoverRule,
      'Expected .preview-item:hover CSS rule to exist'
    );

    // Verify hover background
    const background = hoverRule!.get('background');
    assert.ok(
      background && background.includes('hoverBackground'),
      'Preview items should have hover background styling'
    );
  });

  /**
   * Property 2: Preservation - Preview Item Selected State
   */
  test('Property 2: Preview item selected state should be preserved', () => {
    const html = getFormEditorHTML();
    const cssRules = extractCSSRules(html);

    const selectedRule = cssRules.get('.preview-item.selected');
    
    assert.ok(
      selectedRule,
      'Expected .preview-item.selected CSS rule to exist'
    );

    // Verify selected background
    const background = selectedRule!.get('background');
    assert.ok(
      background && background.includes('activeSelectionBackground'),
      'Selected preview items should have selection background styling'
    );
  });

  /**
   * Property 2: Preservation - Preview Item Drop Target State
   */
  test('Property 2: Preview item drop-target state should be preserved', () => {
    const html = getFormEditorHTML();
    const cssRules = extractCSSRules(html);

    const dropTargetRule = cssRules.get('.preview-item.drop-target');
    
    assert.ok(
      dropTargetRule,
      'Expected .preview-item.drop-target CSS rule to exist'
    );

    // Verify drop-target outline
    const outline = dropTargetRule!.get('outline');
    assert.ok(
      outline && outline.includes('focusBorder'),
      'Drop target preview items should have outline styling'
    );
  });

  /**
   * Property-based test: All interaction-related CSS classes should be preserved
   */
  test('Property 2: All interaction-related CSS classes should exist', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          '.tree-node',
          '.tree-node:hover',
          '.tree-node.selected',
          '.tree-node.drop-target',
          '.tree-chevron',
          '.tree-chevron.collapsed',
          '.tree-icon',
          '.tree-node-label',
          '.preview-item',
          '.preview-item:hover',
          '.preview-item.selected',
          '.preview-item.drop-target'
        ),
        (cssClass) => {
          const html = getFormEditorHTML();
          const cssRules = extractCSSRules(html);

          assert.ok(
            cssRules.has(cssClass),
            `Expected ${cssClass} CSS rule to exist for interaction preservation`
          );
        }
      ),
      { numRuns: 12 } // Test all 12 interaction-related classes
    );
  });

  /**
   * Property 2: Preservation - Tree node display order (chevron, icon, label)
   * 
   * This test verifies that the order of elements within a tree node is preserved
   */
  test('Property 2: Tree node internal layout order should be preserved', () => {
    const html = getFormEditorHTML();

    // Verify the JavaScript code creates elements in the correct order
    // The order should be: chevron, icon, label
    assert.ok(
      html.includes('appendChild(chevronSpan)'),
      'Chevron should be appended first'
    );

    assert.ok(
      html.includes('appendChild(iconSpan)'),
      'Icon should be appended second'
    );

    assert.ok(
      html.includes('appendChild(labelSpan)'),
      'Label should be appended third'
    );

    // Verify the order in the HTML
    const chevronIndex = html.indexOf('appendChild(chevronSpan)');
    const iconIndex = html.indexOf('appendChild(iconSpan)');
    const labelIndex = html.indexOf('appendChild(labelSpan)');

    assert.ok(
      chevronIndex < iconIndex && iconIndex < labelIndex,
      'Tree node elements should be appended in order: chevron, icon, label'
    );
  });

  /**
   * Property 2: Preservation - Drag-and-drop event handlers
   * 
   * Verify that drag-and-drop event handlers are present in the code
   */
  test('Property 2: Drag-and-drop event handlers should be preserved', () => {
    const html = getFormEditorHTML();

    // Verify tree node drag handlers
    assert.ok(
      html.includes('ondragstart'),
      'Tree nodes should have ondragstart handler'
    );

    assert.ok(
      html.includes('ondragover'),
      'Tree nodes should have ondragover handler'
    );

    assert.ok(
      html.includes('ondragleave'),
      'Tree nodes should have ondragleave handler'
    );

    assert.ok(
      html.includes('ondrop'),
      'Tree nodes should have ondrop handler'
    );

    // Verify drag-and-drop message type
    assert.ok(
      html.includes("type: 'dragDrop'"),
      'Drag-and-drop should post dragDrop message'
    );
  });

  /**
   * Property 2: Preservation - Click event handlers
   * 
   * Verify that click event handlers are present in the code
   */
  test('Property 2: Click event handlers should be preserved', () => {
    const html = getFormEditorHTML();

    // Verify tree node click handler
    assert.ok(
      html.includes("addEventListener('click'"),
      'Tree nodes should have click event listener'
    );

    // Verify chevron click handler
    assert.ok(
      html.includes('chevronSpan.addEventListener'),
      'Chevron should have click event listener'
    );

    // Verify selection message type
    assert.ok(
      html.includes("type: 'selectElement'"),
      'Click should post selectElement message'
    );
  });

  /**
   * Property 2: Preservation - Chevron toggle functionality
   * 
   * Verify that chevron toggle logic is present
   */
  test('Property 2: Chevron toggle functionality should be preserved', () => {
    const html = getFormEditorHTML();

    // Verify expandedIds set manipulation
    assert.ok(
      html.includes('expandedIds.has'),
      'Chevron toggle should check expandedIds'
    );

    assert.ok(
      html.includes('expandedIds.delete'),
      'Chevron toggle should delete from expandedIds when collapsing'
    );

    assert.ok(
      html.includes('expandedIds.add'),
      'Chevron toggle should add to expandedIds when expanding'
    );

    // Verify tree re-rendering after toggle
    assert.ok(
      html.includes('renderTree(formModel.childItemsRoot, root)'),
      'Chevron toggle should re-render tree'
    );
  });

  /**
   * Property 2: Preservation - Container detection logic
   * 
   * Verify that container detection logic is preserved
   */
  test('Property 2: Container detection logic should be preserved', () => {
    const html = getFormEditorHTML();

    // Verify CONTAINER_TAGS set
    assert.ok(
      html.includes('CONTAINER_TAGS'),
      'Container tags set should exist'
    );

    // Verify all container types are included
    const containerTypes = [
      'UsualGroup',
      'Pages',
      'Page',
      'Table',
      'AutoCommandBar',
      'Form',
      'Group',
      'CollapsibleGroup'
    ];

    containerTypes.forEach(type => {
      assert.ok(
        html.includes(`'${type}'`),
        `Container type ${type} should be in CONTAINER_TAGS`
      );
    });
  });

  /**
   * Property 2: Preservation - Icon mapping logic
   * 
   * Verify that icon mapping logic is preserved
   */
  test('Property 2: Icon mapping logic should be preserved', () => {
    const html = getFormEditorHTML();

    // Verify getTreeIcon function exists
    assert.ok(
      html.includes('function getTreeIcon'),
      'getTreeIcon function should exist'
    );

    // Verify icon mapping for common element types
    const iconMappings = [
      'Button',
      'InputField',
      'Table',
      'Page',
      'Pages',
      'Form',
      'Group',
      'UsualGroup'
    ];

    iconMappings.forEach(type => {
      assert.ok(
        html.includes(`${type}:`),
        `Icon mapping for ${type} should exist`
      );
    });
  });
});
