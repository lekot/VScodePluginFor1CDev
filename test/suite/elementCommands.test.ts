import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { registerElementCommands } from '../../src/commands/elementCommands';
import { MetadataType, TreeNode } from '../../src/models/treeNode';
import type { ExtensionState } from '../../src/state/extensionState';
import { MutationPlanExecutor } from '../../src/services/configurationSession/mutationPlan';

suite('elementCommands', () => {
  const defaultRegisterCommand = vscode.commands.registerCommand.bind(vscode.commands);
  const patchedCommands = vscode.commands as unknown as {
    registerCommand: typeof vscode.commands.registerCommand;
  };

  setup(() => {
    patchedCommands.registerCommand = defaultRegisterCommand;
  });

  teardown(() => {
    patchedCommands.registerCommand = defaultRegisterCommand;
  });

  test('registers five element command handlers', () => {
    const ids: string[] = [];
    patchedCommands.registerCommand = (id: string) => {
      ids.push(id);
      return { dispose: () => undefined };
    };

    const disposables = registerElementCommands({
      state: {} as unknown as ExtensionState,
      loadMetadataTree: async () => undefined,
      invalidateCacheAndReload: async () => undefined,
      scheduleDeleteReconcile: () => undefined,
    });

    assert.strictEqual(disposables.length, 5);
    assert.deepStrictEqual(ids, [
      '1c-metadata-tree.createElement',
      '1c-metadata-tree.createForm',
      '1c-metadata-tree.duplicateElement',
      '1c-metadata-tree.deleteElement',
      '1c-metadata-tree.renameElement',
    ]);
  });

  test('deleteElement command prompts with warning dialog and respects cancellation', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '1c-cmd-test-'));
    fs.writeFileSync(
      path.join(tmpDir, 'Configuration.xml'),
      '<?xml version="1.0" encoding="UTF-8"?><MetaDataObject><Configuration name="TestConfig"/></MetaDataObject>',
      'utf8'
    );

    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    const patchedCommands = vscode.commands as unknown as {
      registerCommand: (id: string, handler: (...args: unknown[]) => Promise<unknown>) => vscode.Disposable;
    };
    patchedCommands.registerCommand = (id: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(id, handler);
      return { dispose: () => undefined };
    };

    let shownWarning: string | undefined;
    const origShowWarning = vscode.window.showWarningMessage;
    const patchedWindow = vscode.window as unknown as {
      showWarningMessage: (msg: string, ...rest: unknown[]) => Promise<string | undefined>;
    };
    patchedWindow.showWarningMessage = async (msg: string) => {
      shownWarning = msg;
      return 'Отмена';
    };

    try {
      registerElementCommands({
        state: {
          currentFormat: 'designer',
          currentPath: tmpDir,
          treeDataProvider: {
            getConfigPath: () => tmpDir,
            getConfigPathForNode: () => tmpDir,
          },
        } as unknown as ExtensionState,
        loadMetadataTree: async () => undefined,
        invalidateCacheAndReload: async () => undefined,
        scheduleDeleteReconcile: () => undefined,
      });

      const deleteHandler = handlers.get('1c-metadata-tree.deleteElement');
      assert.ok(deleteHandler);

      const targetNode: TreeNode = {
        id: 'Catalog.Test',
        name: 'Test',
        type: MetadataType.Catalog,
        properties: {},
        filePath: path.join(tmpDir, 'Catalogs', 'Test.xml'),
      };
      await deleteHandler(targetNode);
      assert.ok(shownWarning?.includes('Удалить элемент «Test»?'));
    } finally {
      (vscode.window as unknown as { showWarningMessage: typeof origShowWarning }).showWarningMessage = origShowWarning;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('Sequence root create and delete commands execute the shared metadata CRUD plans', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), '1c-sequence-command-'));
    fs.writeFileSync(
      path.join(tempRoot, 'Configuration.xml'),
      '<?xml version="1.0" encoding="UTF-8"?><MetaDataObject version="2.20" xmlns="http://v8.1c.ru/8.3/MDClasses"><Configuration uuid="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"><Properties><Name>TestConfig</Name></Properties><ChildObjects/></Configuration></MetaDataObject>',
      'utf8',
    );

    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    const patchedCommands = vscode.commands as unknown as {
      registerCommand: (id: string, handler: (...args: unknown[]) => Promise<unknown>) => vscode.Disposable;
    };
    patchedCommands.registerCommand = (id: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(id, handler);
      return { dispose: () => undefined };
    };

    const originalShowInputBox = vscode.window.showInputBox;
    const originalShowWarningMessage = vscode.window.showWarningMessage;
    const originalShowInformationMessage = vscode.window.showInformationMessage;
    const originalShowErrorMessage = vscode.window.showErrorMessage;
    const patchedWindow = vscode.window as unknown as {
      showInputBox: (...args: unknown[]) => Promise<string | undefined>;
      showWarningMessage: (...args: unknown[]) => Promise<string | undefined>;
      showInformationMessage: (...args: unknown[]) => Promise<unknown>;
      showErrorMessage: (...args: unknown[]) => Promise<unknown>;
    };
    patchedWindow.showInputBox = async () => 'PostingOrder';
    patchedWindow.showWarningMessage = async () => 'Удалить';
    patchedWindow.showInformationMessage = async () => undefined;
    patchedWindow.showErrorMessage = async () => undefined;

    const sequenceFolderPath = path.join(tempRoot, 'Sequences');
    const sequenceFilePath = path.join(sequenceFolderPath, 'PostingOrder.xml');
    const configurationNode: TreeNode = {
      id: 'Configuration',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
    };
    const sequenceFolder: TreeNode = {
      id: 'Sequences',
      name: 'Sequences',
      type: MetadataType.Sequence,
      filePath: sequenceFolderPath,
      parent: configurationNode,
      properties: {},
    };

    try {
      registerElementCommands({
        state: {
          treeDataProvider: {
            getConfigPathForNode: () => tempRoot,
            getConfigPath: () => tempRoot,
            resolveNodeForUi: (node: TreeNode) => node,
            refresh: () => undefined,
            applyOptimisticDelete: () => true,
          },
        } as unknown as ExtensionState,
        loadMetadataTree: async () => undefined,
        invalidateCacheAndReload: async () => undefined,
        scheduleDeleteReconcile: () => undefined,
        runConfigurationPlan: async <T>(configPath: string, plan: import('../../src/services/configurationSession/mutationPlan').MutationPlan<T>) =>
          new MutationPlanExecutor(configPath).execute(plan),
      });

      const createHandler = handlers.get('1c-metadata-tree.createElement');
      assert.ok(createHandler);
      await createHandler(sequenceFolder);
      assert.ok(fs.existsSync(sequenceFilePath), 'UI create should write the Sequence root descriptor');
      assert.match(
        fs.readFileSync(path.join(tempRoot, 'Configuration.xml'), 'utf8'),
        /<Sequence>PostingOrder<\/Sequence>/,
      );

      const sequenceNode: TreeNode = {
        id: 'Sequences.PostingOrder',
        name: 'PostingOrder',
        type: MetadataType.Sequence,
        filePath: sequenceFilePath,
        parent: sequenceFolder,
        properties: {},
      };
      const deleteHandler = handlers.get('1c-metadata-tree.deleteElement');
      assert.ok(deleteHandler);
      await deleteHandler(sequenceNode);
      assert.strictEqual(fs.existsSync(sequenceFilePath), false, 'UI delete should remove the Sequence root descriptor');
      assert.doesNotMatch(
        fs.readFileSync(path.join(tempRoot, 'Configuration.xml'), 'utf8'),
        /<Sequence>PostingOrder<\/Sequence>/,
      );
    } finally {
      patchedWindow.showInputBox = originalShowInputBox as unknown as (...args: unknown[]) => Promise<string | undefined>;
      patchedWindow.showWarningMessage = originalShowWarningMessage as unknown as (...args: unknown[]) => Promise<string | undefined>;
      patchedWindow.showInformationMessage = originalShowInformationMessage as unknown as (...args: unknown[]) => Promise<unknown>;
      patchedWindow.showErrorMessage = originalShowErrorMessage as unknown as (...args: unknown[]) => Promise<unknown>;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('root create command preserves an EDT src/Roles target through the UI adapter', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), '1c-edt-role-command-'));
    fs.writeFileSync(
      path.join(tempRoot, 'Configuration.xml'),
      '<?xml version="1.0" encoding="UTF-8"?><MetaDataObject version="2.20" xmlns="http://v8.1c.ru/8.3/MDClasses"><Configuration uuid="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"><Properties><Name>EdtCfg</Name></Properties><ChildObjects/></Configuration></MetaDataObject>',
      'utf8',
    );
    const srcRoles = path.join(tempRoot, 'src', 'Roles');
    fs.mkdirSync(srcRoles, { recursive: true });

    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    patchedCommands.registerCommand = (id: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(id, handler);
      return { dispose: () => undefined };
    };

    const originalShowInputBox = vscode.window.showInputBox;
    const originalShowInformationMessage = vscode.window.showInformationMessage;
    const originalShowErrorMessage = vscode.window.showErrorMessage;
    const patchedWindow = vscode.window as unknown as {
      showInputBox: (...args: unknown[]) => Promise<string | undefined>;
      showInformationMessage: (...args: unknown[]) => Promise<unknown>;
      showErrorMessage: (...args: unknown[]) => Promise<unknown>;
    };
    patchedWindow.showInputBox = async () => 'EdtRole';
    patchedWindow.showInformationMessage = async () => undefined;
    patchedWindow.showErrorMessage = async () => undefined;

    let mutationCalls = 0;
    let planCalls = 0;
    const configurationNode: TreeNode = {
      id: 'Configuration',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
    };
    const commonNode: TreeNode = {
      id: 'Common',
      name: 'Общие',
      type: MetadataType.Unknown,
      parent: configurationNode,
      properties: {},
    };
    const rolesFolder: TreeNode = {
      id: 'Roles',
      name: 'Роли',
      type: MetadataType.Role,
      filePath: srcRoles,
      parent: commonNode,
      properties: {},
    };

    try {
      registerElementCommands({
        state: {
          treeDataProvider: {
            getConfigPathForNode: () => tempRoot,
            getConfigPath: () => tempRoot,
          },
        } as unknown as ExtensionState,
        loadMetadataTree: async () => undefined,
        invalidateCacheAndReload: async () => undefined,
        scheduleDeleteReconcile: () => undefined,
        runConfigurationMutation: async (_configPath, _kind, operation) => {
          mutationCalls++;
          return operation();
        },
        runConfigurationPlan: async <T>(configPath: string, plan: import('../../src/services/configurationSession/mutationPlan').MutationPlan<T>) => {
          planCalls++;
          return new MutationPlanExecutor(configPath).execute(plan);
        },
      });

      const createHandler = handlers.get('1c-metadata-tree.createElement');
      assert.ok(createHandler);
      await createHandler(rolesFolder);

      assert.strictEqual(mutationCalls, 1, 'EDT folder creation should use the existing UI mutation adapter');
      assert.strictEqual(planCalls, 0, 'EDT folder creation must not use the Designer-only metadata planner');
      assert.ok(fs.existsSync(path.join(srcRoles, 'EdtRole.xml')));
      assert.ok(!fs.existsSync(path.join(tempRoot, 'Roles', 'EdtRole.xml')));
      assert.match(fs.readFileSync(path.join(tempRoot, 'Configuration.xml'), 'utf8'), /<Role>EdtRole<\/Role>/);
    } finally {
      patchedWindow.showInputBox = originalShowInputBox as unknown as (...args: unknown[]) => Promise<string | undefined>;
      patchedWindow.showInformationMessage = originalShowInformationMessage as unknown as (...args: unknown[]) => Promise<unknown>;
      patchedWindow.showErrorMessage = originalShowErrorMessage as unknown as (...args: unknown[]) => Promise<unknown>;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
