import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import '../helpers/vscodeStubRegister';
import { CfeProjectService } from '../../src/extensionSupport/cfeProject/createProject';
import { CfeProjectError } from '../../src/extensionSupport/cfeProject/types';
import type { ExclusiveConfigurationOperation } from '../../src/services/configurationSession/ConfigurationSession';
import type { MutationPlan } from '../../src/services/configurationSession/mutationPlan';
import { WorkspaceRegistry } from '../../src/services/configurationSession/WorkspaceRegistry';

interface BorrowHarness {
  readonly base: string;
  readonly extension: string;
  readonly service: CfeProjectService;
  readonly registry: WorkspaceRegistry;
  readonly extensionConfigurationId: string;
}

const UUIDS = {
  catalog: '22222222-2222-4222-8222-222222222222',
  document: '33333333-3333-4333-8333-333333333333',
  commonModule: '55555555-5555-4555-8555-555555555555',
  report: '66666666-6666-4666-8666-666666666666',
} as const;

suite('CFE borrow core', () => {
  test('writes canonical Catalog shells and GeneratedTypes for formats 2.17–2.21', async () => {
    for (const format of ['2.17', '2.18', '2.19', '2.20', '2.21']) {
      await withHarness(format, async (harness) => {
        const result = await harness.service.borrowObject({
          extensionConfigurationId: harness.extensionConfigurationId,
          sourceDotPath: 'Catalog.Products',
        });
        assert.deepStrictEqual(
          { status: result.status, type: result.type, name: result.name, sourceUuid: result.sourceUuid },
          { status: 'borrowed', type: 'Catalog', name: 'Products', sourceUuid: UUIDS.catalog },
        );
        const xml = await fs.promises.readFile(path.join(harness.extension, result.objectPath), 'utf8');
        assert.match(xml, new RegExp(`<MetaDataObject[^>]*version="${format.replace('.', '\\.')}"`));
        assert.strictEqual((xml.match(/<xr:GeneratedType /g) ?? []).length, 5);
        assert.match(xml, /name="CatalogObject\.Products" category="Object"/);
        assert.match(xml, /name="CatalogManager\.Products" category="Manager"/);
        assert.match(xml, new RegExp(`<ExtendedConfigurationObject>${UUIDS.catalog}</ExtendedConfigurationObject>`));
        assert.match(xml, /<ChildObjects\/>/);
        if (format === '2.21') {
          assert.match(xml, /xmlns:pal=/);
        } else {
          assert.doesNotMatch(xml, /xmlns:pal=/);
        }
        const configurationXml = await fs.promises.readFile(path.join(harness.extension, 'Configuration.xml'), 'utf8');
        assert.match(configurationXml, /<Catalog>\s*Products\s*<\/Catalog>/);
        assert.strictEqual(await exists(path.join(harness.extension, 'ConfigDumpInfo.xml')), false);
      });
    }
  });

  test('resolves by UUID, preserves CommonModule flags and is idempotent by source UUID', async () => {
    await withHarness('2.20', async (harness) => {
      const byUuid = await harness.service.borrowObject({
        extensionConfigurationId: harness.extensionConfigurationId,
        sourceUuid: UUIDS.commonModule.toUpperCase(),
      });
      assert.strictEqual(byUuid.type, 'CommonModule');
      const commonModuleXml = await fs.promises.readFile(path.join(harness.extension, byUuid.objectPath), 'utf8');
      assert.match(commonModuleXml, /<Global>true<\/Global>/);
      assert.match(commonModuleXml, /<ServerCall>true<\/ServerCall>/);

      const first = await harness.service.borrowObject({
        extensionConfigurationId: harness.extensionConfigurationId,
        sourceDotPath: 'Catalog.Products',
      });
      const repeated = await harness.service.borrowObject({
        extensionConfigurationId: harness.extensionConfigurationId,
        sourceDotPath: 'Catalog.Products',
      });
      assert.strictEqual(repeated.status, 'already-borrowed');
      assert.strictEqual(repeated.localUuid, first.localUuid);
      const configurationXml = await fs.promises.readFile(path.join(harness.extension, 'Configuration.xml'), 'utf8');
      assert.strictEqual((configurationXml.match(/<Catalog>\s*Products\s*<\/Catalog>/g) ?? []).length, 1);
    });
  });

  test('keeps the existing adopted shell when the source object was renamed', async () => {
    await withHarness('2.20', async (harness) => {
      const first = await harness.service.borrowObject({
        extensionConfigurationId: harness.extensionConfigurationId,
        sourceDotPath: 'Catalog.Products',
      });
      await fs.promises.rename(
        path.join(harness.base, 'Catalogs', 'Products.xml'),
        path.join(harness.base, 'Catalogs', 'Renamed.xml'),
      );
      await fs.promises.writeFile(
        path.join(harness.base, 'Catalogs', 'Renamed.xml'),
        sourceObjectXml('Catalog', 'Renamed', UUIDS.catalog),
        'utf8',
      );
      const configurationPath = path.join(harness.base, 'Configuration.xml');
      const configurationXml = await fs.promises.readFile(configurationPath, 'utf8');
      await fs.promises.writeFile(configurationPath, configurationXml.replace('<Catalog>Products</Catalog>', '<Catalog>Renamed</Catalog>'), 'utf8');

      const repeated = await harness.service.borrowObject({
        extensionConfigurationId: harness.extensionConfigurationId,
        sourceDotPath: 'Catalog.Renamed',
      });
      assert.deepStrictEqual(
        { status: repeated.status, objectPath: repeated.objectPath, localUuid: repeated.localUuid },
        { status: 'already-borrowed', objectPath: first.objectPath, localUuid: first.localUuid },
      );
    });
  });

  test('rejects unproven dependency closures and CFE identity collisions before writes', async () => {
    await withHarness('2.20', async (harness) => {
      await assert.rejects(
        () => harness.service.borrowObject({
          extensionConfigurationId: harness.extensionConfigurationId,
          sourceDotPath: 'Report.Sales',
        }),
        (error: CfeProjectError) => error.code === 'CFE_DEPENDENCY_UNSUPPORTED',
      );
      await assert.rejects(
        () => harness.service.borrowObject({
          extensionConfigurationId: harness.extensionConfigurationId,
          sourceUuid: UUIDS.report,
        }),
        (error: CfeProjectError) => error.code === 'CFE_DEPENDENCY_UNSUPPORTED',
      );
      assert.strictEqual(await exists(path.join(harness.extension, 'Reports', 'Sales.xml')), false);

      const reportFolder = path.join(harness.extension, 'Reports');
      const crossTypeTarget = path.join(reportFolder, 'Existing.xml');
      await fs.promises.mkdir(reportFolder, { recursive: true });
      await fs.promises.writeFile(crossTypeTarget, adoptedObjectXml('Report', 'Existing', '99999999-9999-4999-8999-999999999999', UUIDS.catalog), 'utf8');
      await assert.rejects(
        () => harness.service.borrowObject({
          extensionConfigurationId: harness.extensionConfigurationId,
          sourceDotPath: 'Catalog.Products',
        }),
        (error: CfeProjectError) => error.code === 'CFE_OWNERSHIP_INVALID',
      );
      await fs.promises.rm(crossTypeTarget);

      const malformedTarget = path.join(reportFolder, 'Broken.xml');
      await fs.promises.writeFile(malformedTarget, `<?xml version="1.0"?><MetaDataObject version="2.20"><Report uuid="88888888-8888-4888-8888-888888888888"><Properties><ObjectBelonging>Adopted</ObjectBelonging><Name>Broken</Name></Properties></Report></MetaDataObject>`, 'utf8');
      await assert.rejects(
        () => harness.service.borrowObject({
          extensionConfigurationId: harness.extensionConfigurationId,
          sourceDotPath: 'Catalog.Products',
        }),
        (error: CfeProjectError) => error.code === 'CFE_OWNERSHIP_INVALID',
      );
      await fs.promises.rm(malformedTarget);

      const target = path.join(harness.extension, 'Catalogs', 'Products.xml');
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, ownCatalogXml('Products', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 'utf8');
      await assert.rejects(
        () => harness.service.borrowObject({
          extensionConfigurationId: harness.extensionConfigurationId,
          sourceDotPath: 'Catalog.Products',
        }),
        (error: CfeProjectError) => error.code === 'CFE_OWNERSHIP_INVALID',
      );
    });
  });

  test('detects source drift after preflight and before commit', async () => {
    await withHarness('2.20', async (harness) => {
      const session = harness.registry.require(harness.extensionConfigurationId);
      const originalRunExclusive = session.runExclusive.bind(session);
      let entered!: () => void;
      const enteredQueue = new Promise<void>((resolve) => { entered = resolve; });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      session.runExclusive = async <T>(operation: ExclusiveConfigurationOperation<T>) => {
        entered();
        return originalRunExclusive({
          ...operation,
          execute: async () => {
            await gate;
            return operation.execute();
          },
        });
      };
      try {
        const borrow = harness.service.borrowObject({
          extensionConfigurationId: harness.extensionConfigurationId,
          sourceDotPath: 'Catalog.Products',
        });
        await enteredQueue;
        await fs.promises.writeFile(
          path.join(harness.base, 'Catalogs', 'Products.xml'),
          sourceObjectXml('Catalog', 'Products', UUIDS.catalog, '<Comment>changed</Comment>'),
          'utf8',
        );
        release();
        await assert.rejects(
          () => borrow,
          (error: CfeProjectError) => error.code === 'CFE_SOURCE_CHANGED',
        );
        assert.strictEqual(await exists(path.join(harness.extension, 'Catalogs', 'Products.xml')), false);
      } finally {
        session.runExclusive = originalRunExclusive;
      }
    });
  });

  test('leaves no partial files when Configuration.xml CAS rejects the plan', async () => {
    await withHarness('2.20', async (harness) => {
      const session = harness.registry.require(harness.extensionConfigurationId);
      const originalExecute = session.mutations.execute.bind(session.mutations);
      session.mutations.execute = async <T>(plan: MutationPlan<T>, operationId?: string): Promise<T> => {
        const configurationPath = path.join(harness.extension, 'Configuration.xml');
        const edited = await fs.promises.readFile(configurationPath, 'utf8');
        await fs.promises.writeFile(configurationPath, `${edited}\n<!-- external edit -->`, 'utf8');
        return originalExecute(plan, operationId);
      };
      try {
        await assert.rejects(
          () => harness.service.borrowObject({
            extensionConfigurationId: harness.extensionConfigurationId,
            sourceDotPath: 'Catalog.Products',
          }),
          (error: CfeProjectError) => error.code === 'CFE_VALIDATION_FAILED',
        );
        assert.strictEqual(await exists(path.join(harness.extension, 'Catalogs', 'Products.xml')), false);
        assert.strictEqual(await exists(path.join(harness.extension, 'Catalogs')), false);
        assert.strictEqual(await exists(path.join(harness.extension, 'ConfigDumpInfo.xml')), false);
      } finally {
        session.mutations.execute = originalExecute;
      }
    });
  });
});

async function withHarness(format: string, callback: (harness: BorrowHarness) => Promise<void>): Promise<void> {
  const workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cfe-borrow-'));
  const base = path.join(workspace, 'base');
  const extension = path.join(base, 'ConfigurationExtensions', 'BorrowExtension');
  const registry = new WorkspaceRegistry();
  try {
    await writeBaseConfiguration(base, format);
    await registry.refresh([{ configPath: base, workspaceFolderPath: workspace }]);
    const service = new CfeProjectService(workspace, registry, {
      refreshWorkspace: async () => registry.refresh([
        { configPath: base, workspaceFolderPath: workspace },
        { configPath: extension, workspaceFolderPath: workspace },
      ]),
    });
    await service.createProject({
      baseConfigurationId: registry.list()[0]!.configurationId,
      extensionName: 'BorrowExtension', purpose: 'Customization', namePrefix: 'Borrow_', compatibilityMode: 'Version8_3_24',
    });
    const extensionRoot = await fs.promises.realpath(extension);
    const extensionConfigurationId = registry.list().find((item) => item.rootPath === extensionRoot)!.configurationId;
    await callback({ base, extension: extensionRoot, service, registry, extensionConfigurationId });
  } finally {
    await registry.dispose();
    await fs.promises.rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined);
  }
}

async function writeBaseConfiguration(base: string, format: string): Promise<void> {
  await Promise.all([
    fs.promises.mkdir(path.join(base, 'Languages'), { recursive: true }),
    fs.promises.mkdir(path.join(base, 'Catalogs'), { recursive: true }),
    fs.promises.mkdir(path.join(base, 'Documents'), { recursive: true }),
    fs.promises.mkdir(path.join(base, 'CommonModules'), { recursive: true }),
    fs.promises.mkdir(path.join(base, 'Reports'), { recursive: true }),
  ]);
  await fs.promises.writeFile(
    path.join(base, 'Configuration.xml'),
    `<?xml version="1.0"?><MetaDataObject version="${format}"><Configuration uuid="11111111-1111-4111-8111-111111111111"><Properties><DefaultLanguage>Language.Russian</DefaultLanguage><ScriptVariant>Russian</ScriptVariant><InterfaceCompatibilityMode>TaxiEnableVersion8_2</InterfaceCompatibilityMode></Properties><ChildObjects><Language>Russian</Language><CommonModule>Core</CommonModule><Catalog>Products</Catalog><Document>Order</Document><Report>Sales</Report></ChildObjects></Configuration></MetaDataObject>`,
    'utf8',
  );
  await fs.promises.writeFile(path.join(base, 'Languages', 'Russian.xml'), `<?xml version="1.0"?><MetaDataObject version="${format}"><Language uuid="12121212-1212-4121-8121-121212121212"><Properties><Name>Russian</Name><LanguageCode>ru</LanguageCode></Properties></Language></MetaDataObject>`, 'utf8');
  await fs.promises.writeFile(path.join(base, 'Catalogs', 'Products.xml'), sourceObjectXml('Catalog', 'Products', UUIDS.catalog), 'utf8');
  await fs.promises.writeFile(path.join(base, 'Documents', 'Order.xml'), sourceObjectXml('Document', 'Order', UUIDS.document), 'utf8');
  await fs.promises.writeFile(path.join(base, 'CommonModules', 'Core.xml'), sourceObjectXml('CommonModule', 'Core', UUIDS.commonModule, '<Global>true</Global><ClientManagedApplication>false</ClientManagedApplication><Server>true</Server><ExternalConnection>false</ExternalConnection><ClientOrdinaryApplication>false</ClientOrdinaryApplication><ServerCall>true</ServerCall>'), 'utf8');
  await fs.promises.writeFile(path.join(base, 'Reports', 'Sales.xml'), sourceObjectXml('Report', 'Sales', UUIDS.report), 'utf8');
}

function sourceObjectXml(type: string, name: string, uuid: string, extraProperties = ''): string {
  const childObjects = type === 'Catalog' || type === 'Document' || type === 'Enum' ? '<ChildObjects/>' : '';
  return `<?xml version="1.0"?><MetaDataObject version="2.20"><${type} uuid="${uuid}"><Properties><Name>${name}</Name>${extraProperties}</Properties>${childObjects}</${type}></MetaDataObject>`;
}

function ownCatalogXml(name: string, uuid: string): string {
  return `<?xml version="1.0"?><MetaDataObject version="2.20"><Catalog uuid="${uuid}"><Properties><Name>${name}</Name></Properties><ChildObjects/></Catalog></MetaDataObject>`;
}

function adoptedObjectXml(type: string, name: string, uuid: string, sourceUuid: string): string {
  return `<?xml version="1.0"?><MetaDataObject version="2.20"><${type} uuid="${uuid}"><Properties><ObjectBelonging>Adopted</ObjectBelonging><Name>${name}</Name><ExtendedConfigurationObject>${sourceUuid}</ExtendedConfigurationObject></Properties></${type}></MetaDataObject>`;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.promises.access(target);
    return true;
  } catch {
    return false;
  }
}
