import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AgentOperations } from '../../src/agent/agentOperations';
import { AgentMetadataCrudOperations } from '../../src/agent/agentMetadataCrudOperations';
import { AgentChildStructureOperations } from '../../src/agent/agentChildStructureOperations';
import { AgentPropertyOperations } from '../../src/agent/agentPropertyOperations';

const MINIMAL_CONFIG_XML = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject version="2.20" xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core">
  <Configuration uuid="11111111-2222-3333-4444-555555555555">
    <Properties>
      <Name>DecompositionTestConfig</Name>
      <Synonym><v8:item><v8:lang>ru</v8:lang><v8:content>Тест декомпозиции</v8:content></v8:item></Synonym>
    </Properties>
    <ChildObjects/>
  </Configuration>
</MetaDataObject>`;

suite('AgentOperations Decomposition & Domain Parity (#201, #267)', () => {
  let tempDir: string;
  let operations: AgentOperations;

  setup(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-decomp-test-'));
    await fs.promises.writeFile(path.join(tempDir, 'Configuration.xml'), MINIMAL_CONFIG_XML, 'utf-8');
    operations = new AgentOperations(tempDir);
  });

  teardown(async () => {
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error on Windows
    }
  });

  test('source file size of agentOperations.ts is reduced below 500 LOC', () => {
    const filePath = path.resolve(__dirname, '../../../src/agent/agentOperations.ts');
    const content = fs.readFileSync(filePath, 'utf-8');
    const lineCount = content.split('\n').length;
    assert.ok(
      lineCount < 500,
      `agentOperations.ts has ${lineCount} LOC, which exceeds the hotspot threshold (< 500 LOC)`,
    );
  });

  test('domain operations classes are exported and instantiate with AgentOperations context', () => {
    const crud = new AgentMetadataCrudOperations(operations);
    const child = new AgentChildStructureOperations(operations);
    const prop = new AgentPropertyOperations(operations);

    assert.ok(crud instanceof AgentMetadataCrudOperations, 'AgentMetadataCrudOperations must instantiate');
    assert.ok(child instanceof AgentChildStructureOperations, 'AgentChildStructureOperations must instantiate');
    assert.ok(prop instanceof AgentPropertyOperations, 'AgentPropertyOperations must instantiate');
  });

  test('CRUD operations parity: createObject and getYaml work identically via domain class and facade', async () => {
    const crud = new AgentMetadataCrudOperations(operations);

    // 1. Create Catalog via facade
    const facadeResult = await operations.createObject({ type: 'Catalog', name: 'Goods' });
    assert.strictEqual(facadeResult.success, true);
    assert.ok(facadeResult.data?.filePath);

    // 2. Create another Catalog directly via domain operations
    const directResult = await crud.createObject({ type: 'Catalog', name: 'Customers' });
    assert.strictEqual(directResult.success, true);
    assert.ok(directResult.data?.filePath);

    // 3. getYaml via facade and domain class
    const yamlFacade = await operations.getYaml({ path: 'Catalog.Goods' });
    const yamlDirect = await crud.getYaml({ path: 'Catalog.Customers' });
    assert.strictEqual(yamlFacade.success, true);
    assert.strictEqual(yamlDirect.success, true);
  });

  test('child structure operations parity: addAttribute works identically via domain class and facade', async () => {
    await operations.createObject({ type: 'Catalog', name: 'Items' });
    const child = new AgentChildStructureOperations(operations);

    // 1. Add attribute via facade
    const res1 = await operations.addAttribute({
      path: 'Catalog.Items',
      name: 'Barcode',
    });
    assert.strictEqual(res1.success, true);

    // 2. Add attribute directly via domain class
    const res2 = await child.addAttribute({
      path: 'Catalog.Items',
      name: 'Price',
    });
    assert.strictEqual(res2.success, true);
  });

  test('property operations parity: getProperties and setProperties work identically via domain class and facade', async () => {
    await operations.createObject({ type: 'Catalog', name: 'Suppliers' });
    const prop = new AgentPropertyOperations(operations);

    // 1. setProperties via domain class
    const setDirect = await prop.setProperties({
      path: 'Catalog.Suppliers',
      properties: { DescriptionLength: 50 },
    });
    assert.strictEqual(setDirect.success, true);

    // 2. getProperties via facade
    const getFacade = await operations.getProperties({ path: 'Catalog.Suppliers' });
    assert.strictEqual(getFacade.success, true);
    assert.strictEqual((getFacade.data?.properties as any)?.DescriptionLength, 50);
  });
});
