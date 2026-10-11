import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { AgentOperations } from '../../src/agent/agentOperations';
import { MetadataType } from '../../src/models/treeNode';
import { MutationPlanExecutor } from '../../src/services/configurationSession/mutationPlan';
import {
  clearDesignerTemplateRepositoryForTests,
  initDesignerTemplateRepository,
} from '../../src/services/designerTemplateRepository';
import { planCreateMetadataObject } from '../../src/services/metadataCrudService';
import { createTempDir, cleanupTempDir } from '../helpers/testHelpers';

const MINIMAL_CONFIG_XML = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject version="2.20" xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core">
  <Configuration uuid="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee">
    <Properties><Name>TestConfig</Name></Properties>
    <ChildObjects/>
  </Configuration>
</MetaDataObject>`;

const REGISTERED_RECORDER_CONFIG_XML = MINIMAL_CONFIG_XML.replace(
  '<ChildObjects/>',
  '<ChildObjects><Document>Recorder</Document></ChildObjects>',
);

const CFE_CONFIG_XML = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject version="2.20" xmlns="http://v8.1c.ru/8.3/MDClasses">
  <Configuration uuid="bbbbbbbb-cccc-dddd-eeee-ffffffffffff">
    <Properties>
      <Name>Extension</Name>
      <ConfigurationExtensionPurpose>Customization</ConfigurationExtensionPurpose>
      <NamePrefix>Ext_</NamePrefix>
    </Properties>
    <ChildObjects/>
  </Configuration>
</MetaDataObject>`;

const RECORDER_DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Document uuid="11111111-2222-3333-4444-555555555555">
    <Properties><Name>Recorder</Name></Properties>
    <ChildObjects/>
    <RegisterRecords/>
  </Document>
</MetaDataObject>`;

const normalizeGeneratedUuids = (value: string): string =>
  value.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<generated-uuid>');

const normalizeSteps = (steps: readonly { type: string; [key: string]: unknown }[]) =>
  steps.map((step) => step.type === 'writeFile'
    ? { ...step, content: normalizeGeneratedUuids(String(step['content'])) }
    : step);

suite('Metadata create parity', () => {
  let tempRoot: string;

  setup(async () => {
    tempRoot = await createTempDir('1cviewer-create-parity-');
    initDesignerTemplateRepository(path.resolve('.'));
    await fs.promises.writeFile(path.join(tempRoot, 'Configuration.xml'), MINIMAL_CONFIG_XML, 'utf8');
  });

  teardown(async () => {
    clearDesignerTemplateRepositoryForTests();
    await cleanupTempDir(tempRoot);
  });

  test('BusinessProcess plans its companion Task and writes Configuration.xml once', async () => {
    const context = { configurationRootPath: tempRoot };
    const planned = await planCreateMetadataObject(context, {
      type: MetadataType.BusinessProcess,
      name: 'Approval',
    });
    const taskFile = path.join(tempRoot, 'Tasks', 'Approval.xml');
    const configurationFile = path.join(tempRoot, 'Configuration.xml');
    const configWrites = planned.plan.steps.filter((step) => step.type === 'writeFile' && step.targetPath === configurationFile);

    assert.strictEqual(configWrites.length, 1, 'all root registrations must be merged into one Configuration.xml write');
    assert.ok(planned.impact.writePaths.includes(taskFile), 'impact must report the companion Task descriptor');
    assert.ok(planned.impact.directoryPaths.includes(path.join(tempRoot, 'Tasks', 'Approval')));

    await new MutationPlanExecutor(tempRoot).execute(planned.plan);
    assert.ok(fs.existsSync(taskFile), 'the companion Task descriptor must be created');
    assert.ok(fs.existsSync(path.join(tempRoot, 'Tasks', 'Approval')), 'the companion Task directory must be created');
    const configuration = await fs.promises.readFile(configurationFile, 'utf8');
    assert.match(configuration, /<BusinessProcess>Approval<\/BusinessProcess>/);
    assert.match(configuration, /<Task>Approval<\/Task>/);
  });

  test('BusinessProcess create rejects a CFE name before planning either root object', async () => {
    const configurationPath = path.join(tempRoot, 'Configuration.xml');
    await fs.promises.writeFile(configurationPath, CFE_CONFIG_XML, 'utf8');

    await assert.rejects(
      () => planCreateMetadataObject({ configurationRootPath: tempRoot }, {
        type: MetadataType.BusinessProcess,
        name: 'Approval',
      }),
      /NamePrefix CFE/i,
    );
    assert.strictEqual(fs.existsSync(path.join(tempRoot, 'BusinessProcesses', 'Approval.xml')), false);
    assert.strictEqual(fs.existsSync(path.join(tempRoot, 'Tasks', 'Approval.xml')), false);
    assert.strictEqual(await fs.promises.readFile(configurationPath, 'utf8'), CFE_CONFIG_XML);
  });

  test('BusinessProcess companion Task is admitted against its resolved CFE scope before either write', async () => {
    const parentConfiguration = CFE_CONFIG_XML;
    const nestedTaskConfiguration = CFE_CONFIG_XML.replace('<NamePrefix>Ext_</NamePrefix>', '<NamePrefix>Task_</NamePrefix>');
    const configurationPath = path.join(tempRoot, 'Configuration.xml');
    await fs.promises.writeFile(configurationPath, parentConfiguration, 'utf8');
    const tasksFolder = path.join(tempRoot, 'Tasks');
    await fs.promises.mkdir(tasksFolder, { recursive: true });
    await fs.promises.writeFile(path.join(tasksFolder, 'Configuration.xml'), nestedTaskConfiguration, 'utf8');

    await assert.rejects(
      () => planCreateMetadataObject({ configurationRootPath: tempRoot }, {
        type: MetadataType.BusinessProcess,
        name: 'Ext_Approval',
      }),
      /NamePrefix CFE/i,
    );
    assert.strictEqual(fs.existsSync(path.join(tempRoot, 'BusinessProcesses', 'Ext_Approval.xml')), false);
    assert.strictEqual(fs.existsSync(path.join(tasksFolder, 'Ext_Approval.xml')), false);
    assert.strictEqual(await fs.promises.readFile(configurationPath, 'utf8'), parentConfiguration);
  });

  test('BusinessProcess reuses an already registered Task without duplicate registration or overwrite', async () => {
    const taskName = 'Ext_Approval';
    const configurationXml = CFE_CONFIG_XML.replace(
      '<ChildObjects/>',
      `<ChildObjects><Task>${taskName}</Task></ChildObjects>`,
    );
    await fs.promises.writeFile(path.join(tempRoot, 'Configuration.xml'), configurationXml, 'utf8');
    const taskPath = path.join(tempRoot, 'Tasks', `${taskName}.xml`);
    await fs.promises.mkdir(path.dirname(taskPath), { recursive: true });
    const existingTask = `<MetaDataObject><Task><Properties><Name>${taskName}</Name></Properties></Task></MetaDataObject>`;
    await fs.promises.writeFile(taskPath, existingTask, 'utf8');

    const planned = await planCreateMetadataObject({ configurationRootPath: tempRoot }, {
      type: MetadataType.BusinessProcess,
      name: taskName,
    });
    const taskWrites = planned.plan.steps.filter((step) => step.type === 'writeFile' && step.targetPath === taskPath);
    const configWrite = planned.plan.steps.filter((step) => step.type === 'writeFile' && step.targetPath === path.join(tempRoot, 'Configuration.xml'));

    assert.strictEqual(taskWrites.length, 0, 'the existing Task descriptor must not be overwritten');
    assert.strictEqual(configWrite.length, 1, 'BusinessProcess and existing Task registrations share one final config write');
    await new MutationPlanExecutor(tempRoot).execute(planned.plan);
    assert.strictEqual(await fs.promises.readFile(taskPath, 'utf8'), existingTask);
    const updatedConfiguration = await fs.promises.readFile(path.join(tempRoot, 'Configuration.xml'), 'utf8');
    assert.strictEqual(updatedConfiguration.match(/<Task>Ext_Approval<\/Task>/g)?.length, 1);
    assert.match(updatedConfiguration, /<BusinessProcess>Ext_Approval<\/BusinessProcess>/);
  });

  test('Agent dry-run reports the BusinessProcess companion Task without writing files', async () => {
    const configurationPath = path.join(tempRoot, 'Configuration.xml');
    const originalConfiguration = await fs.promises.readFile(configurationPath, 'utf8');
    const taskPath = path.join(tempRoot, 'Tasks', 'DryRunApproval.xml');
    const taskDirectory = path.join(tempRoot, 'Tasks', 'DryRunApproval');
    const result = await new AgentOperations(tempRoot).createObject({
      type: 'BusinessProcess',
      name: 'DryRunApproval',
      dryRun: true,
    });

    assert.strictEqual(result.success, true);
    const data = result.data as { dryRun?: boolean; plannedChanges?: { files?: string[] } };
    assert.strictEqual(data.dryRun, true);
    assert.ok(data.plannedChanges?.files?.includes(taskPath), 'dry-run must include the Task descriptor');
    assert.ok(data.plannedChanges?.files?.includes(taskDirectory), 'dry-run must include the Task directory');
    assert.ok(data.plannedChanges?.files?.includes(configurationPath), 'dry-run must include Configuration.xml');
    assert.strictEqual(fs.existsSync(taskPath), false);
    assert.strictEqual(await fs.promises.readFile(configurationPath, 'utf8'), originalConfiguration);
  });

  test('CommonModule plans and creates Ext/Module/Module.bsl', async () => {
    const planned = await planCreateMetadataObject({ configurationRootPath: tempRoot }, {
      type: MetadataType.CommonModule,
      name: 'SharedLogic',
    });
    const modulePath = path.join(tempRoot, 'CommonModules', 'SharedLogic', 'Ext', 'Module', 'Module.bsl');
    assert.ok(planned.impact.writePaths.includes(modulePath));

    await new MutationPlanExecutor(tempRoot).execute(planned.plan);
    assert.strictEqual(await fs.promises.readFile(modulePath, 'utf8'), '');
  });

  test('DocumentJournal recorder and AccumulationRegister reverse link are planned with expected file state', async () => {
    await fs.promises.writeFile(path.join(tempRoot, 'Configuration.xml'), REGISTERED_RECORDER_CONFIG_XML, 'utf8');
    const documentsDir = path.join(tempRoot, 'Documents');
    await fs.promises.mkdir(documentsDir, { recursive: true });
    const recorderPath = path.join(documentsDir, 'Recorder.xml');
    await fs.promises.writeFile(recorderPath, RECORDER_DOCUMENT_XML, 'utf8');

    const context = { configurationRootPath: tempRoot };
    const journal = await planCreateMetadataObject(context, {
      type: MetadataType.DocumentJournal,
      name: 'Operations',
      recorderDocument: 'Recorder',
    } as any);
    const agentJournal = await new AgentOperations(tempRoot).planCreateObject({
      type: 'DocumentJournal',
      name: 'Operations',
      recorderDocument: 'Recorder',
    } as any);
    const journalContent = journal.plan.steps.find((step) => step.type === 'writeFile' && step.targetPath.endsWith(`${path.sep}Operations.xml`));
    assert.ok(journalContent && journalContent.type === 'writeFile');
    assert.match(journalContent.content, /<xr:Item[^>]*>Document\.Recorder<\/xr:Item>/);
    assert.deepStrictEqual(normalizeSteps(agentJournal.steps), normalizeSteps(journal.plan.steps));

    const register = await planCreateMetadataObject(context, {
      type: MetadataType.AccumulationRegister,
      name: 'InventoryBalance',
      recorderDocument: 'Recorder',
    } as any);
    const recorderWrite = register.plan.steps.find((step) => step.type === 'writeFile' && step.targetPath === recorderPath);
    assert.ok(recorderWrite && recorderWrite.type === 'writeFile', 'existing recorder XML must be part of the mutation plan');
    assert.deepStrictEqual(recorderWrite.expected, {
      state: 'file',
      hash: require('../../src/services/configurationSession/atomicFileStorage').hashContent(RECORDER_DOCUMENT_XML),
    });
    assert.match(recorderWrite.content, /<xr:Item xsi:type="xr:MDObjectRef">AccumulationRegister\.InventoryBalance<\/xr:Item>/);
    assert.ok(register.impact.writePaths.includes(recorderPath));
    assert.strictEqual(
      register.plan.steps.filter((step) => step.type === 'writeFile' && step.targetPath === path.join(tempRoot, 'Configuration.xml')).length,
      1,
    );

    const agentRegister = await new AgentOperations(tempRoot).planCreateObject({
      type: 'AccumulationRegister',
      name: 'InventoryBalance',
      recorderDocument: 'Recorder',
    } as any);
    assert.deepStrictEqual(normalizeSteps(agentRegister.steps), normalizeSteps(register.plan.steps));

    const dryRun = await new AgentOperations(tempRoot).createObject({
      type: 'AccumulationRegister',
      name: 'DryRunInventory',
      recorderDocument: 'Recorder',
      dryRun: true,
    });
    assert.strictEqual(dryRun.success, true);
    const dryRunFiles = (dryRun.data as { plannedChanges?: { files?: string[] } }).plannedChanges?.files ?? [];
    assert.ok(dryRunFiles.includes(recorderPath), 'dry-run must expose the existing recorder XML write');
    assert.ok(dryRunFiles.includes(path.join(tempRoot, 'AccumulationRegisters', 'DryRunInventory.xml')));
    assert.ok(dryRunFiles.includes(path.join(tempRoot, 'Configuration.xml')));
    assert.strictEqual(await fs.promises.readFile(recorderPath, 'utf8'), RECORDER_DOCUMENT_XML);
  });

  test('recorder targets must exist and be registered before a create plan can reference them', async () => {
    await assert.rejects(
      () => planCreateMetadataObject({ configurationRootPath: tempRoot }, {
        type: MetadataType.AccumulationRegister,
        name: 'InventoryBalance',
        recorderDocument: 'Missing',
      } as any),
      /recorder|регистратор|registered|зарегистрирован/i,
    );
  });

  test('AccumulationRegister fails closed when its registered recorder lacks RegisterRecords', async () => {
    await fs.promises.writeFile(path.join(tempRoot, 'Configuration.xml'), REGISTERED_RECORDER_CONFIG_XML, 'utf8');
    const recorderPath = path.join(tempRoot, 'Documents', 'Recorder.xml');
    await fs.promises.mkdir(path.dirname(recorderPath), { recursive: true });
    await fs.promises.writeFile(recorderPath,
      '<MetaDataObject><Document><Properties><Name>Recorder</Name></Properties></Document></MetaDataObject>',
      'utf8');
    const originalConfiguration = await fs.promises.readFile(path.join(tempRoot, 'Configuration.xml'), 'utf8');

    await assert.rejects(
      () => planCreateMetadataObject({ configurationRootPath: tempRoot }, {
        type: MetadataType.AccumulationRegister,
        name: 'InventoryBalance',
        recorderDocument: 'Recorder',
      }),
      /RegisterRecords/i,
    );
    assert.strictEqual(fs.existsSync(path.join(tempRoot, 'AccumulationRegisters', 'InventoryBalance.xml')), false);
    assert.strictEqual(await fs.promises.readFile(path.join(tempRoot, 'Documents', 'Recorder.xml'), 'utf8'),
      '<MetaDataObject><Document><Properties><Name>Recorder</Name></Properties></Document></MetaDataObject>');
    assert.strictEqual(await fs.promises.readFile(path.join(tempRoot, 'Configuration.xml'), 'utf8'), originalConfiguration);
  });

  test('ChartOfAccounts wizard values produce the same detailed plan through Agent and domain entrypoints', async () => {
    const chartOfAccounts = {
      codeMask: '@@.@@',
      codeLength: 5,
      descriptionLength: 240,
      orderLength: 6,
      extDimensionTypes: 'ChartOfCharacteristicTypes.Analytics',
      maxExtDimensionCount: 4,
      accountingFlags: [{ name: 'Currency', synonym: 'Валютный учет' }],
      extDimensionAccountingFlags: [{ name: 'Amount', synonym: 'Суммовой учет' }],
      predefinedAccounts: [{ name: 'Main', code: '000', description: 'Основной счет', order: '000' }],
    };
    const request = {
      type: MetadataType.ChartOfAccounts,
      name: 'Ledger',
      synonym: 'Главная книга',
      chartOfAccounts,
    } as any;
    const planned = await planCreateMetadataObject({ configurationRootPath: tempRoot }, request);
    const agent = await new AgentOperations(tempRoot).planCreateObject({
      ...request,
      type: 'ChartOfAccounts',
    });
    assert.deepStrictEqual(normalizeSteps(agent.steps), normalizeSteps(planned.plan.steps));

    const descriptorPath = path.join(tempRoot, 'ChartsOfAccounts', 'Ledger.xml');
    const predefinedPath = path.join(tempRoot, 'ChartsOfAccounts', 'Ledger', 'Ext', 'Predefined.xml');
    const descriptor = planned.plan.steps.find((step) => step.type === 'writeFile' && step.targetPath === descriptorPath);
    const predefined = planned.plan.steps.find((step) => step.type === 'writeFile' && step.targetPath === predefinedPath);
    assert.ok(descriptor && descriptor.type === 'writeFile');
    assert.match(descriptor.content, /<CodeMask>@@\.@@<\/CodeMask>/);
    assert.match(descriptor.content, /<MaxExtDimensionCount>4<\/MaxExtDimensionCount>/);
    assert.match(descriptor.content, /<AccountingFlag\b/);
    assert.ok(predefined && predefined.type === 'writeFile');
    assert.match(predefined.content, /<Name>Main<\/Name>/);
    assert.ok(planned.impact.writePaths.includes(predefinedPath));
    assert.strictEqual(
      planned.plan.steps.filter((step) => step.type === 'writeFile' && step.targetPath === path.join(tempRoot, 'Configuration.xml')).length,
      1,
    );

    await new MutationPlanExecutor(tempRoot).execute(planned.plan);
    assert.ok(fs.existsSync(descriptorPath));
    assert.ok(fs.existsSync(predefinedPath));
  });

  test('FilterCriterion content and type options produce the same plan through Agent and domain entrypoints', async () => {
    const catalogDir = path.join(tempRoot, 'Catalogs');
    await fs.promises.mkdir(catalogDir, { recursive: true });
    await fs.promises.writeFile(path.join(catalogDir, 'Fixture.xml'),
      `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses"><Catalog uuid="c1"><Properties><Name>Fixture</Name></Properties><ChildObjects><Attribute uuid="a1"><Properties><Name>Code</Name><Type><v8:Type>xs:string</v8:Type></Type></Properties></Attribute></ChildObjects></Catalog></MetaDataObject>`,
      'utf8');
    const properties = {
      types: ['xs:string'],
      content: ['Catalog.Fixture.Attribute.Code'],
      comment: 'Selected catalog value',
      useStandardCommands: true,
    };
    const planned = await planCreateMetadataObject({ configurationRootPath: tempRoot }, {
      type: MetadataType.FilterCriterion,
      name: 'ByCode',
      synonym: 'По коду',
      filterCriterion: properties,
    } as any);
    const agent = await new AgentOperations(tempRoot).planCreateObject({
      type: 'FilterCriterion',
      name: 'ByCode',
      synonym: 'По коду',
      properties: {
        Type: properties.types,
        Content: properties.content,
        Comment: properties.comment,
        UseStandardCommands: properties.useStandardCommands,
      },
    });

    assert.deepStrictEqual(normalizeSteps(agent.steps), normalizeSteps(planned.plan.steps));
    const descriptorPath = path.join(tempRoot, 'FilterCriteria', 'ByCode.xml');
    const descriptor = planned.plan.steps.find((step) => step.type === 'writeFile' && step.targetPath === descriptorPath);
    assert.ok(descriptor && descriptor.type === 'writeFile');
    assert.match(descriptor.content, /Catalog\.Fixture\.Attribute\.Code/);
    assert.match(descriptor.content, /Selected catalog value/);
    assert.match(descriptor.content, /<UseStandardCommands>true<\/UseStandardCommands>/);
    assert.strictEqual(
      planned.plan.steps.filter((step) => step.type === 'writeFile' && step.targetPath === path.join(tempRoot, 'Configuration.xml')).length,
      1,
    );

    await new MutationPlanExecutor(tempRoot).execute(planned.plan);
    assert.ok(fs.existsSync(descriptorPath));
  });
});
