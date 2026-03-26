import * as assert from 'assert';
import * as vscode from 'vscode';
import { registerElementCommands } from '../../src/commands/elementCommands';

suite('elementCommands', () => {
  let originalCommands: any;

  setup(() => {
    const vsAny = vscode as any;
    originalCommands = vsAny.commands;
    if (!vsAny.commands) {
      vsAny.commands = {};
    }
  });

  teardown(() => {
    const vsAny = vscode as any;
    vsAny.commands = originalCommands;
  });

  test('registers five element command handlers', () => {
    const ids: string[] = [];
    (vscode as any).commands.registerCommand = (id: string) => {
      ids.push(id);
      return { dispose: () => undefined };
    };

    const disposables = registerElementCommands({
      state: {} as any,
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
});
