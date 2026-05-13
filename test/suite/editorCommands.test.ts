import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { registerEditorCommands } from '../../src/commands/editorCommands';
import { MetadataType } from '../../src/models/treeNode';

suite('editorCommands', () => {
  const defaultRegisterCommand = vscode.commands.registerCommand.bind(vscode.commands);
  const defaultShowWarningMessage = vscode.window.showWarningMessage.bind(vscode.window);
  const defaultExecuteCommand = vscode.commands.executeCommand.bind(vscode.commands);

  setup(() => {
    (vscode.commands as any).registerCommand = defaultRegisterCommand;
    (vscode.commands as any).executeCommand = defaultExecuteCommand;
    (vscode.window as any).showWarningMessage = defaultShowWarningMessage;
  });

  teardown(() => {
    (vscode.commands as any).registerCommand = defaultRegisterCommand;
    (vscode.commands as any).executeCommand = defaultExecuteCommand;
    (vscode.window as any).showWarningMessage = defaultShowWarningMessage;
  });

  test('registers editor-related command handlers', () => {
    const ids: string[] = [];
    (vscode.commands as any).registerCommand = (id: string) => {
      ids.push(id);
      return { dispose: () => undefined };
    };

    const disposables = registerEditorCommands({ state: {} as any });

    assert.strictEqual(disposables.length, 17);
    assert.deepStrictEqual(ids, [
      '1c-metadata-tree.showProperties',
      '1c-metadata-tree.openXML',
      '1c-metadata-tree.openBslModule',
      '1c-metadata-tree.openFormEditor',
      '1c-metadata-tree.openRightsEditor',
      '1c-metadata-tree.openTemplatePreview',
      '1c-metadata-tree.saveRightsEditor',
      '1c-metadata-tree.validateCurrentXml',
      '1c-metadata-tree.editSubsystemComposition',
      '1c-metadata-tree.editExchangePlanContent',
      '1c-metadata-tree.editCommonAttributeContent',
      '1c-metadata-tree.editFunctionalOptionContent',
      '1c-metadata-tree.editFilterCriterionContent',
      '1c-metadata-tree.editSubsystemCommandInterface',
      '1c-metadata-tree.editXdtoPackageSchema',
      '1c-metadata-tree.viewChartOfCharacteristicTypesPredefined',
      '1c-metadata-tree.startDebugging',
    ]);
  });

  test('openBslModule opens with preview:false', async () => {
    const handlers: Record<string, (node: any) => Promise<void> | void> = {};
    (vscode.commands as any).registerCommand = (id: string, handler: any) => {
      handlers[id] = handler;
      return { dispose: () => undefined };
    };

    const showTextCalls: Array<{ uri: vscode.Uri; options: any }> = [];
    (vscode.window as any).showTextDocument = async (uri: vscode.Uri, options?: any) => {
      showTextCalls.push({ uri, options });
      return {} as any;
    };

    registerEditorCommands({ state: {} as any });

    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), '1cv-bsl-'));
    try {
      const bslPath = path.join(tmpRoot, 'Module.bsl');
      await fs.writeFile(bslPath, '', 'utf8');

      const node = {
        id: 'mod',
        name: 'mod',
        type: MetadataType.CommonModule,
        properties: {},
        filePath: bslPath,
      };

      await handlers['1c-metadata-tree.openBslModule'](node);

      assert.strictEqual(showTextCalls.length, 1, 'showTextDocument called once');
      assert.strictEqual(showTextCalls[0].options?.preview, false, 'preview:false for BSL module');
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      (vscode.window as any).showTextDocument = undefined;
    }
  });

  test('openXML opens with preview:false', async () => {
    const handlers: Record<string, (node: any) => Promise<void> | void> = {};
    (vscode.commands as any).registerCommand = (id: string, handler: any) => {
      handlers[id] = handler;
      return { dispose: () => undefined };
    };

    const showTextCalls: Array<{ uri: vscode.Uri; options: any }> = [];
    (vscode.window as any).showTextDocument = async (uri: vscode.Uri, options?: any) => {
      showTextCalls.push({ uri, options });
      return {} as any;
    };

    registerEditorCommands({ state: {} as any });

    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), '1cv-xml-'));
    try {
      const xmlPath = path.join(tmpRoot, 'Catalog.xml');
      await fs.writeFile(xmlPath, '<root/>', 'utf8');

      const node = {
        id: 'cat',
        name: 'cat',
        type: MetadataType.Catalog,
        properties: {},
        filePath: xmlPath,
      };

      await handlers['1c-metadata-tree.openXML'](node);

      assert.strictEqual(showTextCalls.length, 1, 'showTextDocument called once');
      assert.strictEqual(showTextCalls[0].options?.preview, false, 'preview:false for XML');
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      (vscode.window as any).showTextDocument = undefined;
    }
  });

  test('openFormEditor passes preview:false to vscode.openWith', async () => {
    const handlers: Record<string, (node: any) => Promise<void> | void> = {};
    (vscode.commands as any).registerCommand = (id: string, handler: any) => {
      handlers[id] = handler;
      return { dispose: () => undefined };
    };

    const executeCalls: Array<{ command: string; args: unknown[] }> = [];
    (vscode.commands as any).executeCommand = async (command: string, ...args: unknown[]) => {
      executeCalls.push({ command, args });
      return {} as any;
    };

    registerEditorCommands({ state: {} as any });

    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), '1cv-form-'));
    try {
      const formDir = path.join(tmpRoot, 'Forms', 'MyForm');
      await fs.mkdir(formDir, { recursive: true });
      const formXml = path.join(tmpRoot, 'Forms', 'MyForm.xml');
      await fs.writeFile(formXml, '<form/>', 'utf8');
      const innerXml = path.join(formDir, 'Ext', 'Form.xml');
      await fs.mkdir(path.dirname(innerXml), { recursive: true });
      await fs.writeFile(innerXml, '<form/>', 'utf8');

      const node = {
        id: 'frm',
        name: 'MyForm',
        type: MetadataType.Form,
        properties: {},
        filePath: formXml,
      };

      await handlers['1c-metadata-tree.openFormEditor'](node);

      const openWith = executeCalls.find((c) => c.command === 'vscode.openWith');
      assert.ok(openWith, 'vscode.openWith was called');
      assert.strictEqual(openWith!.args[1], '1c-form-editor', 'uses 1c-form-editor viewType');
      const opts = openWith!.args[2] as any;
      assert.strictEqual(opts?.preview, false, 'preview:false passed to openWith');
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('openTemplatePreview opens mxl preview with resolved Ext/Template.xml URI', async () => {
    const handlers: Record<string, (node: any) => Promise<void> | void> = {};

    (vscode.commands as any).registerCommand = (id: string, handler: any) => {
      handlers[id] = handler;
      return { dispose: () => undefined };
    };

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

    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), '1cv-ed-cmd-'));
    try {
      const bodyPath = path.join(tmpRoot, 'Templates', 'tpl', 'Ext', 'Template.xml');
      await fs.mkdir(path.dirname(bodyPath), { recursive: true });
      await fs.writeFile(bodyPath, '<mxl/>', 'utf8');
      const descPath = path.join(tmpRoot, 'Templates', 'tpl.xml');

      const templateNode = {
        id: 'tpl',
        name: 'tpl',
        type: MetadataType.Template,
        properties: {},
        filePath: descPath,
      };

      await handlers['1c-metadata-tree.openTemplatePreview'](templateNode);

      const openWith = executeCalls.find((c) => c.command === 'vscode.openWith');
      assert.ok(openWith, 'vscode.openWith invoked');
      assert.strictEqual(openWith!.args[1], '1c-mxl-preview');
      const uri = openWith!.args[0] as vscode.Uri;
      assert.strictEqual(uri.fsPath, path.normalize(bodyPath));

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
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('validateCurrentXml warns when no active editor', async () => {
    const handlers: Record<string, () => Promise<void> | void> = {};
    (vscode.commands as any).registerCommand = (id: string, handler: any) => {
      handlers[id] = handler;
      return { dispose: () => undefined };
    };
    const warnings: string[] = [];
    (vscode.window as any).showWarningMessage = async (m: string) => {
      warnings.push(m);
      return undefined;
    };
    (vscode.window as any).activeTextEditor = undefined;
    registerEditorCommands({ state: { bindingManager: {}, infobaseStorage: {} } as any });
    await handlers['1c-metadata-tree.validateCurrentXml']();
    assert.ok(warnings.some((m) => m.includes('XML-файл')));
  });

  test('validateCurrentXml warns for non-xml editor', async () => {
    const handlers: Record<string, () => Promise<void> | void> = {};
    (vscode.commands as any).registerCommand = (id: string, handler: any) => {
      handlers[id] = handler;
      return { dispose: () => undefined };
    };
    const warnings: string[] = [];
    (vscode.window as any).showWarningMessage = async (m: string) => {
      warnings.push(m);
      return undefined;
    };
    (vscode.window as any).activeTextEditor = {
      document: { uri: vscode.Uri.file('C:/tmp/test.bsl') },
    };
    registerEditorCommands({ state: { bindingManager: {}, infobaseStorage: {} } as any });
    await handlers['1c-metadata-tree.validateCurrentXml']();
    assert.ok(warnings.some((m) => m.includes('только для активного XML')));
  });
});
