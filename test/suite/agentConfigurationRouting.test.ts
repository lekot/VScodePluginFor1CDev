import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import '../helpers/vscodeStubRegister';
import { registerAgentCommands } from '../../src/agent/agentCommands';
import { DebugSessionRegistry } from '../../src/agent/debugSessionRegistry';
import { WorkspaceRegistry } from '../../src/services/configurationSession/WorkspaceRegistry';
import {
  ConfigurationSession,
  type MutationExecutionOptions,
  type MutationOutcome,
} from '../../src/services/configurationSession/ConfigurationSession';
import {
  ConfigurationMutationEngine,
  getConfigurationMutationEngine,
  setConfigurationMutationEngine,
} from '../../src/services/configurationSession/ConfigurationMutationEngine';
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
    await fs.promises.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
      '<MetaDataObject version="2.20"><XDTOPackage><Properties><Name>BasePackage</Name></Properties></XDTOPackage></MetaDataObject>',
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
    assert.strictEqual(exported.snapshotVersion, 0, 'writing an external XSD file does not advance the configuration mutation version');
    assert.strictEqual(exported.reconciliation, undefined, 'an absent observer must not claim reconciliation succeeded');
    assert.ok((await fs.promises.readFile(outputPath, 'utf8')).includes('<xs:schema'));
    assert.strictEqual(fs.existsSync(path.join(root, '.cdt-journal')), false);
  });

  test('notifies once for XDTO, subsystem, predefined-characteristic, and static-form Agent writes', async () => {
    const commits: Array<{ configurationId: string; rootPath: string; operationId: string; snapshotVersion: number; kind: string }> = [];
    await registry.dispose();
    registry = new WorkspaceRegistry(undefined, (identity) => new ConfigurationSession(identity, async (commit) => {
      commits.push(commit);
      return { status: 'succeeded' };
    }));
    const root = await createRoot('agent-post-commit', '12121212-1212-1212-1212-121212121212');
    const subsystemCommandInterface = path.join(root, 'Subsystems', 'TestSubsystem', 'Ext', 'CommandInterface.xml');
    const predefinedPath = path.join(root, 'ChartsOfCharacteristicTypes', 'Shared', 'Ext', 'Predefined.xml');
    const formPath = path.join(root, 'CommonForms', 'Editor', 'Ext', 'Form.xml');
    const catalogPath = path.join(root, 'Catalogs', 'Products.xml');
    await fs.promises.mkdir(path.dirname(subsystemCommandInterface), { recursive: true });
    await fs.promises.writeFile(subsystemCommandInterface,
      '<CommandInterface xmlns="http://v8.1c.ru/8.3/xcf/extrnprops" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" version="2.17"><CommandsVisibility/></CommandInterface>',
      'utf8');
    await fs.promises.mkdir(path.dirname(predefinedPath), { recursive: true });
    await fs.promises.writeFile(predefinedPath,
      '<PredefinedData xmlns="http://v8.1c.ru/8.3/xcf/predef" xmlns:v8="http://v8.1c.ru/8.1/data/core" version="2.20"><Item><Name>Choice</Name><Type><v8:Type>cfg:CatalogRef.Products</v8:Type></Type></Item></PredefinedData>',
      'utf8');
    await fs.promises.mkdir(path.dirname(formPath), { recursive: true });
    const formXml = '<Form version="2.20"><Attributes/><Commands/><AutoCommandBar name="FormCommandBar" id="-1"><ChildItems/></AutoCommandBar><ChildItems><Button name="Submit" id="1"><ExtendedTooltip/></Button></ChildItems></Form>';
    await fs.promises.writeFile(formPath, formXml, 'utf8');
    await fs.promises.mkdir(path.dirname(catalogPath), { recursive: true });
    await fs.promises.writeFile(catalogPath,
      '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Catalog><Properties><Name>Products</Name><Synonym>Products</Synonym></Properties><ChildObjects/></Catalog></MetaDataObject>',
      'utf8');
    await fs.promises.writeFile(path.join(root, 'NewPackage.xsd'),
      '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:agent"><xs:element name="Root" type="xs:string"/></xs:schema>',
      'utf8');
    await registry.refresh([{ configPath: root }]);
    const session = registry.require(registry.list()[0]!.configurationId);
    const previousMutationEngine = getConfigurationMutationEngine();
    setConfigurationMutationEngine(new ConfigurationMutationEngine({
      runMutationWithOutcome: async <T>(
        _resourcePath: string,
        kind: string,
        operation: () => Promise<T>,
        options?: MutationExecutionOptions<T>,
      ): Promise<MutationOutcome<T>> => session.enqueue({ kind, ...options, execute: operation }),
    }));
    try {
    const context = { subscriptions: [] as Array<{ dispose(): void }> };
    registerAgentCommands(context as never, () => null, async () => registry, new DebugSessionRegistry());

    const createXdto = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.xdto.createFromXsd')!;
    const setSubsystemVisibility = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.setSubsystemCommandVisibility')!;
    const setPredefinedType = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.setPredefinedCharacteristicType')!;
    const editForm = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.forms.edit')!;
    const setProperties = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.setProperties')!;
    const xdtoResult = await createXdto({ packageName: 'Created', source: '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:agent"><xs:element name="Root" type="xs:string"/></xs:schema>' }) as AgentResult;
    const propertiesResult = await setProperties({ path: 'Catalog.Products', properties: { Synonym: 'Updated products' } }) as AgentResult;
    const subsystemResult = await setSubsystemVisibility({
      subsystemPath: 'Subsystems/TestSubsystem', commandName: 'Catalog.Products.OpenList', common: 'hidden',
    }) as AgentResult;
    const predefinedResult = await setPredefinedType({
      path: 'ChartOfCharacteristicTypes.Shared', predefinedName: 'Choice', types: ['xs:string'],
    }) as AgentResult;
    const formResult = await editForm({
      formPath: 'CommonForms/Editor/Ext/Form.xml',
      ifRev: crypto.createHash('sha256').update(formXml).digest('hex'),
      operations: [{ type: 'setElementIdentity', element: { id: '1', name: 'Submit' }, name: 'Confirm', id: '2' }],
    }) as AgentResult;

    for (const result of [xdtoResult, propertiesResult, subsystemResult, predefinedResult, formResult]) {
      assert.strictEqual(result.success, true, result.error);
      assert.ok(result.operationId);
      assert.deepStrictEqual(result.reconciliation, { status: 'succeeded' }, 'registered session observers report their reconciliation result');
    }
    assert.deepStrictEqual(commits.map((commit) => commit.kind), [
      'agent.xdto.createFromXsd',
      'agent.setProperties',
      'agent.setSubsystemCommandVisibility',
      'agent.setPredefinedCharacteristicType',
      'agent.forms.edit',
    ]);
    assert.deepStrictEqual(commits.map((commit) => commit.rootPath), [root, root, root, root, root]);
    assert.deepStrictEqual(commits.map((commit) => commit.snapshotVersion), [1, 2, 3, 4, 5]);
    assert.strictEqual(commits.length, 5, 'each top-level Agent write notifies once, including nested XMLWriter mutation');
    assert.ok((await fs.promises.readFile(path.join(root, 'Configuration.xml'), 'utf8')).includes('<XDTOPackage>Created</XDTOPackage>'));
    assert.ok((await fs.promises.readFile(catalogPath, 'utf8')).includes('Updated products'));
    assert.ok((await fs.promises.readFile(formPath, 'utf8')).includes('name="Confirm" id="2"'));
    } finally {
      setConfigurationMutationEngine(previousMutationEngine);
    }
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
      '<MetaDataObject version="2.20"><Catalog><Properties><Name>Goods</Name></Properties><ChildObjects/></Catalog></MetaDataObject>',
      'utf8',
    );
    await fs.promises.writeFile(path.join(objectDirectory, 'Ext', 'ObjectModule.bsl'), '// Goods', 'utf8');
    await fs.promises.writeFile(
      descriptorPath,
      '<MetaDataObject version="2.20"><Configuration uuid="eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"><ChildObjects><Catalog>Goods</Catalog></ChildObjects></Configuration></MetaDataObject>',
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
      `<MetaDataObject version="2.20"><Configuration uuid="${uuid}"><ChildObjects/></Configuration></MetaDataObject>`,
      'utf8',
    );
    return fs.promises.realpath(root);
  }
});
