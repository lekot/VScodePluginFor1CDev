import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { PropertiesProvider } from '../../src/providers/propertiesProvider';
import { MetadataTreeDataProvider } from '../../src/providers/treeDataProvider';
import { TypeEditorProvider } from '../../src/providers/typeEditorProvider';
import { TreeNode, MetadataType } from '../../src/models/treeNode';
import {
  saveProperties,
  MessageHandlerContext,
} from '../../src/providers/propertiesMessageHandler';

/**
 * Tests for propertiesProvider.saveProperties changedKeys logic.
 * Validates: changedKeys comparison for Type property, XML string vs object.
 *
 * Would have caught:
 * - Type XML string from type editor skipped by changedKeys (object+string check before XML check)
 * - Type display string "string(10)" treated as change when it shouldn't be
 */

function createMockContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    extensionPath: '',
    extensionUri: vscode.Uri.file(path.resolve(__dirname, '..', '..')),
    globalState: {} as any,
    workspaceState: {} as any,
    secrets: {} as any,
    storageUri: undefined,
    storagePath: undefined,
    globalStorageUri: vscode.Uri.file(path.resolve(__dirname, '..', '..')),
    globalStoragePath: '',
    logUri: vscode.Uri.file(path.resolve(__dirname, '..', '..')),
    logPath: '',
    extensionMode: vscode.ExtensionMode.Test,
    extension: {} as any,
    environmentVariableCollection: {} as any,
    languageModelAccessInformation: {} as any,
    asAbsolutePath: (p: string) => p,
  };
}

function createMockMessageHandlerContext(
  treeDataProvider: MetadataTreeDataProvider,
  typeEditorProvider: TypeEditorProvider,
): MessageHandlerContext {
  return {
    currentNode: undefined,
    currentFormSelection: null,
    currentFormSelectionRevision: 0,
    isSaving: false,
    treeDataProvider,
    typeEditorProvider,
    postMessage: () => { /* no-op */ },
    updateWebviewContent: () => { /* no-op */ },
    setIsSaving: (_value: boolean) => { /* no-op */ },
  };
}

/**
 * Extract changedKeys from saveProperties by examining what it passes to XMLWriter.
 * We test the changedKeys computation logic directly by checking what gets written.
 */
suite('propertiesProvider changedKeys logic', () => {
  let provider: PropertiesProvider;
  let mockContext: vscode.ExtensionContext;
  let mockMsgCtx: MessageHandlerContext;

  setup(() => {
    mockContext = createMockContext();
    const treeDataProvider = new MetadataTreeDataProvider();
    const typeEditorProvider = new TypeEditorProvider(mockContext);
    provider = new PropertiesProvider(mockContext, treeDataProvider, typeEditorProvider);
    mockMsgCtx = createMockMessageHandlerContext(treeDataProvider, typeEditorProvider);
  });

  teardown(() => {
    provider.dispose();
  });

  /**
   * Helper: compute changedKeys using the same logic as saveProperties.
   * This is a copy of the comparison logic for isolated testing.
   */
  function computeChangedKeys(
    nodeProperties: Record<string, unknown> | undefined,
    messageProperties: Record<string, unknown>,
  ): string[] | undefined {
    if (!nodeProperties) return undefined;
    return Object.keys(messageProperties).filter(key => {
      const newValue = messageProperties[key];
      const oldValue = nodeProperties?.[key];

      // Type special handling (mirrors propertiesProvider.ts logic)
      if (key === 'Type') {
        // If new is XML string (starts with '<'), it was explicitly changed
        if (typeof newValue === 'string' && newValue.trim().startsWith('<')) {
          return true;
        }
        // If both are strings, compare directly
        if (typeof newValue === 'string' && typeof oldValue === 'string') {
          return newValue !== oldValue;
        }
        // If old is object and new is a plain string (not XML), it's a display representation
        if (typeof oldValue === 'object' && oldValue !== null && typeof newValue === 'string') {
          return false;
        }
      }

      return newValue !== oldValue;
    });
  }

  // --- Gap 4: XML string from type editor must be detected as change ---

  test('Type XML string (starts with <) is detected as changed when old is object', () => {
    const nodeProps = {
      Name: 'TestAttr',
      Type: { 'v8:Type': 'xs:string', 'v8:StringQualifiers': { 'v8:Length': '50' } },
      PasswordMode: false,
    };
    const messageProps = {
      ...nodeProps,
      Type: '<Type>\n  <v8:Type>cfg:DocumentRef.NewDoc</v8:Type>\n</Type>',
    };

    const changed = computeChangedKeys(nodeProps, messageProps);
    assert.ok(changed?.includes('Type'),
      'Type XML string from type editor must be detected as changed');
  });

  test('Type display string "string(10)" is NOT detected as changed when old is object', () => {
    const nodeProps = {
      Name: 'TestAttr',
      Type: { 'v8:Type': 'xs:string', 'v8:StringQualifiers': { 'v8:Length': '50' } },
      PasswordMode: false,
    };
    const messageProps = {
      ...nodeProps,
      Type: 'string(50)',
    };

    const changed = computeChangedKeys(nodeProps, messageProps);
    assert.ok(!changed?.includes('Type'),
      'Type display string must NOT be detected as changed (it is just a representation)');
  });

  test('Type XML string is detected as changed even when node already has XML string', () => {
    const nodeProps = {
      Name: 'TestAttr',
      Type: '<Type><v8:Type>xs:string</v8:Type></Type>',
      PasswordMode: false,
    };
    const newTypeXml = '<Type><v8:Type>xs:decimal</v8:Type></Type>';
    const messageProps = {
      ...nodeProps,
      Type: newTypeXml,
    };

    const changed = computeChangedKeys(nodeProps, messageProps);
    assert.ok(changed?.includes('Type'),
      'Different Type XML string must be detected as changed');
  });

  test('Same Type XML string is treated as explicit Type update', () => {
    const typeXml = '<Type><v8:Type>xs:string</v8:Type></Type>';
    const nodeProps = {
      Name: 'TestAttr',
      Type: typeXml,
      PasswordMode: false,
    };
    const messageProps = { ...nodeProps };

    const changed = computeChangedKeys(nodeProps, messageProps);
    assert.ok(changed?.includes('Type'),
      'Type XML payload is treated as explicit update signal');
  });

  test('PasswordMode change is detected while Type is skipped (display string)', () => {
    const nodeProps = {
      Name: 'TestAttr',
      Type: { 'v8:Type': 'xs:string', 'v8:StringQualifiers': { 'v8:Length': '50' } },
      PasswordMode: false,
    };
    const messageProps = {
      ...nodeProps,
      PasswordMode: true,
      Type: 'string(50)',
    };

    const changed = computeChangedKeys(nodeProps, messageProps);
    assert.ok(changed?.includes('PasswordMode'), 'PasswordMode change must be detected');
    assert.ok(!changed?.includes('Type'), 'Type display string must be skipped');
  });

  test('PasswordMode change with Type XML string includes both in changedKeys', () => {
    const nodeProps = {
      Name: 'TestAttr',
      Type: { 'v8:Type': 'xs:string', 'v8:StringQualifiers': { 'v8:Length': '50' } },
      PasswordMode: false,
    };
    const messageProps = {
      ...nodeProps,
      PasswordMode: true,
      Type: '<Type><v8:Type>xs:decimal</v8:Type></Type>',
    };

    const changed = computeChangedKeys(nodeProps, messageProps);
    assert.ok(changed?.includes('PasswordMode'), 'PasswordMode change must be detected');
    assert.ok(changed?.includes('Type'), 'Type XML string change must be detected');
  });

  // --- End-to-end: save with changedKeys writes only changed properties ---

  test('saveProperties with type editor XML string writes Type to XML file', async () => {
    const fixturesPath = path.join(__dirname, '../../../test/fixtures');
    const fixturePath = path.join(fixturesPath, 'designer-config/Catalogs/TestCatalogWithPasswordAttribute.xml');
    const tempPath = path.join(fixturesPath, 'temp-changedkeys-type.xml');

    try {
      fs.copyFileSync(fixturePath, tempPath);

      const node: TreeNode = {
        id: 'test',
        name: 'Password',
        type: MetadataType.Attribute,
        properties: {
          Name: 'Password',
          Type: { 'v8:Type': 'xs:string', 'v8:StringQualifiers': { 'v8:Length': '10' } },
          PasswordMode: false,
        },
        filePath: '',
        parentFilePath: tempPath,
      };

      const newTypeXml = '<Type><v8:Type>xs:decimal</v8:Type></Type>';
      const newProperties = {
        ...node.properties,
        Type: newTypeXml,
      };

      await saveProperties(node, newProperties, mockMsgCtx);

      const result = fs.readFileSync(tempPath, 'utf-8');
      assert.ok(result.includes('<v8:Type>xs:decimal</v8:Type>'),
        'Type should be written to XML when changed via type editor');
    } finally {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }
  });

  test('saveProperties with display string Type does NOT overwrite structured Type', async () => {
    const fixturesPath = path.join(__dirname, '../../../test/fixtures');
    const fixturePath = path.join(fixturesPath, 'designer-config/Catalogs/TestCatalogWithPasswordAttribute.xml');
    const tempPath = path.join(fixturesPath, 'temp-changedkeys-notype.xml');

    try {
      fs.copyFileSync(fixturePath, tempPath);

      const node: TreeNode = {
        id: 'test',
        name: 'Password',
        type: MetadataType.Attribute,
        properties: {
          Name: 'Password',
          Type: { 'v8:Type': 'xs:string', 'v8:StringQualifiers': { 'v8:Length': '10' } },
          PasswordMode: false,
        },
        filePath: '',
        parentFilePath: tempPath,
      };

      // Simulate webview sending all properties with Type as display string
      const newProperties = {
        Name: 'Password',
        Type: 'string(10)',
        PasswordMode: true,
      };

      await saveProperties(node, newProperties, mockMsgCtx);

      const result = fs.readFileSync(tempPath, 'utf-8');
      assert.ok(result.includes('<v8:Type>xs:string</v8:Type>'),
        'Structured Type must NOT be overwritten by display string');
      assert.ok(result.includes('<PasswordMode>true</PasswordMode>'),
        'PasswordMode should be updated');
      assert.ok(!result.includes('<Type>string(10)</Type>'),
        'Display string must not be written to XML');
    } finally {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }
  });
});
