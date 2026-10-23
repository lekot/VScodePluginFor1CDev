import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import '../helpers/vscodeStubRegister';
import { resetVscodeTestState } from '../helpers/vscodeModuleStub';
import * as vscode from 'vscode';
import { FormEditorDocument, FormEditorProvider } from '../../src/formEditor/formEditorProvider';
import { loadFormModel } from '../../src/formEditor/formFileIo';
import type { FormModel } from '../../src/formEditor/formModel';
import { ConfigurationSession } from '../../src/services/configurationSession/ConfigurationSession';
import { ConfigFormat } from '../../src/parsers/formatDetector';
import type { MutationPlan } from '../../src/services/configurationSession/mutationPlan';
import { configureConfigurationMutationGateway } from '../../src/services/configurationSession/configurationMutationGateway';

const cancellation = { isCancellationRequested: false } as vscode.CancellationToken;
const validFormXml = `<?xml version="1.0" encoding="UTF-8"?>
<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" xmlns:v8="http://v8.1c.ru/8.1/data/core" version="2.20">
  <ChildItems>
    <InputField name="Field1" id="field-1"><Properties><Width>100</Width></Properties><Events/></InputField>
    <InputField name="Field2" id="field-2"><Properties><Width>200</Width></Properties><Events/></InputField>
  </ChildItems>
</Form>`;

interface FormFixture {
  rootPath: string;
  formPath: string;
  modulePath: string;
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

interface ReadonlyTextBuffer {
  document: vscode.TextDocument;
  get saveCalls(): number;
  getText(): string;
  setText(value: string): void;
  markDirty(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function createFixture(moduleContent?: string): Promise<FormFixture> {
  const rootPath = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'form-issue363-')));
  const formPath = path.join(rootPath, 'Catalogs', 'Goods', 'Forms', 'ItemForm', 'Ext', 'Form.xml');
  const modulePath = path.join(path.dirname(formPath), 'Form', 'Module.bsl');
  await fs.promises.mkdir(path.dirname(formPath), { recursive: true });
  await fs.promises.writeFile(
    path.join(rootPath, 'Configuration.xml'),
    '<MetaDataObject version="2.20"><Configuration/></MetaDataObject>',
    'utf8',
  );
  await fs.promises.writeFile(formPath, validFormXml, 'utf8');
  if (moduleContent !== undefined) {
    await fs.promises.mkdir(path.dirname(modulePath), { recursive: true });
    await fs.promises.writeFile(modulePath, moduleContent, 'utf8');
  }
  return { rootPath, formPath, modulePath };
}

async function openForm(fixture: FormFixture): Promise<{
  provider: FormEditorProvider;
  document: Awaited<ReturnType<FormEditorProvider['openCustomDocument']>>;
  key: string;
}> {
  const provider = new FormEditorProvider();
  const uri = vscode.Uri.file(fixture.formPath);
  const document = await provider.openCustomDocument(uri);
  const loaded = await loadFormModel(fixture.formPath);
  if ('error' in loaded) {
    throw new Error(loaded.error);
  }
  const key = uri.toString();
  (provider as any).documentModel.set(key, loaded.model);
  if (loaded.sourceSnapshot) {
    (provider as any).sourceSnapshots.set(key, loaded.sourceSnapshot);
  }
  return { provider, document, key };
}

function makePanel(): {
  panel: vscode.WebviewPanel;
  messages: unknown[];
  receive(message: unknown): Promise<void>;
  dispose(): void;
} {
  let messageHandler: ((message: any) => Promise<void>) | undefined;
  let disposeHandler: (() => void) | undefined;
  const messages: unknown[] = [];
  const panel = {
    title: '',
    active: true,
    webview: {
      options: {},
      html: '',
      postMessage: async (message: unknown) => { messages.push(message); return true; },
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
    messages,
    receive: async (message) => {
      assert.ok(messageHandler, 'custom editor message handler must be registered');
      await messageHandler!(message);
    },
    dispose: () => disposeHandler?.(),
  };
}

function makeReadonlyTextBuffer(
  uri: vscode.Uri,
  initialText: string,
  saveText: (text: string) => Promise<void>,
): ReadonlyTextBuffer {
  let text = initialText;
  let dirty = true;
  let saveCalls = 0;
  const document = {} as vscode.TextDocument;
  Object.defineProperties(document, {
    uri: { value: uri, enumerable: true },
    isDirty: { get: () => dirty, enumerable: true },
    getText: { value: () => text },
    save: {
      value: async () => {
        saveCalls++;
        await saveText(text);
        dirty = false;
        return true;
      },
    },
  });
  return {
    document,
    get saveCalls() { return saveCalls; },
    getText: () => text,
    setText: (value) => { text = value; dirty = true; },
    markDirty: () => { dirty = true; },
  };
}

function createSession(rootPath: string, id: string): ConfigurationSession {
  return new ConfigurationSession({
    configurationId: id as any,
    rootPath,
    rootUri: vscode.Uri.file(rootPath).toString(),
    descriptorUri: vscode.Uri.file(path.join(rootPath, 'Configuration.xml')).toString(),
    workspaceFolderUris: [vscode.Uri.file(rootPath).toString()],
    format: ConfigFormat.Designer,
    capabilities: { read: true, write: true, process: true },
  });
}

function installSessionGateway(
  session: ConfigurationSession,
  onQueued?: (kind: string) => void,
): { dispose(): void } {
  return configureConfigurationMutationGateway(
    async (_resourcePath, kind, operation) => {
      const queued = session.runMutationValue({ kind, execute: operation });
      onQueued?.(kind);
      return queued;
    },
    (_resourcePath, plan) => session.runPlanValue(plan),
  );
}

async function blockSessionWriter(session: ConfigurationSession): Promise<{
  started: Promise<void>;
  release(): void;
  outcome: ReturnType<ConfigurationSession['runExclusive']>;
}> {
  const started = deferred();
  const gate = deferred();
  const outcome = session.runExclusive({
    kind: 'test.form.lifecycle.blocker',
    execute: async () => {
      started.resolve();
      await gate.promise;
      return undefined;
    },
  });
  return { started: started.promise, release: () => gate.resolve(), outcome };
}

function isCancellationError(error: unknown): boolean {
  return error instanceof (vscode as any).CancellationError
    || (error instanceof Error && (error.name === 'CancellationError' || error.message === 'Canceled'));
}

async function waitFor<T>(promise: Promise<T>, label: string, timeoutMs = 5000): Promise<T> {
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
}

async function createPendingHandlerBackup(fixture: FormFixture): Promise<{
  backupId: string;
  moduleDocument: vscode.TextDocument;
}> {
  const { provider, document } = await openForm(fixture);
  const view = makePanel();
  const backupPath = path.join(fixture.rootPath, 'storage', 'form-backup.json');
  try {
    await provider.resolveCustomEditor(document, view.panel);
    await view.receive({
      type: 'createEventHandler',
      elementId: 'field-1',
      elementName: 'Field1',
      tag: 'InputField',
      eventName: 'OnChange',
    });
    const moduleDocument = vscode.workspace.textDocuments.find(
      (candidate) => candidate.uri.scheme === 'untitled' && path.normalize(candidate.uri.fsPath) === path.normalize(fixture.modulePath),
    );
    assert.ok(moduleDocument, 'new handler uses an associated untitled Module.bsl buffer');
    const manualText = moduleDocument!.getText().replace('TODO: обработчик события', 'manual user implementation');
    (moduleDocument as any).setText(manualText);
    (moduleDocument as any).isDirty = true;
    const aliasPath = `${path.dirname(fixture.modulePath)}${path.sep}alias${path.sep}..${path.sep}Module.bsl`;
    (moduleDocument as any).uri = vscode.Uri.file(aliasPath).with({ scheme: 'untitled' });
    const backup = await provider.backupCustomDocument(
      document,
      { destination: vscode.Uri.file(backupPath) },
      cancellation,
    );
    return { backupId: backup.id, moduleDocument: moduleDocument! };
  } finally {
    view.dispose();
    document.dispose();
    provider.dispose();
  }
}

suite('Form editor lifecycle regressions for issue #363', () => {
  setup(() => resetVscodeTestState());

  test('preserves a later foreign Module.bsl commit when Form CAS fails', async () => {
    const fixture = await createFixture('ORIGINAL');
    const { provider, document, key } = await openForm(fixture);
    const buffer = makeReadonlyTextBuffer(vscode.Uri.file(fixture.modulePath), 'USER SAVED CONTENT', async (text) => {
      await fs.promises.writeFile(fixture.modulePath, text, 'utf8');
    });
    (vscode.workspace as any).textDocuments = [buffer.document];
    (provider as any).dirtyDocuments.add(key);
    const adapter = configureConfigurationMutationGateway(async () => {
      await fs.promises.writeFile(fixture.modulePath, 'FOREIGN COMMITTED CONTENT', 'utf8');
      throw new Error('Form CAS conflict');
    });
    try {
      await assert.rejects(provider.saveCustomDocument(document, cancellation), /Form CAS conflict/);
      assert.strictEqual(buffer.saveCalls, 1, 'the module TextDocument save is attempted once');
      assert.strictEqual(await fs.promises.readFile(fixture.modulePath, 'utf8'), 'FOREIGN COMMITTED CONTENT');
      assert.strictEqual(buffer.getText(), 'USER SAVED CONTENT');
      assert.strictEqual(buffer.document.isDirty, false);
      assert.strictEqual((provider as any).dirtyDocuments.has(key), true, 'Form.xml remains dirty after its paired module commit');
    } finally {
      adapter.dispose();
      document.dispose();
      provider.dispose();
      await fs.promises.rm(fixture.rootPath, { recursive: true, force: true });
    }
  });

  test('keeps a newly created Module.bsl after its paired save and Form CAS failure', async () => {
    const fixture = await createFixture();
    const { provider, document } = await openForm(fixture);
    const buffer = makeReadonlyTextBuffer(vscode.Uri.file(fixture.modulePath), 'NEW USER MODULE', async (text) => {
      await fs.promises.mkdir(path.dirname(fixture.modulePath), { recursive: true });
      await fs.promises.writeFile(fixture.modulePath, text, 'utf8');
    });
    (vscode.workspace as any).textDocuments = [buffer.document];
    (provider as any).dirtyDocuments.add(document.uri.toString());
    const adapter = configureConfigurationMutationGateway(async () => {
      throw new Error('Form CAS conflict');
    });
    try {
      await assert.rejects(provider.saveCustomDocument(document, cancellation), /Form CAS conflict/);
      assert.strictEqual(buffer.saveCalls, 1);
      assert.strictEqual(fs.existsSync(fixture.modulePath), true, 'a successful paired module save remains after Form CAS failure');
      assert.strictEqual(await fs.promises.readFile(fixture.modulePath, 'utf8'), 'NEW USER MODULE');
    } finally {
      adapter.dispose();
      document.dispose();
      provider.dispose();
      await fs.promises.rm(fixture.rootPath, { recursive: true, force: true });
    }
  });

  test('does not recreate a Module.bsl deleted after its successful paired save', async () => {
    const fixture = await createFixture('ORIGINAL');
    const { provider, document } = await openForm(fixture);
    const buffer = makeReadonlyTextBuffer(vscode.Uri.file(fixture.modulePath), 'USER SAVED CONTENT', async (text) => {
      await fs.promises.writeFile(fixture.modulePath, text, 'utf8');
    });
    (vscode.workspace as any).textDocuments = [buffer.document];
    (provider as any).dirtyDocuments.add(document.uri.toString());
    const adapter = configureConfigurationMutationGateway(async () => {
      await fs.promises.rm(fixture.modulePath);
      throw new Error('Form CAS conflict');
    });
    try {
      await assert.rejects(provider.saveCustomDocument(document, cancellation), /Form CAS conflict/);
      assert.strictEqual(buffer.saveCalls, 1);
      assert.strictEqual(fs.existsSync(fixture.modulePath), false, 'a later deletion remains authoritative');
    } finally {
      adapter.dispose();
      document.dispose();
      provider.dispose();
      await fs.promises.rm(fixture.rootPath, { recursive: true, force: true });
    }
  });

  test('uses the readonly TextDocument contract without leaving its buffer clean and disk divergent', async () => {
    const fixture = await createFixture('ORIGINAL');
    const { provider, document } = await openForm(fixture);
    const buffer = makeReadonlyTextBuffer(vscode.Uri.file(fixture.modulePath), 'USER SAVED CONTENT', async (text) => {
      await fs.promises.writeFile(fixture.modulePath, text, 'utf8');
    });
    const descriptor = Object.getOwnPropertyDescriptor(buffer.document, 'isDirty');
    assert.strictEqual(descriptor?.set, undefined, 'isDirty has no setter as in the VS Code API');
    (vscode.workspace as any).textDocuments = [buffer.document];
    (provider as any).dirtyDocuments.add(document.uri.toString());
    const adapter = configureConfigurationMutationGateway(async () => {
      throw new Error('Form CAS conflict');
    });
    try {
      await assert.rejects(provider.saveCustomDocument(document, cancellation), /Form CAS conflict/);
      assert.strictEqual(buffer.document.isDirty, false, 'TextDocument.save completed successfully');
      assert.strictEqual(buffer.getText(), 'USER SAVED CONTENT');
      assert.strictEqual(await fs.promises.readFile(fixture.modulePath, 'utf8'), buffer.getText());
      assert.strictEqual(buffer.saveCalls, 1);
      assert.strictEqual((provider as any).dirtyDocuments.has(document.uri.toString()), true);
    } finally {
      adapter.dispose();
      document.dispose();
      provider.dispose();
      await fs.promises.rm(fixture.rootPath, { recursive: true, force: true });
    }
  });

  test('serializes Save, queued Save, and Revert and cancels saves admitted before Revert', async function (this: Mocha.Context) {
    this.timeout(7000);
    const fixture = await createFixture('ORIGINAL MODULE');
    const { provider, document, key } = await openForm(fixture);
    const view = makePanel();
    await provider.resolveCustomEditor(document, view.panel);
    await view.receive({ type: 'propertyChange', elementId: 'field-1', key: 'Width', value: '777' });
    const moduleSaveStarted = deferred();
    const moduleSaveGate = deferred();
    const buffer = makeReadonlyTextBuffer(vscode.Uri.file(fixture.modulePath), 'MODULE BUFFER', async (text) => {
      moduleSaveStarted.resolve();
      await moduleSaveGate.promise;
      await fs.promises.writeFile(fixture.modulePath, text, 'utf8');
    });
    (vscode.workspace as any).textDocuments = [buffer.document];
    const session = createSession(fixture.rootPath, 'issue363-save-revert');
    const adapter = installSessionGateway(session);
    const firstSave = provider.saveCustomDocument(document, cancellation);
    void firstSave.catch(() => undefined);
    await moduleSaveStarted.promise;
    const queuedSave = provider.saveCustomDocument(document, cancellation);
    void queuedSave.catch(() => undefined);
    const revert = provider.revertCustomDocument(document, cancellation);
    let revertSettled = false;
    void revert.then(() => { revertSettled = true; }, () => { revertSettled = true; });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.strictEqual(revertSettled, false, 'Revert shares the document queue behind the in-flight module save');
      moduleSaveGate.resolve();
      const [firstOutcome, queuedOutcome, revertOutcome] = await Promise.allSettled([firstSave, queuedSave, revert]);
      assert.deepStrictEqual(
        [firstOutcome.status, queuedOutcome.status, revertOutcome.status],
        ['rejected', 'rejected', 'fulfilled'],
        'both saves admitted before Revert are cancelled while Revert completes',
      );
      assert.ok(isCancellationError((firstOutcome as PromiseRejectedResult).reason), 'the in-flight save is cancelled by Revert');
      assert.ok(isCancellationError((queuedOutcome as PromiseRejectedResult).reason), 'a queued pre-Revert save is also cancelled');
      assert.match(await fs.promises.readFile(fixture.formPath, 'utf8'), /<Width>100<\/Width>/);
      assert.strictEqual(JSON.stringify((provider as any).documentModel.get(key)).includes('100'), true);
      assert.strictEqual((provider as any).dirtyDocuments.has(key), false);
      assert.deepStrictEqual(view.messages.filter((message: any) => message?.type === 'error'), []);
    } finally {
      moduleSaveGate.resolve();
      adapter.dispose();
      await session.dispose();
      view.dispose();
      document.dispose();
      provider.dispose();
      await fs.promises.rm(fixture.rootPath, { recursive: true, force: true });
    }
  });

  test('runs a Save requested after Revert against the reloaded form state', async function (this: Mocha.Context) {
    this.timeout(7000);
    const fixture = await createFixture();
    const { provider, document, key } = await openForm(fixture);
    const view = makePanel();
    await provider.resolveCustomEditor(document, view.panel);
    await view.receive({ type: 'propertyChange', elementId: 'field-1', key: 'Width', value: '777' });
    const session = createSession(fixture.rootPath, 'issue363-revert-save');
    const queuedKinds: string[] = [];
    const queuedSignal = deferred();
    const adapter = installSessionGateway(session, (kind) => {
      queuedKinds.push(kind);
      if (kind === 'ui.form.revert') {
        queuedSignal.resolve();
      }
    });
    const blocker = await blockSessionWriter(session);
    try {
      await blocker.started;
      const revert = provider.revertCustomDocument(document, cancellation);
      await queuedSignal.promise;
      const save = provider.saveCustomDocument(document, cancellation);
      blocker.release();
      await Promise.all([revert, save, blocker.outcome]);
      assert.ok(queuedKinds.indexOf('ui.form.revert') < queuedKinds.indexOf('ui.form.save'));
      assert.match(await fs.promises.readFile(fixture.formPath, 'utf8'), /<Width>100<\/Width>/);
      assert.strictEqual(JSON.stringify((provider as any).documentModel.get(key)).includes('100'), true);
    } finally {
      blocker.release();
      adapter.dispose();
      await session.dispose();
      view.dispose();
      document.dispose();
      provider.dispose();
      await fs.promises.rm(fixture.rootPath, { recursive: true, force: true });
    }
  });

  test('lets an admitted atomic Form commit finish before Revert reloads its result', async function (this: Mocha.Context) {
    this.timeout(7000);
    const fixture = await createFixture();
    const { provider, document, key } = await openForm(fixture);
    const view = makePanel();
    await provider.resolveCustomEditor(document, view.panel);
    await view.receive({ type: 'propertyChange', elementId: 'field-1', key: 'Width', value: '777' });
    const session = createSession(fixture.rootPath, 'issue363-admitted-commit-revert');
    const adapter = installSessionGateway(session);
    const commitStarted = deferred();
    const commitGate = deferred();
    const originalRename = fs.promises.rename;
    let held = false;
    (fs.promises as any).rename = async (sourcePath: fs.PathLike, targetPath: fs.PathLike) => {
      if (!held && path.normalize(String(targetPath)) === path.normalize(fixture.formPath)) {
        held = true;
        commitStarted.resolve();
        await commitGate.promise;
      }
      return originalRename.call(fs.promises, sourcePath, targetPath);
    };
    const save = provider.saveCustomDocument(document, cancellation);
    void save.catch(() => undefined);
    try {
      await commitStarted.promise;
      const revert = provider.revertCustomDocument(document, cancellation);
      let revertSettled = false;
      void revert.then(() => { revertSettled = true; }, () => { revertSettled = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.strictEqual(revertSettled, false, 'Revert waits while an admitted atomic replacement is in progress');
      commitGate.resolve();
      const [saveOutcome, revertOutcome] = await Promise.allSettled([save, revert]);
      assert.strictEqual(saveOutcome.status, 'fulfilled', 'admitted Form commit completes as one unit');
      assert.strictEqual(revertOutcome.status, 'fulfilled');
      assert.match(await fs.promises.readFile(fixture.formPath, 'utf8'), /<Width>777<\/Width>/);
      assert.strictEqual(JSON.stringify((provider as any).documentModel.get(key)).includes('777'), true);
      assert.strictEqual((provider as any).dirtyDocuments.has(key), false, 'Revert reflects the committed disk state');
    } finally {
      commitGate.resolve();
      (fs.promises as any).rename = originalRename;
      adapter.dispose();
      await session.dispose();
      view.dispose();
      document.dispose();
      provider.dispose();
      await fs.promises.rm(fixture.rootPath, { recursive: true, force: true });
    }
  });

  test('cancels a queued Save As when Revert is requested before its plan commits', async function (this: Mocha.Context) {
    this.timeout(7000);
    const fixture = await createFixture('SOURCE MODULE');
    const { provider, document } = await openForm(fixture);
    const view = makePanel();
    await provider.resolveCustomEditor(document, view.panel);
    await view.receive({ type: 'propertyChange', elementId: 'field-1', key: 'Width', value: '777' });
    const destinationPath = path.join(fixture.rootPath, 'Catalogs', 'Goods', 'Forms', 'Copy', 'Ext', 'Form.xml');
    const session = createSession(fixture.rootPath, 'issue363-saveas-revert');
    const saveAsQueued = deferred();
    const adapter = installSessionGateway(session, (kind) => {
      if (kind === 'ui.form.saveAs') {
        saveAsQueued.resolve();
      }
    });
    const blocker = await blockSessionWriter(session);
    const saveAs = provider.saveCustomDocumentAs(document, vscode.Uri.file(destinationPath), cancellation);
    void saveAs.catch(() => undefined);
    try {
      await blocker.started;
      await saveAsQueued.promise;
      const revert = provider.revertCustomDocument(document, cancellation);
      blocker.release();
      const [saveAsOutcome, revertOutcome] = await Promise.allSettled([saveAs, revert]);
      await blocker.outcome;
      assert.deepStrictEqual([saveAsOutcome.status, revertOutcome.status], ['rejected', 'fulfilled']);
      assert.ok(isCancellationError((saveAsOutcome as PromiseRejectedResult).reason), 'pre-Revert Save As reports cancellation');
      assert.strictEqual(fs.existsSync(destinationPath), false, 'the cancelled Save As plan never commits');
      assert.deepStrictEqual(view.messages.filter((message: any) => message?.type === 'error'), []);
    } finally {
      blocker.release();
      adapter.dispose();
      await session.dispose();
      view.dispose();
      document.dispose();
      provider.dispose();
      await fs.promises.rm(fixture.rootPath, { recursive: true, force: true });
    }
  });

  test('runs Save As requested after Revert with the reloaded form state', async function (this: Mocha.Context) {
    this.timeout(7000);
    const fixture = await createFixture('SOURCE MODULE');
    const { provider, document } = await openForm(fixture);
    const view = makePanel();
    await provider.resolveCustomEditor(document, view.panel);
    await view.receive({ type: 'propertyChange', elementId: 'field-1', key: 'Width', value: '777' });
    const destinationPath = path.join(fixture.rootPath, 'Catalogs', 'Goods', 'Forms', 'CopyAfterRevert', 'Ext', 'Form.xml');
    const session = createSession(fixture.rootPath, 'issue363-revert-saveas');
    const revertQueued = deferred();
    const adapter = installSessionGateway(session, (kind) => {
      if (kind === 'ui.form.revert') {
        revertQueued.resolve();
      }
    });
    const blocker = await blockSessionWriter(session);
    try {
      await blocker.started;
      const revert = provider.revertCustomDocument(document, cancellation);
      await revertQueued.promise;
      const saveAs = provider.saveCustomDocumentAs(document, vscode.Uri.file(destinationPath), cancellation);
      blocker.release();
      await Promise.all([revert, saveAs, blocker.outcome]);
      assert.match(await fs.promises.readFile(destinationPath, 'utf8'), /<Width>100<\/Width>/);
      assert.doesNotMatch(await fs.promises.readFile(destinationPath, 'utf8'), /<Width>777<\/Width>/);
    } finally {
      blocker.release();
      adapter.dispose();
      await session.dispose();
      view.dispose();
      document.dispose();
      provider.dispose();
      await fs.promises.rm(fixture.rootPath, { recursive: true, force: true });
    }
  });

  test('keeps a single later edit dirty when an older Form snapshot commits with the command engine disabled', async function (this: Mocha.Context) {
    this.timeout(7000);
    const fixture = await createFixture();
    const { provider, document, key } = await openForm(fixture);
    const view = makePanel();
    const previousEngineFlag = process.env.FORM_COMMAND_ENGINE_ENABLED;
    let session: ConfigurationSession | undefined;
    let adapter: { dispose(): void } | undefined;
    let blocker: Awaited<ReturnType<typeof blockSessionWriter>> | undefined;
    let subscription: vscode.Disposable | undefined;
    let documentChanges = 0;
    let changesAfterInitialEdit = 0;
    let changesAfterLaterEdit = 0;
    try {
      delete process.env.FORM_COMMAND_ENGINE_ENABLED;
      await provider.resolveCustomEditor(document, view.panel);
      subscription = provider.onDidChangeCustomDocument(() => { documentChanges += 1; });
      await view.receive({ type: 'propertyChange', elementId: 'field-1', key: 'Width', value: '777' });
      changesAfterInitialEdit = documentChanges;

      session = createSession(fixture.rootPath, 'issue363-single-edit-during-save');
      const saveQueued = deferred();
      adapter = installSessionGateway(session, (kind) => {
        if (kind === 'ui.form.save') {
          saveQueued.resolve();
        }
      });
      blocker = await blockSessionWriter(session);
      await blocker.started;

      const save = provider.saveCustomDocument(document, cancellation);
      await saveQueued.promise;
      await view.receive({ type: 'propertyChange', elementId: 'field-1', key: 'Width', value: '888' });
      changesAfterLaterEdit = documentChanges;
      blocker.release();
      await Promise.all([save, blocker.outcome]);

      assert.match(await fs.promises.readFile(fixture.formPath, 'utf8'), /<Width>777<\/Width>/);
      const providerInternals = provider as unknown as {
        documentModel: Map<string, FormModel>;
        dirtyDocuments: Set<string>;
      };
      const latest = providerInternals.documentModel.get(key);
      assert.ok(latest);
      assert.strictEqual(latest.childItemsRoot[0].properties?.Width, '888');
      assert.strictEqual(providerInternals.dirtyDocuments.has(key), true, 'the later single edit remains dirty');
      assert.strictEqual(changesAfterInitialEdit, 1, 'the initial single edit publishes one document generation');
      assert.strictEqual(changesAfterLaterEdit, 2, 'the later single edit advances the document generation once');
    } finally {
      blocker?.release();
      adapter?.dispose();
      if (session) {
        await session.dispose();
      }
      subscription?.dispose();
      view.dispose();
      document.dispose();
      provider.dispose();
      await fs.promises.rm(fixture.rootPath, { recursive: true, force: true });
      if (previousEngineFlag === undefined) {
        delete process.env.FORM_COMMAND_ENGINE_ENABLED;
      } else {
        process.env.FORM_COMMAND_ENGINE_ENABLED = previousEngineFlag;
      }
    }
  });

  test('keeps a later multi-select edit dirty when an older Form snapshot commits', async function (this: Mocha.Context) {
    this.timeout(7000);
    const fixture = await createFixture();
    const { provider, document, key } = await openForm(fixture);
    const view = makePanel();
    const previousEngineFlag = process.env.FORM_COMMAND_ENGINE_ENABLED;
    let session: ConfigurationSession | undefined;
    let adapter: { dispose(): void } | undefined;
    let blocker: Awaited<ReturnType<typeof blockSessionWriter>> | undefined;
    let subscription: vscode.Disposable | undefined;
    let documentChanges = 0;
    let changesAfterInitialBatch = 0;
    let changesAfterLaterBatch = 0;
    try {
      process.env.FORM_COMMAND_ENGINE_ENABLED = 'true';
      await provider.resolveCustomEditor(document, view.panel);
      subscription = provider.onDidChangeCustomDocument(() => { documentChanges += 1; });
      session = createSession(fixture.rootPath, 'issue363-edit-during-save');
      const saveQueued = deferred();
      adapter = installSessionGateway(session, (kind) => {
        if (kind === 'ui.form.save') {
          saveQueued.resolve();
        }
      });
      blocker = await blockSessionWriter(session);
      await blocker.started;

      await view.receive({
        type: 'propertyChange',
        elementIds: ['field-1', 'field-2'],
        key: 'Width',
        value: '777',
      });
      changesAfterInitialBatch = documentChanges;
      const save = provider.saveCustomDocument(document, cancellation);
      await saveQueued.promise;
      await view.receive({
        type: 'propertyChange',
        elementIds: ['field-1', 'field-2'],
        key: 'Width',
        value: '888',
      });
      changesAfterLaterBatch = documentChanges;
      blocker.release();
      await Promise.all([save, blocker.outcome]);
      const savedXml = await fs.promises.readFile(fixture.formPath, 'utf8');
      assert.strictEqual((savedXml.match(/<Width>777<\/Width>/g) ?? []).length, 2);
      const providerInternals = provider as unknown as {
        documentModel: Map<string, FormModel>;
        dirtyDocuments: Set<string>;
      };
      const latest = providerInternals.documentModel.get(key);
      assert.ok(latest);
      assert.deepStrictEqual(latest.childItemsRoot.map((item) => String(item.properties?.Width)), ['888', '888']);
      assert.strictEqual(providerInternals.dirtyDocuments.has(key), true, 'the later edit remains dirty');
      assert.strictEqual(changesAfterInitialBatch, 1, 'the initial multi-select edit publishes once');
      assert.strictEqual(changesAfterLaterBatch, 2, 'the later multi-select edit increments the document generation once');
    } finally {
      blocker?.release();
      adapter?.dispose();
      if (session) {
        await session.dispose();
      }
      subscription?.dispose();
      view.dispose();
      document.dispose();
      provider.dispose();
      await fs.promises.rm(fixture.rootPath, { recursive: true, force: true });
      if (previousEngineFlag === undefined) {
        delete process.env.FORM_COMMAND_ENGINE_ENABLED;
      } else {
        process.env.FORM_COMMAND_ENGINE_ENABLED = previousEngineFlag;
      }
    }
  });

  test('restores an aliased untitled Module.bsl with manual edits and reuses it for new handlers and Save', async () => {
    const fixture = await createFixture();
    const { backupId, moduleDocument } = await createPendingHandlerBackup(fixture);
    const view = makePanel();
    const originalOpenTextDocument = vscode.workspace.openTextDocument;
    let restoredProvider: FormEditorProvider | undefined;
    let restoredDocument: FormEditorDocument | undefined;
    let adapter: { dispose(): void } | undefined;
    (vscode.workspace as any).openTextDocument = async (uri: vscode.Uri) => {
      if (path.normalize(uri.fsPath) === path.normalize(fixture.modulePath)) {
        throw new Error('restored Module.bsl buffer should be reused');
      }
      return originalOpenTextDocument(uri);
    };
    try {
      restoredProvider = new FormEditorProvider();
      restoredDocument = await restoredProvider.openCustomDocument(
        vscode.Uri.file(fixture.formPath),
        { backupId, untitledDocumentData: undefined },
      );
      await restoredProvider.resolveCustomEditor(restoredDocument, view.panel);
      await view.receive({
        type: 'createEventHandler',
        elementId: 'field-2',
        elementName: 'Field2',
        tag: 'InputField',
        eventName: 'OnChange',
      });
      adapter = configureConfigurationMutationGateway(async (_resourcePath, _kind, operation) => operation());
      await restoredProvider.saveCustomDocument(restoredDocument, cancellation);
      const moduleContent = await fs.promises.readFile(fixture.modulePath, 'utf8');
      assert.match(moduleContent, /manual user implementation/i, 'manual buffer edits survive restore and save');
      assert.match(moduleContent, /Field1ПриИзменении/i, 'the backed-up binding has a procedure');
      assert.match(moduleContent, /Field2ПриИзменении/i, 'new handler creation reuses the restored buffer');
      assert.strictEqual((moduleDocument as any).isDirty, false);
    } finally {
      adapter?.dispose();
      restoredDocument?.dispose();
      restoredProvider?.dispose();
      (vscode.workspace as any).openTextDocument = originalOpenTextDocument;
      view.dispose();
      await fs.promises.rm(fixture.rootPath, { recursive: true, force: true });
    }
  });

  test('ignores a stale private-map buffer that is no longer a live workspace document', async () => {
    const fixture = await createFixture();
    const { backupId } = await createPendingHandlerBackup(fixture);
    await fs.promises.mkdir(path.dirname(fixture.modulePath), { recursive: true });
    const provider = new FormEditorProvider();
    const document = await provider.openCustomDocument(vscode.Uri.file(fixture.formPath), {
      backupId,
      untitledDocumentData: undefined,
    });
    const stale = makeReadonlyTextBuffer(vscode.Uri.file(fixture.modulePath), 'Процедура Field1ПриИзменении()\nКонецПроцедуры', async (text) => {
      await fs.promises.writeFile(fixture.modulePath, text, 'utf8');
    });
    (provider as any).moduleDocumentsByPath.set(path.normalize(fixture.modulePath), stale.document);
    (vscode.workspace as any).textDocuments = [];
    const adapter = configureConfigurationMutationGateway(async (_resourcePath, _kind, operation) => operation());
    try {
      await assert.rejects(provider.saveCustomDocument(document, cancellation));
      assert.strictEqual(stale.saveCalls, 0, 'closed buffers from the old private map are ignored');
      assert.strictEqual(fs.existsSync(fixture.modulePath), false);
    } finally {
      adapter.dispose();
      document.dispose();
      provider.dispose();
      await fs.promises.rm(fixture.rootPath, { recursive: true, force: true });
    }
  });

  test('ignores a closed Module.bsl buffer even if it remains in the live-document snapshot', async () => {
    const fixture = await createFixture('ORIGINAL MODULE');
    const { provider, document } = await openForm(fixture);
    const closed = makeReadonlyTextBuffer(vscode.Uri.file(fixture.modulePath), 'CLOSED BUFFER', async (text) => {
      await fs.promises.writeFile(fixture.modulePath, text, 'utf8');
    });
    Object.defineProperty(closed.document, 'isClosed', { value: true });
    (vscode.workspace as any).textDocuments = [closed.document];
    (provider as any).moduleDocumentsByPath.set(path.normalize(fixture.modulePath), closed.document);
    const adapter = configureConfigurationMutationGateway(async (_resourcePath, _kind, operation) => operation());
    try {
      await provider.saveCustomDocument(document, cancellation);
      assert.strictEqual(closed.saveCalls, 0, 'closed buffers are ignored even when stale state still references them');
      assert.strictEqual(await fs.promises.readFile(fixture.modulePath, 'utf8'), 'ORIGINAL MODULE');
    } finally {
      adapter.dispose();
      document.dispose();
      provider.dispose();
      await fs.promises.rm(fixture.rootPath, { recursive: true, force: true });
    }
  });

  test('fails closed when live file and untitled buffers conflict for one intended module path', async () => {
    const fixture = await createFixture();
    const { backupId } = await createPendingHandlerBackup(fixture);
    await fs.promises.mkdir(path.dirname(fixture.modulePath), { recursive: true });
    const procedure = 'Процедура Field1ПриИзменении()\nКонецПроцедуры';
    const fileBuffer = makeReadonlyTextBuffer(vscode.Uri.file(fixture.modulePath), `${procedure}\n// file buffer`, async (text) => {
      await fs.promises.writeFile(fixture.modulePath, text, 'utf8');
    });
    const aliasPath = `${path.dirname(fixture.modulePath)}${path.sep}alias${path.sep}..${path.sep}Module.bsl`;
    const untitledBuffer = makeReadonlyTextBuffer(
      vscode.Uri.file(aliasPath).with({ scheme: 'untitled' }),
      `${procedure}\n// untitled buffer`,
      async (text) => { await fs.promises.writeFile(fixture.modulePath, text, 'utf8'); },
    );
    (vscode.workspace as any).textDocuments = [fileBuffer.document, untitledBuffer.document];
    const provider = new FormEditorProvider();
    const document = await provider.openCustomDocument(vscode.Uri.file(fixture.formPath), {
      backupId,
      untitledDocumentData: undefined,
    });
    const adapter = configureConfigurationMutationGateway(async (_resourcePath, _kind, operation) => operation());
    try {
      await assert.rejects(provider.saveCustomDocument(document, cancellation), /конфликт|несколько|неоднознач/i);
      assert.strictEqual(fileBuffer.saveCalls + untitledBuffer.saveCalls, 0, 'the provider does not select a live buffer arbitrarily');
      assert.strictEqual(fs.existsSync(fixture.modulePath), false);
    } finally {
      adapter.dispose();
      document.dispose();
      provider.dispose();
      await fs.promises.rm(fixture.rootPath, { recursive: true, force: true });
    }
  });
});
