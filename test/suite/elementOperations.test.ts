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
    const formDir = path.join(formsPath, 'НоваяФорма');
    const formMetaPath = path.join(formDir, 'НоваяФорма.xml');
    const formXmlPath = path.join(formDir, 'Ext', 'Form.xml');
    const modulePath = path.join(formDir, 'Ext', 'Form', 'Module.bsl');
    
    assert.ok(dirExists(formDir));
    assert.ok(fileExists(formMetaPath));
    assert.ok(fileExists(formXmlPath));
    assert.ok(fileExists(modulePath));
    
    const metaContent = await readFileContent(formMetaPath);
    assert.ok(metaContent.includes('<Name>НоваяФорма</Name>'));
    const extContent = await readFileContent(formXmlPath);
    assert.ok(extContent.includes('http://v8.1c.ru/8.3/xcf/logform') && extContent.includes('<Form'));

    const ownerXml = await readFileContent(catalogPath);
    assert.ok(
      ownerXml.includes('<Form>НоваяФорма</Form>'),
      'owner metadata ChildObjects must list the new form'
    );
  });

  test('deleteElement removes form directory created by createForm', async () => {
    const formsPath = path.join(tmpDir, 'Catalogs', 'ExistingCatalog', 'Forms');
    await fs.promises.mkdir(formsPath, { recursive: true });
    const formsNode = createFormsNode(catalogNode, formsPath);
    await createForm(formsNode, 'FormToDelete');
    const formDir = path.join(formsPath, 'FormToDelete');
    const formNode: TreeNode = {
      id: 'Forms.FormToDelete',
      name: 'FormToDelete',
      type: MetadataType.Form,
      properties: {},
      children: [],
      filePath: formDir,
      parent: formsNode,
    };
    await deleteElement(formNode);
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

    const formDir = path.join(formsPath, 'ListFormRef');
    const formNode: TreeNode = {
      id: 'Forms.ListFormRef',
      name: 'ListFormRef',
      type: MetadataType.Form,
      properties: {},
      children: [],
      filePath: formDir,
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
    assert.ok(content.includes('<FillChecking>ShowError</FillChecking>'));
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
});
