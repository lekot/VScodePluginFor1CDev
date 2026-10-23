import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import '../helpers/vscodeStubRegister';
import { resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';
import * as vscode from 'vscode';
import { FormEditorProvider } from '../../src/formEditor/formEditorProvider';
import { ConfigurationSession } from '../../src/services/configurationSession/ConfigurationSession';
import { ConfigFormat } from '../../src/parsers/formatDetector';
import type { MutationPlan } from '../../src/services/configurationSession/mutationPlan';
import {
  canonicalMutationTestPath,
  installMutationPlanTempOpenFailure,
  installMutationPlanPublicationInterception,
} from '../helpers/mutationPlanPublicationInterception';


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
    tempDir = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'form-sync-test-')));
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

  test('saveCustomDocument rejects a cancelled paired Module.bsl save before persisting its binding', async () => {
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

    const moduleDoc = vscode.workspace.textDocuments.find(
      (d) => path.normalize(d.uri.fsPath) === path.normalize(modulePath)
    )!;
    moduleDoc.save = async () => false;

    await assert.rejects(provider.saveCustomDocument(document, cancellation));

    assert.strictEqual((provider as any).dirtyDocuments.has(key), true, 'form remains dirty after module save is cancelled');
    assert.doesNotMatch(await fs.promises.readFile(formXmlPath, 'utf8'), /Field1ПриИзменении/i, 'form binding is not persisted');
    assert.doesNotMatch(await fs.promises.readFile(modulePath, 'utf8'), /Field1ПриИзменении/i, 'module remains unchanged on disk');

    document.dispose();
    provider.dispose();
  });

  test('rejected paired Module.bsl save aborts Form persistence and retains dirty state', async () => {
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
    const moduleDoc = vscode.workspace.textDocuments.find(
      (candidate) => path.normalize(candidate.uri.fsPath) === path.normalize(modulePath)
    )!;
    moduleDoc.save = async () => { throw new Error('injected Module.bsl save failure'); };

    await assert.rejects(provider.saveCustomDocument(document, cancellation), /injected Module\.bsl save failure/);
    assert.strictEqual((provider as any).dirtyDocuments.has(key), true, 'Form remains dirty after rejected module save');
    assert.doesNotMatch(await fs.promises.readFile(formXmlPath, 'utf8'), /Field1ПриИзменении/i, 'Form binding is not persisted');

    view.dispose();
    document.dispose();
    provider.dispose();
  });

  test('missing Module.bsl stays in an associated untitled buffer until save', async () => {
    await fs.promises.rm(modulePath, { force: true });
    const provider = new FormEditorProvider();
    const uri = vscode.Uri.file(formXmlPath);
    const document = await provider.openCustomDocument(uri);
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

    const moduleDoc = vscode.workspace.textDocuments.find(
      (candidate) => path.normalize(candidate.uri.fsPath) === path.normalize(modulePath)
    )!;
    assert.ok(moduleDoc, 'the missing module has an open editor buffer');
    assert.strictEqual(moduleDoc.uri.scheme, 'untitled', 'the unsaved module is not presented as a file-backed document');
    assert.strictEqual(moduleDoc.isUntitled, true, 'VS Code recognizes the buffer as untitled');
    assert.strictEqual(path.normalize(moduleDoc.fileName), path.normalize(modulePath), 'the untitled buffer is associated with the intended Module.bsl path');
    assert.strictEqual(fs.existsSync(modulePath), false, 'handler creation does not create Module.bsl on disk');
    assert.match(moduleDoc.getText(), /Процедура\s+Field1ПриИзменении/i);

    await provider.saveCustomDocument(document, cancellation);

    assert.strictEqual(moduleDoc.uri.scheme, 'file', 'saving the associated untitled buffer binds it to the file URI');
    assert.strictEqual(moduleDoc.isDirty, false);
    assert.match(await fs.promises.readFile(modulePath, 'utf8'), /Процедура\s+Field1ПриИзменении/i);
    assert.match(await fs.promises.readFile(formXmlPath, 'utf8'), /Field1ПриИзменении/i);

    view.dispose();
    document.dispose();
    provider.dispose();
  });

  test('Module save does not persist a binding when its handler was removed from the buffer', async () => {
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

    const moduleDoc = vscode.workspace.textDocuments.find(
      (candidate) => path.normalize(candidate.uri.fsPath) === path.normalize(modulePath)
    )!;
    (moduleDoc as any).setText('// handler removed by the user\r\n');
    (moduleDoc as any).isDirty = true;
    await moduleDoc.save();

    assert.strictEqual((provider as any).dirtyDocuments.has(key), true, 'Form remains dirty because the linked procedure is missing');
    assert.doesNotMatch(await fs.promises.readFile(formXmlPath, 'utf8'), /Field1ПриИзменении/i, 'Form binding is not persisted');
    assert.doesNotMatch(await fs.promises.readFile(modulePath, 'utf8'), /Field1ПриИзменении/i, 'removed handler stays removed');

    view.dispose();
    document.dispose();
    provider.dispose();
  });

  test('failed WorkspaceEdit does not bind an unapplied handler', async () => {
    const provider = new FormEditorProvider();
    const uri = vscode.Uri.file(formXmlPath);
    const document = await provider.openCustomDocument(uri);
    const key = uri.toString();
    const view = makePanel();
    await provider.resolveCustomEditor(document, view.panel);
    await view.receive({ type: 'load' });
    vscodeTestState.applyEditImpl = async () => false;
    try {
      await view.receive({
        type: 'createEventHandler',
        elementId: 'field-1',
        elementName: 'Field1',
        tag: 'InputField',
        eventName: 'OnChange',
      });

      const model = (provider as any).documentModel.get(key);
      assert.strictEqual(model.childItemsRoot[0].events?.OnChange, undefined, 'event link remains absent');
      assert.strictEqual((provider as any).pendingModuleTransactions.has(key), false, 'there is no pending transaction for an edit that was rejected');
      assert.strictEqual((provider as any).dirtyDocuments.has(key), false, 'form stays clean');
      assert.strictEqual((await fs.promises.readFile(modulePath, 'utf8')), '// initial module\r\n', 'module bytes stay unchanged');
    } finally {
      vscodeTestState.applyEditImpl = undefined;
      view.dispose();
      document.dispose();
      provider.dispose();
    }
  });

  test('cancelled dirty paired module save aborts Form save even without a pending binding', async () => {
    const provider = new FormEditorProvider();
    const uri = vscode.Uri.file(formXmlPath);
    const document = await provider.openCustomDocument(uri);
    const view = makePanel();
    await provider.resolveCustomEditor(document, view.panel);
    await view.receive({ type: 'load' });
    await view.receive({ type: 'propertyChange', elementId: 'field-1', key: 'Width', value: '222' });

    const moduleDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(modulePath));
    (moduleDoc as any).setText('// unsaved manual change\r\n');
    (moduleDoc as any).isDirty = true;
    moduleDoc.save = async () => false;
    let formWriteCount = 0;
    const formIo = await import('../../src/formEditor/formFileIo');
    const originalSave = formIo.saveFormModel;
    (formIo as any).saveFormModel = async (...args: any[]) => {
      formWriteCount++;
      return (originalSave as any)(...args);
    };
    try {
      await assert.rejects(provider.saveCustomDocument(document, cancellation));
      assert.strictEqual(formWriteCount, 0, 'Form.xml is not written after paired module save is canceled');
      assert.strictEqual((provider as any).dirtyDocuments.has(uri.toString()), true, 'the edited Form stays dirty');
      assert.doesNotMatch(await fs.promises.readFile(formXmlPath, 'utf8'), /<Width>222<\/Width>/);
    } finally {
      (formIo as any).saveFormModel = originalSave;
      view.dispose();
      document.dispose();
      provider.dispose();
    }
  });

  test('concurrent save waits for the edited generation and persists it', async () => {
    const provider = new FormEditorProvider();
    const uri = vscode.Uri.file(formXmlPath);
    const document = await provider.openCustomDocument(uri);
    const view = makePanel();
    await provider.resolveCustomEditor(document, view.panel);
    await view.receive({ type: 'load' });

    const formIo = await import('../../src/formEditor/formFileIo');
    const originalSave = formIo.saveFormModel;
    let releaseFirstSave!: () => void;
    let firstWriteFinished!: () => void;
    const firstSaveGate = new Promise<void>((resolve) => { releaseFirstSave = resolve; });
    const firstWrite = new Promise<void>((resolve) => { firstWriteFinished = resolve; });
    (formIo as any).saveFormModel = async (...args: any[]) => {
      const result = await (originalSave as any)(...args);
      firstWriteFinished();
      await firstSaveGate;
      return result;
    };

    const firstSave = provider.saveCustomDocument(document, cancellation);
    let secondSaveSettled = false;
    let secondSaveFailure: unknown;
    let secondSave!: Promise<void>;
    try {
      await firstWrite;
      await view.receive({ type: 'propertyChange', elementId: 'field-1', key: 'Width', value: '777' });
      secondSave = provider.saveCustomDocument(document, cancellation).then(
        () => { secondSaveSettled = true; },
        (error) => { secondSaveSettled = true; secondSaveFailure = error; },
      );
      await Promise.resolve();
      assert.strictEqual(secondSaveSettled, false, 'second save waits for its generation instead of reporting early success');
    } finally {
      releaseFirstSave();
    }

    try {
      await firstSave;
      if (secondSave) {
        await secondSave;
      }
      if (secondSaveFailure) {
        throw secondSaveFailure;
      }
      assert.match(await fs.promises.readFile(formXmlPath, 'utf8'), /<Width>777<\/Width>/, 'latest edited model is written');
      assert.strictEqual((provider as any).dirtyDocuments.has(uri.toString()), false, 'saved latest generation is clean');
    } finally {
      (formIo as any).saveFormModel = originalSave;
      document.dispose();
      provider.dispose();
    }
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
    assert.strictEqual(await fs.promises.readFile(modulePath, 'utf8'), '// initial module\r\n', 'Save As does not alter the source module on disk');
    const sourceModuleDoc = vscode.workspace.textDocuments.find(
      (candidate) => path.normalize(candidate.uri.fsPath) === path.normalize(modulePath)
    );
    assert.strictEqual(sourceModuleDoc?.isDirty, true, 'Save As leaves the source module buffer dirty');

    document.dispose();
    provider.dispose();
  });

  test('save As rollback preserves a destination commit made before its mutation lock', async () => {
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

    const destFormPath = path.join(tempDir, 'Catalogs', 'Goods', 'Forms', 'ConcurrentCopy', 'Ext', 'Form.xml');
    const destModulePath = path.join(tempDir, 'Catalogs', 'Goods', 'Forms', 'ConcurrentCopy', 'Ext', 'Form', 'Module.bsl');
    const previousCommit = '\uFEFF' + validFormXml.replace('<Width>100</Width>', '<Width>456</Width>');
    const gateway = await import('../../src/services/configurationSession/configurationMutationGateway');
    const tempOpenFailure = installMutationPlanTempOpenFailure(
      await canonicalMutationTestPath(destModulePath),
      'injected destination Module.bsl temp open failure',
    );
    const publication = installMutationPlanPublicationInterception([{
      targetPath: await canonicalMutationTestPath(destFormPath),
      operation: 'rename',
      after: async () => tempOpenFailure.arm(),
    }]);
    const adapter = gateway.configureConfigurationMutationGateway(async (_path, _kind, operation) => {
      await fs.promises.mkdir(path.dirname(destFormPath), { recursive: true });
      await fs.promises.writeFile(destFormPath, previousCommit, 'utf8');
      return operation();
    });
    try {
      await assert.rejects(provider.saveCustomDocumentAs(document, vscode.Uri.file(destFormPath), cancellation));
      assert.strictEqual(tempOpenFailure.triggered, true, 'the Module.bsl temp-open failure must be injected');
      assert.strictEqual(await fs.promises.readFile(destFormPath, 'utf8'), previousCommit, 'rollback restores the state observed after acquiring the mutation lock');
      assert.strictEqual(fs.existsSync(destModulePath), false, 'failed multi-file Save As does not leave a partial module');
      assert.strictEqual((provider as any).dirtyDocuments.has(key), true, 'source remains dirty after failed Save As');
      assert.strictEqual(await fs.promises.readFile(formXmlPath, 'utf8'), Buffer.concat([Buffer.from('\uFEFF'), Buffer.from(validFormXml)]).toString('utf8'), 'Save As never changes the source form');
      assert.strictEqual(await fs.promises.readFile(modulePath, 'utf8'), '// initial module\r\n', 'Save As never changes the source module');
    } finally {
      publication.restore();
      tempOpenFailure.restore();
      adapter.dispose();
      view.dispose();
      document.dispose();
      provider.dispose();
    }
  });

  test('save As rollback preserves a queued destination writer commit under the session FIFO', async function (this: Mocha.Context) {
    this.timeout(7000);
    const provider = new FormEditorProvider();
    const uri = vscode.Uri.file(formXmlPath);
    const document = await provider.openCustomDocument(uri);
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

    const destFormPath = path.join(tempDir, 'Catalogs', 'Goods', 'Forms', 'QueuedCopy', 'Ext', 'Form.xml');
    const destModulePath = path.join(tempDir, 'Catalogs', 'Goods', 'Forms', 'QueuedCopy', 'Ext', 'Form', 'Module.bsl');
    const previousCommit = '\uFEFF' + validFormXml.replace('<Width>100</Width>', '<Width>456</Width>');
    const gateway = await import('../../src/services/configurationSession/configurationMutationGateway');
    const session = new ConfigurationSession({
      configurationId: 'form-sync-queued-save-as' as any,
      rootPath: tempDir,
      rootUri: vscode.Uri.file(tempDir).toString(),
      descriptorUri: vscode.Uri.file(path.join(tempDir, 'Configuration.xml')).toString(),
      workspaceFolderUris: [vscode.Uri.file(tempDir).toString()],
      format: ConfigFormat.Designer,
      capabilities: { read: true, write: true, process: true },
    });
    const tempOpenFailure = installMutationPlanTempOpenFailure(
      await canonicalMutationTestPath(destModulePath),
      'injected destination Module.bsl temp open failure',
    );
    const publication = installMutationPlanPublicationInterception([{
      targetPath: await canonicalMutationTestPath(destFormPath),
      operation: 'rename',
      after: async () => tempOpenFailure.arm(),
    }]);

    let releaseDestinationWriter!: () => void;
    let markDestinationWriterStarted!: () => void;
    let markSaveAsQueued!: () => void;
    const destinationWriterGate = new Promise<void>((resolve) => { releaseDestinationWriter = resolve; });
    const destinationWriterStarted = new Promise<void>((resolve) => { markDestinationWriterStarted = resolve; });
    const saveAsQueued = new Promise<void>((resolve) => { markSaveAsQueued = resolve; });
    let writerOutcomePromise: Promise<any> | undefined;
    let saveAsPromise: Promise<void> | undefined;
    const adapter = gateway.configureConfigurationMutationGateway(
      async (_resourcePath, kind, operation) => {
        const queued = session.runMutationValue({ kind, execute: operation });
        if (kind === 'ui.form.saveAs') {
          markSaveAsQueued();
        }
        return queued;
      },
      (_resourcePath, plan) => session.runPlanValue(plan),
    );

    const waitFor = async <T>(promise: Promise<T>, label: string, timeoutMs = 5000): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<T>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
          }),
        ]);
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    };

    try {
      writerOutcomePromise = session.enqueue({
        kind: 'test.concurrent-destination-writer',
        execute: async () => {
          markDestinationWriterStarted();
          await destinationWriterGate;
          const plan: MutationPlan<void> = {
            kind: 'test.concurrent-destination-writer',
            steps: [
              { type: 'ensureDirectory', targetPath: path.dirname(destFormPath) },
              {
                type: 'writeFile',
                targetPath: destFormPath,
                content: previousCommit,
                encoding: 'utf8',
                expected: { state: 'missing' },
              },
            ],
            result: undefined,
          };
          return session.mutations.execute(plan);
        },
      });
      await waitFor(destinationWriterStarted, 'destination writer start');

      saveAsPromise = provider.saveCustomDocumentAs(document, vscode.Uri.file(destFormPath), cancellation);
      void saveAsPromise.catch(() => undefined);
      await waitFor(saveAsQueued, 'Save As enqueue');
      releaseDestinationWriter();

      const writerOutcome = await waitFor(writerOutcomePromise, 'destination writer completion');
      assert.strictEqual(writerOutcome.status, 'committed', 'the destination writer commits before Save As owns the FIFO');
      await assert.rejects(
        waitFor(saveAsPromise, 'Save As completion'),
        /Mutation was rolled back: injected destination Module\.bsl temp open failure/,
      );
      assert.strictEqual(tempOpenFailure.triggered, true, 'the Module.bsl temp-open failure must be injected');
      assert.strictEqual(await fs.promises.readFile(destFormPath, 'utf8'), previousCommit, 'rollback preserves the earlier queued writer commit');
      assert.strictEqual(fs.existsSync(destModulePath), false, 'failed Save As does not leave a partial module');
    } finally {
      releaseDestinationWriter();
      adapter.dispose();
      let teardownTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        session.dispose(),
        new Promise<void>((resolve) => { teardownTimer = setTimeout(resolve, 250); }),
      ]);
      if (teardownTimer) {
        clearTimeout(teardownTimer);
      }
      publication.restore();
      tempOpenFailure.restore();
      view.dispose();
      document.dispose();
      provider.dispose();
    }
  });

  test('save As fails closed when the destination Form.xml has a dirty text buffer', async () => {
    const provider = new FormEditorProvider();
    const uri = vscode.Uri.file(formXmlPath);
    const document = await provider.openCustomDocument(uri);
    const view = makePanel();
    await provider.resolveCustomEditor(document, view.panel);
    await view.receive({ type: 'load' });
    const destFormPath = path.join(tempDir, 'Catalogs', 'Goods', 'Forms', 'DirtyCopy', 'Ext', 'Form.xml');
    await fs.promises.mkdir(path.dirname(destFormPath), { recursive: true });
    await fs.promises.writeFile(destFormPath, 'destination disk content', 'utf8');
    const destinationDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(destFormPath));
    (destinationDoc as any).setText('unsaved destination buffer');
    (destinationDoc as any).isDirty = true;
    const gateway = await import('../../src/services/configurationSession/configurationMutationGateway');
    const adapter = gateway.configureConfigurationMutationGateway(async (_path, _kind, operation) => operation());
    try {
      await assert.rejects(provider.saveCustomDocumentAs(document, vscode.Uri.file(destFormPath), cancellation), /несохранёнными изменениями/i);
      assert.strictEqual(await fs.promises.readFile(destFormPath, 'utf8'), 'destination disk content', 'dirty target bytes remain unchanged');
      assert.strictEqual(destinationDoc.isDirty, true, 'destination buffer remains dirty');
    } finally {
      adapter.dispose();
      view.dispose();
      document.dispose();
      provider.dispose();
    }
  });

  test('save As fails closed when the destination Module.bsl has a dirty text buffer', async () => {
    const provider = new FormEditorProvider();
    const uri = vscode.Uri.file(formXmlPath);
    const document = await provider.openCustomDocument(uri);
    const view = makePanel();
    await provider.resolveCustomEditor(document, view.panel);
    await view.receive({ type: 'load' });
    const destFormPath = path.join(tempDir, 'Catalogs', 'Goods', 'Forms', 'DirtyModuleCopy', 'Ext', 'Form.xml');
    const destModulePath = path.join(tempDir, 'Catalogs', 'Goods', 'Forms', 'DirtyModuleCopy', 'Ext', 'Form', 'Module.bsl');
    await fs.promises.mkdir(path.dirname(destModulePath), { recursive: true });
    await fs.promises.writeFile(destModulePath, 'destination module disk content', 'utf8');
    const destinationDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(destModulePath));
    (destinationDoc as any).setText('unsaved destination module buffer');
    (destinationDoc as any).isDirty = true;
    const gateway = await import('../../src/services/configurationSession/configurationMutationGateway');
    const adapter = gateway.configureConfigurationMutationGateway(async (_path, _kind, operation) => operation());
    try {
      await assert.rejects(provider.saveCustomDocumentAs(document, vscode.Uri.file(destFormPath), cancellation), /Module\.bsl открыт с несохранёнными изменениями/i);
      assert.strictEqual(fs.existsSync(destFormPath), false, 'destination Form.xml is not partially written');
      assert.strictEqual(await fs.promises.readFile(destModulePath, 'utf8'), 'destination module disk content', 'dirty destination Module.bsl bytes remain unchanged');
      assert.strictEqual(destinationDoc.isDirty, true, 'destination module buffer remains dirty');
    } finally {
      adapter.dispose();
      view.dispose();
      document.dispose();
      provider.dispose();
    }
  });

  test('save As rejects a canonical destination that aliases its source', async () => {
    const provider = new FormEditorProvider();
    const uri = vscode.Uri.file(formXmlPath);
    const document = await provider.openCustomDocument(uri);
    const view = makePanel();
    await provider.resolveCustomEditor(document, view.panel);
    await view.receive({ type: 'load' });
    const gateway = await import('../../src/services/configurationSession/configurationMutationGateway');
    const adapter = gateway.configureConfigurationMutationGateway(async (_path, _kind, operation) => operation());
    const original = await fs.promises.readFile(formXmlPath);
    try {
      await assert.rejects(provider.saveCustomDocumentAs(document, uri, cancellation), /Источник и назначение Save As совпадают/);
      assert.deepStrictEqual(await fs.promises.readFile(formXmlPath), original, 'the source Form.xml remains unchanged');
    } finally {
      adapter.dispose();
      view.dispose();
      document.dispose();
      provider.dispose();
    }
  });

  test('save As rejects a source Module.bsl changed while waiting for the destination lock', async () => {
    const provider = new FormEditorProvider();
    const uri = vscode.Uri.file(formXmlPath);
    const document = await provider.openCustomDocument(uri);
    const view = makePanel();
    await provider.resolveCustomEditor(document, view.panel);
    await view.receive({ type: 'load' });
    const destFormPath = path.join(tempDir, 'Catalogs', 'Goods', 'Forms', 'SourceChangedCopy', 'Ext', 'Form.xml');
    const concurrentSource = '// source writer committed while Save As waited\r\n';
    const gateway = await import('../../src/services/configurationSession/configurationMutationGateway');
    const adapter = gateway.configureConfigurationMutationGateway(async (_path, _kind, operation) => {
      await fs.promises.writeFile(modulePath, concurrentSource, 'utf8');
      return operation();
    });
    try {
      await assert.rejects(provider.saveCustomDocumentAs(document, vscode.Uri.file(destFormPath), cancellation), /Исходный Module\.bsl изменился/);
      assert.strictEqual(fs.existsSync(destFormPath), false, 'destination remains untouched when the source snapshot is stale');
      assert.strictEqual(await fs.promises.readFile(modulePath, 'utf8'), concurrentSource, 'Save As does not roll back the source writer');
    } finally {
      adapter.dispose();
      view.dispose();
      document.dispose();
      provider.dispose();
    }
  });

  test('save As CAS preserves a concurrent destination writer', async () => {
    const provider = new FormEditorProvider();
    const uri = vscode.Uri.file(formXmlPath);
    const document = await provider.openCustomDocument(uri);
    const view = makePanel();
    await provider.resolveCustomEditor(document, view.panel);
    await view.receive({ type: 'load' });
    const destFormPath = path.join(tempDir, 'Catalogs', 'Goods', 'Forms', 'CasCopy', 'Ext', 'Form.xml');
    const concurrentCommit = 'COMMITTED AFTER SAVE AS EXPECTATION CAPTURE';
    const planModule = await import('../../src/services/configurationSession/mutationPlan');
    const gateway = await import('../../src/services/configurationSession/configurationMutationGateway');
    const originalExecute = planModule.MutationPlanExecutor.prototype.execute;
    (planModule.MutationPlanExecutor.prototype as any).execute = async function (plan: any, ...args: any[]) {
      await fs.promises.mkdir(path.dirname(destFormPath), { recursive: true });
      await fs.promises.writeFile(destFormPath, concurrentCommit, 'utf8');
      return (originalExecute as any).call(this, plan, ...args);
    };
    const adapter = gateway.configureConfigurationMutationGateway(async (_path, _kind, operation) => operation());
    try {
      await assert.rejects(provider.saveCustomDocumentAs(document, vscode.Uri.file(destFormPath), cancellation));
      assert.strictEqual(await fs.promises.readFile(destFormPath, 'utf8'), concurrentCommit, 'CAS conflict does not overwrite a newer destination commit');
    } finally {
      (planModule.MutationPlanExecutor.prototype as any).execute = originalExecute;
      adapter.dispose();
      view.dispose();
      document.dispose();
      provider.dispose();
    }
  });

  test('concurrent edit and save during paired module save waits for the edited generation and persists it', async () => {
    const provider = new FormEditorProvider();
    const uri = vscode.Uri.file(formXmlPath);
    const document = await provider.openCustomDocument(uri);
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

    const moduleDoc = vscode.workspace.textDocuments.find(
      (candidate) => path.normalize(candidate.uri.fsPath) === path.normalize(modulePath)
    )!;
    const originalSave = moduleDoc.save;
    let releaseModuleSave!: () => void;
    let moduleSaveStarted!: () => void;
    const moduleSaveGate = new Promise<void>((resolve) => { releaseModuleSave = resolve; });
    const moduleSaveTriggered = new Promise<void>((resolve) => { moduleSaveStarted = resolve; });

    let saveCalls = 0;
    moduleDoc.save = async function (this: any) {
      saveCalls++;
      if (saveCalls === 1) {
        moduleSaveStarted();
        await moduleSaveGate;
      }
      return originalSave.call(this);
    };

    const firstSave = provider.saveCustomDocument(document, cancellation);
    let secondSaveSettled = false;
    let secondSaveFailure: unknown;
    let secondSave!: Promise<void>;
    try {
      await moduleSaveTriggered;
      await view.receive({ type: 'propertyChange', elementId: 'field-1', key: 'Width', value: '888' });
      secondSave = provider.saveCustomDocument(document, cancellation).then(
        () => { secondSaveSettled = true; },
        (error) => { secondSaveSettled = true; secondSaveFailure = error; },
      );
      await Promise.resolve();
      assert.strictEqual(secondSaveSettled, false, 'second save waits in queue instead of reporting early completion');
    } finally {
      releaseModuleSave();
    }

    try {
      await firstSave;
      if (secondSave) {
        await secondSave;
      }
      if (secondSaveFailure) {
        throw secondSaveFailure;
      }
      assert.match(await fs.promises.readFile(formXmlPath, 'utf8'), /<Width>888<\/Width>/, 'latest generation with new property is persisted');
      assert.strictEqual((provider as any).dirtyDocuments.has(uri.toString()), false, 'form is clean after second save completes');
    } finally {
      moduleDoc.save = originalSave;
      view.dispose();
      document.dispose();
      provider.dispose();
    }
  });

  test('saveCustomDocumentAs overwrites an existing destination cleanly with CAS expectations', async () => {
    const provider = new FormEditorProvider();
    const uri = vscode.Uri.file(formXmlPath);
    const document = await provider.openCustomDocument(uri);
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

    const destFormPath = path.join(tempDir, 'Catalogs', 'Goods', 'Forms', 'ExistingCopy', 'Ext', 'Form.xml');
    const destModulePath = path.join(tempDir, 'Catalogs', 'Goods', 'Forms', 'ExistingCopy', 'Ext', 'Form', 'Module.bsl');
    await fs.promises.mkdir(path.dirname(destFormPath), { recursive: true });
    await fs.promises.mkdir(path.dirname(destModulePath), { recursive: true });
    await fs.promises.writeFile(destFormPath, '<Form version="2.20"><OldForm/></Form>', 'utf8');
    await fs.promises.writeFile(destModulePath, '// old module\r\n', 'utf8');

    const destUri = vscode.Uri.file(destFormPath);
    await provider.saveCustomDocumentAs(document, destUri, cancellation);

    const destFormContent = await fs.promises.readFile(destFormPath, 'utf8');
    assert.match(destFormContent, /Field1ПриИзменении/i, 'Existing destination Form.xml was overwritten with new model');
    assert.doesNotMatch(destFormContent, /<OldForm\/>/, 'Old form content was replaced');

    const destModuleContent = await fs.promises.readFile(destModulePath, 'utf8');
    assert.match(destModuleContent, /Field1ПриИзменении/i, 'Existing destination Module.bsl was overwritten with new module content');

    view.dispose();
    document.dispose();
    provider.dispose();
  });
});
