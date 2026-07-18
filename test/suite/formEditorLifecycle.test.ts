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

function makePanel(): {
  panel: vscode.WebviewPanel;
  receive(message: unknown): Promise<void>;
  dispose(): void;
} {
  let messageHandler: ((message: any) => Promise<void>) | undefined;
  let disposeHandler: (() => void) | undefined;
  const panel = {
    title: '',
    active: true,
    webview: {
      options: {},
      html: '',
      postMessage: async () => true,
      onDidReceiveMessage: (handler: (message: any) => Promise<void>) => {
        messageHandler = handler;
        return { dispose: () => undefined };
      },
    },
    onDidChangeViewState: () => ({ dispose: () => undefined }),
    onDidDispose: (handler: () => void) => {
      disposeHandler = handler;
      return { dispose: () => undefined };
    },
  } as unknown as vscode.WebviewPanel;
  return {
    panel,
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

  test('revert rolls back a generated BSL handler before reporting a form parse failure', async () => {
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
      assert.notStrictEqual(await fs.promises.readFile(modulePath, 'utf8'), '// original module\r\n');
      assert.ok(model.childItemsRoot[0].events?.OnChange);

      await assert.rejects(provider.revertCustomDocument(document, cancellation));
      assert.strictEqual(await fs.promises.readFile(modulePath, 'utf8'), '// original module\r\n');
      assert.strictEqual(model.childItemsRoot[0].events?.OnChange, undefined);
      assert.strictEqual((provider as any).dirtyDocuments.has(key), true);

      document.dispose();
      provider.dispose();
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('failed form save rolls back the generated BSL handler and event binding', async () => {
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
      assert.strictEqual(model.childItemsRoot[0].events?.OnChange, undefined);
      assert.strictEqual((provider as any).pendingModuleTransactions.has(key), false);
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

  test('rollback preserves unrelated module edits and reports a conflict', async () => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'form-editor-handler-conflict-'));
    try {
      const formXmlPath = path.join(tempDir, 'Ext', 'Form.xml');
      const modulePath = path.join(tempDir, 'Ext', 'Form', 'Module.bsl');
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
      await fs.promises.appendFile(modulePath, '// unrelated user edit\r\n', 'utf8');

      await assert.rejects(
        provider.revertCustomDocument(document, cancellation),
        /changed after event-handler generation/,
      );
      const preserved = await fs.promises.readFile(modulePath, 'utf8');
      assert.match(preserved, /Field1ПриИзменении/);
      assert.match(preserved, /unrelated user edit/);
      assert.ok(model.childItemsRoot[0].events?.OnChange);
      assert.strictEqual((provider as any).pendingModuleTransactions.has(key), true);
      assert.strictEqual((provider as any).dirtyDocuments.has(key), true);

      document.dispose();
      provider.dispose();
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });
});
