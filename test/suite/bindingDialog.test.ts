import '../helpers/vscodeStubRegister';
import * as assert from 'assert';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { tmpdir } from 'os';
import type { Memento, SecretStorage } from 'vscode';
import * as vscode from 'vscode';
import {
  BindingDialogPanel,
  getBindingDialogHtml,
  registerBindingDialogCommands,
  runOpenBindingDialog,
} from '../../src/bindings/bindingDialog';
import { BindingManager } from '../../src/bindings/bindingManager';
import { INFOBASE_STORAGE_MAX_ENTRIES } from '../../src/infobases/constants';
import { InfobaseStorageService } from '../../src/infobases/infobaseStorageService';
import type { InfobaseEntry } from '../../src/infobases/models/infobaseEntry';
import { ExtensionState } from '../../src/state/extensionState';
import { createFakeExtensionContext } from '../helpers/rightsEditorTestHarness';
import { resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';

const mockWebview = { cspSource: 'vscode-webview-test-csp' } as vscode.Webview;

/** UUID без записи в каталоге — для строки «(нет в каталоге)» в HTML. */
const IB_ORPHAN = '10000000-0000-4000-8000-00000000ab00';

/** Минимальная реализация для `BindingManager` (как в bindingManager.test). */
function createMemoryFs(): vscode.FileSystem {
  const map = new Map<string, Uint8Array>();
  return {
    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
      const v = map.get(uri.fsPath);
      if (!v) {
        throw vscode.FileSystemError.FileNotFound(uri);
      }
      return v;
    },
    async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
      map.set(uri.fsPath, Buffer.from(content));
    },
    async createDirectory(): Promise<void> {
      /* no-op */
    },
  } as unknown as vscode.FileSystem;
}

class MapMemento implements Memento {
  private readonly map = new Map<string, unknown>();

  keys(): readonly string[] {
    return [...this.map.keys()];
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    if (this.map.has(key)) {
      return this.map.get(key) as T;
    }
    return defaultValue as T;
  }

  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) {
      this.map.delete(key);
    } else {
      this.map.set(key, value);
    }
    return Promise.resolve();
  }
}

class MapSecretStorage implements SecretStorage {
  private readonly values = new Map<string, string>();

  get onDidChange(): import('vscode').Event<{ key: string }> {
    return () => ({ dispose: () => undefined });
  }

  get(key: string): Thenable<string | undefined> {
    return Promise.resolve(this.values.get(key));
  }

  store(key: string, value: string): Thenable<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Thenable<void> {
    this.values.delete(key);
    return Promise.resolve();
  }

  keys(): Thenable<string[]> {
    return Promise.resolve([...this.values.keys()]);
  }
}

type FakePanel = {
  title: string;
  reveal: () => void;
  dispose: () => void;
  onDidDispose: (
    listener: () => void,
    _thisArgs?: unknown,
    disposables?: vscode.Disposable[],
  ) => vscode.Disposable;
  webview: {
    cspSource: string;
    html: string;
    postMessage: (msg: unknown) => Thenable<boolean>;
    onDidReceiveMessage: (
      cb: (msg: unknown) => void | Thenable<void>,
      _thisArgs?: unknown,
      disposables?: vscode.Disposable[],
    ) => vscode.Disposable;
  };
};

/**
 * Панель webview с корректной регистрацией dispose / сообщений (как в VS Code API).
 */
function createFakeBindingPanel(): {
  panel: FakePanel;
  getPostedToWebview: () => unknown[];
  simulateWebviewMessage: (msg: unknown) => Promise<void>;
} {
  const posted: unknown[] = [];
  const disposePanelListeners: Array<() => void> = [];
  let messageHandler: ((msg: unknown) => void | Thenable<void>) | undefined;

  const webview = {
    cspSource: 'https://vscode-resource.test',
    html: '',
    postMessage: (msg: unknown) => {
      posted.push(msg);
      return Promise.resolve(true);
    },
    onDidReceiveMessage: (
      cb: (msg: unknown) => void | Thenable<void>,
      _thisArgs: unknown,
      disposables?: vscode.Disposable[],
    ) => {
      messageHandler = cb;
      const d = {
        dispose: () => {
          if (messageHandler === cb) {
            messageHandler = undefined;
          }
        },
      };
      disposables?.push(d);
      return d;
    },
  };

  const panel: FakePanel = {
    title: '',
    reveal: () => undefined,
    onDidDispose: (listener, _thisArgs, disposables) => {
      disposePanelListeners.push(listener);
      const d = {
        dispose: () => {
          const i = disposePanelListeners.indexOf(listener);
          if (i >= 0) {
            disposePanelListeners.splice(i, 1);
          }
        },
      };
      disposables?.push(d);
      return d;
    },
    dispose: () => {
      const copy = [...disposePanelListeners];
      disposePanelListeners.length = 0;
      for (const l of copy) {
        l();
      }
    },
    webview,
  };

  return {
    panel,
    getPostedToWebview: () => [...posted],
    simulateWebviewMessage: async (msg: unknown) => {
      if (!messageHandler) {
        assert.fail('onDidReceiveMessage handler not registered');
      }
      await messageHandler(msg);
      // `BindingDialogPanel` регистрирует `(m) => void this.onMessage(m)` — промисы не ждутся.
      for (let i = 0; i < 12; i++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    },
  };
}

/**
 * Webview регистрирует `(msg) => void onMessage(msg)` — промис `onMessage` не ожидается.
 * Даём event loop обработать `await` внутри обработчика (upsert, quickPick, …).
 */
async function flushExtensionMessageHandling(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

suite('bindingDialog getBindingDialogHtml', () => {
  test('embeds CSP, context path, mass flag and toolbar labels', () => {
    const html = getBindingDialogHtml(mockWebview, {
      workspaceFolder: 'my-ws',
      configRelativePath: 'src/Configuration.xml',
      rows: [
        { id: 'ib-1', label: 'База один' },
        { id: 'ib-2', label: 'База два' },
      ],
      massDeployment: true,
    });

    assert.ok(html.includes("script-src 'unsafe-inline'"));
    assert.ok(html.includes('vscode-webview-test-csp'));
    assert.ok(html.includes('Привязка информационных баз'));
    assert.ok(html.includes('Добавить из списка'));
    assert.ok(html.includes('Массовая раскатка'));
    assert.ok(html.includes('"massDeployment":true'));
    assert.ok(html.includes('my-ws'));
    assert.ok(html.includes('src/Configuration.xml'));
    assert.ok(html.includes('ib-1'));
    assert.ok(html.includes('База один'));
    assert.ok(html.includes('.row-dimmed'));
    assert.ok(html.includes('.mass-wrap.on'));
  });

  test('escapes closing script sequence inside embedded JSON state', () => {
    const html = getBindingDialogHtml(mockWebview, {
      workspaceFolder: 'evil</script><script>',
      configRelativePath: 'Configuration.xml',
      rows: [],
      massDeployment: false,
    });

    assert.ok(!html.includes('evil</script><script>'));
    assert.ok(html.includes('evil<\\/script><script>'));
  });

  test('includes deploy hint class names for single-base warning path', () => {
    const html = getBindingDialogHtml(mockWebview, {
      workspaceFolder: 'w',
      configRelativePath: 'c.xml',
      rows: [{ id: 'x', label: 'only-one' }],
      massDeployment: false,
    });

    assert.ok(html.includes('.deploy-hint.warn'));
    assert.ok(html.includes('.row-active'));
  });

  test('mass deployment true embeds info deploy hint logic for multiple rows', () => {
    const html = getBindingDialogHtml(mockWebview, {
      workspaceFolder: 'w',
      configRelativePath: 'c.xml',
      rows: [
        { id: '1', label: 'A' },
        { id: '2', label: 'B' },
      ],
      massDeployment: true,
    });

    assert.ok(html.includes('.deploy-hint.info'));
    assert.ok(html.includes('последовательно'));
  });

  test('empty list placeholder text is present', () => {
    const html = getBindingDialogHtml(mockWebview, {
      workspaceFolder: 'w',
      configRelativePath: 'c.xml',
      rows: [],
      massDeployment: false,
    });

    assert.ok(html.includes('Нет привязанных баз'));
  });

  test('embedded script includes mass-deploy uncheck confirm text', () => {
    const html = getBindingDialogHtml(mockWebview, {
      workspaceFolder: 'w',
      configRelativePath: 'c.xml',
      rows: [{ id: 'a', label: 'A' }],
      massDeployment: false,
    });

    assert.ok(html.includes('Отключить массовую раскатку?'));
    assert.ok(html.includes('только в первую базу'));
  });

  test('JSON state escapes double quotes inside row labels', () => {
    const html = getBindingDialogHtml(mockWebview, {
      workspaceFolder: 'w',
      configRelativePath: 'c.xml',
      rows: [{ id: 'id1', label: 'He said "ok"' }],
      massDeployment: false,
    });

    assert.ok(html.includes('id1'));
    assert.ok(html.includes('\\"ok\\"'));
  });
});

suite('BindingDialogPanel', () => {
  const root = path.join(tmpdir(), `1cviewer-binding-dialog-${Date.now()}`);
  const folder: vscode.WorkspaceFolder = {
    name: 'dlg-ws',
    index: 0,
    uri: vscode.Uri.file(root),
  };

  let memento: MapMemento;
  let secrets: MapSecretStorage;
  let storage: InfobaseStorageService;
  let fs: vscode.FileSystem;
  let bindingManager: BindingManager;
  let state: ExtensionState;
  let context: vscode.ExtensionContext;
  let restoreCreatePanel: (() => void) | undefined;

  setup(() => {
    resetVscodeTestState();
    memento = new MapMemento();
    secrets = new MapSecretStorage();
    storage = new InfobaseStorageService(memento, secrets);
    fs = createMemoryFs();
    bindingManager = new BindingManager({
      fileSystem: fs,
      getWorkspaceFolders: () => [folder],
    });
    state = new ExtensionState();
    state.infobaseStorage = storage;
    state.bindingManager = bindingManager;
    context = createFakeExtensionContext();
  });

  teardown(() => {
    restoreCreatePanel?.();
    restoreCreatePanel = undefined;
    resetVscodeTestState();
  });

  function patchPanelFactory(fake: FakePanel): void {
    const w = vscode.window as unknown as { createWebviewPanel: typeof vscode.window.createWebviewPanel };
    const original = w.createWebviewPanel;
    w.createWebviewPanel = ((_viewType, _title, _col, _opts) => fake) as typeof vscode.window.createWebviewPanel;
    restoreCreatePanel = () => {
      w.createWebviewPanel = original;
    };
  }

  test('show reports error when storage is missing', async () => {
    state.infobaseStorage = null;
    const dlg = new BindingDialogPanel(context, state);
    await dlg.show(folder.name, 'Configuration.xml');
    assert.ok(vscodeTestState.errorLog.some((m) => m.includes('не инициализировано')));
    dlg.dispose();
  });

  test('show reports error when binding manager is missing', async () => {
    state.bindingManager = null;
    const dlg = new BindingDialogPanel(context, state);
    await dlg.show(folder.name, 'Configuration.xml');
    assert.ok(vscodeTestState.errorLog.some((m) => m.includes('не инициализировано')));
    dlg.dispose();
  });

  test('show loads binding, builds html with catalog labels and default binding', async () => {
    const ib: InfobaseEntry = {
      id: randomUUID(),
      name: 'Каталог A',
      type: 'file',
      filePath: 'C:/x',
      ibcmdConfigYamlPath: 'C:/x/y.yaml',
      hasStoredPassword: false,
      createdAt: new Date().toISOString(),
    };
    await storage.upsert(ib);
    await bindingManager.upsert({
      workspaceFolder: folder.name,
      configRelativePath: 'Configuration.xml',
      infobaseIds: [ib.id, IB_ORPHAN],
      massDeployment: false,
    });

    const { panel, getPostedToWebview } = createFakeBindingPanel();
    patchPanelFactory(panel as unknown as vscode.WebviewPanel);

    const dlg = new BindingDialogPanel(context, state);
    await dlg.show(folder.name, 'Configuration.xml');

    assert.ok(panel.webview.html.includes('Каталог A'));
    assert.ok(panel.webview.html.includes(ib.id));
    assert.ok(panel.webview.html.includes(`${IB_ORPHAN} (нет в каталоге)`));
    assert.ok(panel.webview.html.includes('"massDeployment":false'));
    dlg.dispose();
    assert.strictEqual(getPostedToWebview().length, 0);
  });

  test('second show reuses panel and calls reveal', async () => {
    const { panel } = createFakeBindingPanel();
    patchPanelFactory(panel as unknown as vscode.WebviewPanel);
    let revealCount = 0;
    panel.reveal = () => {
      revealCount += 1;
    };

    const dlg = new BindingDialogPanel(context, state);
    await dlg.show(folder.name, 'a.xml');
    await dlg.show(folder.name, 'b.xml');
    assert.strictEqual(revealCount, 1);
    dlg.dispose();
  });

  test('save upserts binding from webview payload', async () => {
    const { panel, simulateWebviewMessage } = createFakeBindingPanel();
    patchPanelFactory(panel as unknown as vscode.WebviewPanel);

    const dlg = new BindingDialogPanel(context, state);
    await dlg.show(folder.name, 'cfg/Configuration.xml');

    await simulateWebviewMessage({
      type: 'save',
      infobaseIds: ['u1', 'u2'],
      massDeployment: true,
    });
    await flushExtensionMessageHandling();

    const got = await bindingManager.get(folder.name, 'cfg/Configuration.xml');
    assert.ok(got);
    assert.deepStrictEqual(got!.infobaseIds, ['u1', 'u2']);
    assert.strictEqual(got!.massDeployment, true);
    dlg.dispose();
  });

  test('save with empty infobaseIds clears list in storage', async () => {
    await bindingManager.upsert({
      workspaceFolder: folder.name,
      configRelativePath: 'empty-save.xml',
      infobaseIds: ['keep'],
      massDeployment: true,
    });

    const { panel, simulateWebviewMessage } = createFakeBindingPanel();
    patchPanelFactory(panel as unknown as vscode.WebviewPanel);

    const dlg = new BindingDialogPanel(context, state);
    await dlg.show(folder.name, 'empty-save.xml');

    await simulateWebviewMessage({
      type: 'save',
      infobaseIds: [],
      massDeployment: false,
    });
    await flushExtensionMessageHandling();

    const got = await bindingManager.get(folder.name, 'empty-save.xml');
    assert.ok(got);
    assert.deepStrictEqual(got!.infobaseIds, []);
    assert.strictEqual(got!.massDeployment, false);
    dlg.dispose();
  });

  test('save shows error when upsert throws', async () => {
    const { panel, simulateWebviewMessage } = createFakeBindingPanel();
    patchPanelFactory(panel as unknown as vscode.WebviewPanel);

    const origUpsert = bindingManager.upsert.bind(bindingManager);
    bindingManager.upsert = async () => {
      throw new Error('write denied');
    };

    const dlg = new BindingDialogPanel(context, state);
    await dlg.show(folder.name, 'err.xml');

    await simulateWebviewMessage({
      type: 'save',
      infobaseIds: ['x'],
      massDeployment: false,
    });
    await flushExtensionMessageHandling();

    assert.ok(vscodeTestState.errorLog.some((m) => m.includes('write denied')));
    bindingManager.upsert = origUpsert;
    dlg.dispose();
  });

  test('cancel disposes webview panel', async () => {
    const { panel, simulateWebviewMessage } = createFakeBindingPanel();
    patchPanelFactory(panel as unknown as vscode.WebviewPanel);

    const dlg = new BindingDialogPanel(context, state);
    await dlg.show(folder.name, 'c.xml');

    let disposed = false;
    const orig = panel.dispose.bind(panel);
    panel.dispose = () => {
      disposed = true;
      orig();
    };

    await simulateWebviewMessage({ type: 'cancel' });
    assert.strictEqual(disposed, true);
    dlg.dispose();
  });

  test('addFromList shows info when no bases left to pick', async () => {
    const ib: InfobaseEntry = {
      id: randomUUID(),
      name: 'Only',
      type: 'file',
      filePath: 'C:/o',
      ibcmdConfigYamlPath: 'C:/o/y.yaml',
      hasStoredPassword: false,
      createdAt: new Date().toISOString(),
    };
    await storage.upsert(ib);

    const { panel, simulateWebviewMessage, getPostedToWebview } = createFakeBindingPanel();
    patchPanelFactory(panel as unknown as vscode.WebviewPanel);

    const dlg = new BindingDialogPanel(context, state);
    await dlg.show(folder.name, 'c.xml');

    await simulateWebviewMessage({
      type: 'addFromList',
      excludeIds: [ib.id],
      massDeployment: false,
    });
    await flushExtensionMessageHandling();

    assert.ok(
      vscodeTestState.informationLog.some((m) => m.includes('Все базы из каталога уже в списке')),
    );
    assert.strictEqual(getPostedToWebview().length, 0);
    dlg.dispose();
  });

  test('addFromList quickPick cancel does not post applyState', async () => {
    const idA = randomUUID();
    const idB = randomUUID();
    const a: InfobaseEntry = {
      id: idA,
      name: 'Alpha',
      type: 'file',
      filePath: 'C:/a',
      ibcmdConfigYamlPath: 'C:/a/y.yaml',
      hasStoredPassword: false,
      createdAt: new Date().toISOString(),
    };
    const b: InfobaseEntry = {
      id: idB,
      name: 'Beta',
      type: 'file',
      filePath: 'C:/b',
      ibcmdConfigYamlPath: 'C:/b/y.yaml',
      hasStoredPassword: false,
      createdAt: new Date().toISOString(),
    };
    await storage.upsert(a);
    await storage.upsert(b);
    vscodeTestState.quickPickQueue.push(undefined);

    const { panel, simulateWebviewMessage, getPostedToWebview } = createFakeBindingPanel();
    patchPanelFactory(panel as unknown as vscode.WebviewPanel);

    const dlg = new BindingDialogPanel(context, state);
    await dlg.show(folder.name, 'c.xml');

    await simulateWebviewMessage({
      type: 'addFromList',
      excludeIds: [idA],
      massDeployment: false,
    });
    await flushExtensionMessageHandling();

    assert.strictEqual(getPostedToWebview().length, 0);
    dlg.dispose();
  });

  test('addFromList quickPick adds id and posts applyState', async () => {
    const idA = randomUUID();
    const idB = randomUUID();
    const a: InfobaseEntry = {
      id: idA,
      name: 'Alpha',
      type: 'file',
      filePath: 'C:/a',
      ibcmdConfigYamlPath: 'C:/a/y.yaml',
      hasStoredPassword: false,
      createdAt: new Date().toISOString(),
    };
    const b: InfobaseEntry = {
      id: idB,
      name: 'Beta',
      type: 'file',
      filePath: 'C:/b',
      ibcmdConfigYamlPath: 'C:/b/y.yaml',
      hasStoredPassword: false,
      createdAt: new Date().toISOString(),
    };
    await storage.upsert(a);
    await storage.upsert(b);

    vscodeTestState.quickPickQueue.push({ label: 'Beta', description: 'file', id: idB });

    const { panel, simulateWebviewMessage, getPostedToWebview } = createFakeBindingPanel();
    patchPanelFactory(panel as unknown as vscode.WebviewPanel);

    const dlg = new BindingDialogPanel(context, state);
    await dlg.show(folder.name, 'c.xml');

    await simulateWebviewMessage({
      type: 'addFromList',
      excludeIds: [idA],
      massDeployment: true,
    });
    await flushExtensionMessageHandling();

    const posted = getPostedToWebview();
    assert.strictEqual(posted.length, 1);
    const msg = posted[0] as { type: string; rows: { id: string }[]; massDeployment: boolean };
    assert.strictEqual(msg.type, 'applyState');
    assert.strictEqual(msg.massDeployment, true);
    assert.deepStrictEqual(
      msg.rows.map((r) => r.id),
      [idA, idB],
    );
    dlg.dispose();
  });

  test('addCreate and addExisting execute infobase commands', async () => {
    const { panel, simulateWebviewMessage } = createFakeBindingPanel();
    patchPanelFactory(panel as unknown as vscode.WebviewPanel);

    const dlg = new BindingDialogPanel(context, state);
    await dlg.show(folder.name, 'c.xml');

    await simulateWebviewMessage({ type: 'addCreate' });
    await simulateWebviewMessage({ type: 'addExisting' });
    await flushExtensionMessageHandling();

    assert.deepStrictEqual(vscodeTestState.executedCommands, [
      ['1c-metadata-tree.infobases.create'],
      ['1c-metadata-tree.infobases.add'],
    ]);
    dlg.dispose();
  });

  test('invalid webview message does not throw and does not upsert', async () => {
    const { panel, simulateWebviewMessage } = createFakeBindingPanel();
    patchPanelFactory(panel as unknown as vscode.WebviewPanel);

    const dlg = new BindingDialogPanel(context, state);
    await dlg.show(folder.name, 'only.xml');

    await simulateWebviewMessage({ type: 'save', infobaseIds: 'not-array' });
    await simulateWebviewMessage(null);
    await simulateWebviewMessage({ type: 'addFromList', excludeIds: [1, 2] });
    await simulateWebviewMessage({
      type: 'save',
      infobaseIds: ['ok'],
      massDeployment: 'yes' as unknown as boolean,
    });
    await simulateWebviewMessage({
      type: 'addFromList',
      excludeIds: ['a'],
      massDeployment: 1 as unknown as boolean,
    });
    await flushExtensionMessageHandling();

    assert.strictEqual(await bindingManager.get(folder.name, 'only.xml'), undefined);
    dlg.dispose();
  });

  test('ready message is ignored', async () => {
    const { panel, simulateWebviewMessage } = createFakeBindingPanel();
    patchPanelFactory(panel as unknown as vscode.WebviewPanel);

    const dlg = new BindingDialogPanel(context, state);
    await dlg.show(folder.name, 'c.xml');
    await simulateWebviewMessage({ type: 'ready' });
    dlg.dispose();
  });

  test('catalog change pushes updateLabels to webview', async () => {
    const ib: InfobaseEntry = {
      id: randomUUID(),
      name: 'OldName',
      type: 'file',
      filePath: 'C:/r',
      ibcmdConfigYamlPath: 'C:/r/y.yaml',
      hasStoredPassword: false,
      createdAt: new Date().toISOString(),
    };
    await storage.upsert(ib);
    await bindingManager.upsert({
      workspaceFolder: folder.name,
      configRelativePath: 'c.xml',
      infobaseIds: [ib.id],
      massDeployment: false,
    });

    const { panel, getPostedToWebview } = createFakeBindingPanel();
    patchPanelFactory(panel as unknown as vscode.WebviewPanel);

    const dlg = new BindingDialogPanel(context, state);
    await dlg.show(folder.name, 'c.xml');

    await storage.upsert({ ...ib, name: 'NewName' });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const posted = getPostedToWebview().filter((m) => (m as { type?: string }).type === 'updateLabels');
    assert.strictEqual(posted.length, 1);
    assert.strictEqual((posted[0] as { labels: Record<string, string> }).labels[ib.id], 'NewName');
    dlg.dispose();
  });

  test('addFromList when catalog is full still allows picking excluded ids only', async () => {
    const entries: InfobaseEntry[] = Array.from({ length: INFOBASE_STORAGE_MAX_ENTRIES }, (_, i) => ({
      id: randomUUID(),
      name: `n${i}`,
      type: 'file' as const,
      filePath: `C:/f${i}`,
      ibcmdConfigYamlPath: `C:/f${i}/y.yaml`,
      hasStoredPassword: false,
      createdAt: new Date().toISOString(),
    }));
    for (const e of entries) {
      await storage.upsert(e);
    }
    vscodeTestState.quickPickQueue.push({ label: 'n0', description: 'file', id: entries[0].id });

    const { panel, simulateWebviewMessage, getPostedToWebview } = createFakeBindingPanel();
    patchPanelFactory(panel as unknown as vscode.WebviewPanel);

    const dlg = new BindingDialogPanel(context, state);
    await dlg.show(folder.name, 'c.xml');

    await simulateWebviewMessage({
      type: 'addFromList',
      excludeIds: entries.slice(1).map((e) => e.id),
      massDeployment: false,
    });
    await flushExtensionMessageHandling();

    const posted = getPostedToWebview();
    assert.strictEqual(posted.length, 1);
    const msg = posted[0] as { rows: { id: string }[] };
    const gotIds = new Set(msg.rows.map((r) => r.id));
    assert.strictEqual(msg.rows.length, entries.length);
    for (const e of entries) {
      assert.ok(gotIds.has(e.id), `expected row for catalog id ${e.id}`);
    }
    dlg.dispose();
  });
});

suite('bindingDialog runOpenBindingDialog', () => {
  setup(() => {
    resetVscodeTestState();
  });

  teardown(() => {
    resetVscodeTestState();
  });

  function defineWorkspaceFolders(folders: vscode.WorkspaceFolder[] | undefined): void {
    Object.defineProperty(vscode.workspace, 'workspaceFolders', {
      configurable: true,
      enumerable: true,
      value: folders,
      writable: true,
    });
  }

  test('errors when binding manager or storage missing', async () => {
    const state = new ExtensionState();
    defineWorkspaceFolders([{ name: 'w', index: 0, uri: vscode.Uri.file('/tmp') }]);
    const panel = { show: async () => assert.fail('show must not run') };
    await runOpenBindingDialog(state, panel as unknown as BindingDialogPanel);
    assert.ok(vscodeTestState.errorLog.some((m) => m.includes('не инициализировано')));
  });

  test('errors when no workspace folders', async () => {
    const state = new ExtensionState();
    state.infobaseStorage = new InfobaseStorageService(new MapMemento(), new MapSecretStorage());
    state.bindingManager = new BindingManager({
      fileSystem: createMemoryFs(),
      getWorkspaceFolders: () => [],
    });
    defineWorkspaceFolders(undefined);

    const shown: string[][] = [];
    const panel = { show: async (a: string, b: string) => shown.push([a, b]) };
    await runOpenBindingDialog(state, panel as unknown as BindingDialogPanel);
    assert.ok(vscodeTestState.errorLog.some((m) => m.includes('Откройте папку workspace')));
    assert.strictEqual(shown.length, 0);
  });

  test('single folder: input path then show', async () => {
    const root = path.join(tmpdir(), `1cviewer-robd-${Date.now()}`);
    const wf: vscode.WorkspaceFolder = { name: 'solo', index: 0, uri: vscode.Uri.file(root) };
    defineWorkspaceFolders([wf]);

    const state = new ExtensionState();
    state.infobaseStorage = new InfobaseStorageService(new MapMemento(), new MapSecretStorage());
    state.bindingManager = new BindingManager({
      fileSystem: createMemoryFs(),
      getWorkspaceFolders: () => [wf],
    });

    vscodeTestState.inputBoxQueue.push('  .\\src\\Cfg.xml  ');

    const shown: string[][] = [];
    const panel = { show: async (a: string, b: string) => shown.push([a, b]) };
    await runOpenBindingDialog(state, panel as unknown as BindingDialogPanel);

    assert.deepStrictEqual(shown, [['solo', 'src/Cfg.xml']]);
  });

  test('multi folder: cancel quick pick skips show', async () => {
    const a: vscode.WorkspaceFolder = { name: 'a', index: 0, uri: vscode.Uri.file('/tmp/a') };
    const b: vscode.WorkspaceFolder = { name: 'b', index: 1, uri: vscode.Uri.file('/tmp/b') };
    defineWorkspaceFolders([a, b]);

    const state = new ExtensionState();
    state.infobaseStorage = new InfobaseStorageService(new MapMemento(), new MapSecretStorage());
    state.bindingManager = new BindingManager({
      fileSystem: createMemoryFs(),
      getWorkspaceFolders: () => [a, b],
    });

    vscodeTestState.quickPickQueue.push(undefined);

    const shown: string[][] = [];
    const panel = { show: async (x: string, y: string) => shown.push([x, y]) };
    await runOpenBindingDialog(state, panel as unknown as BindingDialogPanel);
    assert.strictEqual(shown.length, 0);
  });

  test('multi folder: picked folder and normalized path call show', async () => {
    const a: vscode.WorkspaceFolder = { name: 'root-a', index: 0, uri: vscode.Uri.file('/tmp/a') };
    const b: vscode.WorkspaceFolder = { name: 'root-b', index: 1, uri: vscode.Uri.file('/tmp/b') };
    defineWorkspaceFolders([a, b]);

    const state = new ExtensionState();
    state.infobaseStorage = new InfobaseStorageService(new MapMemento(), new MapSecretStorage());
    state.bindingManager = new BindingManager({
      fileSystem: createMemoryFs(),
      getWorkspaceFolders: () => [a, b],
    });

    vscodeTestState.quickPickQueue.push({ label: 'root-b', description: '/tmp/b', folder: b });
    vscodeTestState.inputBoxQueue.push('Configuration.xml');

    const shown: string[][] = [];
    const panel = { show: async (x: string, y: string) => shown.push([x, y]) };
    await runOpenBindingDialog(state, panel as unknown as BindingDialogPanel);

    assert.deepStrictEqual(shown, [['root-b', 'Configuration.xml']]);
  });

  test('input box undefined (cancel) skips show', async () => {
    const wf: vscode.WorkspaceFolder = { name: 'w', index: 0, uri: vscode.Uri.file('/tmp/w') };
    defineWorkspaceFolders([wf]);

    const state = new ExtensionState();
    state.infobaseStorage = new InfobaseStorageService(new MapMemento(), new MapSecretStorage());
    state.bindingManager = new BindingManager({
      fileSystem: createMemoryFs(),
      getWorkspaceFolders: () => [wf],
    });

    vscodeTestState.inputBoxQueue.push(undefined);

    const shown: string[][] = [];
    const panel = { show: async (x: string, y: string) => shown.push([x, y]) };
    await runOpenBindingDialog(state, panel as unknown as BindingDialogPanel);
    assert.strictEqual(shown.length, 0);
  });
});

suite('bindingDialog registerBindingDialogCommands', () => {
  setup(() => resetVscodeTestState());
  teardown(() => resetVscodeTestState());

  test('returns disposables including command registration', () => {
    const state = new ExtensionState();
    state.infobaseStorage = new InfobaseStorageService(new MapMemento(), new MapSecretStorage());
    state.bindingManager = new BindingManager({ fileSystem: createMemoryFs() });
    const ctx = createFakeExtensionContext();
    const disposables = registerBindingDialogCommands(ctx, state);
    assert.ok(Array.isArray(disposables));
    assert.strictEqual(disposables.length, 2);
    for (const d of disposables) {
      assert.strictEqual(typeof d.dispose, 'function');
    }
    for (const d of disposables) {
      d.dispose();
    }
  });
});
