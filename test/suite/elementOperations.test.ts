import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TreeNode, MetadataType } from '../../src/models/treeNode';
import {
  createElement,
  createForm,
  duplicateElement,
  deleteElement,
  renameElement,
} from '../../src/services/elementOperations';
import { XMLWriter } from '../../src/utils/XMLWriter';

suite('elementOperations', () => {
  let tmpDir: string;
  let configNode: TreeNode;
  let catalogsTypeNode: TreeNode;
  let catalogNode: TreeNode;

  setup(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-el-'));
    const catalogsPath = path.join(tmpDir, 'Catalogs');
    await fs.promises.mkdir(catalogsPath, { recursive: true });
    const catalogPath = path.join(catalogsPath, 'ExistingCatalog.xml');
    await XMLWriter.createMinimalElementFile(catalogPath, 'Catalog', 'ExistingCatalog');
    configNode = {
      id: 'config',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
    };
    catalogsTypeNode = {
      id: 'catalogs',
      name: 'Catalogs',
      type: MetadataType.Catalog,
      properties: {},
      filePath: catalogsPath,
      parent: configNode,
    };
    catalogNode = {
      id: 'cat1',
      name: 'ExistingCatalog',
      type: MetadataType.Catalog,
      properties: {},
      filePath: catalogPath,
      parent: catalogsTypeNode,
    };
  });

  teardown(async () => {
    try {
      await fs.promises.rm(tmpDir, { recursive: true });
    } catch {
      // ignore
    }
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
    assert.ok(fs.existsSync(filePath));
    assert.ok(fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory());
    const content = await fs.promises.readFile(filePath, 'utf-8');
    assert.ok(content.includes('<Name>NewCatalog</Name>'));
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
    const formsNode: TreeNode = {
      id: 'Forms',
      name: 'Forms',
      type: MetadataType.Form,
      properties: {},
      children: [],
      filePath: formsPath,
    };
    await createForm(formsNode, 'НоваяФорма');
    const formDir = path.join(formsPath, 'НоваяФорма');
    const formMetaPath = path.join(formDir, 'НоваяФорма.xml');
    const formXmlPath = path.join(formDir, 'Ext', 'Form.xml');
    const modulePath = path.join(formDir, 'Ext', 'Form', 'Module.bsl');
    assert.ok(fs.existsSync(formDir) && fs.statSync(formDir).isDirectory());
    assert.ok(fs.existsSync(formMetaPath));
    assert.ok(fs.existsSync(formXmlPath));
    assert.ok(fs.existsSync(modulePath));
    const metaContent = await fs.promises.readFile(formMetaPath, 'utf-8');
    assert.ok(metaContent.includes('<Name>НоваяФорма</Name>'));
    const extContent = await fs.promises.readFile(formXmlPath, 'utf-8');
    assert.ok(extContent.includes('http://v8.1c.ru/8.3/xcf/logform') && extContent.includes('<Form'));
  });

  test('duplicateElement creates copy of catalog', async () => {
    await duplicateElement(catalogNode, 'CopyCatalog');
    const filePath = path.join(tmpDir, 'Catalogs', 'CopyCatalog.xml');
    assert.ok(fs.existsSync(filePath));
    const content = await fs.promises.readFile(filePath, 'utf-8');
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
    assert.ok(!fs.existsSync(catalogNode.filePath!));
    assert.ok(!fs.existsSync(elementDir));
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
});
