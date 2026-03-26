import * as assert from 'assert';
import * as vscode from 'vscode';
import { registerEditorCommands } from '../../src/commands/editorCommands';
import { MetadataType } from '../../src/models/treeNode';

suite('editorCommands', () => {
  const defaultRegisterCommand = vscode.commands.registerCommand.bind(vscode.commands);

  setup(() => {
    (vscode.commands as any).registerCommand = defaultRegisterCommand;
  });

  teardown(() => {
    (vscode.commands as any).registerCommand = defaultRegisterCommand;
  });

  test('registers seven editor-related command handlers', () => {
    const ids: string[] = [];
    (vscode.commands as any).registerCommand = (id: string) => {
      ids.push(id);
      return { dispose: () => undefined };
    };

    const disposables = registerEditorCommands({ state: {} as any });

    assert.strictEqual(disposables.length, 7);
    assert.deepStrictEqual(ids, [
      '1c-metadata-tree.showProperties',
      '1c-metadata-tree.openXML',
      '1c-metadata-tree.openBslModule',
      '1c-metadata-tree.openFormEditor',
      '1c-metadata-tree.openRightsEditor',
      '1c-metadata-tree.openTemplatePreview',
      '1c-metadata-tree.saveRightsEditor',
    ]);
  });

  test('openTemplatePreview opens mxl preview for Template/CommonTemplate', async () => {
    const handlers: Record<string, (node: any) => Promise<void> | void> = {};

    (vscode.commands as any).registerCommand = (id: string, handler: any) => {
      handlers[id] = handler;
      return { dispose: () => undefined };
    };

    // command registration only; we will invoke handler directly
    registerEditorCommands({ state: {} as any });

    const executeCalls: Array<{ command: string; args: unknown[] }> = [];
    (vscode.commands as any).executeCommand = async (command: string, ...args: unknown[]) => {
      executeCalls.push({ command, args });
      return {} as any;
    };

    const warningCalls: string[] = [];
    (vscode.window as any).showWarningMessage = async (message: string) => {
      warningCalls.push(message);
      return undefined;
    };

    const templateNode = {
      id: 'tpl',
      name: 'tpl',
      type: MetadataType.Template,
      properties: {},
      filePath: 'C:/tmp/template.mxl',
    };

    await handlers['1c-metadata-tree.openTemplatePreview'](templateNode);
    assert.ok(
      executeCalls.some((c) => c.command === 'vscode.openWith' && c.args[1] === '1c-mxl-preview'),
      'vscode.openWith called with viewType=1c-mxl-preview'
    );

    const wrongNode = {
      id: 'cat',
      name: 'cat',
      type: MetadataType.Catalog,
      properties: {},
      filePath: 'C:/tmp/catalog.xml',
    };

    await handlers['1c-metadata-tree.openTemplatePreview'](wrongNode);
    assert.ok(
      warningCalls.some((m) => m.includes('Preview макета доступен только')),
      'warns for non-template node'
    );
  });
});
