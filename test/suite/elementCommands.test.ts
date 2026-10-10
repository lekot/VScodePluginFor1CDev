import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { registerElementCommands } from '../../src/commands/elementCommands';
import { MetadataType, TreeNode } from '../../src/models/treeNode';
import type { ExtensionState } from '../../src/state/extensionState';

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
});
