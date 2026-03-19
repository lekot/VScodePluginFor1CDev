import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { TreeNode, MetadataType } from '../../src/models/treeNode';
import {
  createElement,
  deleteElement,
  duplicateElement,
  renameElement,
} from '../../src/services/elementOperations';
import { XMLWriter } from '../../src/utils/XMLWriter';
import {
  createTempDir,
  cleanupTempDir,
  createConfigNode,
  fileExists,
  dirExists,
  readFileContent,
} from '../helpers/testHelpers';

suite('DataProcessor Operations', () => {
  let tmpDir: string;
  let configNode: TreeNode;
  let dataProcessorsTypeNode: TreeNode;

  setup(async () => {
    tmpDir = await createTempDir('1cviewer-dp-');
    
    // Create DataProcessors directory
    const dataProcessorsPath = path.join(tmpDir, 'DataProcessors');
    await fs.promises.mkdir(dataProcessorsPath, { recursive: true });
    
    // Create Configuration.xml required for createElement (addRootObjectToConfiguration)
    const configXmlPath = path.join(tmpDir, 'Configuration.xml');
    const configXml = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core">
  <Configuration uuid="42bff091-dd0b-4592-a67f-70c38db7993f">
    <Properties><Name>TestConfig</Name></Properties>
    <ChildObjects>
    </ChildObjects>
  </Configuration>
</MetaDataObject>
`;
    await fs.promises.writeFile(configXmlPath, configXml, 'utf-8');

    configNode = createConfigNode();
    dataProcessorsTypeNode = {
      id: 'DataProcessors',
      name: 'DataProcessors',
      type: MetadataType.DataProcessor,
      parent: configNode,
      filePath: dataProcessorsPath,
      properties: {},
      children: undefined
    };
  });

  teardown(async () => {
    await cleanupTempDir(tmpDir);
  });

  test('createElement creates new DataProcessor file and folder', async () => {
    await createElement(dataProcessorsTypeNode, 'НоваяОбработка');
    
    const filePath = path.join(tmpDir, 'DataProcessors', 'НоваяОбработка.xml');
    const dirPath = path.join(tmpDir, 'DataProcessors', 'НоваяОбработка');
    
    assert.ok(fileExists(filePath), 'DataProcessor XML file should be created');
    assert.ok(dirExists(dirPath), 'DataProcessor directory should be created');
    
    const content = await readFileContent(filePath);
    assert.ok(content.includes('<DataProcessor'), 'Should contain DataProcessor root element');
    assert.ok(content.includes('<Name>НоваяОбработка</Name>'), 'Should contain correct name');
    assert.ok(content.includes('<Synonym>'), 'Should contain synonym');
    assert.ok(content.includes('<v8:content>НоваяОбработка</v8:content>'), 'Should contain synonym content');
    assert.ok(content.includes('uuid="'), 'Should contain UUID');

    // Баг2 guard: запись в Configuration.xml должна появиться
    const configurationContent = await readFileContent(path.join(tmpDir, 'Configuration.xml'));
    assert.ok(
      /<DataProcessor>\s*НоваяОбработка\s*<\/DataProcessor>/.test(configurationContent),
      'Configuration.xml should include created DataProcessor entry'
    );
  });

  test('createAttribute inside DataProcessor does not include invalid requisites properties', async () => {
    // Create DataProcessor first
    const dpName = 'НоваяОбработка2';
    await createElement(dataProcessorsTypeNode, dpName);

    const elementPath = path.join(tmpDir, 'DataProcessors', `${dpName}.xml`);
    const dataProcessorNode = {
      id: dpName,
      name: dpName,
      type: MetadataType.DataProcessor,
      parent: dataProcessorsTypeNode,
      filePath: elementPath,
      properties: {},
      children: undefined
    };

    // Add requisite (Attribute) inside DataProcessor
    await createElement(dataProcessorNode, 'Реквизит1');

    const content = await readFileContent(elementPath);

    // Баг1 guard: these properties should not be generated for DataProcessor requisites.
    assert.ok(!content.includes('<DataHistory>'), 'Attribute inside DataProcessor must not include DataHistory');
    assert.ok(!content.includes('<FullTextSearch>'), 'Attribute inside DataProcessor must not include FullTextSearch');
    assert.ok(!content.includes('<Indexing>'), 'Attribute inside DataProcessor must not include Indexing');
    assert.ok(!content.includes('<FillValue>'), 'Attribute inside DataProcessor must not include FillValue');
    assert.ok(!content.includes('<FillFromFillingValue>'), 'Attribute inside DataProcessor must not include FillFromFillingValue');

    assert.ok(content.includes('<Attribute'), 'Should contain an Attribute block');
    assert.ok(content.includes('<Name>Реквизит1</Name>'), 'Attribute should have correct requisite name');
  });

  test('createElement throws for duplicate DataProcessor name', async () => {
    // Create existing DataProcessor first
    const existingPath = path.join(tmpDir, 'DataProcessors', 'СуществующаяОбработка.xml');
    await XMLWriter.createMinimalElementFile(existingPath, 'DataProcessor', 'СуществующаяОбработка');
    
    await assert.rejects(
      async () => createElement(dataProcessorsTypeNode, 'СуществующаяОбработка'),
      /уже существует/
    );
  });

  test('deleteElement removes DataProcessor file and folder', async () => {
    // Create DataProcessor first
    const elementPath = path.join(tmpDir, 'DataProcessors', 'ТестоваяОбработка.xml');
    const elementDir = path.join(tmpDir, 'DataProcessors', 'ТестоваяОбработка');
    await XMLWriter.createMinimalElementFile(elementPath, 'DataProcessor', 'ТестоваяОбработка');
    await fs.promises.mkdir(elementDir, { recursive: true });
    
    // Create test file in directory to verify directory deletion
    const testFile = path.join(elementDir, 'test.txt');
    await fs.promises.writeFile(testFile, 'test');
    
    const dataProcessorNode = {
      id: 'ТестоваяОбработка',
      name: 'ТестоваяОбработка',
      type: MetadataType.DataProcessor,
      parent: dataProcessorsTypeNode,
      filePath: elementPath,
      properties: {},
      children: undefined
    };
    
    await deleteElement(dataProcessorNode);
    
    assert.ok(!fileExists(elementPath), 'DataProcessor XML file should be deleted');
    assert.ok(!dirExists(elementDir), 'DataProcessor directory should be deleted');

    // Баг2 guard: запись в Configuration.xml должна быть удалена
    const configurationContent = await readFileContent(path.join(tmpDir, 'Configuration.xml'));
    assert.ok(
      !/<DataProcessor>\s*ТестоваяОбработка\s*<\/DataProcessor>/.test(configurationContent),
      'Configuration.xml must not include deleted DataProcessor entry'
    );
  });

  test('deleteElement throws for DataProcessor with no parent', async () => {
    const noParentNode = {
      id: 'ТестоваяОбработка',
      name: 'ТестоваяОбработка',
      type: MetadataType.DataProcessor,
      parent: undefined,
      filePath: path.join(tmpDir, 'DataProcessors', 'ТестоваяОбработка.xml'),
      properties: {},
      children: undefined
    };
    
    await assert.rejects(
      async () => deleteElement(noParentNode as TreeNode),
      /Нет родительского/
    );
  });

  test('duplicateElement creates copy of DataProcessor', async () => {
    // Create original DataProcessor
    const originalPath = path.join(tmpDir, 'DataProcessors', 'ИсходнаяОбработка.xml');
    const originalContent = `<?xml version='1.0' encoding='utf-8'?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core">
  <DataProcessor uuid="{original-uuid}">
    <Properties>
      <Name>ИсходнаяОбработка</Name>
      <Synonym>
        <v8:item>
          <v8:lang>ru</v8:lang>
          <v8:content>Исходная Обработка</v8:content>
        </v8:item>
      </Synonym>
      <Comment>Тестовая обработка</Comment>
    </Properties>
    <ChildObjects />
  </DataProcessor>
</MetaDataObject>`;
    await fs.promises.writeFile(originalPath, originalContent, 'utf-8');
    
    const originalDir = path.join(tmpDir, 'DataProcessors', 'ИсходнаяОбработка');
    await fs.promises.mkdir(originalDir, { recursive: true });
    
    const originalNode = {
      id: 'ИсходнаяОбработка',
      name: 'ИсходнаяОбработка',
      type: MetadataType.DataProcessor,
      parent: dataProcessorsTypeNode,
      filePath: originalPath,
      properties: {},
      children: undefined
    };
    
    await duplicateElement(originalNode, 'СкопированнаяОбработка');
    
    const duplicatedPath = path.join(tmpDir, 'DataProcessors', 'СкопированнаяОбработка.xml');
    assert.ok(fileExists(duplicatedPath), 'Duplicated DataProcessor file should exist');
    
    const duplicatedContent = await readFileContent(duplicatedPath);
    assert.ok(duplicatedContent.includes('<Name>СкопированнаяОбработка</Name>'), 'Should have new name');
    assert.ok(duplicatedContent.includes('<v8:content>СкопированнаяОбработка</v8:content>'), 'Should have new synonym content');
    assert.ok(!duplicatedContent.includes('ИсходнаяОбработка'), 'Should not contain old name');
  });

  test('renameElement renames DataProcessor file and folder', async () => {
    // Create original DataProcessor
    const originalPath = path.join(tmpDir, 'DataProcessors', 'СтараяОбработка.xml');
    await XMLWriter.createMinimalElementFile(originalPath, 'DataProcessor', 'СтараяОбработка');
    
    const originalDir = path.join(tmpDir, 'DataProcessors', 'СтараяОбработка');
    const newDir = path.join(tmpDir, 'DataProcessors', 'ПереименованнаяОбработка');
    await fs.promises.mkdir(originalDir, { recursive: true });
    
    // Create test file in directory
    const testFile = path.join(originalDir, 'test.txt');
    await fs.promises.writeFile(testFile, 'test');
    
    const dataProcessorNode = {
      id: 'СтараяОбработка',
      name: 'СтараяОбработка',
      type: MetadataType.DataProcessor,
      parent: dataProcessorsTypeNode,
      filePath: originalPath,
      properties: {},
      children: undefined
    };
    
    await renameElement(dataProcessorNode, 'ПереименованнаяОбработка', tmpDir);
    
    const newPath = path.join(tmpDir, 'DataProcessors', 'ПереименованнаяОбработка.xml');
    assert.ok(fs.existsSync(newPath), 'Renamed DataProcessor file should exist');
    assert.ok(fs.existsSync(newDir), 'Renamed directory should exist');
    assert.ok(!fs.existsSync(originalPath), 'Original file should not exist');
    assert.ok(!fs.existsSync(originalDir), 'Original directory should not exist');
    
    // Check that test file was moved with directory
    const movedTestFile = path.join(newDir, 'test.txt');
    assert.ok(fs.existsSync(movedTestFile), 'Files should be moved with directory');
  });

  test('renameElement to same name does nothing', async () => {
    const originalPath = path.join(tmpDir, 'DataProcessors', 'ТестоваяОбработка.xml');
    await XMLWriter.createMinimalElementFile(originalPath, 'DataProcessor', 'ТестоваяОбработка');
    
    const dataProcessorNode = {
      id: 'ТестоваяОбработка',
      name: 'ТестоваяОбработка',
      type: MetadataType.DataProcessor,
      parent: dataProcessorsTypeNode,
      filePath: originalPath,
      properties: {},
      children: undefined
    };
    
    await renameElement(dataProcessorNode, 'ТестоваяОбработка', tmpDir);
    
    assert.ok(fs.existsSync(originalPath), 'Original file should still exist');
  });
});