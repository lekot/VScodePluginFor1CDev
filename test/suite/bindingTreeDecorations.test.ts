import * as assert from 'assert';
import * as path from 'path';
import {
  rebuildBindingDecorationsForTree,
  registerBindingDecorationSync,
} from '../../src/bindings/bindingTreeDecorations';
import { bindingKey } from '../../src/bindings/bindingPathUtils';
import type { ExtensionState } from '../../src/state/extensionState';
import type { ConfigurationBindingDecoration } from '../../src/bindings/bindingDecorationTypes';
import {
  fireWorkspaceDidSaveDocument,
  fireWorkspaceFoldersChanged,
  resetVscodeTestState,
  vscodeTestState,
} from '../helpers/vscodeModuleStub';

/** `registerBindingDecorationSync` fires `void rebuildBindingDecorationsForTree` — дождаться завершения промиса. */
function flushAsyncDecorationRebuild(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

suite('bindingTreeDecorations (WOW §2C sync)', () => {
  teardown(() => {
    resetVscodeTestState();
  });

  function makeState(overrides: {
    provider?: {
      setConfigurationBindingDecorations: (m: ReadonlyMap<string, ConfigurationBindingDecoration>) => void;
      refresh: () => void;
    } | null;
    manager?: { listAll: () => Promise<unknown[]> } | null;
    storage?: {
      load: () => Promise<Array<{ id: string; name: string }>>;
      onDidChangeCatalog?: (cb: () => void) => { dispose: () => void };
    } | null;
  }): ExtensionState {
    const rawStorage = overrides.storage;
    const storage =
      rawStorage === null
        ? null
        : ({
            load: rawStorage!.load,
            onDidChangeCatalog:
              rawStorage!.onDidChangeCatalog ?? (() => ({ dispose: () => undefined })),
          } as ExtensionState['infobaseStorage']);
    return {
      treeDataProvider: overrides.provider ?? null,
      bindingManager: (overrides.manager ?? null) as ExtensionState['bindingManager'],
      infobaseStorage: storage,
    } as ExtensionState;
  }

  test('rebuildBindingDecorationsForTree is no-op when treeDataProvider is missing', async () => {
    const state = makeState({
      provider: null,
      manager: { listAll: async () => [{ workspaceFolder: 'W', configRelativePath: 'c.xml', infobaseIds: ['a'] }] },
      storage: { load: async () => [{ id: 'a', name: 'A' }] },
    });
    await rebuildBindingDecorationsForTree(state);
    assert.strictEqual(vscodeTestState.warningLog.length, 0);
  });

  test('rebuildBindingDecorationsForTree is no-op when bindingManager is missing', async () => {
    let setCalls = 0;
    const state = makeState({
      provider: {
        setConfigurationBindingDecorations: () => {
          setCalls++;
        },
        refresh: () => undefined,
      },
      manager: null,
      storage: { load: async () => [] },
    });
    await rebuildBindingDecorationsForTree(state);
    assert.strictEqual(setCalls, 0);
  });

  test('rebuildBindingDecorationsForTree is no-op when infobaseStorage is missing', async () => {
    let setCalls = 0;
    const state = makeState({
      provider: {
        setConfigurationBindingDecorations: () => {
          setCalls++;
        },
        refresh: () => undefined,
      },
      manager: { listAll: async () => [] },
      storage: null,
    });
    await rebuildBindingDecorationsForTree(state);
    assert.strictEqual(setCalls, 0);
  });

  test('rebuildBindingDecorationsForTree maps bindings, resolves names, truncates preview, calls refresh', async () => {
    const captured = new Map<string, ConfigurationBindingDecoration>();
    let refreshCount = 0;
    const state = makeState({
      provider: {
        setConfigurationBindingDecorations: (m) => {
          captured.clear();
          for (const [k, v] of m) {
            captured.set(k, v);
          }
        },
        refresh: () => {
          refreshCount++;
        },
      },
      manager: {
        listAll: async () => [
          {
            workspaceFolder: 'WF',
            configRelativePath: 'app/Configuration.xml',
            infobaseIds: ['i1', 'i2', 'i3', 'i4', 'i5', 'i6', 'i7'],
            massDeployment: false,
          },
        ],
      },
      storage: {
        load: async () => [
          { id: 'i1', name: 'N1' },
          { id: 'i2', name: 'N2' },
          { id: 'i3', name: 'N3' },
          { id: 'i4', name: 'N4' },
          { id: 'i5', name: 'N5' },
          { id: 'i6', name: 'N6' },
          { id: 'i7', name: 'N7' },
        ],
      },
    });
    await rebuildBindingDecorationsForTree(state);
    const key = bindingKey('WF', 'app/Configuration.xml');
    const deco = captured.get(key);
    assert.ok(deco, 'decoration for key must exist');
    assert.strictEqual(deco!.boundCount, 7);
    assert.ok(deco!.namesPreview.includes('N1'), deco!.namesPreview);
    assert.ok(deco!.namesPreview.includes('ещё 1'), 'must append overflow suffix for 7th name');
    assert.strictEqual(deco!.massDeployment, false);
    assert.strictEqual(refreshCount, 1);
  });

  test('rebuildBindingDecorationsForTree uses infobase id when name missing in catalog', async () => {
    const captured = new Map<string, ConfigurationBindingDecoration>();
    const state = makeState({
      provider: {
        setConfigurationBindingDecorations: (m) => {
          captured.clear();
          for (const [k, v] of m) {
            captured.set(k, v);
          }
        },
        refresh: () => undefined,
      },
      manager: {
        listAll: async () => [
          {
            workspaceFolder: 'W',
            configRelativePath: 'x/Configuration.xml',
            infobaseIds: ['missing-id'],
            massDeployment: true,
          },
        ],
      },
      storage: { load: async () => [] },
    });
    await rebuildBindingDecorationsForTree(state);
    const deco = captured.get(bindingKey('W', 'x/Configuration.xml'));
    assert.ok(deco);
    assert.strictEqual(deco!.namesPreview, 'missing-id');
    assert.strictEqual(deco!.massDeployment, true);
  });

  test('rebuildBindingDecorationsForTree shows warning when listAll throws', async () => {
    const state = makeState({
      provider: {
        setConfigurationBindingDecorations: () => undefined,
        refresh: () => undefined,
      },
      manager: {
        listAll: async () => {
          throw new Error('disk boom');
        },
      },
      storage: { load: async () => [] },
    });
    await rebuildBindingDecorationsForTree(state);
    assert.ok(
      vscodeTestState.warningLog.some((m) => m.includes('индикацию') && m.includes('disk boom')),
      `expected warning, got ${JSON.stringify(vscodeTestState.warningLog)}`,
    );
  });

  test('rebuildBindingDecorationsForTree shows warning when storage.load throws', async () => {
    const state = makeState({
      provider: {
        setConfigurationBindingDecorations: () => undefined,
        refresh: () => undefined,
      },
      manager: { listAll: async () => [{ workspaceFolder: 'W', configRelativePath: 'c.xml', infobaseIds: ['x'] }] },
      storage: {
        load: async () => {
          throw new Error('catalog read failed');
        },
      },
    });
    await rebuildBindingDecorationsForTree(state);
    assert.ok(
      vscodeTestState.warningLog.some((m) => m.includes('индикацию') && m.includes('catalog read failed')),
      `expected warning, got ${JSON.stringify(vscodeTestState.warningLog)}`,
    );
  });

  test('registerBindingDecorationSync: save infobase-bindings.json triggers rebuild', async () => {
    let refreshCount = 0;
    const state = makeState({
      provider: {
        setConfigurationBindingDecorations: () => undefined,
        refresh: () => {
          refreshCount++;
        },
      },
      manager: { listAll: async () => [] },
      storage: {
        load: async () => [],
        onDidChangeCatalog: () => ({ dispose: () => undefined }),
      },
    });
    const sub = registerBindingDecorationSync(state);
    assert.strictEqual(refreshCount, 0);
    fireWorkspaceDidSaveDocument(path.join('C:', 'proj', '.vscode', 'infobase-bindings.json'));
    await flushAsyncDecorationRebuild();
    assert.strictEqual(refreshCount, 1);
    fireWorkspaceDidSaveDocument(path.join('C:', 'proj', 'other.json'));
    await flushAsyncDecorationRebuild();
    assert.strictEqual(refreshCount, 1, 'non-bindings save must not refresh');
    sub.dispose();
  });

  test('registerBindingDecorationSync: Windows path with backslashes recognized', async () => {
    let refreshCount = 0;
    const state = makeState({
      provider: {
        setConfigurationBindingDecorations: () => undefined,
        refresh: () => {
          refreshCount++;
        },
      },
      manager: { listAll: async () => [] },
      storage: {
        load: async () => [],
        onDidChangeCatalog: () => ({ dispose: () => undefined }),
      },
    });
    const sub = registerBindingDecorationSync(state);
    const p = 'C:\\x\\.vscode\\infobase-bindings.json';
    fireWorkspaceDidSaveDocument(p);
    await flushAsyncDecorationRebuild();
    assert.strictEqual(refreshCount, 1);
    sub.dispose();
  });

  test('registerBindingDecorationSync: workspace folders change triggers rebuild', async () => {
    let refreshCount = 0;
    const state = makeState({
      provider: {
        setConfigurationBindingDecorations: () => undefined,
        refresh: () => {
          refreshCount++;
        },
      },
      manager: { listAll: async () => [] },
      storage: {
        load: async () => [],
        onDidChangeCatalog: () => ({ dispose: () => undefined }),
      },
    });
    const sub = registerBindingDecorationSync(state);
    fireWorkspaceFoldersChanged();
    await flushAsyncDecorationRebuild();
    assert.strictEqual(refreshCount, 1);
    sub.dispose();
  });

  test('registerBindingDecorationSync: onDidChangeCatalog fires rebuild', async () => {
    let refreshCount = 0;
    const catalogCallbacks: Array<() => void> = [];
    const state = makeState({
      provider: {
        setConfigurationBindingDecorations: () => undefined,
        refresh: () => {
          refreshCount++;
        },
      },
      manager: { listAll: async () => [] },
      storage: {
        load: async () => [],
        onDidChangeCatalog: (cb) => {
          catalogCallbacks.push(cb);
          return { dispose: () => undefined };
        },
      },
    });
    registerBindingDecorationSync(state);
    assert.strictEqual(catalogCallbacks.length, 1);
    catalogCallbacks[0]!();
    await flushAsyncDecorationRebuild();
    assert.strictEqual(refreshCount, 1);
  });

});
