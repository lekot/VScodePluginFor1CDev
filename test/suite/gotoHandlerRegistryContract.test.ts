import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { MetadataType, TreeNode } from '../../src/models/treeNode';
import {
  handleGotoHandlerMessage,
  type MessageHandlerContext,
} from '../../src/providers/propertiesMessageHandler';
import { cleanupTempDir, createTempDir } from '../helpers/testHelpers';
import { resetVscodeTestState } from '../helpers/vscodeModuleStub';

interface NavigationCase {
  name: string;
  metadataFolder: string;
  metadataType: MetadataType;
  objectName: string;
  moduleName: string;
  expectedFileName?: string;
}

suite('gotoHandler canonical module registry contract (#284)', () => {
  let tempRoot: string;
  let openedPaths: string[];
  let warnings: string[];
  let originalOpenTextDocument: typeof vscode.workspace.openTextDocument;
  let originalShowTextDocument: typeof vscode.window.showTextDocument;
  let originalShowWarningMessage: typeof vscode.window.showWarningMessage;

  setup(async () => {
    resetVscodeTestState();
    tempRoot = await createTempDir('1cviewer-goto-handler-registry-');
    openedPaths = [];
    warnings = [];

    originalOpenTextDocument = vscode.workspace.openTextDocument;
    originalShowTextDocument = vscode.window.showTextDocument;
    originalShowWarningMessage = vscode.window.showWarningMessage;

    (vscode.workspace as any).openTextDocument = async (uri: vscode.Uri) => {
      openedPaths.push(uri.fsPath);
      assert.ok(fs.existsSync(uri.fsPath), `Expected physical module file at ${uri.fsPath}`);
      return {
        lineCount: 1,
        lineAt: () => ({ text: '' }),
        getText: () => '',
      } as any;
    };
    (vscode.window as any).showTextDocument = async () => ({
      revealRange: () => {},
      selection: {},
    });
    (vscode.window as any).showWarningMessage = async (message: string) => {
      warnings.push(message);
    };
  });

  teardown(async () => {
    vscode.workspace.openTextDocument = originalOpenTextDocument;
    vscode.window.showTextDocument = originalShowTextDocument;
    vscode.window.showWarningMessage = originalShowWarningMessage;
    await cleanupTempDir(tempRoot);
  });

  function createNode(testCase: NavigationCase): { node: TreeNode; modulePath: string } {
    const objectFolder = path.join(tempRoot, testCase.metadataFolder, testCase.objectName);
    const objectXmlPath = path.join(objectFolder, `${testCase.objectName}.xml`);
    const moduleFileName = testCase.expectedFileName ?? `${testCase.moduleName}.bsl`;
    const modulePath = path.join(objectFolder, 'Ext', moduleFileName);
    fs.mkdirSync(path.dirname(modulePath), { recursive: true });
    fs.writeFileSync(objectXmlPath, '');
    fs.writeFileSync(modulePath, '');

    return {
      node: {
        id: `${testCase.metadataFolder}.${testCase.objectName}`,
        name: testCase.objectName,
        type: testCase.metadataType,
        filePath: objectXmlPath,
        properties: {},
      },
      modulePath,
    };
  }

  function createContext(node: TreeNode): MessageHandlerContext {
    return {
      currentNode: node,
      currentFormSelection: null,
      currentFormSelectionRevision: 0,
      isSaving: false,
      treeDataProvider: {
        findNodesByName: (query: string) => (query === node.name ? [node] : []),
      } as any,
      typeEditorProvider: {} as any,
      objectTypeEditorProvider: {} as any,
      postMessage: () => {},
      updateWebviewContent: () => {},
      setIsSaving: () => {},
    };
  }

  test('opens canonical modules and legacy alias, and rejects unknown type-kind pairs with physical files', async () => {
    const cases: NavigationCase[] = [
      {
        name: 'Catalog ObjectModule',
        metadataFolder: 'Catalogs',
        metadataType: MetadataType.Catalog,
        objectName: 'Products',
        moduleName: 'ObjectModule',
        expectedFileName: 'ObjectModule.bsl',
      },
      {
        name: 'Catalog ManagerModule',
        metadataFolder: 'Catalogs',
        metadataType: MetadataType.Catalog,
        objectName: 'Prices',
        moduleName: 'ManagerModule',
        expectedFileName: 'ManagerModule.bsl',
      },
      {
        name: 'Enum ManagerModule',
        metadataFolder: 'Enums',
        metadataType: MetadataType.Enum,
        objectName: 'Statuses',
        moduleName: 'ManagerModule',
        expectedFileName: 'ManagerModule.bsl',
      },
      {
        name: 'CommonModule',
        metadataFolder: 'CommonModules',
        metadataType: MetadataType.CommonModule,
        objectName: 'Shared',
        moduleName: 'CommonModule',
        expectedFileName: 'Module.bsl',
      },
      {
        name: 'legacy ObjectManagerModule alias',
        metadataFolder: 'Catalogs',
        metadataType: MetadataType.Catalog,
        objectName: 'LegacyHandlers',
        moduleName: 'ObjectManagerModule',
        expectedFileName: 'ObjectManagerModule.bsl',
      },
      {
        name: 'Enum ObjectManagerModule legacy alias is unsupported',
        metadataFolder: 'Enums',
        metadataType: MetadataType.Enum,
        objectName: 'UnsupportedLegacyEnum',
        moduleName: 'ObjectManagerModule',
      },
      {
        name: 'Enum ObjectModule is unsupported',
        metadataFolder: 'Enums',
        metadataType: MetadataType.Enum,
        objectName: 'UnsupportedEnum',
        moduleName: 'ObjectModule',
      },
      {
        name: 'Catalog ValueManagerModule is unsupported',
        metadataFolder: 'Catalogs',
        metadataType: MetadataType.Catalog,
        objectName: 'UnsupportedCatalog',
        moduleName: 'ValueManagerModule',
      },
      {
        name: 'InformationRegister ObjectModule is unsupported',
        metadataFolder: 'InformationRegisters',
        metadataType: MetadataType.InformationRegister,
        objectName: 'UnsupportedRegister',
        moduleName: 'ObjectModule',
      },
    ];

    for (const testCase of cases) {
      const { node, modulePath } = createNode(testCase);
      const beforeOpenCount = openedPaths.length;
      const beforeWarningCount = warnings.length;
      const handler =
        testCase.metadataType === MetadataType.CommonModule
          ? `CommonModule.${testCase.objectName}.Handle`
          : `${testCase.metadataFolder}.${testCase.objectName}.${testCase.moduleName}.Handle`;

      await handleGotoHandlerMessage({ type: 'gotoHandler', handler }, createContext(node));

      if (testCase.expectedFileName) {
        assert.strictEqual(openedPaths.length, beforeOpenCount + 1, `${testCase.name} should open`);
        assert.strictEqual(openedPaths[openedPaths.length - 1], modulePath);
        assert.strictEqual(
          path.basename(openedPaths[openedPaths.length - 1]),
          testCase.expectedFileName
        );
        assert.strictEqual(warnings.length, beforeWarningCount, `${testCase.name} should not warn`);
      } else {
        assert.strictEqual(
          openedPaths.length,
          beforeOpenCount,
          `${testCase.name} must not open the physically present guessed path ${modulePath}`
        );
        assert.strictEqual(warnings.length, beforeWarningCount + 1, `${testCase.name} should warn`);
        assert.match(warnings[warnings.length - 1], /не поддерживается|не найден/i);
      }
    }
  });
});
