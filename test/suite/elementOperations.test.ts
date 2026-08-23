import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { XMLParser } from 'fast-xml-parser';
import { TreeNode, MetadataType } from '../../src/models/treeNode';
import {
  createElement,
  createForm,
  duplicateElement,
  deleteElement,
  renameElement,
  isRootObjectCreateInTypeFolder,
  planRenameRootElement,
} from '../../src/services/elementOperations';
import { MutationPlanExecutor } from '../../src/services/configurationSession/mutationPlan';
import { XMLWriter } from '../../src/utils/XMLWriter';
import {
  createTempDir,
  cleanupTempDir,
  createConfigNode,
  createCatalogsTypeNode,
  createCatalogNode,
  createFormsNode,
  fileExists,
  dirExists,
  readFileContent,
} from '../helpers/testHelpers';
import { ensureR6PlaceholdersForInstanceNode, NormalizeContext } from '../../src/utils/treeNormalization';
import { ConfigFormat } from '../../src/parsers/formatDetector';
import { addRootObjectToConfiguration } from '../../src/services/configurationXmlUpdater';

async function writeConfigurationWithFormat(dir: string, version = '2.20'): Promise<void> {
  await fs.promises.writeFile(
    path.join(dir, 'Configuration.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<MetaDataObject version="${version}"><Configuration><Properties><Name>Test</Name></Properties><ChildObjects/></Configuration></MetaDataObject>`,
    'utf8'
  );
}

suite('elementOperations', () => {
  let tmpDir: string;
  let catalogPath: string;
  let configNode: TreeNode;
  let catalogsTypeNode: TreeNode;
  let catalogNode: TreeNode;

  setup(async () => {
    tmpDir = await createTempDir('1cviewer-el-');
    const catalogsPath = path.join(tmpDir, 'Catalogs');
    await fs.promises.mkdir(catalogsPath, { recursive: true });
    catalogPath = path.join(catalogsPath, 'ExistingCatalog.xml');
    await XMLWriter.createMinimalElementFile(catalogPath, 'Catalog', 'ExistingCatalog', '2.20');
    // Configuration.xml required for createElement (addRootObjectToConfiguration)
    const configXmlPath = path.join(tmpDir, 'Configuration.xml');
    const configXml = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core" version="2.20">
  <Configuration uuid="42bff091-dd0b-4592-a67f-70c38db7993f">
    <Properties><Name>TestConfig</Name></Properties>
    <ChildObjects>
      <Catalog>ExistingCatalog</Catalog>
    </ChildObjects>
  </Configuration>
</MetaDataObject>
`;
    await fs.promises.writeFile(configXmlPath, configXml, 'utf-8');

    configNode = createConfigNode();
    catalogsTypeNode = createCatalogsTypeNode(configNode, catalogsPath);
    catalogNode = createCatalogNode('ExistingCatalog', catalogsTypeNode, catalogPath);
  });

  teardown(async () => {
    await cleanupTempDir(tmpDir);
  });

  test('isRootObjectCreateInTypeFolder true for Roles under Общие, false for Role instance', () => {
    const cfg = createConfigNode();
    const common: TreeNode = {
      id: 'Common',
      name: 'Общие',
      type: MetadataType.Unknown,
      properties: {},
      parent: cfg,
      children: [],
    };
    const rolesFolder: TreeNode = {
      id: 'Roles',
      name: 'Роли',
      type: MetadataType.Role,
      properties: {},
      filePath: '/cfg/Roles',
      parent: common,
      children: [],
    };
    cfg.children = [common];
    common.children = [rolesFolder];
    assert.strictEqual(isRootObjectCreateInTypeFolder(rolesFolder), true);

    const roleInstance: TreeNode = {
      id: 'Roles.SomeRole',
      name: 'SomeRole',
      type: MetadataType.Role,
      properties: {},
      filePath: '/cfg/Roles/SomeRole.xml',
      parent: rolesFolder,
      children: [],
    };
    assert.strictEqual(isRootObjectCreateInTypeFolder(roleInstance), false);
  });

  test('createElement throws when parent is Configuration', async () => {
    await assert.rejects(
      async () => createElement(configNode, 'NewCat'),
      /Выберите узел типа/
    );
  });

  test('createElement creates new catalog file and folder', async () => {
    await createElement(catalogsTypeNode, 'NewCatalog');
    const filePath = path.join(tmpDir, 'Catalogs', 'NewCatalog.xml');
    const dirPath = path.join(tmpDir, 'Catalogs', 'NewCatalog');
    assert.ok(fileExists(filePath));
    assert.ok(dirExists(dirPath));
    const content = await readFileContent(filePath);
    assert.ok(content.includes('<Name>NewCatalog</Name>'));
  });

  test('createElement creates Role when type folder is under Общие (not Файл объекта не найден)', async () => {
    const dir = await createTempDir('1cviewer-role-common-');
    try {
      const rolesPath = path.join(dir, 'Roles');
      await fs.promises.mkdir(rolesPath, { recursive: true });
      const configXmlPath = path.join(dir, 'Configuration.xml');
      const configXml = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core" version="2.20">
  <Configuration uuid="42bff091-dd0b-4592-a67f-70c38db7993f">
    <Properties><Name>TestConfig</Name></Properties>
    <ChildObjects/>
  </Configuration>
</MetaDataObject>
`;
      await fs.promises.writeFile(configXmlPath, configXml, 'utf-8');

      const cfgNode = createConfigNode({ filePath: configXmlPath });
      const commonNode: TreeNode = {
        id: 'Common',
        name: 'Общие',
        type: MetadataType.Unknown,
        properties: {},
        parent: cfgNode,
        children: [],
      };
      const rolesTypeNode: TreeNode = {
        id: 'Roles',
        name: 'Роли',
        type: MetadataType.Role,
        properties: {},
        filePath: rolesPath,
        parent: commonNode,
        children: [],
      };
      cfgNode.children = [commonNode];
      commonNode.children = [rolesTypeNode];

      await createElement(rolesTypeNode, 'NewRole');
      const roleXml = path.join(rolesPath, 'NewRole.xml');
      assert.ok(fileExists(roleXml), 'NewRole.xml must exist');
      const updatedCfg = await readFileContent(configXmlPath);
      assert.ok(updatedCfg.includes('NewRole'), 'Configuration.xml must list new role');
    } finally {
      await cleanupTempDir(dir);
    }
  });

  test('createElement creates CommonModule when type folder is under Общие', async () => {
    const dir = await createTempDir('1cviewer-cm-common-');
    try {
      const cmPath = path.join(dir, 'CommonModules');
      await fs.promises.mkdir(cmPath, { recursive: true });
      const configXmlPath = path.join(dir, 'Configuration.xml');
      const configXml = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core" version="2.20">
  <Configuration uuid="42bff091-dd0b-4592-a67f-70c38db7993f">
    <Properties><Name>TestConfig</Name></Properties>
    <ChildObjects/>
  </Configuration>
</MetaDataObject>
`;
      await fs.promises.writeFile(configXmlPath, configXml, 'utf-8');

      const cfgNode = createConfigNode({ filePath: configXmlPath });
      const commonNode: TreeNode = {
        id: 'Common',
        name: 'Общие',
        type: MetadataType.Unknown,
        properties: {},
        parent: cfgNode,
        children: [],
      };
      const cmTypeNode: TreeNode = {
        id: 'CommonModules',
        name: 'Общие модули',
        type: MetadataType.CommonModule,
        properties: {},
        filePath: cmPath,
        parent: commonNode,
        children: [],
      };
      cfgNode.children = [commonNode];
      commonNode.children = [cmTypeNode];

      await createElement(cmTypeNode, 'NewCommonModule');
      const xmlPath = path.join(cmPath, 'NewCommonModule.xml');
      assert.ok(fileExists(xmlPath));
      const moduleXml = await readFileContent(xmlPath);
      assert.ok(
        !moduleXml.includes('<ChildObjects'),
        'Configurator expects CommonModule without ChildObjects (see ut_demo_ForFormat)'
      );
      const updatedCfg = await readFileContent(configXmlPath);
      assert.ok(updatedCfg.includes('NewCommonModule'));
    } finally {
      await cleanupTempDir(dir);
    }
  });

  test('createElement Role under Общие finds Configuration.xml in EDT layout (src/Roles)', async () => {
    const dir = await createTempDir('1cviewer-role-edt-');
    try {
      const srcRoles = path.join(dir, 'src', 'Roles');
      await fs.promises.mkdir(srcRoles, { recursive: true });
      const configXmlPath = path.join(dir, 'Configuration.xml');
      const configXml = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core" version="2.20">
  <Configuration uuid="42bff091-dd0b-4592-a67f-70c38db7993f">
    <Properties><Name>EdtCfg</Name></Properties>
    <ChildObjects/>
  </Configuration>
</MetaDataObject>
`;
      await fs.promises.writeFile(configXmlPath, configXml, 'utf-8');

      const cfgNode = createConfigNode({ filePath: configXmlPath });
      const commonNode: TreeNode = {
        id: 'Common',
        name: 'Общие',
        type: MetadataType.Unknown,
        properties: {},
        parent: cfgNode,
        children: [],
      };
      const rolesTypeNode: TreeNode = {
        id: 'Roles',
        name: 'Роли',
        type: MetadataType.Role,
        properties: {},
        filePath: srcRoles,
        parent: commonNode,
        children: [],
      };
      cfgNode.children = [commonNode];
      commonNode.children = [rolesTypeNode];

      await createElement(rolesTypeNode, 'EdtRole');
      assert.ok(fileExists(path.join(srcRoles, 'EdtRole.xml')));
      const updatedCfg = await readFileContent(configXmlPath);
      assert.ok(updatedCfg.includes('EdtRole'));
    } finally {
      await cleanupTempDir(dir);
    }
  });

  test('createElement throws for duplicate sibling name', async () => {
    await assert.rejects(
      async () => createElement(catalogsTypeNode, 'ExistingCatalog'),
      /уже существует/
    );
  });

  test('createForm throws when parent is not Forms node', async () => {
    await assert.rejects(
      async () => createForm(catalogsTypeNode, 'NewForm'),
      /Создание формы: выберите узел «Forms»/
    );
  });

  test('createForm creates form directory and minimal files', async () => {
    const formsPath = path.join(tmpDir, 'Catalogs', 'ExistingCatalog', 'Forms');
    await fs.promises.mkdir(formsPath, { recursive: true });
    const formsNode = createFormsNode(catalogNode, formsPath);
    
    await createForm(formsNode, 'НоваяФорма');
    const formMetaPath = path.join(formsPath, 'НоваяФорма.xml');
    const formDir = path.join(formsPath, 'НоваяФорма');
    const formXmlPath = path.join(formDir, 'Ext', 'Form.xml');
    const modulePath = path.join(formDir, 'Ext', 'Form', 'Module.bsl');

    assert.ok(fileExists(formMetaPath));
    assert.ok(dirExists(formDir));
    assert.ok(fileExists(formXmlPath));
    assert.ok(fileExists(modulePath));
    
    const metaContent = await readFileContent(formMetaPath);
    assert.ok(metaContent.includes('<Name>НоваяФорма</Name>'));
    assert.ok(
      metaContent.includes('<FormType>Managed</FormType>'),
      'Designer/ibcmd: у метаданных формы должно быть FormType'
    );
    assert.ok(
      !metaContent.includes('<ChildObjects'),
      'метаданные встроенной формы без ChildObjects (ibcmd)'
    );
    const extContent = await readFileContent(formXmlPath);
    assert.ok(extContent.includes('http://v8.1c.ru/8.3/xcf/logform') && extContent.includes('<Form'));

    const ownerXml = await readFileContent(catalogPath);
    assert.ok(
      ownerXml.includes('<Form>НоваяФорма</Form>'),
      'owner metadata ChildObjects must list the new form'
    );
  });

  test('createElement on Forms folder creates form (same as createForm)', async () => {
    const formsPath = path.join(tmpDir, 'Catalogs', 'ExistingCatalog', 'Forms');
    await fs.promises.mkdir(formsPath, { recursive: true });
    const formsNode = createFormsNode(catalogNode, formsPath);
    await createElement(formsNode, 'ЧерезСоздатьЭлемент');
    const formMetaPath = path.join(formsPath, 'ЧерезСоздатьЭлемент.xml');
    assert.ok(fileExists(formMetaPath));
  });

  test('deleteElement removes form directory created by createForm', async () => {
    const formsPath = path.join(tmpDir, 'Catalogs', 'ExistingCatalog', 'Forms');
    await fs.promises.mkdir(formsPath, { recursive: true });
    const formsNode = createFormsNode(catalogNode, formsPath);
    await createForm(formsNode, 'FormToDelete');
    const formMetaPath = path.join(formsPath, 'FormToDelete.xml');
    const formDir = path.join(formsPath, 'FormToDelete');
    const formNode: TreeNode = {
      id: 'Forms.FormToDelete',
      name: 'FormToDelete',
      type: MetadataType.Form,
      properties: {},
      children: [],
      filePath: formMetaPath,
      parent: formsNode,
    };
    await deleteElement(formNode);
    assert.ok(!fileExists(formMetaPath));
    assert.ok(!dirExists(formDir));
    const ownerXmlAfter = await readFileContent(catalogPath);
    assert.ok(
      !ownerXmlAfter.includes('<Form>FormToDelete</Form>'),
      'form reference must be removed from owner ChildObjects'
    );
  });

  test('deleteElement clears DefaultListForm when it points at the deleted form', async () => {
    const formsPath = path.join(tmpDir, 'Catalogs', 'ExistingCatalog', 'Forms');
    await fs.promises.mkdir(formsPath, { recursive: true });
    const formsNode = createFormsNode(catalogNode, formsPath);
    await createForm(formsNode, 'ListFormRef');
    let ownerXml = await readFileContent(catalogPath);
    ownerXml = ownerXml.replace(
      /\t\t<\/Properties>/,
      '\t\t\t<DefaultListForm>Catalog.ExistingCatalog.Form.ListFormRef</DefaultListForm>\n\t\t</Properties>'
    );
    await fs.promises.writeFile(catalogPath, ownerXml, 'utf-8');

    const formMetaPath = path.join(formsPath, 'ListFormRef.xml');
    const formNode: TreeNode = {
      id: 'Forms.ListFormRef',
      name: 'ListFormRef',
      type: MetadataType.Form,
      properties: {},
      children: [],
      filePath: formMetaPath,
      parent: formsNode,
    };
    await deleteElement(formNode);
    const after = await readFileContent(catalogPath);
    assert.ok(!after.includes('ListFormRef'), 'default form ref and ChildObjects entry should be gone');
  });

  test('duplicateElement creates copy of catalog', async () => {
    const childUuid = '22222222-2222-4222-8222-222222222222';
    const externalUuid = '99999999-9999-4999-8999-999999999999';
    await fs.promises.writeFile(catalogPath, `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xr="http://v8.3/xcf/readable" version="2.20">
  <Catalog uuid="11111111-1111-4111-8111-111111111111">
    <InternalInfo><xr:GeneratedType name="CatalogObject.ExistingCatalog" category="Object"><xr:TypeId>33333333-3333-4333-8333-333333333333</xr:TypeId><xr:ValueId>44444444-4444-4444-8444-444444444444</xr:ValueId></xr:GeneratedType></InternalInfo>
    <Properties><Name>ExistingCatalog</Name><Synonym><v8:item><v8:lang>ru</v8:lang><v8:content>ExistingCatalog</v8:content></v8:item></Synonym><InputByString><xr:Field>Catalog.ExistingCatalog.StandardAttribute.Description</xr:Field></InputByString></Properties>
    <ChildObjects><Attribute uuid="${childUuid}"><Properties><Name>Code</Name></Properties></Attribute></ChildObjects>
  </Catalog>
</MetaDataObject>`, 'utf-8');
    const sourceDir = path.join(tmpDir, 'Catalogs', 'ExistingCatalog');
    await fs.promises.mkdir(sourceDir, { recursive: true });
    await fs.promises.writeFile(path.join(sourceDir, 'Identity.xml'),
      `<Root uuid="55555555-5555-4555-8555-555555555555"><OwnRef>${childUuid}</OwnRef><ExternalRef>${externalUuid}</ExternalRef><xr:GeneratedType name="CatalogObject.ExistingCatalog"/></Root>`,
      'utf-8');
    await duplicateElement(catalogNode, 'CopyCatalog');
    const filePath = path.join(tmpDir, 'Catalogs', 'CopyCatalog.xml');
    assert.ok(fileExists(filePath));
    const content = await readFileContent(filePath);
    assert.ok(content.includes('<Name>CopyCatalog</Name>'));

    const domParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    const sourceDom = domParser.parse(await readFileContent(catalogNode.filePath!));
    const copyDom = domParser.parse(content);
    const sourceUuid = sourceDom.MetaDataObject.Catalog['@_uuid'];
    const copyUuid = copyDom.MetaDataObject.Catalog['@_uuid'];
    assert.match(copyUuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.notStrictEqual(copyUuid, sourceUuid, 'duplicate must receive a fresh root UUID');
    const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
    const sourceIdentityFile = await readFileContent(path.join(sourceDir, 'Identity.xml'));
    const sourceIdentities = new Set([
      ...((await readFileContent(catalogNode.filePath!)).match(uuidPattern) ?? []),
      ...(sourceIdentityFile.match(uuidPattern) ?? []),
    ]);
    const copiedIdentityFile = await readFileContent(path.join(tmpDir, 'Catalogs', 'CopyCatalog', 'Identity.xml'));
    const copyIdentities = new Set([...(content.match(uuidPattern) ?? []), ...(copiedIdentityFile.match(uuidPattern) ?? [])]);
    for (const identity of sourceIdentities) {
      if (identity !== externalUuid) {
        assert.ok(!copyIdentities.has(identity), `identity ${identity} must be remapped`);
      }
    }
    assert.ok(content.includes('CatalogObject.CopyCatalog'));
    assert.ok(content.includes('Catalog.CopyCatalog.StandardAttribute.Description'));
    assert.ok(copiedIdentityFile.includes('CatalogObject.CopyCatalog'));
    assert.ok(copiedIdentityFile.includes(externalUuid), 'external UUID references must stay unchanged');
    const copiedChildUuid = copyDom.MetaDataObject.Catalog.ChildObjects.Attribute['@_uuid'];
    assert.ok(copiedIdentityFile.includes(copiedChildUuid), 'references to remapped own UUID must remain consistent');

    const configDom = domParser.parse(await readFileContent(path.join(tmpDir, 'Configuration.xml')));
    const catalogEntries = configDom.MetaDataObject.Configuration.ChildObjects.Catalog;
    assert.deepStrictEqual(
      Array.isArray(catalogEntries) ? catalogEntries : [catalogEntries],
      ['ExistingCatalog', 'CopyCatalog'],
      'duplicate must be registered in Configuration.xml/ChildObjects'
    );
  });

  for (const version of ['2.17', '2.21']) {
    test(`createForm uses project profile ${version} for both child documents`, async () => {
      const configPath = path.join(tmpDir, 'Configuration.xml');
      const configuration = await readFileContent(configPath);
      await fs.promises.writeFile(
        configPath,
        configuration.replace('version="2.20"', `version="${version}"`),
        'utf8'
      );
      const formsPath = path.join(tmpDir, 'Catalogs', 'ExistingCatalog', 'Forms');
      const formsNode = createFormsNode(catalogNode, formsPath);

      await createForm(formsNode, `Profile${version.replace('.', '')}`);

      const formName = `Profile${version.replace('.', '')}`;
      const metaXml = await readFileContent(path.join(formsPath, `${formName}.xml`));
      const extXml = await readFileContent(path.join(formsPath, formName, 'Ext', 'Form.xml'));
      assert.ok(metaXml.includes(`version="${version}"`));
      assert.ok(extXml.includes(`version="${version}"`));
    });
  }

  test('duplicateElement preflights target directory without leaving a descriptor', async () => {
    const targetDir = path.join(tmpDir, 'Catalogs', 'CopyCatalog');
    await fs.promises.mkdir(targetDir, { recursive: true });
    await assert.rejects(() => duplicateElement(catalogNode, 'CopyCatalog'), /Каталог объекта уже существует/);
    assert.ok(!fs.existsSync(path.join(tmpDir, 'Catalogs', 'CopyCatalog.xml')));
    const configuration = await readFileContent(path.join(tmpDir, 'Configuration.xml'));
    assert.ok(!configuration.includes('<Catalog>CopyCatalog</Catalog>'));
  });

  test('duplicateElement throws when no parent', async () => {
    const noParent = { ...catalogNode, parent: undefined };
    await assert.rejects(
      async () => duplicateElement(noParent as TreeNode, 'Copy'),
      /Нет родительского/
    );
  });

  test('deleteElement removes catalog file and folder', async () => {
    const elementDir = path.join(tmpDir, 'Catalogs', 'ExistingCatalog');
    await fs.promises.mkdir(elementDir, { recursive: true });
    await deleteElement(catalogNode);
    assert.ok(!fileExists(catalogNode.filePath!));
    assert.ok(!dirExists(elementDir));
  });

  test('deleteElement throws for Configuration', async () => {
    await assert.rejects(
      async () => deleteElement(configNode),
      /Нельзя удалить корень/
    );
  });

  test('renameElement renames catalog file and folder', async () => {
    const configXmlPath = path.join(tmpDir, 'Configuration.xml');
    const configWithNeighbors = (await readFileContent(configXmlPath)).replace(
      '<Catalog>ExistingCatalog</Catalog>',
      '<Language>Русский</Language>\n      <Catalog>ExistingCatalog</Catalog>\n      <Document>Заказ</Document>'
    );
    await fs.promises.writeFile(configXmlPath, configWithNeighbors, 'utf-8');
    const elementDir = path.join(tmpDir, 'Catalogs', 'ExistingCatalog');
    await fs.promises.mkdir(elementDir, { recursive: true });
    await renameElement(catalogNode, 'RenamedCatalog', tmpDir);
    const newPath = path.join(tmpDir, 'Catalogs', 'RenamedCatalog.xml');
    const newDir = path.join(tmpDir, 'Catalogs', 'RenamedCatalog');
    assert.ok(fs.existsSync(newPath));
    assert.ok(fs.existsSync(newDir));
    assert.ok(!fs.existsSync(catalogNode.filePath!));

    const configurationXml = await readFileContent(configXmlPath);
    const domParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    const configDom = domParser.parse(configurationXml);
    const childObjects = configDom.MetaDataObject.Configuration.ChildObjects;
    assert.strictEqual(childObjects.Catalog, 'RenamedCatalog');
    assert.ok(!configurationXml.includes('<Catalog>ExistingCatalog</Catalog>'));
    assert.ok(
      configurationXml.indexOf('<Language>Русский</Language>')
        < configurationXml.indexOf('<Catalog>RenamedCatalog</Catalog>')
      && configurationXml.indexOf('<Catalog>RenamedCatalog</Catalog>')
        < configurationXml.indexOf('<Document>Заказ</Document>'),
      'rename must preserve the ChildObjects entry type and position'
    );
  });

  test('renameElement updates own identity tokens and preserves UUIDs', async () => {
    const rootUuid = '11111111-1111-4111-8111-111111111111';
    const typeId = '33333333-3333-4333-8333-333333333333';
    await fs.promises.writeFile(catalogPath, `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xr="http://v8.3/xcf/readable" version="2.20">
  <Catalog uuid="${rootUuid}"><InternalInfo><xr:GeneratedType name="CatalogObject.ExistingCatalog" category="Object"><xr:TypeId>${typeId}</xr:TypeId><xr:ValueId>44444444-4444-4444-8444-444444444444</xr:ValueId></xr:GeneratedType><xr:GeneratedType name="CatalogRef.ExistingCatalog" category="Ref"><xr:TypeId>55555555-5555-4555-8555-555555555555</xr:TypeId><xr:ValueId>66666666-6666-4666-8666-666666666666</xr:ValueId></xr:GeneratedType></InternalInfo><Properties><Name>ExistingCatalog</Name><Synonym><v8:item><v8:lang>ru</v8:lang><v8:content>ExistingCatalog</v8:content></v8:item></Synonym><InputByString><xr:Field>Catalog.ExistingCatalog.StandardAttribute.Description</xr:Field></InputByString></Properties><ChildObjects/></Catalog>
</MetaDataObject>`, 'utf-8');
    const sourceDir = path.join(tmpDir, 'Catalogs', 'ExistingCatalog');
    await fs.promises.mkdir(sourceDir, { recursive: true });
    await fs.promises.writeFile(path.join(sourceDir, 'Identity.xml'),
      '<Root><xr:GeneratedType name="CatalogObject.ExistingCatalog"/><xr:Field>Catalog.ExistingCatalog.StandardAttribute.Description</xr:Field></Root>',
      'utf-8');
    const referencesDir = path.join(tmpDir, 'Documents');
    await fs.promises.mkdir(referencesDir, { recursive: true });
    const referencesPath = path.join(referencesDir, 'Refs.xml');
    await fs.promises.writeFile(referencesPath,
      '<Refs><Type>CatalogObject.ExistingCatalog</Type><Ref>CatalogRef.ExistingCatalog</Ref><Field>Catalog.ExistingCatalog.StandardAttribute.Code</Field></Refs>',
      'utf-8');

    await renameElement(catalogNode, 'RenamedCatalog', tmpDir);

    const renamed = await readFileContent(path.join(tmpDir, 'Catalogs', 'RenamedCatalog.xml'));
    const nested = await readFileContent(path.join(tmpDir, 'Catalogs', 'RenamedCatalog', 'Identity.xml'));
    const references = await readFileContent(referencesPath);
    assert.ok(renamed.includes(`uuid="${rootUuid}"`));
    assert.ok(renamed.includes(typeId), 'rename must preserve generated type IDs');
    for (const value of [renamed, nested, references]) {
      assert.ok(!value.includes('CatalogObject.ExistingCatalog'));
      assert.ok(!value.includes('Catalog.ExistingCatalog.'));
    }
    assert.ok(references.includes('CatalogRef.RenamedCatalog'));
  });

  test('root rename plan transforms nested Ext XML before moving the object directory', async () => {
    const extDir = path.join(tmpDir, 'Catalogs', 'ExistingCatalog', 'Ext');
    const nestedPath = path.join(extDir, 'Identity.xml');
    await fs.promises.mkdir(extDir, { recursive: true });
    await fs.promises.writeFile(
      nestedPath,
      '<Root><xr:GeneratedType name="CatalogObject.ExistingCatalog"/></Root>',
      'utf8',
    );

    const plan = await planRenameRootElement(catalogNode, 'RenamedCatalog', tmpDir);
    await new MutationPlanExecutor(tmpDir).execute(plan);

    const renamedNestedPath = path.join(tmpDir, 'Catalogs', 'RenamedCatalog', 'Ext', 'Identity.xml');
    assert.strictEqual(fs.existsSync(nestedPath), false);
    assert.ok(fs.existsSync(renamedNestedPath));
    assert.ok((await fs.promises.readFile(renamedNestedPath, 'utf8')).includes('CatalogObject.RenamedCatalog'));
    assert.ok((await fs.promises.readFile(path.join(tmpDir, 'Configuration.xml'), 'utf8')).includes(
      '<Catalog>RenamedCatalog</Catalog>',
    ));
    assert.strictEqual(fs.existsSync(path.join(tmpDir, '.cdt-journal')), false);
  });

  test('renameElement preflights missing Configuration.xml registration', async () => {
    const configurationPath = path.join(tmpDir, 'Configuration.xml');
    const configuration = (await readFileContent(configurationPath))
      .replace('<Catalog>ExistingCatalog</Catalog>', '');
    await fs.promises.writeFile(configurationPath, configuration, 'utf-8');
    await assert.rejects(
      () => renameElement(catalogNode, 'RenamedCatalog', tmpDir),
      /is not registered/
    );
    assert.ok(fs.existsSync(catalogPath));
    assert.ok(!fs.existsSync(path.join(tmpDir, 'Catalogs', 'RenamedCatalog.xml')));
  });

  test('renameElement to same name does nothing', async () => {
    await renameElement(catalogNode, 'ExistingCatalog', tmpDir);
    assert.ok(fs.existsSync(catalogNode.filePath!));
  });

  test('createElement rejects nested attribute on Role instance (Designer: no ChildObjects)', async () => {
    const rolesDir = path.join(tmpDir, 'Roles');
    await fs.promises.mkdir(rolesDir, { recursive: true });
    const roleXml = path.join(rolesDir, 'R1.xml');
    await XMLWriter.createMinimalElementFile(roleXml, 'Role', 'R1', '2.20');
    const rolesTypeNode: TreeNode = {
      id: 'Roles',
      name: 'Роли',
      type: MetadataType.Role,
      properties: {},
      filePath: rolesDir,
      parent: configNode,
      children: [],
    };
    const roleInstance: TreeNode = {
      id: 'Roles.R1',
      name: 'R1',
      type: MetadataType.Role,
      properties: {},
      filePath: roleXml,
      parent: rolesTypeNode,
      children: [],
    };
    await assert.rejects(
      async () => createElement(roleInstance, 'BadAttr'),
      /нет ChildObjects/
    );
  });

  test('createElement creates attribute with proper structure', async () => {
    await createElement(catalogNode, 'NewAttribute');
    const content = await readFileContent(catalogNode.filePath!);
    
    // Check that the attribute was added with proper structure
    assert.ok(content.includes('<Attribute'));
    assert.ok(content.includes('uuid="'));
    assert.ok(content.includes('<Name>NewAttribute</Name>'));
    assert.ok(content.includes('<Synonym>'));
    assert.ok(content.includes('<v8:lang>ru</v8:lang>'));
    assert.ok(content.includes('<v8:content>NewAttribute</v8:content>'));
    assert.ok(content.includes('<Comment/>') || content.includes('<Comment></Comment>'));
    assert.ok(content.includes('<PasswordMode>false</PasswordMode>'));
    assert.ok(content.includes('<Format/>') || content.includes('<Format></Format>'));
    assert.ok(content.includes('<EditFormat/>') || content.includes('<EditFormat></EditFormat>'));
    assert.ok(content.includes('<ToolTip>'));
    assert.ok(content.includes('<MarkNegatives>false</MarkNegatives>'));
    assert.ok(content.includes('<Mask/>') || content.includes('<Mask></Mask>'));
    assert.ok(content.includes('<MultiLine>false</MultiLine>'));
    assert.ok(content.includes('<ExtendedEdit>false</ExtendedEdit>'));
    assert.ok(content.includes('<MinValue xsi:nil="true"/>'));
    assert.ok(content.includes('<MaxValue xsi:nil="true"/>'));
    assert.ok(content.includes('<FillFromFillingValue>true</FillFromFillingValue>'));
    assert.ok(content.includes('<FillChecking>DontCheck</FillChecking>'));
    assert.ok(content.includes('<ChoiceFoldersAndItems>Items</ChoiceFoldersAndItems>'));
    assert.ok(content.includes('<ChoiceParameterLinks/>') || content.includes('<ChoiceParameterLinks></ChoiceParameterLinks>'));
    assert.ok(content.includes('<ChoiceParameters/>') || content.includes('<ChoiceParameters></ChoiceParameters>'));
    assert.ok(content.includes('<QuickChoice>Auto</QuickChoice>'));
    assert.ok(content.includes('<CreateOnInput>Auto</CreateOnInput>'));
    assert.ok(content.includes('<Indexing>DontIndex</Indexing>'));
    assert.ok(content.includes('<FullTextSearch>Use</FullTextSearch>'));
    assert.ok(content.includes('<DataHistory>Use</DataHistory>'));
  });

  test('createElement creates attribute in Attributes folder', async () => {
    const attributesPath = path.join(tmpDir, 'Catalogs', 'ExistingCatalog', 'Attributes');
    await fs.promises.mkdir(attributesPath, { recursive: true });
    const attributesNode = {
      id: 'Attributes',
      name: 'Attributes',
      type: MetadataType.Attribute,
      parent: catalogNode,
      filePath: attributesPath,
      properties: {},
      children: undefined
    };
    
    await createElement(attributesNode, 'NewAttribute');
    const content = await readFileContent(catalogNode.filePath!);
    
    // Check that the attribute was added to the object's XML
    assert.ok(content.includes('<Attribute'));
    assert.ok(content.includes('uuid="'));
    assert.ok(content.includes('<Name>NewAttribute</Name>'));
  });

  test('createElement creates tabular section in TabularSections folder', async () => {
    const tabularSectionsPath = path.join(tmpDir, 'Catalogs', 'ExistingCatalog', 'TabularSections');
    await fs.promises.mkdir(tabularSectionsPath, { recursive: true });
    const tabularSectionsNode = {
      id: 'TabularSections',
      name: 'TabularSections',
      type: MetadataType.TabularSection,
      parent: catalogNode,
      filePath: tabularSectionsPath,
      properties: {},
      children: undefined
    };

    await createElement(tabularSectionsNode, 'Items');
    const content = await readFileContent(catalogNode.filePath!);
    assert.ok(content.includes('<TabularSection'));
    assert.ok(content.includes('<Name>Items</Name>'));
    assert.ok(content.includes('<ChildObjects>'));
    assert.ok(content.includes('<ChildObjects>\n      <TabularSection') || content.includes('<ChildObjects>\r\n      <TabularSection'));
    assert.ok(content.includes('<TabularSection') && content.includes('<ChildObjects/>'));
    assert.ok(content.includes('<InternalInfo>'));
    assert.ok(content.includes('category="TabularSection"'));
    assert.ok(content.includes('category="TabularSectionRow"'));
    assert.ok(!content.trimStart().startsWith('<TabularSections>'));
    const tsStart = content.indexOf('<TabularSection');
    const tsInternal = content.indexOf('<InternalInfo>', tsStart);
    const tsProps = content.indexOf('<Properties>', tsStart);
    const tsChildren = content.indexOf('<ChildObjects', tsStart);
    assert.ok(tsStart >= 0 && tsInternal > tsStart && tsProps > tsInternal && tsChildren > tsProps);
  });

  test('deleteElement removes tabular section from object ChildObjects', async () => {
    const tabularSectionsPath = path.join(tmpDir, 'Catalogs', 'ExistingCatalog', 'TabularSections');
    await fs.promises.mkdir(tabularSectionsPath, { recursive: true });
    const tabularSectionsNode = {
      id: 'TabularSections',
      name: 'TabularSections',
      type: MetadataType.TabularSection,
      parent: catalogNode,
      filePath: tabularSectionsPath,
      properties: {},
      children: undefined
    };
    await createElement(tabularSectionsNode, 'ToDelete');

    const tabularNode: TreeNode = {
      id: 'TabularSections.ToDelete',
      name: 'ToDelete',
      type: MetadataType.TabularSection,
      parent: catalogNode,
      parentFilePath: catalogNode.filePath,
      properties: {},
      children: undefined
    };
    await deleteElement(tabularNode);

    const content = await readFileContent(catalogNode.filePath!);
    assert.ok(!content.includes('<Name>ToDelete</Name>'));
  });

  test('createElement adds first column via tabular columns container (embedded ChildObjects)', async () => {
    const src = path.join(__dirname, '../fixtures/designer-config/Catalogs/CatalogEmptyEmbedded.xml');
    const dest = path.join(tmpDir, 'Catalogs', 'EmbCat.xml');
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.copyFile(src, dest);

    const embCatalog: TreeNode = {
      id: 'Catalogs.CatalogEmptyEmbedded',
      name: 'CatalogEmptyEmbedded',
      type: MetadataType.Catalog,
      filePath: dest,
      parent: catalogsTypeNode,
      properties: {},
    };
    const tabFolder: TreeNode = {
      id: 'TabularSections',
      name: 'TabularSections',
      type: MetadataType.TabularSection,
      parent: embCatalog,
      filePath: path.join(tmpDir, 'Catalogs', 'TabularSectionsEmb'),
      properties: {},
    };
    const section: TreeNode = {
      id: 'TabularSections.EmbeddedEmpty',
      name: 'EmbeddedEmpty',
      type: MetadataType.TabularSection,
      parent: tabFolder,
      parentFilePath: dest,
      properties: {},
    };
    const container: TreeNode = {
      id: 'TabularSections.EmbeddedEmpty.Attributes',
      name: 'Реквизиты',
      type: MetadataType.Attribute,
      properties: { type: 'TabularSectionColumns' },
      parent: section,
      parentFilePath: dest,
      children: [],
    };

    await createElement(container, 'FirstCol');
    const content = await readFileContent(dest);
    assert.ok(content.includes('<Name>FirstCol</Name>'));
  });

  test('createElement adds first column into dedicated TabularSections/Name/Name.xml file', async () => {
    const fixtureRoot = path.join(__dirname, '../fixtures/designer-config/Catalogs/CatalogEmptyFolder');
    const catDestDir = path.join(tmpDir, 'Catalogs', 'ZFolder');
    await fs.promises.cp(fixtureRoot, catDestDir, { recursive: true });
    const catXml = path.join(catDestDir, 'CatalogEmptyFolder.xml');
    const tsXml = path.join(catDestDir, 'TabularSections', 'FolderEmpty', 'FolderEmpty.xml');

    const catNode: TreeNode = {
      id: 'Catalogs.CatalogEmptyFolder',
      name: 'CatalogEmptyFolder',
      type: MetadataType.Catalog,
      filePath: catXml,
      parent: catalogsTypeNode,
      properties: {},
    };
    const tabFolder: TreeNode = {
      id: 'TabularSections',
      name: 'TabularSections',
      type: MetadataType.TabularSection,
      parent: catNode,
      filePath: path.join(catDestDir, 'TabularSections'),
      properties: {},
    };
    const section: TreeNode = {
      id: 'TabularSections.FolderEmpty',
      name: 'FolderEmpty',
      type: MetadataType.TabularSection,
      parent: tabFolder,
      filePath: tsXml,
      parentFilePath: catXml,
      properties: {},
    };
    const container: TreeNode = {
      id: 'TabularSections.FolderEmpty.Attributes',
      name: 'Реквизиты',
      type: MetadataType.Attribute,
      properties: { type: 'TabularSectionColumns' },
      parent: section,
      filePath: tsXml,
      parentFilePath: tsXml,
      children: [],
    };

    await createElement(container, 'DiskCol');
    const tsContent = await readFileContent(tsXml);
    assert.ok(tsContent.includes('<Name>DiskCol</Name>'));
  });

  test('duplicateElement clones tabular column XML (Type), not minimal Attribute', async () => {
    const src = path.join(__dirname, '../fixtures/designer-config/Catalogs/CatalogWithTabular.xml');
    const dest = path.join(tmpDir, 'Catalogs', 'CatDupCol.xml');
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.copyFile(src, dest);

    const catNode: TreeNode = {
      id: 'Catalogs.CatalogWithTabular',
      name: 'CatalogWithTabular',
      type: MetadataType.Catalog,
      filePath: dest,
      parent: catalogsTypeNode,
      properties: {},
    };
    const tabFolder: TreeNode = {
      id: 'TabularSections',
      name: 'TabularSections',
      type: MetadataType.TabularSection,
      parent: catNode,
      properties: {},
    };
    const section: TreeNode = {
      id: 'TabularSections.Tabular1',
      name: 'Tabular1',
      type: MetadataType.TabularSection,
      parent: tabFolder,
      parentFilePath: dest,
      properties: {},
    };
    const container: TreeNode = {
      id: 'TabularSections.Tabular1.Attributes',
      name: 'Реквизиты',
      type: MetadataType.Attribute,
      properties: { type: 'TabularSectionColumns' },
      parent: section,
      parentFilePath: dest,
      children: [
        { id: 'TabularSections.Tabular1.Col1', name: 'Col1', type: MetadataType.Attribute, properties: {} },
        { id: 'TabularSections.Tabular1.Col2', name: 'Col2', type: MetadataType.Attribute, properties: {} },
      ],
    };
    const col1: TreeNode = {
      id: 'TabularSections.Tabular1.Col1',
      name: 'Col1',
      type: MetadataType.Attribute,
      parent: container,
      parentFilePath: dest,
      properties: {},
    };

    await duplicateElement(col1, 'Col1Clone');
    const content = await readFileContent(dest);
    assert.ok(content.includes('<Name>Col1</Name>'));
    assert.ok(content.includes('<Name>Col1Clone</Name>'));
    assert.strictEqual((content.match(/xs:string/g) || []).length, 2);
    assert.strictEqual((content.match(/xs:decimal/g) || []).length, 1);
  });

  test('renameElement renames tabular column in embedded TabularSection ChildObjects', async () => {
    const src = path.join(__dirname, '../fixtures/designer-config/Catalogs/CatalogWithTabular.xml');
    const dest = path.join(tmpDir, 'Catalogs', 'CatRenameCol.xml');
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.copyFile(src, dest);

    const catNode: TreeNode = {
      id: 'Catalogs.CatalogWithTabular',
      name: 'CatalogWithTabular',
      type: MetadataType.Catalog,
      filePath: dest,
      parent: catalogsTypeNode,
      properties: {},
    };
    const tabFolder: TreeNode = {
      id: 'TabularSections',
      name: 'TabularSections',
      type: MetadataType.TabularSection,
      parent: catNode,
      properties: {},
    };
    const section: TreeNode = {
      id: 'TabularSections.Tabular1',
      name: 'Tabular1',
      type: MetadataType.TabularSection,
      parent: tabFolder,
      parentFilePath: dest,
      properties: {},
    };
    const container: TreeNode = {
      id: 'TabularSections.Tabular1.Attributes',
      name: 'Реквизиты',
      type: MetadataType.Attribute,
      properties: { type: 'TabularSectionColumns' },
      parent: section,
      parentFilePath: dest,
      children: [
        { id: 'TabularSections.Tabular1.Col1', name: 'Col1', type: MetadataType.Attribute, properties: {} },
        { id: 'TabularSections.Tabular1.Col2', name: 'Col2', type: MetadataType.Attribute, properties: {} },
      ],
    };
    const col1: TreeNode = {
      id: 'TabularSections.Tabular1.Col1',
      name: 'Col1',
      type: MetadataType.Attribute,
      parent: container,
      parentFilePath: dest,
      properties: {},
    };

    await renameElement(col1, 'ColRenamed', tmpDir);
    const content = await readFileContent(dest);
    assert.ok(content.includes('<Name>ColRenamed</Name>'), 'column Name updated in owner XML');
    assert.ok(content.includes('<Name>Col2</Name>'), 'sibling column unchanged');
    assert.ok(!content.includes('<Name>Col1</Name>'), 'old column name must not remain');
    assert.strictEqual((content.match(/xs:string/g) || []).length, 1);
    assert.strictEqual((content.match(/xs:decimal/g) || []).length, 1);
  });

  test('renameElement renames tabular column only in scoped SectionA when SectionB has same column name', async () => {
    const src = path.join(__dirname, '../fixtures/designer-config/Catalogs/CatalogTwoTabularSameColumn.xml');
    const dest = path.join(tmpDir, 'Catalogs', 'CatTwoTs.xml');
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.copyFile(src, dest);

    const catNode: TreeNode = {
      id: 'Catalogs.CatalogTwoTabularSameColumn',
      name: 'CatalogTwoTabularSameColumn',
      type: MetadataType.Catalog,
      filePath: dest,
      parent: catalogsTypeNode,
      properties: {},
    };
    const tabFolder: TreeNode = {
      id: 'TabularSections',
      name: 'TabularSections',
      type: MetadataType.TabularSection,
      parent: catNode,
      properties: {},
    };
    const sectionA: TreeNode = {
      id: 'TabularSections.SectionA',
      name: 'SectionA',
      type: MetadataType.TabularSection,
      parent: tabFolder,
      parentFilePath: dest,
      properties: {},
    };
    const containerA: TreeNode = {
      id: 'TabularSections.SectionA.Attributes',
      name: 'Реквизиты',
      type: MetadataType.Attribute,
      properties: { type: 'TabularSectionColumns' },
      parent: sectionA,
      parentFilePath: dest,
      children: [],
    };
    const colA: TreeNode = {
      id: 'TabularSections.SectionA.Nom',
      name: 'Номенклатура',
      type: MetadataType.Attribute,
      parent: containerA,
      parentFilePath: dest,
      properties: {},
    };

    await renameElement(colA, 'НоменклатураА', tmpDir);
    const content = await readFileContent(dest);
    assert.ok(content.includes('<Name>НоменклатураА</Name>'), 'SectionA column renamed');
    assert.ok(content.includes('<Name>Номенклатура</Name>'), 'SectionB column name unchanged');
    assert.ok(content.includes('<Name>Количество</Name>'), 'sibling column in SectionA unchanged');
    assert.strictEqual((content.match(/<Name>Номенклатура<\/Name>/g) || []).length, 1);
  });

  test('renameElement renames column in first catalog Товары only when second catalog has same section and column name', async () => {
    const srcA = path.join(__dirname, '../fixtures/designer-config/Catalogs/CatalogGoodsA.xml');
    const srcB = path.join(__dirname, '../fixtures/designer-config/Catalogs/CatalogGoodsB.xml');
    const destA = path.join(tmpDir, 'Catalogs', 'CatalogGoodsA.xml');
    const destB = path.join(tmpDir, 'Catalogs', 'CatalogGoodsB.xml');
    await fs.promises.mkdir(path.dirname(destA), { recursive: true });
    await fs.promises.copyFile(srcA, destA);
    await fs.promises.copyFile(srcB, destB);

    const catA: TreeNode = {
      id: 'Catalogs.CatalogGoodsA',
      name: 'CatalogGoodsA',
      type: MetadataType.Catalog,
      filePath: destA,
      parent: catalogsTypeNode,
      properties: {},
    };
    const tabFolderA: TreeNode = {
      id: 'TabularSections',
      name: 'TabularSections',
      type: MetadataType.TabularSection,
      parent: catA,
      properties: {},
    };
    const sectionA: TreeNode = {
      id: 'TabularSections.Товары',
      name: 'Товары',
      type: MetadataType.TabularSection,
      parent: tabFolderA,
      parentFilePath: destA,
      properties: {},
    };
    const containerA: TreeNode = {
      id: 'TabularSections.Товары.Attributes',
      name: 'Реквизиты',
      type: MetadataType.Attribute,
      properties: { type: 'TabularSectionColumns' },
      parent: sectionA,
      parentFilePath: destA,
      children: [],
    };
    const colA: TreeNode = {
      id: 'TabularSections.Товары.Art',
      name: 'Артикул',
      type: MetadataType.Attribute,
      parent: containerA,
      parentFilePath: destA,
      properties: {},
    };

    await renameElement(colA, 'АртикулПрайм', tmpDir);
    const contentA = await readFileContent(destA);
    const contentB = await readFileContent(destB);
    assert.ok(contentA.includes('<Name>АртикулПрайм</Name>'), 'catalog A column renamed');
    assert.ok(contentB.includes('<Name>Артикул</Name>'), 'catalog B column unchanged');
    assert.ok(!contentB.includes('<Name>АртикулПрайм</Name>'));
  });

  test('renameElement scoped tabular column does not rename top-level Attribute with same name', async () => {
    const src = path.join(__dirname, '../fixtures/designer-config/Catalogs/CatalogTopLevelAndTabularDupName.xml');
    const dest = path.join(tmpDir, 'Catalogs', 'CatDupTopTab.xml');
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.copyFile(src, dest);

    const catNode: TreeNode = {
      id: 'Catalogs.CatalogTopLevelAndTabularDupName',
      name: 'CatalogTopLevelAndTabularDupName',
      type: MetadataType.Catalog,
      filePath: dest,
      parent: catalogsTypeNode,
      properties: {},
    };
    const tabFolder: TreeNode = {
      id: 'TabularSections',
      name: 'TabularSections',
      type: MetadataType.TabularSection,
      parent: catNode,
      properties: {},
    };
    const section: TreeNode = {
      id: 'TabularSections.Lines',
      name: 'Lines',
      type: MetadataType.TabularSection,
      parent: tabFolder,
      parentFilePath: dest,
      properties: {},
    };
    const container: TreeNode = {
      id: 'TabularSections.Lines.Attributes',
      name: 'Реквизиты',
      type: MetadataType.Attribute,
      properties: { type: 'TabularSectionColumns' },
      parent: section,
      parentFilePath: dest,
      children: [],
    };
    const tabCol: TreeNode = {
      id: 'TabularSections.Lines.SharedColName',
      name: 'SharedColName',
      type: MetadataType.Attribute,
      parent: container,
      parentFilePath: dest,
      properties: {},
    };

    await renameElement(tabCol, 'LineColRenamed', tmpDir);
    const content = await readFileContent(dest);
    assert.ok(content.includes('<Name>SharedColName</Name>'), 'top-level attribute name unchanged');
    assert.ok(content.includes('<Name>LineColRenamed</Name>'), 'tabular column renamed');
    assert.strictEqual((content.match(/<Name>SharedColName<\/Name>/g) || []).length, 1);
    assert.strictEqual((content.match(/xs:string/g) || []).length, 1);
    assert.strictEqual((content.match(/xs:decimal/g) || []).length, 1);
  });

  test('writeNestedElementProperties scopes Attribute rename in dedicated TabularSection XML file', async () => {
    const src = path.join(
      __dirname,
      '../fixtures/designer-config/Catalogs/CatalogWithTabular/TabularSections/Tabular1/Tabular1.xml'
    );
    const dest = path.join(tmpDir, 'Catalogs', 'DedicatedTs', 'Tabular1.xml');
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.copyFile(src, dest);

    await XMLWriter.writeNestedElementProperties(
      dest,
      'Attribute',
      'Col1',
      { Name: 'ColDedicatedRenamed' },
      ['Name'],
      { scopedTabularSectionName: 'Tabular1' }
    );
    const content = await readFileContent(dest);
    assert.ok(content.includes('<Name>ColDedicatedRenamed</Name>'));
    assert.ok(content.includes('<Name>Col2</Name>'));
    assert.ok(!content.includes('<Name>Col1</Name>'));
  });

  test('createElement rejects duplicate column name in tabular columns container', async () => {
    const src = path.join(__dirname, '../fixtures/designer-config/Catalogs/CatalogEmptyEmbedded.xml');
    const dest = path.join(tmpDir, 'Catalogs', 'EmbCatDup.xml');
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.copyFile(src, dest);
    const embCatalog: TreeNode = {
      id: 'Catalogs.CatalogEmptyEmbedded',
      name: 'CatalogEmptyEmbedded',
      type: MetadataType.Catalog,
      filePath: dest,
      parent: catalogsTypeNode,
      properties: {},
    };
    const tabFolder: TreeNode = {
      id: 'TabularSections',
      name: 'TabularSections',
      type: MetadataType.TabularSection,
      parent: embCatalog,
      properties: {},
    };
    const section: TreeNode = {
      id: 'TabularSections.EmbeddedEmpty',
      name: 'EmbeddedEmpty',
      type: MetadataType.TabularSection,
      parent: tabFolder,
      parentFilePath: dest,
      properties: {},
    };
    const container: TreeNode = {
      id: 'TabularSections.EmbeddedEmpty.Attributes',
      name: 'Реквизиты',
      type: MetadataType.Attribute,
      properties: { type: 'TabularSectionColumns' },
      parent: section,
      parentFilePath: dest,
      children: [],
    };
    await createElement(container, 'DupCol');
    container.children = [
      { id: 'TabularSections.EmbeddedEmpty.DupCol', name: 'DupCol', type: MetadataType.Attribute, properties: {} },
    ];
    await assert.rejects(async () => createElement(container, 'DupCol'), Error);
  });

  test('createElement creates Ext/Module/Module.bsl for new CommonModule', async () => {
    const cmFolder = path.join(tmpDir, 'CommonModules');
    await fs.promises.mkdir(cmFolder, { recursive: true });
    const cmType: TreeNode = {
      id: 'CommonModules',
      name: 'CommonModules',
      type: MetadataType.CommonModule,
      filePath: cmFolder,
      parent: configNode,
      properties: { type: 'CommonModules' },
      children: [],
    };
    await createElement(cmType, 'NewCm');
    const bslPath = path.join(cmFolder, 'NewCm', 'Ext', 'Module', 'Module.bsl');
    assert.ok(await fileExists(bslPath));
  });

  test('duplicateElement copies CommonModule object directory including nested Ext', async () => {
    const fixture = path.join(__dirname, '../fixtures/designer-config/CommonModules/NestedModule');
    const cmRoot = path.join(tmpDir, 'CommonModules');
    await fs.promises.mkdir(cmRoot, { recursive: true });
    await fs.promises.copyFile(
      path.join(fixture, 'NestedModule.xml'),
      path.join(cmRoot, 'SrcMod.xml')
    );
    await fs.promises.cp(path.join(fixture, 'Ext'), path.join(cmRoot, 'SrcMod', 'Ext'), { recursive: true });
    let content = await fs.promises.readFile(path.join(cmRoot, 'SrcMod.xml'), 'utf-8');
    content = content.replace(/<Name>NestedModule<\/Name>/g, '<Name>SrcMod</Name>');
    await fs.promises.writeFile(path.join(cmRoot, 'SrcMod.xml'), content, 'utf-8');
    const cmType: TreeNode = {
      id: 'CommonModules',
      name: 'CommonModules',
      type: MetadataType.CommonModule,
      filePath: cmRoot,
      parent: configNode,
      properties: { type: 'CommonModules' },
      children: [],
    };
    const node: TreeNode = {
      id: 'CommonModules.SrcMod',
      name: 'SrcMod',
      type: MetadataType.CommonModule,
      filePath: path.join(cmRoot, 'SrcMod.xml'),
      parent: cmType,
      properties: {},
    };
    await duplicateElement(node, 'DupMod');
    const bsl = path.join(cmRoot, 'DupMod', 'Ext', 'Module', 'Module.bsl');
    assert.ok(await fileExists(bsl));
    const body = await fs.promises.readFile(bsl, 'utf-8');
    assert.ok(body.includes('nested'));
  });

  test('renameElement moves CommonModule directory with nested Ext', async () => {
    const fixture = path.join(__dirname, '../fixtures/designer-config/CommonModules/NestedModule');
    const cmRoot = path.join(tmpDir, 'CommonModules');
    await fs.promises.mkdir(cmRoot, { recursive: true });
    await fs.promises.copyFile(
      path.join(fixture, 'NestedModule.xml'),
      path.join(cmRoot, 'SrcMod.xml')
    );
    await fs.promises.cp(path.join(fixture, 'Ext'), path.join(cmRoot, 'SrcMod', 'Ext'), { recursive: true });
    let content = await fs.promises.readFile(path.join(cmRoot, 'SrcMod.xml'), 'utf-8');
    content = content.replace(/<Name>NestedModule<\/Name>/g, '<Name>SrcMod</Name>');
    await fs.promises.writeFile(path.join(cmRoot, 'SrcMod.xml'), content, 'utf-8');
    await addRootObjectToConfiguration(tmpDir, 'CommonModule', 'SrcMod');
    const cmType: TreeNode = {
      id: 'CommonModules',
      name: 'CommonModules',
      type: MetadataType.CommonModule,
      filePath: cmRoot,
      parent: configNode,
      properties: { type: 'CommonModules' },
      children: [],
    };
    const node: TreeNode = {
      id: 'CommonModules.SrcMod',
      name: 'SrcMod',
      type: MetadataType.CommonModule,
      filePath: path.join(cmRoot, 'SrcMod.xml'),
      parent: cmType,
      properties: {},
    };
    await renameElement(node, 'RenamedMod', tmpDir);
    assert.ok(await fileExists(path.join(cmRoot, 'RenamedMod', 'Ext', 'Module', 'Module.bsl')));
  });

  // ---------------------------------------------------------------------------
  // Validation errors — name
  // ---------------------------------------------------------------------------

  test('createElement throws on empty name', async () => {
    await assert.rejects(
      async () => createElement(catalogsTypeNode, '   '),
      /пустым/
    );
  });

  test('createElement throws when name starts with digit', async () => {
    await assert.rejects(
      async () => createElement(catalogsTypeNode, '1BadName'),
      /цифры/
    );
  });

  test('createElement throws when name contains invalid characters', async () => {
    await assert.rejects(
      async () => createElement(catalogsTypeNode, 'Bad-Name!'),
      /буквы, цифры и подчёркивание/
    );
  });

  test('createElement throws when name is a reserved 1C keyword', async () => {
    await assert.rejects(
      async () => createElement(catalogsTypeNode, 'Если'),
      /зарезервированным/
    );
  });

  // ---------------------------------------------------------------------------
  // createElement — unrecognized parent (no matching case)
  // ---------------------------------------------------------------------------

  test('createElement throws on unrecognized parent type', async () => {
    // A node that is not Configuration, not Forms, not a type folder,
    // not a TOP_LEVEL_TYPES instance, not an Attribute/TabularSection container.
    const orphan: TreeNode = {
      id: 'Orphan',
      name: 'Orphan',
      type: MetadataType.Unknown,
      properties: {},
      parent: configNode,
      children: [],
    };
    await assert.rejects(
      async () => createElement(orphan, 'SomeName'),
      /Создание элемента/
    );
  });

  // ---------------------------------------------------------------------------
  // duplicateElement — error paths
  // ---------------------------------------------------------------------------

  test('duplicateElement throws when node is Configuration', async () => {
    await assert.rejects(
      async () => duplicateElement(configNode, 'Copy'),
      /дублировать корень/
    );
  });

  test('duplicateElement throws when target name already exists (duplicate sibling)', async () => {
    // catalogsTypeNode has child ExistingCatalog
    catalogsTypeNode.children = [catalogNode];
    await assert.rejects(
      async () => duplicateElement(catalogNode, 'ExistingCatalog'),
      /уже существует/
    );
  });

  test('duplicateElement throws when source file does not exist', async () => {
    const missingNode: TreeNode = {
      id: 'Catalogs.Ghost',
      name: 'Ghost',
      type: MetadataType.Catalog,
      properties: {},
      filePath: path.join(tmpDir, 'Catalogs', 'Ghost.xml'), // not on disk
      parent: catalogsTypeNode,
      children: [],
    };
    await assert.rejects(
      async () => duplicateElement(missingNode, 'GhostCopy'),
      /не найден/
    );
  });

  // ---------------------------------------------------------------------------
  // deleteElement — error paths
  // ---------------------------------------------------------------------------

  test('deleteElement throws when node has no parent', async () => {
    const noParent: TreeNode = {
      id: 'Catalogs.Orphan',
      name: 'Orphan',
      type: MetadataType.Catalog,
      properties: {},
      filePath: catalogPath,
    };
    await assert.rejects(
      async () => deleteElement(noParent),
      /родительского/
    );
  });

  test('deleteElement throws when filePath is absent', async () => {
    const noFile: TreeNode = {
      id: 'Catalogs.NoFile',
      name: 'NoFile',
      type: MetadataType.Catalog,
      properties: {},
      parent: catalogsTypeNode,
    };
    await assert.rejects(
      async () => deleteElement(noFile),
      /не найден/
    );
  });

  test('deleteElement throws when top-level element file is missing on disk', async () => {
    const ghostNode: TreeNode = {
      id: 'Catalogs.Ghost',
      name: 'Ghost',
      type: MetadataType.Catalog,
      properties: {},
      filePath: path.join(tmpDir, 'Catalogs', 'Ghost.xml'), // does not exist
      parent: catalogsTypeNode,
      children: [],
    };
    await assert.rejects(
      async () => deleteElement(ghostNode),
      /не найден/
    );
  });

  test('deleteElement throws for unsupported type (Unknown)', async () => {
    const unknownNode: TreeNode = {
      id: 'WeirdNode',
      name: 'WeirdNode',
      type: MetadataType.Unknown,
      properties: {},
      filePath: catalogPath,
      parent: catalogsTypeNode,
      children: [],
    };
    await assert.rejects(
      async () => deleteElement(unknownNode),
      /не поддерживается/
    );
  });

  // ---------------------------------------------------------------------------
  // renameElement — error paths
  // ---------------------------------------------------------------------------

  test('renameElement throws when node is Configuration', async () => {
    await assert.rejects(
      async () => renameElement(configNode, 'NewName', tmpDir),
      /переименовать корень/
    );
  });

  test('renameElement throws when node has no parent', async () => {
    const noParent: TreeNode = {
      id: 'Catalogs.Orphan',
      name: 'Orphan',
      type: MetadataType.Catalog,
      properties: {},
      filePath: catalogPath,
    };
    await assert.rejects(
      async () => renameElement(noParent, 'NewName', tmpDir),
      /родительского/
    );
  });

  test('renameElement throws when target name already exists as sibling', async () => {
    // Add a second child to simulate sibling collision
    const secondCatalog = createCatalogNode('SecondCatalog', catalogsTypeNode,
      path.join(tmpDir, 'Catalogs', 'SecondCatalog.xml'));
    catalogsTypeNode.children = [catalogNode, secondCatalog];
    catalogNode.parent = catalogsTypeNode;

    await assert.rejects(
      async () => renameElement(catalogNode, 'SecondCatalog', tmpDir),
      /уже существует/
    );
  });

  test('renameElement throws when file is missing on disk', async () => {
    const ghostNode: TreeNode = {
      id: 'Catalogs.Ghost',
      name: 'Ghost',
      type: MetadataType.Catalog,
      properties: {},
      filePath: path.join(tmpDir, 'Catalogs', 'Ghost.xml'), // not on disk
      parent: catalogsTypeNode,
      children: [],
    };
    await assert.rejects(
      async () => renameElement(ghostNode, 'GhostRenamed', tmpDir),
      /не найден/
    );
  });

  // ---------------------------------------------------------------------------
  // createForm — validation edge cases
  // ---------------------------------------------------------------------------

  test('createForm throws on empty form name', async () => {
    const formsPath = path.join(tmpDir, 'Catalogs', 'ExistingCatalog', 'Forms');
    await fs.promises.mkdir(formsPath, { recursive: true });
    const formsNode = createFormsNode(catalogNode, formsPath);
    await assert.rejects(
      async () => createForm(formsNode, '   '),
      /пустым/
    );
  });

  test('createForm throws when form name already exists', async () => {
    const formsPath = path.join(tmpDir, 'Catalogs', 'ExistingCatalog', 'Forms');
    await fs.promises.mkdir(formsPath, { recursive: true });
    const formsNode = createFormsNode(catalogNode, formsPath);
    await createForm(formsNode, 'UniqueForm');
    // Second call with same name should fail
    formsNode.children = [
      { id: 'Forms.UniqueForm', name: 'UniqueForm', type: MetadataType.Form, properties: {} }
    ];
    await assert.rejects(
      async () => createForm(formsNode, 'UniqueForm'),
      /уже существует/
    );
  });

  test('createForm throws when formsNode has no filePath', async () => {
    const formsNode: TreeNode = {
      id: 'Forms',
      name: 'Forms',
      type: MetadataType.Form,
      properties: {},
      parent: catalogNode,
      children: [],
      // filePath intentionally absent
    };
    await assert.rejects(
      async () => createForm(formsNode, 'MyForm'),
      /не задан путь/
    );
  });

  // ---------------------------------------------------------------------------
  // findTabularSectionInstanceForAttributeParent — exported utility
  // ---------------------------------------------------------------------------
  // R6: EnumValue / Dimension / Resource / PredefinedItem (issue #77)
  // ---------------------------------------------------------------------------

  test('createElement adds EnumValue under EnumValues folder', async () => {
    const dir = await createTempDir('1cviewer-enumvalue-');
    try {
      const enumsDir = path.join(dir, 'Enums');
      await fs.promises.mkdir(enumsDir, { recursive: true });
      const enumPath = path.join(enumsDir, 'TestEnum.xml');
      await XMLWriter.createMinimalElementFile(enumPath, 'Enum', 'TestEnum', '2.20');
      const enumNode: TreeNode = {
        id: 'Enums.TestEnum',
        name: 'TestEnum',
        type: MetadataType.Enum,
        filePath: enumPath,
        properties: {},
        parent: undefined,
        children: [],
      };
      const enumValuesFolder: TreeNode = {
        id: 'EnumValues',
        name: 'Значения',
        type: MetadataType.EnumValue,
        parent: enumNode,
        properties: {},
        children: [],
      };
      enumNode.children = [enumValuesFolder];
      enumValuesFolder.parent = enumNode;

      await createElement(enumValuesFolder, 'NewEnumMember');
      const xml = await readFileContent(enumPath);
      assert.ok(xml.includes('EnumValue'), 'EnumValue block expected');
      assert.ok(xml.includes('<Name>NewEnumMember</Name>'), 'Name expected');
    } finally {
      await cleanupTempDir(dir);
    }
  });

  test('createElement adds Dimension under Dimensions folder (InformationRegister)', async () => {
    const dir = await createTempDir('1cviewer-dimension-');
    try {
      const regsDir = path.join(dir, 'InformationRegisters');
      await fs.promises.mkdir(regsDir, { recursive: true });
      const regPath = path.join(regsDir, 'TestIR.xml');
      await XMLWriter.createMinimalElementFile(regPath, 'InformationRegister', 'TestIR', '2.17');
      const regNode: TreeNode = {
        id: 'InformationRegisters.TestIR',
        name: 'TestIR',
        type: MetadataType.InformationRegister,
        filePath: regPath,
        properties: {},
        parent: undefined,
        children: [],
      };
      const dimsFolder: TreeNode = {
        id: 'Dimensions',
        name: 'Измерения',
        type: MetadataType.Dimension,
        parent: regNode,
        properties: {},
        children: [],
      };
      regNode.children = [dimsFolder];
      dimsFolder.parent = regNode;

      await createElement(dimsFolder, 'DimOne');
      const xml = await readFileContent(regPath);
      assert.ok(xml.includes('<Dimension'), 'Dimension block expected');
      assert.ok(xml.includes('<Name>DimOne</Name>'), 'Dimension name expected');
      assert.ok(xml.includes('<Master>true</Master>'), 'First dimension is master');
      assert.ok(!xml.includes('TypeReductionMode'), '2.17 must not emit TypeReductionMode');
    } finally {
      await cleanupTempDir(dir);
    }
  });

  test('createElement adds Resource under Resources folder (AccumulationRegister)', async () => {
    const dir = await createTempDir('1cviewer-resource-');
    try {
      const regsDir = path.join(dir, 'AccumulationRegisters');
      await fs.promises.mkdir(regsDir, { recursive: true });
      const regPath = path.join(regsDir, 'TestAR.xml');
      await XMLWriter.createMinimalElementFile(regPath, 'AccumulationRegister', 'TestAR', '2.20');
      const regNode: TreeNode = {
        id: 'AccumulationRegisters.TestAR',
        name: 'TestAR',
        type: MetadataType.AccumulationRegister,
        filePath: regPath,
        properties: {},
        parent: undefined,
        children: [],
      };
      const resFolder: TreeNode = {
        id: 'Resources',
        name: 'Ресурсы',
        type: MetadataType.Resource,
        parent: regNode,
        properties: {},
        children: [],
      };
      regNode.children = [resFolder];
      resFolder.parent = regNode;

      await createElement(resFolder, 'ResOne');
      const xml = await readFileContent(regPath);
      assert.ok(xml.includes('<Resource'), 'Resource block expected');
      assert.ok(xml.includes('<Name>ResOne</Name>'), 'Resource name expected');
    } finally {
      await cleanupTempDir(dir);
    }
  });

  test('createElement creates Predefined.xml with Item under PredefinedData (Catalog)', async () => {
    const dir = await createTempDir('1cviewer-predef-');
    try {
      await writeConfigurationWithFormat(dir);
      const catalogsDir = path.join(dir, 'Catalogs');
      await fs.promises.mkdir(path.join(catalogsDir, 'Cat1'), { recursive: true });
      const catPath = path.join(catalogsDir, 'Cat1.xml');
      await XMLWriter.createMinimalElementFile(catPath, 'Catalog', 'Cat1', '2.20');
      const predefinedPath = path.join(catalogsDir, 'Cat1', 'Ext', 'Predefined.xml');
      const catNode: TreeNode = {
        id: 'Catalogs.Cat1',
        name: 'Cat1',
        type: MetadataType.Catalog,
        filePath: catPath,
        properties: {},
        parent: undefined,
        children: [],
      };
      const predefFolder: TreeNode = {
        id: 'PredefinedData',
        name: 'Предопределённые',
        type: MetadataType.PredefinedItem,
        filePath: predefinedPath,
        parent: catNode,
        properties: {},
        children: [],
      };
      catNode.children = [predefFolder];
      predefFolder.parent = catNode;

      await createElement(predefFolder, 'PredefinedOne');
      assert.ok(fileExists(predefinedPath), 'Predefined.xml should be created');
      const xml = await readFileContent(predefinedPath);
      assert.ok(xml.includes('CatalogPredefinedItems'), 'xsi type');
      assert.ok(xml.includes('<Name>PredefinedOne</Name>'));
    } finally {
      await cleanupTempDir(dir);
    }
  });

  test('createElement creates Predefined.xml when PredefinedData filePath set via ensureR6Placeholders (no Ext dir)', async () => {
    const dir = await createTempDir('1cviewer-predef-r6-');
    try {
      await writeConfigurationWithFormat(dir);
      const catalogsDir = path.join(dir, 'Catalogs');
      await fs.promises.mkdir(path.join(catalogsDir, 'Товары'), { recursive: true });
      const catPath = path.join(catalogsDir, 'Товары', 'Товары.xml');
      await XMLWriter.createMinimalElementFile(catPath, 'Catalog', 'Товары', '2.20');

      const catalogsFolder: TreeNode = {
        id: 'Catalogs',
        name: 'Справочники',
        type: MetadataType.Catalog,
        filePath: catalogsDir,
        properties: {},
        children: [],
      };
      const configRoot: TreeNode = {
        id: 'root',
        name: 'Configuration',
        type: MetadataType.Configuration,
        properties: {},
        children: [catalogsFolder],
      };
      catalogsFolder.parent = configRoot;

      const catalogNode: TreeNode = {
        id: 'Catalogs.Товары',
        name: 'Товары',
        type: MetadataType.Catalog,
        filePath: catPath,
        properties: {},
        children: [],
        parent: catalogsFolder,
      };
      catalogsFolder.children!.push(catalogNode);

      const ctx: NormalizeContext = { configPath: dir, format: ConfigFormat.Designer };
      ensureR6PlaceholdersForInstanceNode(catalogNode, ctx);

      const predefNode = catalogNode.children!.find((c) => c.id === 'PredefinedData');
      assert.ok(predefNode, 'PredefinedData placeholder must exist after ensureR6PlaceholdersForInstanceNode');
      assert.ok(predefNode!.filePath, 'PredefinedData must have filePath');

      const predefinedPath = path.join(catalogsDir, 'Товары', 'Ext', 'Predefined.xml');
      assert.ok(!fileExists(predefinedPath), 'Predefined.xml must NOT exist before createElement');

      await createElement(predefNode!, 'Test1');

      assert.ok(fileExists(predefinedPath), 'Predefined.xml should be created by createElement');
      const xml = await readFileContent(predefinedPath);
      assert.ok(xml.includes('CatalogPredefinedItems'), 'xsi type expected');
      assert.ok(xml.includes('<Name>Test1</Name>'), 'Item name expected');
    } finally {
      await cleanupTempDir(dir);
    }
  });

  test('createElement emits TypeReductionMode for InformationRegister Dimension from 2.18', async () => {
    const dir = await createTempDir('1cviewer-dimension-218-');
    try {
      const regsDir = path.join(dir, 'InformationRegisters');
      await fs.promises.mkdir(regsDir, { recursive: true });
      const regPath = path.join(regsDir, 'TestIR.xml');
      await XMLWriter.createMinimalElementFile(regPath, 'InformationRegister', 'TestIR', '2.18');
      const regNode: TreeNode = {
        id: 'InformationRegisters.TestIR', name: 'TestIR', type: MetadataType.InformationRegister,
        filePath: regPath, properties: {}, children: [],
      };
      const dimensions: TreeNode = {
        id: 'Dimensions', name: 'Dimensions', type: MetadataType.Dimension,
        parent: regNode, properties: {}, children: [],
      };
      regNode.children = [dimensions];

      await createElement(dimensions, 'Dim218');

      assert.ok((await readFileContent(regPath)).includes('<TypeReductionMode>TransformValues</TypeReductionMode>'));
    } finally {
      await cleanupTempDir(dir);
    }
  });

  for (const version of ['2.17', '2.21']) {
    test(`createElement creates Predefined.xml with project profile ${version}`, async () => {
      const dir = await createTempDir('1cviewer-predef-profile-');
      try {
        await writeConfigurationWithFormat(dir, version);
        const catalogsDir = path.join(dir, 'Catalogs');
        await fs.promises.mkdir(catalogsDir, { recursive: true });
        const catalogPath = path.join(catalogsDir, 'Cat.xml');
        await XMLWriter.createMinimalElementFile(catalogPath, 'Catalog', 'Cat', version);
        const predefinedPath = path.join(catalogsDir, 'Cat', 'Ext', 'Predefined.xml');
        const catalog: TreeNode = {
          id: 'Catalogs.Cat', name: 'Cat', type: MetadataType.Catalog,
          filePath: catalogPath, properties: {}, children: [],
        };
        const predefinedFolder: TreeNode = {
          id: 'PredefinedData', name: 'PredefinedData', type: MetadataType.PredefinedItem,
          filePath: predefinedPath, properties: {}, parent: catalog, children: [],
        };
        catalog.children = [predefinedFolder];

        await createElement(predefinedFolder, 'Item');

        assert.ok((await readFileContent(predefinedPath)).includes(`version="${version}"`));
      } finally {
        await cleanupTempDir(dir);
      }
    });
  }

  for (const scenario of [
    {
      label: 'EnumValue', ownerType: MetadataType.Enum, ownerTag: 'Enum',
      ownerFolder: 'Enums', containerId: 'EnumValues', childType: MetadataType.EnumValue,
    },
    {
      label: 'Dimension', ownerType: MetadataType.InformationRegister, ownerTag: 'InformationRegister',
      ownerFolder: 'InformationRegisters', containerId: 'Dimensions', childType: MetadataType.Dimension,
    },
    {
      label: 'Resource', ownerType: MetadataType.AccumulationRegister, ownerTag: 'AccumulationRegister',
      ownerFolder: 'AccumulationRegisters', containerId: 'Resources', childType: MetadataType.Resource,
    },
  ] as const) {
    test(`deleteElement removes only the named ${scenario.label} from owner XML`, async () => {
      const dir = await createTempDir(`1cviewer-delete-${scenario.label.toLowerCase()}-`);
      try {
        const ownerDir = path.join(dir, scenario.ownerFolder);
        await fs.promises.mkdir(ownerDir, { recursive: true });
        const ownerPath = path.join(ownerDir, 'Owner.xml');
        await XMLWriter.createMinimalElementFile(ownerPath, scenario.ownerTag, 'Owner', '2.20');
        const owner: TreeNode = {
          id: `${scenario.ownerFolder}.Owner`, name: 'Owner', type: scenario.ownerType,
          filePath: ownerPath, properties: {}, children: [],
        };
        const container: TreeNode = {
          id: scenario.containerId, name: scenario.containerId, type: scenario.childType,
          parent: owner, parentFilePath: ownerPath, properties: {}, children: [],
        };
        owner.children = [container];

        await createElement(container, 'KeepMe');
        await createElement(container, 'DeleteMe');
        await deleteElement(
          {
            id: `${owner.id}.${scenario.containerId}.DeleteMe`,
            name: 'DeleteMe', type: scenario.childType, parent: container,
            parentFilePath: ownerPath, properties: {},
          },
          { trustedRootPath: dir }
        );

        const xml = await readFileContent(ownerPath);
        assert.ok(xml.includes('<Name>KeepMe</Name>'), 'sibling must be preserved');
        assert.ok(!xml.includes('<Name>DeleteMe</Name>'), 'target must be removed');
      } finally {
        await cleanupTempDir(dir);
      }
    });
  }

  for (const scenario of [
    { ownerType: MetadataType.Enum, ownerTag: 'Enum', containerId: 'EnumValues', childType: MetadataType.EnumValue },
    { ownerType: MetadataType.InformationRegister, ownerTag: 'InformationRegister', containerId: 'Dimensions', childType: MetadataType.Dimension },
    { ownerType: MetadataType.AccumulationRegister, ownerTag: 'AccumulationRegister', containerId: 'Resources', childType: MetadataType.Resource },
  ] as const) {
    test(`deleteElement rejects external ${String(scenario.childType)} owner against trusted root`, async () => {
      const dir = await createTempDir('1cviewer-delete-r6-external-');
      try {
        const trustedRoot = path.join(dir, 'trusted');
        const externalRoot = path.join(dir, 'external');
        await fs.promises.mkdir(trustedRoot, { recursive: true });
        await fs.promises.mkdir(externalRoot, { recursive: true });
        const ownerPath = path.join(externalRoot, 'Owner.xml');
        await XMLWriter.createMinimalElementFile(ownerPath, scenario.ownerTag, 'Owner', '2.20');
        const owner: TreeNode = {
          id: 'External.Owner', name: 'Owner', type: scenario.ownerType,
          filePath: ownerPath, properties: {}, children: [],
        };
        const container: TreeNode = {
          id: scenario.containerId, name: scenario.containerId, type: scenario.childType,
          parent: owner, parentFilePath: ownerPath, properties: {}, children: [],
        };
        owner.children = [container];
        await createElement(container, 'DeleteMe');
        const before = await readFileContent(ownerPath);

        await assert.rejects(() => deleteElement({
          id: `External.Owner.${scenario.containerId}.DeleteMe`, name: 'DeleteMe',
          type: scenario.childType, parent: container, parentFilePath: ownerPath, properties: {},
        }, { trustedRootPath: trustedRoot }), (error: unknown) =>
          !!error && typeof error === 'object'
          && (error as { code?: string }).code === 'PATH_OUTSIDE_ROOT');
        assert.strictEqual(await readFileContent(ownerPath), before);
      } finally {
        await cleanupTempDir(dir);
      }
    });
  }

  test('deleteElement removes one PredefinedItem and preserves siblings and namespaces', async () => {
    const dir = await createTempDir('1cviewer-delete-predefined-');
    try {
      await writeConfigurationWithFormat(dir);
      const catalogsDir = path.join(dir, 'Catalogs');
      await fs.promises.mkdir(catalogsDir, { recursive: true });
      const ownerPath = path.join(catalogsDir, 'Owner.xml');
      await XMLWriter.createMinimalElementFile(ownerPath, 'Catalog', 'Owner', '2.20');
      const predefinedPath = path.join(catalogsDir, 'Owner', 'Ext', 'Predefined.xml');
      const owner: TreeNode = {
        id: 'Catalogs.Owner', name: 'Owner', type: MetadataType.Catalog,
        filePath: ownerPath, properties: {}, children: [],
      };
      const container: TreeNode = {
        id: 'PredefinedData', name: 'PredefinedData', type: MetadataType.PredefinedItem,
        filePath: predefinedPath, parent: owner, properties: {}, children: [],
      };
      owner.children = [container];
      await createElement(container, 'KeepMe');
      await createElement(container, 'DeleteMe');

      await deleteElement(
        {
          id: 'Catalogs.Owner.PredefinedData.DeleteMe', name: 'DeleteMe',
          type: MetadataType.PredefinedItem, parent: container,
          parentFilePath: predefinedPath, properties: {},
        },
        { trustedRootPath: dir }
      );

      const xml = await readFileContent(predefinedPath);
      assert.ok(xml.includes('<Name>KeepMe</Name>'), 'sibling must be preserved');
      assert.ok(!xml.includes('<Name>DeleteMe</Name>'), 'target must be removed');
      assert.ok(xml.includes('xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'));
      assert.ok(xml.includes('xsi:type="CatalogPredefinedItems"'));
    } finally {
      await cleanupTempDir(dir);
    }
  });

  test('deleteElement rejects a consistent external Predefined owner against trusted root', async () => {
    const dir = await createTempDir('1cviewer-delete-predefined-outside-');
    try {
      const trustedRoot = path.join(dir, 'trusted');
      const externalRoot = path.join(dir, 'external');
      const catalogsDir = path.join(externalRoot, 'Catalogs');
      await fs.promises.mkdir(trustedRoot, { recursive: true });
      await fs.promises.mkdir(catalogsDir, { recursive: true });
      const ownerPath = path.join(catalogsDir, 'Owner.xml');
      await XMLWriter.createMinimalElementFile(ownerPath, 'Catalog', 'Owner', '2.20');
      const externalPath = path.join(catalogsDir, 'Owner', 'Ext', 'Predefined.xml');
      const externalXml = `<?xml version="1.0" encoding="UTF-8"?>
<PredefinedData xmlns="http://v8.1c.ru/8.3/xcf/predef" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CatalogPredefinedItems">
  <Item id="00000000-0000-0000-0000-000000000001"><Name>DeleteMe</Name></Item>
</PredefinedData>
`;
      await fs.promises.mkdir(path.dirname(externalPath), { recursive: true });
      await fs.promises.writeFile(externalPath, externalXml, 'utf-8');
      const owner: TreeNode = {
        id: 'Catalogs.Owner', name: 'Owner', type: MetadataType.Catalog,
        filePath: ownerPath, properties: {}, children: [],
      };
      const container: TreeNode = {
        id: 'PredefinedData', name: 'PredefinedData', type: MetadataType.PredefinedItem,
        filePath: externalPath, parent: owner, properties: {}, children: [],
      };
      owner.children = [container];

      await assert.rejects(() => deleteElement({
        id: 'Catalogs.Owner.PredefinedData.DeleteMe', name: 'DeleteMe',
        type: MetadataType.PredefinedItem, parent: container,
        parentFilePath: externalPath, properties: {},
      }, { trustedRootPath: trustedRoot }), (error: unknown) =>
        !!error && typeof error === 'object'
        && (error as { code?: string }).code === 'PATH_OUTSIDE_ROOT');
      assert.strictEqual(await readFileContent(externalPath), externalXml);
    } finally {
      await cleanupTempDir(dir);
    }
  });

  test('deleteElement rejects a missing R6 target without rewriting owner XML', async () => {
    const dir = await createTempDir('1cviewer-delete-r6-missing-');
    try {
      const enumPath = path.join(dir, 'Owner.xml');
      await XMLWriter.createMinimalElementFile(enumPath, 'Enum', 'Owner', '2.20');
      const owner: TreeNode = {
        id: 'Enums.Owner', name: 'Owner', type: MetadataType.Enum,
        filePath: enumPath, properties: {}, children: [],
      };
      const container: TreeNode = {
        id: 'EnumValues', name: 'EnumValues', type: MetadataType.EnumValue,
        parent: owner, parentFilePath: enumPath, properties: {}, children: [],
      };
      owner.children = [container];
      const before = await readFileContent(enumPath);

      await assert.rejects(() => deleteElement({
        id: 'Enums.Owner.EnumValues.Missing', name: 'Missing',
        type: MetadataType.EnumValue, parent: container,
        parentFilePath: enumPath, properties: {},
      }, { trustedRootPath: dir }), /was not found/);
      assert.strictEqual(await readFileContent(enumPath), before);
    } finally {
      await cleanupTempDir(dir);
    }
  });

  test('deleteElement requires trusted root for R6 before touching owner path', async () => {
    const missingOwnerPath = path.join(tmpDir, 'missing', 'Owner.xml');
    const owner: TreeNode = {
      id: 'Enums.Owner', name: 'Owner', type: MetadataType.Enum,
      filePath: missingOwnerPath, properties: {}, children: [],
    };
    const container: TreeNode = {
      id: 'EnumValues', name: 'EnumValues', type: MetadataType.EnumValue,
      parent: owner, parentFilePath: missingOwnerPath, properties: {}, children: [],
    };
    owner.children = [container];
    await assert.rejects(() => deleteElement({
      id: 'Enums.Owner.EnumValues.DeleteMe', name: 'DeleteMe',
      type: MetadataType.EnumValue, parent: container,
      parentFilePath: missingOwnerPath, properties: {},
    }), /доверенный корень конфигурации/);
  });

  test('deleteElement rejects R6 owner reached through symlink or junction escape', async function () {
    const dir = await createTempDir('1cviewer-delete-r6-link-');
    try {
      const trustedRoot = path.join(dir, 'trusted');
      const externalEnums = path.join(dir, 'external-enums');
      const linkedEnums = path.join(trustedRoot, 'Enums');
      await fs.promises.mkdir(trustedRoot, { recursive: true });
      await fs.promises.mkdir(externalEnums, { recursive: true });
      const externalOwnerPath = path.join(externalEnums, 'Owner.xml');
      await XMLWriter.createMinimalElementFile(externalOwnerPath, 'Enum', 'Owner', '2.20');
      const externalOwner: TreeNode = {
        id: 'Enums.Owner', name: 'Owner', type: MetadataType.Enum,
        filePath: externalOwnerPath, properties: {}, children: [],
      };
      const externalContainer: TreeNode = {
        id: 'EnumValues', name: 'EnumValues', type: MetadataType.EnumValue,
        parent: externalOwner, parentFilePath: externalOwnerPath, properties: {}, children: [],
      };
      externalOwner.children = [externalContainer];
      await createElement(externalContainer, 'DeleteMe');
      const before = await readFileContent(externalOwnerPath);
      try {
        await fs.promises.symlink(
          externalEnums,
          linkedEnums,
          process.platform === 'win32' ? 'junction' : 'dir'
        );
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') {
          this.skip();
          return;
        }
        throw error;
      }
      const linkedOwnerPath = path.join(linkedEnums, 'Owner.xml');
      const linkedOwner: TreeNode = {
        ...externalOwner, filePath: linkedOwnerPath, children: [],
      };
      const linkedContainer: TreeNode = {
        ...externalContainer, parent: linkedOwner, parentFilePath: linkedOwnerPath, children: [],
      };
      linkedOwner.children = [linkedContainer];

      await assert.rejects(() => deleteElement({
        id: 'Enums.Owner.EnumValues.DeleteMe', name: 'DeleteMe',
        type: MetadataType.EnumValue, parent: linkedContainer,
        parentFilePath: linkedOwnerPath, properties: {},
      }, { trustedRootPath: trustedRoot }), (error: unknown) =>
        !!error && typeof error === 'object'
        && (error as { code?: string }).code === 'PATH_OUTSIDE_ROOT');
      assert.strictEqual(await readFileContent(externalOwnerPath), before);
    } finally {
      await cleanupTempDir(dir);
    }
  });

  // ---------------------------------------------------------------------------

  test('findTabularSectionInstanceForAttributeParent returns section for columns container', async () => {
    const { findTabularSectionInstanceForAttributeParent } = await import('../../src/services/elementOperations');

    const sectionNode: TreeNode = {
      id: 'TabularSections.Items',
      name: 'Items',
      type: MetadataType.TabularSection,
      properties: {},
      parent: catalogsTypeNode,
      children: [],
    };
    const columnsContainer: TreeNode = {
      id: 'TabularSections.Items.Attributes',
      name: 'Реквизиты',
      type: MetadataType.Attribute,
      properties: { type: 'TabularSectionColumns' },
      parent: sectionNode,
      children: [],
    };
    const result = findTabularSectionInstanceForAttributeParent(columnsContainer);
    assert.strictEqual(result, sectionNode);
  });

  test('findTabularSectionInstanceForAttributeParent returns section when parent is TabularSection instance under TabularSections folder', async () => {
    const { findTabularSectionInstanceForAttributeParent } = await import('../../src/services/elementOperations');

    const tsFolder: TreeNode = {
      id: 'TabularSections',
      name: 'TabularSections',
      type: MetadataType.Unknown,
      properties: {},
      children: [],
    };
    const sectionNode: TreeNode = {
      id: 'TabularSections.Items',
      name: 'Items',
      type: MetadataType.TabularSection,
      properties: {},
      parent: tsFolder,
      children: [],
    };
    // parent of attribute = the section instance itself
    const result = findTabularSectionInstanceForAttributeParent(sectionNode);
    assert.strictEqual(result, sectionNode);
  });

  test('findTabularSectionInstanceForAttributeParent returns undefined for regular catalog node', async () => {
    const { findTabularSectionInstanceForAttributeParent } = await import('../../src/services/elementOperations');

    const result = findTabularSectionInstanceForAttributeParent(catalogNode);
    assert.strictEqual(result, undefined);
  });

  test('createElement rejects nested attribute on Subsystem instance (no ChildObjects)', async () => {
    const subsystemsDir = path.join(tmpDir, 'Subsystems');
    await fs.promises.mkdir(subsystemsDir, { recursive: true });
    const subsystemXml = path.join(subsystemsDir, 'ПодсистемаТест.xml');
    await XMLWriter.createMinimalElementFile(subsystemXml, 'Subsystem', 'ПодсистемаТест', '2.20');
    const subsystemsTypeNode: TreeNode = {
      id: 'Subsystems',
      name: 'Подсистемы',
      type: MetadataType.Subsystem,
      properties: {},
      filePath: subsystemsDir,
      parent: configNode,
      children: [],
    };
    const subsystemInstance: TreeNode = {
      id: 'Subsystems.ПодсистемаТест',
      name: 'ПодсистемаТест',
      type: MetadataType.Subsystem,
      properties: {},
      filePath: subsystemXml,
      parent: subsystemsTypeNode,
      children: [],
    };
    await assert.rejects(
      async () => createElement(subsystemInstance, 'BadAttr'),
      /нет ChildObjects/
    );
  });

  test('appendPredefinedDesignerItem COT: uses boolean type from owner file', async () => {
    const { appendPredefinedDesignerItem } = await import('../../src/utils/xml/predefinedDataAppender');
    const dir = await createTempDir('1cviewer-cot-predef-');
    try {
      const cotXml = path.join(dir, 'COT.xml');
      const cotContent = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core" version="2.20">
  <ChartOfCharacteristicTypes uuid="test-uuid">
    <Properties>
      <Name>TestCOT</Name>
      <Type>
        <v8:Type>xs:boolean</v8:Type>
      </Type>
    </Properties>
    <ChildObjects/>
  </ChartOfCharacteristicTypes>
</MetaDataObject>`;
      await fs.promises.writeFile(cotXml, cotContent, 'utf-8');
      const predefinedPath = path.join(dir, 'Ext', 'Predefined.xml');
      await appendPredefinedDesignerItem(predefinedPath, MetadataType.ChartOfCharacteristicTypes, 'ВидТест', 'ВидТест', cotXml, '2.20');
      const xml = await readFileContent(predefinedPath);
      assert.ok(xml.includes('xs:boolean'), 'Item Type must reflect COT owner Type (xs:boolean)');
      assert.ok(!xml.includes('xs:string'), 'Should not fall back to xs:string when owner has xs:boolean');
    } finally {
      await cleanupTempDir(dir);
    }
  });

  test('appendPredefinedDesignerItem COT: fallback to xs:string when no owner file', async () => {
    const { appendPredefinedDesignerItem } = await import('../../src/utils/xml/predefinedDataAppender');
    const dir = await createTempDir('1cviewer-cot-fallback-');
    try {
      const predefinedPath = path.join(dir, 'Ext', 'Predefined.xml');
      await appendPredefinedDesignerItem(predefinedPath, MetadataType.ChartOfCharacteristicTypes, 'Fallback', 'Fallback', undefined, '2.20');
      const xml = await readFileContent(predefinedPath);
      assert.ok(xml.includes('xs:string'), 'Should use xs:string fallback when no owner file provided');
    } finally {
      await cleanupTempDir(dir);
    }
  });

  test('createElement respects project format version 2.17 (8.3.24)', async () => {
    const dir = await createTempDir('1cviewer-fmt-217-');
    try {
      const configXmlPath = path.join(dir, 'Configuration.xml');
      const configXml = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.17">
  <Configuration uuid="42bff091-dd0b-4592-a67f-70c38db7993f">
    <Properties><Name>TestConfig217</Name></Properties>
    <ChildObjects/>
  </Configuration>
</MetaDataObject>`;
      await fs.promises.writeFile(configXmlPath, configXml, 'utf-8');
      const catalogsPath = path.join(dir, 'Catalogs');
      await fs.promises.mkdir(catalogsPath, { recursive: true });
      const confNode = createConfigNode();
      const catTypeNode = createCatalogsTypeNode(confNode, catalogsPath);

      await createElement(catTypeNode, 'Product217');
      const productXmlPath = path.join(catalogsPath, 'Product217.xml');
      const productXml = await readFileContent(productXmlPath);

      assert.ok(productXml.includes('version="2.17"'), 'Generated XML must have version="2.17"');
      assert.ok(!productXml.includes('xmlns:pal'), 'Version 2.17 must not include xmlns:pal');
    } finally {
      await cleanupTempDir(dir);
    }
  });

  test('createElement respects project format version 2.21 (8.5.1)', async () => {
    const dir = await createTempDir('1cviewer-fmt-221-');
    try {
      const configXmlPath = path.join(dir, 'Configuration.xml');
      const configXml = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.21">
  <Configuration uuid="42bff091-dd0b-4592-a67f-70c38db7993f">
    <Properties><Name>TestConfig221</Name></Properties>
    <ChildObjects/>
  </Configuration>
</MetaDataObject>`;
      await fs.promises.writeFile(configXmlPath, configXml, 'utf-8');
      const catalogsPath = path.join(dir, 'Catalogs');
      await fs.promises.mkdir(catalogsPath, { recursive: true });
      const confNode = createConfigNode();
      const catTypeNode = createCatalogsTypeNode(confNode, catalogsPath);

      await createElement(catTypeNode, 'Product221');
      const productXmlPath = path.join(catalogsPath, 'Product221.xml');
      const productXml = await readFileContent(productXmlPath);

      assert.ok(productXml.includes('version="2.21"'), 'Generated XML must have version="2.21"');
      assert.ok(productXml.includes('xmlns:pal'), 'Version 2.21 must include xmlns:pal');
    } finally {
      await cleanupTempDir(dir);
    }
  });

  for (const version of ['missing', '2.16', '2.22', 'malformed']) {
    test(`createElement rejects project format ${version} before creating filesystem artifacts`, async () => {
      const dir = await createTempDir('1cviewer-fmt-reject-');
      try {
        if (version === 'missing') {
          await fs.promises.writeFile(
            path.join(dir, 'Configuration.xml'),
            '<MetaDataObject><Configuration version="2.21"/></MetaDataObject>',
            'utf8'
          );
        } else {
          const configVersion = version === 'malformed' ? '2.x' : version;
          await writeConfigurationWithFormat(dir, configVersion);
        }
        const typeFolder = path.join(dir, 'Catalogs');
        const configNode = createConfigNode();
        const catalogsNode = createCatalogsTypeNode(configNode, typeFolder);
        const configBefore = await readFileContent(path.join(dir, 'Configuration.xml'));

        await assert.rejects(
          () => createElement(catalogsNode, 'MustNotExist'),
          (error: unknown) => !!error && typeof error === 'object'
            && (error as { code?: string }).code === 'CDT_UNSUPPORTED_METADATA_WRITE_FORMAT'
        );

        assert.ok(!dirExists(typeFolder), 'type folder must not be created');
        assert.ok(!fileExists(path.join(typeFolder, 'MustNotExist.xml')));
        assert.ok(!fileExists(`${path.join(dir, 'Configuration.xml')}.bak`));
        assert.strictEqual(await readFileContent(path.join(dir, 'Configuration.xml')), configBefore);
      } finally {
        await cleanupTempDir(dir);
      }
    });
  }
});
