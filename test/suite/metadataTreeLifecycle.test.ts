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
import { ReloadCoordinatorService } from '../../src/services/reloadCoordinatorService';
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

      await executeSingleReload(lifecycle, configA);

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
    const lifecycle = createMetadataTreeLifecycle(state);
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
      lifecycle.dispose();
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
    const lifecycle = createMetadataTreeLifecycle(state);
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
      lifecycle.dispose();
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

    const lifecycle = createMetadataTreeLifecycle(state);
    try {
      await lifecycle.loadMetadataTree();
      warmupCalls.length = 0;

      await executeSingleReload(lifecycle, configA);

      assert.strictEqual(warmupCalls.length, 1);
      assert.strictEqual(warmupCalls[0]?.preferredRootId, provider.getRootNodes()[0].id);
      assert.strictEqual(warmupCalls[0]?.rootIds, undefined, 'rootIds must not be restricted to single root on reload');
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
      lifecycle.dispose();
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
    const lifecycle = createMetadataTreeLifecycle(state);
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
      lifecycle.dispose();
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
    const lifecycle = createMetadataTreeLifecycle(state);
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
      lifecycle.dispose();
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
    const lifecycle = createMetadataTreeLifecycle(state);
    const coordinator = createReloadCoordinator(lifecycle);
    try {
      await lifecycle.loadMetadataTree();
      const request = coordinator.requestReload(configPath, 'repository', {
        operationId: 'dispose-targeted',
        debounceMs: 0,
      });
      await targetedParseStarted.promise;

      const disposal = coordinator.dispose();
      lifecycle.dispose();
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
      lifecycle.dispose();
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
