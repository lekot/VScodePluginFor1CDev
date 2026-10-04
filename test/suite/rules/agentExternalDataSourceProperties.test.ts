import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { AgentOperations } from '../../../src/agent/agentOperations';
import { createTempDir, cleanupTempDir } from '../../helpers/testHelpers';

const CONFIGURATION_XML = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject version="2.20" xmlns="http://v8.1c.ru/8.3/MDClasses"><Configuration><Properties><Name>TestConfig</Name></Properties><ChildObjects/></Configuration></MetaDataObject>`;

const EXTERNAL_DATA_SOURCE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject version="2.20" xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core">
  <ExternalDataSource uuid="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee">
    <Properties><Name>Warehouse</Name><Synonym>Warehouse source</Synonym></Properties>
    <ChildObjects>
      <Table>Tasks</Table>
      <Table>Logs</Table>
      <Function><Properties><Name>GetTask</Name><Synonym>Get task</Synonym><Comment>inline function</Comment></Properties><ChildObjects/></Function>
    </ChildObjects>
  </ExternalDataSource>
</MetaDataObject>`;

function externalDataSourceTableXml(name: string, sharedComment: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject version="2.20" xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core">
  <Table uuid="11111111-2222-4333-8444-555555555555">
    <Properties><Name>${name}</Name><Synonym>${name} synonym</Synonym><NameInDataSource>${name}</NameInDataSource></Properties>
    <ChildObjects>
      <Field uuid="aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"><Properties><Name>Shared</Name><Comment>${sharedComment}</Comment><Type><v8:Type>xs:string</v8:Type></Type></Properties></Field>
      <Field uuid="bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"><Properties><Name>Only${name}</Name><Comment>unique</Comment></Properties></Field>
    </ChildObjects>
  </Table>
</MetaDataObject>`;
}

suite('AgentOperations: ExternalDataSource metadata properties', () => {
    let tmpDir: string;
    let ops: AgentOperations;
    let sourcePath: string;
    let tasksTablePath: string;
    let logsTablePath: string;

    setup(async () => {
        tmpDir = await createTempDir('1cviewer-agent-eds-');
        fs.writeFileSync(path.join(tmpDir, 'Configuration.xml'), CONFIGURATION_XML, 'utf-8');
        const sourceDir = path.join(tmpDir, 'ExternalDataSources', 'Warehouse');
        const tablesDir = path.join(sourceDir, 'Tables');
        fs.mkdirSync(tablesDir, { recursive: true });
        sourcePath = path.join(tmpDir, 'ExternalDataSources', 'Warehouse.xml');
        tasksTablePath = path.join(tablesDir, 'Tasks.xml');
        logsTablePath = path.join(tablesDir, 'Logs.xml');
        fs.writeFileSync(sourcePath, EXTERNAL_DATA_SOURCE_XML, 'utf-8');
        fs.writeFileSync(tasksTablePath, externalDataSourceTableXml('Tasks', 'tasks original'), 'utf-8');
        fs.writeFileSync(logsTablePath, externalDataSourceTableXml('Logs', 'logs original'), 'utf-8');
        ops = new AgentOperations(tmpDir);
    });

    teardown(async () => {
        await cleanupTempDir(tmpDir);
    });

    test('lists scalar Table references, inline Functions, and file-relative Fields with full public paths', async () => {
        const sourceChildren = await ops.listChildren({ path: 'ExternalDataSource.Warehouse' });
        assert.ok(sourceChildren.success, sourceChildren.error);
        assert.deepStrictEqual(sourceChildren.data?.children, [
            { type: 'Table', name: 'Tasks', path: 'ExternalDataSource.Warehouse.Table.Tasks' },
            { type: 'Table', name: 'Logs', path: 'ExternalDataSource.Warehouse.Table.Logs' },
            { type: 'Function', name: 'GetTask', path: 'ExternalDataSource.Warehouse.Function.GetTask' },
        ]);

        const tableChildren = await ops.listChildren({ path: 'ExternalDataSource.Warehouse.Table.Tasks' });
        assert.ok(tableChildren.success, tableChildren.error);
        assert.deepStrictEqual(tableChildren.data?.children, [
            { type: 'Field', name: 'Shared', path: 'ExternalDataSource.Warehouse.Table.Tasks.Field.Shared' },
            { type: 'Field', name: 'OnlyTasks', path: 'ExternalDataSource.Warehouse.Table.Tasks.Field.OnlyTasks' },
        ]);
    });

    test('reads and writes Table root properties and inline Function properties', async () => {
        const tableRead = await ops.getProperties({ path: 'ExternalDataSource.Warehouse.Table.Tasks' });
        assert.ok(tableRead.success, tableRead.error);
        assert.strictEqual(tableRead.data?.properties.Name, 'Tasks');
        assert.strictEqual(tableRead.data?.properties.Synonym, 'Tasks synonym');

        const tableWrite = await ops.setProperties({
            path: 'ExternalDataSource.Warehouse.Table.Tasks',
            properties: { Synonym: 'Updated tasks' },
        });
        assert.ok(tableWrite.success, tableWrite.error);
        const updatedTable = await ops.getProperties({ path: 'ExternalDataSource.Warehouse.Table.Tasks' });
        assert.ok(updatedTable.success, updatedTable.error);
        assert.strictEqual(updatedTable.data?.properties.Synonym, 'Updated tasks');

        const functionRead = await ops.getProperties({ path: 'ExternalDataSource.Warehouse.Function.GetTask' });
        assert.ok(functionRead.success, functionRead.error);
        assert.strictEqual(functionRead.data?.properties.Comment, 'inline function');
        const functionWrite = await ops.setProperties({
            path: 'ExternalDataSource.Warehouse.Function.GetTask',
            properties: { Comment: 'updated inline function' },
        });
        assert.ok(functionWrite.success, functionWrite.error);
        const updatedFunction = await ops.getProperties({ path: 'ExternalDataSource.Warehouse.Function.GetTask' });
        assert.ok(updatedFunction.success, updatedFunction.error);
        assert.strictEqual(updatedFunction.data?.properties.Comment, 'updated inline function');
    });

    test('updates the selected Field without colliding with same-named Fields in another Table', async () => {
        const fieldRead = await ops.getProperties({ path: 'ExternalDataSource.Warehouse.Table.Tasks.Field.Shared' });
        assert.ok(fieldRead.success, fieldRead.error);
        assert.strictEqual(fieldRead.data?.properties.Comment, 'tasks original');

        const fieldWrite = await ops.setProperties({
            path: 'ExternalDataSource.Warehouse.Table.Tasks.Field.Shared',
            properties: { Comment: 'tasks updated' },
        });
        assert.ok(fieldWrite.success, fieldWrite.error);
        const tasksField = await ops.getProperties({ path: 'ExternalDataSource.Warehouse.Table.Tasks.Field.Shared' });
        const logsField = await ops.getProperties({ path: 'ExternalDataSource.Warehouse.Table.Logs.Field.Shared' });
        assert.ok(tasksField.success, tasksField.error);
        assert.ok(logsField.success, logsField.error);
        assert.strictEqual(tasksField.data?.properties.Comment, 'tasks updated');
        assert.strictEqual(logsField.data?.properties.Comment, 'logs original');

        const fieldType = await ops.getType({ path: 'ExternalDataSource.Warehouse.Table.Tasks.Field.Shared' });
        assert.ok(fieldType.success, fieldType.error);
        assert.deepStrictEqual(fieldType.data?.types, ['xs:string']);
        const setFieldType = await ops.setType({
            path: 'ExternalDataSource.Warehouse.Table.Tasks.Field.Shared',
            types: ['xs:boolean'],
        });
        assert.ok(setFieldType.success, setFieldType.error);
        const updatedFieldType = await ops.getType({ path: 'ExternalDataSource.Warehouse.Table.Tasks.Field.Shared' });
        assert.ok(updatedFieldType.success, updatedFieldType.error);
        assert.deepStrictEqual(updatedFieldType.data?.types, ['xs:boolean']);
    });

    test('does not write when the referenced Table file is missing or invalid XML', async () => {
        const originalSource = fs.readFileSync(sourcePath, 'utf-8');
        const missingResult = await ops.setProperties({
            path: 'ExternalDataSource.Warehouse.Table.Missing',
            properties: { Synonym: 'must not create file' },
        });
        assert.strictEqual(missingResult.success, false);
        assert.strictEqual(fs.existsSync(path.join(path.dirname(tasksTablePath), 'Missing.xml')), false);
        assert.strictEqual(fs.readFileSync(sourcePath, 'utf-8'), originalSource);

        const orphanPath = path.join(path.dirname(tasksTablePath), 'Orphan.xml');
        const orphanXml = externalDataSourceTableXml('Orphan', 'must stay unchanged');
        fs.writeFileSync(orphanPath, orphanXml, 'utf-8');
        const unreferencedResult = await ops.setProperties({
            path: 'ExternalDataSource.Warehouse.Table.Orphan',
            properties: { Synonym: 'must not update unreferenced table' },
        });
        assert.strictEqual(unreferencedResult.success, false);
        assert.strictEqual(fs.readFileSync(orphanPath, 'utf-8'), orphanXml);

        const invalidXml = '<MetaDataObject version="2.20"><Table><Properties><Name>Tasks</Name>';
        fs.writeFileSync(tasksTablePath, invalidXml, 'utf-8');
        const invalidResult = await ops.setProperties({
            path: 'ExternalDataSource.Warehouse.Table.Tasks',
            properties: { Synonym: 'must not overwrite malformed XML' },
        });
        assert.strictEqual(invalidResult.success, false);
        assert.strictEqual(fs.readFileSync(tasksTablePath, 'utf-8'), invalidXml);
    });

    test('keeps root-only and non-EDS attribute operations away from separate Table files', async () => {
        const originalSource = fs.readFileSync(sourcePath, 'utf-8');
        const originalTable = fs.readFileSync(tasksTablePath, 'utf-8');

        const deleteResult = await ops.deleteObject({ path: 'ExternalDataSource.Warehouse.Table.Tasks' });
        const renameResult = await ops.renameObject({ path: 'ExternalDataSource.Warehouse.Table.Tasks', newName: 'Renamed' });
        const attributeResult = await ops.addAttribute({ path: 'ExternalDataSource.Warehouse.Table.Tasks', name: 'WrongKind' });
        const tabularResult = await ops.addTabularSection({ path: 'ExternalDataSource.Warehouse.Table.Tasks', name: 'WrongKind' });

        assert.strictEqual(deleteResult.success, false);
        assert.strictEqual(renameResult.success, false);
        assert.strictEqual(attributeResult.success, false);
        assert.strictEqual(tabularResult.success, false);
        assert.strictEqual(fs.existsSync(tasksTablePath), true);
        assert.strictEqual(fs.readFileSync(sourcePath, 'utf-8'), originalSource);
        assert.strictEqual(fs.readFileSync(tasksTablePath, 'utf-8'), originalTable);
    });
});
