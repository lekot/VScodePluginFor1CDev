import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import '../helpers/vscodeStubRegister';
import { AgentCfeProjectOperations } from '../../src/agent/agentCfeProjectOperations';
import { AgentOperations } from '../../src/agent/agentOperations';
import { borrowObjectToExtension } from '../../src/extensionSupport/borrowObjectCommand';
import { CfeProjectService } from '../../src/extensionSupport/cfeProject/createProject';
import { MetadataType, type TreeNode } from '../../src/models/treeNode';
import { WorkspaceRegistry } from '../../src/services/configurationSession/WorkspaceRegistry';
import { resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';

interface Harness {
  readonly workspace: string;
  readonly base: string;
  readonly extension: string;
  readonly baseConfigurationId: string;
  readonly extensionConfigurationId: string;
  readonly registry: WorkspaceRegistry;
  readonly service: CfeProjectService;
}

suite('CFE borrow adapters and read DTO', () => {
  let harness: Harness;

  setup(async () => {
    resetVscodeTestState();
    harness = await createHarness();
  });

  teardown(async () => {
    await harness.registry.dispose();
    await fs.promises.rm(harness.workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined);
    resetVscodeTestState();
  });

  test('Agent borrow delegates to the CFE service and read DTO exposes ownership only for CFE', async () => {
    let refreshes = 0;
    const operations = new AgentCfeProjectOperations(
      async () => harness.registry,
      async () => {
        refreshes += 1;
        await refreshRegistry(harness.registry, harness.base, harness.extension, harness.workspace);
      },
    );

    const result = await operations.borrowObject({
      extensionConfigurationId: harness.extensionConfigurationId,
      sourceDotPath: 'Catalog.Goods',
    });
    assert.strictEqual(result.success, true, result.error);
    assert.strictEqual(result.data?.status, 'borrowed');
    assert.strictEqual(result.data?.sourceUuid, '33333333-3333-4333-8333-333333333333');
    assert.strictEqual(refreshes, 1);

    const borrowedXml = await fs.promises.readFile(path.join(harness.extension, 'Catalogs', 'Goods.xml'), 'utf8');
    assert.match(borrowedXml, /<InternalInfo>/);
    assert.match(borrowedXml, /<xr:GeneratedType\b/);
    assert.match(borrowedXml, /<ObjectBelonging>Adopted<\/ObjectBelonging>/);

    await addOwnCatalog(harness.extension, 'Ext_Own');
    const extensionReads = new AgentOperations(harness.extension);
    const listed = await extensionReads.listObjects({ type: 'Catalog' });
    assert.strictEqual(listed.success, true, listed.error);
    const borrowed = listed.data?.objects.find((item) => item.name === 'Goods');
    const own = listed.data?.objects.find((item) => item.name === 'Ext_Own');
    assert.deepStrictEqual(
      { ownership: borrowed?.ownership, sourceUuid: borrowed?.sourceUuid },
      { ownership: 'adopted', sourceUuid: '33333333-3333-4333-8333-333333333333' },
    );
    assert.deepStrictEqual(
      { ownership: own?.ownership, sourceUuid: own?.sourceUuid },
      { ownership: 'own', sourceUuid: undefined },
    );

    const properties = await extensionReads.getProperties({ path: 'Catalog.Goods' });
    assert.strictEqual(properties.success, true, properties.error);
    assert.strictEqual(properties.data?.ownership, 'adopted');
    assert.strictEqual(properties.data?.sourceUuid, '33333333-3333-4333-8333-333333333333');

    const mainReads = new AgentOperations(harness.base);
    const mainListed = await mainReads.listObjects({ type: 'Catalog' });
    assert.strictEqual(mainListed.success, true, mainListed.error);
    const mainGoods = mainListed.data?.objects.find((item) => item.name === 'Goods');
    assert.strictEqual(mainGoods?.ownership, undefined);
    assert.strictEqual(mainGoods?.sourceUuid, undefined);
    const mainProperties = await mainReads.getProperties({ path: 'Catalog.Goods' });
    assert.strictEqual(mainProperties.success, true, mainProperties.error);
    assert.strictEqual(mainProperties.data?.ownership, undefined);
    assert.strictEqual(mainProperties.data?.sourceUuid, undefined);
  });

  test('UI adapter calls the CFE service, creates the canonical shell, and honours cancellation', async () => {
    const source = catalogNode('UiGoods');
    let treeRefreshes = 0;
    const options = {
      state: { treeDataProvider: { getConfigPathForNode: () => harness.base } } as never,
      getConfigurationRegistry: async () => harness.registry,
      refreshTree: async () => { treeRefreshes += 1; },
    };

    // A dismissed picker must not create a partial XML file or refresh the tree.
    await borrowObjectToExtension(source, options);
    assert.strictEqual(treeRefreshes, 0);
    assert.strictEqual(await exists(path.join(harness.extension, 'Catalogs', 'UiGoods.xml')), false);

    const context = await harness.service.getContext(harness.baseConfigurationId);
    vscodeTestState.quickPickQueue.push({ label: context.extensionName, context });
    await borrowObjectToExtension(source, options);
    assert.strictEqual(treeRefreshes, 1);
    const xml = await fs.promises.readFile(path.join(harness.extension, 'Catalogs', 'UiGoods.xml'), 'utf8');
    assert.match(xml, /<InternalInfo>/, 'UI must use the canonical CFE service shell');
    assert.match(xml, /<xr:GeneratedType\b/, 'UI must use the canonical CFE service shell');
    assert.match(xml, /<ExtendedConfigurationObject>44444444-4444-4444-8444-444444444444<\/ExtendedConfigurationObject>/);
  });

  test('UI adapter rejects a source configuration without a persisted CFE relation before prompting', async () => {
    const unlinked = path.join(harness.workspace, 'unlinked');
    await writeBaseConfiguration(unlinked);
    await refreshRegistry(harness.registry, harness.base, harness.extension, harness.workspace, unlinked);
    const options = {
      state: { treeDataProvider: { getConfigPathForNode: () => unlinked } } as never,
      getConfigurationRegistry: async () => harness.registry,
      refreshTree: async () => assert.fail('tree refresh must not run without a linked CFE'),
    };

    await borrowObjectToExtension(catalogNode('Goods'), options);
    assert.ok(vscodeTestState.warningLog.some((message) => message.includes('нет связанного CFE-проекта')));
    assert.strictEqual(vscodeTestState.quickPickQueue.length, 0);
  });
});

async function createHarness(): Promise<Harness> {
  const workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cfe-borrow-adapters-'));
  const base = path.join(workspace, 'base');
  const extension = path.join(base, 'ConfigurationExtensions', 'AdapterExtension');
  const registry = new WorkspaceRegistry();
  try {
    await writeBaseConfiguration(base);
    await registry.refresh([{ configPath: base, workspaceFolderPath: workspace }]);
    const service = new CfeProjectService(workspace, registry, {
      refreshWorkspace: async () => refreshRegistry(registry, base, extension, workspace),
    });
    const baseConfigurationId = registry.list()[0]!.configurationId;
    await service.createProject({
      baseConfigurationId,
      extensionName: 'AdapterExtension',
      purpose: 'Customization',
      namePrefix: 'Ext_',
      compatibilityMode: 'Version8_3_24',
    });
    const extensionRoot = await fs.promises.realpath(extension);
    const extensionConfigurationId = registry.list().find((item) => item.rootPath === extensionRoot)!.configurationId;
    return { workspace, base, extension: extensionRoot, baseConfigurationId, extensionConfigurationId, registry, service };
  } catch (error) {
    await registry.dispose();
    await fs.promises.rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined);
    throw error;
  }
}

async function refreshRegistry(
  registry: WorkspaceRegistry,
  base: string,
  extension: string,
  workspace: string,
  ...otherRoots: readonly string[]
): Promise<void> {
  await registry.refresh([
    { configPath: base, workspaceFolderPath: workspace },
    { configPath: extension, workspaceFolderPath: workspace },
    ...otherRoots.map((configPath) => ({ configPath, workspaceFolderPath: workspace })),
  ]);
}

async function writeBaseConfiguration(base: string): Promise<void> {
  await fs.promises.mkdir(path.join(base, 'Languages'), { recursive: true });
  await fs.promises.mkdir(path.join(base, 'Catalogs'), { recursive: true });
  await fs.promises.writeFile(
    path.join(base, 'Configuration.xml'),
    '<?xml version="1.0"?><MetaDataObject version="2.20"><Configuration uuid="11111111-1111-4111-8111-111111111111"><Properties><DefaultLanguage>Language.Russian</DefaultLanguage><ScriptVariant>Russian</ScriptVariant><InterfaceCompatibilityMode>TaxiEnableVersion8_2</InterfaceCompatibilityMode></Properties><ChildObjects><Language>Russian</Language><Catalog>Goods</Catalog><Catalog>UiGoods</Catalog></ChildObjects></Configuration></MetaDataObject>',
    'utf8',
  );
  await fs.promises.writeFile(
    path.join(base, 'Languages', 'Russian.xml'),
    '<?xml version="1.0"?><MetaDataObject version="2.20"><Language uuid="22222222-2222-4222-8222-222222222222"><Properties><Name>Russian</Name><LanguageCode>ru</LanguageCode></Properties></Language></MetaDataObject>',
    'utf8',
  );
  await fs.promises.writeFile(path.join(base, 'Catalogs', 'Goods.xml'), catalogXml('Goods', '33333333-3333-4333-8333-333333333333'));
  await fs.promises.writeFile(path.join(base, 'Catalogs', 'UiGoods.xml'), catalogXml('UiGoods', '44444444-4444-4444-8444-444444444444'));
}

async function addOwnCatalog(extension: string, name: string): Promise<void> {
  const configurationPath = path.join(extension, 'Configuration.xml');
  const configuration = await fs.promises.readFile(configurationPath, 'utf8');
  await fs.promises.writeFile(
    configurationPath,
    configuration.replace('</ChildObjects>', `<Catalog>${name}</Catalog></ChildObjects>`),
    'utf8',
  );
  await fs.promises.writeFile(
    path.join(extension, 'Catalogs', `${name}.xml`),
    catalogXml(name, '55555555-5555-4555-8555-555555555555'),
    'utf8',
  );
}

function catalogXml(name: string, uuid: string): string {
  return `<?xml version="1.0"?><MetaDataObject version="2.20"><Catalog uuid="${uuid}"><Properties><Name>${name}</Name><Comment/></Properties><ChildObjects/></Catalog></MetaDataObject>`;
}

function catalogNode(name: string): TreeNode {
  return { id: `Catalogs.${name}`, name, type: MetadataType.Catalog, properties: {}, children: [] };
}

async function exists(target: string): Promise<boolean> {
  try { await fs.promises.access(target); return true; } catch { return false; }
}
