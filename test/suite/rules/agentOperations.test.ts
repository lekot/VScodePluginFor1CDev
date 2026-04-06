// test/suite/rules/agentOperations.test.ts
// Unit-тесты для AgentOperations (без vscode зависимостей).
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { AgentOperations } from '../../../src/agent/agentOperations';
import { createTempDir, cleanupTempDir } from '../../helpers/testHelpers';

// Минимальный Configuration.xml для тестового конфига
const MINIMAL_CONFIG_XML = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core">
  <Configuration uuid="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee">
    <Properties>
      <Name>TestConfig</Name>
    </Properties>
    <ChildObjects>
    </ChildObjects>
  </Configuration>
</MetaDataObject>`;

function writeConfigXml(dir: string): void {
    fs.writeFileSync(path.join(dir, 'Configuration.xml'), MINIMAL_CONFIG_XML, 'utf-8');
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite: createObject
// ─────────────────────────────────────────────────────────────────────────────

suite('AgentOperations: createObject', () => {
    let tmpDir: string;
    let ops: AgentOperations;

    setup(async () => {
        tmpDir = await createTempDir('1cviewer-agent-create-');
        writeConfigXml(tmpDir);
        ops = new AgentOperations(tmpDir);
    });

    teardown(async () => {
        await cleanupTempDir(tmpDir);
    });

    test('creates Catalog XML file on disk', async () => {
        const result = await ops.createObject({ type: 'Catalog', name: 'ТестКаталог' });
        assert.ok(result.success, `Expected success, got error: ${result.error}`);
        assert.ok(result.data?.filePath, 'filePath should be set');
        assert.ok(fs.existsSync(result.data!.filePath), 'XML file should exist on disk');
    });

    test('created XML contains object name', async () => {
        const result = await ops.createObject({ type: 'Catalog', name: 'МойСправочник' });
        assert.ok(result.success, `Expected success, got error: ${result.error}`);
        const content = fs.readFileSync(result.data!.filePath, 'utf-8');
        assert.ok(content.includes('МойСправочник'), 'XML should contain object name');
    });

    test('created XML is valid (starts with xml declaration, has MetaDataObject)', async () => {
        const result = await ops.createObject({ type: 'Catalog', name: 'КаталогXml' });
        assert.ok(result.success, `Expected success, got error: ${result.error}`);
        const content = fs.readFileSync(result.data!.filePath, 'utf-8');
        assert.ok(content.startsWith('<?xml'), 'should start with <?xml');
        assert.ok(content.includes('<MetaDataObject'), 'should contain <MetaDataObject');
        assert.ok(content.includes('<Catalog '), 'should contain <Catalog root tag');
    });

    test('creates object directory alongside XML', async () => {
        const result = await ops.createObject({ type: 'Catalog', name: 'ДирКаталог' });
        assert.ok(result.success, `Expected success, got error: ${result.error}`);
        const elementDir = path.join(tmpDir, 'Catalogs', 'ДирКаталог');
        assert.ok(fs.existsSync(elementDir), 'element directory should be created');
    });

    test('registers object in Configuration.xml', async () => {
        const result = await ops.createObject({ type: 'Catalog', name: 'РегКаталог' });
        assert.ok(result.success, `Expected success, got error: ${result.error}`);
        const configContent = fs.readFileSync(path.join(tmpDir, 'Configuration.xml'), 'utf-8');
        assert.ok(configContent.includes('РегКаталог'), 'Configuration.xml should contain the new object name');
    });

    test('returns error if type not supported', async () => {
        const result = await ops.createObject({ type: 'UnknownType', name: 'Test' });
        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('UnknownType'), 'error should mention unsupported type');
    });

    test('returns error if name is empty', async () => {
        const result = await ops.createObject({ type: 'Catalog', name: '   ' });
        assert.strictEqual(result.success, false);
        assert.ok(result.error, 'error should be set');
    });

    test('returns error if object already exists', async () => {
        await ops.createObject({ type: 'Catalog', name: 'ДубликатОбъект' });
        const result2 = await ops.createObject({ type: 'Catalog', name: 'ДубликатОбъект' });
        assert.strictEqual(result2.success, false);
        assert.ok(result2.error?.includes('уже существует') || result2.error?.includes('exist'), 'error should indicate duplicate');
    });

    test('creates CommonModule successfully', async () => {
        const result = await ops.createObject({ type: 'CommonModule', name: 'МойМодуль' });
        assert.ok(result.success, `Expected success, got error: ${result.error}`);
        assert.ok(fs.existsSync(result.data!.filePath), 'XML file should exist');
    });

    test('creates Enum successfully', async () => {
        const result = await ops.createObject({ type: 'Enum', name: 'МоёПеречисление' });
        assert.ok(result.success, `Expected success, got error: ${result.error}`);
        const content = fs.readFileSync(result.data!.filePath, 'utf-8');
        assert.ok(content.includes('<Enum '), 'XML should contain <Enum root tag');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite: getYaml
// ─────────────────────────────────────────────────────────────────────────────

suite('AgentOperations: getYaml', () => {
    let tmpDir: string;
    let ops: AgentOperations;

    setup(async () => {
        tmpDir = await createTempDir('1cviewer-agent-yaml-');
        writeConfigXml(tmpDir);
        ops = new AgentOperations(tmpDir);
    });

    teardown(async () => {
        await cleanupTempDir(tmpDir);
    });

    test('returns YAML for created Catalog', async () => {
        await ops.createObject({ type: 'Catalog', name: 'ЯМЛСправочник' });
        const result = await ops.getYaml({ path: 'Catalog.ЯМЛСправочник' });
        assert.ok(result.success, `Expected success, got error: ${result.error}`);
        assert.ok(result.data?.yaml, 'yaml should be present');
    });

    test('YAML contains the object name', async () => {
        await ops.createObject({ type: 'Catalog', name: 'ИмяВЯМЛ' });
        const result = await ops.getYaml({ path: 'Catalog.ИмяВЯМЛ' });
        assert.ok(result.success, `Expected success, got error: ${result.error}`);
        assert.ok(result.data!.yaml.includes('ИмяВЯМЛ'), 'YAML should contain object name');
    });

    test('returns error for invalid path (no dot)', async () => {
        const result = await ops.getYaml({ path: 'CatalogNoName' });
        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('вида'), 'error should describe expected format');
    });

    test('returns error if XML file does not exist', async () => {
        const result = await ops.getYaml({ path: 'Catalog.НесуществующийОбъект' });
        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('не найден') || result.error?.includes('not found'), 'error should say not found');
    });

    test('returns error for unsupported type', async () => {
        const result = await ops.getYaml({ path: 'UnknownType.Test' });
        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('UnknownType'), 'error should mention type');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite: listObjects
// ─────────────────────────────────────────────────────────────────────────────

suite('AgentOperations: listObjects', () => {
    let tmpDir: string;
    let ops: AgentOperations;

    setup(async () => {
        tmpDir = await createTempDir('1cviewer-agent-list-');
        writeConfigXml(tmpDir);
        ops = new AgentOperations(tmpDir);
    });

    teardown(async () => {
        await cleanupTempDir(tmpDir);
    });

    test('returns empty list for empty configuration', async () => {
        const result = await ops.listObjects({});
        assert.ok(result.success, `Expected success, got error: ${result.error}`);
        assert.deepStrictEqual(result.data?.objects, []);
    });

    test('returns created object in list', async () => {
        await ops.createObject({ type: 'Catalog', name: 'СписокТест' });
        const result = await ops.listObjects({});
        assert.ok(result.success, `Expected success, got error: ${result.error}`);
        const found = result.data!.objects.find((o) => o.name === 'СписокТест' && o.type === 'Catalog');
        assert.ok(found, 'created Catalog should appear in listObjects');
    });

    test('filters by type', async () => {
        await ops.createObject({ type: 'Catalog', name: 'ФильтрСправочник' });
        await ops.createObject({ type: 'Enum', name: 'ФильтрПеречисление' });

        const catalogsResult = await ops.listObjects({ type: 'Catalog' });
        assert.ok(catalogsResult.success, `Expected success, got error: ${catalogsResult.error}`);
        const types = catalogsResult.data!.objects.map((o) => o.type);
        assert.ok(types.every((t) => t === 'Catalog'), 'should only contain Catalogs when filtered');

        const enumsResult = await ops.listObjects({ type: 'Enum' });
        assert.ok(enumsResult.success, `Expected success, got error: ${enumsResult.error}`);
        const enumNames = enumsResult.data!.objects.map((o) => o.name);
        assert.ok(enumNames.includes('ФильтрПеречисление'), 'should contain the Enum');
    });

    test('ObjectInfo has type, name, filePath', async () => {
        await ops.createObject({ type: 'Catalog', name: 'ФилдТест' });
        const result = await ops.listObjects({ type: 'Catalog' });
        assert.ok(result.success);
        const obj = result.data!.objects[0];
        assert.ok(obj.type, 'type should be set');
        assert.ok(obj.name, 'name should be set');
        assert.ok(obj.filePath, 'filePath should be set');
    });

    test('parses real Configuration.xml fixture', async () => {
        // Пишем реальный Configuration.xml с объектами
        const configXml = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core">
  <Configuration uuid="test-uuid">
    <Properties><Name>TestConf</Name></Properties>
    <ChildObjects>
      <Catalog>Товары</Catalog>
      <Catalog>Контрагенты</Catalog>
      <Document>ПродажаТоваров</Document>
    </ChildObjects>
  </Configuration>
</MetaDataObject>`;
        fs.writeFileSync(path.join(tmpDir, 'Configuration.xml'), configXml, 'utf-8');

        const result = await ops.listObjects({});
        assert.ok(result.success, `Expected success, got error: ${result.error}`);
        const names = result.data!.objects.map((o) => o.name);
        assert.ok(names.includes('Товары'), 'should include Товары');
        assert.ok(names.includes('Контрагенты'), 'should include Контрагенты');
        assert.ok(names.includes('ПродажаТоваров'), 'should include ПродажаТоваров');
    });

    test('returns error if Configuration.xml missing', async () => {
        const opsNoConfig = new AgentOperations(path.join(tmpDir, 'nonexistent'));
        const result = await opsNoConfig.listObjects({});
        assert.strictEqual(result.success, false);
        assert.ok(result.error, 'error should be set');
    });
});
