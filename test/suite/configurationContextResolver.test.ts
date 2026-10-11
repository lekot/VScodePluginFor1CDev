import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { ConfigFormat } from '../../src/parsers/formatDetector';
import {
  ConfigurationContextResolver,
  TreeNodeLike,
} from '../../src/services/configurationSession/ConfigurationContextResolver';
import {
  WorkspaceRegistry,
  WorkspaceRegistryError,
} from '../../src/services/configurationSession/WorkspaceRegistry';
import { WorkspaceRegistryCoordinator } from '../../src/services/configurationSession/WorkspaceRegistryCoordinator';

suite('ConfigurationContext and ConfigurationContextResolver (#256)', () => {
  let tempDir: string;
  let workspaceRoot: string;
  let parentConfigRoot: string;
  let nestedConfigRoot: string;
  let standaloneConfigRoot: string;
  let nonConfigDir: string;

  setup(async () => {
    tempDir = await fs.promises.realpath(
      await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cfg-context-test-')),
    );
    workspaceRoot = path.join(tempDir, 'workspace');
    await fs.promises.mkdir(workspaceRoot, { recursive: true });

    // Parent configuration at <workspace>/parentConfig
    parentConfigRoot = await createTestConfiguration(
      path.join(workspaceRoot, 'parentConfig'),
      '11111111-1111-1111-1111-111111111111',
    );

    // Nested configuration at <workspace>/parentConfig/nested/childConfig
    nestedConfigRoot = await createTestConfiguration(
      path.join(parentConfigRoot, 'nested', 'childConfig'),
      '22222222-2222-2222-2222-222222222222',
    );

    // Standalone configuration at <workspace>/standaloneConfig
    standaloneConfigRoot = await createTestConfiguration(
      path.join(workspaceRoot, 'standaloneConfig'),
      '33333333-3333-3333-3333-333333333333',
    );

    // Non-configuration directory
    nonConfigDir = path.join(workspaceRoot, 'nonConfig');
    await fs.promises.mkdir(nonConfigDir, { recursive: true });
    await fs.promises.writeFile(path.join(nonConfigDir, 'notes.txt'), 'hello world', 'utf8');
  });

  teardown(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined);
  });

  test('resolveFromResource with absolute path returns typed immutable ConfigurationContext', async () => {
    const registry = new WorkspaceRegistry();
    await registry.registerTargetedRoot({ configPath: standaloneConfigRoot, format: ConfigFormat.Designer });
    const resolver = new ConfigurationContextResolver(registry);

    const targetFile = path.join(standaloneConfigRoot, 'Catalogs', 'Items.xml');
    const context = await resolver.resolveFromResource(targetFile);

    assert.strictEqual(context.rootPath, standaloneConfigRoot);
    assert.strictEqual(context.format, ConfigFormat.Designer);
    assert.strictEqual(context.descriptorUuid, '33333333-3333-3333-3333-333333333333');
    assert.ok(context.configurationId.startsWith('cfg-'));
    assert.ok(context.rootUri.startsWith('file:'));
    assert.ok(context.descriptorUri.startsWith('file:'));
    assert.strictEqual(context.session.identity.configurationId, context.configurationId);
    assert.strictEqual(context.capabilities.read, true);
    assert.strictEqual(context.capabilities.write, true);
    assert.ok(Object.isFrozen(context), 'ConfigurationContext must be frozen and immutable');
  });

  test('capability snapshots cannot change the session mutation gate', async () => {
    const edtConfigRoot = await createTestEdtConfiguration(
      path.join(workspaceRoot, 'edtCapabilitySnapshot'),
      '66666666-6666-6666-6666-666666666666',
    );
    const registry = new WorkspaceRegistry();
    const readOnlySession = await registry.registerTargetedRoot({
      configPath: edtConfigRoot,
      format: ConfigFormat.EDT,
    });
    const writableSession = await registry.registerTargetedRoot({
      configPath: standaloneConfigRoot,
      format: ConfigFormat.Designer,
    });
    const resolver = new ConfigurationContextResolver(registry);
    const readOnlyContext = await resolver.resolveFromConfigurationId(readOnlySession.identity.configurationId);
    const writableContext = await resolver.resolveFromConfigurationId(writableSession.identity.configurationId);

    let readOnlyExecutionCount = 0;
    let writableExecutionCount = 0;
    const readOnlyContextMutation = Reflect.set(readOnlyContext.capabilities, 'write', true);
    const readOnlyIdentityMutation = Reflect.set(readOnlySession.identity.capabilities, 'write', true);
    const writableContextMutation = Reflect.set(writableContext.capabilities, 'write', false);
    const writableIdentityMutation = Reflect.set(writableSession.identity.capabilities, 'write', false);

    const readOnlyOutcome = await readOnlySession.enqueue({
      kind: 'capability-snapshot-read-only',
      execute: async () => {
        readOnlyExecutionCount++;
        return 'should-not-run';
      },
    });
    const writableOutcome = await writableSession.enqueue({
      kind: 'capability-snapshot-writable',
      execute: async () => {
        writableExecutionCount++;
        return 'written';
      },
    });

    assert.strictEqual(readOnlyOutcome.status, 'conflict');
    assert.strictEqual((readOnlyOutcome as { code?: string }).code, 'CONFIGURATION_CAPABILITY_UNSUPPORTED');
    assert.strictEqual(readOnlyExecutionCount, 0);
    assert.strictEqual(writableOutcome.status, 'committed');
    assert.strictEqual(writableExecutionCount, 1);
    assert.strictEqual(readOnlyContextMutation, false);
    assert.strictEqual(readOnlyIdentityMutation, false);
    assert.strictEqual(writableContextMutation, false);
    assert.strictEqual(writableIdentityMutation, false);
    for (const context of [readOnlyContext, writableContext]) {
      assert.notStrictEqual(context.capabilities, context.session.identity.capabilities);
      assert.ok(Object.isFrozen(context.capabilities), 'Capability snapshots must be frozen');
      assert.ok(Object.isFrozen(context.session.identity.capabilities), 'Session capabilities must be frozen');
      assert.deepStrictEqual(context.capabilities, context.session.identity.capabilities);
    }
  });

  test('resolveFromResource with file:// URI string and Uri-like object', async () => {
    const registry = new WorkspaceRegistry();
    await registry.registerTargetedRoot({ configPath: standaloneConfigRoot, format: ConfigFormat.Designer });
    const resolver = new ConfigurationContextResolver(registry);

    // file:// URI
    const fileUri = pathToFileURL(path.join(standaloneConfigRoot, 'Documents', 'Order.xml')).toString();
    const ctxFromUri = await resolver.resolveFromResource(fileUri);
    assert.strictEqual(ctxFromUri.rootPath, standaloneConfigRoot);

    // Uri-like duck type object ({ fsPath })
    const uriLike = { fsPath: path.join(standaloneConfigRoot, 'CommonModules', 'Common.xml') };
    const ctxFromDuck = await resolver.resolveFromResource(uriLike);
    assert.strictEqual(ctxFromDuck.rootPath, standaloneConfigRoot);
  });

  test('resolveFromResource on nested configuration resolves to deepest canonical owner', async () => {
    const registry = new WorkspaceRegistry();
    await registry.registerTargetedRoot({ configPath: parentConfigRoot, format: ConfigFormat.Designer });
    await registry.registerTargetedRoot({ configPath: nestedConfigRoot, format: ConfigFormat.Designer });
    const resolver = new ConfigurationContextResolver(registry);

    // Target inside nested configuration
    const nestedFile = path.join(nestedConfigRoot, 'Catalogs', 'ChildCatalog.xml');
    const nestedCtx = await resolver.resolveFromResource(nestedFile);
    assert.strictEqual(nestedCtx.rootPath, nestedConfigRoot, 'Must resolve to nested child configuration');
    assert.strictEqual(nestedCtx.descriptorUuid, '22222222-2222-2222-2222-222222222222');

    // Target in parent configuration (sibling to nested directory)
    const parentFile = path.join(parentConfigRoot, 'Catalogs', 'ParentCatalog.xml');
    const parentCtx = await resolver.resolveFromResource(parentFile);
    assert.strictEqual(parentCtx.rootPath, parentConfigRoot, 'Must resolve to parent configuration');
    assert.strictEqual(parentCtx.descriptorUuid, '11111111-1111-1111-1111-111111111111');
  });

  test('resolveFromResource on non-configuration path fails closed with CONFIGURATION_NOT_FOUND', async () => {
    const registry = new WorkspaceRegistry();
    await registry.registerTargetedRoot({ configPath: standaloneConfigRoot, format: ConfigFormat.Designer });
    const resolver = new ConfigurationContextResolver(registry);

    const nonConfigFile = path.join(nonConfigDir, 'notes.txt');
    await assert.rejects(
      async () => resolver.resolveFromResource(nonConfigFile),
      (err: unknown) => err instanceof WorkspaceRegistryError && err.code === 'CONFIGURATION_NOT_FOUND',
      'Must fail closed with CONFIGURATION_NOT_FOUND for non-configuration resource',
    );
  });

  test('resolveFromResource with requiredCapability throws CONFIGURATION_CAPABILITY_UNSUPPORTED when missing', async () => {
    const edtConfigRoot = await createTestEdtConfiguration(
      path.join(workspaceRoot, 'edtConfig'),
      '44444444-4444-4444-4444-444444444444',
    );
    const registry = new WorkspaceRegistry();
    await registry.registerTargetedRoot({ configPath: edtConfigRoot, format: ConfigFormat.EDT });
    const resolver = new ConfigurationContextResolver(registry);

    // EDT configuration has read: true, but write: false
    const targetFile = path.join(edtConfigRoot, 'src', 'Configuration', 'Configuration.mdo');
    await assert.rejects(
      async () => resolver.resolveFromResource(targetFile, 'write'),
      (err: unknown) =>
        err instanceof WorkspaceRegistryError && err.code === 'CONFIGURATION_CAPABILITY_UNSUPPORTED',
      'Must throw CONFIGURATION_CAPABILITY_UNSUPPORTED when required capability is missing',
    );
  });

  test('resolveFromTreeNode resolves leaf node, nested attribute, and ancestor parent walk', async () => {
    const registry = new WorkspaceRegistry();
    await registry.registerTargetedRoot({ configPath: parentConfigRoot, format: ConfigFormat.Designer });
    await registry.registerTargetedRoot({ configPath: nestedConfigRoot, format: ConfigFormat.Designer });
    const resolver = new ConfigurationContextResolver(registry);

    // Case 1: Leaf node with direct filePath in parent config
    const parentLeafNode: TreeNodeLike = {
      id: 'Catalog.Items',
      name: 'Items',
      filePath: path.join(parentConfigRoot, 'Catalogs', 'Items.xml'),
    };
    const ctx1 = await resolver.resolveFromTreeNode(parentLeafNode);
    assert.strictEqual(ctx1.rootPath, parentConfigRoot);

    // Case 2: Nested node with parentFilePath in nested config
    const nestedChildNode: TreeNodeLike = {
      id: 'Catalog.Sub.Attribute.Code',
      name: 'Code',
      parentFilePath: path.join(nestedConfigRoot, 'Catalogs', 'Sub.xml'),
    };
    const ctx2 = await resolver.resolveFromTreeNode(nestedChildNode);
    assert.strictEqual(ctx2.rootPath, nestedConfigRoot);

    // Case 3: Node with no filePath of its own, walking up parent chain
    const grandParentNode: TreeNodeLike = {
      id: 'Root.Parent',
      name: 'ParentConfig',
      filePath: path.join(parentConfigRoot, 'Configuration.xml'),
    };
    const middleNode: TreeNodeLike = {
      id: 'CatalogsGroup',
      name: 'Справочники',
      parent: grandParentNode,
    };
    const leafNoPath: TreeNodeLike = {
      id: 'CatalogPlaceholder',
      name: 'Placeholder',
      parent: middleNode,
    };
    const ctx3 = await resolver.resolveFromTreeNode(leafNoPath);
    assert.strictEqual(ctx3.rootPath, parentConfigRoot);

    // Case 4: Detached node without any file paths fails closed
    const detachedNode: TreeNodeLike = {
      id: 'detached',
      name: 'DetachedNode',
    };
    await assert.rejects(
      async () => resolver.resolveFromTreeNode(detachedNode),
      (err: unknown) => err instanceof WorkspaceRegistryError && err.code === 'CONFIGURATION_NOT_FOUND',
    );
  });

  test('resolveFromConfigurationId resolves known configuration and rejects unknown ID', async () => {
    const registry = new WorkspaceRegistry();
    const session = await registry.registerTargetedRoot({
      configPath: standaloneConfigRoot,
      format: ConfigFormat.Designer,
    });
    const resolver = new ConfigurationContextResolver(registry);

    const context = await resolver.resolveFromConfigurationId(session.identity.configurationId);
    assert.strictEqual(context.configurationId, session.identity.configurationId);
    assert.strictEqual(context.rootPath, standaloneConfigRoot);

    await assert.rejects(
      async () => resolver.resolveFromConfigurationId('cfg-unknown-id'),
      (err: unknown) => err instanceof WorkspaceRegistryError && err.code === 'CONFIGURATION_ID_UNKNOWN',
    );
  });

  test('resolveDefault handles single configuration, selection required, and capability filtering', async () => {
    const registry = new WorkspaceRegistry();
    const edtConfigRoot = await createTestEdtConfiguration(
      path.join(workspaceRoot, 'edtConfig2'),
      '55555555-5555-5555-5555-555555555555',
    );
    const sessionEdt = await registry.registerTargetedRoot({
      configPath: edtConfigRoot,
      format: ConfigFormat.EDT,
    });
    const resolver = new ConfigurationContextResolver(registry);

    // Single EDT configuration matches 'read'
    const defRead = await resolver.resolveDefault('read');
    assert.strictEqual(defRead.configurationId, sessionEdt.identity.configurationId);

    // But EDT configuration does not match 'write' -> CONFIGURATION_NOT_FOUND
    await assert.rejects(
      async () => resolver.resolveDefault('write'),
      (err: unknown) => err instanceof WorkspaceRegistryError && err.code === 'CONFIGURATION_NOT_FOUND',
    );

    // Register second (Designer) configuration which supports 'write'
    const sessionDesigner = await registry.registerTargetedRoot({
      configPath: standaloneConfigRoot,
      format: ConfigFormat.Designer,
    });

    // Exactly one configuration supports 'write' -> returns Designer
    const defWrite = await resolver.resolveDefault('write');
    assert.strictEqual(defWrite.configurationId, sessionDesigner.identity.configurationId);

    // Both support 'read' -> CONFIGURATION_SELECTION_REQUIRED
    await assert.rejects(
      async () => resolver.resolveDefault('read'),
      (err: unknown) =>
        err instanceof WorkspaceRegistryError && err.code === 'CONFIGURATION_SELECTION_REQUIRED',
    );
  });

  test('list and has reflect registered configurations', async () => {
    const registry = new WorkspaceRegistry();
    const sessionA = await registry.registerTargetedRoot({
      configPath: parentConfigRoot,
      format: ConfigFormat.Designer,
    });
    const sessionB = await registry.registerTargetedRoot({
      configPath: standaloneConfigRoot,
      format: ConfigFormat.Designer,
    });
    const resolver = new ConfigurationContextResolver(registry);

    assert.strictEqual(await resolver.has(sessionA.identity.configurationId), true);
    assert.strictEqual(await resolver.has(sessionB.identity.configurationId), true);
    assert.strictEqual(await resolver.has('cfg-nonexistent'), false);

    const list = await resolver.list();
    assert.strictEqual(list.length, 2);
    const ids = list.map((c) => c.configurationId);
    assert.ok(ids.includes(sessionA.identity.configurationId));
    assert.ok(ids.includes(sessionB.identity.configurationId));
  });

  test('works cleanly with WorkspaceRegistryCoordinator and targeted discovery fallback', async () => {
    const registry = new WorkspaceRegistry();
    const coordinator = new WorkspaceRegistryCoordinator(registry, {
      getWorkspaceFolders: () => [workspaceRoot],
    });
    const resolver = new ConfigurationContextResolver(coordinator);

    try {
      // Configuration was not manually pre-registered, coordinator does targeted discovery
      const targetFile = path.join(standaloneConfigRoot, 'Configuration.xml');
      const context = await resolver.resolveFromResource(targetFile);
      assert.strictEqual(context.rootPath, standaloneConfigRoot);
      assert.strictEqual(context.descriptorUuid, '33333333-3333-3333-3333-333333333333');

      // Now resolveFromConfigurationId works because coordinator registered the root
      const fromId = await resolver.resolveFromConfigurationId(context.configurationId);
      assert.strictEqual(fromId.configurationId, context.configurationId);
    } finally {
      await coordinator.dispose();
    }
  });

  test('stale or deleted configuration fails closed with CONFIGURATION_NOT_FOUND', async () => {
    const registry = new WorkspaceRegistry();
    await registry.registerTargetedRoot({ configPath: standaloneConfigRoot, format: ConfigFormat.Designer });
    const resolver = new ConfigurationContextResolver(registry);

    // Remove Configuration.xml
    await fs.promises.unlink(path.join(standaloneConfigRoot, 'Configuration.xml'));

    await assert.rejects(
      async () => resolver.resolveFromResource(path.join(standaloneConfigRoot, 'SomeFile.xml')),
      (err: unknown) => err instanceof WorkspaceRegistryError && err.code === 'CONFIGURATION_NOT_FOUND',
    );
  });

  test('resolveFromTreeNode with properties.configurationId or properties.configPath', async () => {
    const registry = new WorkspaceRegistry();
    const session = await registry.registerTargetedRoot({
      configPath: standaloneConfigRoot,
      format: ConfigFormat.Designer,
    });
    const resolver = new ConfigurationContextResolver(registry);

    // Node explicitly specifying configurationId in properties
    const nodeWithId: TreeNodeLike = {
      id: 'CustomNode',
      name: 'Custom',
      properties: { configurationId: session.identity.configurationId },
    };
    const ctxId = await resolver.resolveFromTreeNode(nodeWithId);
    assert.strictEqual(ctxId.configurationId, session.identity.configurationId);

    // Node specifying configPath in properties
    const nodeWithPath: TreeNodeLike = {
      id: 'CustomNodePath',
      name: 'CustomPath',
      properties: { configPath: standaloneConfigRoot },
    };
    const ctxPath = await resolver.resolveFromTreeNode(nodeWithPath);
    assert.strictEqual(ctxPath.rootPath, standaloneConfigRoot);
  });

  test('invalid or empty resource target throws CONFIGURATION_NOT_FOUND', async () => {
    const registry = new WorkspaceRegistry();
    const resolver = new ConfigurationContextResolver(registry);

    await assert.rejects(
      async () => resolver.resolveFromResource('   '),
      (err: unknown) => err instanceof WorkspaceRegistryError && err.code === 'CONFIGURATION_NOT_FOUND',
    );

    await assert.rejects(
      async () => resolver.resolveFromResource(null as unknown as string),
      (err: unknown) => err instanceof WorkspaceRegistryError && err.code === 'CONFIGURATION_NOT_FOUND',
    );
  });

  test('returned ConfigurationContext is strictly immutable and frozen', async () => {
    const registry = new WorkspaceRegistry();
    await registry.registerTargetedRoot({ configPath: standaloneConfigRoot, format: ConfigFormat.Designer });
    const resolver = new ConfigurationContextResolver(registry);

    const ctx = await resolver.resolveFromResource(standaloneConfigRoot);
    assert.ok(Object.isFrozen(ctx));
    assert.throws(() => {
      (ctx as unknown as Record<string, unknown>).rootPath = '/modified/path';
    }, /Cannot assign to read only property/);
  });

  test('getWorkspaceFolderForPath hook correctly maps workspaceFolderUri in context', async () => {
    const registry = new WorkspaceRegistry();
    await registry.registerTargetedRoot({ configPath: standaloneConfigRoot, format: ConfigFormat.Designer });
    const customWs = path.join(tempDir, 'custom-ws-folder');
    const resolver = new ConfigurationContextResolver(registry, {
      getWorkspaceFolderForPath: () => customWs,
    });

    const ctx = await resolver.resolveFromResource(path.join(standaloneConfigRoot, 'Configuration.xml'));
    assert.strictEqual(ctx.workspaceFolderUri, pathToFileURL(customWs).toString());
  });
});

async function createTestConfiguration(root: string, uuid: string): Promise<string> {
  await fs.promises.mkdir(root, { recursive: true });
  await fs.promises.writeFile(
    path.join(root, 'Configuration.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20">\n<Configuration uuid="${uuid}"><ChildObjects/></Configuration>\n</MetaDataObject>\n`,
    'utf8',
  );
  return fs.promises.realpath(root);
}

async function createTestEdtConfiguration(root: string, uuid: string): Promise<string> {
  const confDir = path.join(root, 'src', 'Configuration');
  await fs.promises.mkdir(confDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(confDir, 'Configuration.mdo'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<mdclass:Configuration xmlns:mdclass="http://g5.1c.ru/v8/dt/metadata/mdclass" uuid="${uuid}"/>\n`,
    'utf8',
  );
  return fs.promises.realpath(root);
}
