import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import '../helpers/vscodeStubRegister';
import * as vscode from 'vscode';
import { FormEditorProvider } from '../../src/formEditor/formEditorProvider';
import type { FormModel } from '../../src/formEditor/formModel';

const cancellation = { isCancellationRequested: false } as vscode.CancellationToken;

function makeModel(width = '100'): FormModel {
  return {
    version: '2.20',
    attributes: [],
    commands: [],
    formEvents: [],
    childItemsRoot: [
      {
        id: 'field-1',
        name: 'Field1',
        tag: 'InputField',
        properties: { Width: width },
        childItems: [],
      },
    ],
  };
}

function makePanel(active = true): {
  panel: vscode.WebviewPanel;
  setActive(newActive: boolean): void;
  receive(message: unknown): Promise<void>;
  dispose(): void;
} {
  let messageHandler: ((message: any) => Promise<void>) | undefined;
  let disposeHandler: (() => void) | undefined;
  const viewStateListeners: Array<(e: { webviewPanel: vscode.WebviewPanel }) => void> = [];
  const panel = {
    title: '',
    active,
    webview: {
      options: {},
      html: '',
      postMessage: async () => true,
      onDidReceiveMessage: (handler: (message: any) => Promise<void>) => {
        messageHandler = handler;
        return { dispose: () => undefined };
      },
    },
    onDidChangeViewState: (handler: (e: { webviewPanel: vscode.WebviewPanel }) => void) => {
      viewStateListeners.push(handler);
      return { dispose: () => undefined };
    },
    onDidDispose: (handler: () => void) => {
      disposeHandler = handler;
      return { dispose: () => undefined };
    },
  } as unknown as vscode.WebviewPanel;
  return {
    panel,
    setActive: (newActive: boolean) => {
      (panel as any).active = newActive;
      for (const l of [...viewStateListeners]) {
        l({ webviewPanel: panel });
      }
    },
    receive: async (message) => {
      assert.ok(messageHandler, 'message handler must be registered');
      await messageHandler!(message);
    },
    dispose: () => disposeHandler?.(),
  };
}

suite('FormEditorProvider editable document lifecycle', () => {
  test('fires native dirty event and retains model until custom document disposal', async () => {
    delete process.env.FORM_COMMAND_ENGINE_ENABLED;
    const provider = new FormEditorProvider();
    const uri = vscode.Uri.file('C:/tmp/form-lifecycle/Ext/Form.xml');
    const document = await provider.openCustomDocument(uri);
    const key = uri.toString();
    (provider as any).documentModel.set(key, makeModel());
    const view = makePanel();
    await provider.resolveCustomEditor(document, view.panel);
    assert.strictEqual(provider.getActiveDocumentUri()?.toString(), uri.toString());

    let changes = 0;
    const subscription = provider.onDidChangeCustomDocument(() => { changes += 1; });
    await view.receive({
      type: 'propertyChange',
      elementId: 'field-1',
      key: 'Width',
      value: '200',
    });

    assert.strictEqual(changes, 1);
    assert.strictEqual((provider as any).dirtyDocuments.has(key), true);
    view.dispose();
    assert.strictEqual((provider as any).documentModel.has(key), true, 'panel is not the document owner');

    document.dispose();
    assert.strictEqual((provider as any).documentModel.has(key), false, 'last document owner releases the model');
    subscription.dispose();
    provider.dispose();
  });

  test('persists and restores a hot-exit backup', async () => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'form-editor-backup-'));
    try {
      const provider = new FormEditorProvider();
      const uri = vscode.Uri.file(path.join(tempDir, 'Form.xml'));
      const document = await provider.openCustomDocument(uri);
      const key = uri.toString();
      (provider as any).documentModel.set(key, makeModel('321'));
      const destination = vscode.Uri.file(path.join(tempDir, 'storage', 'backup.json'));

      const backup = await provider.backupCustomDocument(
        document,
        { destination },
        cancellation,
      );
      document.dispose();
      assert.strictEqual((provider as any).documentModel.has(key), false);

      const restored = await provider.openCustomDocument(uri, {
        backupId: backup.id,
        untitledDocumentData: undefined,
      });
      const restoredModel = (provider as any).documentModel.get(key) as FormModel;
      assert.strictEqual(restoredModel.childItemsRoot[0].properties.Width, '321');
      assert.strictEqual((provider as any).dirtyDocuments.has(key), true);

      restored.dispose();
      backup.delete();
      provider.dispose();
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('save and revert use the custom document model', async () => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'form-editor-save-'));
    try {
      const provider = new FormEditorProvider();
      const uri = vscode.Uri.file(path.join(tempDir, 'Form.xml'));
      const document = await provider.openCustomDocument(uri);
      const key = uri.toString();
      (provider as any).documentModel.set(key, makeModel('410'));
      (provider as any).dirtyDocuments.add(key);

      await provider.saveCustomDocument(document, cancellation);
      assert.match(await fs.promises.readFile(uri.fsPath, 'utf8'), /Width/);
      assert.strictEqual((provider as any).dirtyDocuments.has(key), false);

      ((provider as any).documentModel.get(key) as FormModel).childItemsRoot[0].properties.Width = '999';
      await provider.revertCustomDocument(document, cancellation);
      const reverted = (provider as any).documentModel.get(key) as FormModel;
      assert.notStrictEqual(reverted.childItemsRoot[0].properties.Width, '999');

      document.dispose();
      provider.dispose();
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('provider saves a loaded Form.xml through the captured byte snapshot', async () => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'form-editor-source-save-'));
    try {
      const formXmlPath = path.join(tempDir, 'Catalogs', 'Goods', 'Forms', 'MainForm', 'Ext', 'Form.xml');
      const source = Buffer.from(
        '\uFEFF<?xml version="1.0" encoding="UTF-8"?>\r\n'
          + '<Form version="2.20">\r\n'
          + '\t<!-- preserve through provider save -->\r\n'
          + '\t<ChildItems>\r\n'
          + '\t\t<InputField extra=\'keep\' name=\'Field1\' id=\'field-1\'>\r\n'
          + '\t\t\t<DataPath>Before</DataPath>\r\n'
          + '\t\t</InputField>\r\n'
          + '\t</ChildItems>\r\n'
          + '</Form>\r\n',
        'utf8',
      );
      await fs.promises.mkdir(path.dirname(formXmlPath), { recursive: true });
      await fs.promises.writeFile(path.join(tempDir, 'Configuration.xml'), '<Configuration/>', 'utf8');
      await fs.promises.writeFile(formXmlPath, source);

      const provider = new FormEditorProvider();
      const uri = vscode.Uri.file(formXmlPath);
      const document = await provider.openCustomDocument(uri);
      const view = makePanel();
      await provider.resolveCustomEditor(document, view.panel);
      await view.receive({ type: 'load' });

      await provider.saveCustomDocument(document, cancellation);
      assert.deepStrictEqual(await fs.promises.readFile(formXmlPath), source, 'no-op save leaves every source byte intact');

      await view.receive({ type: 'propertyChange', elementId: 'field-1', key: 'DataPath', value: 'After & safe' });
      await provider.saveCustomDocument(document, cancellation);
      const actual = await fs.promises.readFile(formXmlPath);
      const xml = actual.toString('utf8');
      assert.ok(actual.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), 'BOM remains');
      assert.ok(xml.includes('\r\n') && !xml.replace(/\r\n/g, '').includes('\n'), 'CRLF remains consistent');
      assert.ok(xml.includes('<!-- preserve through provider save -->'), 'comment remains');
      assert.ok(xml.includes("<InputField extra='keep' name='Field1' id='field-1'>"), 'unmodified tag bytes remain');
      assert.ok(xml.includes('<DataPath>After &amp; safe</DataPath>'), 'UI property edit is spliced');

      view.dispose();
      document.dispose();
      provider.dispose();
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('fails closed for generic save of an adopted CFE form', async () => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'form-editor-adopted-cfe-'));
    try {
      const formXmlPath = path.join(tempDir, 'Catalogs', 'Products', 'Forms', 'List', 'Ext', 'Form.xml');
      const metadataPath = path.join(tempDir, 'Catalogs', 'Products', 'Forms', 'List.xml');
      await fs.promises.mkdir(path.dirname(formXmlPath), { recursive: true });
      await fs.promises.writeFile(metadataPath, `<?xml version="1.0"?><MetaDataObject version="2.20"><Form uuid="11111111-1111-4111-8111-111111111111"><Properties><ObjectBelonging>Adopted</ObjectBelonging><Name>List</Name><ExtendedConfigurationObject>22222222-2222-4222-8222-222222222222</ExtendedConfigurationObject><FormType>Managed</FormType></Properties></Form></MetaDataObject>`, 'utf8');
      const provider = new FormEditorProvider();
      const document = await provider.openCustomDocument(vscode.Uri.file(formXmlPath));
      (provider as any).documentModel.set(document.uri.toString(), makeModel());
      const view = makePanel();
      await provider.resolveCustomEditor(document, view.panel);

      await assert.rejects(
        () => provider.saveCustomDocument(document, cancellation),
        (error: { code?: string }) => error.code === 'CFE_ADOPTED_OPERATION_REQUIRED',
      );
      assert.strictEqual(fs.existsSync(formXmlPath), false, 'generic editor must not write adopted Form.xml');
      await view.receive({
        type: 'createEventHandler', elementId: 'field-1', elementName: 'Field1', tag: 'InputField', eventName: 'OnChange',
      });
      assert.strictEqual(
        fs.existsSync(path.join(tempDir, 'Catalogs', 'Products', 'Forms', 'List', 'Ext', 'Form', 'Module.bsl')),
        false,
        'generic editor must not write a handler into adopted Module.bsl',
      );

      view.dispose();
      document.dispose();
      provider.dispose();
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('fails closed for malformed metadata that explicitly marks an adopted CFE form', async () => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'form-editor-malformed-adopted-cfe-'));
    try {
      const formXmlPath = path.join(tempDir, 'Catalogs', 'Products', 'Forms', 'List', 'Ext', 'Form.xml');
      const metadataPath = path.join(tempDir, 'Catalogs', 'Products', 'Forms', 'List.xml');
      await fs.promises.mkdir(path.dirname(formXmlPath), { recursive: true });
      await fs.promises.writeFile(metadataPath, '<MetaDataObject><Form><Properties><ObjectBelonging>Adopted</ObjectBelonging>', 'utf8');
      const provider = new FormEditorProvider();
      const document = await provider.openCustomDocument(vscode.Uri.file(formXmlPath));
      (provider as any).documentModel.set(document.uri.toString(), makeModel());
      const view = makePanel();
      await provider.resolveCustomEditor(document, view.panel);

      await assert.rejects(
        () => provider.saveCustomDocument(document, cancellation),
        (error: { code?: string }) => error.code === 'CFE_ADOPTED_OPERATION_REQUIRED',
      );
      await view.receive({
        type: 'createEventHandler', elementId: 'field-1', elementName: 'Field1', tag: 'InputField', eventName: 'OnChange',
      });
      assert.strictEqual(fs.existsSync(formXmlPath), false);
      assert.strictEqual(fs.existsSync(path.join(path.dirname(formXmlPath), 'Form', 'Module.bsl')), false);

      view.dispose();
      document.dispose();
      provider.dispose();
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('keeps generic save compatible with malformed metadata without adopted ownership', async () => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'form-editor-malformed-own-'));
    try {
      const formXmlPath = path.join(tempDir, 'Catalogs', 'Products', 'Forms', 'List', 'Ext', 'Form.xml');
      const metadataPath = path.join(tempDir, 'Catalogs', 'Products', 'Forms', 'List.xml');
      await fs.promises.mkdir(path.dirname(formXmlPath), { recursive: true });
      await fs.promises.writeFile(metadataPath, '<MetaDataObject><Form><Properties><Name>List</Name>', 'utf8');
      const provider = new FormEditorProvider();
      const document = await provider.openCustomDocument(vscode.Uri.file(formXmlPath));
      (provider as any).documentModel.set(document.uri.toString(), makeModel());

      await provider.saveCustomDocument(document, cancellation);
      assert.strictEqual(fs.existsSync(formXmlPath), true);

      document.dispose();
      provider.dispose();
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('revert rejects malformed disk state and preserves the dirty in-memory model', async () => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'form-editor-revert-error-'));
    try {
      const formXmlPath = path.join(tempDir, 'Ext', 'Form.xml');
      await fs.promises.mkdir(path.dirname(formXmlPath), { recursive: true });
      await fs.promises.writeFile(formXmlPath, '<', 'utf8');
      const provider = new FormEditorProvider();
      const uri = vscode.Uri.file(formXmlPath);
      const document = await provider.openCustomDocument(uri);
      const key = uri.toString();
      const dirtyModel = makeModel('777');
      (provider as any).documentModel.set(key, dirtyModel);
      (provider as any).dirtyDocuments.add(key);
      const view = makePanel();
      await provider.resolveCustomEditor(document, view.panel);

      await assert.rejects(provider.revertCustomDocument(document, cancellation));
      assert.strictEqual((provider as any).documentModel.get(key), dirtyModel);
      assert.strictEqual(dirtyModel.childItemsRoot[0].properties.Width, '777');
      assert.strictEqual((provider as any).dirtyDocuments.has(key), true);

      document.dispose();
      provider.dispose();
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('all cancelled custom-document operations reject with CancellationError', async () => {
    const provider = new FormEditorProvider();
    const uri = vscode.Uri.file('C:/tmp/form-cancelled/Ext/Form.xml');
    const destination = vscode.Uri.file('C:/tmp/form-cancelled/Ext/Copy.xml');
    const document = await provider.openCustomDocument(uri);
    const cancelled = { isCancellationRequested: true } as vscode.CancellationToken;

    const isCancellation = (error: unknown) => error instanceof vscode.CancellationError;
    await assert.rejects(provider.saveCustomDocument(document, cancelled), isCancellation);
    await assert.rejects(provider.saveCustomDocumentAs(document, destination, cancelled), isCancellation);
    await assert.rejects(provider.revertCustomDocument(document, cancelled), isCancellation);
    await assert.rejects(
      provider.backupCustomDocument(document, { destination }, cancelled),
      isCancellation,
    );

    document.dispose();
    provider.dispose();
  });

  test('createEventHandler keeps module clean on disk and revert rejects malformed form XML', async () => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'form-editor-handler-revert-'));
    try {
      const formXmlPath = path.join(tempDir, 'Ext', 'Form.xml');
      const modulePath = path.join(tempDir, 'Ext', 'Form', 'Module.bsl');
      await fs.promises.mkdir(path.dirname(modulePath), { recursive: true });
      await fs.promises.writeFile(formXmlPath, '<', 'utf8');
      await fs.promises.writeFile(modulePath, '// original module\r\n', 'utf8');
      const provider = new FormEditorProvider();
      const uri = vscode.Uri.file(formXmlPath);
      const document = await provider.openCustomDocument(uri);
      const key = uri.toString();
      const model = makeModel();
      (provider as any).documentModel.set(key, model);
      const view = makePanel();
      await provider.resolveCustomEditor(document, view.panel);

      await view.receive({
        type: 'createEventHandler',
        elementId: 'field-1',
        elementName: 'Field1',
        tag: 'InputField',
        eventName: 'OnChange',
      });
      assert.strictEqual(await fs.promises.readFile(modulePath, 'utf8'), '// original module\r\n');
      assert.ok(model.childItemsRoot[0].events?.OnChange);

      await assert.rejects(provider.revertCustomDocument(document, cancellation));
      assert.strictEqual(await fs.promises.readFile(modulePath, 'utf8'), '// original module\r\n');
      assert.strictEqual((provider as any).dirtyDocuments.has(key), true);

      document.dispose();
      provider.dispose();
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('failed form save preserves clean disk state and keeps in-memory model dirty', async () => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'form-editor-handler-save-'));
    try {
      const formXmlPath = path.join(tempDir, 'Ext', 'Form.xml');
      const modulePath = path.join(tempDir, 'Ext', 'Form', 'Module.bsl');
      await fs.promises.mkdir(formXmlPath, { recursive: true });
      await fs.promises.mkdir(path.dirname(modulePath), { recursive: true });
      await fs.promises.writeFile(modulePath, '// original module\r\n', 'utf8');
      const provider = new FormEditorProvider();
      const uri = vscode.Uri.file(formXmlPath);
      const document = await provider.openCustomDocument(uri);
      const key = uri.toString();
      const model = makeModel();
      (provider as any).documentModel.set(key, model);
      const view = makePanel();
      await provider.resolveCustomEditor(document, view.panel);

      await view.receive({
        type: 'createEventHandler',
        elementId: 'field-1',
        elementName: 'Field1',
        tag: 'InputField',
        eventName: 'OnChange',
      });
      await assert.rejects(provider.saveCustomDocument(document, cancellation));

      assert.strictEqual(await fs.promises.readFile(modulePath, 'utf8'), '// original module\r\n');
      assert.strictEqual((provider as any).dirtyDocuments.has(key), true);

      document.dispose();
      provider.dispose();
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('Save As transfers a pending module transaction and clears dirty state', async () => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'form-editor-handler-save-as-'));
    try {
      const formXmlPath = path.join(tempDir, 'source', 'Ext', 'Form.xml');
      const modulePath = path.join(tempDir, 'source', 'Ext', 'Form', 'Module.bsl');
      const destinationPath = path.join(tempDir, 'copy', 'Ext', 'Form.xml');
      const destinationModulePath = path.join(tempDir, 'copy', 'Ext', 'Form', 'Module.bsl');
      await fs.promises.mkdir(path.dirname(modulePath), { recursive: true });
      await fs.promises.writeFile(modulePath, '// original module\r\n', 'utf8');
      const provider = new FormEditorProvider();
      const uri = vscode.Uri.file(formXmlPath);
      const document = await provider.openCustomDocument(uri);
      const key = uri.toString();
      const model = makeModel();
      (provider as any).documentModel.set(key, model);
      const view = makePanel();
      await provider.resolveCustomEditor(document, view.panel);

      await view.receive({
        type: 'createEventHandler',
        elementId: 'field-1',
        elementName: 'Field1',
        tag: 'InputField',
        eventName: 'OnChange',
      });
      await provider.saveCustomDocumentAs(
        document,
        vscode.Uri.file(destinationPath),
        cancellation,
      );

      assert.strictEqual(await fs.promises.readFile(modulePath, 'utf8'), '// original module\r\n');
      const handlerName = model.childItemsRoot[0].events?.OnChange;
      assert.ok(handlerName);
      assert.match(await fs.promises.readFile(destinationModulePath, 'utf8'), new RegExp(handlerName));
      assert.match(await fs.promises.readFile(destinationPath, 'utf8'), new RegExp(handlerName));
      assert.strictEqual((provider as any).pendingModuleTransactions.has(key), false);
      assert.strictEqual((provider as any).dirtyDocuments.has(key), false);

      document.dispose();
      provider.dispose();
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('unrelated module edits do not conflict with in-memory form edits and are preserved on disk', async () => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'form-editor-handler-conflict-'));
    try {
      const formXmlPath = path.join(tempDir, 'Ext', 'Form.xml');
      const modulePath = path.join(tempDir, 'Ext', 'Form', 'Module.bsl');
      await fs.promises.mkdir(path.dirname(modulePath), { recursive: true });
      await fs.promises.writeFile(formXmlPath, '<Form version="2.20"/>', 'utf8');
      await fs.promises.writeFile(modulePath, '// original module\r\n', 'utf8');
      const provider = new FormEditorProvider();
      const uri = vscode.Uri.file(formXmlPath);
      const document = await provider.openCustomDocument(uri);
      const key = uri.toString();
      const model = makeModel();
      (provider as any).documentModel.set(key, model);
      const view = makePanel();
      await provider.resolveCustomEditor(document, view.panel);

      await view.receive({
        type: 'createEventHandler',
        elementId: 'field-1',
        elementName: 'Field1',
        tag: 'InputField',
        eventName: 'OnChange',
      });
      await fs.promises.appendFile(modulePath, '// unrelated user edit\r\n', 'utf8');

      await provider.revertCustomDocument(document, cancellation);
      const preserved = await fs.promises.readFile(modulePath, 'utf8');
      assert.match(preserved, /unrelated user edit/);

      document.dispose();
      provider.dispose();
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  suite('active vs background custom editor panels (#330 review)', () => {
    test('does not overwrite activeDocumentUri when resolving a background custom editor panel', async () => {
      const provider = new FormEditorProvider();
      const uriA = vscode.Uri.file('C:/tmp/form-lifecycle/FormA/Ext/Form.xml');
      const uriB = vscode.Uri.file('C:/tmp/form-lifecycle/FormB/Ext/Form.xml');
      const docA = await provider.openCustomDocument(uriA);
      const docB = await provider.openCustomDocument(uriB);

      const panelA = makePanel(true);
      await provider.resolveCustomEditor(docA, panelA.panel);
      assert.strictEqual(provider.getActiveDocumentUri()?.toString(), uriA.toString());

      const panelB = makePanel(false);
      await provider.resolveCustomEditor(docB, panelB.panel);
      assert.strictEqual(
        provider.getActiveDocumentUri()?.toString(),
        uriA.toString(),
        'resolving background form B must not overwrite active form A'
      );

      panelB.setActive(true);
      assert.strictEqual(
        provider.getActiveDocumentUri()?.toString(),
        uriB.toString(),
        'activating panel B must update activeDocumentUri to B'
      );

      panelA.setActive(true);
      assert.strictEqual(
        provider.getActiveDocumentUri()?.toString(),
        uriA.toString(),
        'activating panel A must switch activeDocumentUri back to A'
      );

      docA.dispose();
      docB.dispose();
      provider.dispose();
    });

    test('supports initial focus race where panel.active is temporarily false but activeTab matches', async () => {
      const provider = new FormEditorProvider();
      const uriC = vscode.Uri.file('C:/tmp/form-lifecycle/FormC/Ext/Form.xml');
      const docC = await provider.openCustomDocument(uriC);

      const originalTabGroups = (vscode.window as any).tabGroups;
      try {
        (vscode.window as any).tabGroups = {
          activeTabGroup: {
            activeTab: {
              input: new (vscode as any).TabInputCustom(uriC, '1c-form-editor'),
              isActive: true,
            },
          },
        };

        const panelC = makePanel(false);
        await provider.resolveCustomEditor(docC, panelC.panel);
        assert.strictEqual(
          provider.getActiveDocumentUri()?.toString(),
          uriC.toString(),
          'initial focus race: active tab in activeTabGroup is recognized even when panel.active is false'
        );
      } finally {
        (vscode.window as any).tabGroups = originalTabGroups;
        docC.dispose();
        provider.dispose();
      }
    });

    test('two tab groups: background resolve in second tab group preserves active form of first tab group', async () => {
      const provider = new FormEditorProvider();
      const uriA = vscode.Uri.file('C:/tmp/form-lifecycle/Group1/Ext/Form.xml');
      const uriB = vscode.Uri.file('C:/tmp/form-lifecycle/Group2/Ext/Form.xml');
      const docA = await provider.openCustomDocument(uriA);
      const docB = await provider.openCustomDocument(uriB);

      const originalTabGroups = (vscode.window as any).tabGroups;
      try {
        (vscode.window as any).tabGroups = {
          activeTabGroup: {
            activeTab: {
              input: new (vscode as any).TabInputCustom(uriA, '1c-form-editor'),
              isActive: true,
            },
          },
          all: [
            { activeTab: { input: new (vscode as any).TabInputCustom(uriA, '1c-form-editor') } },
            { activeTab: { input: new (vscode as any).TabInputCustom(uriB, '1c-form-editor') } },
          ],
        };

        const panelA = makePanel(true);
        await provider.resolveCustomEditor(docA, panelA.panel);
        assert.strictEqual(provider.getActiveDocumentUri()?.toString(), uriA.toString());

        const panelB = makePanel(false);
        await provider.resolveCustomEditor(docB, panelB.panel);
        assert.strictEqual(
          provider.getActiveDocumentUri()?.toString(),
          uriA.toString(),
          'multi-group: background panel in inactive tab group must not steal activeDocumentUri'
        );
      } finally {
        (vscode.window as any).tabGroups = originalTabGroups;
        docA.dispose();
        docB.dispose();
        provider.dispose();
      }
    });

    test('tab restoration: multiple background panels restored without stealing active document', async () => {
      const provider = new FormEditorProvider();
      const uriA = vscode.Uri.file('C:/tmp/form-lifecycle/RestoredA/Ext/Form.xml');
      const uriB = vscode.Uri.file('C:/tmp/form-lifecycle/RestoredB/Ext/Form.xml');
      const docA = await provider.openCustomDocument(uriA);
      const docB = await provider.openCustomDocument(uriB);

      const originalTabGroups = (vscode.window as any).tabGroups;
      try {
        (vscode.window as any).tabGroups = undefined;

        const panelA = makePanel(false);
        const panelB = makePanel(false);
        await provider.resolveCustomEditor(docA, panelA.panel);
        await provider.resolveCustomEditor(docB, panelB.panel);

        assert.strictEqual(
          provider.getActiveDocumentUri(),
          null,
          'restored background panels must not set activeDocumentUri when neither panel is active'
        );
      } finally {
        (vscode.window as any).tabGroups = originalTabGroups;
        docA.dispose();
        docB.dispose();
        provider.dispose();
      }
    });
  });
});
