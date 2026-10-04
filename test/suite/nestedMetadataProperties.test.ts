import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { AgentOperations } from '../../src/agent/agentOperations';
import { cleanupTempDir, createTempDir } from '../helpers/testHelpers';

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'metadata-properties');

suite('AgentOperations nested metadata properties', () => {
  let tempDir: string;
  let operations: AgentOperations;

  setup(async () => {
    tempDir = await createTempDir('1cviewer-nested-properties-');
    operations = new AgentOperations(tempDir);
    for (const [folder, fixture, objectFile] of [
      ['HTTPServices', 'HTTPService.xml', 'Api.xml'],
      ['WebServices', 'WebService.xml', 'PublicApi.xml'],
      ['Catalogs', 'Catalog.xml', 'Items.xml'],
      ['IntegrationServices', 'IntegrationService.xml', 'Service.xml'],
      ['Tasks', 'Task.xml', 'Tasks.xml'],
      ['ChartsOfAccounts', 'ChartOfAccounts.xml', 'Accounts.xml'],
      ['DocumentJournals', 'DocumentJournal.xml', 'Journal.xml'],
      ['Sequences', 'Sequence.xml', 'Documents.xml'],
    ]) {
      await fs.promises.mkdir(path.join(tempDir, folder), { recursive: true });
      await fs.promises.copyFile(path.join(FIXTURE_DIR, fixture), path.join(tempDir, folder, objectFile));
    }
  });

  teardown(async () => {
    await cleanupTempDir(tempDir);
  });

  test('6-segment HTTP path scopes both reads and writes to the selected URLTemplate and Method', async () => {
    const pathToMethod = 'HTTPService.Api.URLTemplate.SecondRoute.Method.Get';
    const read = await operations.getProperties({ path: pathToMethod });
    assert.strictEqual(read.success, true, read.error);
    assert.strictEqual(read.data?.properties.Handler, 'SecondHandler');

    const write = await operations.setProperties({
      path: pathToMethod,
      properties: { Handler: 'UpdatedSecondHandler' },
    });
    assert.strictEqual(write.success, true, write.error);

    const xml = await fs.promises.readFile(path.join(tempDir, 'HTTPServices', 'Api.xml'), 'utf8');
    assert.deepStrictEqual(Array.from(xml.matchAll(/<Handler>([^<]*)<\/Handler>/g), (match) => match[1]), [
      'FirstHandler',
      'UpdatedSecondHandler',
    ]);
  });

  test('6-segment Web path scopes repeated Parameter names to the selected Operation', async () => {
    const pathToParameter = 'WebService.PublicApi.Operation.SecondOperation.Parameter.Result';
    const read = await operations.getProperties({ path: pathToParameter });
    assert.strictEqual(read.success, true, read.error);
    assert.strictEqual(read.data?.properties.XDTOValueType, 'xs:boolean');

    const write = await operations.setProperties({
      path: pathToParameter,
      properties: { XDTOValueType: 'xs:int' },
    });
    assert.strictEqual(write.success, true, write.error);

    const xml = await fs.promises.readFile(path.join(tempDir, 'WebServices', 'PublicApi.xml'), 'utf8');
    assert.deepStrictEqual(Array.from(xml.matchAll(/<XDTOValueType>([^<]*)<\/XDTOValueType>/g), (match) => match[1]), [
      'xs:string',
      'xs:int',
    ]);
  });

  test('legacy six-segment TabularSection.Attribute path reads the column, not a same-named root attribute', async () => {
    const read = await operations.getProperties({
      path: 'Catalog.Items.TabularSection.Lines.Attribute.Code',
    });
    assert.strictEqual(read.success, true, read.error);
    assert.strictEqual(read.data?.properties.Comment, 'Column attribute');
  });

  test('named inline children are discoverable through supported root and nested paths', async () => {
    const cases: Array<{ rootPath: string; expected: Array<{ type: string; name: string; path: string }> }> = [
      {
        rootPath: 'HTTPService.Api',
        expected: [{ type: 'URLTemplate', name: 'FirstRoute', path: 'HTTPService.Api.URLTemplate.FirstRoute' }, { type: 'URLTemplate', name: 'SecondRoute', path: 'HTTPService.Api.URLTemplate.SecondRoute' }],
      },
      {
        rootPath: 'HTTPService.Api.URLTemplate.SecondRoute',
        expected: [{ type: 'Method', name: 'Get', path: 'HTTPService.Api.URLTemplate.SecondRoute.Method.Get' }],
      },
      {
        rootPath: 'WebService.PublicApi',
        expected: [{ type: 'Operation', name: 'FirstOperation', path: 'WebService.PublicApi.Operation.FirstOperation' }, { type: 'Operation', name: 'SecondOperation', path: 'WebService.PublicApi.Operation.SecondOperation' }],
      },
      {
        rootPath: 'WebService.PublicApi.Operation.SecondOperation',
        expected: [{ type: 'Parameter', name: 'Result', path: 'WebService.PublicApi.Operation.SecondOperation.Parameter.Result' }],
      },
      {
        rootPath: 'IntegrationService.Service',
        expected: [{ type: 'IntegrationServiceChannel', name: 'Inbound', path: 'IntegrationService.Service.IntegrationServiceChannel.Inbound' }],
      },
      {
        rootPath: 'Task.Tasks',
        expected: [{ type: 'AddressingAttribute', name: 'Assignee', path: 'Task.Tasks.AddressingAttribute.Assignee' }],
      },
      {
        rootPath: 'ChartOfAccounts.Accounts',
        expected: [
          { type: 'AccountingFlag', name: 'Foreign', path: 'ChartOfAccounts.Accounts.AccountingFlag.Foreign' },
          { type: 'ExtDimensionAccountingFlag', name: 'Amount', path: 'ChartOfAccounts.Accounts.ExtDimensionAccountingFlag.Amount' },
        ],
      },
      {
        rootPath: 'DocumentJournal.Journal',
        expected: [{ type: 'Column', name: 'Number', path: 'DocumentJournal.Journal.Column.Number' }],
      },
      {
        rootPath: 'Sequence.Documents',
        expected: [{ type: 'Dimension', name: 'Organization', path: 'Sequence.Documents.Dimension.Organization' }],
      },
    ];

    for (const { rootPath, expected } of cases) {
      const result = await operations.listChildren({ path: rootPath });
      assert.strictEqual(result.success, true, `${rootPath}: ${result.error}`);
      assert.deepStrictEqual(result.data?.children, expected, rootPath);
    }
  });

  test('scoped property reads work for confirmed child types outside HTTP and Web services', async () => {
    const cases: Array<{ path: string; property: string; expected: unknown }> = [
      { path: 'IntegrationService.Service.IntegrationServiceChannel.Inbound', property: 'MessageDirection', expected: 'Receive' },
      { path: 'Task.Tasks.AddressingAttribute.Assignee', property: 'Comment', expected: 'Performer address' },
      { path: 'ChartOfAccounts.Accounts.AccountingFlag.Foreign', property: 'Name', expected: 'Foreign' },
      { path: 'ChartOfAccounts.Accounts.ExtDimensionAccountingFlag.Amount', property: 'Name', expected: 'Amount' },
      { path: 'DocumentJournal.Journal.Column.Number', property: 'Title', expected: 'Document number' },
      { path: 'Sequence.Documents.Dimension.Organization', property: 'Use', expected: 'Always' },
    ];

    for (const { path: agentPath, property, expected } of cases) {
      const result = await operations.getProperties({ path: agentPath });
      assert.strictEqual(result.success, true, `${agentPath}: ${result.error}`);
      assert.strictEqual(result.data?.properties[property], expected, agentPath);
    }
  });

  test('ambiguous or missing scoped selectors fail without changing XML', async () => {
    const filePath = path.join(tempDir, 'HTTPServices', 'Api.xml');
    const original = await fs.promises.readFile(filePath, 'utf8');
    const withDuplicate = original.replace(
      /(<Method uuid="55555555-5555-4555-8555-555555555555">[\s\S]*?<\/Method>)/,
      '$1\n          <Method uuid="66666666-6666-4666-8666-666666666666"><Properties><Name>Get</Name><Handler>Duplicate</Handler></Properties></Method>',
    );
    await fs.promises.writeFile(filePath, withDuplicate, 'utf8');

    const duplicatePath = 'HTTPService.Api.URLTemplate.SecondRoute.Method.Get';
    const ambiguousRead = await operations.getProperties({ path: duplicatePath });
    assert.strictEqual(ambiguousRead.success, false);
    assert.match(ambiguousRead.error ?? '', /ambiguous/i);
    const ambiguousWrite = await operations.setProperties({ path: duplicatePath, properties: { Handler: 'Changed' } });
    assert.strictEqual(ambiguousWrite.success, false);
    assert.match(ambiguousWrite.error ?? '', /ambiguous/i);
    assert.strictEqual(await fs.promises.readFile(filePath, 'utf8'), withDuplicate);

    const missingWrite = await operations.setProperties({
      path: 'HTTPService.Api.URLTemplate.Missing.Method.Get',
      properties: { Handler: 'Changed' },
    });
    assert.strictEqual(missingWrite.success, false);
    assert.match(missingWrite.error ?? '', /not found/i);
    assert.strictEqual(await fs.promises.readFile(filePath, 'utf8'), withDuplicate);
  });
});
