import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { PropertiesProvider } from '../../src/providers/propertiesProvider';
import { MetadataTreeDataProvider } from '../../src/providers/treeDataProvider';
import { TypeEditorProvider } from '../../src/providers/typeEditorProvider';
import { TreeNode, MetadataType } from '../../src/models/treeNode';

/**
 * Bug Condition Exploration Test: Configuration Root filePath Directory Bug
 *
 * **Validates: Requirements 1.1, 1.2**
 *
 * CRITICAL: This test MUST FAIL on unfixed code — failure confirms the bug exists.
 * DO NOT attempt to fix the test or the code when it fails.
 *
 * This test encodes the EXPECTED behavior (after fix):
 * - showProperties(node) for a Configuration root node with filePath = directory
 *   SHALL load properties from Configuration.xml in that directory.
 *
 * On UNFIXED code this test FAILS because:
 * - showProperties checks `node.filePath.endsWith('.xml')` before reading the file
 * - When filePath is a directory (not ending in .xml), the condition is false
 * - Properties are never loaded → node.properties remains empty
 *
 * Documented counterexample:
 *   node = { type: 'Configuration', filePath: '/path/to/designer-config', parentFilePath: undefined }
 *   → showProperties does NOT call XMLWriter.readProperties
 *   → node.properties stays empty
 *   → Cause: `node.filePath.endsWith('.xml')` === false for directory paths
 */
suite('Bug Condition Exploration: Configuration Root Properties Not Loaded', () => {
  let provider: PropertiesProvider;
  let treeDataProvider: MetadataTreeDataProvider;
  let typeEditorProvider: TypeEditorProvider;
  let mockContext: vscode.ExtensionContext;

  // Path to the designer-config fixture that contains a real Configuration.xml
  const fixturesDir = path.join(__dirname, '..', 'fixtures');
  const designerConfigDir = path.join(fixturesDir, 'designer-config');
  const configXmlPath = path.join(designerConfigDir, 'Configuration.xml');

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

  /**
   * Test Case 1: Designer root node — filePath is a directory
   *
   * isBugCondition = true:
   *   type = 'Configuration', filePath = directory (no .xml), parentFilePath = undefined
   *
   * EXPECTED (after fix): showProperties loads properties from Configuration.xml
   * ACTUAL (unfixed code): properties remain empty — bug confirmed
   */
  test('Case 1: Designer root node with filePath=directory should load properties from Configuration.xml', async () => {
    const node: TreeNode = {
      id: 'config-root',
      name: 'TestConfiguration',
      type: MetadataType.Configuration,
      // filePath is the directory — this is the bug condition
      filePath: designerConfigDir,
      parentFilePath: undefined,
      properties: {},
    };

    await provider.showProperties(node);

    // After showProperties, node.properties should be populated from Configuration.xml.
    // On UNFIXED code: node.properties stays empty because filePath.endsWith('.xml') === false.
    // This assertion FAILS on unfixed code — confirming the bug.
    assert.ok(
      Object.keys(node.properties ?? {}).length > 0,
      `Bug confirmed: showProperties did NOT load properties for Configuration node with filePath="${designerConfigDir}" (directory). ` +
      `node.filePath.endsWith('.xml') === false, so XMLWriter.readProperties was never called. ` +
      `Expected node.properties to be non-empty after loading from Configuration.xml.`
    );
  });

  /**
   * Test Case 2: EDT root node — filePath ends with /src (directory)
   *
   * isBugCondition = true:
   *   type = 'Configuration', filePath = '.../src' (no .xml), parentFilePath = undefined
   *
   * EXPECTED (after fix): showProperties loads properties from Configuration.xml
   * ACTUAL (unfixed code): properties remain empty — bug confirmed
   *
   * Note: We reuse the designer-config fixture here since we only need a valid
   * Configuration.xml to exist. The EDT path pattern is simulated.
   */
  test('Case 2: EDT root node with filePath ending in /src should load properties from Configuration.xml', async () => {
    // Simulate EDT-style path: the directory is the config root, Configuration.xml is inside
    // We use designerConfigDir as a stand-in since it has a real Configuration.xml
    const edtStylePath = designerConfigDir; // acts as the EDT src/ directory for this test

    const node: TreeNode = {
      id: 'config-root-edt',
      name: 'TestConfiguration',
      type: MetadataType.Configuration,
      // filePath is a directory (EDT format: ends with /src in real projects)
      filePath: edtStylePath,
      parentFilePath: undefined,
      properties: {},
    };

    await provider.showProperties(node);

    // On UNFIXED code: node.properties stays empty — bug confirmed.
    assert.ok(
      Object.keys(node.properties ?? {}).length > 0,
      `Bug confirmed: showProperties did NOT load properties for EDT-style Configuration node with filePath="${edtStylePath}" (directory). ` +
      `node.filePath.endsWith('.xml') === false, so XMLWriter.readProperties was never called.`
    );
  });

  /**
   * Test Case 3 (Hypothesis Verification): filePath pointing directly to Configuration.xml
   *
   * isBugCondition = false (filePath ends with .xml)
   *
   * EXPECTED: showProperties DOES load properties (even on unfixed code).
   * This confirms the hypothesis: the bug is specifically the .xml check.
   * If this test passes on unfixed code, it proves the fix direction is correct.
   */
  test('Case 3 (hypothesis): filePath=Configuration.xml loads properties even on unfixed code', async () => {
    const node: TreeNode = {
      id: 'config-root-xml',
      name: 'TestConfiguration',
      type: MetadataType.Configuration,
      // filePath points directly to the XML file — this is what the fix will produce
      filePath: configXmlPath,
      parentFilePath: undefined,
      properties: {},
    };

    await provider.showProperties(node);

    // This SHOULD pass even on unfixed code — confirming the hypothesis that
    // the only problem is the directory vs .xml path distinction.
    assert.ok(
      Object.keys(node.properties ?? {}).length > 0,
      `Hypothesis failed: showProperties did NOT load properties even when filePath="${configXmlPath}" (ends with .xml). ` +
      `This is unexpected — XMLWriter.readProperties should have been called.`
    );

    // Verify a known property from the fixture Configuration.xml
    assert.ok(
      node.properties && node.properties['Name'] !== undefined,
      `Expected 'Name' property to be loaded from Configuration.xml, but it was missing. ` +
      `Loaded properties: ${JSON.stringify(node.properties)}`
    );
  });
});
