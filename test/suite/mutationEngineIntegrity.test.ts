import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { CommandInterfaceOperations } from '../../src/agent/commandInterfaceOperations';
import { TreeNode, MetadataType } from '../../src/models/treeNode';
import { createForm, deleteElement, duplicateElement, renameElement } from '../../src/services/elementOperations';
import { XMLWriter } from '../../src/utils/XMLWriter';
import {
  configureConfigurationMutationGateway,
  runConfigurationPlan,
} from '../../src/services/configurationSession/configurationMutationGateway';
import { MutationPlan, MutationPlanExecutor } from '../../src/services/configurationSession/mutationPlan';
import { AtomicFileStorage } from '../../src/services/configurationSession/atomicFileStorage';
import { cleanupTempDir, createTempDir } from '../helpers/testHelpers';

suite('Mutation Engine Integrity & Bypassed Writers (#351)', () => {
  let tempRoot: string;
  let configRoot: string;

  setup(async () => {
    tempRoot = await createTempDir('mutation-engine-351-');
    configRoot = path.join(tempRoot, 'Config');
    await fs.promises.mkdir(configRoot, { recursive: true });
    // Minimal Configuration.xml with format version 2.16
    await fs.promises.writeFile(
      path.join(configRoot, 'Configuration.xml'),
      `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.16">
\t<Configuration uuid="00000000-0000-0000-0000-000000000000">
\t\t<Properties>
\t\t\t<Name>TestConfig</Name>
\t\t</Properties>
\t\t<ChildObjects/>
\t</Configuration>
</MetaDataObject>`,
      'utf8',
    );
  });

  teardown(async () => {
    await cleanupTempDir(tempRoot);
  });

  suite('Finding 1: CommandInterfaceOperations uses AtomicFileStorage and CAS', () => {
    test('CommandInterfaceOperations uses AtomicFileStorage for writes', async () => {
      const subDir = path.join(configRoot, 'Subsystems', 'Sub1', 'Ext');
      await fs.promises.mkdir(subDir, { recursive: true });
      const ciPath = path.join(subDir, 'CommandInterface.xml');
      await fs.promises.writeFile(
        ciPath,
        `<?xml version="1.0" encoding="UTF-8"?>
<CommandInterface xmlns="http://v8.1c.ru/8.3/xcf/extxmlns">
\t<CommandsVisibility/>
\t<CommandsOrder/>
\t<SubsystemsOrder/>
</CommandInterface>`,
        'utf8',
      );

      let storageReplaceCalled = false;
      const originalReplace = AtomicFileStorage.prototype.replace;
      AtomicFileStorage.prototype.replace = async function (this: AtomicFileStorage, ...args) {
        storageReplaceCalled = true;
        return originalReplace.apply(this, args);
      };

      try {
        const ops = new CommandInterfaceOperations(configRoot);
        const result = await ops.setCommandVisibility('Subsystems.Sub1', 'Catalog.Items.StandardCommand.OpenList', 'visible');
        assert.strictEqual(result.success, true, result.error);
        assert.strictEqual(storageReplaceCalled, true, 'CommandInterfaceOperations must route writes through AtomicFileStorage.replace');
      } finally {
        AtomicFileStorage.prototype.replace = originalReplace;
      }
    });

    test('CommandInterfaceOperations detects stale target hash and returns conflict', async () => {
      const subDir = path.join(configRoot, 'Subsystems', 'Sub1', 'Ext');
      await fs.promises.mkdir(subDir, { recursive: true });
      const ciPath = path.join(subDir, 'CommandInterface.xml');
      const initialXml = `<?xml version="1.0" encoding="UTF-8"?>
<CommandInterface xmlns="http://v8.1c.ru/8.3/xcf/extxmlns">
\t<CommandsVisibility/>
\t<CommandsOrder/>
\t<SubsystemsOrder/>
</CommandInterface>`;
      await fs.promises.writeFile(ciPath, initialXml, 'utf8');

      // Intercept file read to simulate another process modifying the file before write
      const originalReadFile = fs.promises.readFile;
      let firstRead = true;
      // @ts-expect-error test interceptor
      fs.promises.readFile = async (...args: Parameters<typeof originalReadFile>) => {
        const res = await originalReadFile(...args);
        if (firstRead && typeof args[0] === 'string' && args[0].endsWith('CommandInterface.xml')) {
          firstRead = false;
          // Modify the file on disk concurrently right after reading
          await originalWriteFile(ciPath, initialXml + '\n<!-- concurrent modification -->', 'utf8');
        }
        return res;
      };
      const originalWriteFile = fs.promises.writeFile;

      try {
        const ops = new CommandInterfaceOperations(configRoot);
        const result = await ops.setCommandVisibility('Subsystems.Sub1', 'Catalog.Items.StandardCommand.OpenList', 'visible');
        assert.strictEqual(result.success, false, 'Expected conflict on stale hash');
        assert.strictEqual(result.code, 'STALE_TARGET_HASH');
      } finally {
        fs.promises.readFile = originalReadFile;
      }
    });

    test('CommandInterfaceOperations rejects escape outside root boundary with TARGET_OUTSIDE_ROOT', async () => {
      const ops = new CommandInterfaceOperations(configRoot);
      const result = await ops.setCommandVisibility('../../Outside', 'Cmd', 'visible');
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.code, 'TARGET_OUTSIDE_ROOT');
    });
  });

  suite('Finding 3: createForm and deleteElement multi-file atomic transactions', () => {
    test('createForm rolls back newly created form files if owner XML update fails', async () => {
      const catalogsDir = path.join(configRoot, 'Catalogs');
      const catalogDir = path.join(catalogsDir, 'Products');
      const formsDir = path.join(catalogDir, 'Forms');
      await fs.promises.mkdir(formsDir, { recursive: true });
      const ownerXmlPath = path.join(catalogsDir, 'Products.xml');
      // Intentionally invalid XML so XMLWriter.addDesignerFormReferenceToOwnerMetadata fails
      await fs.promises.writeFile(ownerXmlPath, '<CorruptedXml', 'utf8');

      const ownerNode: TreeNode = {
        id: 'Catalog.Products',
        name: 'Products',
        type: MetadataType.Catalog,
        filePath: ownerXmlPath,
        properties: {},
      };
      const formsNode: TreeNode = {
        id: 'Forms',
        name: 'Forms',
        type: MetadataType.Form,
        filePath: formsDir,
        properties: {},
        parent: ownerNode,
      };

      await assert.rejects(async () => {
        await createForm(formsNode, 'ItemForm');
      });

      // Verify rollback: no partial files left on disk!
      const metaFormPath = path.join(formsDir, 'ItemForm.xml');
      const extFormPath = path.join(formsDir, 'ItemForm', 'Ext', 'Form.xml');
      const bslFormPath = path.join(formsDir, 'ItemForm', 'Ext', 'Form', 'Module.bsl');

      assert.strictEqual(fs.existsSync(metaFormPath), false, 'Form metadata XML must not remain on failure');
      assert.strictEqual(fs.existsSync(extFormPath), false, 'Ext/Form.xml must not remain on failure');
      assert.strictEqual(fs.existsSync(bslFormPath), false, 'Module.bsl must not remain on failure');
    });

    test('createForm creates form metadata, Ext/Form.xml, Module.bsl and updates owner XML atomically', async () => {
      const catalogsDir = path.join(configRoot, 'Catalogs');
      const catalogDir = path.join(catalogsDir, 'Products');
      const formsDir = path.join(catalogDir, 'Forms');
      await fs.promises.mkdir(formsDir, { recursive: true });
      const ownerXmlPath = path.join(catalogsDir, 'Products.xml');
      await fs.promises.writeFile(
        ownerXmlPath,
        `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.16">
\t<Catalog uuid="11111111-1111-1111-1111-111111111111">
\t\t<Properties>
\t\t\t<Name>Products</Name>
\t\t</Properties>
\t\t<ChildObjects/>
\t</Catalog>
</MetaDataObject>`,
        'utf8',
      );

      const ownerNode: TreeNode = {
        id: 'Catalog.Products',
        name: 'Products',
        type: MetadataType.Catalog,
        filePath: ownerXmlPath,
        properties: {},
      };
      const formsNode: TreeNode = {
        id: 'Forms',
        name: 'Forms',
        type: MetadataType.Form,
        filePath: formsDir,
        properties: {},
        parent: ownerNode,
      };

      await createForm(formsNode, 'ItemForm');

      const metaFormPath = path.join(formsDir, 'ItemForm.xml');
      const extFormPath = path.join(formsDir, 'ItemForm', 'Ext', 'Form.xml');
      const bslFormPath = path.join(formsDir, 'ItemForm', 'Ext', 'Form', 'Module.bsl');

      assert.strictEqual(fs.existsSync(metaFormPath), true, 'Form metadata XML should exist');
      assert.strictEqual(fs.existsSync(extFormPath), true, 'Ext/Form.xml should exist');
      assert.strictEqual(fs.existsSync(bslFormPath), true, 'Module.bsl should exist');

      const ownerXml = await fs.promises.readFile(ownerXmlPath, 'utf8');
      assert.match(ownerXml, /<Form>ItemForm<\/Form>/, 'Owner XML must contain registered Form');
    });

    test('deleteElement removes form files and cleans up owner XML in a single transaction', async () => {
      const catalogsDir = path.join(configRoot, 'Catalogs');
      const catalogDir = path.join(catalogsDir, 'Products');
      const formsDir = path.join(catalogDir, 'Forms');
      await fs.promises.mkdir(path.join(formsDir, 'ItemForm', 'Ext', 'Form'), { recursive: true });
      const ownerXmlPath = path.join(catalogsDir, 'Products.xml');
      await fs.promises.writeFile(
        ownerXmlPath,
        `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.16">
\t<Catalog uuid="11111111-1111-1111-1111-111111111111">
\t\t<Properties>
\t\t\t<Name>Products</Name>
\t\t</Properties>
\t\t<ChildObjects>
\t\t\t<Form>ItemForm</Form>
\t\t</ChildObjects>
\t</Catalog>
</MetaDataObject>`,
        'utf8',
      );
      const metaFormPath = path.join(formsDir, 'ItemForm.xml');
      await fs.promises.writeFile(metaFormPath, '<FormXml/>', 'utf8');
      await fs.promises.writeFile(path.join(formsDir, 'ItemForm', 'Ext', 'Form.xml'), '<Form/>', 'utf8');

      const ownerNode: TreeNode = {
        id: 'Catalog.Products',
        name: 'Products',
        type: MetadataType.Catalog,
        filePath: ownerXmlPath,
        properties: {},
      };
      const formsNode: TreeNode = {
        id: 'Forms',
        name: 'Forms',
        type: MetadataType.Form,
        filePath: formsDir,
        properties: {},
        parent: ownerNode,
      };
      const formNode: TreeNode = {
        id: 'Catalog.Products.Form.ItemForm',
        name: 'ItemForm',
        type: MetadataType.Form,
        filePath: metaFormPath,
        properties: {},
        parent: formsNode,
      };

      await deleteElement(formNode, { trustedRootPath: configRoot });

      assert.strictEqual(fs.existsSync(metaFormPath), false, 'Form XML file must be deleted');
      assert.strictEqual(fs.existsSync(path.join(formsDir, 'ItemForm')), false, 'Form directory must be deleted');

      const ownerXml = await fs.promises.readFile(ownerXmlPath, 'utf8');
      assert.ok(!ownerXml.includes('<Form>ItemForm</Form>'), 'Owner XML must no longer contain Form');
    });
  });

  suite('Finding 4: duplicateElement, deleteElement, and renameElement route through runConfigurationPlan', () => {
    test('duplicateElement routes root duplication plan through runConfigurationPlan gateway', async () => {
      const catalogsDir = path.join(configRoot, 'Catalogs');
      await fs.promises.mkdir(catalogsDir, { recursive: true });
      const catPath = path.join(catalogsDir, 'Goods.xml');
      await fs.promises.writeFile(
        catPath,
        `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.16">
\t<Catalog uuid="22222222-2222-2222-2222-222222222222">
\t\t<Properties>
\t\t\t<Name>Goods</Name>
\t\t</Properties>
\t</Catalog>
</MetaDataObject>`,
        'utf8',
      );

      const catNode: TreeNode = {
        id: 'Catalog.Goods',
        name: 'Goods',
        type: MetadataType.Catalog,
        filePath: catPath,
        properties: {},
        parent: {
          id: 'Catalogs',
          name: 'Catalogs',
          type: MetadataType.Catalog,
          filePath: catalogsDir,
          properties: {},
        },
      };

      let routedPlan: MutationPlan<unknown> | undefined;
      let routedConfigPath: string | undefined;

      const mutationGateway = configureConfigurationMutationGateway(
        async (_path, _kind, fn) => fn(),
        async (resPath, plan) => {
          routedConfigPath = resPath;
          routedPlan = plan;
          return new MutationPlanExecutor(resPath).execute(plan);
        },
      );

      try {
        await duplicateElement(catNode, 'GoodsCopy');

        assert.ok(routedPlan, 'duplicateElement must route plan through runConfigurationPlan');
        assert.strictEqual(routedPlan.kind, 'ui.duplicateRootElement');
        assert.ok(routedConfigPath?.endsWith('Config') || routedConfigPath?.endsWith('Catalogs'));
        assert.strictEqual(fs.existsSync(path.join(catalogsDir, 'GoodsCopy.xml')), true);
      } finally {
        mutationGateway.dispose();
      }
    });

    test('deleteElement routes root deletion plan through runConfigurationPlan gateway', async () => {
      const catalogsDir = path.join(configRoot, 'Catalogs');
      await fs.promises.mkdir(catalogsDir, { recursive: true });
      const catPath = path.join(catalogsDir, 'ToDelete.xml');
      await fs.promises.writeFile(
        catPath,
        `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.16">
\t<Catalog uuid="33333333-3333-3333-3333-333333333333">
\t\t<Properties>
\t\t\t<Name>ToDelete</Name>
\t\t</Properties>
\t</Catalog>
</MetaDataObject>`,
        'utf8',
      );

      const catNode: TreeNode = {
        id: 'Catalog.ToDelete',
        name: 'ToDelete',
        type: MetadataType.Catalog,
        filePath: catPath,
        properties: {},
        parent: {
          id: 'Catalogs',
          name: 'Catalogs',
          type: MetadataType.Catalog,
          filePath: catalogsDir,
          properties: {},
        },
      };

      let routedPlan: MutationPlan<unknown> | undefined;

      const mutationGateway = configureConfigurationMutationGateway(
        async (_path, _kind, fn) => fn(),
        async (resPath, plan) => {
          routedPlan = plan;
          return new MutationPlanExecutor(resPath).execute(plan);
        },
      );

      try {
        await deleteElement(catNode, { trustedRootPath: configRoot });

        assert.ok(routedPlan, 'deleteElement must route plan through runConfigurationPlan');
        assert.strictEqual(routedPlan.kind, 'metadata.delete');
        assert.strictEqual(fs.existsSync(catPath), false);
      } finally {
        mutationGateway.dispose();
      }
    });

    test('renameElement routes root rename plan through runConfigurationPlan gateway', async () => {
      await fs.promises.writeFile(
        path.join(configRoot, 'Configuration.xml'),
        `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.16">
\t<Configuration uuid="00000000-0000-0000-0000-000000000000">
\t\t<Properties>
\t\t\t<Name>TestConfig</Name>
\t\t</Properties>
\t\t<ChildObjects>
\t\t\t<Catalog>OldName</Catalog>
\t\t</ChildObjects>
\t</Configuration>
</MetaDataObject>`,
        'utf8',
      );
      const catalogsDir = path.join(configRoot, 'Catalogs');
      await fs.promises.mkdir(catalogsDir, { recursive: true });
      const catPath = path.join(catalogsDir, 'OldName.xml');
      await fs.promises.writeFile(
        catPath,
        `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.16">
\t<Catalog uuid="44444444-4444-4444-4444-444444444444">
\t\t<Properties>
\t\t\t<Name>OldName</Name>
\t\t</Properties>
\t</Catalog>
</MetaDataObject>`,
        'utf8',
      );

      const catNode: TreeNode = {
        id: 'Catalog.OldName',
        name: 'OldName',
        type: MetadataType.Catalog,
        filePath: catPath,
        properties: {},
        parent: {
          id: 'Catalogs',
          name: 'Catalogs',
          type: MetadataType.Catalog,
          filePath: catalogsDir,
          properties: {},
        },
      };

      let routedPlan: MutationPlan<unknown> | undefined;

      const mutationGateway = configureConfigurationMutationGateway(
        async (_path, _kind, fn) => fn(),
        async (resPath, plan) => {
          routedPlan = plan;
          return new MutationPlanExecutor(resPath).execute(plan);
        },
      );

      try {
        await renameElement(catNode, 'NewName', configRoot);

        assert.ok(routedPlan, 'renameElement must route plan through runConfigurationPlan');
        assert.strictEqual(routedPlan.kind, 'metadata.rename');
        assert.strictEqual(fs.existsSync(path.join(catalogsDir, 'NewName.xml')), true);
        assert.strictEqual(fs.existsSync(catPath), false);
      } finally {
        mutationGateway.dispose();
      }
    });
  });

  suite('Finding 2: XMLWriter routes updates through ConfigurationMutationEngine', () => {
    test('XMLWriter.addNestedElement fails with concurrent modification conflict when file changes before mutation', async () => {
      const catalogsDir = path.join(configRoot, 'Catalogs');
      await fs.promises.mkdir(catalogsDir, { recursive: true });
      const catPath = path.join(catalogsDir, 'Items.xml');
      const initialXml = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.16">
\t<Catalog uuid="55555555-5555-5555-5555-555555555555">
\t\t<Properties>
\t\t\t<Name>Items</Name>
\t\t</Properties>
\t\t<ChildObjects/>
\t</Catalog>
</MetaDataObject>`;
      await fs.promises.writeFile(catPath, initialXml, 'utf8');

      // Intercept fs.promises.readFile to modify the file during reading
      const originalReadFile = fs.promises.readFile;
      let firstRead = true;
      // @ts-expect-error test interceptor
      fs.promises.readFile = async (...args: Parameters<typeof originalReadFile>) => {
        const res = await originalReadFile(...args);
        if (firstRead && typeof args[0] === 'string' && args[0].endsWith('Items.xml')) {
          firstRead = false;
          await originalWriteFile(catPath, initialXml.replace('Items', 'ItemsModified'), 'utf8');
        }
        return res;
      };
      const originalWriteFile = fs.promises.writeFile;

      try {
        await assert.rejects(
          async () => {
            await XMLWriter.addNestedElement(catPath, 'Attribute', 'Attr1', {}, MetadataType.Catalog, 'Items');
          },
          /Concurrent modification detected|STALE_TARGET_REVISION|Файл изменился/,
        );
      } finally {
        fs.promises.readFile = originalReadFile;
      }
    });
  });
});
