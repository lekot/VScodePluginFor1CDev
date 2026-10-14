/**
 * Tests for the diff logic used by SubsystemCompositionEditorProvider.
 *
 * The provider keeps two Sets: `initialChecked` (state on open) and
 * `currentChecked` (state after user interactions).  On save it derives:
 *   toAdd    = currentChecked \ initialChecked
 *   toRemove = initialChecked \ currentChecked
 *
 * We test that logic via a local simulateDiff helper that mirrors the
 * implementation exactly, and also verify the toggle / selectAll / deselectAll
 * mutations in isolation.
 */
import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { CompositionEditorProvider } from '../../src/compositionEditor/compositionEditorProvider';
import { SubsystemStrategy } from '../../src/compositionEditor/strategies/subsystemStrategy';
import { CommonAttributeStrategy } from '../../src/compositionEditor/strategies/commonAttributeStrategy';
import { FunctionalOptionStrategy } from '../../src/compositionEditor/strategies/functionalOptionStrategy';
import { FilterCriterionStrategy } from '../../src/compositionEditor/strategies/filterCriterionStrategy';
import { ExchangePlanStrategy } from '../../src/compositionEditor/strategies/exchangePlanStrategy';
import { TreeNode, MetadataType } from '../../src/models/treeNode';
import { createTempDir, cleanupTempDir } from '../helpers/testHelpers';
import { configureConfigurationMutationGateway } from '../../src/services/configurationSession/configurationMutationGateway';
import { CompositionWebviewRuntime } from '../helpers/compositionWebviewRuntime';

// ── diff simulator ────────────────────────────────────────────────────────────

/**
 * Mirrors the diff computation from SubsystemCompositionEditorProvider.handleSave.
 */
function computeDiff(
  initialChecked: ReadonlySet<string>,
  currentChecked: ReadonlySet<string>,
): { toAdd: string[]; toRemove: string[] } {
  const toAdd = [...currentChecked].filter((r) => !initialChecked.has(r));
  const toRemove = [...initialChecked].filter((r) => !currentChecked.has(r));
  return { toAdd, toRemove };
}

/**
 * Simulates a sequence of toggle operations starting from `initialChecked`.
 */
function simulateDiff(
  initialChecked: Set<string>,
  toggles: Array<{ ref: string; checked: boolean }>,
): { toAdd: string[]; toRemove: string[] } {
  const currentChecked = new Set(initialChecked);
  for (const { ref, checked } of toggles) {
    if (checked) {
      currentChecked.add(ref);
    } else {
      currentChecked.delete(ref);
    }
  }
  return computeDiff(initialChecked, currentChecked);
}

// ── suite ─────────────────────────────────────────────────────────────────────

suite('subsystemCompositionEditorProvider — diff logic', () => {
  // 1 ─────────────────────────────────────────────────────────────────────────
  test('toggle add: checking an unchecked ref appears in toAdd', () => {
    const initial = new Set<string>(['Catalog.Existing']);
    const { toAdd, toRemove } = simulateDiff(initial, [
      { ref: 'Document.NewDoc', checked: true },
    ]);

    assert.ok(toAdd.includes('Document.NewDoc'), 'newly toggled ref must be in toAdd');
    assert.deepStrictEqual(toRemove, [], 'toRemove must be empty');
  });

  // 2 ─────────────────────────────────────────────────────────────────────────
  test('toggle remove: unchecking an initially-checked ref appears in toRemove', () => {
    const initial = new Set<string>(['Catalog.Items', 'Document.Order']);
    const { toAdd, toRemove } = simulateDiff(initial, [
      { ref: 'Catalog.Items', checked: false },
    ]);

    assert.deepStrictEqual(toAdd, [], 'toAdd must be empty');
    assert.ok(toRemove.includes('Catalog.Items'), 'unchecked ref must be in toRemove');
    assert.ok(!toRemove.includes('Document.Order'), 'untouched ref must not be in toRemove');
  });

  // 3 ─────────────────────────────────────────────────────────────────────────
  test('toggle back (net-zero): checking then unchecking yields empty diff', () => {
    const initial = new Set<string>(['Catalog.Items']);
    const { toAdd, toRemove } = simulateDiff(initial, [
      { ref: 'Document.NewDoc', checked: true },
      { ref: 'Document.NewDoc', checked: false },
    ]);

    assert.deepStrictEqual(toAdd, [], 'net-zero add must yield empty toAdd');
    assert.deepStrictEqual(toRemove, [], 'net-zero remove must yield empty toRemove');
  });

  // 4 ─────────────────────────────────────────────────────────────────────────
  test('multiple toggles: correct toAdd and toRemove', () => {
    const initial = new Set<string>(['Catalog.A', 'Catalog.B', 'Document.X']);
    const { toAdd, toRemove } = simulateDiff(initial, [
      { ref: 'Catalog.B', checked: false },      // remove
      { ref: 'Document.X', checked: false },     // remove
      { ref: 'Subsystem.Admin', checked: true }, // add
      { ref: 'Catalog.New', checked: true },     // add
    ]);

    assert.deepStrictEqual(toAdd.sort(), ['Catalog.New', 'Subsystem.Admin']);
    assert.deepStrictEqual(toRemove.sort(), ['Catalog.B', 'Document.X']);
    assert.ok(!toAdd.includes('Catalog.A'), 'untouched ref must not appear in toAdd');
  });

  // 5 ─────────────────────────────────────────────────────────────────────────
  test('selectAll: all provided refs are added to currentChecked', () => {
    const initial = new Set<string>(['Catalog.A']);
    const allRefs = ['Catalog.A', 'Document.X', 'Document.Y'];

    // Simulate the 'selectAll' handler
    const currentChecked = new Set(initial);
    for (const ref of allRefs) {
      currentChecked.add(ref);
    }
    const { toAdd, toRemove } = computeDiff(initial, currentChecked);

    assert.deepStrictEqual(toAdd.sort(), ['Document.X', 'Document.Y']);
    assert.deepStrictEqual(toRemove, [], 'selectAll must not remove anything');
  });

  // 6 ─────────────────────────────────────────────────────────────────────────
  test('deselectAll: all provided refs are removed from currentChecked', () => {
    const initial = new Set<string>(['Catalog.A', 'Document.X', 'Document.Y']);
    const allRefs = ['Catalog.A', 'Document.X', 'Document.Y'];

    // Simulate the 'deselectAll' handler
    const currentChecked = new Set(initial);
    for (const ref of allRefs) {
      currentChecked.delete(ref);
    }
    const { toAdd, toRemove } = computeDiff(initial, currentChecked);

    assert.deepStrictEqual(toAdd, [], 'deselectAll must not add anything');
    assert.deepStrictEqual(toRemove.sort(), ['Catalog.A', 'Document.X', 'Document.Y']);
  });
});

suite('CompositionEditorProvider — production writers & save entrypoint (Issue 159)', () => {
  let tmpDir: string;
  let originalCreateWebviewPanel: typeof vscode.window.createWebviewPanel;
  let currentMessageHandler: ((msg: any) => void) | undefined;
  let postedMessages: any[] = [];
  let panelDisposed = false;

  setup(async () => {
    tmpDir = await createTempDir('1cviewer-provider-save-');
    postedMessages = [];
    panelDisposed = false;
    currentMessageHandler = undefined;

    originalCreateWebviewPanel = vscode.window.createWebviewPanel;
    (vscode.window as any).createWebviewPanel = () => {
      return {
        title: '',
        webview: {
          html: '',
          postMessage: async (msg: any) => {
            postedMessages.push(msg);
            return true;
          },
          onDidReceiveMessage: (cb: any) => {
            currentMessageHandler = cb;
            return { dispose: () => {} };
          },
        },
        reveal: () => {},
        onDidDispose: (cb: any) => {
          return { dispose: () => {} };
        },
        dispose: () => {
          panelDisposed = true;
        },
      };
    };
  });

  teardown(async () => {
    (vscode.window as any).createWebviewPanel = originalCreateWebviewPanel;
    await cleanupTempDir(tmpDir);
  });

  function createMockContext(): vscode.ExtensionContext {
    return {
      extensionPath: path.resolve(__dirname, '../../'),
      extensionUri: vscode.Uri.file(path.resolve(__dirname, '../../')),
      subscriptions: [],
    } as unknown as vscode.ExtensionContext;
  }

  function createMockTreeProvider(): any {
    return {
      getRootNodes: () => [],
      getChildren: async () => [],
    };
  }

  test('SubsystemStrategy: save entrypoint updates real XML on disk and routes through gateway', async () => {
    const xmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" version="2.17">
  <Subsystem uuid="00000000-0000-0000-0000-000000000001">
    <Properties>
      <Name>Admin</Name>
      <Content/>
    </Properties>
  </Subsystem>
</MetaDataObject>`;
    const filePath = path.join(tmpDir, 'Subsystem.xml');
    await fsp.writeFile(filePath, xmlContent, 'utf-8');

    let gatewayCalled = false;
    const gateway = configureConfigurationMutationGateway(
      async (resPath, kind, op) => {
        gatewayCalled = true;
        assert.strictEqual(kind, 'ui.composition.save');
        assert.strictEqual(path.resolve(resPath), path.resolve(filePath));
        return op();
      },
      async (_path, plan) => plan.result
    );

    const provider = new CompositionEditorProvider(
      createMockContext(),
      {
        loadMetadataTree: async () => {},
        invalidateTreeCacheOnly: async () => {},
      },
      SubsystemStrategy
    );

    try {
      const node: TreeNode = {
        id: 'subsystem:admin',
        name: 'Admin',
        type: MetadataType.Subsystem,
        filePath,
        properties: {},
      };

      await provider.show(node, createMockTreeProvider(), tmpDir);
      assert.ok(currentMessageHandler, 'Webview message handler must be registered');

      // Send toggle message from webview
      currentMessageHandler({ command: 'toggle', data: { ref: 'Catalog.Users', checked: true } });
      assert.strictEqual(provider.getDirtyCount(), 1);

      // Send save message
      await currentMessageHandler({ command: 'save' });

      assert.strictEqual(gatewayCalled, true, 'Save entrypoint must route through configuration mutation gateway');
      assert.ok(
        postedMessages.some((m) => m.command === 'saveSuccess'),
        `Expected saveSuccess in webview messages: ${JSON.stringify(postedMessages)}`
      );

      const written = await fsp.readFile(filePath, 'utf-8');
      assert.ok(written.includes('Catalog.Users'), 'Subsystem.xml must contain Catalog.Users');
      assert.strictEqual(panelDisposed, true, 'Panel must be disposed on successful save');
    } finally {
      gateway.dispose();
      provider.dispose();
    }
  });

  test('CommonAttributeStrategy: save entrypoint updates Use setting on real XML on disk', async () => {
    const xmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" version="2.17">
  <CommonAttribute uuid="00000000-0000-0000-0000-000000000002">
    <Properties>
      <Name>Department</Name>
      <Content/>
    </Properties>
  </CommonAttribute>
</MetaDataObject>`;
    const filePath = path.join(tmpDir, 'CommonAttribute.xml');
    await fsp.writeFile(filePath, xmlContent, 'utf-8');

    const provider = new CompositionEditorProvider(
      createMockContext(),
      {
        loadMetadataTree: async () => {},
        invalidateTreeCacheOnly: async () => {},
      },
      CommonAttributeStrategy
    );

    try {
      const node: TreeNode = {
        id: 'commonAttribute:dept',
        name: 'Department',
        type: MetadataType.CommonAttribute,
        filePath,
        properties: {},
      };

      await provider.show(node, createMockTreeProvider(), tmpDir);
      assert.ok(currentMessageHandler, 'Webview message handler must be registered');

      currentMessageHandler({ command: 'toggle', data: { ref: 'Catalog.Employees', checked: true } });
      currentMessageHandler({
        command: 'settingChange',
        data: { ref: 'Catalog.Employees', key: 'Use', value: 'DontUse' },
      });

      await currentMessageHandler({ command: 'save' });

      assert.ok(
        postedMessages.some((m) => m.command === 'saveSuccess'),
        `Expected saveSuccess message: ${JSON.stringify(postedMessages)}`
      );

      const written = await fsp.readFile(filePath, 'utf-8');
      assert.ok(written.includes('Catalog.Employees'), 'CommonAttribute.xml must contain Catalog.Employees');
      assert.ok(written.includes('DontUse'), 'CommonAttribute.xml must contain DontUse');
    } finally {
      provider.dispose();
    }
  });

  test('FunctionalOptionStrategy: save entrypoint adds multi-segment ref to real XML', async () => {
    const xmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" version="2.17">
  <FunctionalOption uuid="00000000-0000-0000-0000-000000000003">
    <Properties>
      <Name>UseDiscounts</Name>
      <Content/>
    </Properties>
  </FunctionalOption>
</MetaDataObject>`;
    const filePath = path.join(tmpDir, 'FunctionalOption.xml');
    await fsp.writeFile(filePath, xmlContent, 'utf-8');

    const provider = new CompositionEditorProvider(
      createMockContext(),
      {
        loadMetadataTree: async () => {},
        invalidateTreeCacheOnly: async () => {},
      },
      FunctionalOptionStrategy
    );

    try {
      const node: TreeNode = {
        id: 'functionalOption:discounts',
        name: 'UseDiscounts',
        type: MetadataType.FunctionalOption,
        filePath,
        properties: {},
      };

      await provider.show(node, createMockTreeProvider(), tmpDir);
      assert.ok(currentMessageHandler, 'Webview message handler must be registered');

      currentMessageHandler({
        command: 'toggle',
        data: { ref: 'Document.Order.TabularSection.Goods.Attribute.Discount', checked: true },
      });

      await currentMessageHandler({ command: 'save' });

      const written = await fsp.readFile(filePath, 'utf-8');
      assert.ok(
        written.includes('Document.Order.TabularSection.Goods.Attribute.Discount'),
        'FunctionalOption.xml must contain nested ref'
      );
    } finally {
      provider.dispose();
    }
  });

  test('reports saveError to webview when invalid reference rejected', async () => {
    const xmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" version="2.17">
  <Subsystem uuid="00000000-0000-0000-0000-000000000004">
    <Properties>
      <Name>InvalidTest</Name>
      <Content/>
    </Properties>
  </Subsystem>
</MetaDataObject>`;
    const filePath = path.join(tmpDir, 'Subsystem.xml');
    await fsp.writeFile(filePath, xmlContent, 'utf-8');

    const provider = new CompositionEditorProvider(
      createMockContext(),
      {
        loadMetadataTree: async () => {},
        invalidateTreeCacheOnly: async () => {},
      },
      SubsystemStrategy
    );

    try {
      const node: TreeNode = {
        id: 'subsystem:invalid',
        name: 'InvalidTest',
        type: MetadataType.Subsystem,
        filePath,
        properties: {},
      };

      await provider.show(node, createMockTreeProvider(), tmpDir);
      assert.ok(currentMessageHandler, 'Webview message handler must be registered');

      currentMessageHandler({ command: 'toggle', data: { ref: 'InvalidNameWithoutType', checked: true } });
      await currentMessageHandler({ command: 'save' });

      assert.ok(
        postedMessages.some((m) => m.command === 'saveError'),
        `Expected saveError in webview messages: ${JSON.stringify(postedMessages)}`
      );
      assert.strictEqual(panelDisposed, false, 'Panel must not be disposed on save error');
    } finally {
      provider.dispose();
    }
  });
});

type CompositionDeferred<T = void> = {
  promise: Promise<T>;
  resolve(value?: T): void;
  reject(reason?: unknown): void;
};

function compositionDeferred<T = void>(): CompositionDeferred<T> {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value?: T) => resolvePromise(value as T),
    reject: rejectPromise,
  };
}

function createCompositionPanelHarness(runRealWebview = false): {
  panel: vscode.WebviewPanel;
  posted: any[];
  runtime: CompositionWebviewRuntime | undefined;
  disposed(): boolean;
  liveState(): { checkedRefs: string[]; itemSettings: Record<string, Record<string, string>> } | undefined;
  htmlAssignmentCount(): number;
  dispatch(message: unknown): Promise<void>;
} {
  let disposeHandler: (() => void) | undefined;
  let messageHandler: ((message: unknown) => Promise<void>) | undefined;
  let isDisposed = false;
  let htmlValue = '';
  let htmlAssignments = 0;
  let displayedState: { checkedRefs: string[]; itemSettings: Record<string, Record<string, string>> } | undefined;
  const posted: any[] = [];
  const runtime = runRealWebview ? new CompositionWebviewRuntime() : undefined;
  const webview = {
    get html(): string { return htmlValue; },
    set html(value: string) {
      htmlValue = value;
      htmlAssignments++;
      const match = value.match(/window\.__compositionData = (.*);/);
      if (match) {
        const payload = JSON.parse(match[1]);
        displayedState = {
          checkedRefs: [...payload.checkedRefs],
          itemSettings: JSON.parse(JSON.stringify(payload.itemSettings)),
        };
      }
      runtime?.loadHtml(value);
    },
    postMessage: async (message: unknown) => {
      posted.push(message);
      if (runtime) {
        runtime.postMessageToWebview(message as import('../../src/compositionEditor/compositionContracts').CompositionHostMessage);
      }
      return true;
    },
    onDidReceiveMessage: (callback: (message: unknown) => Promise<void>) => {
      messageHandler = callback;
      runtime?.connectExtension(callback as (message: import('../../src/compositionEditor/compositionContracts').CompositionWebviewMessage) => Promise<void>);
      return { dispose: () => {} };
    },
  };
  const panel = {
    title: '',
    reveal: () => {},
    onDidDispose: (callback: () => void) => {
      disposeHandler = callback;
      return { dispose: () => {} };
    },
    webview,
    dispose: () => {
      if (isDisposed) {
        return;
      }
      isDisposed = true;
      disposeHandler?.();
    },
  } as unknown as vscode.WebviewPanel;
  return {
    panel,
    posted,
    runtime,
    disposed: () => isDisposed,
    liveState: () => displayedState && {
      checkedRefs: [...displayedState.checkedRefs],
      itemSettings: JSON.parse(JSON.stringify(displayedState.itemSettings)),
    },
    htmlAssignmentCount: () => htmlAssignments,
    dispatch: async (message) => {
      if (displayedState && message && typeof message === 'object') {
        const incoming = message as Record<string, any>;
        if (incoming.command === 'toggle') {
          const refs = new Set(displayedState.checkedRefs);
          if (incoming.data.checked) { refs.add(incoming.data.ref); } else { refs.delete(incoming.data.ref); }
          displayedState.checkedRefs = [...refs];
        } else if (incoming.command === 'settingChange') {
          displayedState.itemSettings[incoming.data.ref] ??= {};
          displayedState.itemSettings[incoming.data.ref][incoming.data.key] = incoming.data.value;
        } else if (incoming.command === 'selectAll') {
          displayedState.checkedRefs = [...new Set([...displayedState.checkedRefs, ...incoming.data.refs])];
        } else if (incoming.command === 'deselectAll') {
          const removed = new Set(incoming.data.refs);
          displayedState.checkedRefs = displayedState.checkedRefs.filter((ref) => !removed.has(ref));
        }
      }
      await messageHandler?.(message);
    },
  };
}

function patchCompositionPanelFactory(runRealWebview = false): {
  panels: ReturnType<typeof createCompositionPanelHarness>[];
  restore(): void;
} {
  const original = vscode.window.createWebviewPanel;
  const panels: ReturnType<typeof createCompositionPanelHarness>[] = [];
  (vscode.window as any).createWebviewPanel = (_viewType: string, title: string) => {
    const harness = createCompositionPanelHarness(runRealWebview);
    harness.panel.title = title;
    panels.push(harness);
    return harness.panel;
  };
  return {
    panels,
    restore: () => {
      (vscode.window as any).createWebviewPanel = original;
    },
  };
}

function createCompositionContext(): vscode.ExtensionContext {
  const extensionPath = path.resolve(__dirname, '../../');
  return {
    extensionPath,
    extensionUri: vscode.Uri.file(extensionPath),
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
}

function createCompositionNode(filePath: string, name: string, type = MetadataType.Subsystem): TreeNode {
  return {
    id: `${type}:${name}`,
    name,
    type,
    filePath,
    properties: {},
  };
}

function createCompositionTreeProvider(roots: TreeNode[], getChildren?: (node: TreeNode) => Promise<TreeNode[]>): any {
  return {
    getRootNodes: () => roots,
    getChildren: getChildren ?? (async (node: TreeNode) => node.children ?? []),
  };
}

function subsystemXml(name: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" version="2.17">
  <Subsystem uuid="00000000-0000-0000-0000-000000000001">
    <Properties><Name>${name}</Name><Content/></Properties>
  </Subsystem>
</MetaDataObject>`;
}

function commonAttributeXml(name: string, ref: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" version="2.17">
  <CommonAttribute uuid="00000000-0000-0000-0000-000000000002">
    <Properties>
      <Name>${name}</Name>
      <Content><xr:Item><xr:Metadata>${ref}</xr:Metadata><xr:Use>Use</xr:Use><xr:ConditionalSeparation/></xr:Item></Content>
    </Properties>
  </CommonAttribute>
</MetaDataObject>`;
}

async function writeCompositionFixture(configPath: string, filePath: string, content: string): Promise<void> {
  await fsp.mkdir(configPath, { recursive: true });
  await fsp.writeFile(path.join(configPath, 'Configuration.xml'), '<Configuration/>', 'utf-8');
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, content, 'utf-8');
}

suite('CompositionEditorProvider — session fences (#250)', () => {
  test('queued save A writes only A across configuration roots and reconciles A without publishing into B', async () => {
    const tempRoot = await createTempDir('composition-session-roots-');
    const configA = path.join(tempRoot, 'configuration A');
    const configB = path.join(tempRoot, 'configuration B');
    const fileA = path.join(configA, 'Subsystems', 'A.xml');
    const fileB = path.join(configB, 'Subsystems', 'B.xml');
    const beforeB = Buffer.from(subsystemXml('B'), 'utf8');
    const enteredA = compositionDeferred<void>();
    const releaseA = compositionDeferred<void>();
    const mutationResources: string[] = [];
    const invalidated: string[] = [];
    let loaded = 0;
    const gateway = configureConfigurationMutationGateway(async (resourcePath, _kind, operation) => {
      mutationResources.push(path.resolve(resourcePath));
      if (path.resolve(resourcePath) === path.resolve(fileA)) {
        enteredA.resolve();
        await releaseA.promise;
      }
      return operation();
    }, async (_resourcePath, plan) => plan.result);
    const panels = patchCompositionPanelFactory();
    const provider = new CompositionEditorProvider(
      createCompositionContext(),
      {
        invalidateTreeCacheOnly: async (configPath) => { invalidated.push(path.resolve(configPath)); },
        loadMetadataTree: async () => { loaded++; },
      },
      SubsystemStrategy,
    );

    try {
      await writeCompositionFixture(configA, fileA, subsystemXml('A'));
      await writeCompositionFixture(configB, fileB, beforeB.toString('utf8'));
      const tree = createCompositionTreeProvider([]);
      await provider.show(createCompositionNode(fileA, 'A'), tree, configA);
      await provider.handleMessage({ command: 'toggle', data: { ref: 'Catalog.Users', checked: true } });
      await provider.handleMessage({ command: 'toggle', data: { ref: 'Catalog.Bad&Name', checked: true } });

      const saveA = provider.handleSave();
      await enteredA.promise;
      await provider.show(createCompositionNode(fileB, 'B'), tree, configB);
      releaseA.resolve();
      await saveA;

      const afterA = await fsp.readFile(fileA);
      const afterB = await fsp.readFile(fileB);
      assert.ok(afterA.toString('utf8').includes('Catalog.Users'), 'the captured A target must be changed');
      assert.ok(!afterA.toString('utf8').includes('Bad&Name'), 'escaped invalid reference must not corrupt A XML');
      assert.deepStrictEqual(afterB, beforeB, 'B must remain byte-identical while A is queued');
      assert.deepStrictEqual(mutationResources, [path.resolve(fileA)], 'the mutation gateway must never enter B');
      assert.deepStrictEqual(invalidated, [path.resolve(configA)], 'reconciliation must use captured config A');
      assert.strictEqual(loaded, 1, 'the captured A metadata tree must be reloaded');
      assert.strictEqual(panels.panels.length, 1, 'show B should reuse the active panel');
      assert.strictEqual(panels.panels[0].disposed(), false, 'completion of save A must not close panel B');
      assert.ok(
        !panels.panels[0].posted.some((message) => message.command === 'saveSuccess' || message.command === 'saveError'),
        'success or rejected-reference result from save A must not publish into panel B',
      );
    } finally {
      releaseA.resolve();
      gateway.dispose();
      provider.dispose();
      panels.restore();
      await cleanupTempDir(tempRoot);
    }
  });

  test('reverse read completion leaves the last requested show active and suppresses stale open errors', async () => {
    const tempRoot = await createTempDir('composition-show-order-');
    const fileA = path.join(tempRoot, 'A.xml');
    const fileB = path.join(tempRoot, 'B.xml');
    const readA = compositionDeferred<{ refs: string[]; itemSettings: Map<string, Record<string, string>> }>();
    const readB = compositionDeferred<{ refs: string[]; itemSettings: Map<string, Record<string, string>> }>();
    const panels = patchCompositionPanelFactory();
    const strategy = {
      ...SubsystemStrategy,
      readContent: (filePath: string) => filePath === fileA ? readA.promise : readB.promise,
    };
    const provider = new CompositionEditorProvider(
      createCompositionContext(),
      { invalidateTreeCacheOnly: async () => {}, loadMetadataTree: async () => {} },
      strategy,
    );

    try {
      const tree = createCompositionTreeProvider([]);
      const showA = provider.show(createCompositionNode(fileA, 'A'), tree, tempRoot);
      const showB = provider.show(createCompositionNode(fileB, 'B'), tree, tempRoot);
      readB.resolve({ refs: ['Document.B'], itemSettings: new Map() });
      await showB;
      readA.reject(new Error('stale A read failed'));
      await showA;

      assert.strictEqual((provider as any).contentFilePath, fileB);
      assert.strictEqual((provider as any).node.name, 'B');
      assert.ok(panels.panels[0].panel.title.includes('B'), 'the active panel title must remain B');
      assert.ok(panels.panels[0].panel.webview.html.includes('Document.B'), 'the active HTML must contain B data');
      assert.ok(!panels.panels[0].panel.webview.html.includes('A read failed'), 'stale A failure must not replace B');
    } finally {
      readA.reject(new Error('cleanup A read'));
      readB.resolve({ refs: [], itemSettings: new Map() });
      provider.dispose();
      panels.restore();
      await cleanupTempDir(tempRoot);
    }
  });

  test('queued settings diff keeps its captured refs and values after switching targets', async () => {
    const tempRoot = await createTempDir('composition-settings-snapshot-');
    const configA = path.join(tempRoot, 'configuration A');
    const configB = path.join(tempRoot, 'configuration B');
    const fileA = path.join(configA, 'CommonAttributes', 'A.xml');
    const fileB = path.join(configB, 'CommonAttributes', 'B.xml');
    const beforeB = Buffer.from(commonAttributeXml('B', 'Document.Keep'), 'utf8');
    const enteredA = compositionDeferred<void>();
    const releaseA = compositionDeferred<void>();
    const invalidated: string[] = [];
    const gateway = configureConfigurationMutationGateway(async (resourcePath, kind, operation) => {
      if (kind === 'ui.composition.save' && path.resolve(resourcePath) === path.resolve(fileA)) {
        enteredA.resolve();
        await releaseA.promise;
      }
      return operation();
    }, async (_resourcePath, plan) => plan.result);
    const panels = patchCompositionPanelFactory();
    const provider = new CompositionEditorProvider(
      createCompositionContext(),
      {
        invalidateTreeCacheOnly: async (root) => { invalidated.push(path.resolve(root)); },
        loadMetadataTree: async () => {},
      },
      CommonAttributeStrategy,
    );

    try {
      await writeCompositionFixture(configA, fileA, commonAttributeXml('A', 'Catalog.Old'));
      await writeCompositionFixture(configB, fileB, beforeB.toString('utf8'));
      const tree = createCompositionTreeProvider([]);
      await provider.show(createCompositionNode(fileA, 'A', MetadataType.CommonAttribute), tree, configA);
      await provider.handleMessage({ command: 'toggle', data: { ref: 'Document.New', checked: true } });
      await provider.handleMessage({ command: 'settingChange', data: { ref: 'Catalog.Old', key: 'Use', value: 'DontUse' } });
      const saveA = provider.handleSave();
      await enteredA.promise;
      await provider.show(createCompositionNode(fileB, 'B', MetadataType.CommonAttribute), tree, configB);
      releaseA.resolve();
      await saveA;

      const savedA = await fsp.readFile(fileA, 'utf8');
      assert.ok(savedA.includes('Document.New'), 'the captured add must be written to A');
      assert.ok(savedA.includes('Catalog.Old'), 'the captured existing ref must remain in A');
      assert.ok(savedA.includes('DontUse'), 'the captured setting value must be written to A');
      assert.deepStrictEqual(await fsp.readFile(fileB), beforeB, 'switching must preserve B byte-for-byte');
      assert.deepStrictEqual(invalidated, [path.resolve(configA)]);
      assert.ok(!panels.panels[0].posted.some((message) => message.command === 'saveSuccess' || message.command === 'saveError'));
      assert.strictEqual(panels.panels[0].disposed(), false);
    } finally {
      releaseA.resolve();
      gateway.dispose();
      provider.dispose();
      panels.restore();
      await cleanupTempDir(tempRoot);
    }
  });

  test('messages from the previous show are not admitted while the last requested target is still loading', async () => {
    const tempRoot = await createTempDir('composition-pending-show-');
    const configA = path.join(tempRoot, 'configuration A');
    const configB = path.join(tempRoot, 'configuration B');
    const fileA = path.join(configA, 'Subsystems', 'A.xml');
    const fileB = path.join(configB, 'Subsystems', 'B.xml');
    const beforeA = Buffer.from(subsystemXml('A'), 'utf8');
    const pendingReadB = compositionDeferred<{ refs: string[]; itemSettings: Map<string, Record<string, string>> }>();
    const originalReadContent = SubsystemStrategy.readContent;
    const strategy = {
      ...SubsystemStrategy,
      readContent: (filePath: string) => filePath === fileB
        ? pendingReadB.promise
        : originalReadContent(filePath),
    };
    const gateway = configureConfigurationMutationGateway(async (_resourcePath, _kind, operation) => operation());
    const panels = patchCompositionPanelFactory();
    const provider = new CompositionEditorProvider(
      createCompositionContext(),
      { invalidateTreeCacheOnly: async () => {}, loadMetadataTree: async () => {} },
      strategy,
    );
    let showB: Promise<void> | undefined;

    try {
      await writeCompositionFixture(configA, fileA, beforeA.toString('utf8'));
      await writeCompositionFixture(configB, fileB, subsystemXml('B'));
      const tree = createCompositionTreeProvider([]);
      await provider.show(createCompositionNode(fileA, 'A'), tree, configA);
      showB = provider.show(createCompositionNode(fileB, 'B'), tree, configB);

      await provider.handleMessage({ command: 'toggle', data: { ref: 'Catalog.StaleFromA', checked: true } });
      await provider.handleMessage({ command: 'save' });
      assert.deepStrictEqual(await fsp.readFile(fileA), beforeA, 'old HTML must not save A as if B were ready');
      assert.deepStrictEqual(await fsp.readFile(fileB), Buffer.from(subsystemXml('B'), 'utf8'));

      pendingReadB.resolve({ refs: [], itemSettings: new Map() });
      await showB;
      await provider.handleMessage({ command: 'toggle', data: { ref: 'Document.Current', checked: true } });
      await provider.handleMessage({ command: 'save' });
      assert.ok((await fsp.readFile(fileB, 'utf8')).includes('Document.Current'), 'the loaded B session must accept its own messages');
      assert.ok(!(await fsp.readFile(fileB, 'utf8')).includes('Catalog.StaleFromA'), 'A edits made during loading must be discarded after B publishes');
      assert.deepStrictEqual(await fsp.readFile(fileA), beforeA, 'B save must not change the previous target');
    } finally {
      pendingReadB.resolve({ refs: [], itemSettings: new Map() });
      await showB;
      gateway.dispose();
      provider.dispose();
      panels.restore();
      await cleanupTempDir(tempRoot);
    }
  });

  test('failed show restores A with dirty settings and keeps a stale committed save from closing it', async () => {
    const tempRoot = await createTempDir('composition-failed-show-recovery-');
    const configA = path.join(tempRoot, 'configuration A');
    const configB = path.join(tempRoot, 'configuration B');
    const fileA = path.join(configA, 'CommonAttributes', 'A.xml');
    const fileB = path.join(configB, 'CommonAttributes', 'B.xml');
    const pendingReadB = compositionDeferred<{ refs: string[]; itemSettings: Map<string, Record<string, string>> }>();
    const enteredSaveA = compositionDeferred<void>();
    const releaseSaveA = compositionDeferred<void>();
    const originalReadContent = CommonAttributeStrategy.readContent;
    const strategy = {
      ...CommonAttributeStrategy,
      readContent: (filePath: string) => filePath === fileB
        ? pendingReadB.promise
        : originalReadContent(filePath),
    };
    const gateway = configureConfigurationMutationGateway(async (resourcePath, kind, operation) => {
      if (kind === 'ui.composition.save' && path.resolve(resourcePath) === path.resolve(fileA)) {
        enteredSaveA.resolve();
        await releaseSaveA.promise;
      }
      return operation();
    });
    const panels = patchCompositionPanelFactory();
    const provider = new CompositionEditorProvider(
      createCompositionContext(),
      { invalidateTreeCacheOnly: async () => {}, loadMetadataTree: async () => {} },
      strategy,
    );
    let saveA: Promise<void> | undefined;
    let showB: Promise<void> | undefined;

    try {
      await writeCompositionFixture(configA, fileA, commonAttributeXml('A', 'Catalog.Old'));
      await writeCompositionFixture(configB, fileB, commonAttributeXml('B', 'Catalog.B'));
      const tree = createCompositionTreeProvider([]);
      await provider.show(createCompositionNode(fileA, 'A', MetadataType.CommonAttribute), tree, configA);
      await panels.panels[0].dispatch({ command: 'toggle', data: { ref: 'Document.New', checked: true } });
      await panels.panels[0].dispatch({ command: 'settingChange', data: { ref: 'Catalog.Old', key: 'Use', value: 'DontUse' } });
      saveA = provider.handleSave();
      await enteredSaveA.promise;

      showB = provider.show(createCompositionNode(fileB, 'B', MetadataType.CommonAttribute), tree, configB);
      pendingReadB.reject(new Error('B read failed'));
      await showB;
      assert.strictEqual((provider as any).contentFilePath, fileA, 'the last fully published target must remain available');
      assert.strictEqual(provider.getDirtyCount(), 2, 'failed show must preserve A refs and setting changes');
      assert.ok(panels.panels[0].panel.title.includes('A'));

      releaseSaveA.resolve();
      await saveA;
      const savedA = await fsp.readFile(fileA, 'utf8');
      assert.ok(savedA.includes('Document.New'), 'the already accepted A save must finish against its captured target');
      assert.ok(savedA.includes('DontUse'), 'the accepted settings snapshot must finish against A');
      assert.strictEqual(panels.panels[0].disposed(), false, 'a stale A completion must not close the recovered panel');
      assert.ok(!panels.panels[0].posted.some((message) => message.command === 'saveSuccess' || message.command === 'saveError'));

      await panels.panels[0].dispatch({ command: 'cancel' });
      assert.strictEqual(panels.panels[0].disposed(), true, 'cancel from the recovered A session must still work');
    } finally {
      releaseSaveA.resolve();
      pendingReadB.reject(new Error('cleanup B read'));
      await Promise.allSettled([saveA, showB].filter((pending): pending is Promise<void> => !!pending));
      gateway.dispose();
      provider.dispose();
      panels.restore();
      await cleanupTempDir(tempRoot);
    }
  });

  test('read failure preserves the live dirty webview without reassigning initialization HTML', async () => {
    const tempRoot = await createTempDir('composition-live-ui-recovery-');
    const configA = path.join(tempRoot, 'configuration A');
    const fileA = path.join(configA, 'CommonAttributes', 'A.xml');
    const fileB = path.join(tempRoot, 'configuration B', 'CommonAttributes', 'B.xml');
    const pendingReadB = compositionDeferred<{ refs: string[]; itemSettings: Map<string, Record<string, string>> }>();
    const originalReadContent = CommonAttributeStrategy.readContent;
    const strategy = {
      ...CommonAttributeStrategy,
      readContent: (filePath: string) => filePath === fileB
        ? pendingReadB.promise
        : originalReadContent(filePath),
    };
    const panels = patchCompositionPanelFactory();
    const provider = new CompositionEditorProvider(
      createCompositionContext(),
      { invalidateTreeCacheOnly: async () => {}, loadMetadataTree: async () => {} },
      strategy,
    );
    let showB: Promise<void> | undefined;

    try {
      await writeCompositionFixture(configA, fileA, commonAttributeXml('A', 'Catalog.Old'));
      const tree = createCompositionTreeProvider([]);
      await provider.show(createCompositionNode(fileA, 'A', MetadataType.CommonAttribute), tree, configA);
      await panels.panels[0].dispatch({ command: 'toggle', data: { ref: 'Document.Dirty', checked: true } });
      await panels.panels[0].dispatch({ command: 'settingChange', data: { ref: 'Catalog.Old', key: 'Use', value: 'DontUse' } });
      const dirtyUiBeforeFailure = panels.panels[0].liveState();
      const htmlAssignmentsBeforeFailure = panels.panels[0].htmlAssignmentCount();

      showB = provider.show(createCompositionNode(fileB, 'B', MetadataType.CommonAttribute), tree, path.dirname(path.dirname(fileB)));
      pendingReadB.reject(new Error('B read failed before publication'));
      await showB;

      assert.strictEqual(panels.panels[0].htmlAssignmentCount(), htmlAssignmentsBeforeFailure, 'recovery must not reload the initialization HTML');
      assert.deepStrictEqual(panels.panels[0].liveState(), dirtyUiBeforeFailure, 'the displayed checkbox and settings state must stay dirty');
      assert.strictEqual(provider.getDirtyCount(), 2, 'the provider model must agree with the displayed dirty state');
    } finally {
      pendingReadB.reject(new Error('cleanup B read'));
      await showB;
      provider.dispose();
      panels.restore();
      await cleanupTempDir(tempRoot);
    }
  });

  test('edits made in A while B loads are saved to A only if B fails', async () => {
    const tempRoot = await createTempDir('composition-pending-edit-recovery-');
    const configA = path.join(tempRoot, 'configuration A');
    const configB = path.join(tempRoot, 'configuration B');
    const fileA = path.join(configA, 'CommonAttributes', 'A.xml');
    const fileB = path.join(configB, 'CommonAttributes', 'B.xml');
    const beforeA = Buffer.from(commonAttributeXml('A', 'Catalog.Old'), 'utf8');
    const pendingReadB = compositionDeferred<{ refs: string[]; itemSettings: Map<string, Record<string, string>> }>();
    const originalReadContent = CommonAttributeStrategy.readContent;
    const strategy = {
      ...CommonAttributeStrategy,
      readContent: (filePath: string) => filePath === fileB
        ? pendingReadB.promise
        : originalReadContent(filePath),
    };
    const gateway = configureConfigurationMutationGateway(async (_resourcePath, _kind, operation) => operation());
    const panels = patchCompositionPanelFactory();
    const provider = new CompositionEditorProvider(
      createCompositionContext(),
      { invalidateTreeCacheOnly: async () => {}, loadMetadataTree: async () => {} },
      strategy,
    );
    let showB: Promise<void> | undefined;

    try {
      await writeCompositionFixture(configA, fileA, beforeA.toString('utf8'));
      await writeCompositionFixture(configB, fileB, commonAttributeXml('B', 'Catalog.B'));
      const tree = createCompositionTreeProvider([]);
      await provider.show(createCompositionNode(fileA, 'A', MetadataType.CommonAttribute), tree, configA);
      showB = provider.show(createCompositionNode(fileB, 'B', MetadataType.CommonAttribute), tree, configB);
      await panels.panels[0].dispatch({ command: 'toggle', data: { ref: 'Document.DuringLoad', checked: true } });
      await panels.panels[0].dispatch({ command: 'settingChange', data: { ref: 'Catalog.Old', key: 'Use', value: 'DontUse' } });
      await panels.panels[0].dispatch({ command: 'selectAll', data: { refs: ['Document.TemporaryDuringLoad'] } });
      assert.ok(panels.panels[0].liveState()?.checkedRefs.includes('Document.TemporaryDuringLoad'));
      await panels.panels[0].dispatch({ command: 'deselectAll', data: { refs: ['Document.TemporaryDuringLoad'] } });
      assert.ok(!panels.panels[0].liveState()?.checkedRefs.includes('Document.TemporaryDuringLoad'));
      const dirtyUi = panels.panels[0].liveState();
      await panels.panels[0].dispatch({ command: 'save' });
      assert.deepStrictEqual(await fsp.readFile(fileA), beforeA, 'save must remain blocked while B is loading');

      pendingReadB.reject(new Error('B read failed after A edits'));
      await showB;
      assert.strictEqual(provider.getDirtyCount(), 2, 'recovery must include edits made while B loaded');
      assert.deepStrictEqual(panels.panels[0].liveState(), dirtyUi, 'the restored model must match the still-visible A webview');
      await panels.panels[0].dispatch({ command: 'save' });

      const savedA = await fsp.readFile(fileA, 'utf8');
      assert.ok(savedA.includes('Document.DuringLoad'), 'the edit received during pending B must be saved to A after B fails');
      assert.ok(savedA.includes('DontUse'), 'the setting received during pending B must be saved to A after B fails');
      assert.deepStrictEqual(await fsp.readFile(fileB), Buffer.from(commonAttributeXml('B', 'Catalog.B'), 'utf8'));
    } finally {
      pendingReadB.reject(new Error('cleanup B read'));
      await showB;
      gateway.dispose();
      provider.dispose();
      panels.restore();
      await cleanupTempDir(tempRoot);
    }
  });

  test('failure in the latest show of a B-to-C chain restores A and admits a save after late B settles', async () => {
    const tempRoot = await createTempDir('composition-show-chain-recovery-');
    const configA = path.join(tempRoot, 'configuration A');
    const configB = path.join(tempRoot, 'configuration B');
    const configC = path.join(tempRoot, 'configuration C');
    const fileA = path.join(configA, 'Subsystems', 'A.xml');
    const fileB = path.join(configB, 'Subsystems', 'B.xml');
    const fileC = path.join(configC, 'Subsystems', 'C.xml');
    const beforeB = Buffer.from(subsystemXml('B'), 'utf8');
    const beforeC = Buffer.from(subsystemXml('C'), 'utf8');
    const pendingReadB = compositionDeferred<{ refs: string[]; itemSettings: Map<string, Record<string, string>> }>();
    const pendingReadC = compositionDeferred<{ refs: string[]; itemSettings: Map<string, Record<string, string>> }>();
    const originalReadContent = SubsystemStrategy.readContent;
    const strategy = {
      ...SubsystemStrategy,
      readContent: (filePath: string) => filePath === fileB
        ? pendingReadB.promise
        : filePath === fileC
          ? pendingReadC.promise
          : originalReadContent(filePath),
    };
    const gateway = configureConfigurationMutationGateway(async (_resourcePath, _kind, operation) => operation());
    const panels = patchCompositionPanelFactory();
    const provider = new CompositionEditorProvider(
      createCompositionContext(),
      { invalidateTreeCacheOnly: async () => {}, loadMetadataTree: async () => {} },
      strategy,
    );
    let showB: Promise<void> | undefined;
    let showC: Promise<void> | undefined;

    try {
      await writeCompositionFixture(configA, fileA, subsystemXml('A'));
      await writeCompositionFixture(configB, fileB, beforeB.toString('utf8'));
      await writeCompositionFixture(configC, fileC, beforeC.toString('utf8'));
      const tree = createCompositionTreeProvider([]);
      await provider.show(createCompositionNode(fileA, 'A'), tree, configA);
      showB = provider.show(createCompositionNode(fileB, 'B'), tree, configB);
      showC = provider.show(createCompositionNode(fileC, 'C'), tree, configC);
      pendingReadC.reject(new Error('latest C read failed'));
      await showC;
      pendingReadB.resolve({ refs: ['Catalog.StaleB'], itemSettings: new Map() });
      await showB;

      assert.strictEqual((provider as any).contentFilePath, fileA, 'latest failed C must restore the last fully published A');
      assert.strictEqual((provider as any).node.name, 'A');
      assert.strictEqual(panels.panels[0].panel.title, 'Состав подсистемы: A');
      await panels.panels[0].dispatch({ command: 'toggle', data: { ref: 'Catalog.Recovered', checked: true } });
      await panels.panels[0].dispatch({ command: 'save' });

      assert.ok((await fsp.readFile(fileA, 'utf8')).includes('Catalog.Recovered'), 'the restored A model must accept a save');
      assert.deepStrictEqual(await fsp.readFile(fileB), beforeB, 'late B completion must not save or replace A');
      assert.deepStrictEqual(await fsp.readFile(fileC), beforeC);
      assert.ok(panels.panels[0].posted.some((message) => message.command === 'saveSuccess'));
      assert.strictEqual(panels.panels[0].disposed(), true);
    } finally {
      pendingReadB.resolve({ refs: [], itemSettings: new Map() });
      pendingReadC.reject(new Error('cleanup C read'));
      await Promise.allSettled([showB, showC].filter((pending): pending is Promise<void> => !!pending));
      gateway.dispose();
      provider.dispose();
      panels.restore();
      await cleanupTempDir(tempRoot);
    }
  });

  test('a show with no content path restores A and keeps its message handler active', async () => {
    const tempRoot = await createTempDir('composition-invalid-show-recovery-');
    const configA = path.join(tempRoot, 'configuration A');
    const fileA = path.join(configA, 'Subsystems', 'A.xml');
    const originalGetContentFilePath = SubsystemStrategy.getContentFilePath;
    const strategy = {
      ...SubsystemStrategy,
      getContentFilePath: (node: TreeNode) => node.name === 'Missing'
        ? ''
        : originalGetContentFilePath(node),
    };
    const gateway = configureConfigurationMutationGateway(async (_resourcePath, _kind, operation) => operation());
    const panels = patchCompositionPanelFactory();
    const provider = new CompositionEditorProvider(
      createCompositionContext(),
      { invalidateTreeCacheOnly: async () => {}, loadMetadataTree: async () => {} },
      strategy,
    );

    try {
      await writeCompositionFixture(configA, fileA, subsystemXml('A'));
      const tree = createCompositionTreeProvider([]);
      await provider.show(createCompositionNode(fileA, 'A'), tree, configA);
      await provider.show(createCompositionNode(path.join(configA, 'Missing.xml'), 'Missing'), tree, configA);
      await panels.panels[0].dispatch({ command: 'toggle', data: { ref: 'Catalog.AfterInvalidShow', checked: true } });
      await panels.panels[0].dispatch({ command: 'save' });

      assert.ok((await fsp.readFile(fileA, 'utf8')).includes('Catalog.AfterInvalidShow'));
      assert.ok(panels.panels[0].posted.some((message) => message.command === 'saveSuccess'));
      assert.strictEqual(panels.panels[0].disposed(), true);
    } finally {
      gateway.dispose();
      provider.dispose();
      panels.restore();
      await cleanupTempDir(tempRoot);
    }
  });

  test('committed mixed valid and escaped rejected references reconcile before reporting saveError', async () => {
    const tempRoot = await createTempDir('composition-mixed-rejected-');
    const configPath = path.join(tempRoot, 'configuration');
    const filePath = path.join(configPath, 'CommonAttributes', 'Department.xml');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" version="2.17">
  <CommonAttribute uuid="00000000-0000-0000-0000-000000000002">
    <Properties><Name>Department</Name><Content/></Properties>
  </CommonAttribute>
</MetaDataObject>`;
    const invalidated: string[] = [];
    let loaded = 0;
    let writeAttempts = 0;
    const strategy = {
      ...CommonAttributeStrategy,
      applyUpdate: async (targetPath: string, diff: Parameters<typeof CommonAttributeStrategy.applyUpdate>[1]) => {
        writeAttempts++;
        return CommonAttributeStrategy.applyUpdate(targetPath, diff);
      },
    };
    const gateway = configureConfigurationMutationGateway(async (_resourcePath, _kind, operation) => operation());
    const panels = patchCompositionPanelFactory();
    const provider = new CompositionEditorProvider(
      createCompositionContext(),
      {
        invalidateTreeCacheOnly: async (root) => { invalidated.push(path.resolve(root)); },
        loadMetadataTree: async () => { loaded++; },
      },
      strategy,
    );

    try {
      await writeCompositionFixture(configPath, filePath, xml);
      await provider.show(createCompositionNode(filePath, 'Department', MetadataType.CommonAttribute), createCompositionTreeProvider([]), configPath);
      await provider.handleMessage({ command: 'toggle', data: { ref: 'Document.New', checked: true } });
      await provider.handleMessage({ command: 'toggle', data: { ref: 'Catalog.Bad&Name', checked: true } });
      await provider.handleMessage({ command: 'settingChange', data: { ref: 'Document.New', key: 'Use', value: 'DontUse' } });
      await provider.handleSave();

      const written = await fsp.readFile(filePath, 'utf8');
      assert.ok(written.includes('Document.New'), 'valid reference must be committed with rejected references');
      assert.ok(written.includes('DontUse'), 'settings changes must be included in the committed diff');
      assert.ok(!written.includes('Bad&Name'), 'rejected reference must not become malformed XML');
      assert.deepStrictEqual(invalidated, [path.resolve(configPath)], 'committed mixed write must invalidate its root');
      assert.strictEqual(loaded, 1, 'committed mixed write must reload its root');
      assert.ok(panels.panels[0].posted.some((message) => message.command === 'saveError' && message.data.message.includes('Bad&Name')));
      assert.ok(!panels.panels[0].posted.some((message) => message.command === 'saveSuccess'));
      assert.strictEqual(panels.panels[0].disposed(), false, 'rejected references must leave the editor open');

      await provider.handleMessage({ command: 'toggle', data: { ref: 'Catalog.Bad&Name', checked: false } });
      await provider.handleSave();
      assert.strictEqual(writeAttempts, 2, 'a rejected save must allow a corrected retry');
      assert.ok(panels.panels[0].posted.some((message) => message.command === 'saveSuccess'));
      assert.strictEqual(panels.panels[0].disposed(), true, 'the corrected retry should close the editor');
    } finally {
      gateway.dispose();
      provider.dispose();
      panels.restore();
      await cleanupTempDir(tempRoot);
    }
  });

  test('writer failure from A after switching to B is not published or reconciled into B', async () => {
    const tempRoot = await createTempDir('composition-stale-writer-error-');
    const configA = path.join(tempRoot, 'configuration A');
    const configB = path.join(tempRoot, 'configuration B');
    const fileA = path.join(configA, 'Subsystems', 'A.xml');
    const fileB = path.join(configB, 'Subsystems', 'B.xml');
    const beforeA = Buffer.from(subsystemXml('A'), 'utf8');
    const beforeB = Buffer.from(subsystemXml('B'), 'utf8');
    const enteredWrite = compositionDeferred<string>();
    const releaseWrite = compositionDeferred<void>();
    const invalidated: string[] = [];
    let loadCount = 0;
    const strategy = {
      ...SubsystemStrategy,
      applyUpdate: async (targetPath: string) => {
        enteredWrite.resolve(path.resolve(targetPath));
        await releaseWrite.promise;
        throw new Error('A write failed');
      },
    };
    const gateway = configureConfigurationMutationGateway(async (_resourcePath, _kind, operation) => operation());
    const panels = patchCompositionPanelFactory();
    const provider = new CompositionEditorProvider(
      createCompositionContext(),
      {
        invalidateTreeCacheOnly: async (root) => { invalidated.push(path.resolve(root)); },
        loadMetadataTree: async () => { loadCount++; },
      },
      strategy,
    );
    let saveA: Promise<void> | undefined;

    try {
      await writeCompositionFixture(configA, fileA, beforeA.toString('utf8'));
      await writeCompositionFixture(configB, fileB, beforeB.toString('utf8'));
      const tree = createCompositionTreeProvider([]);
      await provider.show(createCompositionNode(fileA, 'A'), tree, configA);
      await provider.handleMessage({ command: 'toggle', data: { ref: 'Catalog.A', checked: true } });
      saveA = provider.handleSave();
      assert.strictEqual(await enteredWrite.promise, path.resolve(fileA));
      await provider.show(createCompositionNode(fileB, 'B'), tree, configB);
      releaseWrite.resolve();
      await saveA;

      assert.deepStrictEqual(await fsp.readFile(fileA), beforeA);
      assert.deepStrictEqual(await fsp.readFile(fileB), beforeB);
      assert.deepStrictEqual(invalidated, [], 'a writer failure must not reconcile either root');
      assert.strictEqual(loadCount, 0);
      assert.ok(!panels.panels[0].posted.some((message) => message.command === 'saveError' || message.command === 'saveSuccess'));
      assert.strictEqual(panels.panels[0].disposed(), false, 'A writer failure must not close B');
    } finally {
      releaseWrite.resolve();
      await saveA;
      gateway.dispose();
      provider.dispose();
      panels.restore();
      await cleanupTempDir(tempRoot);
    }
  });

  test('refresh failure after a committed write warns separately and does not report save failure', async () => {
    const tempRoot = await createTempDir('composition-refresh-failure-');
    const configPath = path.join(tempRoot, 'configuration');
    const filePath = path.join(configPath, 'Subsystems', 'A.xml');
    const warnings: string[] = [];
    const window = vscode.window as any;
    const originalWarning = window.showWarningMessage;
    window.showWarningMessage = async (message: string) => { warnings.push(message); };
    const gateway = configureConfigurationMutationGateway(async (_resourcePath, _kind, operation) => operation());
    const panels = patchCompositionPanelFactory();
    const provider = new CompositionEditorProvider(
      createCompositionContext(),
      {
        invalidateTreeCacheOnly: async () => { throw new Error('tree cache unavailable'); },
        loadMetadataTree: async () => {},
      },
      SubsystemStrategy,
    );

    try {
      await writeCompositionFixture(configPath, filePath, subsystemXml('A'));
      await provider.show(createCompositionNode(filePath, 'A'), createCompositionTreeProvider([]), configPath);
      await provider.handleMessage({ command: 'toggle', data: { ref: 'Catalog.Users', checked: true } });
      await provider.handleSave();

      assert.ok((await fsp.readFile(filePath, 'utf8')).includes('Catalog.Users'), 'the XML write must remain committed');
      assert.ok(warnings.some((message) => message.includes('обновить дерево')), 'refresh failure needs a Russian warning');
      assert.ok(panels.panels[0].posted.some((message) => message.command === 'saveSuccess'));
      assert.ok(!panels.panels[0].posted.some((message) => message.command === 'saveError'));
      assert.strictEqual(panels.panels[0].disposed(), true, 'a committed save still closes its current panel');
    } finally {
      window.showWarningMessage = originalWarning;
      gateway.dispose();
      provider.dispose();
      panels.restore();
      await cleanupTempDir(tempRoot);
    }
  });

  test('writer failure reports saveError without reconciliation or XML changes', async () => {
    const tempRoot = await createTempDir('composition-writer-failure-');
    const configPath = path.join(tempRoot, 'configuration');
    const filePath = path.join(configPath, 'Subsystems', 'A.xml');
    const originalXml = Buffer.from(subsystemXml('A'), 'utf8');
    const invalidated: string[] = [];
    let loaded = 0;
    const strategy = {
      ...SubsystemStrategy,
      applyUpdate: async () => { throw new Error('write refused'); },
    };
    const gateway = configureConfigurationMutationGateway(async (_resourcePath, _kind, operation) => operation());
    const panels = patchCompositionPanelFactory();
    const provider = new CompositionEditorProvider(
      createCompositionContext(),
      {
        invalidateTreeCacheOnly: async (root) => { invalidated.push(root); },
        loadMetadataTree: async () => { loaded++; },
      },
      strategy,
    );

    try {
      await writeCompositionFixture(configPath, filePath, originalXml.toString('utf8'));
      await provider.show(createCompositionNode(filePath, 'A'), createCompositionTreeProvider([]), configPath);
      await provider.handleMessage({ command: 'toggle', data: { ref: 'Catalog.Users', checked: true } });
      await provider.handleSave();

      assert.deepStrictEqual(await fsp.readFile(filePath), originalXml);
      assert.deepStrictEqual(invalidated, []);
      assert.strictEqual(loaded, 0);
      assert.ok(panels.panels[0].posted.some((message) => message.command === 'saveError'));
      assert.strictEqual(panels.panels[0].disposed(), false);
    } finally {
      gateway.dispose();
      provider.dispose();
      panels.restore();
      await cleanupTempDir(tempRoot);
    }
  });

  test('saves are owned per session and duplicate save cannot bypass a newer pending save', async () => {
    const tempRoot = await createTempDir('composition-save-ownership-');
    const configA = path.join(tempRoot, 'root A');
    const configB = path.join(tempRoot, 'root B');
    const fileA = path.join(configA, 'Subsystems', 'A.xml');
    const fileB = path.join(configB, 'Subsystems', 'B.xml');
    const enteredA = compositionDeferred<void>();
    const enteredB = compositionDeferred<void>();
    const releaseA = compositionDeferred<void>();
    const releaseB = compositionDeferred<void>();
    let startsA = 0;
    let startsB = 0;
    const gateway = configureConfigurationMutationGateway(async (resourcePath, kind, operation) => {
      if (kind === 'ui.composition.save' && path.resolve(resourcePath) === path.resolve(fileA)) {
        startsA++;
        enteredA.resolve();
        await releaseA.promise;
      } else if (kind === 'ui.composition.save' && path.resolve(resourcePath) === path.resolve(fileB)) {
        startsB++;
        enteredB.resolve();
        await releaseB.promise;
      }
      return operation();
    }, async (_resourcePath, plan) => plan.result);
    const panels = patchCompositionPanelFactory();
    const provider = new CompositionEditorProvider(
      createCompositionContext(),
      { invalidateTreeCacheOnly: async () => {}, loadMetadataTree: async () => {} },
      SubsystemStrategy,
    );
    let saveA: Promise<void> | undefined;
    let saveB: Promise<void> | undefined;

    try {
      await writeCompositionFixture(configA, fileA, subsystemXml('A'));
      await writeCompositionFixture(configB, fileB, subsystemXml('B'));
      const tree = createCompositionTreeProvider([]);
      await provider.show(createCompositionNode(fileA, 'A'), tree, configA);
      await provider.handleMessage({ command: 'toggle', data: { ref: 'Catalog.A', checked: true } });
      saveA = provider.handleSave();
      await enteredA.promise;

      await provider.show(createCompositionNode(fileB, 'B'), tree, configB);
      await provider.handleMessage({ command: 'toggle', data: { ref: 'Document.B', checked: true } });
      saveB = provider.handleSave();
      await Promise.resolve();
      const startedBBeforeACompleted = startsB === 1 && startsA === 1;

      if (startedBBeforeACompleted) {
        await enteredB.promise;
      }
      releaseA.resolve();
      await saveA;
      const messagesBeforeBCompletes = [...panels.panels[0].posted];
      let duplicateDidNotEnterGateway = false;
      if (startedBBeforeACompleted) {
        const duplicateSaveB = provider.handleSave();
        await duplicateSaveB;
        duplicateDidNotEnterGateway = startsB === 1;
        releaseB.resolve();
        await saveB;
      }
      assert.strictEqual(startedBBeforeACompleted, true, 'B must start while A remains pending');
      assert.strictEqual(duplicateDidNotEnterGateway, true, 'duplicate save B must be ignored while B owns busy state');
      assert.ok(!messagesBeforeBCompletes.some((message) => message.command === 'saveSuccess' || message.command === 'saveError'));
      assert.ok((await fsp.readFile(fileA, 'utf8')).includes('Catalog.A'));
      assert.ok((await fsp.readFile(fileB, 'utf8')).includes('Document.B'));
      assert.ok(panels.panels[0].posted.some((message) => message.command === 'saveSuccess'));
      assert.strictEqual(panels.panels[0].disposed(), true);
    } finally {
      releaseA.resolve();
      releaseB.resolve();
      await Promise.allSettled([saveA, saveB].filter((pending): pending is Promise<void> => !!pending));
      gateway.dispose();
      provider.dispose();
      panels.restore();
      await cleanupTempDir(tempRoot);
    }
  });

  test('expand and expandAll keep late results and loading ownership inside their original session', async () => {
    const tempRoot = await createTempDir('composition-expand-session-');
    const configA = path.join(tempRoot, 'configuration A');
    const configB = path.join(tempRoot, 'configuration B');
    const folderA = { id: 'Catalogs', name: 'Catalogs', type: MetadataType.Catalog, properties: {} } as TreeNode;
    const folderB = { id: 'Catalogs', name: 'Catalogs', type: MetadataType.Catalog, properties: {} } as TreeNode;
    const rootA = { id: 'rootA', name: 'A', type: MetadataType.Configuration, filePath: path.join(configA, 'Configuration.xml'), properties: {}, children: [folderA] } as TreeNode;
    const rootB = { id: 'rootB', name: 'B', type: MetadataType.Configuration, filePath: path.join(configB, 'Configuration.xml'), properties: {}, children: [folderB] } as TreeNode;
    const enteredA = compositionDeferred<void>();
    const enteredB = compositionDeferred<void>();
    const releaseA = compositionDeferred<void>();
    const releaseB = compositionDeferred<void>();
    let callsA = 0;
    let callsB = 0;
    const treeA = createCompositionTreeProvider([rootA], async () => {
      callsA++;
      enteredA.resolve();
      await releaseA.promise;
      folderA.children = [{ id: 'Catalog.A', name: 'A', type: MetadataType.Catalog, properties: {} } as TreeNode];
      return folderA.children;
    });
    const treeB = createCompositionTreeProvider([rootB], async () => {
      callsB++;
      enteredB.resolve();
      await releaseB.promise;
      folderB.children = [{ id: 'Catalog.B', name: 'B', type: MetadataType.Catalog, properties: {} } as TreeNode];
      return folderB.children;
    });
    const gateway = configureConfigurationMutationGateway(async (_resourcePath, _kind, operation) => operation());
    const panels = patchCompositionPanelFactory();
    const provider = new CompositionEditorProvider(
      createCompositionContext(),
      { invalidateTreeCacheOnly: async () => {}, loadMetadataTree: async () => {} },
      SubsystemStrategy,
    );
    let expansionA: Promise<void> | undefined;
    let expansionB: Promise<void> | undefined;

    try {
      const fileA = path.join(configA, 'Subsystems', 'A.xml');
      const fileB = path.join(configB, 'Subsystems', 'B.xml');
      await writeCompositionFixture(configA, fileA, subsystemXml('A'));
      await writeCompositionFixture(configB, fileB, subsystemXml('B'));
      await provider.show(createCompositionNode(fileA, 'A'), treeA, configA);
      expansionA = provider.handleMessage({ command: 'expand', data: { typeFolderId: 'Catalogs' } });
      await enteredA.promise;

      await provider.show(createCompositionNode(fileB, 'B'), treeB, configB);
      expansionB = provider.handleMessage({ command: 'expandAll' });
      await enteredB.promise;
      releaseA.resolve();
      await expansionA;
      const messagesAfterA = [...panels.panels[0].posted];
      const loadingOwnerBPreserved = (provider as any).loadingTypes.has('Catalogs');
      await provider.handleMessage({ command: 'expand', data: { typeFolderId: 'Catalogs' } });
      const duplicateBLoadWasSuppressed = callsB === 1;

      releaseB.resolve();
      await expansionB;
      assert.strictEqual(loadingOwnerBPreserved, true, 'A finally must not clear B loading ownership');
      assert.strictEqual(duplicateBLoadWasSuppressed, true, 'B loading must remain deduplicated after A settles');
      assert.ok(!messagesAfterA.some((message) => message.command === 'objectsLoaded' || message.command === 'allObjectsLoaded'));
      assert.ok(panels.panels[0].posted.some((message) => message.command === 'allObjectsLoaded' && message.data.containers.Catalogs[0].ref === 'Catalog.B'));
    } finally {
      releaseA.resolve();
      releaseB.resolve();
      await Promise.allSettled([expansionA, expansionB].filter((pending): pending is Promise<void> => !!pending));
      gateway.dispose();
      provider.dispose();
      panels.restore();
      await cleanupTempDir(tempRoot);
    }
  });

  test('dispose invalidates a pending show before it can create or republish a panel', async () => {
    const tempRoot = await createTempDir('composition-dispose-show-');
    const read = compositionDeferred<{ refs: string[]; itemSettings: Map<string, Record<string, string>> }>();
    const panels = patchCompositionPanelFactory();
    const strategy = { ...SubsystemStrategy, readContent: () => read.promise };
    const provider = new CompositionEditorProvider(
      createCompositionContext(),
      { invalidateTreeCacheOnly: async () => {}, loadMetadataTree: async () => {} },
      strategy,
    );
    let show: Promise<void> | undefined;

    try {
      show = provider.show(createCompositionNode(path.join(tempRoot, 'A.xml'), 'A'), createCompositionTreeProvider([]), tempRoot);
      provider.dispose();
      read.resolve({ refs: ['Catalog.A'], itemSettings: new Map() });
      await show;
      assert.strictEqual(panels.panels.length, 0, 'disposed provider must not create a panel for a late show');
      assert.strictEqual((provider as any).contentFilePath, undefined);
    } finally {
      read.resolve({ refs: [], itemSettings: new Map() });
      await show;
      provider.dispose();
      panels.restore();
      await cleanupTempDir(tempRoot);
    }
  });

  test('cancel from the visible A panel disposes it and invalidates the pending B show', async () => {
    const tempRoot = await createTempDir('composition-pending-cancel-');
    const configA = path.join(tempRoot, 'configuration A');
    const configB = path.join(tempRoot, 'configuration B');
    const fileA = path.join(configA, 'Subsystems', 'A.xml');
    const fileB = path.join(configB, 'Subsystems', 'B.xml');
    const pendingReadB = compositionDeferred<{ refs: string[]; itemSettings: Map<string, Record<string, string>> }>();
    const originalReadContent = SubsystemStrategy.readContent;
    const strategy = {
      ...SubsystemStrategy,
      readContent: (filePath: string) => filePath === fileB
        ? pendingReadB.promise
        : originalReadContent(filePath),
    };
    const panels = patchCompositionPanelFactory();
    const provider = new CompositionEditorProvider(
      createCompositionContext(),
      { invalidateTreeCacheOnly: async () => {}, loadMetadataTree: async () => {} },
      strategy,
    );
    let showB: Promise<void> | undefined;

    try {
      await writeCompositionFixture(configA, fileA, subsystemXml('A'));
      await writeCompositionFixture(configB, fileB, subsystemXml('B'));
      const tree = createCompositionTreeProvider([]);
      await provider.show(createCompositionNode(fileA, 'A'), tree, configA);
      showB = provider.show(createCompositionNode(fileB, 'B'), tree, configB);
      await panels.panels[0].dispatch({ command: 'cancel' });
      assert.strictEqual(panels.panels[0].disposed(), true, 'cancel must dispose the visible A panel immediately');

      pendingReadB.resolve({ refs: ['Catalog.B'], itemSettings: new Map() });
      await showB;
      assert.strictEqual(panels.panels.length, 1, 'the invalidated show must not resurrect a panel');
      assert.strictEqual((provider as any).contentFilePath, undefined);
    } finally {
      pendingReadB.resolve({ refs: [], itemSettings: new Map() });
      await showB;
      provider.dispose();
      panels.restore();
      await cleanupTempDir(tempRoot);
    }
  });

  test('a disposed panel callback cannot mutate the reopened panel session', async () => {
    const tempRoot = await createTempDir('composition-dispose-reopen-');
    const configA = path.join(tempRoot, 'configuration A');
    const configB = path.join(tempRoot, 'configuration B');
    const fileA = path.join(configA, 'Subsystems', 'A.xml');
    const fileB = path.join(configB, 'Subsystems', 'B.xml');
    const beforeB = Buffer.from(subsystemXml('B'), 'utf8');
    const gateway = configureConfigurationMutationGateway(async (_resourcePath, _kind, operation) => operation());
    const panels = patchCompositionPanelFactory();
    const provider = new CompositionEditorProvider(
      createCompositionContext(),
      { invalidateTreeCacheOnly: async () => {}, loadMetadataTree: async () => {} },
      SubsystemStrategy,
    );

    try {
      await writeCompositionFixture(configA, fileA, subsystemXml('A'));
      await writeCompositionFixture(configB, fileB, beforeB.toString('utf8'));
      const tree = createCompositionTreeProvider([]);
      await provider.show(createCompositionNode(fileA, 'A'), tree, configA);
      panels.panels[0].panel.dispose();
      await provider.show(createCompositionNode(fileB, 'B'), tree, configB);

      await panels.panels[0].dispatch({ command: 'toggle', data: { ref: 'Catalog.StaleA', checked: true } });
      await panels.panels[0].dispatch({ command: 'save' });
      assert.deepStrictEqual(await fsp.readFile(fileB), beforeB, 'disposed panel A must not save to reopened B');
      assert.strictEqual(provider.getDirtyCount(), 0, 'disposed callback must not mutate B current state');
      assert.ok(!panels.panels[1].posted.some((message) => message.command === 'saveError' || message.command === 'saveSuccess'));

      await panels.panels[1].dispatch({ command: 'toggle', data: { ref: 'Document.B', checked: true } });
      await panels.panels[1].dispatch({ command: 'save' });
      assert.ok((await fsp.readFile(fileB, 'utf8')).includes('Document.B'));
    } finally {
      gateway.dispose();
      provider.dispose();
      panels.restore();
      await cleanupTempDir(tempRoot);
    }
  });
});

function createRuntimeCatalogTree(
  configA: string,
  configB: string,
  childrenA: TreeNode[] | undefined,
  loadA?: () => Promise<TreeNode[]>,
): { tree: ReturnType<typeof createCompositionTreeProvider>; folderA: TreeNode } {
  const folderA: TreeNode = {
    id: 'Catalogs',
    name: 'Catalogs',
    type: MetadataType.Catalog,
    properties: {},
    children: childrenA,
  };
  const folderB: TreeNode = {
    id: 'Catalogs',
    name: 'Catalogs',
    type: MetadataType.Catalog,
    properties: {},
    children: [],
  };
  const rootA: TreeNode = {
    id: 'rootA',
    name: 'A',
    type: MetadataType.Configuration,
    filePath: path.join(configA, 'Configuration.xml'),
    properties: {},
    children: [folderA],
  };
  const rootB: TreeNode = {
    id: 'rootB',
    name: 'B',
    type: MetadataType.Configuration,
    filePath: path.join(configB, 'Configuration.xml'),
    properties: {},
    children: [folderB],
  };
  const tree = createCompositionTreeProvider([rootA, rootB], async (node) => {
    if (node === folderA && loadA) {
      const children = await loadA();
      folderA.children = children;
      return children;
    }
    return node.children ?? [];
  });
  return { tree, folderA };
}

async function createRuntimeCompositionFiles(prefix: string): Promise<{
  tempRoot: string;
  configA: string;
  configB: string;
  fileA: string;
  fileB: string;
  nodeA: TreeNode;
  nodeB: TreeNode;
}> {
  const tempRoot = await createTempDir(prefix);
  const configA = path.join(tempRoot, 'configuration A');
  const configB = path.join(tempRoot, 'configuration B');
  const fileA = path.join(configA, 'CommonAttributes', 'A.xml');
  const fileB = path.join(configB, 'CommonAttributes', 'B.xml');
  await writeCompositionFixture(configA, fileA, commonAttributeXml('A', 'Catalog.Existing'));
  await writeCompositionFixture(configB, fileB, commonAttributeXml('B', 'Catalog.Other'));
  return {
    tempRoot,
    configA,
    configB,
    fileA,
    fileB,
    nodeA: createCompositionNode(fileA, 'A', MetadataType.CommonAttribute),
    nodeB: createCompositionNode(fileB, 'B', MetadataType.CommonAttribute),
  };
}

async function makeRuntimeCompositionDirty(runtime: CompositionWebviewRuntime): Promise<void> {
  const expandArrow = runtime.findTypeArrow('Catalogs');
  assert.ok(expandArrow, 'the real webview must render a Catalogs expand control');
  expandArrow.click();
  await runtime.drainExtensionMessages();

  const newCheckbox = runtime.findObjectCheckbox('Catalog.New');
  const existingSetting = runtime.findObjectSetting('Catalog.Existing');
  assert.ok(newCheckbox, 'the real webview must render the new catalog checkbox');
  assert.ok(existingSetting, 'the real webview must render the common attribute setting');
  newCheckbox.checked = true;
  newCheckbox.dispatchEvent({ type: 'change' });
  existingSetting.value = 'DontUse';
  existingSetting.dispatchEvent({ type: 'change' });
  await runtime.drainExtensionMessages();
}

suite('CompositionEditorProvider — real webview session state (#250)', () => {
  test('ignored save during a pending show is re-enabled after A recovery with dirty UI intact', async () => {
    const fixture = await createRuntimeCompositionFiles('composition-ui-pending-save-');
    const readB = compositionDeferred<{ refs: string[]; itemSettings: Map<string, Record<string, string>> }>();
    let writeAttempts = 0;
    const gateway = configureConfigurationMutationGateway(async (_resourcePath, _kind, operation) => {
      writeAttempts++;
      return operation();
    }, async (_resourcePath, plan) => plan.result);
    const panels = patchCompositionPanelFactory(true);
    const strategy = {
      ...CommonAttributeStrategy,
      readContent: (filePath: string) => filePath === fixture.fileB
        ? readB.promise
        : CommonAttributeStrategy.readContent(filePath),
    };
    const provider = new CompositionEditorProvider(
      createCompositionContext(),
      { invalidateTreeCacheOnly: async () => {}, loadMetadataTree: async () => {} },
      strategy,
    );

    try {
      await writeCompositionFixture(fixture.configA, fixture.fileA, commonAttributeXml('A', 'Catalog.Existing'));
      const existing = { id: 'Catalog.Existing', name: 'Existing', type: MetadataType.Catalog, properties: {} } as TreeNode;
      const added = { id: 'Catalog.New', name: 'New', type: MetadataType.Catalog, properties: {} } as TreeNode;
      const { tree } = createRuntimeCatalogTree(fixture.configA, fixture.configB, [existing, added]);
      await provider.show(fixture.nodeA, tree, fixture.configA);
      const runtime = panels.panels[0].runtime;
      assert.ok(runtime, 'the panel must execute its real inline webview script');
      await makeRuntimeCompositionDirty(runtime);
      assert.strictEqual(runtime.getElementById('btn-save').disabled, false, 'dirty UI must enable save');

      const showB = provider.show(fixture.nodeB, tree, fixture.configB);
      runtime.getElementById('btn-save').click();
      await runtime.drainExtensionMessages();
      assert.strictEqual(writeAttempts, 0, 'save is ignored while B is pending');
      assert.strictEqual(runtime.getElementById('btn-save').disabled, true, 'the actual click handler marks save pending');
      readB.reject(new Error('B read failed'));
      await showB;

      const saveButton = runtime.getElementById('btn-save');
      assert.strictEqual(saveButton.disabled, false, 'recovered dirty A must allow another save');
      assert.strictEqual(saveButton.textContent, 'Сохранить', 'recovery must clear the stale saving label');
      assert.strictEqual(runtime.findObjectCheckbox('Catalog.New')?.checked, true, 'the dirty checked ref must stay visible');
      assert.strictEqual(runtime.findObjectSetting('Catalog.Existing')?.value, 'DontUse', 'the dirty setting must stay visible');
      assert.ok(
        panels.panels[0].posted.some((message) => message.command === 'sessionState'),
        'recovery must synchronize the live webview without reloading its dirty state',
      );

      saveButton.click();
      await runtime.drainExtensionMessages();
      assert.strictEqual(writeAttempts, 1, 'the re-enabled button must admit the retry');
      const savedA = await fsp.readFile(fixture.fileA, 'utf8');
      assert.ok(savedA.includes('Catalog.New'), 'retry must save the preserved checked ref');
      assert.ok(savedA.includes('DontUse'), 'retry must save the preserved setting');
    } finally {
      readB.reject(new Error('cleanup B read'));
      gateway.dispose();
      provider.dispose();
      panels.restore();
      await cleanupTempDir(fixture.tempRoot);
    }
  });

  for (const writerOutcome of ['success', 'failure'] as const) {
    test(`accepted A ${writerOutcome} after failed B recovery synchronizes UI without a stale outcome`, async () => {
      const fixture = await createRuntimeCompositionFiles(`composition-ui-stale-${writerOutcome}-`);
      const enteredSave = compositionDeferred<void>();
      const releaseSave = compositionDeferred<void>();
      const readB = compositionDeferred<{ refs: string[]; itemSettings: Map<string, Record<string, string>> }>();
      const gateway = configureConfigurationMutationGateway(async (resourcePath, kind, operation) => {
        if (path.resolve(resourcePath) === path.resolve(fixture.fileA) && kind === 'ui.composition.save') {
          enteredSave.resolve();
          await releaseSave.promise;
          if (writerOutcome === 'failure') { throw new Error('captured A writer failed'); }
        }
        return operation();
      }, async (_resourcePath, plan) => plan.result);
      const panels = patchCompositionPanelFactory(true);
      const strategy = {
        ...CommonAttributeStrategy,
        readContent: (filePath: string) => filePath === fixture.fileB
          ? readB.promise
          : CommonAttributeStrategy.readContent(filePath),
      };
      const provider = new CompositionEditorProvider(
        createCompositionContext(),
        { invalidateTreeCacheOnly: async () => {}, loadMetadataTree: async () => {} },
        strategy,
      );
      let runtime: CompositionWebviewRuntime | undefined;

      try {
        const existing = { id: 'Catalog.Existing', name: 'Existing', type: MetadataType.Catalog, properties: {} } as TreeNode;
        const added = { id: 'Catalog.New', name: 'New', type: MetadataType.Catalog, properties: {} } as TreeNode;
        const { tree } = createRuntimeCatalogTree(fixture.configA, fixture.configB, [existing, added]);
        await provider.show(fixture.nodeA, tree, fixture.configA);
        runtime = panels.panels[0].runtime;
        assert.ok(runtime, 'the panel must execute its real inline webview script');
        await makeRuntimeCompositionDirty(runtime);
        runtime.getElementById('btn-save').click();
        await enteredSave.promise;

        const showB = provider.show(fixture.nodeB, tree, fixture.configB);
        readB.reject(new Error('B read failed after A accepted save'));
        await showB;
        const remainedSavingDuringRecovery = runtime.getElementById('btn-save').disabled &&
          runtime.getElementById('btn-save').textContent === 'Сохранение...';
        const recoveryState = panels.panels[0].posted.filter((message) => message.command === 'sessionState');

        releaseSave.resolve();
        await runtime.drainExtensionMessages();

        const saveButton = runtime.getElementById('btn-save');
        assert.strictEqual(remainedSavingDuringRecovery, true, 'recovery must retain the accepted A save ownership');
        assert.ok(
          recoveryState.some((message) => message.command === 'sessionState' && message.data.saving === true && message.data.resetLoading),
          'A recovery must synchronize the still-running save and reset old loading indicators',
        );
        assert.strictEqual(saveButton.disabled, false, 'A finally must re-enable the dirty recovered editor');
        assert.strictEqual(saveButton.textContent, 'Сохранить', 'A finally must clear the stale saving label');
        assert.strictEqual(runtime.findObjectCheckbox('Catalog.New')?.checked, true, 'checked state must survive recovery');
        assert.strictEqual(runtime.findObjectSetting('Catalog.Existing')?.value, 'DontUse', 'settings must survive recovery');
        assert.strictEqual(panels.panels[0].disposed(), false, 'a stale save completion must not close recovered A');
        assert.ok(
          !panels.panels[0].posted.some((message) => message.command === 'saveSuccess' || message.command === 'saveError'),
          'stale A completion must not publish a save outcome into recovered A',
        );
        assert.ok(
          panels.panels[0].posted.some((message) => message.command === 'sessionState' && message.data.saving === false && !message.data.resetLoading),
          'A finally must publish fresh idle state after releasing the same recovered save owner',
        );
      } finally {
        readB.reject(new Error('cleanup B read'));
        releaseSave.resolve();
        await runtime?.drainExtensionMessages().catch(() => {});
        gateway.dispose();
        provider.dispose();
        panels.restore();
        await cleanupTempDir(fixture.tempRoot);
      }
    });
  }

  test('A expansion spinner is cleared after failed B recovery and late A children stay fenced', async () => {
    const fixture = await createRuntimeCompositionFiles('composition-ui-expand-reset-');
    const enteredLoad = compositionDeferred<void>();
    const releaseLoad = compositionDeferred<TreeNode[]>();
    const readB = compositionDeferred<{ refs: string[]; itemSettings: Map<string, Record<string, string>> }>();
    const panels = patchCompositionPanelFactory(true);
    const strategy = {
      ...CommonAttributeStrategy,
      readContent: (filePath: string) => filePath === fixture.fileB
        ? readB.promise
        : CommonAttributeStrategy.readContent(filePath),
    };
    const provider = new CompositionEditorProvider(
      createCompositionContext(),
      { invalidateTreeCacheOnly: async () => {}, loadMetadataTree: async () => {} },
      strategy,
    );
    let runtime: CompositionWebviewRuntime | undefined;

    try {
      const { tree } = createRuntimeCatalogTree(fixture.configA, fixture.configB, undefined, async () => {
        enteredLoad.resolve();
        return releaseLoad.promise;
      });
      await provider.show(fixture.nodeA, tree, fixture.configA);
      runtime = panels.panels[0].runtime;
      assert.ok(runtime, 'the panel must execute its real inline webview script');
      runtime.findTypeArrow('Catalogs')?.click();
      await enteredLoad.promise;
      assert.ok(runtime.findTypeArrow('Catalogs')?.innerHTML.includes('spinner-inline'), 'the real script must show the loading arrow');

      const showB = provider.show(fixture.nodeB, tree, fixture.configB);
      readB.reject(new Error('B read failed while A expands'));
      await showB;
      const spinnerCleared = !runtime.findTypeArrow('Catalogs')?.innerHTML.includes('spinner-inline');

      releaseLoad.resolve([
        { id: 'Catalog.Existing', name: 'Existing', type: MetadataType.Catalog, properties: {} } as TreeNode,
      ]);
      await runtime.drainExtensionMessages();

      assert.strictEqual(spinnerCleared, true, 'resetLoading must clear the stale expansion spinner');
      assert.strictEqual(runtime.findObjectRow('Catalog.Existing'), undefined, 'late A children must not be published after recovery');
      assert.ok(
        panels.panels[0].posted.some((message) => message.command === 'sessionState' && message.data.resetLoading),
        'failed B recovery must instruct the live webview to reset load indicators',
      );
    } finally {
      readB.reject(new Error('cleanup B read'));
      releaseLoad.resolve([]);
      await runtime?.drainExtensionMessages().catch(() => {});
      provider.dispose();
      panels.restore();
      await cleanupTempDir(fixture.tempRoot);
    }
  });

  test('bulk loading recovery clears the overlay and pending select-all callback', async () => {
    const fixture = await createRuntimeCompositionFiles('composition-ui-bulk-reset-');
    const enteredLoad = compositionDeferred<void>();
    const releaseLoad = compositionDeferred<TreeNode[]>();
    const readB = compositionDeferred<{ refs: string[]; itemSettings: Map<string, Record<string, string>> }>();
    const panels = patchCompositionPanelFactory(true);
    const strategy = {
      ...CommonAttributeStrategy,
      readContent: (filePath: string) => filePath === fixture.fileB
        ? readB.promise
        : CommonAttributeStrategy.readContent(filePath),
    };
    const provider = new CompositionEditorProvider(
      createCompositionContext(),
      { invalidateTreeCacheOnly: async () => {}, loadMetadataTree: async () => {} },
      strategy,
    );
    let runtime: CompositionWebviewRuntime | undefined;

    try {
      const { tree } = createRuntimeCatalogTree(fixture.configA, fixture.configB, undefined, async () => {
        enteredLoad.resolve();
        return releaseLoad.promise;
      });
      await provider.show(fixture.nodeA, tree, fixture.configA);
      runtime = panels.panels[0].runtime;
      assert.ok(runtime, 'the panel must execute its real inline webview script');
      runtime.getElementById('btn-select-all').click();
      await enteredLoad.promise;
      assert.ok(runtime.getElementById('loading-overlay').classList.contains('visible'), 'bulk load must show its real overlay');

      const showB = provider.show(fixture.nodeB, tree, fixture.configB);
      readB.reject(new Error('B read failed during bulk load'));
      await showB;
      const overlayCleared = !runtime.getElementById('loading-overlay').classList.contains('visible');

      runtime.postMessageToWebview({
        command: 'allObjectsLoaded',
        data: {
          containers: {
            Catalogs: [{ ref: 'Catalog.New', displayName: 'New', type: MetadataType.Catalog }],
          },
        },
      });
      runtime.findTypeArrow('Catalogs')?.click();

      assert.strictEqual(overlayCleared, true, 'resetLoading must hide the stale bulk loading overlay');
      assert.ok(
        !runtime.sentMessages.some((message) => message.command === 'selectAll'),
        'resetLoading must discard the pending select-all callback instead of applying it later',
      );
    } finally {
      readB.reject(new Error('cleanup B read'));
      releaseLoad.resolve([]);
      await runtime?.drainExtensionMessages().catch(() => {});
      provider.dispose();
      panels.restore();
      await cleanupTempDir(fixture.tempRoot);
    }
  });

  test('old A finally does not send session state to successfully published B', async () => {
    const fixture = await createRuntimeCompositionFiles('composition-ui-new-b-session-');
    const enteredSave = compositionDeferred<void>();
    const releaseSave = compositionDeferred<void>();
    const readB = compositionDeferred<{ refs: string[]; itemSettings: Map<string, Record<string, string>> }>();
    const gateway = configureConfigurationMutationGateway(async (resourcePath, kind, operation) => {
      if (path.resolve(resourcePath) === path.resolve(fixture.fileA) && kind === 'ui.composition.save') {
        enteredSave.resolve();
        await releaseSave.promise;
      }
      return operation();
    }, async (_resourcePath, plan) => plan.result);
    const panels = patchCompositionPanelFactory(true);
    const strategy = {
      ...CommonAttributeStrategy,
      readContent: (filePath: string) => filePath === fixture.fileB
        ? readB.promise
        : CommonAttributeStrategy.readContent(filePath),
    };
    const provider = new CompositionEditorProvider(
      createCompositionContext(),
      { invalidateTreeCacheOnly: async () => {}, loadMetadataTree: async () => {} },
      strategy,
    );
    let runtime: CompositionWebviewRuntime | undefined;

    try {
      const existing = { id: 'Catalog.Existing', name: 'Existing', type: MetadataType.Catalog, properties: {} } as TreeNode;
      const added = { id: 'Catalog.New', name: 'New', type: MetadataType.Catalog, properties: {} } as TreeNode;
      const { tree } = createRuntimeCatalogTree(fixture.configA, fixture.configB, [existing, added]);
      await provider.show(fixture.nodeA, tree, fixture.configA);
      runtime = panels.panels[0].runtime;
      assert.ok(runtime, 'the panel must execute its real inline webview script');
      await makeRuntimeCompositionDirty(runtime);
      runtime.getElementById('btn-save').click();
      await enteredSave.promise;

      const showB = provider.show(fixture.nodeB, tree, fixture.configB);
      readB.resolve(await CommonAttributeStrategy.readContent(fixture.fileB));
      await showB;
      const bTitle = runtime.getElementById('entity-title').textContent;
      releaseSave.resolve();
      await runtime.drainExtensionMessages();

      assert.ok(bTitle.endsWith(': B'), 'the actual webview script must display B after successful publication');
      assert.ok(
        !panels.panels[0].posted.some((message) => message.command === 'sessionState'),
        'old A finally must not publish fresh UI state into B ownership',
      );
      assert.ok(
        !panels.panels[0].posted.some((message) => message.command === 'saveSuccess' || message.command === 'saveError'),
        'old A outcome must remain suppressed after B publication',
      );
      assert.strictEqual(panels.panels[0].disposed(), false);
    } finally {
      readB.reject(new Error('cleanup B read'));
      releaseSave.resolve();
      await runtime?.drainExtensionMessages().catch(() => {});
      gateway.dispose();
      provider.dispose();
      panels.restore();
      await cleanupTempDir(fixture.tempRoot);
    }
  });
});
