import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import '../helpers/vscodeStubRegister';
import { resetVscodeTestState } from '../helpers/vscodeModuleStub';
import * as vscode from 'vscode';
import { FormEditorProvider } from '../../src/formEditor/formEditorProvider';


const cancellation = { isCancellationRequested: false } as vscode.CancellationToken;



function makePanel(active = true): {
  panel: vscode.WebviewPanel;
  receive(message: unknown): Promise<void>;
  dispose(): void;
} {
  let messageHandler: ((message: any) => Promise<void>) | undefined;
  let disposeHandler: (() => void) | undefined;
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

suite('FormEditor Coupled In-Memory Edit & Save Coordination (#353)', () => {
  let tempDir: string;
  let formXmlPath: string;
  let modulePath: string;

  const validFormXml = `<?xml version="1.0" encoding="UTF-8"?>
<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" xmlns:v8="http://v8.1c.ru/8.1/data/core" version="2.20">
  <ChildItems>
    <InputField name="Field1" id="field-1">
      <Properties>
        <Width>100</Width>
      </Properties>
      <Events/>
    </InputField>
  </ChildItems>
</Form>`;

  setup(async () => {
    resetVscodeTestState();
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'form-sync-test-'));
    formXmlPath = path.join(tempDir, 'Catalogs', 'Goods', 'Forms', 'ItemForm', 'Ext', 'Form.xml');
    modulePath = path.join(tempDir, 'Catalogs', 'Goods', 'Forms', 'ItemForm', 'Ext', 'Form', 'Module.bsl');
    await fs.promises.mkdir(path.dirname(formXmlPath), { recursive: true });
    await fs.promises.mkdir(path.dirname(modulePath), { recursive: true });
    await fs.promises.writeFile(path.join(tempDir, 'Configuration.xml'), '<Configuration/>', 'utf8');
    await fs.promises.writeFile(formXmlPath, Buffer.from('\uFEFF' + validFormXml, 'utf8'));
    await fs.promises.writeFile(modulePath, '// initial module\r\n', 'utf8');
  });

  teardown(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  test('createEventHandler does NOT modify Module.bsl on disk prematurely', async () => {
    const provider = new FormEditorProvider();
    const uri = vscode.Uri.file(formXmlPath);
    const document = await provider.openCustomDocument(uri);
    const key = uri.toString();
    const view = makePanel();
    await provider.resolveCustomEditor(document, view.panel);
    await view.receive({ type: 'load' });
    const model = (provider as any).documentModel.get(key);

    await view.receive({
      type: 'createEventHandler',
      elementId: 'field-1',
      elementName: 'Field1',
      tag: 'InputField',
      eventName: 'OnChange',
    });

    // 1. Module.bsl on disk MUST remain untouched before any save action
    const onDiskModule = await fs.promises.readFile(modulePath, 'utf8');
    assert.strictEqual(
      onDiskModule,
      '// initial module\r\n',
      'Module.bsl on disk must NOT be eagerly written before save'
    );

    // 2. In-memory model and Form.xml must be marked dirty
    assert.ok(model.childItemsRoot[0].events?.OnChange, 'Handler must be bound in model');
    assert.strictEqual((provider as any).dirtyDocuments.has(key), true, 'Form.xml must be dirty');

    // 3. Open text document buffer for Module.bsl must be dirty and contain the stub
    const moduleUri = vscode.Uri.file(modulePath);
    const openDoc = vscode.workspace.textDocuments.find(
      (d) => path.normalize(d.uri.fsPath) === path.normalize(moduleUri.fsPath)
    );
    assert.ok(openDoc, 'Module.bsl must be opened as a text document');
    assert.strictEqual(openDoc!.isDirty, true, 'Module.bsl document must be marked dirty in memory');
    assert.match(openDoc!.getText(), /Процедура\s+Field1ПриИзменении/i);

    document.dispose();
    provider.dispose();
  });

  test('saveCustomDocument auto-saves paired dirty Module.bsl', async () => {
    const provider = new FormEditorProvider();
    const uri = vscode.Uri.file(formXmlPath);
    const document = await provider.openCustomDocument(uri);
    const key = uri.toString();

    const view = makePanel();
    await provider.resolveCustomEditor(document, view.panel);
    await view.receive({ type: 'load' });

    await view.receive({
      type: 'createEventHandler',
      elementId: 'field-1',
      elementName: 'Field1',
      tag: 'InputField',
      eventName: 'OnChange',
    });

    // Save Form.xml
    await provider.saveCustomDocument(document, cancellation);

    // After saving Form.xml, Module.bsl on disk must now contain the procedure
    const onDiskModule = await fs.promises.readFile(modulePath, 'utf8');
    assert.match(
      onDiskModule,
      /Процедура\s+Field1ПриИзменении/i,
      'Saving Form.xml must auto-save paired dirty Module.bsl to disk'
    );

    // Module.bsl in memory must no longer be dirty
    const moduleUri = vscode.Uri.file(modulePath);
    const openDoc = vscode.workspace.textDocuments.find(
      (d) => path.normalize(d.uri.fsPath) === path.normalize(moduleUri.fsPath)
    );
    if (openDoc) {
      assert.strictEqual(openDoc.isDirty, false, 'Module.bsl document must no longer be dirty');
    }

    document.dispose();
    provider.dispose();
  });

  test('saving Module.bsl auto-saves paired dirty Form.xml', async () => {
    const provider = new FormEditorProvider();
    const uri = vscode.Uri.file(formXmlPath);
    const document = await provider.openCustomDocument(uri);
    const key = uri.toString();

    const view = makePanel();
    await provider.resolveCustomEditor(document, view.panel);
    await view.receive({ type: 'load' });

    await view.receive({
      type: 'createEventHandler',
      elementId: 'field-1',
      elementName: 'Field1',
      tag: 'InputField',
      eventName: 'OnChange',
    });

    assert.strictEqual((provider as any).dirtyDocuments.has(key), true);

    // Save Module.bsl TextDocument
    const moduleUri = vscode.Uri.file(modulePath);
    const openDoc = vscode.workspace.textDocuments.find(
      (d) => path.normalize(d.uri.fsPath) === path.normalize(moduleUri.fsPath)
    );
    assert.ok(openDoc, 'Module document must exist');
    await openDoc!.save();

    // After Module.bsl is saved, paired Form.xml should have auto-saved
    assert.strictEqual(
      (provider as any).dirtyDocuments.has(key),
      false,
      'Form.xml dirty state must be cleared after paired Module.bsl is saved'
    );
    const onDiskForm = await fs.promises.readFile(formXmlPath, 'utf8');
    assert.match(
      onDiskForm,
      /Field1ПриИзменении/i,
      'Form.xml on disk must contain the event handler binding after Module.bsl save'
    );

    document.dispose();
    provider.dispose();
  });

  test('saveCustomDocumentAs locks destination path and cleanly transfers module content', async () => {
    const provider = new FormEditorProvider();
    const uri = vscode.Uri.file(formXmlPath);
    const document = await provider.openCustomDocument(uri);
    const key = uri.toString();

    const view = makePanel();
    await provider.resolveCustomEditor(document, view.panel);
    await view.receive({ type: 'load' });

    await view.receive({
      type: 'createEventHandler',
      elementId: 'field-1',
      elementName: 'Field1',
      tag: 'InputField',
      eventName: 'OnChange',
    });

    const destFormPath = path.join(tempDir, 'Catalogs', 'Goods', 'Forms', 'CopyForm', 'Ext', 'Form.xml');
    const destModulePath = path.join(tempDir, 'Catalogs', 'Goods', 'Forms', 'CopyForm', 'Ext', 'Form', 'Module.bsl');
    const destUri = vscode.Uri.file(destFormPath);

    await provider.saveCustomDocumentAs(document, destUri, cancellation);

    assert.strictEqual(fs.existsSync(destFormPath), true, 'Destination Form.xml must exist');
    assert.strictEqual(fs.existsSync(destModulePath), true, 'Destination Module.bsl must exist');

    const destFormContent = await fs.promises.readFile(destFormPath, 'utf8');
    assert.match(destFormContent, /Field1ПриИзменении/i, 'Destination Form.xml must contain handler binding');

    const destModuleContent = await fs.promises.readFile(destModulePath, 'utf8');
    assert.match(destModuleContent, /Field1ПриИзменении/i, 'Destination Module.bsl must contain handler procedure');

    document.dispose();
    provider.dispose();
  });
});
