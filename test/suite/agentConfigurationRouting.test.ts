import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import '../helpers/vscodeStubRegister';
import { registerAgentCommands } from '../../src/agent/agentCommands';
import { DebugSessionRegistry } from '../../src/agent/debugSessionRegistry';
import { WorkspaceRegistry } from '../../src/services/configurationSession/WorkspaceRegistry';
import { resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';
import type { AgentResult } from '../../src/agent/types';

suite('Agent configuration routing', () => {
  let tempDir: string;
  let registry: WorkspaceRegistry;

  setup(async () => {
    resetVscodeTestState();
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-config-routing-'));
    registry = new WorkspaceRegistry();
  });

  teardown(async () => {
    await registry.dispose();
    await fs.promises.rm(tempDir, { recursive: true, force: true });
    resetVscodeTestState();
  });

  test('returns typed ambiguity and routes an exact configurationId', async () => {
    const rootA = await createRoot('a', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    const rootB = await createRoot('b', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    await registry.refresh([{ configPath: rootA }, { configPath: rootB }]);
    const context = { subscriptions: [] as Array<{ dispose(): void }> };
    registerAgentCommands(
      context as never,
      () => null,
      async () => registry,
      new DebugSessionRegistry(),
    );
    const handler = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.listObjects')!;

    const ambiguous = await handler({}) as AgentResult;
    assert.strictEqual(ambiguous.success, false);
    assert.strictEqual(ambiguous.code, 'CONFIGURATION_SELECTION_REQUIRED');

    const selectedDescriptor = registry.list().find((descriptor) => descriptor.rootPath === rootB)!;
    const selected = await handler({ configurationId: selectedDescriptor.configurationId }) as AgentResult;
    assert.strictEqual(selected.success, true);
    assert.strictEqual(selected.configurationId, selectedDescriptor.configurationId);
  });

  test('publishes discovery envelope and commits root CRUD through a journaled plan', async () => {
    const root = await createRoot('planned', 'cccccccc-cccc-cccc-cccc-cccccccccccc');
    await registry.refresh([{ configPath: root }]);
    const context = { subscriptions: [] as Array<{ dispose(): void }> };
    registerAgentCommands(context as never, () => null, async () => registry, new DebugSessionRegistry());

    const listHandler = vscodeTestState.registeredCommandHandlers.get(
      '1c-metadata-tree.agent.listConfigurations',
    )!;
    const listed = await listHandler() as AgentResult<{ configurations: Array<{ configurationId: string }> }>;
    assert.strictEqual(listed.success, true);
    assert.strictEqual(listed.data?.configurations.length, 1);

    const createHandler = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.createObject')!;
    const created = await createHandler({ type: 'Catalog', name: 'PlanGoods' }) as AgentResult<{ filePath: string }>;
    assert.strictEqual(created.success, true, created.error);
    assert.ok(created.operationId);
    assert.strictEqual(created.snapshotVersion, 1);
    assert.strictEqual(await fs.promises.readFile(created.data!.filePath, 'utf8').then((value) => value.includes('PlanGoods')), true);
    assert.strictEqual(
      await fs.promises.readFile(path.join(root, 'Configuration.xml'), 'utf8').then((value) => value.includes('PlanGoods')),
      true,
    );
    assert.strictEqual(fs.existsSync(path.join(root, '.cdt-journal')), false);
  });

  test('routes XDTO file export as a journaled write mutation', async () => {
    const root = await createRoot('xdto-export', 'dddddddd-dddd-dddd-dddd-dddddddddddd');
    const packagesDir = path.join(root, 'XDTOPackages');
    const schemaPath = path.join(packagesDir, 'BasePackage', 'Ext', 'Package.bin');
    await fs.promises.mkdir(path.dirname(schemaPath), { recursive: true });
    await fs.promises.writeFile(
      path.join(packagesDir, 'BasePackage.xml'),
      '<MetaDataObject><XDTOPackage><Properties><Name>BasePackage</Name></Properties></XDTOPackage></MetaDataObject>',
      'utf8',
    );
    await fs.promises.writeFile(
      schemaPath,
      '\uFEFF<package xmlns="http://v8.1c.ru/8.1/xdto" xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test"/>',
      'utf8',
    );
    await registry.refresh([{ configPath: root }]);
    const context = { subscriptions: [] as Array<{ dispose(): void }> };
    registerAgentCommands(context as never, () => null, async () => registry, new DebugSessionRegistry());

    const exportHandler = vscodeTestState.registeredCommandHandlers.get(
      '1c-metadata-tree.agent.xdto.exportXsd',
    )!;
    const outputPath = path.join(root, 'exports', 'BasePackage.xsd');
    const exported = await exportHandler({ packageName: 'BasePackage', outputPath }) as AgentResult;

    assert.strictEqual(exported.success, true, exported.error);
    assert.ok(exported.operationId, 'file export must pass through the configuration mutation session');
    assert.strictEqual(exported.snapshotVersion, 1);
    assert.ok((await fs.promises.readFile(outputPath, 'utf8')).includes('<xs:schema'));
    assert.strictEqual(fs.existsSync(path.join(root, '.cdt-journal')), false);
  });

  test('rejects 4/6-segment rename paths before effects or journaling', async () => {
    const { root, descriptorPath, objectPath, renameHandler } = await prepareRenameRoot();
    const descriptorBefore = await fs.promises.readFile(descriptorPath, 'utf8');
    const objectBefore = await fs.promises.readFile(objectPath, 'utf8');

    for (const invalidPath of [
      'Catalog.Goods.Attribute.Code',
      'Catalog.Goods.TabularSection.Items.Attribute.Quantity',
    ]) {
      const rejected = await renameHandler({ path: invalidPath, newName: 'RenamedGoods' }) as AgentResult;
      assert.strictEqual(rejected.success, false);
      assert.strictEqual(rejected.code, 'INVALID_AGENT_PATH');
      assert.strictEqual(rejected.operationId, undefined, 'rejected plan must not enter the mutation queue');
      assert.strictEqual(await fs.promises.readFile(descriptorPath, 'utf8'), descriptorBefore);
      assert.strictEqual(await fs.promises.readFile(objectPath, 'utf8'), objectBefore);
      assert.strictEqual(fs.existsSync(path.join(root, '.cdt-journal')), false);
    }

    const configurationId = registry.list()[0]!.configurationId;
    assert.strictEqual(registry.require(configurationId).snapshotVersion, 0);
  });

  test('commits a valid root rename through the mutation session', async () => {
    const { root, descriptorPath, objectPath, renameHandler } = await prepareRenameRoot();
    const renamed = await renameHandler({ path: 'Catalog.Goods', newName: 'RenamedGoods' }) as AgentResult<{
      filePath: string;
    }>;

    assert.strictEqual(renamed.success, true, renamed.error);
    assert.ok(renamed.operationId);
    assert.strictEqual(renamed.snapshotVersion, 1);
    assert.strictEqual(fs.existsSync(objectPath), false);
    assert.strictEqual(renamed.data?.filePath, path.join(root, 'Catalogs', 'RenamedGoods.xml'));
    assert.ok((await fs.promises.readFile(renamed.data!.filePath, 'utf8')).includes('<Name>RenamedGoods</Name>'));
    assert.ok(fs.existsSync(path.join(root, 'Catalogs', 'RenamedGoods', 'Ext', 'ObjectModule.bsl')));
    assert.ok((await fs.promises.readFile(descriptorPath, 'utf8')).includes('RenamedGoods'));
    assert.strictEqual(fs.existsSync(path.join(root, '.cdt-journal')), false);
  });

  async function prepareRenameRoot(): Promise<{
    root: string;
    descriptorPath: string;
    objectPath: string;
    renameHandler: (...args: unknown[]) => unknown;
  }> {
    const root = await createRoot('rename-paths', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee');
    const descriptorPath = path.join(root, 'Configuration.xml');
    const objectPath = path.join(root, 'Catalogs', 'Goods.xml');
    const objectDirectory = path.join(root, 'Catalogs', 'Goods');
    await fs.promises.mkdir(path.join(objectDirectory, 'Ext'), { recursive: true });
    await fs.promises.writeFile(
      objectPath,
      '<MetaDataObject><Catalog><Properties><Name>Goods</Name></Properties><ChildObjects/></Catalog></MetaDataObject>',
      'utf8',
    );
    await fs.promises.writeFile(path.join(objectDirectory, 'Ext', 'ObjectModule.bsl'), '// Goods', 'utf8');
    await fs.promises.writeFile(
      descriptorPath,
      '<MetaDataObject><Configuration uuid="eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"><ChildObjects><Catalog>Goods</Catalog></ChildObjects></Configuration></MetaDataObject>',
      'utf8',
    );
    await registry.refresh([{ configPath: root }]);
    const context = { subscriptions: [] as Array<{ dispose(): void }> };
    registerAgentCommands(context as never, () => null, async () => registry, new DebugSessionRegistry());
    const renameHandler = vscodeTestState.registeredCommandHandlers.get(
      '1c-metadata-tree.agent.renameObject',
    )!;
    return { root, descriptorPath, objectPath, renameHandler };
  }

  async function createRoot(name: string, uuid: string): Promise<string> {
    const root = path.join(tempDir, name);
    await fs.promises.mkdir(root, { recursive: true });
    await fs.promises.writeFile(
      path.join(root, 'Configuration.xml'),
      `<MetaDataObject><Configuration uuid="${uuid}"><ChildObjects/></Configuration></MetaDataObject>`,
      'utf8',
    );
    return fs.promises.realpath(root);
  }
});
