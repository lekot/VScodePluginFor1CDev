import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  rebuildBindingDecorationsForTree,
  registerBindingDecorationSync,
} from '../../src/bindings/bindingTreeDecorations';
import { BindingManager } from '../../src/bindings/bindingManager';
import type { ConfigurationBinding } from '../../src/bindings/models/configurationBinding';
import { bindingKey } from '../../src/bindings/bindingPathUtils';
import type { ConfigurationBindingDecoration } from '../../src/bindings/bindingDecorationTypes';
import { createBindingTreeDecorationsContext, type BindingTreeDecorationsContext } from '../../src/extension/extensionFeatureContexts';
import type { InfobaseEntry } from '../../src/infobases/models/infobaseEntry';
import { InfobaseStorageService } from '../../src/infobases/infobaseStorageService';
import { MetadataTreeDataProvider } from '../../src/providers/treeDataProvider';
import { createExtensionStateFixture } from '../helpers/extensionStateFixture';
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

const testStorageServices = new Set<InfobaseStorageService>();

interface BindingDecorationsTestOverrides {
  provider?: {
    setConfigurationBindingDecorations: (m: ReadonlyMap<string, ConfigurationBindingDecoration>) => void;
    refresh: () => void;
  };
  manager?: { listAll: () => Promise<ConfigurationBinding[]> };
  storage?: { load: () => Promise<InfobaseEntry[]> };
}

class TestMemento implements vscode.Memento {
  private readonly values = new Map<string, unknown>();

  keys(): readonly string[] {
    return [...this.values.keys()];
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    const value = this.values.get(key);
    return value === undefined ? defaultValue : value as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.values.delete(key);
    } else {
      this.values.set(key, value);
    }
  }
}

function createInfobaseStorageService(): InfobaseStorageService {
  const secrets = new Map<string, string>();
  const changes = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>();
  const secretStorage: vscode.SecretStorage = {
    keys: async () => [...secrets.keys()],
    get: async (key) => secrets.get(key),
    store: async (key, value) => {
      secrets.set(key, value);
      changes.fire({ key });
    },
    delete: async (key) => {
      secrets.delete(key);
      changes.fire({ key });
    },
    onDidChange: changes.event,
  };
  const storage = new InfobaseStorageService(new TestMemento(), secretStorage);
  testStorageServices.add(storage);
  return storage;
}

function makeStateFixture(overrides: BindingDecorationsTestOverrides = {}): {
  state: BindingTreeDecorationsContext;
  storage: InfobaseStorageService;
} {
  const provider = new MetadataTreeDataProvider();
  if (overrides.provider) {
    provider.setConfigurationBindingDecorations = overrides.provider.setConfigurationBindingDecorations;
    provider.refresh = overrides.provider.refresh;
  }
  const manager = new BindingManager();
  if (overrides.manager) {
    manager.listAll = overrides.manager.listAll;
  }
  const storage = createInfobaseStorageService();
  if (overrides.storage) {
    storage.load = overrides.storage.load;
  }
  const fixture = createExtensionStateFixture({
    bindingManager: manager,
    infobaseStorage: storage,
    treeDataProvider: provider,
  });
  return {
    state: createBindingTreeDecorationsContext(fixture.state),
    storage,
  };
}

function makeState(overrides: BindingDecorationsTestOverrides = {}): BindingTreeDecorationsContext {
  return makeStateFixture(overrides).state;
}

function makeEntry(id: string, name: string): InfobaseEntry {
  return {
    id,
    name,
    type: 'file',
    filePath: `/${id}.1cd`,
    hasStoredPassword: false,
    createdAt: new Date(0).toISOString(),
  };
}

suite('bindingTreeDecorations (WOW §2C sync)', () => {
  teardown(() => {
    for (const storage of testStorageServices) {
      storage.dispose();
    }
    testStorageServices.clear();
    resetVscodeTestState();
  });

  test('rebuildBindingDecorationsForTree publishes an empty map when there are no bindings', async () => {
    let published: ReadonlyMap<string, ConfigurationBindingDecoration> | undefined;
    let refreshCount = 0;
    const state = makeState({
      provider: {
        setConfigurationBindingDecorations: (map) => { published = map; },
        refresh: () => { refreshCount++; },
      },
      manager: { listAll: async () => [] },
      storage: { load: async () => [makeEntry('a', 'A')] },
    });
    await rebuildBindingDecorationsForTree(state);
    assert.strictEqual(published?.size, 0);
    assert.strictEqual(refreshCount, 1);
  });

  test('rebuildBindingDecorationsForTree retains a binding with an empty infobase list', async () => {
    const captured = new Map<string, ConfigurationBindingDecoration>();
    const state = makeState({
      provider: {
        setConfigurationBindingDecorations: (map) => {
          captured.clear();
          for (const [key, value] of map) {
            captured.set(key, value);
          }
        },
        refresh: () => undefined,
      },
      manager: {
        listAll: async () => [{
          workspaceFolder: 'W',
          configRelativePath: 'empty/Configuration.xml',
          infobaseIds: [],
          massDeployment: false,
        }],
      },
      storage: { load: async () => [] },
    });
    await rebuildBindingDecorationsForTree(state);
    const decoration = captured.get(bindingKey('W', 'empty/Configuration.xml'));
    assert.ok(decoration);
    assert.strictEqual(decoration!.boundCount, 0);
    assert.strictEqual(decoration!.namesPreview, '');
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
          makeEntry('i1', 'N1'),
          makeEntry('i2', 'N2'),
          makeEntry('i3', 'N3'),
          makeEntry('i4', 'N4'),
          makeEntry('i5', 'N5'),
          makeEntry('i6', 'N6'),
          makeEntry('i7', 'N7'),
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
      manager: { listAll: async () => [{ workspaceFolder: 'W', configRelativePath: 'c.xml', infobaseIds: ['x'], massDeployment: false }] },
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
      storage: { load: async () => [] },
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
      storage: { load: async () => [] },
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
      storage: { load: async () => [] },
    });
    const sub = registerBindingDecorationSync(state);
    fireWorkspaceFoldersChanged();
    await flushAsyncDecorationRebuild();
    assert.strictEqual(refreshCount, 1);
    sub.dispose();
  });

  test('registerBindingDecorationSync: onDidChangeCatalog fires rebuild', async () => {
    const infobaseId = '7f0f0e1e-e4df-4bc0-a291-4765fc20a74a';
    let refreshCount = 0;
    let published: ReadonlyMap<string, ConfigurationBindingDecoration> | undefined;
    const { state, storage } = makeStateFixture({
      provider: {
        setConfigurationBindingDecorations: (decorations) => { published = decorations; },
        refresh: () => {
          refreshCount++;
        },
      },
      manager: {
        listAll: async () => [{
          workspaceFolder: 'W',
          configRelativePath: 'Configuration.xml',
          infobaseIds: [infobaseId],
          massDeployment: false,
        }],
      },
    });
    const subscription = registerBindingDecorationSync(state);
    assert.strictEqual(refreshCount, 0);
    await storage.upsert(makeEntry(infobaseId, 'Event base'));
    await flushAsyncDecorationRebuild();
    assert.strictEqual(refreshCount, 1);
    assert.strictEqual(published?.get(bindingKey('W', 'Configuration.xml'))?.boundCount, 1);
    subscription.dispose();
  });

});
