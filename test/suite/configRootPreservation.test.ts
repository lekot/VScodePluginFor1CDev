import * as assert from 'assert';
import * as path from 'path';
import * as fc from 'fast-check';
import * as vscode from 'vscode';
import { PropertiesProvider } from '../../src/providers/propertiesProvider';
import { MetadataTreeDataProvider } from '../../src/providers/treeDataProvider';
import { TypeEditorProvider } from '../../src/providers/typeEditorProvider';
import { TreeNode, MetadataType } from '../../src/models/treeNode';
import { getConfigRootFromNode } from '../../src/utils/configHelpers';

/**
 * Preservation Property Tests: Non-Configuration Nodes Unaffected
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4**
 *
 * IMPORTANT: Follow observation-first methodology.
 * These tests observe behavior on UNFIXED code for non-buggy inputs
 * (nodes where isBugCondition returns false).
 *
 * EXPECTED OUTCOME: Tests PASS on unfixed code (confirms baseline behavior to preserve).
 *
 * isBugCondition(node) = false for:
 *   - nodes with type != 'Configuration'
 *   - nodes with filePath.endsWith('.xml')
 *   - nodes with parentFilePath set
 *   - nodes with filePath.endsWith('.bsl')
 */
suite('Preservation Property Tests: Non-Configuration Nodes Unaffected', () => {
  let provider: PropertiesProvider;
  let treeDataProvider: MetadataTreeDataProvider;
  let typeEditorProvider: TypeEditorProvider;
  let mockContext: vscode.ExtensionContext;

  const fixturesDir = path.join(__dirname, '..', 'fixtures');
  const designerConfigDir = path.join(fixturesDir, 'designer-config');
  const catalogXmlPath = path.join(designerConfigDir, 'Catalogs', 'TestCatalog1.xml');

  setup(() => {
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

    treeDataProvider = new MetadataTreeDataProvider(mockContext);
    typeEditorProvider = new TypeEditorProvider(mockContext);
    provider = new PropertiesProvider(mockContext, treeDataProvider, typeEditorProvider);
  });

  teardown(() => {
    provider.dispose();
  });

  // ---------------------------------------------------------------------------
  // Requirement 3.1: Catalog/Document nodes with .xml filePath load properties
  // ---------------------------------------------------------------------------

  /**
   * Test 3.1a: Catalog node with filePath ending in .xml loads properties from XML.
   * isBugCondition = false (type != 'Configuration').
   * EXPECTED: PASS on unfixed code.
   */
  test('3.1a: Catalog node with .xml filePath loads properties from XML file', async () => {
    const node: TreeNode = {
      id: 'catalog-1',
      name: 'TestCatalog1',
      type: MetadataType.Catalog,
      filePath: catalogXmlPath,
      parentFilePath: undefined,
      properties: {},
    };

    await provider.showProperties(node);

    assert.ok(
      Object.keys(node.properties ?? {}).length > 0,
      `Catalog node should have properties loaded from ${catalogXmlPath}. ` +
      `Got: ${JSON.stringify(node.properties)}`
    );
    assert.ok(
      node.properties['Name'] !== undefined,
      `Expected 'Name' property to be loaded. Got: ${JSON.stringify(node.properties)}`
    );
  });

  /**
   * Test 3.1b: Property-based — for any non-Configuration node type with a real .xml filePath,
   * showProperties loads properties (non-empty result).
   * EXPECTED: PASS on unfixed code.
   */
  test('3.1b: Any non-Configuration node type with .xml filePath loads properties (Property-Based)', async () => {
    // Use concrete non-Configuration types that have real XML fixtures
    const nonConfigTypes = [
      MetadataType.Catalog,
      MetadataType.Document,
    ] as const;

    const xmlFiles = [
      path.join(designerConfigDir, 'Catalogs', 'TestCatalog1.xml'),
      path.join(designerConfigDir, 'Documents', 'TestDocument1.xml'),
    ];

    for (let i = 0; i < nonConfigTypes.length; i++) {
      const node: TreeNode = {
        id: `node-${i}`,
        name: `TestNode${i}`,
        type: nonConfigTypes[i],
        filePath: xmlFiles[i],
        parentFilePath: undefined,
        properties: {},
      };

      await provider.showProperties(node);

      assert.ok(
        Object.keys(node.properties ?? {}).length > 0,
        `Node type=${nonConfigTypes[i]} with filePath=${xmlFiles[i]} should have properties loaded. ` +
        `Got: ${JSON.stringify(node.properties)}`
      );
    }
  });

  // ---------------------------------------------------------------------------
  // Requirement 3.2: Nested elements with parentFilePath use node.properties
  // ---------------------------------------------------------------------------

  /**
   * Test 3.2a: Node with parentFilePath set — showProperties uses already-loaded
   * node.properties and does NOT re-read the file.
   * EXPECTED: PASS on unfixed code.
   */
  test('3.2a: Node with parentFilePath uses pre-loaded node.properties without re-reading file', async () => {
    const preloadedProperties = {
      Name: 'TestAttribute',
      Type: 'String',
      Length: '50',
    };

    const node: TreeNode = {
      id: 'attr-1',
      name: 'TestAttribute',
      type: MetadataType.Attribute,
      filePath: undefined,
      parentFilePath: catalogXmlPath,
      properties: { ...preloadedProperties },
    };

    await provider.showProperties(node);

    // Properties should remain exactly as pre-loaded (no file re-read)
    assert.deepStrictEqual(
      node.properties,
      preloadedProperties,
      `Node with parentFilePath should keep pre-loaded properties unchanged. ` +
      `Expected: ${JSON.stringify(preloadedProperties)}, Got: ${JSON.stringify(node.properties)}`
    );
  });

  /**
   * Test 3.2b: Property-based — for any node with parentFilePath, showProperties
   * never overwrites node.properties with file content.
   * EXPECTED: PASS on unfixed code.
   */
  test('3.2b: Any node with parentFilePath preserves pre-loaded properties (Property-Based)', async () => {
    // Arbitrary property records (string keys, string values)
    const propertyRecordArb = fc.dictionary(
      fc.string({ minLength: 1, maxLength: 20 }).filter(s => /^[A-Za-z][A-Za-z0-9]*$/.test(s)),
      fc.string({ minLength: 0, maxLength: 50 }),
      { minKeys: 1, maxKeys: 5 }
    );

    await fc.assert(
      fc.asyncProperty(propertyRecordArb, async (props) => {
        const node: TreeNode = {
          id: 'attr-pbt',
          name: 'AttrPBT',
          type: MetadataType.Attribute,
          filePath: undefined,
          parentFilePath: catalogXmlPath,
          properties: { ...props },
        };

        await provider.showProperties(node);

        // Properties must remain unchanged — no file re-read for nested elements
        return JSON.stringify(node.properties) === JSON.stringify(props);
      }),
      { numRuns: 30 }
    );
  });

  // ---------------------------------------------------------------------------
  // Requirement 3.4: .bsl nodes open as text document, not properties panel
  // ---------------------------------------------------------------------------

  /**
   * Test 3.4a: Node with .bsl filePath — showProperties returns early (opens text doc).
   * We verify that node.properties is NOT populated (no XML read attempted).
   * EXPECTED: PASS on unfixed code.
   */
  test('3.4a: Node with .bsl filePath does not load XML properties (opens as text document)', async () => {
    const node: TreeNode = {
      id: 'module-1',
      name: 'ObjectModule',
      type: MetadataType.CommonModule,
      filePath: path.join(designerConfigDir, 'ObjectModule.bsl'),
      parentFilePath: undefined,
      properties: {},
    };

    // showProperties will try to open the .bsl file as a text document.
    // The file doesn't exist in fixtures, so it may throw — that's fine.
    // What matters: it does NOT attempt to read XML properties.
    try {
      await provider.showProperties(node);
    } catch {
      // Expected: vscode.window.showTextDocument may fail in test environment
    }

    // Properties should remain empty — no XML read was attempted
    assert.strictEqual(
      Object.keys(node.properties ?? {}).length,
      0,
      `.bsl node should NOT have XML properties loaded. Got: ${JSON.stringify(node.properties)}`
    );
  });

  /**
   * Test 3.4b: Property-based — for any node with .bsl filePath, properties stay empty.
   * EXPECTED: PASS on unfixed code.
   */
  test('3.4b: Any .bsl node never gets XML properties loaded (Property-Based)', async () => {
    const bslPathArb = fc.string({ minLength: 1, maxLength: 30 })
      .filter(s => /^[A-Za-z0-9_]+$/.test(s))
      .map(name => path.join(designerConfigDir, `${name}.bsl`));

    await fc.assert(
      fc.asyncProperty(bslPathArb, async (bslPath) => {
        const node: TreeNode = {
          id: 'bsl-pbt',
          name: 'BslModule',
          type: MetadataType.CommonModule,
          filePath: bslPath,
          parentFilePath: undefined,
          properties: {},
        };

        try {
          await provider.showProperties(node);
        } catch {
          // vscode.window.showTextDocument may fail in test env — that's OK
        }

        // Property: .bsl nodes must never have XML properties loaded
        return Object.keys(node.properties ?? {}).length === 0;
      }),
      { numRuns: 20 }
    );
  });

  // ---------------------------------------------------------------------------
  // Requirement 3.3: getConfigRootFromNode returns directory path for Designer node
  // ---------------------------------------------------------------------------

  /**
   * Test 3.3a: getConfigRootFromNode for a Designer-format root node returns
   * the directory path (not a .xml path).
   * EXPECTED: PASS on unfixed code (filePath is still a directory on unfixed code).
   */
  test('3.3a: getConfigRootFromNode returns directory path for Designer root node', () => {
    const rootNode: TreeNode = {
      id: 'config-root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      // On unfixed code, filePath is the directory (the bug condition)
      filePath: designerConfigDir,
      parentFilePath: undefined,
      properties: {},
    };

    const result = getConfigRootFromNode(rootNode);

    assert.ok(result !== null, 'getConfigRootFromNode should return a non-null path');
    assert.ok(
      !result!.endsWith('.xml'),
      `getConfigRootFromNode should return a directory path, not a .xml path. Got: "${result}"`
    );
    assert.strictEqual(
      result,
      designerConfigDir,
      `Expected directory path "${designerConfigDir}", got "${result}"`
    );
  });

  /**
   * Test 3.3b: getConfigRootFromNode for a child node walks up to root and returns directory.
   * EXPECTED: PASS on unfixed code.
   */
  test('3.3b: getConfigRootFromNode walks up to root and returns directory for child node', () => {
    const rootNode: TreeNode = {
      id: 'config-root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      filePath: designerConfigDir,
      parentFilePath: undefined,
      properties: {},
    };

    const catalogNode: TreeNode = {
      id: 'catalog-1',
      name: 'TestCatalog1',
      type: MetadataType.Catalog,
      filePath: catalogXmlPath,
      parentFilePath: undefined,
      properties: {},
      parent: rootNode,
    };

    const result = getConfigRootFromNode(catalogNode);

    assert.ok(result !== null, 'getConfigRootFromNode should return a non-null path for child node');
    assert.ok(
      !result!.endsWith('.xml'),
      `getConfigRootFromNode should return a directory path for child node. Got: "${result}"`
    );
    assert.strictEqual(
      result,
      designerConfigDir,
      `Expected directory path "${designerConfigDir}", got "${result}"`
    );
  });

  /**
   * Test 3.3c: Property-based — getConfigRootFromNode always returns a non-.xml path
   * for Designer-format root nodes (filePath = directory).
   * EXPECTED: PASS on unfixed code.
   */
  test('3.3c: getConfigRootFromNode always returns non-.xml path for Designer root nodes (Property-Based)', () => {
    // Generate arbitrary directory paths (no .xml suffix)
    const dirPathArb = fc.array(
      fc.string({ minLength: 1, maxLength: 15 }).filter(s => /^[A-Za-z0-9_]+$/.test(s)),
      { minLength: 1, maxLength: 4 }
    ).map(parts => path.join('C:', 'projects', ...parts));

    fc.assert(
      fc.property(dirPathArb, (dirPath) => {
        const rootNode: TreeNode = {
          id: 'config-root-pbt',
          name: 'Configuration',
          type: MetadataType.Configuration,
          filePath: dirPath,
          parentFilePath: undefined,
          properties: {},
        };

        const result = getConfigRootFromNode(rootNode);

        // Property: result must not end with .xml
        return result !== null && !result.endsWith('.xml');
      }),
      { numRuns: 50 }
    );
  });
});
