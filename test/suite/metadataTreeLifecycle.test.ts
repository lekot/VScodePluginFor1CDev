import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { MESSAGES } from '../../src/constants/messages';
import {
  createMetadataTreeLifecycle,
  MetadataReloadError,
} from '../../src/extension/metadataTreeLifecycle';
import { MetadataType, TreeNode } from '../../src/models/treeNode';
import {
  ConfigurationDiscoveryError,
  ConfigFormat,
  DiscoveryStatus,
  FormatDetector,
} from '../../src/parsers/formatDetector';
import { MetadataParser } from '../../src/parsers/metadataParser';
import { MetadataTreeDataProvider } from '../../src/providers/treeDataProvider';
import { ExtensionState } from '../../src/state/extensionState';
import {
  fireWorkspaceFoldersChanged,
  resetVscodeTestState,
  vscodeTestState,
} from '../helpers/vscodeModuleStub';
import { registerMetadataWorkspaceFolderLifecycle } from '../../src/extension/metadataWorkspaceFolders';
import { loadTreeFromCache } from '../../src/utils/diskCache';

suite('MetadataTreeLifecycle', () => {
  const originalDiscoverAllConfigurationRoots = FormatDetector.discoverAllConfigurationRoots;
  const originalDiscoverAllConfigurationPackageFiles = FormatDetector.discoverAllConfigurationPackageFiles;
  const originalDetect = FormatDetector.detect;
  const originalParseStructureOnly = MetadataParser.parseStructureOnly;

  function stubDiscovery(options?: {
    configs?: Array<{ configPath: string; workspaceFolderPath: string }>;
    packages?: Array<{ filePath: string; workspaceFolderPath: string }>;
    configStatus?: DiscoveryStatus;
    packageStatus?: DiscoveryStatus;
  }): void {
    (FormatDetector.discoverAllConfigurationRoots as unknown as typeof FormatDetector.discoverAllConfigurationRoots) =
      async () => ({
        status: options?.configStatus ?? 'authoritative',
        items: options?.configs ?? [],
        issues: options?.configStatus && options.configStatus !== 'authoritative'
          ? [{ path: 'C:/unreadable', error: new Error('unreadable') }]
          : [],
      });
    (FormatDetector.discoverAllConfigurationPackageFiles as unknown as typeof FormatDetector.discoverAllConfigurationPackageFiles) =
      async () => ({
        status: options?.packageStatus ?? 'authoritative',
        items: options?.packages ?? [],
        issues: options?.packageStatus && options.packageStatus !== 'authoritative'
          ? [{ path: 'C:/unreadable', error: new Error('unreadable') }]
          : [],
      });
  }

  function createStateWithProvider(): {
    state: ExtensionState;
    provider: MetadataTreeDataProvider;
    messages: Array<string | undefined>;
  } {
    const state = new ExtensionState();
    const provider = new MetadataTreeDataProvider();
    const messages: Array<string | undefined> = [];
    provider.setMessageUpdater((message) => messages.push(message));
    state.treeDataProvider = provider;
    return { state, provider, messages };
  }

  setup(() => {
    resetVscodeTestState();
    stubDiscovery();
  });

  teardown(() => {
    (FormatDetector.discoverAllConfigurationRoots as unknown as typeof FormatDetector.discoverAllConfigurationRoots) =
      originalDiscoverAllConfigurationRoots;
    (FormatDetector.discoverAllConfigurationPackageFiles as unknown as typeof FormatDetector.discoverAllConfigurationPackageFiles) =
      originalDiscoverAllConfigurationPackageFiles;
    (FormatDetector.detect as unknown as typeof FormatDetector.detect) = originalDetect;
    (MetadataParser.parseStructureOnly as unknown as typeof MetadataParser.parseStructureOnly) =
      originalParseStructureOnly;
    resetVscodeTestState();
  });

  test('no configuration clears roots and uses contextual empty state without a global warning', async () => {
    vscodeTestState.mockWorkspaceFolders = [
      { name: 'non-1c', index: 0, uri: vscode.Uri.file('C:/workspace/non-1c') },
    ];
    const { state, provider, messages } = createStateWithProvider();
    let watcherDisposals = 0;
    state.metadataWatchers = [{ dispose: () => { watcherDisposals += 1; } } as any];
    const existingRoot: TreeNode = {
      id: 'existing-configuration',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
    };
    provider.setRootNode(existingRoot);

    await createMetadataTreeLifecycle(state).loadMetadataTree();

    assert.deepStrictEqual(vscodeTestState.warningLog, []);
    assert.deepStrictEqual(provider.getRootNodes(), []);
    assert.strictEqual(messages.at(-1), MESSAGES.EMPTY_TREE_MESSAGE);
    assert.strictEqual(watcherDisposals, 1, 'watchers from removed configuration roots must be disposed');
    assert.deepStrictEqual(state.metadataWatchers, []);
  });

  test('no workspace preserves NO_WORKSPACE warning and clears the tree', async () => {
    vscodeTestState.mockWorkspaceFolders = [];
    const { state, provider, messages } = createStateWithProvider();

    await createMetadataTreeLifecycle(state).loadMetadataTree();

    assert.deepStrictEqual(vscodeTestState.warningLog, [MESSAGES.NO_WORKSPACE]);
    assert.deepStrictEqual(provider.getRootNodes(), []);
    assert.strictEqual(messages.at(-1), MESSAGES.EMPTY_TREE_MESSAGE);
  });

  test('a real metadata load error is reported, propagated, and preserves active watchers', async () => {
    const workspaceFolderPath = 'C:/workspace/1c';
    vscodeTestState.mockWorkspaceFolders = [
      { name: '1c', index: 0, uri: vscode.Uri.file(workspaceFolderPath) },
    ];
    stubDiscovery({
      configs: [{ configPath: 'C:/missing-configuration', workspaceFolderPath }],
    });
    const { state } = createStateWithProvider();
    let watcherDisposals = 0;
    const activeWatcher = { dispose: () => { watcherDisposals += 1; } } as any;
    state.metadataWatchers = [activeWatcher];

    await assert.rejects(createMetadataTreeLifecycle(state).loadMetadataTree());

    assert.strictEqual(vscodeTestState.warningLog.length, 0);
    assert.strictEqual(vscodeTestState.errorLog.length, 1);
    assert.match(vscodeTestState.errorLog[0], new RegExp(`^${MESSAGES.ERROR_LOADING}:`));
    assert.strictEqual(watcherDisposals, 0, 'last known-good watcher must survive a failed reload');
    assert.deepStrictEqual(state.metadataWatchers, [activeWatcher]);
  });

  test('partial discovery is rejected and preserves last known-good roots and watchers', async () => {
    const workspaceFolderPath = 'C:/workspace/1c';
    vscodeTestState.mockWorkspaceFolders = [
      { name: '1c', index: 0, uri: vscode.Uri.file(workspaceFolderPath) },
    ];
    stubDiscovery({
      configStatus: 'partial',
      configs: [{ configPath: 'C:/workspace/1c/new-config', workspaceFolderPath }],
    });
    const { state, provider } = createStateWithProvider();
    const existingRoot: TreeNode = {
      id: 'existing-configuration',
      name: 'Existing configuration',
      type: MetadataType.Configuration,
      properties: {},
    };
    provider.setRootNode(existingRoot);
    let watcherDisposals = 0;
    const activeWatcher = { dispose: () => { watcherDisposals += 1; } } as any;
    state.metadataWatchers = [activeWatcher];

    await assert.rejects(
      createMetadataTreeLifecycle(state).loadMetadataTree(),
      ConfigurationDiscoveryError
    );

    assert.deepStrictEqual(provider.getRootNodes(), [existingRoot]);
    assert.strictEqual(watcherDisposals, 0);
    assert.deepStrictEqual(state.metadataWatchers, [activeWatcher]);
  });

  test('successful load atomically replaces and disposes the previous watcher set', async () => {
    const workspaceFolderPath = 'C:/workspace/1c';
    const configPath = 'C:/workspace/1c/config';
    vscodeTestState.mockWorkspaceFolders = [
      { name: '1c', index: 0, uri: vscode.Uri.file(workspaceFolderPath) },
    ];
    stubDiscovery({ configs: [{ configPath, workspaceFolderPath }] });
    (MetadataParser.parseStructureOnly as unknown as typeof MetadataParser.parseStructureOnly) =
      async () => ({
        id: 'configuration',
        name: 'Configuration',
        type: MetadataType.Configuration,
        properties: {},
        children: [],
      });
    (FormatDetector.detect as unknown as typeof FormatDetector.detect) =
      async () => ConfigFormat.Designer;

    const { state } = createStateWithProvider();
    let watcherDisposals = 0;
    const activeWatcher = { dispose: () => { watcherDisposals += 1; } } as any;
    state.metadataWatchers = [activeWatcher];

    await createMetadataTreeLifecycle(state).loadMetadataTree();

    assert.strictEqual(watcherDisposals, 1);
    assert.strictEqual(state.metadataWatchers.length, 1);
    assert.notStrictEqual(state.metadataWatchers[0], activeWatcher);
  });

  test('targeted reload reparses only the affected configuration and preserves sibling roots and watchers', async () => {
    const workspaceFolderPath = 'C:/workspace/1c';
    const configA = `${workspaceFolderPath}/cfg-a`;
    const configB = `${workspaceFolderPath}/cfg-b`;
    vscodeTestState.mockWorkspaceFolders = [
      { name: '1c', index: 0, uri: vscode.Uri.file(workspaceFolderPath) },
    ];
    stubDiscovery({
      configs: [
        { configPath: configA, workspaceFolderPath },
        { configPath: configB, workspaceFolderPath },
      ],
    });
    const parseCalls: string[] = [];
    const revisions = new Map([[configA, 1], [configB, 1]]);
    (MetadataParser.parseStructureOnly as unknown as typeof MetadataParser.parseStructureOnly) =
      async (configPath) => {
        parseCalls.push(configPath);
        return {
          id: 'configuration',
          name: `Configuration-${revisions.get(configPath)}`,
          type: MetadataType.Configuration,
          properties: { comment: String(revisions.get(configPath)) },
          children: [],
        };
      };
    (FormatDetector.detect as unknown as typeof FormatDetector.detect) =
      async () => ConfigFormat.Designer;

    const { state, provider } = createStateWithProvider();
    const lifecycle = createMetadataTreeLifecycle(state);
    try {
      await lifecycle.loadMetadataTree();
      const rootsBeforeReload = provider.getRootNodes();
      const siblingRoot = rootsBeforeReload[1];
      const watchersBeforeReload = [...state.metadataWatchers];
      parseCalls.length = 0;
      revisions.set(configA, 2);

      await lifecycle.invalidateCacheAndReload(configA);

      const rootsAfterReload = provider.getRootNodes();
      assert.deepStrictEqual(parseCalls, [configA]);
      assert.strictEqual(rootsAfterReload.length, 2);
      assert.notStrictEqual(rootsAfterReload[0], rootsBeforeReload[0]);
      assert.strictEqual(rootsAfterReload[0].properties.comment, '2');
      assert.strictEqual(rootsAfterReload[1], siblingRoot, 'unaffected root must retain object identity');
      assert.deepStrictEqual(state.metadataWatchers, watchersBeforeReload, 'targeted reload must preserve watcher sessions');
    } finally {
      lifecycle.dispose();
    }
  });

  test('new targeted generation cannot consume cache saved by an older parse after invalidation', async () => {
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'metadata-reload-generation-'));
    const workspaceFolderPath = path.join(tempRoot, 'workspace');
    const configPath = path.join(workspaceFolderPath, 'cfg');
    const globalStoragePath = path.join(tempRoot, 'global-storage');
    await fs.promises.mkdir(configPath, { recursive: true });
    await fs.promises.writeFile(path.join(configPath, 'Configuration.xml'), '<Configuration revision="1"/>');
    vscodeTestState.mockWorkspaceFolders = [
      { name: 'workspace', index: 0, uri: vscode.Uri.file(workspaceFolderPath) },
    ];
    stubDiscovery({ configs: [{ configPath, workspaceFolderPath }] });

    let parseCall = 0;
    let releaseOldParse!: () => void;
    let oldParseStarted!: () => void;
    const oldParseGate = new Promise<void>((resolve) => { releaseOldParse = resolve; });
    const oldParseStartedPromise = new Promise<void>((resolve) => { oldParseStarted = resolve; });
    (MetadataParser.parseStructureOnly as unknown as typeof MetadataParser.parseStructureOnly) =
      async () => {
        parseCall += 1;
        if (parseCall === 2) {
          oldParseStarted();
          await oldParseGate;
        }
        const revision = parseCall === 1 ? 'initial' : parseCall === 2 ? 'stale' : 'fresh';
        return {
          id: 'configuration',
          name: 'Configuration',
          type: MetadataType.Configuration,
          properties: { comment: revision },
          children: [],
        };
      };
    (FormatDetector.detect as unknown as typeof FormatDetector.detect) =
      async () => ConfigFormat.Designer;

    const { state, provider } = createStateWithProvider();
    Object.defineProperty(state, '_extensionContext', {
      configurable: true,
      value: { globalStoragePath },
    });
    const lifecycle = createMetadataTreeLifecycle(state);
    try {
      await lifecycle.loadMetadataTree();
      const firstReload = lifecycle.invalidateCacheAndReload(configPath);
      await oldParseStartedPromise;
      await fs.promises.writeFile(path.join(configPath, 'Configuration.xml'), '<Configuration revision="2"/>');
      const secondReload = lifecycle.invalidateCacheAndReload(configPath);
      releaseOldParse();

      await Promise.all([firstReload, secondReload]);

      assert.strictEqual(parseCall, 3, 'trailing generation must reparse instead of consuming stale cache');
      assert.strictEqual(provider.getRootNodes()[0]?.properties.comment, 'fresh');
      assert.strictEqual(
        await loadTreeFromCache(globalStoragePath, configPath),
        null,
        'targeted generations must not repopulate shared tree cache',
      );
    } finally {
      lifecycle.dispose();
      await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('targeted invalidation fences a paused full parse from repopulating stale cache', async () => {
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'metadata-full-cache-fence-'));
    const workspaceFolderPath = path.join(tempRoot, 'workspace');
    const configPath = path.join(workspaceFolderPath, 'cfg');
    const globalStoragePath = path.join(tempRoot, 'global-storage');
    await fs.promises.mkdir(configPath, { recursive: true });
    await fs.promises.writeFile(path.join(configPath, 'Configuration.xml'), '<Configuration/>');
    vscodeTestState.mockWorkspaceFolders = [
      { name: 'workspace', index: 0, uri: vscode.Uri.file(workspaceFolderPath) },
    ];
    stubDiscovery({ configs: [{ configPath, workspaceFolderPath }] });

    let parseCall = 0;
    let releaseFullParse!: () => void;
    let fullParseStarted!: () => void;
    const fullParseGate = new Promise<void>((resolve) => { releaseFullParse = resolve; });
    const fullParseStartedPromise = new Promise<void>((resolve) => { fullParseStarted = resolve; });
    (MetadataParser.parseStructureOnly as unknown as typeof MetadataParser.parseStructureOnly) = async () => {
      parseCall += 1;
      if (parseCall === 1) {
        fullParseStarted();
        await fullParseGate;
      }
      const revision = parseCall === 1 ? 'stale-full' : parseCall === 2 ? 'fresh-targeted' : 'fresh-full';
      return {
        id: 'configuration',
        name: 'Configuration',
        type: MetadataType.Configuration,
        properties: { comment: revision },
        children: [],
      };
    };
    (FormatDetector.detect as unknown as typeof FormatDetector.detect) = async () => ConfigFormat.Designer;

    const { state, provider } = createStateWithProvider();
    Object.defineProperty(state, '_extensionContext', {
      configurable: true,
      value: { globalStoragePath },
    });
    const lifecycle = createMetadataTreeLifecycle(state);
    try {
      const fullLoad = lifecycle.loadMetadataTree();
      await fullParseStartedPromise;
      const targetedReload = lifecycle.invalidateCacheAndReload(configPath);
      releaseFullParse();

      await Promise.all([fullLoad, targetedReload]);

      assert.strictEqual(provider.getRootNodes()[0]?.properties.comment, 'fresh-targeted');
      assert.strictEqual(
        await loadTreeFromCache(globalStoragePath, configPath),
        null,
        'the pre-invalidation full parse must not repopulate shared cache',
      );

      await lifecycle.loadMetadataTree();
      assert.strictEqual(parseCall, 3, 'the next full load must parse instead of reusing stale full-load cache');
      assert.strictEqual(provider.getRootNodes()[0]?.properties.comment, 'fresh-full');
    } finally {
      lifecycle.dispose();
      await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('dispose fences a late full-load publication', async () => {
    const workspaceFolderPath = 'C:/workspace/1c';
    const configPath = `${workspaceFolderPath}/cfg`;
    vscodeTestState.mockWorkspaceFolders = [
      { name: '1c', index: 0, uri: vscode.Uri.file(workspaceFolderPath) },
    ];
    stubDiscovery({ configs: [{ configPath, workspaceFolderPath }] });
    let releaseParse!: () => void;
    let parseStarted!: () => void;
    const parseStartedPromise = new Promise<void>((resolve) => { parseStarted = resolve; });
    const parseGate = new Promise<void>((resolve) => { releaseParse = resolve; });
    (MetadataParser.parseStructureOnly as unknown as typeof MetadataParser.parseStructureOnly) =
      async () => {
        parseStarted();
        await parseGate;
        return {
          id: 'configuration',
          name: 'Configuration',
          type: MetadataType.Configuration,
          properties: {},
          children: [],
        };
      };
    (FormatDetector.detect as unknown as typeof FormatDetector.detect) =
      async () => ConfigFormat.Designer;

    const { state, provider } = createStateWithProvider();
    const lifecycle = createMetadataTreeLifecycle(state);
    const loading = lifecycle.loadMetadataTree();
    await parseStartedPromise;
    lifecycle.dispose();
    releaseParse();

    await assert.rejects(
      loading,
      (error: unknown) => error instanceof MetadataReloadError && error.code === 'RELOAD_DISPOSED',
    );
    assert.deepStrictEqual(provider.getRootNodes(), []);
    assert.deepStrictEqual(state.metadataWatchers, []);
    assert.deepStrictEqual(vscodeTestState.informationLog, []);
  });

  test('concurrent reload requests are single-flight and coalesce into one trailing generation', async () => {
    vscodeTestState.mockWorkspaceFolders = [
      { name: '1c', index: 0, uri: vscode.Uri.file('C:/workspace/1c') },
    ];
    let discoveryCalls = 0;
    let resolveFirstDiscovery: (() => void) | undefined;
    const firstDiscovery = new Promise<void>((resolve) => {
      resolveFirstDiscovery = resolve;
    });
    (FormatDetector.discoverAllConfigurationRoots as unknown as typeof FormatDetector.discoverAllConfigurationRoots) =
      async () => {
        discoveryCalls += 1;
        if (discoveryCalls === 1) {
          await firstDiscovery;
        }
        return { status: 'authoritative', items: [], issues: [] };
      };

    const lifecycle = createMetadataTreeLifecycle(createStateWithProvider().state);
    const first = lifecycle.loadMetadataTree();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const second = lifecycle.loadMetadataTree();
    const third = lifecycle.loadMetadataTree();
    resolveFirstDiscovery?.();

    await Promise.all([first, second, third]);

    assert.strictEqual(
      discoveryCalls,
      2,
      'requests arriving during a load must share one pending generation'
    );
  });

  test('workspace folder changes trigger metadata rediscovery and disposable listener cleanup', async () => {
    let reloads = 0;
    const disposable = registerMetadataWorkspaceFolderLifecycle({
      loadMetadataTree: async () => {
        reloads += 1;
      },
    });

    fireWorkspaceFoldersChanged();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.strictEqual(reloads, 0, 'collapsed lazy view must not trigger metadata discovery');

    await disposable.loadMetadataTree();
    assert.strictEqual(reloads, 1, 'an explicit load must initialize workspace tracking');
    fireWorkspaceFoldersChanged();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.strictEqual(reloads, 2);

    disposable.dispose();
    fireWorkspaceFoldersChanged();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.strictEqual(reloads, 2, 'disposed workspace listener must not retain lifecycle callback');
  });

  test('failed explicit load still initializes workspace-folder rediscovery', async () => {
    let reloads = 0;
    const disposable = registerMetadataWorkspaceFolderLifecycle({
      loadMetadataTree: async () => {
        reloads += 1;
        if (reloads === 1) {
          throw new Error('initial discovery failed');
        }
      },
    });

    await assert.rejects(disposable.loadMetadataTree(), /initial discovery failed/);
    fireWorkspaceFoldersChanged();
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.strictEqual(reloads, 2);
    disposable.dispose();
  });
});
