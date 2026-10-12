import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { AgentOperations } from '../../src/agent/agentOperations';
import { MetadataType, type TreeNode } from '../../src/models/treeNode';
import {
  MutationPlanError,
  MutationPlanExecutor,
} from '../../src/services/configurationSession/mutationPlan';
import { planRenameRootElement } from '../../src/services/elementOperations';
import { ReferenceScanError } from '../../src/utils/referenceFinder';
import { cleanupTempDir, createTempDir } from '../helpers/testHelpers';

const OLD_NAME = 'Stock';
const NEW_NAME = 'RenamedStock';
const ROOT_UUID = '11111111-1111-4111-8111-111111111111';
const GENERATED_TYPE_ID = '22222222-2222-4222-8222-222222222222';
const GENERATED_VALUE_ID = '33333333-3333-4333-8333-333333333333';
const NESTED_TYPE_ID = '44444444-4444-4444-8444-444444444444';

suite('Metadata rename parity', () => {
  let tempRoot: string;

  setup(async () => {
    tempRoot = await createTempDir('1cviewer-rename-parity-');
    await writeRenameFixture(tempRoot);
  });

  teardown(async () => {
    await cleanupTempDir(tempRoot);
  });

  test('Agent and UI build the same root rename plan for owned identities, nested XML and external references', async () => {
    const uiPlan = await planRenameRootElement(createCatalogNode(tempRoot), NEW_NAME, tempRoot);
    const operations = new AgentOperations(tempRoot);
    const agentPlan = await operations.planRenameObject({ path: `Catalog.${OLD_NAME}`, newName: NEW_NAME });

    assert.strictEqual(uiPlan.kind, 'ui.renameRootElement');
    assert.strictEqual(agentPlan.kind, 'agent.renameObject');
    assert.deepStrictEqual(agentPlan.result, {
      success: true,
      data: { filePath: path.join(tempRoot, 'Catalogs', `${NEW_NAME}.xml`) },
    });
    assert.deepStrictEqual(agentPlan.steps, uiPlan.steps, 'both adapters must use the same domain steps');

    const result = await operations.renameObject({ path: `Catalog.${OLD_NAME}`, newName: NEW_NAME });
    assert.strictEqual(result.success, true, result.error);
    const renamedDescriptorPath = path.join(tempRoot, 'Catalogs', `${NEW_NAME}.xml`);
    const renamedDirectory = path.join(tempRoot, 'Catalogs', NEW_NAME);
    assert.ok(!fs.existsSync(path.join(tempRoot, 'Catalogs', `${OLD_NAME}.xml`)));
    assert.ok(fs.existsSync(renamedDescriptorPath));
    assert.ok(fs.existsSync(path.join(renamedDirectory, 'Ext', 'Identity.xml')));

    const descriptor = await fs.promises.readFile(renamedDescriptorPath, 'utf8');
    const nested = await fs.promises.readFile(path.join(renamedDirectory, 'Ext', 'Identity.xml'), 'utf8');
    const reference = await fs.promises.readFile(path.join(tempRoot, 'Documents', 'Receipt.xml'), 'utf8');
    const configuration = await fs.promises.readFile(path.join(tempRoot, 'Configuration.xml'), 'utf8');

    for (const content of [descriptor, nested]) {
      assert.ok(content.includes('CatalogRef.RenamedStock'));
      assert.ok(content.includes('CatalogObject.RenamedStock'));
      assert.ok(content.includes('Catalog.RenamedStock.Attribute.Code'));
      assert.ok(!content.includes('CatalogRef.Stock</'));
    }
    assert.ok(reference.includes('CatalogRef.RenamedStock'));
    assert.ok(reference.includes('CatalogObject.RenamedStock'));
    assert.ok(reference.includes('CatalogRef.Stockpile'), 'replacement must respect identity-token boundaries');
    assert.ok(!reference.includes('CatalogRef.Stock</'));
    assert.ok(configuration.includes(`<Catalog>${NEW_NAME}</Catalog>`));

    assert.ok(descriptor.includes(`uuid="${ROOT_UUID}"`), 'root identity UUID must remain unchanged');
    assert.ok(descriptor.includes(`<xr:TypeId>${GENERATED_TYPE_ID}</xr:TypeId>`));
    assert.ok(descriptor.includes(`<xr:ValueId>${GENERATED_VALUE_ID}</xr:ValueId>`));
    assert.ok(nested.includes(`<xr:TypeId>${NESTED_TYPE_ID}</xr:TypeId>`));
  });

  test('UI applies its shared root rename plan to nested and external XML', async () => {
    const plan = await planRenameRootElement(createCatalogNode(tempRoot), NEW_NAME, tempRoot);
    await new MutationPlanExecutor(tempRoot).execute(plan);

    const renamedDirectory = path.join(tempRoot, 'Catalogs', NEW_NAME);
    const nested = await fs.promises.readFile(path.join(renamedDirectory, 'Ext', 'Identity.xml'), 'utf8');
    const reference = await fs.promises.readFile(path.join(tempRoot, 'Documents', 'Receipt.xml'), 'utf8');
    const configuration = await fs.promises.readFile(path.join(tempRoot, 'Configuration.xml'), 'utf8');
    assert.ok(fs.existsSync(path.join(tempRoot, 'Catalogs', `${NEW_NAME}.xml`)));
    assert.ok(!fs.existsSync(path.join(tempRoot, 'Catalogs', `${OLD_NAME}.xml`)));
    assert.ok(nested.includes('CatalogRef.RenamedStock'));
    assert.ok(reference.includes('CatalogObject.RenamedStock'));
    assert.ok(configuration.includes(`<Catalog>${NEW_NAME}</Catalog>`));
  });

  test('Agent dryRun impact includes reference and nested XML resources without changing disk', async () => {
    const sourcePath = path.join(tempRoot, 'Catalogs', `${OLD_NAME}.xml`);
    const nestedPath = path.join(tempRoot, 'Catalogs', OLD_NAME, 'Ext', 'Identity.xml');
    const referencePath = path.join(tempRoot, 'Documents', 'Receipt.xml');
    const sourceBefore = await fs.promises.readFile(sourcePath, 'utf8');
    const nestedBefore = await fs.promises.readFile(nestedPath, 'utf8');
    const referenceBefore = await fs.promises.readFile(referencePath, 'utf8');

    const result = await new AgentOperations(tempRoot).renameObject({
      path: `Catalog.${OLD_NAME}`,
      newName: NEW_NAME,
      dryRun: true,
    });

    assert.strictEqual(result.success, true, result.error);
    assert.strictEqual(result.data?.dryRun, true);
    const files = result.data?.plannedChanges?.files ?? [];
    assert.ok(files.includes(referencePath), 'dryRun must report each external reference write');
    assert.ok(files.includes(nestedPath), 'dryRun must report nested identity rewrites');
    assert.ok(fs.existsSync(sourcePath));
    assert.strictEqual(await fs.promises.readFile(sourcePath, 'utf8'), sourceBefore);
    assert.strictEqual(await fs.promises.readFile(nestedPath, 'utf8'), nestedBefore);
    assert.strictEqual(await fs.promises.readFile(referencePath, 'utf8'), referenceBefore);
  });

  test('Agent root rename plan conflicts if an external reference changes after planning', async () => {
    const sourcePath = path.join(tempRoot, 'Catalogs', `${OLD_NAME}.xml`);
    const referencePath = path.join(tempRoot, 'Documents', 'Receipt.xml');
    const sourceBefore = await fs.promises.readFile(sourcePath, 'utf8');
    const operations = new AgentOperations(tempRoot);
    const plan = await operations.planRenameObject({ path: `Catalog.${OLD_NAME}`, newName: NEW_NAME });
    const reference = await fs.promises.readFile(referencePath, 'utf8');
    await fs.promises.writeFile(referencePath, `${reference}\n<!-- changed after plan -->`, 'utf8');

    await assert.rejects(
      () => new MutationPlanExecutor(tempRoot).execute(plan),
      (error: unknown) => error instanceof MutationPlanError && error.code === 'PLAN_CONFLICT',
    );
    assert.ok(fs.existsSync(sourcePath));
    assert.ok(!fs.existsSync(path.join(tempRoot, 'Catalogs', `${NEW_NAME}.xml`)));
    assert.strictEqual(await fs.promises.readFile(sourcePath, 'utf8'), sourceBefore);
  });

  test('Agent and UI fail closed when reference scanning cannot read an XML file', async () => {
    const unreadablePath = path.join(tempRoot, 'Documents', 'Unreadable.xml');
    await fs.promises.writeFile(unreadablePath, '<Document/>', 'utf8');
    const originalReadFile = fs.promises.readFile;
    const patchedPromises = fs.promises as unknown as { readFile: typeof fs.promises.readFile };
    patchedPromises.readFile = (async (
      filePath: Parameters<typeof fs.promises.readFile>[0],
      ...args: [Parameters<typeof fs.promises.readFile>[1]]
    ) => {
      if (String(filePath) === unreadablePath) {
        throw Object.assign(new Error('EACCES: test permission denied'), { code: 'EACCES' });
      }
      return originalReadFile.apply(fs.promises, [filePath, ...args]);
    }) as typeof fs.promises.readFile;

    try {
      const isReadFailure = (error: unknown): boolean => error instanceof ReferenceScanError
        && error.details?.reason === 'read_file_failed';
      await assert.rejects(
        () => planRenameRootElement(createCatalogNode(tempRoot), NEW_NAME, tempRoot),
        isReadFailure,
      );
      await assert.rejects(
        () => new AgentOperations(tempRoot).planRenameObject({ path: `Catalog.${OLD_NAME}`, newName: NEW_NAME }),
        isReadFailure,
      );
      assert.ok(fs.existsSync(path.join(tempRoot, 'Catalogs', `${OLD_NAME}.xml`)));
      assert.ok(!fs.existsSync(path.join(tempRoot, 'Catalogs', `${NEW_NAME}.xml`)));
    } finally {
      fs.promises.readFile = originalReadFile;
    }
  });

  test('root rename rejects malformed XML during authoritative reference scanning', async () => {
    await fs.promises.writeFile(path.join(tempRoot, 'Documents', 'Malformed.xml'), '<Document><broken></Document>', 'utf8');
    const isMalformedScanError = (error: unknown): boolean => error instanceof ReferenceScanError
      && String((error.details as { reason?: string } | undefined)?.reason) === 'malformed_xml';

    await assert.rejects(
      () => planRenameRootElement(createCatalogNode(tempRoot), NEW_NAME, tempRoot),
      isMalformedScanError,
    );
    await assert.rejects(
      () => new AgentOperations(tempRoot).planRenameObject({ path: `Catalog.${OLD_NAME}`, newName: NEW_NAME }),
      isMalformedScanError,
    );
    assert.ok(fs.existsSync(path.join(tempRoot, 'Catalogs', `${OLD_NAME}.xml`)));
    assert.ok(!fs.existsSync(path.join(tempRoot, 'Catalogs', `${NEW_NAME}.xml`)));
  });

  test('CFE adopted roots are refused on both UI and Agent rename paths', async () => {
    const cfeRoot = path.join(tempRoot, 'Extension');
    await fs.promises.mkdir(path.join(cfeRoot, 'Catalogs'), { recursive: true });
    await fs.promises.writeFile(path.join(cfeRoot, 'Configuration.xml'), cfeConfigurationXml(), 'utf8');
    const adoptedPath = path.join(cfeRoot, 'Catalogs', `${OLD_NAME}.xml`);
    await fs.promises.writeFile(adoptedPath, adoptedCatalogXml(), 'utf8');

    await assert.rejects(
      () => planRenameRootElement(createCatalogNode(cfeRoot), NEW_NAME, cfeRoot),
      (error: unknown) => Boolean(error && typeof error === 'object'
        && (error as { code?: string }).code === 'CFE_ADOPTED_OPERATION_REQUIRED'),
    );
    const agentResult = await new AgentOperations(cfeRoot).renameObject({
      path: `Catalog.${OLD_NAME}`,
      newName: NEW_NAME,
    });
    assert.strictEqual(agentResult.success, false);
    assert.strictEqual(agentResult.code, 'CFE_ADOPTED_OPERATION_REQUIRED');
    assert.ok(fs.existsSync(adoptedPath));
    assert.ok(!fs.existsSync(path.join(cfeRoot, 'Catalogs', `${NEW_NAME}.xml`)));
  });

  test('Agent keeps nested root rename outside the root rename use case', async () => {
    const result = await new AgentOperations(tempRoot).renameObject({
      path: `Catalog.${OLD_NAME}.Attribute.Code`,
      newName: 'RenamedCode',
    });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.code, 'INVALID_AGENT_PATH');
    assert.ok(fs.existsSync(path.join(tempRoot, 'Catalogs', `${OLD_NAME}.xml`)));
  });
});

function createCatalogNode(configurationRootPath: string): TreeNode {
  const folderPath = path.join(configurationRootPath, 'Catalogs');
  const configuration: TreeNode = {
    id: 'Configuration',
    name: 'Configuration',
    type: MetadataType.Configuration,
    properties: {},
    children: [],
  };
  const folder: TreeNode = {
    id: 'Catalogs',
    name: 'Catalogs',
    type: MetadataType.Catalog,
    filePath: folderPath,
    parent: configuration,
    properties: {},
    children: [],
  };
  const node: TreeNode = {
    id: `Catalogs.${OLD_NAME}`,
    name: OLD_NAME,
    type: MetadataType.Catalog,
    filePath: path.join(folderPath, `${OLD_NAME}.xml`),
    parent: folder,
    properties: {},
  };
  folder.children = [node];
  configuration.children = [folder];
  return node;
}

async function writeRenameFixture(configurationRootPath: string): Promise<void> {
  await fs.promises.mkdir(path.join(configurationRootPath, 'Catalogs', OLD_NAME, 'Ext'), { recursive: true });
  await fs.promises.mkdir(path.join(configurationRootPath, 'Documents'), { recursive: true });
  await fs.promises.writeFile(path.join(configurationRootPath, 'Configuration.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject version="2.20"><Configuration uuid="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"><Properties><Name>Test</Name></Properties><ChildObjects><Catalog>${OLD_NAME}</Catalog></ChildObjects></Configuration></MetaDataObject>`, 'utf8');
  await fs.promises.writeFile(path.join(configurationRootPath, 'Catalogs', `${OLD_NAME}.xml`), rootCatalogXml(), 'utf8');
  await fs.promises.writeFile(path.join(configurationRootPath, 'Catalogs', OLD_NAME, 'Ext', 'Identity.xml'), nestedIdentityXml(), 'utf8');
  await fs.promises.writeFile(path.join(configurationRootPath, 'Documents', 'Receipt.xml'), referenceXml(), 'utf8');
}

function rootCatalogXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config" version="2.20">
  <Catalog uuid="${ROOT_UUID}">
    <Properties><Name>${OLD_NAME}</Name><Synonym><v8:content>${OLD_NAME}</v8:content></Synonym></Properties>
    <ChildObjects><Attribute uuid="55555555-5555-4555-8555-555555555555"><Properties><Name>Code</Name></Properties></Attribute></ChildObjects>
    <InternalInfo>
      <xr:GeneratedType name="CatalogRef.${OLD_NAME}" category="Object"><xr:TypeId>${GENERATED_TYPE_ID}</xr:TypeId><xr:ValueId>${GENERATED_VALUE_ID}</xr:ValueId></xr:GeneratedType>
      <xr:GeneratedType name="CatalogObject.${OLD_NAME}" category="Object"><xr:TypeId>${GENERATED_TYPE_ID}</xr:TypeId><xr:ValueId>${GENERATED_VALUE_ID}</xr:ValueId></xr:GeneratedType>
      <xr:Field>Catalog.${OLD_NAME}.Attribute.Code</xr:Field>
    </InternalInfo>
  </Catalog>
</MetaDataObject>`;
}

function nestedIdentityXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Identity xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config">
  <xr:GeneratedType name="CatalogObject.${OLD_NAME}" category="Object"><xr:TypeId>${NESTED_TYPE_ID}</xr:TypeId></xr:GeneratedType>
  <xr:Field>Catalog.${OLD_NAME}.Attribute.Code</xr:Field>
  <v8:Type>cfg:CatalogRef.${OLD_NAME}</v8:Type>
</Identity>`;
}

function referenceXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config">
  <v8:Type>cfg:CatalogRef.${OLD_NAME}</v8:Type>
  <v8:Type>cfg:CatalogObject.${OLD_NAME}</v8:Type>
  <v8:Type>cfg:CatalogRef.${OLD_NAME}pile</v8:Type>
</Document>`;
}

function cfeConfigurationXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject version="2.21"><Configuration uuid="66666666-6666-4666-8666-666666666666"><Properties><Name>Extension</Name><ConfigurationExtensionPurpose>Customization</ConfigurationExtensionPurpose><NamePrefix>Ext_</NamePrefix></Properties><ChildObjects><Catalog>${OLD_NAME}</Catalog></ChildObjects></Configuration></MetaDataObject>`;
}

function adoptedCatalogXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject version="2.21"><Catalog uuid="77777777-7777-4777-8777-777777777777"><Properties><Name>${OLD_NAME}</Name><ObjectBelonging>Adopted</ObjectBelonging><ExtendedConfigurationObject>88888888-8888-4888-8888-888888888888</ExtendedConfigurationObject></Properties><ChildObjects/></Catalog></MetaDataObject>`;
}
