import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import * as vscode from 'vscode';
import { MESSAGES } from '../../src/constants/messages';
import {
  createMetadataTreeLifecycle,
  MetadataReloadError,
} from '../../src/extension/metadataTreeLifecycle';
import { MetadataType } from '../../src/models/treeNode';
import {
  ConfigurationDiscoveryError,
  ConfigFormat,
  DiscoveryStatus,
  FormatDetector,
} from '../../src/parsers/formatDetector';
import { MetadataParser } from '../../src/parsers/metadataParser';
import { MetadataTreeDataProvider } from '../../src/providers/treeDataProvider';
import { ConfigurationContextResolver } from '../../src/services/configurationSession/ConfigurationContextResolver';
import { ConfigurationSession } from '../../src/services/configurationSession/ConfigurationSession';
import { WorkspaceRegistry } from '../../src/services/configurationSession/WorkspaceRegistry';
import { MetadataWatcherService } from '../../src/services/metadataWatcherService';
import { ReloadCoordinatorService } from '../../src/services/reloadCoordinatorService';
import { Logger } from '../../src/utils/logger';
import { createMetadataTreeLifecycleRuntimeView } from '../../src/extension/extensionFeatureContexts';
import { createExtensionStateFixture, type ExtensionStateFixture } from '../helpers/extensionStateFixture';
import { fakeTreeLoadContext } from '../helpers/fakeTreeLoadContext';
import {
  fireWorkspaceFoldersChanged,
  resetVscodeTestState,
  vscodeTestState,
} from '../helpers/vscodeModuleStub';
import { registerMetadataWorkspaceFolderLifecycle } from '../../src/extension/metadataWorkspaceFolders';
import { loadTreeFromCache, saveTreeToCache } from '../../src/utils/diskCache';
import * as diskCache from '../../src/utils/diskCache';

suite('MetadataTreeLifecycle', () => {
  const originalDiscoverAllConfigurationRoots = FormatDetector.discoverAllConfigurationRoots;
  const originalDiscoverAllConfigurationPackageFiles = FormatDetector.discoverAllConfigurationPackageFiles;
  const originalDetect = FormatDetector.detect;
  const originalParseStructureOnly = MetadataParser.parseStructureOnly;
  const originalInvalidateTypeContentsCache = MetadataParser.invalidateTypeContentsCache;
  const originalWatcherStart = MetadataWatcherService.prototype.start;
  const originalWatcherDispose = MetadataWatcherService.prototype.dispose;
  const originalShowWarningMessage = vscode.window.showWarningMessage;
  const activeLifecycles = new Set<ReturnType<typeof createMetadataTreeLifecycle>>();
  const activeProviders = new Set<MetadataTreeDataProvider>();
  const activeStateFixtures = new Set<ExtensionStateFixture>();
  let watcherDisposals = 0;

  class TestWorkspaceRegistry extends WorkspaceRegistry {
    override async resolveResource(resource: string): Promise<ConfigurationSession> {
      const context = fakeTreeLoadContext(resource, ConfigFormat.Designer);
      const absoluteRootPath = path.resolve(resource);
      return new ConfigurationSession({
        configurationId: context.configurationId,
        rootPath: resource,
        rootUri: pathToFileURL(absoluteRootPath).toString(),
        descriptorUri: pathToFileURL(path.join(absoluteRootPath, 'Configuration.xml')).toString(),
        workspaceFolderUris: [pathToFileURL(path.dirname(absoluteRootPath)).toString()],
        format: context.format,
        capabilities: { read: true, write: true, process: true },
      });
    }
  }

  interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
  }

  function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
    return { promise, resolve };
  }

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

  function stubSuccessfulTreeParsing(): void {
    (MetadataParser.parseStructureOnly as unknown as typeof MetadataParser.parseStructureOnly) = async () => ({
      id: 'configuration',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      children: [],
    });
    (FormatDetector.detect as unknown as typeof FormatDetector.detect) = async () => ConfigFormat.Designer;
  }

  function testExtensionContext(globalStoragePath: string): vscode.ExtensionContext {
    return {
      subscriptions: [],
      globalStoragePath,
    } as unknown as vscode.ExtensionContext;
  }

  function createStateWithProvider(extensionContext?: vscode.ExtensionContext): {
    state: ReturnType<typeof createMetadataTreeLifecycleRuntimeView>;
    provider: MetadataTreeDataProvider;
    messages: Array<string | undefined>;
  } {
    const provider = new MetadataTreeDataProvider();
    activeProviders.add(provider);
    const messages: Array<string | undefined> = [];
    provider.setMessageUpdater((message) => messages.push(message));
    const fixture = createExtensionStateFixture({
      treeDataProvider: provider,
      configurationContextResolver: new ConfigurationContextResolver(new TestWorkspaceRegistry()),
    }, extensionContext);
    activeStateFixtures.add(fixture);
    return {
      state: createMetadataTreeLifecycleRuntimeView(fixture.state),
      provider,
      messages,
    };
  }

  function createTrackedLifecycle(
    state: ReturnType<typeof createMetadataTreeLifecycleRuntimeView>,
  ): ReturnType<typeof createMetadataTreeLifecycle> {
    const lifecycle = createMetadataTreeLifecycle(state);
    activeLifecycles.add(lifecycle);
    return lifecycle;
  }

  function createReloadCoordinator(lifecycle: ReturnType<typeof createMetadataTreeLifecycle>): ReloadCoordinatorService {
    return new ReloadCoordinatorService(async ({ configPath, canPublish }) =>
      lifecycle.executeConfigurationReload(configPath, canPublish), { defaultDebounceMs: 0 });
  }

  async function executeSingleReload(
    lifecycle: ReturnType<typeof createMetadataTreeLifecycle>,
    configPath: string,
  ): Promise<void> {
    const outcome = await lifecycle.executeConfigurationReload(configPath, () => true);
    assert.strictEqual(outcome.status, 'published');
  }

  setup(() => {
    activeLifecycles.clear();
    activeProviders.clear();
    activeStateFixtures.clear();
    watcherDisposals = 0;
    MetadataWatcherService.prototype.start = () => undefined;
    MetadataWatcherService.prototype.dispose = () => { watcherDisposals += 1; };
    resetVscodeTestState();
    stubDiscovery();
  });

  teardown(async () => {
    await Promise.all([...activeLifecycles].map((lifecycle) => lifecycle.dispose()));
    activeLifecycles.clear();
    await Promise.all([...activeStateFixtures].map((fixture) => fixture.dispose()));
    activeStateFixtures.clear();
    for (const provider of activeProviders) {
      provider.dispose();
    }
    activeProviders.clear();
    MetadataWatcherService.prototype.start = originalWatcherStart;
    MetadataWatcherService.prototype.dispose = originalWatcherDispose;
    (vscode.window as any).showWarningMessage = originalShowWarningMessage;
    (FormatDetector.discoverAllConfigurationRoots as unknown as typeof FormatDetector.discoverAllConfigurationRoots) =
      originalDiscoverAllConfigurationRoots;
    (FormatDetector.discoverAllConfigurationPackageFiles as unknown as typeof FormatDetector.discoverAllConfigurationPackageFiles) =
      originalDiscoverAllConfigurationPackageFiles;
    (FormatDetector.detect as unknown as typeof FormatDetector.detect) = originalDetect;
    (MetadataParser.parseStructureOnly as unknown as typeof MetadataParser.parseStructureOnly) =
      originalParseStructureOnly;
    (MetadataParser.invalidateTypeContentsCache as unknown as typeof MetadataParser.invalidateTypeContentsCache) =
      originalInvalidateTypeContentsCache;
    resetVscodeTestState();
  });

  test('no configuration clears roots and uses contextual empty state without a global warning', async () => {
    const workspaceFolderPath = 'C:/workspace/non-1c';
    vscodeTestState.mockWorkspaceFolders = [
      { name: 'non-1c', index: 0, uri: vscode.Uri.file(workspaceFolderPath) },
    ];
    const existingConfigPath = `${workspaceFolderPath}/config`;
    stubDiscovery({ configs: [{ configPath: existingConfigPath, workspaceFolderPath }] });
    stubSuccessfulTreeParsing();
    const { state, provider, messages } = createStateWithProvider();
    const lifecycle = createTrackedLifecycle(state);
    await lifecycle.loadMetadataTree();
    const previousWatchers = [...lifecycle.metadataWatchers];
    assert.strictEqual(previousWatchers.length, 1);

    stubDiscovery();

    await lifecycle.loadMetadataTree();

    assert.deepStrictEqual(vscodeTestState.warningLog, []);
    assert.deepStrictEqual(provider.getRootNodes(), []);
    assert.strictEqual(messages.at(-1), MESSAGES.EMPTY_TREE_MESSAGE);
    assert.strictEqual(watcherDisposals, previousWatchers.length, 'watchers from removed configuration roots must be disposed');
    assert.deepStrictEqual(lifecycle.metadataWatchers, []);
  });

  test('no workspace preserves NO_WORKSPACE warning and clears the tree', async () => {
    vscodeTestState.mockWorkspaceFolders = [];
    const { state, provider, messages } = createStateWithProvider();

    await createTrackedLifecycle(state).loadMetadataTree();

    assert.deepStrictEqual(vscodeTestState.warningLog, [MESSAGES.NO_WORKSPACE]);
    assert.deepStrictEqual(provider.getRootNodes(), []);
    assert.strictEqual(messages.at(-1), MESSAGES.EMPTY_TREE_MESSAGE);
  });

  test('a real metadata load error is reported, propagated, and preserves active watchers', async () => {
    const workspaceFolderPath = 'C:/workspace/1c';
    vscodeTestState.mockWorkspaceFolders = [
      { name: '1c', index: 0, uri: vscode.Uri.file(workspaceFolderPath) },
    ];
    const configPath = `${workspaceFolderPath}/config`;
    stubDiscovery({ configs: [{ configPath, workspaceFolderPath }] });
    let parseCalls = 0;
    (MetadataParser.parseStructureOnly as unknown as typeof MetadataParser.parseStructureOnly) = async () => {
      parseCalls += 1;
      if (parseCalls > 1) {
        throw new Error('synthetic metadata parse failure');
      }
      return {
        id: 'configuration',
        name: 'Configuration',
        type: MetadataType.Configuration,
        properties: {},
        children: [],
      };
    };
    (FormatDetector.detect as unknown as typeof FormatDetector.detect) = async () => ConfigFormat.Designer;
    const { state } = createStateWithProvider();
    const lifecycle = createTrackedLifecycle(state);
    await lifecycle.loadMetadataTree();
    const previousWatchers = [...lifecycle.metadataWatchers];
    assert.strictEqual(previousWatchers.length, 1);

    await assert.rejects(lifecycle.loadMetadataTree());

    assert.strictEqual(vscodeTestState.warningLog.length, 0);
    assert.strictEqual(vscodeTestState.errorLog.length, 1);
    assert.match(vscodeTestState.errorLog[0], new RegExp(`^${MESSAGES.ERROR_LOADING}:`));
    assert.strictEqual(watcherDisposals, 0, 'last known-good watcher must survive a failed reload');
    assert.deepStrictEqual(lifecycle.metadataWatchers, previousWatchers);
  });

  test('partial discovery is rejected and preserves last known-good roots and watchers', async () => {
    const workspaceFolderPath = 'C:/workspace/1c';
    vscodeTestState.mockWorkspaceFolders = [
      { name: '1c', index: 0, uri: vscode.Uri.file(workspaceFolderPath) },
    ];
    const existingConfigPath = `${workspaceFolderPath}/existing-config`;
    stubDiscovery({ configs: [{ configPath: existingConfigPath, workspaceFolderPath }] });
    stubSuccessfulTreeParsing();
    const { state, provider } = createStateWithProvider();
    const lifecycle = createTrackedLifecycle(state);
    await lifecycle.loadMetadataTree();
    const previousRoots = provider.getRootNodes();
    const previousWatchers = [...lifecycle.metadataWatchers];
    assert.strictEqual(previousWatchers.length, 1);
    stubDiscovery({
      configStatus: 'partial',
      configs: [{ configPath: 'C:/workspace/1c/new-config', workspaceFolderPath }],
    });

    await assert.rejects(
      lifecycle.loadMetadataTree(),
      ConfigurationDiscoveryError
    );

    assert.deepStrictEqual(provider.getRootNodes(), previousRoots);
    assert.strictEqual(watcherDisposals, 0);
    assert.deepStrictEqual(lifecycle.metadataWatchers, previousWatchers);
  });

  test('successful load atomically replaces and disposes the previous watcher set', async () => {
    const workspaceFolderPath = 'C:/workspace/1c';
    const configPath = 'C:/workspace/1c/config';
    vscodeTestState.mockWorkspaceFolders = [
      { name: '1c', index: 0, uri: vscode.Uri.file(workspaceFolderPath) },
    ];
    const previousConfigPath = `${workspaceFolderPath}/previous-config`;
    stubDiscovery({ configs: [{ configPath: previousConfigPath, workspaceFolderPath }] });
    stubSuccessfulTreeParsing();
    const { state } = createStateWithProvider();
    const lifecycle = createTrackedLifecycle(state);
    await lifecycle.loadMetadataTree();
    const previousWatchers = [...lifecycle.metadataWatchers];
    assert.strictEqual(previousWatchers.length, 1);

    stubDiscovery({ configs: [{ configPath, workspaceFolderPath }] });
    await lifecycle.loadMetadataTree();

    assert.strictEqual(watcherDisposals, previousWatchers.length);
    assert.strictEqual(lifecycle.metadataWatchers.length, 1);
    assert.notStrictEqual(lifecycle.metadataWatchers[0], previousWatchers[0]);
  });

  for (const failingPosition of [0, 1, 2]) {
    test(`keeps other roots and packages when parsing root ${failingPosition + 1} of 3 fails`, async () => {
      const workspaceFolderPath = 'C:/workspace/partial-root-load';
      const configPaths = ['cfg-a', 'cfg-b', 'cfg-c'].map((name) => `${workspaceFolderPath}/${name}`);
      const failingConfigPath = configPaths[failingPosition]!;
      const packagePath = `${workspaceFolderPath}/release.cf`;
      vscodeTestState.mockWorkspaceFolders = [
        { name: 'partial-root-load', index: 0, uri: vscode.Uri.file(workspaceFolderPath) },
      ];
      stubDiscovery({
        configs: configPaths.map((configPath) => ({ configPath, workspaceFolderPath })),
        packages: [{ filePath: packagePath, workspaceFolderPath }],
      });

      const parseCalls: string[] = [];
      (MetadataParser.parseStructureOnly as unknown as typeof MetadataParser.parseStructureOnly) = async (configPath) => {
        parseCalls.push(configPath);
        if (configPath === failingConfigPath) {
          throw new Error(`synthetic parser failure: ${configPath}`);
        }
        return {
          id: 'configuration',
          name: 'Configuration',
          type: MetadataType.Configuration,
          properties: { comment: configPath },
          children: [],
        };
      };
      const watcherStarts: string[] = [];
      MetadataWatcherService.prototype.start = function (configRoot, _callbacks): void {
        watcherStarts.push(configRoot);
      };

      const { state, provider } = createStateWithProvider();
      const lifecycle = createTrackedLifecycle(state);
      try {
        await lifecycle.loadMetadataTree();

        const roots = provider.getRootNodes();
        const configurationRoots = roots.filter((root) => root.type === MetadataType.Configuration);
        const packageRoots = roots.filter((root) => root.type === MetadataType.ConfigurationPackage);
        const expectedConfigPaths = configPaths.filter((configPath) => configPath !== failingConfigPath);
        assert.deepStrictEqual(parseCalls, configPaths, 'the parser should attempt every discovered root in order');
        assert.deepStrictEqual(
          configurationRoots.map((root) => root.properties.comment),
          expectedConfigPaths,
          'only successfully prepared configuration roots should be published',
        );
        assert.deepStrictEqual(packageRoots.map((root) => root.filePath), [packagePath]);
        assert.deepStrictEqual(watcherStarts, expectedConfigPaths, 'failed roots must not receive watchers');
        assert.strictEqual(lifecycle.metadataWatchers.length, expectedConfigPaths.length);

        const contexts = (provider as any).cache.getLoadContexts() as Map<unknown, { configPath: string }>;
        assert.deepStrictEqual(
          [...contexts.values()].map((context) => context.configPath),
          expectedConfigPaths,
          'each published configuration root must keep its own resolved load context',
        );
        assert.strictEqual(contexts.size, configurationRoots.length);
        assert.strictEqual(vscodeTestState.warningLog.length, 1);
        assert.match(vscodeTestState.warningLog[0]!, /Не удалось подготовить/u);
        assert.ok(vscodeTestState.warningLog[0]!.includes(failingConfigPath));
        assert.deepStrictEqual(vscodeTestState.informationLog, [], 'partial publication must not claim a full success');
        assert.deepStrictEqual(vscodeTestState.errorLog, []);
      } finally {
        await lifecycle.dispose();
      }
    });
  }

  test('publishes a partial tree without waiting for the warning to be dismissed', async () => {
    const workspaceFolderPath = 'C:/workspace/pending-partial-warning';
    const healthyConfigPath = `${workspaceFolderPath}/healthy`;
    const failingConfigPath = `${workspaceFolderPath}/failed`;
    vscodeTestState.mockWorkspaceFolders = [
      { name: 'pending-partial-warning', index: 0, uri: vscode.Uri.file(workspaceFolderPath) },
    ];
    stubDiscovery({
      configs: [healthyConfigPath, failingConfigPath]
        .map((configPath) => ({ configPath, workspaceFolderPath })),
    });
    (MetadataParser.parseStructureOnly as unknown as typeof MetadataParser.parseStructureOnly) = async (configPath) => {
      if (configPath === failingConfigPath) {
        throw new Error('synthetic parser failure');
      }
      return {
        id: 'configuration',
        name: 'Configuration',
        type: MetadataType.Configuration,
        properties: { comment: configPath },
        children: [],
      };
    };

    const warningGate = deferred<string | undefined>();
    let warningRequested = false;
    (vscode.window as any).showWarningMessage = (message: string) => {
      warningRequested = true;
      assert.ok(message.includes(failingConfigPath));
      return warningGate.promise;
    };
    const { state, provider } = createStateWithProvider();
    const lifecycle = createTrackedLifecycle(state);
    const loading = lifecycle.loadMetadataTree();
    try {
      const result = await Promise.race([
        loading.then(() => 'loaded' as const),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 100)),
      ]);

      assert.strictEqual(result, 'loaded', 'tree publication must not wait for the user to dismiss a warning');
      assert.strictEqual(warningRequested, true);
      assert.deepStrictEqual(
        provider.getRootNodes().map((root) => root.properties.comment),
        [healthyConfigPath],
      );
      assert.strictEqual(lifecycle.metadataWatchers.length, 1);
      assert.deepStrictEqual(vscodeTestState.informationLog, []);
    } finally {
      warningGate.resolve(undefined);
      await loading.catch(() => undefined);
      (vscode.window as any).showWarningMessage = originalShowWarningMessage;
      await lifecycle.dispose();
    }
  });

  for (const failureMode of ['synchronous throw', 'asynchronous rejection'] as const) {
    test(`keeps a partial tree when the warning delivery has ${failureMode === 'asynchronous rejection' ? 'an ' : 'a '}${failureMode} and logging also fails`, async () => {
      const workspaceFolderPath = `C:/workspace/warning-delivery-${failureMode.replace(/\s+/gu, '-')}`;
      const healthyConfigPath = `${workspaceFolderPath}/healthy`;
      const failingConfigPath = `${workspaceFolderPath}/failed`;
      vscodeTestState.mockWorkspaceFolders = [
        { name: 'warning-delivery', index: 0, uri: vscode.Uri.file(workspaceFolderPath) },
      ];
      stubDiscovery({
        configs: [healthyConfigPath, failingConfigPath]
          .map((configPath) => ({ configPath, workspaceFolderPath })),
      });
      (MetadataParser.parseStructureOnly as unknown as typeof MetadataParser.parseStructureOnly) = async (configPath) => {
        if (configPath === failingConfigPath) {
          throw new Error('synthetic parser failure');
        }
        return {
          id: 'configuration',
          name: 'Configuration',
          type: MetadataType.Configuration,
          properties: { comment: configPath },
          children: [],
        };
      };
      const originalWarn = Logger.warn;
      let attemptedWarning = false;
      (vscode.window as any).showWarningMessage = () => {
        attemptedWarning = true;
        if (failureMode === 'synchronous throw') {
          throw new Error('warning API failed synchronously');
        }
        return Promise.reject(new Error('warning API rejected asynchronously'));
      };
      Logger.warn = () => { throw new Error('logger unavailable'); };
      const { state, provider } = createStateWithProvider();
      const lifecycle = createTrackedLifecycle(state);
      try {
        await lifecycle.loadMetadataTree();

        assert.strictEqual(attemptedWarning, true);
        assert.deepStrictEqual(
          provider.getRootNodes().map((root) => root.properties.comment),
          [healthyConfigPath],
        );
        assert.strictEqual(lifecycle.metadataWatchers.length, 1);
        assert.deepStrictEqual(vscodeTestState.informationLog, []);
      } finally {
        (vscode.window as any).showWarningMessage = originalShowWarningMessage;
        Logger.warn = originalWarn;
        await lifecycle.dispose();
      }
    });
  }

  test('publishes discovered packages when every configuration root fails', async () => {
    const workspaceFolderPath = 'C:/workspace/package-only-partial';
    const configPaths = ['failed-a', 'failed-b'].map((name) => `${workspaceFolderPath}/${name}`);
    const packagePath = `${workspaceFolderPath}/release.cf`;
    vscodeTestState.mockWorkspaceFolders = [
      { name: 'package-only-partial', index: 0, uri: vscode.Uri.file(workspaceFolderPath) },
    ];
    stubDiscovery({
      configs: configPaths.map((configPath) => ({ configPath, workspaceFolderPath })),
      packages: [{ filePath: packagePath, workspaceFolderPath }],
    });
    (MetadataParser.parseStructureOnly as unknown as typeof MetadataParser.parseStructureOnly) = async () => {
      throw new Error('all configuration roots failed');
    };
    const { state, provider } = createStateWithProvider();
    const lifecycle = createTrackedLifecycle(state);
    try {
      await lifecycle.loadMetadataTree();

      assert.deepStrictEqual(
        provider.getRootNodes().map((root) => ({ type: root.type, filePath: root.filePath })),
        [{ type: MetadataType.ConfigurationPackage, filePath: packagePath }],
      );
      assert.deepStrictEqual(lifecycle.metadataWatchers, []);
      assert.strictEqual(vscodeTestState.warningLog.length, 1);
      assert.ok(configPaths.every((configPath) => vscodeTestState.warningLog[0]!.includes(configPath)));
      assert.deepStrictEqual(vscodeTestState.informationLog, []);
    } finally {
      await lifecycle.dispose();
    }
  });

  test('isolates non-Error root failures even when per-root logging throws', async () => {
    const workspaceFolderPath = 'C:/workspace/non-error-partial-failure';
    const failingConfigPath = `${workspaceFolderPath}/failed`;
    const healthyConfigPath = `${workspaceFolderPath}/healthy`;
    vscodeTestState.mockWorkspaceFolders = [
      { name: 'non-error-partial-failure', index: 0, uri: vscode.Uri.file(workspaceFolderPath) },
    ];
    stubDiscovery({
      configs: [failingConfigPath, healthyConfigPath]
        .map((configPath) => ({ configPath, workspaceFolderPath })),
    });
    (MetadataParser.parseStructureOnly as unknown as typeof MetadataParser.parseStructureOnly) = async (configPath) => {
      if (configPath === failingConfigPath) {
        throw 'synthetic string failure';
      }
      return {
        id: 'configuration',
        name: 'Configuration',
        type: MetadataType.Configuration,
        properties: { comment: configPath },
        children: [],
      };
    };
    const originalWarn = Logger.warn;
    Logger.warn = () => { throw new Error('logger unavailable'); };
    const { state, provider } = createStateWithProvider();
    const lifecycle = createTrackedLifecycle(state);
    try {
      await lifecycle.loadMetadataTree();

      assert.deepStrictEqual(
        provider.getRootNodes().map((root) => root.properties.comment),
        [healthyConfigPath],
      );
      assert.strictEqual(lifecycle.metadataWatchers.length, 1);
      assert.strictEqual(vscodeTestState.warningLog.length, 1);
      assert.ok(vscodeTestState.warningLog[0]!.includes(failingConfigPath));
    } finally {
      Logger.warn = originalWarn;
      await lifecycle.dispose();
    }
  });

  test('superseded per-root failures do not publish a partial generation or warning', async () => {
    const workspaceFolderPath = 'C:/workspace/superseded-partial-root';
    const configPaths = ['cfg-a', 'cfg-b'].map((name) => `${workspaceFolderPath}/${name}`);
    vscodeTestState.mockWorkspaceFolders = [
      { name: 'superseded-partial-root', index: 0, uri: vscode.Uri.file(workspaceFolderPath) },
    ];
    stubDiscovery({ configs: configPaths.map((configPath) => ({ configPath, workspaceFolderPath })) });
    const failedParseGate = deferred<void>();
    const firstParseStarted = deferred<void>();
    const parseCalls: string[] = [];
    (MetadataParser.parseStructureOnly as unknown as typeof MetadataParser.parseStructureOnly) = async (configPath) => {
      parseCalls.push(configPath);
      if (parseCalls.length === 1) {
        firstParseStarted.resolve(undefined);
        await failedParseGate.promise;
        throw new Error('superseded generation parser failure');
      }
      return {
        id: 'configuration',
        name: 'Configuration',
        type: MetadataType.Configuration,
        properties: { comment: configPath },
        children: [],
      };
    };
    const { state, provider } = createStateWithProvider();
    const lifecycle = createTrackedLifecycle(state);
    try {
      const firstLoad = lifecycle.loadMetadataTree();
      await firstParseStarted.promise;
      const trailingLoad = lifecycle.loadMetadataTree();
      failedParseGate.resolve(undefined);
      await Promise.all([firstLoad, trailingLoad]);

      assert.deepStrictEqual(parseCalls, [configPaths[0], ...configPaths]);
      assert.deepStrictEqual(
        provider.getRootNodes().map((root) => root.properties.comment),
        configPaths,
      );
      assert.strictEqual(lifecycle.metadataWatchers.length, 2);
      assert.deepStrictEqual(vscodeTestState.warningLog, []);
    } finally {
      failedParseGate.resolve(undefined);
      await lifecycle.dispose();
    }
  });

  test('quiescing during a failed root aborts instead of publishing neighboring roots', async () => {
    const workspaceFolderPath = 'C:/workspace/quiesced-partial-root';
    const configPaths = ['failed-a', 'neighbor-b'].map((name) => `${workspaceFolderPath}/${name}`);
    vscodeTestState.mockWorkspaceFolders = [
      { name: 'quiesced-partial-root', index: 0, uri: vscode.Uri.file(workspaceFolderPath) },
    ];
    stubDiscovery({ configs: configPaths.map((configPath) => ({ configPath, workspaceFolderPath })) });
    const parseGate = deferred<void>();
    const parseStarted = deferred<void>();
    const parseCalls: string[] = [];
    (MetadataParser.parseStructureOnly as unknown as typeof MetadataParser.parseStructureOnly) = async (configPath) => {
      parseCalls.push(configPath);
      parseStarted.resolve(undefined);
      await parseGate.promise;
      throw new Error('failure after quiesce');
    };
    const { state, provider } = createStateWithProvider();
    const lifecycle = createTrackedLifecycle(state);
    try {
      const loading = lifecycle.loadMetadataTree();
      await parseStarted.promise;
      const quiescence = lifecycle.quiesce();
      parseGate.resolve(undefined);

      await assert.rejects(
        loading,
        (error: unknown) => error instanceof MetadataReloadError && error.code === 'RELOAD_DISPOSED',
      );
      await quiescence;
      assert.deepStrictEqual(parseCalls, [configPaths[0]]);
      assert.deepStrictEqual(provider.getRootNodes(), []);
      assert.deepStrictEqual(lifecycle.metadataWatchers, []);
      assert.deepStrictEqual(vscodeTestState.warningLog, []);
    } finally {
      parseGate.resolve(undefined);
      await lifecycle.dispose();
    }
  });

  test('a disposed reload error from one root remains globally fatal', async () => {
    const workspaceFolderPath = 'C:/workspace/disposed-root-error';
    const configPaths = ['disposed-a', 'neighbor-b'].map((name) => `${workspaceFolderPath}/${name}`);
    vscodeTestState.mockWorkspaceFolders = [
      { name: 'disposed-root-error', index: 0, uri: vscode.Uri.file(workspaceFolderPath) },
    ];
    stubDiscovery({ configs: configPaths.map((configPath) => ({ configPath, workspaceFolderPath })) });
    const parseCalls: string[] = [];
    const disposedFailure = new MetadataReloadError('RELOAD_DISPOSED', 'synthetic disposal error');
    (MetadataParser.parseStructureOnly as unknown as typeof MetadataParser.parseStructureOnly) = async (configPath) => {
      parseCalls.push(configPath);
      throw disposedFailure;
    };
    const { state, provider } = createStateWithProvider();
    const lifecycle = createTrackedLifecycle(state);
    try {
      await assert.rejects(lifecycle.loadMetadataTree(), (error: unknown) => error === disposedFailure);

      assert.deepStrictEqual(parseCalls, [configPaths[0]]);
      assert.deepStrictEqual(provider.getRootNodes(), []);
      assert.deepStrictEqual(lifecycle.metadataWatchers, []);
      assert.deepStrictEqual(vscodeTestState.warningLog, []);
    } finally {
      await lifecycle.dispose();
    }
  });

  test('cleans up a watcher whose startup fails and publishes only roots with ready watchers', async () => {
    const workspaceFolderPath = 'C:/workspace/partial-watcher-load';
    const configPaths = ['cfg-a', 'cfg-b', 'cfg-c'].map((name) => `${workspaceFolderPath}/${name}`);
    const failingConfigPath = configPaths[1]!;
    vscodeTestState.mockWorkspaceFolders = [
      { name: 'partial-watcher-load', index: 0, uri: vscode.Uri.file(workspaceFolderPath) },
    ];
    stubDiscovery({
      configs: configPaths.map((configPath) => ({ configPath, workspaceFolderPath })),
      packages: [{ filePath: `${workspaceFolderPath}/release.cf`, workspaceFolderPath }],
    });
    (MetadataParser.parseStructureOnly as unknown as typeof MetadataParser.parseStructureOnly) = async (configPath) => ({
      id: 'configuration',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: { comment: configPath },
      children: [],
    });

    const watcherStarts: string[] = [];
    const watcherRoots = new Map<MetadataWatcherService, string>();
    const failingWatcherDisposals: string[] = [];
    MetadataWatcherService.prototype.start = function (configRoot, _callbacks): void {
      watcherStarts.push(configRoot);
      watcherRoots.set(this, configRoot);
      if (configRoot === failingConfigPath) {
        throw new Error('synthetic watcher startup failure');
      }
    };
    MetadataWatcherService.prototype.dispose = function (): void {
      const configRoot = watcherRoots.get(this);
      if (configRoot === failingConfigPath) {
        failingWatcherDisposals.push(failingConfigPath);
      }
      watcherDisposals += 1;
    };

    const { state, provider } = createStateWithProvider();
    const lifecycle = createTrackedLifecycle(state);
    try {
      await lifecycle.loadMetadataTree();

      const expectedConfigPaths = configPaths.filter((configPath) => configPath !== failingConfigPath);
      assert.deepStrictEqual(
        provider.getRootNodes()
          .filter((root) => root.type === MetadataType.Configuration)
          .map((root) => root.properties.comment),
        expectedConfigPaths,
      );
      assert.deepStrictEqual(failingWatcherDisposals, [failingConfigPath]);
      assert.strictEqual(lifecycle.metadataWatchers.length, expectedConfigPaths.length);
      assert.strictEqual(vscodeTestState.warningLog.length, 1);
      assert.ok(vscodeTestState.warningLog[0]!.includes(failingConfigPath));
      assert.deepStrictEqual(vscodeTestState.informationLog, []);
    } finally {
      await lifecycle.dispose();
    }
  });

  test('all failed roots preserve the last published roots and watchers and rethrow the first diagnostic', async () => {
    const workspaceFolderPath = 'C:/workspace/all-roots-failed';
    const previousConfigPath = `${workspaceFolderPath}/previous`;
    vscodeTestState.mockWorkspaceFolders = [
      { name: 'all-roots-failed', index: 0, uri: vscode.Uri.file(workspaceFolderPath) },
    ];
    stubDiscovery({ configs: [{ configPath: previousConfigPath, workspaceFolderPath }] });
    stubSuccessfulTreeParsing();
    const { state, provider } = createStateWithProvider();
    const lifecycle = createTrackedLifecycle(state);
    try {
      await lifecycle.loadMetadataTree();
      const previousRoots = provider.getRootNodes();
      const previousWatchers = [...lifecycle.metadataWatchers];
      const firstFailure = new Error('first configuration root failed');

      stubDiscovery({
        configs: ['failed-a', 'failed-b'].map((name) => ({
          configPath: `${workspaceFolderPath}/${name}`,
          workspaceFolderPath,
        })),
      });
      (MetadataParser.parseStructureOnly as unknown as typeof MetadataParser.parseStructureOnly) = async () => {
        throw firstFailure;
      };

      await assert.rejects(lifecycle.loadMetadataTree(), (error: unknown) => error === firstFailure);

      assert.deepStrictEqual(provider.getRootNodes(), previousRoots);
      assert.deepStrictEqual(lifecycle.metadataWatchers, previousWatchers);
      assert.strictEqual(watcherDisposals, 0, 'all-failed preparation must keep the existing watcher set alive');
      assert.deepStrictEqual(vscodeTestState.warningLog, []);
    } finally {
      await lifecycle.dispose();
    }
  });

  test('watcher cleanup continues when disposal and warning diagnostics both throw', async () => {
    const workspaceFolderPath = 'C:/workspace/watcher-cleanup';
    vscodeTestState.mockWorkspaceFolders = [
      { name: 'watcher-cleanup', index: 0, uri: vscode.Uri.file(workspaceFolderPath) },
    ];
    stubDiscovery({
      configs: [
        { configPath: `${workspaceFolderPath}/cfg-a`, workspaceFolderPath },
        { configPath: `${workspaceFolderPath}/cfg-b`, workspaceFolderPath },
      ],
    });
    stubSuccessfulTreeParsing();
    const { state } = createStateWithProvider();
    const lifecycle = createTrackedLifecycle(state);
    await lifecycle.loadMetadataTree();
    assert.strictEqual(lifecycle.metadataWatchers.length, 2, 'the regression needs multiple owned watcher instances');

    const originalDispose = MetadataWatcherService.prototype.dispose;
    const originalWarn = Logger.warn;
    const watcherFailure = new Error('first watcher failed to dispose');
    const diagnosticsFailure = new Error('warning logger unavailable');
    let watcherDisposalsAttempted = 0;
    MetadataWatcherService.prototype.dispose = function (): void {
      watcherDisposalsAttempted += 1;
      if (watcherDisposalsAttempted === 1) {
        throw watcherFailure;
      }
    };
    Logger.warn = () => {
      throw diagnosticsFailure;
    };

    try {
      const quiescence = lifecycle.quiesce();
      assert.deepStrictEqual(lifecycle.metadataWatchers, [], 'quiescence removes the published watcher snapshot immediately');
      assert.strictEqual(lifecycle.quiesce(), quiescence, 'quiesce must remain idempotent');
      await quiescence;
      assert.strictEqual(watcherDisposalsAttempted, 2, 'one disposal failure and logger failure must not skip later watchers');

      const disposal = lifecycle.dispose();
      assert.strictEqual(lifecycle.dispose(), disposal, 'terminal disposal must remain idempotent');
      await disposal;
      assert.strictEqual(watcherDisposalsAttempted, 2, 'repeated quiesce/dispose must not dispose watchers twice');
    } finally {
      MetadataWatcherService.prototype.dispose = originalDispose;
      Logger.warn = originalWarn;
    }
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
    const lifecycle = createTrackedLifecycle(state);
    try {
      await lifecycle.loadMetadataTree();
      const rootsBeforeReload = provider.getRootNodes();
      const siblingRoot = rootsBeforeReload[1];
      const watchersBeforeReload = [...lifecycle.metadataWatchers];
      parseCalls.length = 0;
      revisions.set(configA, 2);

      await executeSingleReload(lifecycle, configA);

      const rootsAfterReload = provider.getRootNodes();
      assert.deepStrictEqual(parseCalls, [configA]);
      assert.strictEqual(rootsAfterReload.length, 2);
      assert.notStrictEqual(rootsAfterReload[0], rootsBeforeReload[0]);
      assert.strictEqual(rootsAfterReload[0].properties.comment, '2');
      assert.strictEqual(rootsAfterReload[1], siblingRoot, 'unaffected root must retain object identity');
      assert.deepStrictEqual(lifecycle.metadataWatchers, watchersBeforeReload, 'targeted reload must preserve watcher sessions');
    } finally {
      await lifecycle.dispose();
    }
  });

  test('keeps case-distinct targeted reload generations separate on case-sensitive hosts', async function () {
    if (process.platform === 'win32') {
      this.skip();
      return;
    }

    const workspaceFolderPath = '/workspace';
    const configA = '/workspace/Config';
    const configB = '/workspace/config';
    vscodeTestState.mockWorkspaceFolders = [
      { name: 'workspace', index: 0, uri: vscode.Uri.file(workspaceFolderPath) },
    ];
    stubDiscovery({
      configs: [
        { configPath: configA, workspaceFolderPath },
        { configPath: configB, workspaceFolderPath },
      ],
    });

    const revisions = new Map([[configA, 1], [configB, 1]]);
    const parseCalls: string[] = [];
    let pauseNextParseForA = false;
    let parseAStarted: (() => void) | undefined;
    let parseAGate: Promise<void> | undefined;
    let releaseParseA: (() => void) | undefined;
    (MetadataParser.parseStructureOnly as unknown as typeof MetadataParser.parseStructureOnly) =
      async (configPath) => {
        parseCalls.push(configPath);
        if (pauseNextParseForA && configPath === configA) {
          pauseNextParseForA = false;
          parseAStarted?.();
          await parseAGate;
        }
        return {
          id: `configuration:${configPath}`,
          name: 'Configuration',
          type: MetadataType.Configuration,
          properties: { comment: String(revisions.get(configPath)) },
          children: [],
        };
      };
    (FormatDetector.detect as unknown as typeof FormatDetector.detect) =
      async () => ConfigFormat.Designer;

    const { state, provider } = createStateWithProvider();
    const lifecycle = createTrackedLifecycle(state);
    const coordinator = createReloadCoordinator(lifecycle);
    try {
      await lifecycle.loadMetadataTree();
      assert.deepStrictEqual(
        provider.getRootNodes().map((root) => root.properties.comment),
        ['1', '1'],
      );

      parseCalls.length = 0;
      revisions.set(configA, 2);
      const firstReload = await coordinator.requestReload(configA, 'repository', { debounceMs: 0 }).completed;
      assert.strictEqual(firstReload.succeeded, true);
      revisions.set(configB, 5);
      const secondReload = await coordinator.requestReload(configB, 'repository', { debounceMs: 0 }).completed;
      assert.strictEqual(secondReload.succeeded, true);

      assert.deepStrictEqual(parseCalls, [configA, configB]);
      assert.deepStrictEqual(
        provider.getRootNodes().map((root) => root.properties.comment),
        ['2', '5'],
        'sequential reloads must publish the requested root and preserve its case-distinct sibling',
      );

      parseCalls.length = 0;
      revisions.set(configA, 3);
      revisions.set(configB, 7);
      const parseAStartedPromise = new Promise<void>((resolve) => {
        parseAStarted = resolve;
      });
      parseAGate = new Promise<void>((resolve) => {
        releaseParseA = resolve;
      });
      pauseNextParseForA = true;

      const reloadA = coordinator.requestReload(configA, 'repository', { debounceMs: 0 });
      await parseAStartedPromise;
      const reloadB = coordinator.requestReload(configB, 'repository', { debounceMs: 0 });
      releaseParseA?.();
      const [reloadAResult, reloadBResult] = await Promise.all([reloadA.completed, reloadB.completed]);
      assert.strictEqual(reloadAResult.succeeded, true);
      assert.strictEqual(reloadBResult.succeeded, true);

      assert.deepStrictEqual(parseCalls.sort(), [configA, configB].sort());
      assert.deepStrictEqual(
        provider.getRootNodes().map((root) => root.properties.comment),
        ['3', '7'],
        'concurrent reloads must not drop one case-distinct root generation',
      );
    } finally {
      releaseParseA?.();
      await coordinator.dispose();
      await lifecycle.dispose();
    }
  });

  test('coalesces case aliases for targeted reload on Windows', async function () {
    if (process.platform !== 'win32') {
      this.skip();
      return;
    }

    const workspaceFolderPath = 'C:/workspace';
    const configCanonical = 'C:/workspace/Config';
    const configLowerAlias = 'c:/workspace/config';
    vscodeTestState.mockWorkspaceFolders = [
      { name: 'workspace', index: 0, uri: vscode.Uri.file(workspaceFolderPath) },
    ];
    stubDiscovery({
      configs: [
        { configPath: configCanonical, workspaceFolderPath },
      ],
    });

    let revision = 1;
    const parseCalls: string[] = [];
    (MetadataParser.parseStructureOnly as unknown as typeof MetadataParser.parseStructureOnly) =
      async (configPath) => {
        parseCalls.push(configPath);
        return {
          id: `configuration:${configPath}`,
          name: 'Configuration',
          type: MetadataType.Configuration,
          properties: { comment: String(revision) },
          children: [],
        };
      };
    (FormatDetector.detect as unknown as typeof FormatDetector.detect) =
      async () => ConfigFormat.Designer;

    const { state, provider } = createStateWithProvider();
    const lifecycle = createTrackedLifecycle(state);
    const coordinator = createReloadCoordinator(lifecycle);
    try {
      await lifecycle.loadMetadataTree();
      assert.deepStrictEqual(
        provider.getRootNodes().map((root) => root.properties.comment),
        ['1'],
      );

      parseCalls.length = 0;
      revision = 2;
      // Reload via lower case alias
      const reload = await coordinator.requestReload(configLowerAlias, 'repository', { debounceMs: 0 }).completed;
      assert.strictEqual(reload.succeeded, true);

      assert.strictEqual(parseCalls.length, 1);
      assert.deepStrictEqual(
        provider.getRootNodes().map((root) => root.properties.comment),
        ['2'],
        'reloading via case alias on Windows must update the canonical root',
      );
    } finally {
      await coordinator.dispose();
      await lifecycle.dispose();
    }
  });


  test('targeted reload starts warmup with preferredRootId preserving other roots in queue', async () => {
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
    (MetadataParser.parseStructureOnly as unknown as typeof MetadataParser.parseStructureOnly) =
      async (configPath) => ({
        id: `configuration:${configPath}`,
        name: 'Configuration',
        type: MetadataType.Configuration,
        properties: {},
        children: [],
      });
    (FormatDetector.detect as unknown as typeof FormatDetector.detect) =
      async () => ConfigFormat.Designer;

    const { state, provider } = createStateWithProvider();
    const warmupCalls: Array<any> = [];
    provider.startTypeContentsCacheWarmup = ((options: any) => {
      warmupCalls.push(options);
    }) as any;

    const lifecycle = createTrackedLifecycle(state);
    try {
      await lifecycle.loadMetadataTree();
      warmupCalls.length = 0;

      await executeSingleReload(lifecycle, configA);

      assert.strictEqual(warmupCalls.length, 1);
      assert.strictEqual(warmupCalls[0]?.preferredRootId, provider.getRootNodes()[0].id);
      assert.strictEqual(warmupCalls[0]?.rootIds, undefined, 'rootIds must not be restricted to single root on reload');
    } finally {
      await lifecycle.dispose();
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

    const { state, provider } = createStateWithProvider(testExtensionContext(globalStoragePath));
    const lifecycle = createTrackedLifecycle(state);
    const coordinator = createReloadCoordinator(lifecycle);
    try {
      await lifecycle.loadMetadataTree();
      const firstReload = coordinator.requestReload(configPath, 'repository', {
        operationId: 'same-reload-id',
        debounceMs: 0,
      });
      await oldParseStartedPromise;
      await fs.promises.writeFile(path.join(configPath, 'Configuration.xml'), '<Configuration revision="2"/>');
      const secondReload = coordinator.requestReload(configPath, 'create-command', {
        operationId: 'same-reload-id',
        debounceMs: 0,
      });
      releaseOldParse();

      const [firstResult, secondResult] = await Promise.all([firstReload.completed, secondReload.completed]);

      assert.strictEqual(parseCall, 3, 'trailing generation must reparse instead of consuming stale cache');
      assert.strictEqual(firstResult.succeeded, true);
      assert.strictEqual(secondResult.succeeded, true);
      assert.strictEqual(firstResult.reason, 'repository');
      assert.strictEqual(secondResult.reason, 'create-command');
      assert.strictEqual(provider.getRootNodes()[0]?.properties.comment, 'fresh');
      assert.strictEqual(
        await loadTreeFromCache(globalStoragePath, configPath),
        null,
        'targeted generations must not repopulate shared tree cache',
      );
    } finally {
      await coordinator.dispose();
      await lifecycle.dispose();
      await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('coordinator keeps a superseded lifecycle parse private and completes same-ID requests on one fresh attempt', async () => {
    const workspaceFolderPath = 'C:/workspace/single-attempt';
    const configPath = `${workspaceFolderPath}/cfg`;
    vscodeTestState.mockWorkspaceFolders = [
      { name: 'single-attempt', index: 0, uri: vscode.Uri.file(workspaceFolderPath) },
    ];
    stubDiscovery({ configs: [{ configPath, workspaceFolderPath }] });

    let revision = 'base';
    let parseCall = 0;
    const firstTargetedParseStarted = deferred<void>();
    const releaseFirstTargetedParse = deferred<void>();
    const retryParseStarted = deferred<void>();
    const releaseRetryParse = deferred<void>();
    (MetadataParser.parseStructureOnly as unknown as typeof MetadataParser.parseStructureOnly) = async () => {
      parseCall += 1;
      const parsedRevision = revision;
      if (parseCall === 2) {
        firstTargetedParseStarted.resolve(undefined);
        await releaseFirstTargetedParse.promise;
      } else if (parseCall === 3) {
        retryParseStarted.resolve(undefined);
        await releaseRetryParse.promise;
      }
      return {
        id: 'configuration',
        name: 'Configuration',
        type: MetadataType.Configuration,
        properties: { comment: parsedRevision },
        children: [],
      };
    };
    (FormatDetector.detect as unknown as typeof FormatDetector.detect) = async () => ConfigFormat.Designer;

    const { state, provider } = createStateWithProvider();
    const lifecycle = createTrackedLifecycle(state);
    let runnerAttempts = 0;
    const coordinator = new ReloadCoordinatorService(async ({ configPath: requestedConfigPath, canPublish }) => {
      runnerAttempts += 1;
      return lifecycle.executeConfigurationReload(requestedConfigPath, canPublish);
    }, { defaultDebounceMs: 0 });
    try {
      await lifecycle.loadMetadataTree();
      revision = 'stale';
      const firstHandle = coordinator.requestReload(configPath, 'repository', {
        operationId: 'shared-id',
        debounceMs: 0,
      });
      let firstSettled = false;
      firstHandle.completed.then(() => { firstSettled = true; });
      await firstTargetedParseStarted.promise;

      revision = 'current';
      const trailingHandle = coordinator.requestReload(configPath, 'create-command', {
        operationId: 'shared-id',
        debounceMs: 0,
      });
      let trailingSettled = false;
      trailingHandle.completed.then(() => { trailingSettled = true; });
      releaseFirstTargetedParse.resolve(undefined);
      await retryParseStarted.promise;

      assert.strictEqual(firstSettled, false, 'active request cannot complete from a parse superseded by the trailing request');
      assert.strictEqual(trailingSettled, false, 'trailing request remains attached until the fresh tree is published');
      assert.strictEqual(
        provider.getRootNodes()[0]?.properties.comment,
        'base',
        'stale targeted output must not publish before the retry',
      );

      releaseRetryParse.resolve(undefined);
      const [firstResult, trailingResult] = await Promise.all([
        firstHandle.completed,
        trailingHandle.completed,
      ]);
      assert.strictEqual(parseCall, 3, 'one superseded attempt plus one fresh attempt follow the initial full load');
      assert.strictEqual(runnerAttempts, 2, 'the coordinator owns the retry instead of a lifecycle loop');
      assert.strictEqual(provider.getRootNodes()[0]?.properties.comment, 'current');
      assert.strictEqual(firstResult.succeeded, true);
      assert.strictEqual(trailingResult.succeeded, true);
      assert.strictEqual(firstResult.reason, 'repository');
      assert.strictEqual(trailingResult.reason, 'create-command');
    } finally {
      releaseFirstTargetedParse.resolve(undefined);
      releaseRetryParse.resolve(undefined);
      await coordinator.dispose();
      await lifecycle.dispose();
    }
  });

  test('coordinator retries after a full load supersedes one targeted lifecycle attempt', async () => {
    const workspaceFolderPath = 'C:/workspace/full-load-race';
    const configPath = `${workspaceFolderPath}/cfg`;
    vscodeTestState.mockWorkspaceFolders = [
      { name: 'full-load-race', index: 0, uri: vscode.Uri.file(workspaceFolderPath) },
    ];
    stubDiscovery({ configs: [{ configPath, workspaceFolderPath }] });

    let parseCall = 0;
    const firstTargetedParseStarted = deferred<void>();
    const releaseFirstTargetedParse = deferred<void>();
    const fullParseStarted = deferred<void>();
    const releaseFullParse = deferred<void>();
    const retryParseStarted = deferred<void>();
    const releaseRetryParse = deferred<void>();
    (MetadataParser.parseStructureOnly as unknown as typeof MetadataParser.parseStructureOnly) = async () => {
      parseCall += 1;
      const revision = parseCall === 1
        ? 'base'
        : parseCall === 2
          ? 'stale-targeted'
          : parseCall === 3
            ? 'fresh-full'
            : 'fresh-targeted';
      if (parseCall === 2) {
        firstTargetedParseStarted.resolve(undefined);
        await releaseFirstTargetedParse.promise;
      } else if (parseCall === 3) {
        fullParseStarted.resolve(undefined);
        await releaseFullParse.promise;
      } else if (parseCall === 4) {
        retryParseStarted.resolve(undefined);
        await releaseRetryParse.promise;
      }
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
    const lifecycle = createTrackedLifecycle(state);
    let runnerAttempts = 0;
    const coordinator = new ReloadCoordinatorService(async ({ configPath: requestedConfigPath, canPublish }) => {
      runnerAttempts += 1;
      return lifecycle.executeConfigurationReload(requestedConfigPath, canPublish);
    }, { defaultDebounceMs: 0 });
    try {
      await lifecycle.loadMetadataTree();
      const request = coordinator.requestReload(configPath, 'repository', {
        operationId: 'full-race',
        debounceMs: 0,
      });
      let requestSettled = false;
      request.completed.then(() => { requestSettled = true; });
      const fullLoad = (async () => {
        await firstTargetedParseStarted.promise;
        await lifecycle.loadMetadataTree();
      })();
      await fullParseStarted.promise;
      releaseFirstTargetedParse.resolve(undefined);
      releaseFullParse.resolve(undefined);
      await retryParseStarted.promise;

      assert.strictEqual(runnerAttempts, 2, 'full-load supersession must return to the coordinator for its retry');
      assert.strictEqual(requestSettled, false, 'targeted handle stays pending until the post-full-load retry publishes');
      assert.strictEqual(
        provider.getRootNodes()[0]?.properties.comment,
        'fresh-full',
        'the full load publishes its own fresh discovery before the targeted retry',
      );

      releaseRetryParse.resolve(undefined);
      const result = await request.completed;
      await fullLoad;
      assert.strictEqual(result.succeeded, true);
      assert.strictEqual(parseCall, 4, 'one targeted attempt, one full load and one coordinator retry follow initialization');
      assert.strictEqual(provider.getRootNodes()[0]?.properties.comment, 'fresh-targeted');
    } finally {
      releaseFirstTargetedParse.resolve(undefined);
      releaseFullParse.resolve(undefined);
      releaseRetryParse.resolve(undefined);
      await coordinator.dispose();
      await lifecycle.dispose();
    }
  });

  test('trailing request supersedes an attempt during cache invalidation before parse and both wait for one fresh parse', async () => {
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'metadata-preparse-supersession-'));
    const workspaceFolderPath = path.join(tempRoot, 'workspace');
    const configPath = path.join(workspaceFolderPath, 'cfg');
    const globalStoragePath = path.join(tempRoot, 'global-storage');
    await fs.promises.mkdir(configPath, { recursive: true });
    await fs.promises.writeFile(path.join(configPath, 'Configuration.xml'), '<Configuration/>');
    vscodeTestState.mockWorkspaceFolders = [
      { name: 'preparse-supersession', index: 0, uri: vscode.Uri.file(workspaceFolderPath) },
    ];
    stubDiscovery({ configs: [{ configPath, workspaceFolderPath }] });

    let revision = 'base';
    let parseCalls = 0;
    let runnerAttempts = 0;
    let invalidationCalls = 0;
    const invalidationStarted = deferred<void>();
    const releaseInvalidation = deferred<void>();
    const retryParseStarted = deferred<void>();
    const releaseRetryParse = deferred<void>();
    (MetadataParser.invalidateTypeContentsCache as unknown as typeof MetadataParser.invalidateTypeContentsCache) =
      async () => {
        invalidationCalls += 1;
        if (invalidationCalls === 1) {
          invalidationStarted.resolve(undefined);
          await releaseInvalidation.promise;
        }
      };
    (MetadataParser.parseStructureOnly as unknown as typeof MetadataParser.parseStructureOnly) = async () => {
      parseCalls += 1;
      const parsedRevision = revision;
      if (parseCalls === 2) {
        retryParseStarted.resolve(undefined);
        await releaseRetryParse.promise;
      }
      return {
        id: 'configuration',
        name: 'Configuration',
        type: MetadataType.Configuration,
        properties: { comment: parsedRevision, bslLanguage: 'ru' },
        children: [],
      };
    };
    (FormatDetector.detect as unknown as typeof FormatDetector.detect) = async () => ConfigFormat.Designer;

    const { state, provider } = createStateWithProvider(testExtensionContext(globalStoragePath));
    const lifecycle = createTrackedLifecycle(state);
    const coordinator = new ReloadCoordinatorService(async ({ configPath: requestedConfigPath, canPublish }) => {
      runnerAttempts += 1;
      return lifecycle.executeConfigurationReload(requestedConfigPath, canPublish);
    }, { defaultDebounceMs: 0 });
    try {
      await lifecycle.loadMetadataTree();
      assert.strictEqual(provider.getRootNodes()[0]?.properties.comment, 'base');
      const baselineRoot = provider.getRootNodes()[0];
      assert.ok(baselineRoot);
      await saveTreeToCache(globalStoragePath, configPath, baselineRoot);
      assert.ok(await loadTreeFromCache(globalStoragePath, configPath), 'initial full load should establish a cache entry');

      const active = coordinator.requestReload(configPath, 'repository', {
        operationId: 'preparse-active',
        debounceMs: 0,
      });
      let activeSettled = false;
      void active.completed.then(() => { activeSettled = true; });
      await invalidationStarted.promise;

      revision = 'fresh';
      const trailing = coordinator.requestReload(configPath, 'create-command', {
        operationId: 'preparse-trailing',
        debounceMs: 0,
      });
      let trailingSettled = false;
      void trailing.completed.then(() => { trailingSettled = true; });
      releaseInvalidation.resolve(undefined);
      await retryParseStarted.promise;

      assert.strictEqual(runnerAttempts, 2, 'the rejected pre-parse attempt returns ownership to the coordinator');
      assert.strictEqual(parseCalls, 2, 'only the fresh retry performs a targeted parse after initialization');
      assert.strictEqual(activeSettled, false, 'the active handle waits for the fresh retry');
      assert.strictEqual(trailingSettled, false, 'the trailing handle waits for the same fresh retry');
      assert.strictEqual(provider.getRootNodes()[0]?.properties.comment, 'base', 'the retry must remain private until parse completion');
      assert.strictEqual(await loadTreeFromCache(globalStoragePath, configPath), null, 'neither targeted attempt may republish tree cache');

      releaseRetryParse.resolve(undefined);
      const [activeResult, trailingResult] = await Promise.all([active.completed, trailing.completed]);
      assert.strictEqual(activeResult.succeeded, true);
      assert.strictEqual(trailingResult.succeeded, true);
      assert.strictEqual(activeResult.reason, 'repository');
      assert.strictEqual(trailingResult.reason, 'create-command');
      assert.strictEqual(parseCalls, 2);
      assert.strictEqual(provider.getRootNodes()[0]?.properties.comment, 'fresh');
      assert.strictEqual(await loadTreeFromCache(globalStoragePath, configPath), null);
    } finally {
      releaseInvalidation.resolve(undefined);
      releaseRetryParse.resolve(undefined);
      await coordinator.dispose();
      await lifecycle.dispose();
      await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('full-load failure while targeted reload waits completes negatively without retry or stale publication', async () => {
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'metadata-full-load-failure-'));
    const workspaceFolderPath = path.join(tempRoot, 'workspace');
    const configPath = path.join(workspaceFolderPath, 'cfg');
    const globalStoragePath = path.join(tempRoot, 'global-storage');
    await fs.promises.mkdir(configPath, { recursive: true });
    await fs.promises.writeFile(path.join(configPath, 'Configuration.xml'), '<Configuration/>');
    vscodeTestState.mockWorkspaceFolders = [
      { name: 'full-load-failure', index: 0, uri: vscode.Uri.file(workspaceFolderPath) },
    ];
    stubDiscovery({ configs: [{ configPath, workspaceFolderPath }] });

    let parseCalls = 0;
    let runnerAttempts = 0;
    const fullParseStarted = deferred<void>();
    const rejectFullParse = (() => {
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; });
      return { promise, reject };
    })();
    const targetedInvalidationStarted = deferred<void>();
    const diskInvalidationStarted = deferred<void>();
    const releaseDiskInvalidation = deferred<void>();
    const mutableDiskCache = diskCache as unknown as { invalidateTreeCache: typeof diskCache.invalidateTreeCache };
    const originalInvalidateTreeCache = diskCache.invalidateTreeCache;
    mutableDiskCache.invalidateTreeCache = async () => {
      diskInvalidationStarted.resolve(undefined);
      await releaseDiskInvalidation.promise;
    };
    (MetadataParser.invalidateTypeContentsCache as unknown as typeof MetadataParser.invalidateTypeContentsCache) =
      async () => { targetedInvalidationStarted.resolve(undefined); };
    (MetadataParser.parseStructureOnly as unknown as typeof MetadataParser.parseStructureOnly) = async () => {
      parseCalls += 1;
      if (parseCalls === 2) {
        fullParseStarted.resolve(undefined);
        await rejectFullParse.promise;
      }
      return {
        id: 'configuration',
        name: 'Configuration',
        type: MetadataType.Configuration,
        properties: { comment: 'base', bslLanguage: 'ru' },
        children: [],
      };
    };
    (FormatDetector.detect as unknown as typeof FormatDetector.detect) = async () => ConfigFormat.Designer;

    const { state, provider } = createStateWithProvider(testExtensionContext(globalStoragePath));
    const lifecycle = createTrackedLifecycle(state);
    const coordinator = new ReloadCoordinatorService(async ({ configPath: requestedConfigPath, canPublish }) => {
      runnerAttempts += 1;
      return lifecycle.executeConfigurationReload(requestedConfigPath, canPublish);
    }, { defaultDebounceMs: 0 });
    try {
      await lifecycle.loadMetadataTree();
      await fs.promises.writeFile(path.join(configPath, 'Configuration.xml'), '<Configuration revision="2"/>');
      const fullLoad = lifecycle.loadMetadataTree().then(
        () => ({ succeeded: true as const }),
        (error: unknown) => ({ succeeded: false as const, error }),
      );
      await fullParseStarted.promise;

      const targeted = coordinator.requestReload(configPath, 'repository', {
        operationId: 'waited-targeted',
        debounceMs: 0,
      });
      let targetedSettled = false;
      void targeted.completed.then(() => { targetedSettled = true; });
      await Promise.all([targetedInvalidationStarted.promise, diskInvalidationStarted.promise]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.strictEqual(targetedSettled, false, 'the targeted handle remains pending while the full parse is unresolved');
      assert.strictEqual(parseCalls, 2, 'targeted parsing must wait until the active full parse finishes');

      rejectFullParse.reject(new Error('full-tree parse failed'));
      const fullLoadResult = await fullLoad;
      releaseDiskInvalidation.resolve(undefined);
      const targetedResult = await targeted.completed;

      assert.strictEqual(fullLoadResult.succeeded, false);
      assert.strictEqual(targetedResult.succeeded, false, 'a failed full-load wait must not become a false success');
      assert.strictEqual(targetedResult.failure?.code, 'UNKNOWN_RELOAD_FAILURE');
      assert.match(targetedResult.error ?? '', /full-tree parse failed/u);
      assert.strictEqual(runnerAttempts, 1, 'a failed full-load wait is final and does not schedule a targeted retry');
      assert.strictEqual(parseCalls, 2, 'no targeted parse follows the failed full load');
      assert.strictEqual(coordinator.getState(configPath).lastRunSucceeded, false);
      assert.strictEqual(provider.getRootNodes()[0]?.properties.comment, 'base');
      assert.strictEqual(await loadTreeFromCache(globalStoragePath, configPath), null);
    } finally {
      rejectFullParse.reject(new Error('test cleanup released the full parse'));
      releaseDiskInvalidation.resolve(undefined);
      await coordinator.dispose();
      await lifecycle.dispose();
      mutableDiskCache.invalidateTreeCache = originalInvalidateTreeCache;
      await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('coordinator and lifecycle disposal settle an active targeted handle without late publication or retry', async () => {
    const workspaceFolderPath = 'C:/workspace/dispose-targeted';
    const configPath = `${workspaceFolderPath}/cfg`;
    vscodeTestState.mockWorkspaceFolders = [
      { name: 'dispose-targeted', index: 0, uri: vscode.Uri.file(workspaceFolderPath) },
    ];
    stubDiscovery({ configs: [{ configPath, workspaceFolderPath }] });

    let parseCall = 0;
    const targetedParseStarted = deferred<void>();
    const releaseTargetedParse = deferred<void>();
    (MetadataParser.parseStructureOnly as unknown as typeof MetadataParser.parseStructureOnly) = async () => {
      parseCall += 1;
      const revision = parseCall === 1 ? 'base' : 'late';
      if (parseCall === 2) {
        targetedParseStarted.resolve(undefined);
        await releaseTargetedParse.promise;
      }
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
    const lifecycle = createTrackedLifecycle(state);
    const coordinator = createReloadCoordinator(lifecycle);
    try {
      await lifecycle.loadMetadataTree();
      const request = coordinator.requestReload(configPath, 'repository', {
        operationId: 'dispose-targeted',
        debounceMs: 0,
      });
      await targetedParseStarted.promise;

      const disposal = coordinator.dispose();
      await lifecycle.dispose();
      const result = await request.completed;
      assert.strictEqual(result.succeeded, false);
      assert.strictEqual(result.failure?.code, 'RELOAD_DISPOSED');

      releaseTargetedParse.resolve(undefined);
      await disposal;
      assert.strictEqual(parseCall, 2, 'disposed work must not schedule a second attempt');
      assert.strictEqual(
        provider.getRootNodes()[0]?.properties.comment,
        'base',
        'an in-flight targeted parse must not publish after disposal',
      );
    } finally {
      releaseTargetedParse.resolve(undefined);
      await coordinator.dispose();
      await lifecycle.dispose();
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

    const { state, provider } = createStateWithProvider(testExtensionContext(globalStoragePath));
    const lifecycle = createTrackedLifecycle(state);
    const coordinator = createReloadCoordinator(lifecycle);
    try {
      const fullLoad = lifecycle.loadMetadataTree();
      await fullParseStartedPromise;
      const targetedReload = coordinator.requestReload(configPath, 'repository', { debounceMs: 0 });
      releaseFullParse();

      const [, targetedResult] = await Promise.all([fullLoad, targetedReload.completed]);

      assert.strictEqual(targetedResult.succeeded, true);
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
      await coordinator.dispose();
      await lifecycle.dispose();
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
    const lifecycle = createTrackedLifecycle(state);
    const loading = lifecycle.loadMetadataTree();
    await parseStartedPromise;
    lifecycle.dispose();
    releaseParse();

    await assert.rejects(
      loading,
      (error: unknown) => error instanceof MetadataReloadError && error.code === 'RELOAD_DISPOSED',
    );
    assert.deepStrictEqual(provider.getRootNodes(), []);
    assert.deepStrictEqual(lifecycle.metadataWatchers, []);
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

    const lifecycle = createTrackedLifecycle(createStateWithProvider().state);
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
