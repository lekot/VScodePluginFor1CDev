// test/suite/rules/agentOperations.test.ts
// Unit-тесты для AgentOperations (без vscode зависимостей).
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { XMLParser } from 'fast-xml-parser';
import { AgentOperations } from '../../../src/agent/agentOperations';
import { createTempDir, cleanupTempDir } from '../../helpers/testHelpers';

// Минимальный Configuration.xml для тестового конфига
const MINIMAL_CONFIG_XML = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject version="2.20" xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core">
  <Configuration uuid="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee">
    <Properties>
      <Name>TestConfig</Name>
    </Properties>
    <ChildObjects>
    </ChildObjects>
  </Configuration>
</MetaDataObject>`;

const EVENT_SUBSCRIPTION_XML = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject version="2.20" xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core">
  <EventSubscription uuid="11111111-1111-4111-8111-111111111111">
    <Properties>
      <Name>OnWrite</Name>
      <Source>
        <v8:Type>cfg:DocumentObject.Receipt</v8:Type>
        <v8:Type>cfg:CatalogObject.Goods</v8:Type>
      </Source>
      <Event>BeforeWrite</Event>
      <Handler>CommonModule.Handler</Handler>
    </Properties>
    <ChildObjects/>
  </EventSubscription>
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
        assert.ok(content.includes('version="2.20"'), 'should preserve the project format version');
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

    test('FilterCriterion: rejects creation when Content is missing, empty array, or whitespace-only', async () => {
        // Missing properties
        const r1 = await ops.createObject({ type: 'FilterCriterion', name: 'КритерийБезСвойств' });
        assert.strictEqual(r1.success, false);
        assert.ok(r1.error?.includes('Content'), `expected Content error, got: ${r1.error}`);

        // Empty Content array
        const r2 = await ops.createObject({
            type: 'FilterCriterion',
            name: 'КритерийПустойМассив',
            properties: { Content: [] },
        });
        assert.strictEqual(r2.success, false);
        assert.ok(r2.error?.includes('Content'), `expected Content error, got: ${r2.error}`);

        // Whitespace-only string
        const r3 = await ops.createObject({
            type: 'FilterCriterion',
            name: 'КритерийПробелСтрока',
            properties: { Content: '   ' },
        });
        assert.strictEqual(r3.success, false);
        assert.ok(r3.error?.includes('Content'), `expected Content error, got: ${r3.error}`);

        // Whitespace-only array
        const r4 = await ops.createObject({
            type: 'FilterCriterion',
            name: 'КритерийПробелМассив',
            properties: { Content: ['   ', ''] },
        });
        assert.strictEqual(r4.success, false);
        assert.ok(r4.error?.includes('Content'), `expected Content error, got: ${r4.error}`);
    });

    test('FilterCriterion: creates metadata object successfully with valid Type and Content', async () => {
        const result = await ops.createObject({
            type: 'FilterCriterion',
            name: 'ПоПартнеру',
            properties: {
                Type: ['cfg:CatalogRef.Партнеры'],
                Content: ['Catalog.Партнеры.Attribute.ГоловнойПартнер'],
            },
        });
        assert.ok(result.success, `Expected success, got error: ${result.error}`);
        assert.ok(fs.existsSync(result.data!.filePath), 'XML file should exist');
        const content = fs.readFileSync(result.data!.filePath, 'utf-8');
        assert.ok(content.includes('<FilterCriterion '), 'XML should contain FilterCriterion');
        assert.ok(content.includes('Catalog.Партнеры.Attribute.ГоловнойПартнер'), 'XML should contain Content item ref');
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

    test('query is trimmed and matches object names case-insensitively', async () => {
        await ops.createObject({ type: 'Catalog', name: 'CustomerOrders' });
        await ops.createObject({ type: 'Catalog', name: 'Warehouses' });

        const result = await ops.listObjects({ query: '  TOMERord  ' });

        assert.ok(result.success, result.error);
        assert.deepStrictEqual(result.data!.objects.map((object) => object.name), ['CustomerOrders']);
    });

    test('query filters by name only and an empty trimmed query does not filter', async () => {
        await ops.createObject({ type: 'Catalog', name: 'Products' });
        await ops.createObject({ type: 'Document', name: 'CatalogInName' });

        const byTypeText = await ops.listObjects({ query: 'Document' });
        assert.ok(byTypeText.success, byTypeText.error);
        assert.deepStrictEqual(byTypeText.data!.objects, [], 'metadata type must not participate in query matching');

        const all = await ops.listObjects({ query: '   ' });
        assert.ok(all.success, all.error);
        assert.strictEqual(all.data!.objects.length, 2);
    });

    test('type remains exact and case-sensitive when combined with query', async () => {
        await ops.createObject({ type: 'Catalog', name: 'SharedNameCatalog' });
        await ops.createObject({ type: 'Document', name: 'SharedNameDocument' });

        const exact = await ops.listObjects({ type: 'Catalog', query: 'sharedname' });
        assert.ok(exact.success, exact.error);
        assert.deepStrictEqual(exact.data!.objects.map((object) => object.type), ['Catalog']);

        const wrongCase = await ops.listObjects({ type: 'catalog', query: 'sharedname' });
        assert.ok(wrongCase.success, wrongCase.error);
        assert.deepStrictEqual(wrongCase.data!.objects, []);
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
<MetaDataObject version="2.20" xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core">
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

// ─────────────────────────────────────────────────────────────────────────────
// Suite: getType
// ─────────────────────────────────────────────────────────────────────────────

const DEFINED_TYPE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="2.17">
  <DefinedType uuid="11111111-2222-3333-4444-555555555555">
    <Properties>
      <Name>ТипНоменклатуры</Name>
      <Type>
        <v8:Type>cfg:CatalogRef.Товары</v8:Type>
        <v8:Type>cfg:CatalogRef.Услуги</v8:Type>
      </Type>
    </Properties>
  </DefinedType>
</MetaDataObject>`;

const CONFIG_XML_WITH_DEFINED_TYPE = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject version="2.20" xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core">
  <Configuration uuid="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee">
    <Properties>
      <Name>TestConfig</Name>
    </Properties>
    <ChildObjects>
      <DefinedType>ТипНоменклатуры</DefinedType>
    </ChildObjects>
  </Configuration>
</MetaDataObject>`;

function writeDefinedTypeXml(dir: string): void {
    const definedTypesDir = path.join(dir, 'DefinedTypes');
    fs.mkdirSync(definedTypesDir, { recursive: true });
    fs.writeFileSync(path.join(definedTypesDir, 'ТипНоменклатуры.xml'), DEFINED_TYPE_XML, 'utf-8');
}

suite('AgentOperations: getType', () => {
    let tmpDir: string;
    let ops: AgentOperations;

    setup(async () => {
        tmpDir = await createTempDir('1cviewer-agent-gettype-');
        fs.writeFileSync(path.join(tmpDir, 'Configuration.xml'), CONFIG_XML_WITH_DEFINED_TYPE, 'utf-8');
        writeDefinedTypeXml(tmpDir);
        ops = new AgentOperations(tmpDir);
    });

    teardown(async () => {
        await cleanupTempDir(tmpDir);
    });

    test('returns types for DefinedType after setType round-trip', async () => {
        await ops.setType({ path: 'DefinedType.ТипНоменклатуры', types: ['cfg:CatalogRef.Товары', 'cfg:CatalogRef.Услуги'] });
        const result = await ops.getType({ path: 'DefinedType.ТипНоменклатуры' });
        assert.ok(result.success, `Expected success, got error: ${result.error}`);
        assert.ok(Array.isArray(result.data?.types), 'types should be an array');
        assert.strictEqual(result.data!.types.length, 2, 'should have 2 types');
        assert.ok(result.data!.types.includes('cfg:CatalogRef.Товары'), 'should include cfg:CatalogRef.Товары');
        assert.ok(result.data!.types.includes('cfg:CatalogRef.Услуги'), 'should include cfg:CatalogRef.Услуги');
    });

    test('returns error for non-existent path', async () => {
        const result = await ops.getType({ path: 'DefinedType.НесуществующийТип' });
        assert.strictEqual(result.success, false);
        assert.ok(result.error, 'error should be set');
    });

    test('rawXml contains v8:Type elements after setType', async () => {
        await ops.setType({ path: 'DefinedType.ТипНоменклатуры', types: ['cfg:CatalogRef.Товары'] });
        const result = await ops.getType({ path: 'DefinedType.ТипНоменклатуры' });
        assert.ok(result.success, `Expected success, got error: ${result.error}`);
        assert.ok(result.data!.rawXml.includes('v8:Type'), 'rawXml should contain v8:Type elements');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite: setType
// ─────────────────────────────────────────────────────────────────────────────

suite('AgentOperations: setType', () => {
    let tmpDir: string;
    let ops: AgentOperations;

    setup(async () => {
        tmpDir = await createTempDir('1cviewer-agent-settype-');
        fs.writeFileSync(path.join(tmpDir, 'Configuration.xml'), CONFIG_XML_WITH_DEFINED_TYPE, 'utf-8');
        writeDefinedTypeXml(tmpDir);
        ops = new AgentOperations(tmpDir);
    });

    teardown(async () => {
        await cleanupTempDir(tmpDir);
    });

    test('sets single type successfully', async () => {
        const result = await ops.setType({ path: 'DefinedType.ТипНоменклатуры', types: ['xs:string'] });
        assert.ok(result.success, `Expected success, got error: ${result.error}`);
        const content = fs.readFileSync(path.join(tmpDir, 'DefinedTypes', 'ТипНоменклатуры.xml'), 'utf-8');
        const domParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
        const dom = domParser.parse(content);
        const typeNode = dom.MetaDataObject.DefinedType.Properties.Type;
        assert.strictEqual(typeNode['v8:Type'], 'xs:string');
        assert.strictEqual(typeNode.Type, undefined, 'native Type must not contain a nested wrapper');
        assert.ok(!content.includes('&lt;Type'), 'Type markup must not be stored as escaped text');
    });

    test('stores multiple types as native v8:Type children', async () => {
        const expected = ['cfg:DocumentRef.Заказ', 'xs:boolean'];
        const result = await ops.setType({ path: 'DefinedType.ТипНоменклатуры', types: expected });
        assert.ok(result.success, `Expected success, got error: ${result.error}`);

        const content = fs.readFileSync(path.join(tmpDir, 'DefinedTypes', 'ТипНоменклатуры.xml'), 'utf-8');
        const domParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
        const dom = domParser.parse(content);
        const typeNode = dom.MetaDataObject.DefinedType.Properties.Type;
        assert.deepStrictEqual(typeNode['v8:Type'], expected);
        assert.ok(!content.includes('&lt;Type'));
    });

    test('round-trip: setType then getType returns same types', async () => {
        const typesToSet = ['cfg:DocumentRef.Заказ', 'xs:boolean'];
        const setResult = await ops.setType({ path: 'DefinedType.ТипНоменклатуры', types: typesToSet });
        assert.ok(setResult.success, `setType failed: ${setResult.error}`);

        const getResult = await ops.getType({ path: 'DefinedType.ТипНоменклатуры' });
        assert.ok(getResult.success, `getType after setType failed: ${getResult.error}`);
        assert.ok(getResult.data!.types.includes('cfg:DocumentRef.Заказ'), 'types should include cfg:DocumentRef.Заказ');
        assert.ok(getResult.data!.types.includes('xs:boolean'), 'types should include xs:boolean');
    });

    test('preserves Date/DateTime/Time semantics in native Designer shape', async () => {
        for (const [apiType, fraction] of [
            ['xs:date', 'Date'],
            ['xs:dateTime', 'DateTime'],
            ['xs:time', 'Time'],
        ] as const) {
            const setResult = await ops.setType({ path: 'DefinedType.ТипНоменклатуры', types: [apiType] });
            assert.ok(setResult.success, setResult.error);
            const content = fs.readFileSync(path.join(tmpDir, 'DefinedTypes', 'ТипНоменклатуры.xml'), 'utf-8');
            const dom = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' }).parse(content);
            const typeNode = dom.MetaDataObject.DefinedType.Properties.Type;
            assert.strictEqual(typeNode['v8:Type'], 'xs:dateTime');
            assert.strictEqual(typeNode['v8:DateQualifiers']['v8:DateFractions'], fraction);
            const getResult = await ops.getType({ path: 'DefinedType.ТипНоменклатуры' });
            assert.ok(getResult.success, getResult.error);
            assert.deepStrictEqual(getResult.data!.types, [apiType]);
        }
    });

    test('scopes getType/setType to the named tabular section', async () => {
        const catalogsDir = path.join(tmpDir, 'Catalogs');
        fs.mkdirSync(catalogsDir, { recursive: true });
        fs.writeFileSync(path.join(catalogsDir, 'Товары.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject version="2.20" xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core">
  <Catalog uuid="11111111-1111-4111-8111-111111111111"><Properties><Name>Товары</Name></Properties><ChildObjects>
    <TabularSection uuid="22222222-2222-4222-8222-222222222222"><Properties><Name>Первая</Name></Properties><ChildObjects><Attribute uuid="33333333-3333-4333-8333-333333333333"><Properties><Name>Значение</Name><Type><v8:Type>xs:string</v8:Type></Type></Properties></Attribute></ChildObjects></TabularSection>
    <TabularSection uuid="44444444-4444-4444-8444-444444444444"><Properties><Name>Вторая</Name></Properties><ChildObjects><Attribute uuid="55555555-5555-4555-8555-555555555555"><Properties><Name>Значение</Name><Type><v8:Type>xs:decimal</v8:Type></Type></Properties></Attribute></ChildObjects></TabularSection>
  </ChildObjects></Catalog>
</MetaDataObject>`, 'utf-8');

        const targetPath = 'Catalog.Товары.TabularSection.Вторая.Attribute.Значение';
        const setResult = await ops.setType({ path: targetPath, types: ['xs:boolean'] });
        assert.ok(setResult.success, setResult.error);
        const getResult = await ops.getType({ path: targetPath });
        assert.ok(getResult.success, getResult.error);
        assert.deepStrictEqual(getResult.data!.types, ['xs:boolean']);

        const dom = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' }).parse(
            fs.readFileSync(path.join(catalogsDir, 'Товары.xml'), 'utf-8')
        );
        const sections = dom.MetaDataObject.Catalog.ChildObjects.TabularSection;
        assert.strictEqual(sections[0].ChildObjects.Attribute.Properties.Type['v8:Type'], 'xs:string');
        assert.strictEqual(sections[1].ChildObjects.Attribute.Properties.Type['v8:Type'], 'xs:boolean');
    });
});

suite('AgentOperations: EventSubscription Source', () => {
    let tmpDir: string;
    let ops: AgentOperations;
    let sourcePath: string;

    setup(async () => {
        tmpDir = await createTempDir('1cviewer-agent-event-source-');
        writeConfigXml(tmpDir);
        const subscriptionsDir = path.join(tmpDir, 'EventSubscriptions');
        fs.mkdirSync(subscriptionsDir, { recursive: true });
        sourcePath = path.join(subscriptionsDir, 'OnWrite.xml');
        fs.writeFileSync(sourcePath, EVENT_SUBSCRIPTION_XML, 'utf-8');
        ops = new AgentOperations(tmpDir);
    });

    teardown(async () => {
        await cleanupTempDir(tmpDir);
    });

    test('reads Source from an EventSubscription XML file', async () => {
        const result = await ops.getSource({ path: 'EventSubscription.OnWrite' });
        assert.ok(result.success, result.error);
        assert.deepStrictEqual(result.data?.types, [
            'cfg:DocumentObject.Receipt',
            'cfg:CatalogObject.Goods',
        ]);
        assert.ok(result.data?.rawXml.includes('<v8:Type>cfg:DocumentObject.Receipt</v8:Type>'));
    });

    test('rejects malformed stored Source entries instead of returning a partial list', async () => {
        const malformedXml = EVENT_SUBSCRIPTION_XML.replace(
            '<v8:Type>cfg:CatalogObject.Goods</v8:Type>',
            '<v8:Type>cfg:CatalogObject.Goods</v8:Type>\n        <v8:Type>cfg:UnknownKind.Invalid</v8:Type>',
        );
        fs.writeFileSync(sourcePath, malformedXml, 'utf-8');

        const result = await ops.getSource({ path: 'EventSubscription.OnWrite' });
        assert.strictEqual(result.success, false);
        assert.ok(result.error, 'invalid stored Source must return a controlled error');
    });

    test('rejects unexpected stored Source elements instead of treating them as empty', async () => {
        const malformedXml = EVENT_SUBSCRIPTION_XML.replace(
            /<Source>[\s\S]*?<\/Source>/,
            '<Source><Unexpected>value</Unexpected></Source>',
        );
        fs.writeFileSync(sourcePath, malformedXml, 'utf-8');

        const result = await ops.getSource({ path: 'EventSubscription.OnWrite' });
        assert.strictEqual(result.success, false);
        assert.ok(result.error, 'unexpected Source structure must return a controlled error');
    });

    test('replaces Source in the file and reads the new list back', async () => {
        const types = [
            'cfg:InformationRegisterRecordSet.Prices',
            'cfg:CatalogManager',
        ];
        const setResult = await ops.setSource({ path: 'EventSubscription.OnWrite', types });
        assert.ok(setResult.success, setResult.error);

        const dom = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })
            .parse(fs.readFileSync(sourcePath, 'utf-8'));
        assert.deepStrictEqual(dom.MetaDataObject.EventSubscription.Properties.Source['v8:Type'], types);
        const getResult = await ops.getSource({ path: 'EventSubscription.OnWrite' });
        assert.ok(getResult.success, getResult.error);
        assert.deepStrictEqual(getResult.data?.types, types);
    });

    test('empty types clear the complete Source property', async () => {
        const setResult = await ops.setSource({ path: 'EventSubscription.OnWrite', types: [] });
        assert.ok(setResult.success, setResult.error);

        const content = fs.readFileSync(sourcePath, 'utf-8');
        const dom = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' }).parse(content);
        assert.deepStrictEqual(dom.MetaDataObject.EventSubscription.Properties.Source, '');
        const getResult = await ops.getSource({ path: 'EventSubscription.OnWrite' });
        assert.ok(getResult.success, getResult.error);
        assert.deepStrictEqual(getResult.data?.types, []);
        assert.ok(content.includes('<Source/>'));
    });

    test('rejects malformed types before writing any part of the requested list', async () => {
        const original = fs.readFileSync(sourcePath, 'utf-8');
        const invalidLists = [
            ['cfg:DocumentObject.Receipt', 'cfg:UnknownKind.Goods'],
            ['cfg:DocumentObject'],
            ['cfg:CatalogManager.Named'],
            ['cfg:CatalogObject.Bad-Name'],
            ['cfg:CatalogObject.<v8:Type>Bad</v8:Type>'],
        ];

        for (const types of invalidLists) {
            const result = await ops.setSource({ path: 'EventSubscription.OnWrite', types });
            assert.strictEqual(result.success, false, `expected rejection for ${types.join(', ')}`);
            assert.strictEqual(fs.readFileSync(sourcePath, 'utf-8'), original, 'invalid input must leave the file untouched');
        }
    });

    test('rejects a non-array or non-string type without writing', async () => {
        const original = fs.readFileSync(sourcePath, 'utf-8');
        const invalidValues = [null, ['cfg:CatalogObject.Goods', 42]];
        for (const types of invalidValues) {
            const result = await ops.setSource({
                path: 'EventSubscription.OnWrite',
                types: types as unknown as string[],
            });
            assert.strictEqual(result.success, false);
            assert.strictEqual(fs.readFileSync(sourcePath, 'utf-8'), original);
        }
    });

    test('rejects non-EventSubscription and nested paths without writing', async () => {
        const original = fs.readFileSync(sourcePath, 'utf-8');
        for (const pathValue of [
            'Catalog.Goods',
            'EventSubscription.OnWrite.Attribute.Source',
            'EventSubscription.OnWrite.TabularSection.Items.Attribute.Source',
        ]) {
            const readResult = await ops.getSource({ path: pathValue });
            assert.strictEqual(readResult.success, false, `getSource must reject ${pathValue}`);
            const writeResult = await ops.setSource({ path: pathValue, types: [] });
            assert.strictEqual(writeResult.success, false, `setSource must reject ${pathValue}`);
            assert.strictEqual(fs.readFileSync(sourcePath, 'utf-8'), original);
        }
    });
});
