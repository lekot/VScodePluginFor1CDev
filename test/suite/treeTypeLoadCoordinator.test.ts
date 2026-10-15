import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import { MetadataTreeDataProvider } from '../../src/providers/treeDataProvider';
import { MetadataParser } from '../../src/parsers/metadataParser';
import { ConfigFormat } from '../../src/parsers/formatDetector';
import { MetadataType, TreeNode } from '../../src/models/treeNode';
import { optimisticAppendCreatedNode } from '../../src/helpers/optimisticNodeBuilder';
import { ExtensionState } from '../../src/state/extensionState';
import { createMetadataTreeLifecycle } from '../../src/extension/metadataTreeLifecycle';
import { fakeTreeLoadContext } from '../helpers/fakeTreeLoadContext';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface RootFixture {
  root: TreeNode;
  catalogs: TreeNode;
  configPath: string;
  configurationId: string;
}

function createRootFixture(label: string, withSubsystem = false): RootFixture {
  const configPath = path.join(os.tmpdir(), 'tree-type-load-owner', label);
  const configurationId = `test:${label}`;
  const catalogs: TreeNode = {
    id: 'Catalogs',
    name: 'Справочники',
    type: MetadataType.Catalog,
    properties: {},
    children: [],
  };
  const children: TreeNode[] = [catalogs];

  if (withSubsystem) {
    const subsystem: TreeNode = {
      id: 'Subsystems.Current',
      name: 'Current',
      type: MetadataType.Subsystem,
      properties: {
        Content: { 'xr:Item': [{ '#text': 'Catalog.Existing' }] },
      },
      children: [],
    };
    const subsystemFolder: TreeNode = {
      id: 'Subsystems',
      name: 'Подсистемы',
      type: MetadataType.Subsystem,
      properties: { _indexLoaded: true } as TreeNode['properties'],
      children: [subsystem],
    };
    subsystem.parent = subsystemFolder;
    children.push(subsystemFolder);
  }

  const root: TreeNode = {
    id: `config:${configurationId}`,
    name: label,
    type: MetadataType.Configuration,
    properties: {},
    children,
  };
  Object.defineProperty(root, 'configurationId', {
    configurable: true,
    enumerable: true,
    value: configurationId,
  });
  for (const childNode of children) {
    childNode.parent = root;
  }
  return { root, catalogs, configPath, configurationId };
}

function contextFor(fixture: RootFixture) {
  return fakeTreeLoadContext(fixture.configPath, ConfigFormat.Designer, fixture.configurationId);
}

function child(id: string, name = id): TreeNode {
  return { id, name, type: MetadataType.Catalog, properties: {}, children: [] };
}

function makeCatalogWithChildren(label: string, names: string[]): RootFixture {
  const fixture = createRootFixture(label);
  fixture.catalogs.properties = { _indexLoaded: true } as TreeNode['properties'];
  fixture.catalogs.children = names.map((name) => {
    const node = child(`Catalogs.${name}`, name);
    node.parent = fixture.catalogs;
    return node;
  });
  return fixture;
}

function resultErrorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

suite('Tree type-index load ownership runtime', () => {
  const originalParseTypeIndex = MetadataParser.parseTypeIndex;
  const originalInvalidateTypeContentsCache = MetadataParser.invalidateTypeContentsCache;
  const providers = new Set<MetadataTreeDataProvider>();

  function createProvider(): MetadataTreeDataProvider {
    const provider = new MetadataTreeDataProvider();
    providers.add(provider);
    return provider;
  }

  setup(() => {
    providers.clear();
  });

  teardown(() => {
    for (const provider of providers) {
      provider.dispose();
    }
    providers.clear();
    MetadataParser.parseTypeIndex = originalParseTypeIndex;
    MetadataParser.invalidateTypeContentsCache = originalInvalidateTypeContentsCache;
  });

  test('foreground, warmup, eager, subsystem, Reference, and Object consumers share one active parse', async () => {
    const provider = createProvider();
    const fixture = createRootFixture('shared-consumers', true);
    provider.setRootNodes([fixture.root], new Map([[fixture.root, contextFor(fixture)]]));

    const parseStarted = deferred<void>();
    const releaseParse = deferred<TreeNode[]>();
    const parseCalls: string[] = [];
    MetadataParser.parseTypeIndex = async (_configPath, typeName) => {
      parseCalls.push(typeName);
      parseStarted.resolve();
      return releaseParse.promise;
    };

    provider.startTypeContentsCacheWarmup({ delayMs: 0, budgetMs: 1000 });
    await parseStarted.promise;

    const foreground = Promise.resolve(provider.getChildren(fixture.catalogs));
    const referenceEditor = provider.getReferenceableObjectsForTypeEditor(fixture.root);
    const objectEditor = provider.getObjectableObjectsForEditor(fixture.root);
    const eager = provider.eagerLoadAllTypeFolders(fixture.root);
    const subsystem = provider.setSubsystemFilter('Subsystems.Current', 'Current');
    const published = [child('Catalogs.Shared', 'Shared')];
    releaseParse.resolve(published);

    const results = await Promise.allSettled([foreground, referenceEditor, objectEditor, eager, subsystem]);
    assert.ok(results.every((result) => result.status === 'fulfilled'));
    assert.deepStrictEqual(
      parseCalls,
      ['Catalogs'],
      'all active type-index consumers must join the same promise owned by the provider',
    );
    assert.deepStrictEqual(fixture.catalogs.children?.map((node) => node.id), ['Catalogs.Shared']);
    assert.strictEqual(fixture.catalogs.children?.[0]?.parent, fixture.catalogs);
  });

  test('subsystem eager loading enters the shared owner and foreground joins that load', async () => {
    const provider = createProvider();
    const fixture = createRootFixture('subsystem-shared-load', true);
    provider.setRootNodes([fixture.root], new Map([[fixture.root, contextFor(fixture)]]));
    const parseStarted = deferred<void>();
    const releaseParse = deferred<TreeNode[]>();
    let parseCalls = 0;
    MetadataParser.parseTypeIndex = async (_configPath, typeName) => {
      assert.strictEqual(typeName, 'Catalogs');
      parseCalls += 1;
      parseStarted.resolve();
      return releaseParse.promise;
    };

    const subsystemLoad = provider.setSubsystemFilter('Subsystems.Current', 'Current');
    await parseStarted.promise;
    const foregroundLoad = Promise.resolve(provider.getChildren(fixture.catalogs));
    releaseParse.resolve([child('Catalogs.SubsystemObject', 'SubsystemObject')]);
    const results = await Promise.allSettled([subsystemLoad, foregroundLoad]);

    assert.ok(results.every((result) => result.status === 'fulfilled'));
    assert.strictEqual(parseCalls, 1, 'subsystem eager and foreground must share one owned load');
    assert.deepStrictEqual(fixture.catalogs.children?.map((node) => node.id), ['Catalogs.SubsystemObject']);
  });

  test('replacement retires only the replaced root while a same-context root load remains publishable', async () => {
    const provider = createProvider();
    const rootA = createRootFixture('replacement-a');
    const oldRootB = createRootFixture('replacement-b');
    provider.setRootNodes([rootA.root, oldRootB.root], new Map([
      [rootA.root, contextFor(rootA)],
      [oldRootB.root, contextFor(oldRootB)],
    ]));

    const startedA = deferred<void>();
    const startedB = deferred<void>();
    const releaseA = deferred<TreeNode[]>();
    const releaseB = deferred<TreeNode[]>();
    MetadataParser.parseTypeIndex = async (configPath, typeName) => {
      if (configPath === rootA.configPath) {
        startedA.resolve();
        return releaseA.promise;
      }
      startedB.resolve();
      return releaseB.promise;
    };

    const loadA = Promise.resolve(provider.getChildren(rootA.catalogs));
    const loadB = Promise.resolve(provider.getChildren(oldRootB.catalogs));
    await Promise.all([startedA.promise, startedB.promise]);

    const newRootB = createRootFixture('replacement-b');
    const newContextB = fakeTreeLoadContext(
      newRootB.configPath,
      ConfigFormat.EDT,
      newRootB.configurationId,
    );
    provider.setRootNodes([rootA.root, newRootB.root], new Map([
      [rootA.root, contextFor(rootA)],
      [newRootB.root, newContextB],
    ]));

    releaseB.resolve([child('Catalogs.StaleB', 'Stale B')]);
    releaseA.resolve([child('Catalogs.CurrentA', 'Current A')]);
    const [resultA, resultB] = await Promise.allSettled([loadA, loadB]);

    assert.strictEqual(resultA.status, 'fulfilled', 'copying contexts for B must not retire exact root A');
    assert.strictEqual(resultB.status, 'rejected', 'a detached root B result must be reported as superseded');
    if (resultB.status === 'rejected') {
      assert.strictEqual(resultErrorCode(resultB.reason), 'TREE_LOAD_SUPERSEDED');
    }
    assert.deepStrictEqual(rootA.catalogs.children?.map((node) => node.id), ['Catalogs.CurrentA']);
    assert.deepStrictEqual(oldRootB.catalogs.children, [], 'retired root B must remain untouched');
    assert.deepStrictEqual(newRootB.catalogs.children, [], 'the new B root must not receive old B results');
  });

  test('invalidateLoadedChildren allows a fresh request and fences the earlier parse', async () => {
    const provider = createProvider();
    const fixture = createRootFixture('node-invalidation');
    provider.setRootNodes([fixture.root], new Map([[fixture.root, contextFor(fixture)]]));

    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const releaseFirst = deferred<TreeNode[]>();
    const releaseSecond = deferred<TreeNode[]>();
    let calls = 0;
    MetadataParser.parseTypeIndex = async () => {
      calls += 1;
      if (calls === 1) {
        firstStarted.resolve();
        return releaseFirst.promise;
      }
      secondStarted.resolve();
      return releaseSecond.promise;
    };

    const staleLoad = Promise.resolve(provider.getChildren(fixture.catalogs));
    await firstStarted.promise;
    provider.invalidateLoadedChildren(fixture.catalogs);
    const freshLoad = Promise.resolve(provider.getChildren(fixture.catalogs));
    await secondStarted.promise;

    releaseFirst.resolve([child('Catalogs.Stale', 'Stale')]);
    releaseSecond.resolve([child('Catalogs.Fresh', 'Fresh')]);
    const [staleResult, freshResult] = await Promise.allSettled([staleLoad, freshLoad]);

    assert.strictEqual(calls, 2, 'the post-invalidation request must not join the old promise');
    assert.strictEqual(staleResult.status, 'rejected');
    if (staleResult.status === 'rejected') {
      assert.strictEqual(resultErrorCode(staleResult.reason), 'TREE_LOAD_SUPERSEDED');
    }
    assert.strictEqual(freshResult.status, 'fulfilled');
    assert.deepStrictEqual(fixture.catalogs.children?.map((node) => node.id), ['Catalogs.Fresh']);
  });

  test('type-index failure remains retryable while a successful empty index is loaded once', async () => {
    const provider = createProvider();
    const fixture = createRootFixture('failure-and-empty');
    provider.setRootNodes([fixture.root], new Map([[fixture.root, contextFor(fixture)]]));
    let calls = 0;
    MetadataParser.parseTypeIndex = async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('injected parser failure');
      }
      return [];
    };

    await assert.rejects(
      Promise.resolve(provider.getChildren(fixture.catalogs)),
      (error: unknown) => resultErrorCode(error) === 'TREE_LOAD_FAILED',
    );
    assert.notStrictEqual((fixture.catalogs.properties as Record<string, unknown>)._indexLoaded, true);

    assert.deepStrictEqual(await provider.getChildren(fixture.catalogs), []);
    assert.strictEqual((fixture.catalogs.properties as Record<string, unknown>)._indexLoaded, true);
    assert.deepStrictEqual(await provider.getChildren(fixture.catalogs), []);
    assert.strictEqual(calls, 2, 'loaded-empty is cached but failed is eligible for an independent request');
  });

  test('editor consumers do not publish failed loads as empty and a retry returns fresh data', async () => {
    const provider = createProvider();
    const fixture = createRootFixture('editor-failure-retry');
    provider.setRootNodes([fixture.root], new Map([[fixture.root, contextFor(fixture)]]));
    let calls = 0;
    MetadataParser.parseTypeIndex = async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('injected editor parse failure');
      }
      return [child('Catalogs.Recovered', 'Recovered')];
    };

    const failed = await Promise.allSettled([
      provider.getReferenceableObjectsForTypeEditor(fixture.root),
    ]);
    assert.strictEqual(failed[0]?.status, 'rejected');
    if (failed[0]?.status === 'rejected') {
      assert.strictEqual(resultErrorCode(failed[0].reason), 'TREE_LOAD_FAILED');
    }
    const recovered = await Promise.all([
      provider.getReferenceableObjectsForTypeEditor(fixture.root),
      provider.getObjectableObjectsForEditor(fixture.root),
    ]);
    const referenceNames = recovered[0].find((group) => group.referenceKind === 'CatalogRef')?.objectNames;
    const objectNames = recovered[1].find((group) => group.objectKind === 'CatalogObject')?.objectNames;

    assert.deepStrictEqual(referenceNames, ['Recovered']);
    assert.deepStrictEqual(objectNames, ['Recovered']);
    assert.strictEqual(calls, 2, 'failed editor aggregate must not be cached as an authoritative empty result');
  });

  test('a loaded-empty editor index is shared and not reparsed', async () => {
    const provider = createProvider();
    const fixture = createRootFixture('editor-empty');
    provider.setRootNodes([fixture.root], new Map([[fixture.root, contextFor(fixture)]]));
    let calls = 0;
    MetadataParser.parseTypeIndex = async () => {
      calls += 1;
      return [];
    };

    await Promise.all([
      provider.getReferenceableObjectsForTypeEditor(fixture.root),
      provider.getObjectableObjectsForEditor(fixture.root),
    ]);
    assert.strictEqual((fixture.catalogs.properties as Record<string, unknown>)._indexLoaded, true);
    assert.deepStrictEqual(await provider.getChildren(fixture.catalogs), []);
    assert.strictEqual(calls, 1, 'successful empty results are shared by foreground and editor consumers');
  });

  test('scoped editor snapshots survive another root replacement while both all-roots scopes are fenced', async () => {
    const provider = createProvider();
    const fixtureA = createRootFixture('editor-scope-a');
    const oldFixtureB = createRootFixture('editor-scope-b');
    provider.setRootNodes([fixtureA.root, oldFixtureB.root], new Map([
      [fixtureA.root, contextFor(fixtureA)],
      [oldFixtureB.root, contextFor(oldFixtureB)],
    ]));
    const startedA = deferred<void>();
    const startedB = deferred<void>();
    const releaseA = deferred<TreeNode[]>();
    const releaseB = deferred<TreeNode[]>();
    const parseCalls: string[] = [];
    MetadataParser.parseTypeIndex = async (configPath) => {
      parseCalls.push(configPath);
      if (configPath === fixtureA.configPath) {
        startedA.resolve();
        return releaseA.promise;
      }
      startedB.resolve();
      return releaseB.promise;
    };

    const scopedReferenceA = provider.getReferenceableObjectsForTypeEditor(fixtureA.root);
    const scopedObjectA = provider.getObjectableObjectsForEditor(fixtureA.root);
    const staleReferenceAggregate = provider.getReferenceableObjectsForTypeEditor();
    const staleObjectAggregate = provider.getObjectableObjectsForEditor();
    await Promise.all([startedA.promise, startedB.promise]);
    const currentFixtureB = createRootFixture('editor-scope-b');
    provider.setRootNodes([fixtureA.root, currentFixtureB.root], new Map([
      [fixtureA.root, contextFor(fixtureA)],
      [currentFixtureB.root, contextFor(currentFixtureB)],
    ]));
    releaseA.resolve([child('Catalogs.FromA', 'FromA')]);
    releaseB.resolve([child('Catalogs.FromOldB', 'FromOldB')]);

    const [scopedReferenceResult, scopedObjectResult, staleReferenceResult, staleObjectResult] = await Promise.all([
      Promise.allSettled([scopedReferenceA]),
      Promise.allSettled([scopedObjectA]),
      Promise.allSettled([staleReferenceAggregate]),
      Promise.allSettled([staleObjectAggregate]),
    ]);
    assert.strictEqual(scopedReferenceResult[0]?.status, 'fulfilled');
    assert.strictEqual(scopedObjectResult[0]?.status, 'fulfilled');
    assert.strictEqual(staleReferenceResult[0]?.status, 'rejected');
    assert.strictEqual(staleObjectResult[0]?.status, 'rejected');
    for (const result of [staleReferenceResult[0], staleObjectResult[0]]) {
      if (result?.status === 'rejected') {
        assert.strictEqual(resultErrorCode(result.reason), 'TREE_LOAD_SUPERSEDED');
      }
    }
    assert.ok(parseCalls.includes(fixtureA.configPath));
    assert.ok(parseCalls.includes(oldFixtureB.configPath));

    MetadataParser.parseTypeIndex = async (configPath) => [
      child('Catalogs.FromCurrentB', configPath === currentFixtureB.configPath ? 'FromCurrentB' : 'Unexpected'),
    ];
    const [currentReferenceGroups, currentObjectGroups] = await Promise.all([
      provider.getReferenceableObjectsForTypeEditor(),
      provider.getObjectableObjectsForEditor(),
    ]);
    const referenceNames = currentReferenceGroups.find((group) => group.referenceKind === 'CatalogRef')?.objectNames;
    const objectNames = currentObjectGroups.find((group) => group.objectKind === 'CatalogObject')?.objectNames;
    assert.deepStrictEqual(referenceNames, ['FromA', 'FromCurrentB']);
    assert.deepStrictEqual(objectNames, ['FromA', 'FromCurrentB']);
    assert.ok(!referenceNames?.includes('FromOldB'), 'late reference aggregate must not poison the active cache');
    assert.ok(!objectNames?.includes('FromOldB'), 'late object aggregate must not poison the active cache');
  });

  test('optimistic delete and rollback invalidate both editor aggregate snapshots', async () => {
    const provider = createProvider();
    const fixture = makeCatalogWithChildren('optimistic-editor-cache', ['Products']);
    provider.setRootNodes([fixture.root], new Map([[fixture.root, contextFor(fixture)]]));
    const originalChild = fixture.catalogs.children![0]!;

    const [referenceBefore, objectBefore] = await Promise.all([
      provider.getReferenceableObjectsForTypeEditor(fixture.root),
      provider.getObjectableObjectsForEditor(fixture.root),
    ]);
    assert.deepStrictEqual(
      referenceBefore.find((group) => group.referenceKind === 'CatalogRef')?.objectNames,
      ['Products'],
    );
    assert.deepStrictEqual(
      objectBefore.find((group) => group.objectKind === 'CatalogObject')?.objectNames,
      ['Products'],
    );

    const token = provider.applyOptimisticDelete(originalChild, 'delete-products');
    assert.ok(token);
    const [referenceAfterDelete, objectAfterDelete] = await Promise.all([
      provider.getReferenceableObjectsForTypeEditor(fixture.root),
      provider.getObjectableObjectsForEditor(fixture.root),
    ]);
    assert.deepStrictEqual(
      referenceAfterDelete.find((group) => group.referenceKind === 'CatalogRef')?.objectNames,
      [],
    );
    assert.deepStrictEqual(
      objectAfterDelete.find((group) => group.objectKind === 'CatalogObject')?.objectNames,
      [],
    );

    assert.strictEqual(provider.rollbackOptimisticDelete(token!), true);
    const [referenceAfterRollback, objectAfterRollback] = await Promise.all([
      provider.getReferenceableObjectsForTypeEditor(fixture.root),
      provider.getObjectableObjectsForEditor(fixture.root),
    ]);
    assert.deepStrictEqual(
      referenceAfterRollback.find((group) => group.referenceKind === 'CatalogRef')?.objectNames,
      ['Products'],
    );
    assert.deepStrictEqual(
      objectAfterRollback.find((group) => group.objectKind === 'CatalogObject')?.objectNames,
      ['Products'],
    );
  });

  test('a required lazy load without a captured context fails explicitly', async () => {
    const provider = createProvider();
    const fixture = createRootFixture('missing-context');
    provider.setRootNode(fixture.root);

    await assert.rejects(
      Promise.resolve(provider.getChildren(fixture.catalogs)),
      (error: unknown) => resultErrorCode(error) === 'CONFIGURATION_CONTEXT_UNAVAILABLE',
    );
  });

  test('Common DefinedTypes are loaded through the shared selector for ObjectTypeEditor', async () => {
    const provider = createProvider();
    const fixture = createRootFixture('common-defined-types');
    const definedTypes: TreeNode = {
      id: 'DefinedTypes',
      name: 'Определяемые типы',
      type: MetadataType.DefinedType,
      properties: {},
      children: [],
    };
    const common: TreeNode = {
      id: 'Common',
      name: 'Общие',
      type: MetadataType.Unknown,
      properties: {},
      children: [definedTypes],
      parent: fixture.root,
    };
    definedTypes.parent = common;
    fixture.root.children = [common];
    provider.setRootNodes([fixture.root], new Map([[fixture.root, contextFor(fixture)]]));
    const parseCalls: Array<{ configPath: string; typeName: string }> = [];
    MetadataParser.parseTypeIndex = async (configPath, typeName) => {
      parseCalls.push({ configPath, typeName });
      return [{
        id: 'DefinedTypes.Special',
        name: 'Special',
        type: MetadataType.DefinedType,
        properties: {},
        children: [],
      }];
    };

    const groups = await provider.getObjectableObjectsForEditor(fixture.root);
    assert.deepStrictEqual(parseCalls, [{ configPath: fixture.configPath, typeName: 'DefinedTypes' }]);
    assert.deepStrictEqual(
      groups.find((group) => group.objectKind === 'DefinedType')?.objectNames,
      ['Special'],
    );
    assert.strictEqual(provider.findNodeById('DefinedTypes.Special')?.parent, definedTypes);
  });

  test('type-index publication normalizes R6 placeholders before adding them to the node cache', async () => {
    const provider = createProvider();
    const fixture = createRootFixture('r6-before-cache');
    provider.setRootNodes([fixture.root], new Map([[fixture.root, contextFor(fixture)]]));
    MetadataParser.parseTypeIndex = async () => [{
      id: 'Catalogs.Items',
      name: 'Items',
      type: MetadataType.Catalog,
      properties: {},
      children: [],
    }];

    const [instance] = await provider.getChildren(fixture.catalogs);
    const attributes = instance?.children?.find((node) => node.id === 'Attributes');
    assert.strictEqual(instance?.parent, fixture.catalogs);
    assert.ok(attributes, 'R6 normalization must add the Attributes placeholder to the shared cache');
    assert.strictEqual(provider.isLoadedNode(attributes!), true, 'R6 child must be registered in the cache');
    assert.strictEqual(attributes?.parent, instance);
  });

  test('case-distinct POSIX roots retain native paths and separate both editor scopes', async function () {
    if (process.platform === 'win32') {
      this.skip();
    }
    const provider = createProvider();
    const upper = createRootFixture('CaseSensitive');
    const lower = createRootFixture('casesensitive');
    const seen: string[] = [];
    provider.setRootNodes([upper.root, lower.root], new Map([
      [upper.root, contextFor(upper)],
      [lower.root, contextFor(lower)],
    ]));
    MetadataParser.parseTypeIndex = async (configPath) => {
      seen.push(configPath);
      return [child('Catalogs.SharedId', path.basename(configPath))];
    };

    const [upperChildren, lowerChildren] = await Promise.all([
      provider.getChildren(upper.catalogs),
      provider.getChildren(lower.catalogs),
    ]);
    assert.deepStrictEqual(seen.sort(), [upper.configPath, lower.configPath].sort());
    assert.strictEqual(upperChildren[0]?.name, path.basename(upper.configPath));
    assert.strictEqual(lowerChildren[0]?.name, path.basename(lower.configPath));
    assert.notStrictEqual(upperChildren[0], lowerChildren[0]);

    const [upperReference, lowerReference, upperObject, lowerObject] = await Promise.all([
      provider.getReferenceableObjectsForTypeEditor(upper.root),
      provider.getReferenceableObjectsForTypeEditor(lower.root),
      provider.getObjectableObjectsForEditor(upper.root),
      provider.getObjectableObjectsForEditor(lower.root),
    ]);
    assert.deepStrictEqual(
      upperReference.find((group) => group.referenceKind === 'CatalogRef')?.objectNames,
      [path.basename(upper.configPath)],
    );
    assert.deepStrictEqual(
      lowerReference.find((group) => group.referenceKind === 'CatalogRef')?.objectNames,
      [path.basename(lower.configPath)],
    );
    assert.deepStrictEqual(
      upperObject.find((group) => group.objectKind === 'CatalogObject')?.objectNames,
      [path.basename(upper.configPath)],
    );
    assert.deepStrictEqual(
      lowerObject.find((group) => group.objectKind === 'CatalogObject')?.objectNames,
      [path.basename(lower.configPath)],
    );
  });

  test('optimistic append retires a pending parse before it can replace visible children', async () => {
    const provider = createProvider();
    const fixture = createRootFixture('optimistic-append');
    provider.setRootNodes([fixture.root], new Map([[fixture.root, contextFor(fixture)]]));
    const parseStarted = deferred<void>();
    const releaseParse = deferred<TreeNode[]>();
    MetadataParser.parseTypeIndex = async () => {
      parseStarted.resolve();
      return releaseParse.promise;
    };

    const pendingLoad = Promise.resolve(provider.getChildren(fixture.catalogs));
    await parseStarted.promise;
    await optimisticAppendCreatedNode(
      { treeDataProvider: provider } as ExtensionState,
      fixture.catalogs,
      'Optimistic',
      { configPath: fixture.configPath, format: ConfigFormat.Designer },
    );
    const optimisticNode = fixture.catalogs.children?.[0];
    assert.strictEqual(optimisticNode?.id, 'Catalogs.Optimistic');

    releaseParse.resolve([child('Catalogs.StaleFromDisk', 'Stale from disk')]);
    const result = await Promise.allSettled([pendingLoad]);

    assert.strictEqual(result[0]?.status, 'rejected');
    if (result[0]?.status === 'rejected') {
      assert.strictEqual(resultErrorCode(result[0].reason), 'TREE_LOAD_SUPERSEDED');
    }
    assert.deepStrictEqual(
      fixture.catalogs.children?.map((node) => node.id),
      ['Catalogs.Optimistic'],
      'late index data must not erase the successful optimistic append',
    );
  });

  test('optimistic delete and rollback retire a pending parse before it can restore stale children', async () => {
    const provider = createProvider();
    const fixture = createRootFixture('optimistic-delete-rollback');
    provider.setRootNodes([fixture.root], new Map([[fixture.root, contextFor(fixture)]]));
    const parseStarted = deferred<void>();
    const releaseParse = deferred<TreeNode[]>();
    MetadataParser.parseTypeIndex = async () => {
      parseStarted.resolve();
      return releaseParse.promise;
    };

    const pendingLoad = Promise.resolve(provider.getChildren(fixture.catalogs));
    await parseStarted.promise;
    await optimisticAppendCreatedNode(
      { treeDataProvider: provider } as ExtensionState,
      fixture.catalogs,
      'CreatedThenDeleted',
      { configPath: fixture.configPath, format: ConfigFormat.Designer },
    );
    const created = fixture.catalogs.children?.[0];
    assert.ok(created);
    const token = provider.applyOptimisticDelete(created!, 'delete-created-during-index-load');
    assert.ok(token);
    assert.deepStrictEqual(fixture.catalogs.children, []);
    assert.strictEqual(provider.rollbackOptimisticDelete(token!), true);
    const restored = (fixture.catalogs.children as TreeNode[] | undefined)?.[0];
    assert.strictEqual(restored?.name, 'CreatedThenDeleted');

    releaseParse.resolve([child('Catalogs.StaleFromDisk', 'Stale from disk')]);
    const result = await Promise.allSettled([pendingLoad]);

    assert.strictEqual(result[0]?.status, 'rejected');
    if (result[0]?.status === 'rejected') {
      assert.strictEqual(resultErrorCode(result[0].reason), 'TREE_LOAD_SUPERSEDED');
    }
    assert.deepStrictEqual(
      (fixture.catalogs.children as TreeNode[] | undefined)?.map((node) => node.name),
      ['CreatedThenDeleted'],
      'late index data must not erase the restored optimistic node',
    );
    assert.strictEqual(fixture.catalogs.children?.[0], restored);
  });

  test('dispose rejects an in-flight load and does not restart warmup from its finally handler', async () => {
    const provider = createProvider();
    const fixture = createRootFixture('disposed-load');
    provider.setRootNodes([fixture.root], new Map([[fixture.root, contextFor(fixture)]]));
    const parseStarted = deferred<void>();
    const releaseParse = deferred<TreeNode[]>();
    MetadataParser.parseTypeIndex = async () => {
      parseStarted.resolve();
      return releaseParse.promise;
    };
    let warmupStarts = 0;
    provider.startTypeContentsCacheWarmup = (() => {
      warmupStarts += 1;
    }) as typeof provider.startTypeContentsCacheWarmup;

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const pendingLoad = Promise.resolve(provider.getChildren(fixture.catalogs));
      const settled = pendingLoad.then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason: unknown) => ({ status: 'rejected' as const, reason }),
      );
      await parseStarted.promise;
      provider.dispose();
      releaseParse.resolve([child('Catalogs.AfterDispose')]);
      const result = await settled;
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.strictEqual(result.status, 'rejected');
      if (result.status === 'rejected') {
        assert.strictEqual(resultErrorCode(result.reason), 'TREE_LOAD_DISPOSED');
      }
      assert.deepStrictEqual(fixture.catalogs.children, [], 'disposed owner must not publish late children');
      assert.strictEqual(warmupStarts, 0, 'foreground finally must not revive the disposed warmup scheduler');
      assert.deepStrictEqual(unhandled, [], 'retired shared work must not leak an unhandled rejection');
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });

  test('configuration invalidation suspends new tree loads before parser invalidation completes', async () => {
    const provider = createProvider();
    const fixture = createRootFixture('suspended-configuration');
    provider.setRootNodes([fixture.root], new Map([[fixture.root, contextFor(fixture)]]));
    const state = new ExtensionState();
    state.treeDataProvider = provider;
    const lifecycle = createMetadataTreeLifecycle(state);
    const invalidationStarted = deferred<void>();
    const releaseInvalidation = deferred<void>();
    let invalidation: Promise<void> | undefined;
    MetadataParser.invalidateTypeContentsCache = async () => {
      invalidationStarted.resolve();
      await releaseInvalidation.promise;
    };
    MetadataParser.parseTypeIndex = async () => [child('Catalogs.FromFreshRequest')];

    try {
      invalidation = lifecycle.invalidateTreeCacheOnly(fixture.configPath);
      await invalidationStarted.promise;
      await assert.rejects(
        Promise.resolve(provider.getChildren(fixture.catalogs)),
        (error: unknown) => resultErrorCode(error) === 'TREE_LOAD_SUPERSEDED',
      );
      assert.deepStrictEqual(fixture.catalogs.children, [], 'suspension preserves the prior visible snapshot');
    } finally {
      releaseInvalidation.resolve();
      await invalidation;
      lifecycle.dispose();
    }
  });
});
