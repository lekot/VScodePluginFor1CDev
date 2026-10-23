import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MetadataType, type TreeNode } from '../../src/models/treeNode';
import { DesignerParser } from '../../src/parsers/designerParser';
import { ConfigFormat } from '../../src/parsers/formatDetector';
import { MetadataTreeDataProvider } from '../../src/providers/treeDataProvider';
import type { TreeLoadErrorCode } from '../../src/types/treeTypeLoadResult';
import { fakeTreeLoadContext } from '../helpers/fakeTreeLoadContext';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

interface ElementTreeFixture {
  readonly configPath: string;
  readonly root: TreeNode;
  readonly catalogs: TreeNode;
  readonly object: TreeNode;
  readonly attributes: TreeNode;
  readonly tabularSections: TreeNode;
}

interface SubsystemTreeFixture {
  readonly configPath: string;
  readonly root: TreeNode;
  readonly subsystemFolder: TreeNode;
  readonly subsystem: TreeNode;
  readonly nestedSubsystem: TreeNode;
}

interface ElementParserCall {
  readonly configPath: string;
  readonly typeName: string;
  readonly elementName: string;
  readonly element: TreeNode | undefined;
}

interface ParserBarrier {
  readonly calls: ElementParserCall[];
  readonly started: Promise<void>;
  release(): void;
  restore(): void;
}

function createElementTree(configPath: string, label: string): ElementTreeFixture {
  const root: TreeNode = {
    id: 'Configuration',
    name: 'Configuration',
    type: MetadataType.Configuration,
    properties: {},
    filePath: path.join(configPath, 'Configuration.xml'),
    children: [],
  };
  const catalogs: TreeNode = {
    id: 'Catalogs',
    name: 'Catalogs',
    type: MetadataType.Catalog,
    properties: {},
    children: [],
    parent: root,
  };
  const object: TreeNode = {
    id: 'Catalogs.Item',
    name: 'Item',
    type: MetadataType.Catalog,
    properties: {
      Synonym: `Published ${label}`,
      _parseError: new Error(`object parse marker ${label}`),
    },
    children: [],
    parent: catalogs,
  };
  const attributes: TreeNode = {
    id: 'Attributes',
    name: 'Attributes',
    type: MetadataType.Attribute,
    properties: {
      _lazy: true,
      _parseError: new Error(`attribute parse marker ${label}`),
    },
    children: [],
    parent: object,
  };
  const tabularSections: TreeNode = {
    id: 'TabularSections',
    name: 'Tabular Sections',
    type: MetadataType.TabularSection,
    properties: { _lazy: true },
    children: [],
    parent: object,
  };
  object.children = [attributes, tabularSections];
  catalogs.children = [object];
  root.children = [catalogs];
  return { configPath, root, catalogs, object, attributes, tabularSections };
}

function createSubsystemTree(configPath: string, label: string): SubsystemTreeFixture {
  const root: TreeNode = {
    id: 'Configuration',
    name: 'Configuration',
    type: MetadataType.Configuration,
    properties: {},
    filePath: path.join(configPath, 'Configuration.xml'),
    children: [],
  };
  const subsystemFolder: TreeNode = {
    id: 'Subsystems',
    name: 'Subsystems',
    type: MetadataType.Subsystem,
    properties: {},
    children: [],
    parent: root,
  };
  const subsystem: TreeNode = {
    id: 'Subsystems.Main',
    name: 'Main',
    type: MetadataType.Subsystem,
    properties: {
      _lazy: true,
      Synonym: `Published ${label}`,
      _parseError: new Error(`subsystem parse marker ${label}`),
    },
    children: [],
    filePath: path.join(configPath, 'Subsystems', 'Main.xml'),
    parent: subsystemFolder,
  };
  const nestedSubsystem: TreeNode = {
    id: 'Subsystems.Main.Nested',
    name: 'Nested',
    type: MetadataType.Subsystem,
    properties: {},
    children: [],
    parent: subsystem,
  };
  subsystem.children = [nestedSubsystem];
  subsystemFolder.children = [subsystem];
  root.children = [subsystemFolder];
  return { configPath, root, subsystemFolder, subsystem, nestedSubsystem };
}

function createCatalogXml(synonym: string, attributeName: string, includeTabularSection = false): string {
  const tabularSection = includeTabularSection
    ? `<TabularSection><Properties><Name>Lines</Name><Synonym>Rows from disk</Synonym></Properties><ChildObjects><Attribute><Properties><Name>Quantity</Name></Properties></Attribute></ChildObjects></TabularSection>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20">
  <Catalog uuid="11111111-1111-4111-8111-111111111111">
    <Properties><Name>Item</Name><Synonym>${synonym}</Synonym></Properties>
    <ChildObjects>
      <Attribute><Properties><Name>${attributeName}</Name><Synonym>Attribute from disk</Synonym></Properties></Attribute>
      ${tabularSection}
    </ChildObjects>
  </Catalog>
</MetaDataObject>`;
}

function createSubsystemXml(synonym: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20">
  <Subsystem><Properties><Name>Main</Name><Synonym>${synonym}</Synonym></Properties><ChildObjects/></Subsystem>
</MetaDataObject>`;
}

async function prepareCatalog(configPath: string, xml: string): Promise<string> {
  const typeDir = path.join(configPath, 'Catalogs');
  await fs.promises.mkdir(typeDir, { recursive: true });
  const xmlPath = path.join(typeDir, 'Item.xml');
  await fs.promises.writeFile(xmlPath, xml, 'utf8');
  return xmlPath;
}

async function prepareSubsystem(configPath: string, xml: string): Promise<string> {
  const subsystemDir = path.join(configPath, 'Subsystems');
  await fs.promises.mkdir(path.join(subsystemDir, 'Main'), { recursive: true });
  const xmlPath = path.join(subsystemDir, 'Main.xml');
  await fs.promises.writeFile(xmlPath, xml, 'utf8');
  return xmlPath;
}

function installElementParserBarrier(
  matches: (call: ElementParserCall) => boolean,
): ParserBarrier {
  const original = DesignerParser.loadChildrenForElement;
  const gate = deferred<void>();
  const started = deferred<void>();
  const calls: ElementParserCall[] = [];
  DesignerParser.loadChildrenForElement = async (...args) => {
    const call: ElementParserCall = {
      configPath: args[0],
      typeName: args[1],
      elementName: args[2],
      element: args[3],
    };
    if (matches(call)) {
      calls.push(call);
      if (calls.length === 1) {
        started.resolve(undefined);
      }
      await gate.promise;
    }
    return original.apply(DesignerParser, args);
  };
  return {
    calls,
    started: started.promise,
    release: () => gate.resolve(undefined),
    restore: () => { DesignerParser.loadChildrenForElement = original; },
  };
}

function assertElementUnchanged(fixture: ElementTreeFixture, expectedSynonym: string): void {
  assert.strictEqual(fixture.object.properties.Synonym, expectedSynonym);
  assert.match(String(fixture.object.properties._parseError), /object parse marker/);
  assert.strictEqual(fixture.attributes.properties._lazy, true);
  assert.match(String(fixture.attributes.properties._parseError), /attribute parse marker/);
  assert.deepStrictEqual(fixture.attributes.children, []);
}

function track<T>(pendingOperations: Set<Promise<unknown>>, promise: PromiseLike<T>): Promise<T> {
  const tracked = Promise.resolve(promise);
  pendingOperations.add(tracked);
  void tracked.then(
    () => pendingOperations.delete(tracked),
    () => pendingOperations.delete(tracked),
  );
  return tracked;
}

function settle<T>(promise: PromiseLike<T>): Promise<PromiseSettledResult<T>> {
  return Promise.resolve(promise).then(
    (value) => ({ status: 'fulfilled', value }),
    (reason: unknown) => ({ status: 'rejected', reason }),
  );
}

function treeLoadErrorCode(error: unknown): string | undefined {
  const seen = new Set<object>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string') {
      return candidate.code;
    }
    current = candidate.cause;
  }
  return undefined;
}

function assertTreeLoadRejection(
  outcome: PromiseSettledResult<unknown>,
  expectedCode: TreeLoadErrorCode,
): void {
  assert.strictEqual(outcome.status, 'rejected', `expected ${expectedCode} rather than a fulfilled stale result`);
  if (outcome.status === 'rejected') {
    assert.strictEqual(treeLoadErrorCode(outcome.reason), expectedCode);
  }
}

suite('lazy element publication ownership (#381)', () => {
  const providers = new Set<MetadataTreeDataProvider>();
  const tempRoots = new Set<string>();
  const parserBarriers = new Set<ParserBarrier>();
  const pendingOperations = new Set<Promise<unknown>>();

  function createProvider(): MetadataTreeDataProvider {
    const instance = new MetadataTreeDataProvider();
    providers.add(instance);
    return instance;
  }

  function createConfigPath(): string {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-element-publication-'));
    tempRoots.add(tempRoot);
    return path.join(tempRoot, 'configuration');
  }

  function installBarrier(matches: (call: ElementParserCall) => boolean): ParserBarrier {
    const barrier = installElementParserBarrier(matches);
    parserBarriers.add(barrier);
    return barrier;
  }

  function publish(provider: MetadataTreeDataProvider, fixtures: readonly ElementTreeFixture[]): void {
    provider.setRootNodes(
      fixtures.map((fixture) => fixture.root),
      new Map(fixtures.map((fixture) => [
        fixture.root,
        fakeTreeLoadContext(fixture.configPath, ConfigFormat.Designer),
      ] as const)),
    );
  }

  setup(() => {
    providers.clear();
    tempRoots.clear();
    parserBarriers.clear();
    pendingOperations.clear();
  });

  teardown(async () => {
    for (const barrier of parserBarriers) {
      barrier.release();
    }
    await Promise.allSettled([...pendingOperations]);
    for (const barrier of parserBarriers) {
      barrier.restore();
    }
    parserBarriers.clear();
    for (const instance of providers) {
      instance.dispose();
    }
    providers.clear();
    await Promise.all([...tempRoots].map((root) => fs.promises.rm(root, { recursive: true, force: true })));
    tempRoots.clear();
  });

  test('real Designer parsing mutates a detached ancestor chain and stale A→B→A completion cannot publish by matching ids', async () => {
    const provider = createProvider();
    const a1 = createElementTree(createConfigPath(), 'A1');
    const b = createElementTree(createConfigPath(), 'B');
    const a2 = createElementTree(a1.configPath, 'A2');
    await prepareCatalog(a1.configPath, createCatalogXml('From disk A', 'LoadedA'));
    publish(provider, [a1, b]);

    const originalObjectProperties = a1.object.properties;
    const originalAttributeProperties = a1.attributes.properties;
    const barrier = installBarrier((call) => call.configPath === a1.configPath && call.typeName === 'Catalogs');
    const pending = track(pendingOperations, Promise.resolve(provider.getChildren(a1.attributes)));
    await barrier.started;

    publish(provider, [b]);
    publish(provider, [a2, b]);
    barrier.release();
    const outcome = await settle(pending);

    assert.strictEqual(a1.object.properties, originalObjectProperties);
    assert.strictEqual(a1.attributes.properties, originalAttributeProperties);
    assertElementUnchanged(a1, 'Published A1');
    assertElementUnchanged(a2, 'Published A2');
    assertElementUnchanged(b, 'Published B');
    assert.strictEqual(provider.findNodeById('Attributes.LoadedA'), null, 'stale children must not enter the active cache');
    assertTreeLoadRejection(outcome, 'TREE_LOAD_SUPERSEDED');

    const parserObject = barrier.calls[0]?.element;
    assert.ok(parserObject, 'the real Designer parser must receive the object ancestor');
    assert.notStrictEqual(parserObject, a1.object, 'the parser must not receive the published object instance');
    assert.notStrictEqual(parserObject.parent, a1.catalogs, 'the parser input must have a detached type-folder ancestor');
    assert.notStrictEqual(parserObject.parent?.parent, a1.root, 'the parser input must have a detached configuration ancestor');
    assert.notStrictEqual(parserObject.children, a1.object.children, 'the parser input must not share the published children array');
    assert.notStrictEqual(parserObject.children?.[0], a1.attributes, 'the parser input must not share published child nodes');
    assert.strictEqual(parserObject.properties.Synonym, 'From disk A', 'the real parser must mutate its detached input');
  });

  test('same ids in simultaneously published roots keep parser context and children root-local', async () => {
    const provider = createProvider();
    const a = createElementTree(createConfigPath(), 'A');
    const b = createElementTree(createConfigPath(), 'B');
    await prepareCatalog(a.configPath, createCatalogXml('Disk A', 'OnlyA'));
    await prepareCatalog(b.configPath, createCatalogXml('Disk B', 'OnlyB'));
    publish(provider, [a, b]);

    const barrier = installBarrier((call) => call.typeName === 'Catalogs' && call.elementName === 'Item');
    const pendingA = track(pendingOperations, Promise.resolve(provider.getChildren(a.attributes)));
    const pendingB = track(pendingOperations, Promise.resolve(provider.getChildren(b.attributes)));
    await barrier.started;
    await new Promise<void>((resolve) => setImmediate(resolve));
    barrier.release();
    const [childrenA, childrenB] = await Promise.all([pendingA, pendingB]);

    assert.deepStrictEqual(new Set(barrier.calls.map((call) => call.configPath)), new Set([a.configPath, b.configPath]));
    assert.deepStrictEqual(childrenA.map((child) => child.name), ['OnlyA']);
    assert.deepStrictEqual(childrenB.map((child) => child.name), ['OnlyB']);
    assert.strictEqual(a.object.properties.Synonym, 'Disk A');
    assert.strictEqual(b.object.properties.Synonym, 'Disk B');
    assert.strictEqual(a.attributes.children?.[0]?.parent, a.attributes);
    assert.strictEqual(b.attributes.children?.[0]?.parent, b.attributes);
  });

  test('concurrent expansions of one R6 placeholder share one parser read', async () => {
    const provider = createProvider();
    const fixture = createElementTree(createConfigPath(), 'shared');
    await prepareCatalog(fixture.configPath, createCatalogXml('Disk', 'Shared'));
    publish(provider, [fixture]);

    const barrier = installBarrier((call) => call.typeName === 'Catalogs' && call.elementName === 'Item');
    const first = track(pendingOperations, Promise.resolve(provider.getChildren(fixture.attributes)));
    const second = track(pendingOperations, Promise.resolve(provider.getChildren(fixture.attributes)));
    await barrier.started;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const readsAtBarrier = barrier.calls.length;
    barrier.release();
    await Promise.all([first, second]);

    assert.strictEqual(readsAtBarrier, 1, 'a slot has one in-flight owner even when VS Code requests it twice');
    assert.strictEqual(fixture.attributes.children?.[0]?.name, 'Shared');
  });

  test('invalidating a lazy element fences its in-flight parse without marking it loaded', async () => {
    const provider = createProvider();
    const fixture = createElementTree(createConfigPath(), 'invalidated');
    await prepareCatalog(fixture.configPath, createCatalogXml('Disk', 'Invalidated'));
    publish(provider, [fixture]);

    const barrier = installBarrier((call) => call.configPath === fixture.configPath && call.typeName === 'Catalogs');
    const pending = track(pendingOperations, Promise.resolve(provider.getChildren(fixture.attributes)));
    await barrier.started;
    provider.invalidateLoadedChildren(fixture.attributes);
    barrier.release();
    const outcome = await settle(pending);

    assertElementUnchanged(fixture, 'Published invalidated');
    assert.strictEqual(provider.findNodeById('Attributes.Invalidated'), null);
    assertTreeLoadRejection(outcome, 'TREE_LOAD_SUPERSEDED');
  });

  test('dispose fences a lazy element completion already inside the parser', async () => {
    const provider = createProvider();
    const fixture = createElementTree(createConfigPath(), 'disposed');
    await prepareCatalog(fixture.configPath, createCatalogXml('Disk', 'Disposed'));
    publish(provider, [fixture]);

    const barrier = installBarrier((call) => call.configPath === fixture.configPath && call.typeName === 'Catalogs');
    const pending = track(pendingOperations, Promise.resolve(provider.getChildren(fixture.attributes)));
    await barrier.started;
    provider.dispose();
    barrier.release();
    const outcome = await settle(pending);

    assertElementUnchanged(fixture, 'Published disposed');
    assert.strictEqual(provider.findNodeById('Attributes.Disposed'), null);
    assertTreeLoadRejection(outcome, 'TREE_LOAD_DISPOSED');
  });

  test('optimistic deletion prevents a pending lazy completion from republishing removed children', async () => {
    const provider = createProvider();
    const fixture = createElementTree(createConfigPath(), 'deleted');
    await prepareCatalog(fixture.configPath, createCatalogXml('Disk', 'DeletedLate'));
    publish(provider, [fixture]);

    const barrier = installBarrier((call) => call.configPath === fixture.configPath && call.typeName === 'Catalogs');
    const pending = track(pendingOperations, Promise.resolve(provider.getChildren(fixture.attributes)));
    await barrier.started;
    const token = provider.applyOptimisticDelete(fixture.attributes, 'delete-lazy-attributes');
    assert.ok(token, 'the lazy detail slot must be removed from its live parent');
    barrier.release();
    const outcome = await settle(pending);

    assert.strictEqual(fixture.object.children?.includes(fixture.attributes), false);
    assert.strictEqual(provider.findNodeById('Attributes'), null);
    assert.strictEqual(provider.findNodeById('Attributes.DeletedLate'), null, 'late children must not re-enter cache');
    assert.strictEqual(fixture.attributes.properties._lazy, true, 'the detached deleted slot remains unloaded');
    assertTreeLoadRejection(outcome, 'TREE_LOAD_SUPERSEDED');
  });

  test('a failed parse leaves the detail slot retryable and a corrected file publishes once', async () => {
    const provider = createProvider();
    const fixture = createElementTree(createConfigPath(), 'retry');
    const xmlPath = await prepareCatalog(fixture.configPath, '<MetaDataObject><Catalog>broken');
    publish(provider, [fixture]);

    const failedOutcome = await settle(track(
      pendingOperations,
      Promise.resolve(provider.getChildren(fixture.attributes)),
    ));
    assert.strictEqual(fixture.attributes.properties._lazy, true);
    assert.deepStrictEqual(fixture.attributes.children, []);
    assert.match(String(fixture.object.properties._parseError), /object parse marker/);
    assert.match(String(fixture.attributes.properties._parseError), /attribute parse marker/);
    assert.strictEqual(failedOutcome.status, 'rejected', 'a malformed parse must remain retryable');

    await fs.promises.writeFile(xmlPath, createCatalogXml('Corrected', 'Retry'), 'utf8');
    const loaded = await track(pendingOperations, Promise.resolve(provider.getChildren(fixture.attributes)));
    assert.deepStrictEqual(loaded.map((child) => child.name), ['Retry']);
    assert.strictEqual(fixture.attributes.properties._lazy, undefined);
    assert.strictEqual(fixture.object.properties.Synonym, 'Corrected');
  });

  test('successful retry clears typed parse errors with cause and custom metadata', async () => {
    const provider = createProvider();
    const fixture = createElementTree(createConfigPath(), 'typed-error');
    await prepareCatalog(fixture.configPath, createCatalogXml('Corrected', 'Recovered'));
    const parseCause = Object.assign(new Error('underlying read failure'), { code: 'E_READ' });
    const typedParseError = Object.assign(new Error('previous parse failure'), {
      code: 'E_PARSE',
      cause: parseCause,
      detail: { source: 'test fixture' },
    });
    fixture.object.properties._parseError = typedParseError;
    fixture.attributes.properties._parseError = typedParseError;
    publish(provider, [fixture]);

    const loaded = await track(pendingOperations, Promise.resolve(provider.getChildren(fixture.attributes)));

    assert.deepStrictEqual(loaded.map((child) => child.name), ['Recovered']);
    assert.strictEqual(fixture.object.properties._parseError, undefined);
    assert.strictEqual(fixture.attributes.properties._parseError, undefined);
  });

  test('a parsed disk value does not overwrite a same-property update made while reading', async () => {
    const provider = createProvider();
    const fixture = createElementTree(createConfigPath(), 'concurrent-property-update');
    await prepareCatalog(fixture.configPath, createCatalogXml('Disk value', 'Loaded'));
    publish(provider, [fixture]);

    const barrier = installBarrier((call) => call.configPath === fixture.configPath && call.typeName === 'Catalogs');
    const pending = track(pendingOperations, Promise.resolve(provider.getChildren(fixture.attributes)));
    await barrier.started;
    fixture.object.properties.Synonym = 'Concurrent live update';
    barrier.release();
    const outcome = await settle(pending);

    assert.strictEqual(outcome.status, 'fulfilled');
    assert.strictEqual(fixture.object.properties.Synonym, 'Concurrent live update');
    if (outcome.status === 'fulfilled') {
      assert.deepStrictEqual(outcome.value.map((child) => child.name), ['Loaded']);
    }
  });

  test('stale R6 tabular-section parsing cannot publish into a replacement root', async () => {
    const provider = createProvider();
    const oldTree = createElementTree(createConfigPath(), 'tabular-old');
    const replacement = createElementTree(createConfigPath(), 'tabular-new');
    await prepareCatalog(oldTree.configPath, createCatalogXml('Old disk', 'OldAttribute', true));
    publish(provider, [oldTree]);

    const barrier = installBarrier((call) => call.configPath === oldTree.configPath && call.typeName === 'Catalogs');
    const pending = track(pendingOperations, Promise.resolve(provider.getChildren(oldTree.tabularSections)));
    await barrier.started;
    publish(provider, [replacement]);
    barrier.release();
    const outcome = await settle(pending);

    assert.strictEqual(oldTree.object.properties.Synonym, 'Published tabular-old');
    assert.strictEqual(oldTree.tabularSections.properties._lazy, true);
    assert.deepStrictEqual(oldTree.tabularSections.children, []);
    assert.strictEqual(replacement.object.properties.Synonym, 'Published tabular-new');
    assert.strictEqual(replacement.tabularSections.properties._lazy, true);
    assert.deepStrictEqual(replacement.tabularSections.children, []);
    assert.strictEqual(provider.findNodeById('TabularSections.Lines'), null);
    assertTreeLoadRejection(outcome, 'TREE_LOAD_SUPERSEDED');
  });

  test('stale tabular-column parsing cannot attach columns to a replacement section with the same id', async () => {
    const provider = createProvider();
    const oldTree = createElementTree(createConfigPath(), 'columns-old');
    const replacement = createElementTree(createConfigPath(), 'columns-new');
    const xmlPath = await prepareCatalog(oldTree.configPath, createCatalogXml('Old disk', 'OldAttribute', true));
    const oldSection: TreeNode = {
      id: 'TabularSections.Lines',
      name: 'Lines',
      type: MetadataType.TabularSection,
      properties: {},
      children: [],
      parent: oldTree.tabularSections,
      parentFilePath: xmlPath,
    };
    const oldColumns: TreeNode = {
      id: 'TabularSections.Lines.Attributes',
      name: 'Реквизиты',
      type: MetadataType.Attribute,
      properties: { type: 'TabularSectionColumns', _lazy: true },
      children: [],
      parent: oldSection,
      parentFilePath: xmlPath,
    };
    oldSection.children = [oldColumns];
    oldTree.tabularSections.children = [oldSection];
    publish(provider, [oldTree]);

    const original = DesignerParser.loadTabularSectionColumnChildren;
    const gate = deferred<void>();
    const started = deferred<void>();
    const parsedSections: TreeNode[] = [];
    DesignerParser.loadTabularSectionColumnChildren = async (sectionInstance) => {
      parsedSections.push(sectionInstance);
      if (parsedSections.length === 1) {
        started.resolve(undefined);
      }
      await gate.promise;
      return original.call(DesignerParser, sectionInstance);
    };
    const release = (): void => gate.resolve(undefined);
    const restore = (): void => { DesignerParser.loadTabularSectionColumnChildren = original; };
    const cleanupBarrier: ParserBarrier = {
      calls: [],
      started: started.promise,
      release,
      restore,
    };
    parserBarriers.add(cleanupBarrier);

    const pending = track(pendingOperations, Promise.resolve(provider.getChildren(oldColumns)));
    await started.promise;
    publish(provider, [replacement]);
    release();
    const outcome = await settle(pending);

    assert.deepStrictEqual(oldColumns.children, []);
    assert.strictEqual(oldColumns.properties._lazy, true);
    assert.deepStrictEqual(replacement.tabularSections.children, []);
    assert.strictEqual(provider.findNodeById('TabularSections.Lines.Quantity'), null);
    assertTreeLoadRejection(outcome, 'TREE_LOAD_SUPERSEDED');
    assert.notStrictEqual(parsedSections[0], oldSection, 'the nested-column parser must receive a detached section instance');
    assert.notStrictEqual(parsedSections[0]?.parent, oldTree.tabularSections);
  });

  test('stale subsystem parsing preserves its existing child subsystem and cannot mutate a replacement', async () => {
    const provider = createProvider();
    const oldTree = createSubsystemTree(createConfigPath(), 'sub-old');
    const replacement = createSubsystemTree(createConfigPath(), 'sub-new');
    await prepareSubsystem(oldTree.configPath, createSubsystemXml('Loaded from old disk'));
    provider.setRootNodes(
      [oldTree.root],
      new Map([[oldTree.root, fakeTreeLoadContext(oldTree.configPath, ConfigFormat.Designer)]]),
    );

    const barrier = installBarrier((call) => call.configPath === oldTree.configPath && call.typeName === 'Subsystems');
    const pending = track(pendingOperations, Promise.resolve(provider.getChildren(oldTree.subsystem)));
    await barrier.started;
    provider.setRootNodes(
      [replacement.root],
      new Map([[replacement.root, fakeTreeLoadContext(replacement.configPath, ConfigFormat.Designer)]]),
    );
    barrier.release();
    const outcome = await settle(pending);

    assert.strictEqual(oldTree.subsystem.properties.Synonym, 'Published sub-old');
    assert.strictEqual(oldTree.subsystem.properties._lazy, true);
    assert.deepStrictEqual(oldTree.subsystem.children, [oldTree.nestedSubsystem]);
    assert.strictEqual(replacement.subsystem.properties.Synonym, 'Published sub-new');
    assert.strictEqual(replacement.subsystem.properties._lazy, true);
    assert.deepStrictEqual(replacement.subsystem.children, [replacement.nestedSubsystem]);
    assert.strictEqual(provider.findNodeById('Subsystems.Main.CommandInterface'), null);
    assertTreeLoadRejection(outcome, 'TREE_LOAD_SUPERSEDED');
  });
});
