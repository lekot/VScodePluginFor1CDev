import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { TreeNode } from '../../src/models/treeNode';
import {
  createElement,
  createForm,
  duplicateElement,
  deleteElement,
  renameElement,
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
  let configNode: TreeNode;
  let catalogsTypeNode: TreeNode;
  let catalogNode: TreeNode;

  setup(async () => {
    tmpDir = await createTempDir('1cviewer-el-');
    const catalogsPath = path.join(tmpDir, 'Catalogs');
    await fs.promises.mkdir(catalogsPath, { recursive: true });
    const catalogPath = path.join(catalogsPath, 'ExistingCatalog.xml');
    await XMLWriter.createMinimalElementFile(catalogPath, 'Catalog', 'ExistingCatalog');
    
    configNode = createConfigNode();
    catalogsTypeNode = createCatalogsTypeNode(configNode, catalogsPath);
    catalogNode = createCatalogNode('ExistingCatalog', catalogsTypeNode, catalogPath);
  });

  teardown(async () => {
    await cleanupTempDir(tmpDir);
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
});
