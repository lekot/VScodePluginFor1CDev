import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MetadataTreeDataProvider } from '../../src/providers/treeDataProvider';
import { MetadataParser } from '../../src/parsers/metadataParser';
import { ConfigFormat } from '../../src/parsers/formatDetector';
import { MetadataType, TreeNode } from '../../src/models/treeNode';
import { optimisticAppendCreatedNode } from '../../src/helpers/optimisticNodeBuilder';
import { ExtensionState } from '../../src/state/extensionState';
import { createMetadataTreeLifecycle } from '../../src/extension/metadataTreeLifecycle';
import * as diskCache from '../../src/utils/diskCache';
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

  test('transient I/O error during parseTypeIndex is not cached as authoritative empty and retries on restored access (Designer and EDT)', async () => {
    const originalReaddir = fs.promises.readdir;
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'type-index-eacces-'));
    try {
      for (const format of [ConfigFormat.Designer, ConfigFormat.EDT]) {
        const fixture = createRootFixture(`eacces-${format}`);
        const configPath = fixture.configPath;
        const catalogsDir = format === ConfigFormat.Designer
          ? path.join(configPath, 'Catalogs')
          : path.join(configPath, 'src', 'Catalogs');
        await fs.promises.mkdir(catalogsDir, { recursive: true });
        if (format === ConfigFormat.Designer) {
          await fs.promises.writeFile(path.join(catalogsDir, 'Recovered.xml'), '<MetaDataObject/>', 'utf8');
        } else {
          await fs.promises.mkdir(path.join(catalogsDir, 'Recovered'), { recursive: true });
        }

        const subsystems: TreeNode = {
          id: 'Subsystems',
          name: 'Подсистемы',
          type: MetadataType.Subsystem,
          properties: {},
          children: [],
        };
        subsystems.parent = fixture.root;
        fixture.root.children!.push(subsystems);

        const subsystemsDir = format === ConfigFormat.Designer
          ? path.join(configPath, 'Subsystems')
          : path.join(configPath, 'src', 'Subsystems');
        await fs.promises.mkdir(subsystemsDir, { recursive: true });
        if (format === ConfigFormat.Designer) {
          await fs.promises.writeFile(
            path.join(subsystemsDir, 'SubRecovered.xml'),
            '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.17"><Subsystem><Properties><Name>SubRecovered</Name></Properties></Subsystem></MetaDataObject>',
            'utf8',
          );
        } else {
          const subDir = path.join(subsystemsDir, 'SubRecovered');
          await fs.promises.mkdir(subDir, { recursive: true });
          await fs.promises.writeFile(
            path.join(subDir, 'Subsystem.mdo'),
            '<mdclass:Subsystem xmlns:mdclass="http://g5.1c.ru/v8/dt/metadata/mdclass"><name>SubRecovered</name></mdclass:Subsystem>',
            'utf8',
          );
        }

        const documents: TreeNode = {
          id: 'Documents',
          name: 'Документы',
          type: MetadataType.Document,
          properties: {},
          children: [],
        };
        documents.parent = fixture.root;
        fixture.root.children!.push(documents);

        const provider = createProvider();
        provider.setRootNodes([fixture.root], new Map([[fixture.root, fakeTreeLoadContext(configPath, format, fixture.configurationId)]]));

        let failEacces = true;
        (fs.promises as unknown as { readdir: unknown }).readdir = async (targetPath: fs.PathLike, options?: unknown) => {
          if (failEacces && (String(targetPath).includes('Catalogs') || String(targetPath).includes('Subsystems'))) {
            const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
            err.code = 'EACCES';
            throw err;
          }
          return (originalReaddir as (p: fs.PathLike, o?: unknown) => Promise<unknown>)(targetPath, options);
        };

        await assert.rejects(
          Promise.resolve(provider.getChildren(fixture.catalogs)),
          (error: unknown) => resultErrorCode(error) === 'TREE_LOAD_FAILED',
          `Format ${format} must fail typed on EACCES for Catalogs`,
        );
        assert.notStrictEqual((fixture.catalogs.properties as Record<string, unknown>)?._indexLoaded, true, `Format ${format} must not mark _indexLoaded on failure`);

        await assert.rejects(
          Promise.resolve(provider.getChildren(subsystems)),
          (error: unknown) => resultErrorCode(error) === 'TREE_LOAD_FAILED',
          `Format ${format} must fail typed on EACCES for Subsystems`,
        );
        assert.notStrictEqual((subsystems.properties as Record<string, unknown>)?._indexLoaded, true, `Format ${format} must not mark _indexLoaded on failure for Subsystems`);

        failEacces = false;
        const recovered = await provider.getChildren(fixture.catalogs);
        assert.strictEqual(recovered.length, 1, `Format ${format} must read recovered items`);
        assert.strictEqual(recovered[0].name, 'Recovered');
        assert.strictEqual((fixture.catalogs.properties as Record<string, unknown>)?._indexLoaded, true, `Format ${format} must mark _indexLoaded on success`);

        const recoveredSubs = await provider.getChildren(subsystems);
        assert.strictEqual(recoveredSubs.length, 1, `Format ${format} must read recovered subsystems`);
        assert.strictEqual(recoveredSubs[0].name, 'SubRecovered');
        assert.strictEqual((subsystems.properties as Record<string, unknown>)?._indexLoaded, true, `Format ${format} must mark _indexLoaded on success for Subsystems`);

        const emptyDocs = await provider.getChildren(documents);
        assert.deepStrictEqual(emptyDocs, []);
        assert.strictEqual((documents.properties as Record<string, unknown>)?._indexLoaded, true);
      }
    } finally {
      fs.promises.readdir = originalReaddir;
      await fs.promises.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  test('subsystem XML/MDO access error (EACCES) during parseTypeIndex is not swallowed into partial index and retries on restored access (Designer and EDT)', async () => {
    const originalReadFile = fs.promises.readFile;
    const originalAccess = fs.promises.access;
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'subsystem-xml-eacces-'));
    try {
      for (const format of [ConfigFormat.Designer, ConfigFormat.EDT]) {
        const fixture = createRootFixture(`sub-xml-eacces-${format}`);
        const configPath = fixture.configPath;

        const subsystems: TreeNode = {
          id: 'Subsystems',
          name: 'Подсистемы',
          type: MetadataType.Subsystem,
          properties: {},
          children: [],
        };
        subsystems.parent = fixture.root;
        fixture.root.children!.push(subsystems);

        const subsystemsDir = format === ConfigFormat.Designer
          ? path.join(configPath, 'Subsystems')
          : path.join(configPath, 'src', 'Subsystems');
        await fs.promises.mkdir(subsystemsDir, { recursive: true });

        if (format === ConfigFormat.Designer) {
          await fs.promises.writeFile(
            path.join(subsystemsDir, 'SubOk.xml'),
            '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.17"><Subsystem><Properties><Name>SubOk</Name></Properties><ChildObjects><Subsystem>SubNested</Subsystem></ChildObjects></Subsystem></MetaDataObject>',
            'utf8',
          );
          await fs.promises.writeFile(
            path.join(subsystemsDir, 'SubBroken.xml'),
            '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.17"><Subsystem><Properties><Name>SubBroken</Name></Properties></Subsystem></MetaDataObject>',
            'utf8',
          );
          const subOkNestedDir = path.join(subsystemsDir, 'SubOk', 'Subsystems');
          await fs.promises.mkdir(subOkNestedDir, { recursive: true });
          await fs.promises.writeFile(
            path.join(subOkNestedDir, 'SubNested.xml'),
            '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.17"><Subsystem><Properties><Name>SubNested</Name></Properties></Subsystem></MetaDataObject>',
            'utf8',
          );
        } else {
          const subOkDir = path.join(subsystemsDir, 'SubOk');
          await fs.promises.mkdir(subOkDir, { recursive: true });
          await fs.promises.writeFile(
            path.join(subOkDir, 'Subsystem.mdo'),
            '<mdclass:Subsystem xmlns:mdclass="http://g5.1c.ru/v8/dt/metadata/mdclass"><name>SubOk</name><subsystems>SubNested</subsystems></mdclass:Subsystem>',
            'utf8',
          );

          const subBrokenDir = path.join(subsystemsDir, 'SubBroken');
          await fs.promises.mkdir(subBrokenDir, { recursive: true });
          await fs.promises.writeFile(
            path.join(subBrokenDir, 'Subsystem.mdo'),
            '<mdclass:Subsystem xmlns:mdclass="http://g5.1c.ru/v8/dt/metadata/mdclass"><name>SubBroken</name></mdclass:Subsystem>',
            'utf8',
          );

          const subOkNestedDir = path.join(subOkDir, 'Subsystems', 'SubNested');
          await fs.promises.mkdir(subOkNestedDir, { recursive: true });
          await fs.promises.writeFile(
            path.join(subOkNestedDir, 'Subsystem.mdo'),
            '<mdclass:Subsystem xmlns:mdclass="http://g5.1c.ru/v8/dt/metadata/mdclass"><name>SubNested</name><parentSubsystem>Subsystem.SubOk</parentSubsystem></mdclass:Subsystem>',
            'utf8',
          );
        }

        const provider = createProvider();
        provider.setRootNodes([fixture.root], new Map([[fixture.root, fakeTreeLoadContext(configPath, format, fixture.configurationId)]]));

        let failEacces = true;
        (fs.promises as unknown as { readFile: unknown }).readFile = async (targetPath: fs.PathLike, options?: unknown) => {
          if (failEacces && String(targetPath).includes('SubBroken')) {
            const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
            err.code = 'EACCES';
            throw err;
          }
          return (originalReadFile as (p: fs.PathLike, o?: unknown) => Promise<unknown>)(targetPath, options);
        };
        (fs.promises as unknown as { access: unknown }).access = async (targetPath: fs.PathLike, mode?: number) => {
          if (failEacces && String(targetPath).includes('SubBroken')) {
            const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
            err.code = 'EACCES';
            throw err;
          }
          return (originalAccess as (p: fs.PathLike, m?: number) => Promise<void>)(targetPath, mode);
        };

        await assert.rejects(
          Promise.resolve(provider.getChildren(subsystems)),
          (error: unknown) => resultErrorCode(error) === 'TREE_LOAD_FAILED',
          `Format ${format} must fail typed on EACCES for subsystem XML/MDO file`,
        );
        assert.notStrictEqual(
          (subsystems.properties as Record<string, unknown>)?._indexLoaded,
          true,
          `Format ${format} must not mark _indexLoaded on subsystem file failure`,
        );

        failEacces = false;
        const recoveredSubs = await provider.getChildren(subsystems);
        assert.strictEqual(recoveredSubs.length, 2, `Format ${format} must read top-level recovered subsystems`);
        const names = recoveredSubs.map((s) => s.name).sort();
        assert.deepStrictEqual(names, ['SubBroken', 'SubOk']);
        const okSub = recoveredSubs.find((s) => s.name === 'SubOk');
        assert.ok(okSub, 'SubOk must be found');
        assert.strictEqual(okSub.children?.length, 1, `SubOk must contain nested SubNested subsystem in ${format}`);
        assert.strictEqual(okSub.children?.[0]?.name, 'SubNested');
        assert.strictEqual(
          (subsystems.properties as Record<string, unknown>)?._indexLoaded,
          true,
          `Format ${format} must mark _indexLoaded on success after retry`,
        );
      }
    } finally {
      fs.promises.readFile = originalReadFile;
      fs.promises.access = originalAccess;
      await fs.promises.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
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

  test('a suspended root stays fenced when another root is replaced', async () => {
    const provider = createProvider();
    const fixtureA = createRootFixture('suspended-preserved-A');
    const fixtureB = createRootFixture('replaced-B');
    const replacementB = createRootFixture('replacement-B');
    replacementB.root.id = fixtureB.root.id;
    replacementB.root.name = fixtureB.root.name;
    Object.defineProperty(replacementB.root, 'configurationId', {
      configurable: true,
      enumerable: true,
      value: fixtureB.configurationId,
    });

    provider.setRootNodes(
      [fixtureA.root, fixtureB.root],
      new Map([
        [fixtureA.root, contextFor(fixtureA)],
        [fixtureB.root, contextFor(fixtureB)],
      ]),
    );
    const state = new ExtensionState();
    state.treeDataProvider = provider;
    Object.defineProperty(state, '_extensionContext', {
      configurable: true,
      value: { globalStoragePath: path.join(os.tmpdir(), 'tree-type-load-owner-preserved-root-cache') },
    });
    const lifecycle = createMetadataTreeLifecycle(state);
    const diskStarted = deferred<void>();
    const releaseDisk = deferred<void>();
    const parserInvalidationStarted = deferred<void>();
    const releaseParserInvalidation = deferred<void>();
    const mutableDiskCache = diskCache as unknown as { invalidateTreeCache: typeof diskCache.invalidateTreeCache };
    const originalInvalidateTreeCache = diskCache.invalidateTreeCache;
    mutableDiskCache.invalidateTreeCache = async () => {
      diskStarted.resolve();
      await releaseDisk.promise;
    };
    MetadataParser.invalidateTypeContentsCache = async () => {
      parserInvalidationStarted.resolve();
      await releaseParserInvalidation.promise;
    };
    MetadataParser.parseTypeIndex = async (_configPath, typeName) => [child(`${typeName}.Current`,'Current')];
    let invalidation: Promise<void> | undefined;

    try {
      invalidation = lifecycle.invalidateTreeCacheOnly(fixtureA.configPath);
      await Promise.all([diskStarted.promise, parserInvalidationStarted.promise]);

      provider.setRootNodes(
        [fixtureA.root, replacementB.root],
        new Map([
          [fixtureA.root, contextFor(fixtureA)],
          [replacementB.root, fakeTreeLoadContext(
            fixtureB.configPath,
            ConfigFormat.Designer,
            fixtureB.configurationId,
          )],
        ]),
      );

      const preservedRootRequests = await Promise.allSettled([
        Promise.resolve(provider.getChildren(fixtureA.catalogs)),
        provider.getReferenceableObjectsForTypeEditor(fixtureA.root),
      ]);
      assert.ok(preservedRootRequests.every((result) => result.status === 'rejected'));
      for (const result of preservedRootRequests) {
        if (result.status === 'rejected') {
          assert.strictEqual(resultErrorCode(result.reason), 'TREE_LOAD_SUPERSEDED');
        }
      }

      const replacementChildren = await provider.getChildren(replacementB.catalogs);
      assert.deepStrictEqual(replacementChildren.map((node) => node.name), ['Current']);
    } finally {
      releaseDisk.resolve();
      releaseParserInvalidation.resolve();
      if (invalidation) {
        await invalidation;
      }
      lifecycle.dispose();
      mutableDiskCache.invalidateTreeCache = originalInvalidateTreeCache;
    }
  });

  test('both editor scopes reject when an already-loaded type folder is invalidated during another load', async () => {
    const provider = createProvider();
    const fixture = createRootFixture('editor-node-version');
    const documents: TreeNode = {
      id: 'Documents',
      name: 'Документы',
      type: MetadataType.Document,
      properties: {},
      children: [],
      parent: fixture.root,
    };
    fixture.root.children?.push(documents);
    const existingCatalog = child('Catalogs.Existing', 'Existing');
    existingCatalog.parent = fixture.catalogs;
    fixture.catalogs.children = [existingCatalog];
    fixture.catalogs.properties = { _indexLoaded: true } as TreeNode['properties'];
    provider.setRootNodes([fixture.root], new Map([[fixture.root, contextFor(fixture)]]));

    const parseStarted = deferred<void>();
    const releaseDocuments = deferred<TreeNode[]>();
    MetadataParser.parseTypeIndex = async (_configPath, typeName) => {
      if (typeName === 'Documents') {
        parseStarted.resolve();
        return releaseDocuments.promise;
      }
      return [child(`${typeName}.Fresh`, 'Fresh')];
    };

    const pending = [
      provider.getReferenceableObjectsForTypeEditor(fixture.root),
      provider.getObjectableObjectsForEditor(fixture.root),
    ];
    try {
      await parseStarted.promise;
      provider.invalidateLoadedChildren(fixture.catalogs);
      releaseDocuments.resolve([child('Documents.Existing', 'Existing')]);

      const staleResults = await Promise.allSettled(pending);
      assert.ok(staleResults.every((result) => result.status === 'rejected'));
      for (const result of staleResults) {
        if (result.status === 'rejected') {
          assert.strictEqual(resultErrorCode(result.reason), 'TREE_LOAD_SUPERSEDED');
        }
      }

      const [references, objects] = await Promise.all([
        provider.getReferenceableObjectsForTypeEditor(fixture.root),
        provider.getObjectableObjectsForEditor(fixture.root),
      ]);
      assert.ok(references.find((group) => group.referenceKind === 'CatalogRef')?.objectNames.includes('Fresh'));
      assert.ok(objects.some((group) => group.objectNames.includes('Fresh')));
    } finally {
      releaseDocuments.resolve([]);
      await Promise.allSettled(pending);
    }
  });

  for (const transition of ['replacement', 'dispose'] as const) {
    test(`late parser rejection reports ${transition} instead of an active load failure`, async () => {
      const provider = createProvider();
      const fixture = createRootFixture(`late-rejection-${transition}`);
      provider.setRootNodes([fixture.root], new Map([[fixture.root, contextFor(fixture)]]));
      const parseStarted = deferred<void>();
      const rejectParse = deferred<TreeNode[]>();
      MetadataParser.parseTypeIndex = async () => {
        parseStarted.resolve();
        return rejectParse.promise;
      };

      const pending = Promise.resolve(provider.getChildren(fixture.catalogs));
      await parseStarted.promise;
      if (transition === 'replacement') {
        const replacement = createRootFixture(`late-rejection-${transition}-replacement`);
        replacement.root.id = fixture.root.id;
        replacement.root.name = fixture.root.name;
        Object.defineProperty(replacement.root, 'configurationId', {
          configurable: true,
          enumerable: true,
          value: fixture.configurationId,
        });
        provider.setRootNodes(
          [replacement.root],
          new Map([[replacement.root, fakeTreeLoadContext(
            fixture.configPath,
            ConfigFormat.Designer,
            fixture.configurationId,
          )]]),
        );
      } else {
        provider.dispose();
      }

      rejectParse.reject(new Error('late injected parser rejection'));
      const result = await Promise.allSettled([pending]);
      assert.strictEqual(result[0]?.status, 'rejected');
      if (result[0]?.status === 'rejected') {
        assert.strictEqual(
          resultErrorCode(result[0].reason),
          transition === 'dispose' ? 'TREE_LOAD_DISPOSED' : 'TREE_LOAD_SUPERSEDED',
        );
      }
    });
  }

  test('configuration invalidation starts parser fencing before the first tree-disk await', async () => {
    const provider = createProvider();
    const fixture = createRootFixture('disk-await-invalidation');
    provider.setRootNodes([fixture.root], new Map([[fixture.root, contextFor(fixture)]]));
    const state = new ExtensionState();
    state.treeDataProvider = provider;
    Object.defineProperty(state, '_extensionContext', {
      configurable: true,
      value: { globalStoragePath: path.join(os.tmpdir(), 'tree-type-load-owner-disk-cache') },
    });
    const lifecycle = createMetadataTreeLifecycle(state);
    const diskStarted = deferred<void>();
    const releaseDisk = deferred<void>();
    const releaseParserInvalidation = deferred<void>();
    const releaseParse = deferred<TreeNode[]>();
    const parseStarted = deferred<void>();
    let parseCalls = 0;
    let parserInvalidationCalls = 0;
    const originalInvalidateTreeCache = diskCache.invalidateTreeCache;
    (diskCache as unknown as { invalidateTreeCache: typeof diskCache.invalidateTreeCache }).invalidateTreeCache = async () => {
      diskStarted.resolve();
      await releaseDisk.promise;
    };
    MetadataParser.invalidateTypeContentsCache = async () => {
      parserInvalidationCalls += 1;
      await releaseParserInvalidation.promise;
    };
    MetadataParser.parseTypeIndex = async () => {
      parseCalls += 1;
      if (parseCalls === 1) {
        parseStarted.resolve();
        return releaseParse.promise;
      }
      return [child('Catalogs.DuringInvalidation')];
    };
    let invalidation: Promise<void> | undefined;
    let staleLoad: Promise<TreeNode[]> | undefined;

    try {
      staleLoad = Promise.resolve(provider.getChildren(fixture.catalogs));
      await parseStarted.promise;
      invalidation = lifecycle.invalidateTreeCacheOnly(fixture.configPath);
      await diskStarted.promise;
      assert.strictEqual(
        parserInvalidationCalls,
        1,
        'parser fencing must start synchronously before the first tree-cache disk await',
      );

      const suspendedRequest = Promise.resolve(provider.getChildren(fixture.catalogs));
      await assert.rejects(
        suspendedRequest,
        (error: unknown) => resultErrorCode(error) === 'TREE_LOAD_SUPERSEDED',
      );
      assert.strictEqual(parseCalls, 1, 'suspension must happen before the first tree-cache disk await');
      assert.deepStrictEqual(fixture.catalogs.children, [], 'the old visible root stays intact during invalidation');

      releaseParse.resolve([child('Catalogs.BeforeInvalidation')]);
      const staleResult = await Promise.allSettled([staleLoad]);
      assert.strictEqual(staleResult[0]?.status, 'rejected');
      if (staleResult[0]?.status === 'rejected') {
        assert.strictEqual(resultErrorCode(staleResult[0].reason), 'TREE_LOAD_SUPERSEDED');
      }
    } finally {
      releaseDisk.resolve();
      releaseParserInvalidation.resolve();
      releaseParse.resolve([]);
      if (staleLoad) {
        await Promise.allSettled([staleLoad]);
      }
      if (invalidation) {
        await invalidation;
      }
      lifecycle.dispose();
      (diskCache as unknown as { invalidateTreeCache: typeof diskCache.invalidateTreeCache }).invalidateTreeCache = originalInvalidateTreeCache;
    }
  });

  test('type-index parser and publication stay behind the shared coordinator', () => {
    const sourceRoot = path.resolve(__dirname, '../../..', 'src');
    const sourceFiles: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          visit(entryPath);
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
          sourceFiles.push(entryPath);
        }
      }
    };
    visit(sourceRoot);

    const parserOwners = sourceFiles
      .filter((filePath) => /MetadataParser\.parseTypeIndex\s*\(/.test(fs.readFileSync(filePath, 'utf8')))
      .map((filePath) => path.relative(sourceRoot, filePath).replace(/\\/g, '/'))
      .sort();
    assert.deepStrictEqual(parserOwners, [
      'providers/treeTypeLoadCoordinator.ts',
      'rolesEditor/metadataLoader.ts',
    ]);

    const rawParserOwners = sourceFiles
      .filter((filePath) => /(?:DesignerParser|EdtParser)\.parseTypeIndex\s*\(/.test(fs.readFileSync(filePath, 'utf8')))
      .map((filePath) => path.relative(sourceRoot, filePath).replace(/\\/g, '/'))
      .sort();
    assert.deepStrictEqual(rawParserOwners, ['agent/agentRoleRights.ts', 'parsers/metadataParser.ts']);

    for (const loaderFile of ['providers/treeReferenceLoader.ts', 'providers/objectTypeLoader.ts']) {
      const source = fs.readFileSync(path.join(sourceRoot, loaderFile), 'utf8');
      assert.doesNotMatch(source, /MetadataParser|parseTypeIndex\s*\(/, `${loaderFile} must remain a pure projection`);
      assert.doesNotMatch(source, /\.children\s*=/, `${loaderFile} must not publish tree children`);
      assert.doesNotMatch(
        source,
        /\.(?:buildCache|removeNode|replaceNode|clearLoadContexts|setLoadContext|setLoadContexts)\s*\(/,
        `${loaderFile} must not mutate the tree cache`,
      );
    }
  });
});
