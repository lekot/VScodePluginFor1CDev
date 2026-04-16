import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { TreeNode, MetadataType } from '../../src/models/treeNode';
import {
  createElement,
  createForm,
  duplicateElement,
  deleteElement,
  renameElement,
  isRootObjectCreateInTypeFolder,
} from '../../src/services/elementOperations';
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
    await XMLWriter.createMinimalElementFile(catalogPath, 'Catalog', 'ExistingCatalog');
    // Configuration.xml required for createElement (addRootObjectToConfiguration)
    const configXmlPath = path.join(tmpDir, 'Configuration.xml');
    const configXml = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core">
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
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core">
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
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core">
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
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core">
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
    const formDir = path.join(formsPath, 'ListFormRef');
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
    await duplicateElement(catalogNode, 'CopyCatalog');
    const filePath = path.join(tmpDir, 'Catalogs', 'CopyCatalog.xml');
    assert.ok(fileExists(filePath));
    const content = await readFileContent(filePath);
    assert.ok(content.includes('<Name>CopyCatalog</Name>'));
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
    const elementDir = path.join(tmpDir, 'Catalogs', 'ExistingCatalog');
    await fs.promises.mkdir(elementDir, { recursive: true });
    await renameElement(catalogNode, 'RenamedCatalog', tmpDir);
    const newPath = path.join(tmpDir, 'Catalogs', 'RenamedCatalog.xml');
    const newDir = path.join(tmpDir, 'Catalogs', 'RenamedCatalog');
    assert.ok(fs.existsSync(newPath));
    assert.ok(fs.existsSync(newDir));
    assert.ok(!fs.existsSync(catalogNode.filePath!));
  });

  test('renameElement to same name does nothing', async () => {
    await renameElement(catalogNode, 'ExistingCatalog', tmpDir);
    assert.ok(fs.existsSync(catalogNode.filePath!));
  });

  test('createElement rejects nested attribute on Role instance (Designer: no ChildObjects)', async () => {
    const rolesDir = path.join(tmpDir, 'Roles');
    await fs.promises.mkdir(rolesDir, { recursive: true });
    const roleXml = path.join(rolesDir, 'R1.xml');
    await XMLWriter.createMinimalElementFile(roleXml, 'Role', 'R1');
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
      await XMLWriter.createMinimalElementFile(enumPath, 'Enum', 'TestEnum');
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
      await XMLWriter.createMinimalElementFile(regPath, 'InformationRegister', 'TestIR');
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
      await XMLWriter.createMinimalElementFile(regPath, 'AccumulationRegister', 'TestAR');
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
      const catalogsDir = path.join(dir, 'Catalogs');
      await fs.promises.mkdir(path.join(catalogsDir, 'Cat1'), { recursive: true });
      const catPath = path.join(catalogsDir, 'Cat1.xml');
      await XMLWriter.createMinimalElementFile(catPath, 'Catalog', 'Cat1');
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
});
