import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { createMetadataTreeLifecycle, MetadataReloadError } from '../../src/extension/metadataTreeLifecycle';
import { MetadataType, TreeNode } from '../../src/models/treeNode';
import { ConfigFormat, FormatDetector } from '../../src/parsers/formatDetector';
import { MetadataParser } from '../../src/parsers/metadataParser';
import { MetadataTreeDataProvider } from '../../src/providers/treeDataProvider';
import { TreeCacheService } from '../../src/providers/treeCacheService';
import { renderPropertiesBySections } from '../../src/providers/propertiesWebviewContent';
import { saveProperties } from '../../src/providers/propertiesMessageHandler';
import { ConfigurationContextResolver } from '../../src/services/configurationSession/ConfigurationContextResolver';
import { WorkspaceRegistry, WorkspaceRegistryError } from '../../src/services/configurationSession/WorkspaceRegistry';
import { ExtensionState } from '../../src/state/extensionState';
import { saveTreeToCache } from '../../src/utils/diskCache';
import { serializeTree, deserializeTree } from '../../src/utils/treeSerializer';
import { configureConfigurationMutationGateway } from '../../src/services/configurationSession/configurationMutationGateway';
import { resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';

type FakeTreeLoadContext = {
  readonly configurationId: string;
  readonly configPath: string;
  readonly format: ConfigFormat;
};

function fakeContext(
  configurationId: string,
  configPath: string,
  format: ConfigFormat = ConfigFormat.Designer,
): FakeTreeLoadContext {
  return Object.freeze({ configurationId, configPath, format });
}

function makeRoot(id: string, name: string, configPath: string): TreeNode {
  return {
    id,
    name,
    type: MetadataType.Configuration,
    properties: {},
    filePath: path.join(configPath, 'Configuration.xml'),
    children: [],
  };
}

suite('Tree resolved load context', () => {
  const originalDiscoverAllConfigurationRoots = FormatDetector.discoverAllConfigurationRoots;
  const originalDiscoverAllConfigurationPackageFiles = FormatDetector.discoverAllConfigurationPackageFiles;
  const originalDetect = FormatDetector.detect;
  const originalParseStructureOnly = MetadataParser.parseStructureOnly;
  const originalParseTypeIndex = MetadataParser.parseTypeIndex;

  function createState(): { state: ExtensionState; provider: MetadataTreeDataProvider } {
    const state = new ExtensionState();
    const provider = new MetadataTreeDataProvider();
    state.treeDataProvider = provider;
    return { state, provider };
  }

  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
    return { promise, resolve };
  }

  function stubDiscovery(configs: Array<{ configPath: string; workspaceFolderPath: string }>): void {
    (FormatDetector.discoverAllConfigurationRoots as unknown as typeof FormatDetector.discoverAllConfigurationRoots) =
      async () => ({ status: 'authoritative', items: configs, issues: [] });
    (FormatDetector.discoverAllConfigurationPackageFiles as unknown as typeof FormatDetector.discoverAllConfigurationPackageFiles) =
      async () => ({ status: 'authoritative', items: [], issues: [] });
  }

  setup(() => resetVscodeTestState());

  teardown(() => {
    (FormatDetector.discoverAllConfigurationRoots as unknown as typeof FormatDetector.discoverAllConfigurationRoots) =
      originalDiscoverAllConfigurationRoots;
    (FormatDetector.discoverAllConfigurationPackageFiles as unknown as typeof FormatDetector.discoverAllConfigurationPackageFiles) =
      originalDiscoverAllConfigurationPackageFiles;
    (FormatDetector.detect as unknown as typeof FormatDetector.detect) = originalDetect;
    (MetadataParser.parseStructureOnly as unknown as typeof MetadataParser.parseStructureOnly) =
      originalParseStructureOnly;
    (MetadataParser.parseTypeIndex as unknown as typeof MetadataParser.parseTypeIndex) = originalParseTypeIndex;
    resetVscodeTestState();
  });

  test('resolves colliding physical Designer and EDT roots and routes tree/editor loads by registry context', async () => {
    const tempRoot = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tree-context-collision-')));
    const workspace = tempRoot;
    const configA = path.join(tempRoot, 'A_B', 'C');
    const configB = path.join(tempRoot, 'A', 'B_C');
    await fs.promises.mkdir(configA, { recursive: true });
    await fs.promises.mkdir(path.join(configB, 'src', 'Configuration'), { recursive: true });
    await fs.promises.writeFile(
      path.join(configA, 'Configuration.xml'),
      '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core" version="2.20"><Configuration uuid="11111111-1111-1111-1111-111111111111"><Properties><Name>Configuration</Name></Properties><ChildObjects/></Configuration></MetaDataObject>',
      'utf8',
    );
    await fs.promises.writeFile(
      path.join(configB, 'src', 'Configuration', 'Configuration.mdo'),
      '<mdclass:Configuration xmlns:mdclass="http://g5.1c.ru/v8/dt/metadata/mdclass" uuid="22222222-2222-2222-2222-222222222222"/>',
      'utf8',
    );
    const resolvedConfigA = await fs.promises.realpath(configA);
    const resolvedConfigB = await fs.promises.realpath(configB);
    const previousUnderscoreIdA = path.normalize(resolvedConfigA).replace(/\\/g, '_');
    const previousUnderscoreIdB = path.normalize(resolvedConfigB).replace(/\\/g, '_');
    if (process.platform === 'win32') {
      assert.strictEqual(
        previousUnderscoreIdA,
        previousUnderscoreIdB,
        'Windows physical paths collide under the previous backslash-only underscore root ID scheme',
      );
    } else {
      assert.notStrictEqual(
        previousUnderscoreIdA,
        previousUnderscoreIdB,
        'POSIX separators were not rewritten by the previous root ID scheme',
      );
    }
    vscodeTestState.mockWorkspaceFolders = [{ name: 'workspace', index: 0, uri: vscode.Uri.file(workspace) }];
    stubDiscovery([
      { configPath: resolvedConfigA, workspaceFolderPath: workspace },
      { configPath: resolvedConfigB, workspaceFolderPath: workspace },
    ]);
    const registry = new WorkspaceRegistry();
    await registry.registerTargetedRoot({ configPath: resolvedConfigA, format: ConfigFormat.Designer });
    await registry.registerTargetedRoot({ configPath: resolvedConfigB, format: ConfigFormat.EDT });
    const resolver = new ConfigurationContextResolver(registry);
    const contextA = await resolver.resolveFromResource(resolvedConfigA, 'read');
    const contextB = await resolver.resolveFromResource(resolvedConfigB, 'read');
    const { state, provider } = createState();
    state.configurationContextResolver = resolver;
    // Keep background cache warmup out of the routing assertions below.
    provider.startTypeContentsCacheWarmup = () => undefined;

    (MetadataParser.parseStructureOnly as unknown as typeof MetadataParser.parseStructureOnly) = async (configPath) => {
      const root: TreeNode = {
        id: 'parser-root',
        name: 'Configuration',
        type: MetadataType.Configuration,
        properties: {},
        children: [
          { id: 'Catalogs', name: 'Catalogs', type: MetadataType.Catalog, properties: {}, children: [] },
          { id: 'Documents', name: 'Documents', type: MetadataType.Document, properties: {}, children: [] },
        ],
        filePath: path.join(configPath, 'Configuration.xml'),
      };
      for (const child of root.children ?? []) {
        child.parent = root;
      }
      return root;
    };
    // The registry context, rather than an independent detector result, controls routing.
    (FormatDetector.detect as unknown as typeof FormatDetector.detect) = async (configPath) =>
      configPath === resolvedConfigA ? ConfigFormat.EDT : ConfigFormat.Designer;
    const typeIndexCalls: Array<{ configPath: string; typeName: string; format?: ConfigFormat }> = [];
    (MetadataParser.parseTypeIndex as unknown as typeof MetadataParser.parseTypeIndex) = async (
      configPath,
      typeName,
      options,
    ) => {
      typeIndexCalls.push({ configPath, typeName, format: options?.format });
      const type = typeName === 'Documents' ? MetadataType.Document : MetadataType.Catalog;
      return [{ id: `${typeName}.Resolved`, name: path.basename(configPath), type, properties: {} }];
    };

    const lifecycle = createMetadataTreeLifecycle(state);
    try {
      await lifecycle.loadMetadataTree();
      const [rootA, rootB] = provider.getRootNodes();
      assert.notStrictEqual(rootA.id, rootB.id, 'ConfigurationId must prevent underscore path collisions');
      assert.strictEqual(rootA.id, `config:${contextA.configurationId}`);
      assert.strictEqual(rootB.id, `config:${contextB.configurationId}`);

      const rootHtml = renderPropertiesBySections(rootA, false);
      const serializedRoot = serializeTree(rootA);
      const hydratedRoot = deserializeTree(serializedRoot);
      const serializedValue = JSON.parse(serializedRoot) as { configurationId?: string; properties: Record<string, unknown> };
      const mutationGateway = configureConfigurationMutationGateway(async (_resource, _kind, operation) => operation());
      try {
        await saveProperties(rootA, { ...rootA.properties, Synonym: 'Изменённый синоним' }, {
          currentNode: rootA,
          treeDataProvider: provider,
          setIsSaving: () => undefined,
          postMessage: () => undefined,
        } as any);
      } finally {
        mutationGateway.dispose();
      }
      const savedRootXml = await fs.promises.readFile(path.join(resolvedConfigA, 'Configuration.xml'), 'utf8');
      assert.deepStrictEqual({
        topLevelIdentity: (rootA as any).configurationId,
        metadataIdentity: Object.prototype.hasOwnProperty.call(rootA.properties, 'configurationId'),
        renderedIdentity: rootHtml.includes('data-property="configurationId"'),
        serializedRuntimeIdentity: Object.prototype.hasOwnProperty.call(serializedValue, 'configurationId'),
        serializedMetadataIdentity: Object.prototype.hasOwnProperty.call(serializedValue.properties, 'configurationId'),
        hydratedRuntimeIdentity: (hydratedRoot as any).configurationId,
        hydratedMetadataIdentity: Object.prototype.hasOwnProperty.call(hydratedRoot.properties, 'configurationId'),
        savedXmlIdentity: savedRootXml.includes(contextA.configurationId),
        savedSynonym: savedRootXml.includes('Изменённый синоним'),
      }, {
        topLevelIdentity: contextA.configurationId,
        metadataIdentity: false,
        renderedIdentity: false,
        serializedRuntimeIdentity: false,
        serializedMetadataIdentity: false,
        hydratedRuntimeIdentity: undefined,
        hydratedMetadataIdentity: false,
        savedXmlIdentity: false,
        savedSynonym: true,
      }, 'published tree identity must stay out of editable properties, serializer output, and generic XML updates');

      const resolvedFromConflictingTreeNode = await resolver.resolveFromTreeNode({
        configurationId: contextA.configurationId,
        properties: { configurationId: contextB.configurationId },
      } as any, 'read');
      assert.strictEqual(resolvedFromConflictingTreeNode.configurationId, contextA.configurationId);
      const catalogsA = rootA.children!.find((child) => child.id === 'Catalogs')!;
      const catalogsB = rootB.children!.find((child) => child.id === 'Catalogs')!;
      assert.strictEqual(catalogsA.parent, rootA);
      assert.strictEqual((provider as any).isLazyTypeNode(catalogsA), true);
      assert.strictEqual((provider as any).isLazyTypeNode(catalogsB), true);

      await provider.getChildren(catalogsA);
      await provider.getChildren(catalogsB);
      const foregroundRoutes = typeIndexCalls.slice();
      const referencesA = await provider.getReferenceableObjectsForTypeEditor(rootA);
      const objectsB = await provider.getObjectableObjectsForEditor(rootB);
      const callsBeforeScopeCacheHits = typeIndexCalls.length;
      await provider.getReferenceableObjectsForTypeEditor(rootA);
      await provider.getObjectableObjectsForEditor(rootB);

      assert.deepStrictEqual(foregroundRoutes, [
        { configPath: resolvedConfigA, typeName: 'Catalogs', format: ConfigFormat.Designer },
        { configPath: resolvedConfigB, typeName: 'Catalogs', format: ConfigFormat.EDT },
      ]);
      assert.ok(typeIndexCalls.some((call) => call.configPath === resolvedConfigA && call.format === ConfigFormat.Designer));
      assert.ok(typeIndexCalls.some((call) => call.configPath === resolvedConfigB && call.format === ConfigFormat.EDT));
      assert.ok(referencesA.find((group) => group.referenceKind === 'CatalogRef')?.objectNames.includes(path.basename(resolvedConfigA)));
      assert.ok(objectsB.find((group) => group.objectKind === 'CatalogObject')?.objectNames.includes(path.basename(resolvedConfigB)));
      assert.strictEqual(typeIndexCalls.length, callsBeforeScopeCacheHits, 'each editor scope cache must use its own root context');
    } finally {
      lifecycle.dispose();
      await registry.dispose();
      await fs.promises.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('refuses to load without a read-context resolver and preserves the published root', async () => {
    const workspace = 'C:\\workspace';
    const configPath = 'C:\\workspace\\Configuration';
    vscodeTestState.mockWorkspaceFolders = [{ name: 'workspace', index: 0, uri: vscode.Uri.file(workspace) }];
    stubDiscovery([{ configPath, workspaceFolderPath: workspace }]);
    (MetadataParser.parseStructureOnly as unknown as typeof MetadataParser.parseStructureOnly) = async () => ({
      id: 'new-root', name: 'New', type: MetadataType.Configuration, properties: {}, children: [],
    });
    (FormatDetector.detect as unknown as typeof FormatDetector.detect) = async () => ConfigFormat.Designer;
    const { state, provider } = createState();
    const oldRoot = makeRoot('previous-root', 'Previous configuration', configPath);
    provider.setRootNode(oldRoot);

    const lifecycle = createMetadataTreeLifecycle(state);
    let parseCalls = 0;
    (MetadataParser.parseStructureOnly as unknown as typeof MetadataParser.parseStructureOnly) = async () => {
      parseCalls++;
      return { id: 'new-root', name: 'New', type: MetadataType.Configuration, properties: {}, children: [] };
    };
    try {
      await assert.rejects(
        lifecycle.loadMetadataTree(),
        (error: unknown) => error instanceof MetadataReloadError
          && String(error.code) === 'CONFIGURATION_CONTEXT_UNAVAILABLE',
      );
      assert.strictEqual(parseCalls, 0, 'the resolver must fail before tree parsing or disk cache access');
      assert.deepStrictEqual(provider.getRootNodes(), [oldRoot]);
    } finally {
      lifecycle.dispose();
    }
  });

  test('resolver capability failure preserves the published tree and stops before parsing', async () => {
    const workspace = 'C:\\workspace';
    const configPath = 'C:\\workspace\\Configuration';
    vscodeTestState.mockWorkspaceFolders = [{ name: 'workspace', index: 0, uri: vscode.Uri.file(workspace) }];
    stubDiscovery([{ configPath, workspaceFolderPath: workspace }]);
    const { state, provider } = createState();
    const oldRoot = makeRoot('previous-root', 'Previous configuration', configPath);
    provider.setRootNode(oldRoot);
    let parseCalls = 0;
    let watcherDisposals = 0;
    const activeWatcher = { dispose: () => { watcherDisposals++; } } as any;
    state.metadataWatchers = [activeWatcher];
    state.configurationContextResolver = {
      resolveFromResource: async (_resource: string, capability: string) => {
        assert.strictEqual(capability, 'read');
        throw new WorkspaceRegistryError(
          'CONFIGURATION_CAPABILITY_UNSUPPORTED',
          'Read access is unavailable for this configuration.',
        );
      },
    } as any;
    (MetadataParser.parseStructureOnly as unknown as typeof MetadataParser.parseStructureOnly) = async () => {
      parseCalls++;
      return { id: 'new-root', name: 'New', type: MetadataType.Configuration, properties: {}, children: [] };
    };

    const lifecycle = createMetadataTreeLifecycle(state);
    try {
      await assert.rejects(
        lifecycle.loadMetadataTree(),
        (error: unknown) => error instanceof MetadataReloadError
          && String(error.code) === 'CONFIGURATION_CONTEXT_UNAVAILABLE'
          && error.cause instanceof WorkspaceRegistryError
          && error.cause.code === 'CONFIGURATION_CAPABILITY_UNSUPPORTED',
      );
      assert.strictEqual(parseCalls, 0);
      assert.deepStrictEqual(provider.getRootNodes(), [oldRoot]);
      assert.deepStrictEqual(state.metadataWatchers, [activeWatcher]);
      assert.strictEqual(watcherDisposals, 0);
    } finally {
      lifecycle.dispose();
    }
  });

  test('refreshes the runtime marker on a real disk cache hit', async () => {
    const tempRoot = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tree-context-cache-')));
    const configPath = path.join(tempRoot, 'Configuration');
    const storagePath = path.join(tempRoot, 'storage');
    await fs.promises.mkdir(configPath, { recursive: true });
    await fs.promises.writeFile(
      path.join(configPath, 'Configuration.xml'),
      '<MetaDataObject><Configuration uuid="33333333-3333-3333-3333-333333333333"><ChildObjects/></Configuration></MetaDataObject>',
      'utf8',
    );
    const resolvedConfigPath = await fs.promises.realpath(configPath);
    const workspace = tempRoot;
    vscodeTestState.mockWorkspaceFolders = [{ name: 'workspace', index: 0, uri: vscode.Uri.file(workspace) }];
    stubDiscovery([{ configPath: resolvedConfigPath, workspaceFolderPath: workspace }]);
    const registry = new WorkspaceRegistry();
    const session = await registry.registerTargetedRoot({ configPath: resolvedConfigPath, format: ConfigFormat.Designer });
    const resolver = new ConfigurationContextResolver(registry);
    const staleCachedRoot = makeRoot('stale-disk-root-id', 'Cached configuration', resolvedConfigPath);
    staleCachedRoot.properties = { bslLanguage: 'ru', configurationId: 'stale-configuration-id' } as any;
    await saveTreeToCache(storagePath, resolvedConfigPath, staleCachedRoot);
    const { state, provider } = createState();
    state.configurationContextResolver = resolver;
    (state as any)._extensionContext = { globalStoragePath: storagePath };
    let parseCalls = 0;
    (MetadataParser.parseStructureOnly as unknown as typeof MetadataParser.parseStructureOnly) = async () => {
      parseCalls++;
      return makeRoot('unexpected-parser-root', 'Unexpected', resolvedConfigPath);
    };

    const lifecycle = createMetadataTreeLifecycle(state);
    try {
      await lifecycle.loadMetadataTree();
      const [root] = provider.getRootNodes();
      assert.strictEqual(parseCalls, 0, 'the test must exercise the disk cache hit');
      assert.strictEqual(root.id, `config:${session.identity.configurationId}`);
      assert.strictEqual((root as any).configurationId, session.identity.configurationId);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(root.properties, 'configurationId'), false);
    } finally {
      lifecycle.dispose();
      await registry.dispose();
      await fs.promises.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('captures and freezes resolved context before deferred parsing', async () => {
    const workspace = 'C:\\workspace';
    const configPath = 'C:\\workspace\\Configuration';
    const resolvedPath = 'C:\\workspace\\ResolvedConfiguration';
    vscodeTestState.mockWorkspaceFolders = [{ name: 'workspace', index: 0, uri: vscode.Uri.file(workspace) }];
    stubDiscovery([{ configPath, workspaceFolderPath: workspace }]);
    const mutableResolverContext: Record<string, unknown> = {
      configurationId: 'configuration-captured',
      rootPath: resolvedPath,
      format: ConfigFormat.Designer,
      capabilities: { read: true, write: true, process: true },
    };
    const { state, provider } = createState();
    state.configurationContextResolver = {
      resolveFromResource: async () => mutableResolverContext,
    } as any;
    provider.startTypeContentsCacheWarmup = () => undefined;
    const parseStarted = deferred<void>();
    const releaseParse = deferred<void>();
    (MetadataParser.parseStructureOnly as unknown as typeof MetadataParser.parseStructureOnly) = async () => {
      parseStarted.resolve();
      await releaseParse.promise;
      const root: TreeNode = {
        id: 'parser-root',
        name: 'Configuration',
        type: MetadataType.Configuration,
        properties: {},
        children: [{ id: 'Catalogs', name: 'Catalogs', type: MetadataType.Catalog, properties: {}, children: [] }],
      };
      root.children![0].parent = root;
      return root;
    };
    const typeIndexCalls: Array<{ configPath: string; format?: ConfigFormat }> = [];
    (MetadataParser.parseTypeIndex as unknown as typeof MetadataParser.parseTypeIndex) = async (pathValue, _typeName, options) => {
      typeIndexCalls.push({ configPath: pathValue, format: options?.format });
      return [];
    };

    const lifecycle = createMetadataTreeLifecycle(state);
    try {
      const loading = lifecycle.loadMetadataTree();
      await parseStarted.promise;
      mutableResolverContext.configurationId = 'configuration-mutated';
      mutableResolverContext.rootPath = 'C:\\workspace\\Mutated';
      mutableResolverContext.format = ConfigFormat.EDT;
      releaseParse.resolve();
      await loading;

      const [root] = provider.getRootNodes();
      const treeContext = (provider as any).cache.getLoadContext(root) as FakeTreeLoadContext;
      assert.strictEqual(root.id, 'config:configuration-captured');
      assert.strictEqual((root as any).configurationId, 'configuration-captured');
      assert.strictEqual(Object.prototype.hasOwnProperty.call(root.properties, 'configurationId'), false);
      assert.strictEqual(treeContext.configPath, resolvedPath);
      assert.strictEqual(treeContext.format, ConfigFormat.Designer);
      assert.ok(Object.isFrozen(treeContext));
      const catalogs = root.children!.find((child) => child.id === 'Catalogs')!;
      assert.strictEqual(catalogs.parent, root);
      assert.strictEqual((provider as any).isLazyTypeNode(catalogs), true);
      await provider.getChildren(catalogs);
      assert.deepStrictEqual(typeIndexCalls, [{ configPath: resolvedPath, format: ConfigFormat.Designer }]);
    } finally {
      lifecycle.dispose();
    }
  });

  test('keys contexts by root object, so a stale root cannot inherit a replacement context', () => {
    const cache = new TreeCacheService();
    const provider = new MetadataTreeDataProvider();
    const oldRoot = makeRoot('config:configuration-a', 'Configuration', 'C:\\workspace\\A');
    const newRoot = makeRoot('config:configuration-a', 'Configuration', 'C:\\workspace\\A');
    const contextOld = { configurationId: 'configuration-a', configPath: 'C:\\workspace\\old', format: ConfigFormat.Designer };
    const contextNew = fakeContext('configuration-a', 'C:\\workspace\\new', ConfigFormat.EDT);

    (cache.setLoadContext as any)(oldRoot, contextOld);
    assert.deepStrictEqual((cache.getLoadContext as any)(oldRoot), contextOld);
    provider.setRootNode(oldRoot, contextOld as any);
    contextOld.configPath = 'C:\\workspace\\mutated';
    provider.setRootNode(newRoot, contextNew as any);

    assert.strictEqual((provider as any).cache.getLoadContext(oldRoot), undefined);
    assert.deepStrictEqual((provider as any).cache.getLoadContext(newRoot), contextNew);
    assert.ok(Object.isFrozen((provider as any).cache.getLoadContext(newRoot)));
  });

  test('replaces only the active root with the requested ConfigurationId', () => {
    const provider = new MetadataTreeDataProvider();
    const rootA = makeRoot('config:configuration-a', 'Configuration A', 'C:\\workspace\\A');
    const rootB = makeRoot('config:configuration-b', 'Configuration B', 'C:\\workspace\\B');
    (rootA as any).configurationId = 'configuration-a';
    (rootB as any).configurationId = 'configuration-b';
    const contextA = fakeContext('configuration-a', 'C:\\workspace\\A');
    const contextB = fakeContext('configuration-b', 'C:\\workspace\\B');
    provider.setRootNodes([rootA, rootB], new Map([
      [rootA, contextA],
      [rootB, contextB],
    ]) as any);
    const replacement = makeRoot('config:configuration-b', 'Configuration B next', 'C:\\workspace\\B');
    (replacement as any).configurationId = 'configuration-b';
    const wrongReplacement = makeRoot('config:configuration-a', 'Configuration A', 'C:\\workspace\\A');
    (wrongReplacement as any).configurationId = 'configuration-a';

    assert.strictEqual((provider.replaceConfigurationRoot as any)('configuration-b', wrongReplacement, contextB), false);
    assert.deepStrictEqual(provider.getRootNodes(), [rootA, rootB]);
    assert.strictEqual((provider as any).cache.getLoadContext(rootB).configPath, contextB.configPath);

    assert.strictEqual((provider.replaceConfigurationRoot as any)('configuration-b', replacement, contextB), true);
    assert.deepStrictEqual(provider.getRootNodes(), [rootA, replacement]);
  });

  test('stale nodes retain root identity for scoped lookup after another root is replaced', () => {
    const provider = new MetadataTreeDataProvider();
    const createRoot = (configurationId: string): { root: TreeNode; shared: TreeNode } => {
      const shared: TreeNode = {
        id: 'Catalogs.Shared',
        name: 'Shared',
        type: MetadataType.Catalog,
        properties: {},
      };
      const catalogs: TreeNode = {
        id: 'Catalogs',
        name: 'Catalogs',
        type: MetadataType.Catalog,
        properties: {},
        children: [shared],
      };
      const root: TreeNode = {
        id: `config:${configurationId}`,
        name: 'Configuration',
        type: MetadataType.Configuration,
        properties: {},
        children: [catalogs],
      };
      (root as any).configurationId = configurationId;
      catalogs.parent = root;
      shared.parent = catalogs;
      return { root, shared };
    };
    const currentA = createRoot('configuration-a');
    const staleB = createRoot('configuration-b');
    const currentB = createRoot('configuration-b');
    provider.setRootNodes([currentA.root, staleB.root], new Map([
      [currentA.root, fakeContext('configuration-a', 'C:\\workspace\\A')],
      [staleB.root, fakeContext('configuration-b', 'C:\\workspace\\B')],
    ]) as any);
    provider.setRootNodes([currentA.root, currentB.root], new Map([
      [currentA.root, fakeContext('configuration-a', 'C:\\workspace\\A')],
      [currentB.root, fakeContext('configuration-b', 'C:\\workspace\\B')],
    ]) as any);

    assert.strictEqual((provider as any).cache.getLoadContext(staleB.root), undefined);
    assert.strictEqual(provider.resolveNodeForUi(staleB.shared), currentB.shared);
    assert.strictEqual(provider.findRootObjectForCompositionRef('Catalog.Shared', staleB.shared), currentB.shared);
    assert.strictEqual(provider.findRootObjectForCompositionRef('Catalog.Shared', currentA.shared), currentA.shared);
  });

  test('stale selected root reloads both editor scopes through the active root context', async () => {
    const provider = new MetadataTreeDataProvider();
    const createRoot = (configurationId: string, configPath: string): TreeNode => {
      const catalogs: TreeNode = {
        id: 'Catalogs',
        name: 'Catalogs',
        type: MetadataType.Catalog,
        properties: {},
        children: [],
      };
      const documents: TreeNode = {
        id: 'Documents',
        name: 'Documents',
        type: MetadataType.Document,
        properties: {},
        children: [],
      };
      const root: TreeNode = {
        id: `config:${configurationId}`,
        name: 'Configuration',
        type: MetadataType.Configuration,
        properties: {},
        children: [catalogs, documents],
        filePath: path.join(configPath, 'Configuration.xml'),
      };
      (root as any).configurationId = configurationId;
      catalogs.parent = root;
      documents.parent = root;
      return root;
    };
    const rootA = createRoot('configuration-a', 'C:\\workspace\\A');
    const oldRootB = createRoot('configuration-b', 'C:\\workspace\\B-old');
    const currentRootB = createRoot('configuration-b', 'C:\\workspace\\B-current');
    provider.setRootNodes([rootA, oldRootB], new Map([
      [rootA, fakeContext('configuration-a', 'C:\\workspace\\A')],
      [oldRootB, fakeContext('configuration-b', 'C:\\workspace\\B-old')],
    ]) as any);
    provider.setRootNodes([rootA, currentRootB], new Map([
      [rootA, fakeContext('configuration-a', 'C:\\workspace\\A')],
      [currentRootB, fakeContext('configuration-b', 'C:\\workspace\\B-current', ConfigFormat.EDT)],
    ]) as any);
    assert.strictEqual((provider as any).cache.getLoadContext(oldRootB), undefined);

    const parseCalls: Array<{ configPath: string; typeName: string; format?: ConfigFormat }> = [];
    (MetadataParser.parseTypeIndex as unknown as typeof MetadataParser.parseTypeIndex) = async (
      configPath,
      typeName,
      options,
    ) => {
      parseCalls.push({ configPath, typeName, format: options?.format });
      const type = typeName === 'Documents' ? MetadataType.Document : MetadataType.Catalog;
      return [{ id: `${typeName}.Resolved`, name: path.basename(configPath), type, properties: {} }];
    };

    const references = await provider.getReferenceableObjectsForTypeEditor(oldRootB);
    const objects = await provider.getObjectableObjectsForEditor(oldRootB);
    const expectedRootB = 'C:\\workspace\\B-current';
    assert.ok(references.find((group) => group.referenceKind === 'CatalogRef')?.objectNames.includes('B-current'));
    assert.ok(objects.find((group) => group.objectKind === 'CatalogObject')?.objectNames.includes('B-current'));
    assert.ok(parseCalls.length > 0);
    assert.ok(parseCalls.every((call) => call.configPath === expectedRootB && call.format === ConfigFormat.EDT));
    assert.ok(!parseCalls.some((call) => call.configPath === 'C:\\workspace\\A'));

    const foreignRoot = createRoot('configuration-foreign', 'C:\\workspace\\Foreign');
    const isScopeFailure = (error: unknown): boolean =>
      typeof error === 'object'
      && error !== null
      && (error as { code?: string }).code === 'TREE_CONFIGURATION_SCOPE_UNAVAILABLE'
      && /конфигурац/i.test((error as { message?: string }).message ?? '');
    await assert.rejects(
      provider.getReferenceableObjectsForTypeEditor(foreignRoot),
      isScopeFailure,
      'a foreign selected configuration must fail explicitly instead of returning an empty or workspace-wide list',
    );
    await assert.rejects(
      provider.getObjectableObjectsForEditor(foreignRoot),
      isScopeFailure,
      'object editor scope must also fail explicitly for an unresolved configuration',
    );
  });

  test('uses host-aware path identity for synthetic roots without resolved contexts', function () {
    if (process.platform === 'win32') {
      this.skip();
      return;
    }
    const cache = new TreeCacheService();
    const upperRoot = makeRoot('upper', 'Upper', '/workspace/Config');
    const lowerRoot = makeRoot('lower', 'Lower', '/workspace/config');
    assert.notStrictEqual(
      cache.getNodeRootIdentity(upperRoot),
      cache.getNodeRootIdentity(lowerRoot),
      'POSIX synthetic root identities must preserve path case',
    );
  });
});
