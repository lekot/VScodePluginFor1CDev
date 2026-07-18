import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentOperations } from '../../src/agent/agentOperations';
import { resolveAgentPath } from '../../src/agent/agentPathResolver';

suite('Agent metadata path and name safety', () => {
  let tempDir: string;

  setup(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-safety-'));
    await fs.promises.writeFile(
      path.join(tempDir, 'Configuration.xml'),
      '<MetaDataObject><Configuration uuid="cccccccc-cccc-cccc-cccc-cccccccccccc"><ChildObjects/></Configuration></MetaDataObject>',
      'utf8',
    );
  });

  teardown(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  test('rejects traversal, separators, reserved words and leading digits', async () => {
    const operations = new AgentOperations(tempDir);
    for (const name of ['../Outside', '..\\Outside', 'Bad/Name', 'Если', 'если', '1Catalog']) {
      const result = await operations.createObject({ type: 'Catalog', name });
      assert.strictEqual(result.success, false, name);
    }
    assert.throws(() => resolveAgentPath(tempDir, 'Catalog.Bad/Name'), /Некорректный/);
    assert.throws(() => resolveAgentPath(tempDir, 'Catalog.Bad\\Name'), /Некорректный/);
  });

  test('rejects a case-insensitive sibling duplicate', async () => {
    const catalogs = path.join(tempDir, 'Catalogs');
    await fs.promises.mkdir(catalogs);
    await fs.promises.writeFile(path.join(catalogs, 'Goods.xml'), '<MetaDataObject/>', 'utf8');

    const result = await new AgentOperations(tempDir).createObject({ type: 'Catalog', name: 'goods' });

    assert.strictEqual(result.success, false);
    assert.match(result.error ?? '', /уже существует/);
  });

  test('rejects case-insensitive duplicates in each nested sibling scope', async () => {
    const catalogs = path.join(tempDir, 'Catalogs');
    await fs.promises.mkdir(catalogs);
    await fs.promises.writeFile(path.join(catalogs, 'Goods.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses">
  <Catalog uuid="11111111-1111-1111-1111-111111111111">
    <Properties><Name>Goods</Name></Properties>
    <ChildObjects>
      <Attribute uuid="22222222-2222-2222-2222-222222222222"><Properties><Name>Code</Name></Properties></Attribute>
      <TabularSection uuid="33333333-3333-3333-3333-333333333333">
        <Properties><Name>Items</Name></Properties>
        <ChildObjects>
          <Attribute uuid="44444444-4444-4444-4444-444444444444"><Properties><Name>Quantity</Name></Properties></Attribute>
        </ChildObjects>
      </TabularSection>
    </ChildObjects>
  </Catalog>
</MetaDataObject>`, 'utf8');
    const operations = new AgentOperations(tempDir);

    const attribute = await operations.addAttribute({ path: 'Catalog.Goods', name: 'code' });
    const section = await operations.addTabularSection({ path: 'Catalog.Goods', name: 'items' });
    const column = await operations.addTabularSectionColumn({
      path: 'Catalog.Goods.TabularSection.Items',
      name: 'quantity',
    });

    for (const result of [attribute, section, column]) {
      assert.strictEqual(result.success, false);
      assert.match(result.error ?? '', /уже существует/i);
    }
  });

  test('rejects an object descriptor reached through a junction escape', async function () {
    const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-safety-outside-'));
    await fs.promises.writeFile(path.join(outside, 'Goods.xml'), '<MetaDataObject/>', 'utf8');
    const catalogsLink = path.join(tempDir, 'Catalogs');
    try {
      await fs.promises.symlink(outside, catalogsLink, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      await fs.promises.rm(outside, { recursive: true, force: true });
      this.skip();
      return;
    }
    try {
      const result = await new AgentOperations(tempDir).getProperties({ path: 'Catalog.Goods' });
      assert.strictEqual(result.success, false);
      assert.match(result.error ?? '', /границ/);
    } finally {
      await fs.promises.rm(outside, { recursive: true, force: true });
    }
  });
});
