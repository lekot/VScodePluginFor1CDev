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
