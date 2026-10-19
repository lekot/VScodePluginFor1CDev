import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { AgentOperations } from '../../src/agent/agentOperations';
import { MetadataType, type TreeNode } from '../../src/models/treeNode';
import {
  deleteElement,
  duplicateElement,
  planDuplicateRootElement,
  planRenameRootElement,
} from '../../src/services/elementOperations';
import {
  planCreateMetadataObject,
  planDeleteMetadataObject,
} from '../../src/services/metadataCrudService';
import { MutationPlanExecutor, type MutationPlan } from '../../src/services/configurationSession/mutationPlan';
import {
  clearDesignerTemplateRepositoryForTests,
  initDesignerTemplateRepository,
} from '../../src/services/designerTemplateRepository';
import { createTempDir, cleanupTempDir } from '../helpers/testHelpers';
import { XmlParser } from '../../src/parsers/xmlParser';

interface DuplicateMetadataPlan {
  readonly plan: MutationPlan<void>;
  readonly impact: {
    readonly affectedPaths: readonly string[];
    readonly writePaths: readonly string[];
    readonly directoryPaths: readonly string[];
    readonly deletePaths: readonly string[];
  };
}

const duplicateMetadataPlanner = (require('../../src/services/metadataCrudService') as {
  planDuplicateMetadataObject?: (
    context: { readonly configurationRootPath: string },
    request: { readonly type: MetadataType; readonly sourceName: string; readonly newName: string },
  ) => Promise<DuplicateMetadataPlan>;
}).planDuplicateMetadataObject;

function requireDuplicateMetadataPlanner(): NonNullable<typeof duplicateMetadataPlanner> {
  if (!duplicateMetadataPlanner) {
    throw new Error('planDuplicateMetadataObject is not implemented.');
  }
  return duplicateMetadataPlanner;
}

const MINIMAL_CONFIG_XML = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject version="2.20" xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core">
  <Configuration uuid="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee">
    <Properties><Name>TestConfig</Name></Properties>
    <ChildObjects/>
  </Configuration>
</MetaDataObject>`;

suite('MetadataCrudService', () => {
  let tempRoot: string;

  setup(async () => {
    tempRoot = await createTempDir('1cviewer-metadata-crud-');
    initDesignerTemplateRepository(path.resolve(__dirname, '../../..'));
    await fs.promises.writeFile(path.join(tempRoot, 'Configuration.xml'), MINIMAL_CONFIG_XML, 'utf8');
  });

  teardown(async () => {
    clearDesignerTemplateRepositoryForTests();
    await cleanupTempDir(tempRoot);
  });

  test('Sequence create/delete plans carry impact and preserve the Agent root-object behavior', async () => {
    const context = { configurationRootPath: tempRoot };
    const create = await planCreateMetadataObject(context, {
      type: MetadataType.Sequence,
      name: 'PostingOrder',
    });
    const sequenceFile = path.join(tempRoot, 'Sequences', 'PostingOrder.xml');
    const sequenceDirectory = path.join(tempRoot, 'Sequences', 'PostingOrder');
    const configurationFile = path.join(tempRoot, 'Configuration.xml');

    assert.deepStrictEqual(create.plan.result, { filePath: sequenceFile });
    assert.strictEqual('success' in (create.plan.result as object), false);
    assert.ok(create.impact.affectedPaths.includes(sequenceFile));
    assert.ok(create.impact.affectedPaths.includes(configurationFile));
    assert.ok(create.impact.writePaths.includes(sequenceFile));
    assert.ok(create.impact.directoryPaths.includes(sequenceDirectory));

    const agentCreate = await new AgentOperations(tempRoot).planCreateObject({
      type: 'Sequence',
      name: 'PostingOrder',
    });
    assert.strictEqual(agentCreate.result.success, true);
    assert.strictEqual(agentCreate.kind, 'agent.createObject');
    assert.strictEqual(create.plan.kind, 'metadata.create');
    const normalizeGeneratedUuids = (content: string): string =>
      content.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<generated-uuid>');
    const normalizeCreateSteps = (steps: typeof create.plan.steps) => steps.map((step) =>
      step.type === 'writeFile'
        ? { ...step, content: normalizeGeneratedUuids(step.content) }
        : step,
    );
    assert.deepStrictEqual(normalizeCreateSteps(agentCreate.steps), normalizeCreateSteps(create.plan.steps));

    await new MutationPlanExecutor(tempRoot).execute(create.plan);
    assert.ok(fs.existsSync(sequenceFile));
    assert.ok(fs.existsSync(sequenceDirectory));
    assert.match(await fs.promises.readFile(configurationFile, 'utf8'), /<Sequence>PostingOrder<\/Sequence>/);

    const deletion = await planDeleteMetadataObject(context, {
      type: MetadataType.Sequence,
      name: 'PostingOrder',
    });
    const agentDelete = await new AgentOperations(tempRoot).planDeleteObject({ path: 'Sequence.PostingOrder' });
    assert.deepStrictEqual(agentDelete.steps, deletion.plan.steps);
    assert.strictEqual(agentDelete.kind, 'agent.deleteObject');
    assert.strictEqual(deletion.plan.kind, 'metadata.delete');
    assert.strictEqual(agentDelete.result.success, true);
    assert.ok(deletion.impact.affectedPaths.includes(sequenceFile));
    assert.ok(deletion.impact.deletePaths.includes(sequenceFile));
    assert.ok(deletion.impact.deletePaths.includes(sequenceDirectory));
    assert.ok(deletion.impact.writePaths.includes(configurationFile));

    await new MutationPlanExecutor(tempRoot).execute(deletion.plan);
    assert.strictEqual(fs.existsSync(sequenceFile), false);
    assert.strictEqual(fs.existsSync(sequenceDirectory), false);
    assert.doesNotMatch(await fs.promises.readFile(configurationFile, 'utf8'), /<Sequence>PostingOrder<\/Sequence>/);
  });

  test('Sequence create with recorderDocument populates Documents MDObjectRef and validates registration', async () => {
    const context = { configurationRootPath: tempRoot };
    const configWithDoc = MINIMAL_CONFIG_XML.replace(
      '<ChildObjects/>',
      '<ChildObjects><Document>DocRecorder</Document></ChildObjects>',
    );
    await fs.promises.writeFile(path.join(tempRoot, 'Configuration.xml'), configWithDoc, 'utf8');
    await fs.promises.mkdir(path.join(tempRoot, 'Documents'), { recursive: true });
    await fs.promises.writeFile(
      path.join(tempRoot, 'Documents', 'DocRecorder.xml'),
      recorderDocumentXml('DocRecorder', ''),
      'utf8',
    );

    await assert.rejects(
      () =>
        planCreateMetadataObject(context, {
          type: MetadataType.Sequence,
          name: 'SeqMissingDoc',
          recorderDocument: 'NonExistentDoc',
        }),
      /NonExistentDoc/,
    );

    const create = await planCreateMetadataObject(context, {
      type: MetadataType.Sequence,
      name: 'SeqWithDoc',
      recorderDocument: 'DocRecorder',
    });
    await new MutationPlanExecutor(tempRoot).execute(create.plan);

    const seqXml = await fs.promises.readFile(path.join(tempRoot, 'Sequences', 'SeqWithDoc.xml'), 'utf8');
    assert.match(
      seqXml,
      /<Documents>\s*<xr:Item\s+xsi:type="xr:MDObjectRef">Document\.DocRecorder<\/xr:Item>\s*<\/Documents>/,
      'Sequence XML must contain participating Document in <Documents>',
    );
    assert.match(seqXml, /<InternalInfo>[\s\S]*?<xr:GeneratedType\s+name="SequenceRecord\.SeqWithDoc"/);
  });

  test('AccountingRegister create applies rules-backed overrides to its Designer template and links valid references', async () => {
    const context = { configurationRootPath: tempRoot };
    await createRootMetadataObject(context, MetadataType.ChartOfAccounts, 'Main');
    await createRootMetadataObject(context, MetadataType.Document, 'Recorder');

    const create = await planCreateMetadataObject(context, {
      type: MetadataType.AccountingRegister,
      name: 'ReviewAccounting',
      synonym: 'Синоним <&',
      recorderDocument: 'Recorder',
      properties: {
        chartOfAccounts: 'ChartOfAccounts.Main',
        comment: 'SENTINEL <& " \'',
        correspondence: false,
        periodAdjustmentLength: 0,
        useStandardCommands: false,
      },
    });
    await new MutationPlanExecutor(tempRoot).execute(create.plan);

    const registerXml = await fs.promises.readFile(
      path.join(tempRoot, 'AccountingRegisters', 'ReviewAccounting.xml'),
      'utf8',
    );
    assert.match(registerXml, /<ChartOfAccounts>ChartOfAccounts\.Main<\/ChartOfAccounts>/);
    assert.match(registerXml, /<Comment>SENTINEL &lt;&amp;/);
    assert.match(registerXml, /<Correspondence>false<\/Correspondence>/);
    assert.match(registerXml, /<PeriodAdjustmentLength>0<\/PeriodAdjustmentLength>/);
    assert.match(registerXml, /<UseStandardCommands>false<\/UseStandardCommands>/);
    assert.match(registerXml, /<v8:content>Синоним &lt;&amp;<\/v8:content>/);
    assert.match(registerXml, /<ListPresentation\s*\/>/, 'unoverridden ListPresentation must retain its template default');
    assert.match(registerXml, /<ExtendedListPresentation\s*\/>/, 'unoverridden ExtendedListPresentation must retain its template default');
    assert.match(registerXml, /<Dimension\s+uuid=/, 'the rich Designer template Dimension must be retained');
    assert.match(registerXml, /<Resource\s+uuid=/, 'the rich Designer template Resource must be retained');
    assert.strictEqual(readRootProperties(registerXml, 'AccountingRegister')['Comment'], 'SENTINEL <& " \'');

    const documentXml = await fs.promises.readFile(path.join(tempRoot, 'Documents', 'Recorder.xml'), 'utf8');
    assert.match(documentXml, /<RegisterRecords>[\s\S]*?AccountingRegister\.ReviewAccounting[\s\S]*?<\/RegisterRecords>/);

    await assert.rejects(
      () => planCreateMetadataObject(context, {
        type: MetadataType.AccountingRegister,
        name: 'ReviewAccountingMissingRecorder',
        properties: { chartOfAccounts: 'ChartOfAccounts.Main', comment: 'must not be planned' },
        recorderDocument: 'MissingRecorder',
      }),
      /MissingRecorder/,
    );
    assert.strictEqual(
      fs.existsSync(path.join(tempRoot, 'AccountingRegisters', 'ReviewAccountingMissingRecorder.xml')),
      false,
      'invalid recorder references must fail before a mutation plan can be executed',
    );
  });

  test('CalculationRegister create applies rules-backed overrides to its Designer template and links valid references', async () => {
    const context = { configurationRootPath: tempRoot };
    await createRootMetadataObject(context, MetadataType.ChartOfCalculationTypes, 'Main');
    await createRootMetadataObject(context, MetadataType.Document, 'Recorder');

    const create = await planCreateMetadataObject(context, {
      type: MetadataType.CalculationRegister,
      name: 'ReviewCalculation',
      synonym: 'Расчёт <&',
      recorderDocument: 'Recorder',
      properties: {
        chartOfCalculationTypes: 'ChartOfCalculationTypes.Main',
        comment: 'CALC <&',
        basePeriod: true,
        actionPeriod: false,
        useStandardCommands: false,
      },
    });
    await new MutationPlanExecutor(tempRoot).execute(create.plan);

    const registerXml = await fs.promises.readFile(
      path.join(tempRoot, 'CalculationRegisters', 'ReviewCalculation.xml'),
      'utf8',
    );
    assert.match(registerXml, /<ChartOfCalculationTypes>ChartOfCalculationTypes\.Main<\/ChartOfCalculationTypes>/);
    assert.match(registerXml, /<Comment>CALC &lt;&amp;<\/Comment>/);
    assert.match(registerXml, /<BasePeriod>true<\/BasePeriod>/);
    assert.match(registerXml, /<ActionPeriod>false<\/ActionPeriod>/);
    assert.match(registerXml, /<UseStandardCommands>false<\/UseStandardCommands>/);
    assert.match(registerXml, /<v8:content>Расчёт &lt;&amp;<\/v8:content>/);
    assert.match(registerXml, /<ListPresentation\s*\/>/, 'unoverridden ListPresentation must retain its template default');
    assert.match(registerXml, /<ExtendedListPresentation\s*\/>/, 'unoverridden ExtendedListPresentation must retain its template default');
    assert.match(registerXml, /<Dimension\s+uuid=/, 'the rich Designer template Dimension must be retained');
    assert.match(registerXml, /<Resource\s+uuid=/, 'the rich Designer template Resource must be retained');
    assert.strictEqual(readRootProperties(registerXml, 'CalculationRegister')['Comment'], 'CALC <&');

    const documentXml = await fs.promises.readFile(path.join(tempRoot, 'Documents', 'Recorder.xml'), 'utf8');
    assert.match(documentXml, /<RegisterRecords>[\s\S]*?CalculationRegister\.ReviewCalculation[\s\S]*?<\/RegisterRecords>/);

    await assert.rejects(
      () => planCreateMetadataObject(context, {
        type: MetadataType.CalculationRegister,
        name: 'ReviewCalculationMissingRecorder',
        properties: { chartOfCalculationTypes: 'ChartOfCalculationTypes.Main', comment: 'must not be planned' },
        recorderDocument: 'MissingRecorder',
      }),
      /MissingRecorder/,
    );
    assert.strictEqual(
      fs.existsSync(path.join(tempRoot, 'CalculationRegisters', 'ReviewCalculationMissingRecorder.xml')),
      false,
      'invalid recorder references must fail before a mutation plan can be executed',
    );
  });

  test('register create preserves template defaults when no property overrides are requested', async () => {
    const context = { configurationRootPath: tempRoot };
    for (const { type, name, rootTag } of [
      { type: MetadataType.AccountingRegister, name: 'TemplateAccounting', rootTag: 'AccountingRegister' },
      { type: MetadataType.CalculationRegister, name: 'TemplateCalculation', rootTag: 'CalculationRegister' },
    ]) {
      const create = await planCreateMetadataObject(context, { type, name });
      await new MutationPlanExecutor(tempRoot).execute(create.plan);
      const registerPath = path.join(
        tempRoot,
        type === MetadataType.AccountingRegister ? 'AccountingRegisters' : 'CalculationRegisters',
        `${name}.xml`,
      );
      const registerXml = await fs.promises.readFile(registerPath, 'utf8');
      assert.match(registerXml, /<ListPresentation\s*\/>/, `${rootTag} ListPresentation should retain its template default`);
      assert.match(registerXml, /<ExtendedListPresentation\s*\/>/, `${rootTag} ExtendedListPresentation should retain its template default`);
      if (type === MetadataType.AccountingRegister) {
        assert.match(registerXml, /<PeriodAdjustmentLength>3<\/PeriodAdjustmentLength>/,
          'AccountingRegister PeriodAdjustmentLength should retain its Designer template default');
      }
    }
  });

  test('AccumulationRegister deletion cleans exact RegisterRecords items in every registered Document', async () => {
    const fixture = await createRegisterDeleteFixture(tempRoot, ['RecorderOne', 'RecorderTwo'], ['Unregistered']);
    const oneBefore = recorderDocumentXml('RecorderOne', [
      '<xr:Item xsi:type="xr:MDObjectRef">AccumulationRegister.Target</xr:Item>',
      '<xr:Item xsi:type="xr:MDObjectRef">AccumulationRegister.TargetExtra</xr:Item>',
      '<xr:Item xsi:type="xr:MDObjectRef">InformationRegister.Target</xr:Item>',
    ].join('\n'));
    const twoBefore = recorderDocumentXml('RecorderTwo',
      '<xr:Item xsi:type="xr:MDObjectRef">AccumulationRegister.Target</xr:Item>');
    const unregisteredBefore = recorderDocumentXml('Unregistered',
      '<xr:Item xsi:type="xr:MDObjectRef">AccumulationRegister.Target</xr:Item>');
    await fs.promises.writeFile(fixture.documents.get('RecorderOne')!, oneBefore, 'utf8');
    await fs.promises.writeFile(fixture.documents.get('RecorderTwo')!, twoBefore, 'utf8');
    await fs.promises.writeFile(fixture.documents.get('Unregistered')!, unregisteredBefore, 'utf8');

    const deletion = await planDeleteMetadataObject({ configurationRootPath: tempRoot }, {
      type: MetadataType.AccumulationRegister,
      name: 'Target',
    });
    const agentDeletion = await new AgentOperations(tempRoot).planDeleteObject({
      path: 'AccumulationRegister.Target',
    });
    assert.deepStrictEqual(agentDeletion.steps, deletion.plan.steps);
    const writes = deletion.plan.steps.filter((step) => step.type === 'writeFile');
    const recorderWrites = writes.filter((step) => step.targetPath === fixture.documents.get('RecorderOne')
      || step.targetPath === fixture.documents.get('RecorderTwo'));
    assert.deepStrictEqual(recorderWrites.map((step) => step.targetPath).sort(), [
      fixture.documents.get('RecorderOne')!,
      fixture.documents.get('RecorderTwo')!,
    ].sort());
    assert.ok(!writes.some((step) => step.targetPath === fixture.documents.get('Unregistered')));
    assert.ok(deletion.impact.affectedPaths.includes(fixture.documents.get('RecorderOne')!));
    assert.ok(deletion.impact.affectedPaths.includes(fixture.documents.get('RecorderTwo')!));
    assert.ok(deletion.impact.writePaths.includes(fixture.documents.get('RecorderOne')!));
    assert.ok(deletion.impact.writePaths.includes(fixture.documents.get('RecorderTwo')!));

    const registerDeleteIndex = deletion.plan.steps.findIndex((step) => step.type === 'deletePath'
      && step.targetPath === fixture.registerPath);
    assert.ok(registerDeleteIndex >= 0);
    assert.ok(recorderWrites.every((step) => deletion.plan.steps.indexOf(step) < registerDeleteIndex),
      'authoritative recorder cleanup is planned before destructive delete steps');

    await new MutationPlanExecutor(tempRoot).execute(deletion.plan);
    const oneAfter = await fs.promises.readFile(fixture.documents.get('RecorderOne')!, 'utf8');
    const oneRecords = oneAfter.match(/<RegisterRecords>([\s\S]*?)<\/RegisterRecords>/)?.[1] ?? '';
    assert.doesNotMatch(oneRecords, /<xr:Item[^>]*>AccumulationRegister\.Target<\/xr:Item>/);
    assert.match(oneRecords, /AccumulationRegister\.TargetExtra/);
    assert.match(oneRecords, /InformationRegister\.Target/);
    assert.match(oneAfter, /<Wrapper><xr:Item[^>]*>AccumulationRegister\.Target<\/xr:Item><\/Wrapper>/,
      'same reference outside RegisterRecords is preserved');
    const twoAfter = await fs.promises.readFile(fixture.documents.get('RecorderTwo')!, 'utf8');
    assert.doesNotMatch(twoAfter.match(/<RegisterRecords>([\s\S]*?)<\/RegisterRecords>/)?.[1] ?? '',
      /AccumulationRegister\.Target/);
    assert.strictEqual(await fs.promises.readFile(fixture.documents.get('Unregistered')!, 'utf8'), unregisteredBefore);
  });

  test('AccumulationRegister cleanup follows the Designer Document/Properties template and preserves lookalikes', async () => {
    const fixture = await createRegisterDeleteFixture(tempRoot, ['RecorderOne', 'RecorderTwo'], ['Unregistered']);
    const templatePath = path.join(process.cwd(), 'resources', 'designerTemplates', 'Designer', 'Document.xml');
    const template = await fs.promises.readFile(templatePath, 'utf8');
    const nestedReference = '<xr:Item xsi:type="xr:MDObjectRef">AccumulationRegister.Target</xr:Item>';
    const recorderOneBefore = designerTemplateRecorderDocumentXml(template, 'RecorderOne', '11111111-1111-4111-8111-111111111111', [
      nestedReference,
      '<xr:Item xsi:type="xs:string">AccumulationRegister.Target</xr:Item>',
      '<xr:Item xsi:type="xr:MDObjectRef">AccumulationRegister.TargetExtra</xr:Item>',
      '<xr:Item xsi:type="xr:MDObjectRef">InformationRegister.Target</xr:Item>',
    ].join('\n'), nestedReference);
    const recorderTwoBefore = designerTemplateRecorderDocumentXml(template, 'RecorderTwo', '22222222-2222-4222-8222-222222222222', [
      nestedReference,
      '<xr:Item xsi:type="xs:string">AccumulationRegister.Target</xr:Item>',
      '<xr:Item xsi:type="xr:MDObjectRef">AccumulationRegister.TargetExtra</xr:Item>',
      '<xr:Item xsi:type="xr:MDObjectRef">InformationRegister.Target</xr:Item>',
    ].join('\n'), nestedReference);
    const unregisteredBefore = designerTemplateRecorderDocumentXml(template, 'Unregistered', '33333333-3333-4333-8333-333333333333', nestedReference, nestedReference);
    await fs.promises.writeFile(fixture.documents.get('RecorderOne')!, recorderOneBefore, 'utf8');
    await fs.promises.writeFile(fixture.documents.get('RecorderTwo')!, recorderTwoBefore, 'utf8');
    await fs.promises.writeFile(fixture.documents.get('Unregistered')!, unregisteredBefore, 'utf8');

    const deletion = await planDeleteMetadataObject({ configurationRootPath: tempRoot }, {
      type: MetadataType.AccumulationRegister,
      name: 'Target',
    });
    await new MutationPlanExecutor(tempRoot).execute(deletion.plan);

    for (const name of ['RecorderOne', 'RecorderTwo']) {
      const xml = await fs.promises.readFile(fixture.documents.get(name)!, 'utf8');
      const propertiesRecords = extractPropertiesRegisterRecords(xml);
      assert.doesNotMatch(propertiesRecords, /<xr:Item\s+xsi:type="xr:MDObjectRef">AccumulationRegister\.Target<\/xr:Item>/,
        'the exact metadata reference in Document/Properties/RegisterRecords is removed');
      assert.match(propertiesRecords, /<xr:Item\s+xsi:type="xs:string">AccumulationRegister\.Target<\/xr:Item>/,
        'an Item with matching text but a different xsi:type is retained');
      assert.match(propertiesRecords, /AccumulationRegister\.TargetExtra/);
      assert.match(propertiesRecords, /InformationRegister\.Target/);
      const nestedRecords = xml.match(/<Wrapper><RegisterRecords>([\s\S]*?)<\/RegisterRecords><\/Wrapper>/)?.[1];
      assert.strictEqual(nestedRecords, nestedReference,
        'a nested RegisterRecords section outside Document/Properties is preserved');
    }
    assert.strictEqual(await fs.promises.readFile(fixture.documents.get('Unregistered')!, 'utf8'), unregisteredBefore,
      'unregistered documents are not rewritten');
  });

  test('Agent delete dryRun reports recorder documents in plan impact', async () => {
    const fixture = await createRegisterDeleteFixture(tempRoot, ['Recorder']);
    await fs.promises.writeFile(fixture.documents.get('Recorder')!, recorderDocumentXml('Recorder',
      '<xr:Item xsi:type="xr:MDObjectRef">AccumulationRegister.Target</xr:Item>'), 'utf8');

    const result = await new AgentOperations(tempRoot).deleteObject({
      path: 'AccumulationRegister.Target',
      dryRun: true,
    });
    assert.strictEqual(result.success, true, result.error);
    const data = result.data as { plannedChanges?: { files?: string[] } } | undefined;
    assert.ok(data?.plannedChanges?.files?.includes(fixture.documents.get('Recorder')!));
    assert.ok(fs.existsSync(fixture.registerPath), 'dryRun must not delete the register');
  });

  test('direct root deleteElement executes the shared recorder cleanup plan', async () => {
    const fixture = await createRegisterDeleteFixture(tempRoot, ['RecorderOne', 'RecorderTwo']);
    for (const name of ['RecorderOne', 'RecorderTwo']) {
      await fs.promises.writeFile(fixture.documents.get(name)!, recorderDocumentXml(name,
        '<xr:Item xsi:type="xr:MDObjectRef">AccumulationRegister.Target</xr:Item>'), 'utf8');
    }
    const configurationNode: TreeNode = {
      id: 'Configuration', name: 'Configuration', type: MetadataType.Configuration,
      filePath: path.join(tempRoot, 'Configuration.xml'), properties: {},
    };
    const folderNode: TreeNode = {
      id: 'AccumulationRegisters', name: 'AccumulationRegisters', type: MetadataType.AccumulationRegister,
      filePath: path.join(tempRoot, 'AccumulationRegisters'), parent: configurationNode, properties: {},
    };
    const registerNode: TreeNode = {
      id: 'AccumulationRegisters.Target', name: 'Target', type: MetadataType.AccumulationRegister,
      filePath: fixture.registerPath, parent: folderNode, properties: {},
    };
    const previousRecorder = process.env.IBCMD_RECORDER_DOCUMENT;
    delete process.env.IBCMD_RECORDER_DOCUMENT;
    try {
      await deleteElement(registerNode);
    } finally {
      if (previousRecorder === undefined) {
        delete process.env.IBCMD_RECORDER_DOCUMENT;
      } else {
        process.env.IBCMD_RECORDER_DOCUMENT = previousRecorder;
      }
    }

    assert.ok(!fs.existsSync(fixture.registerPath));
    for (const name of ['RecorderOne', 'RecorderTwo']) {
      const xml = await fs.promises.readFile(fixture.documents.get(name)!, 'utf8');
      assert.doesNotMatch(xml.match(/<RegisterRecords>([\s\S]*?)<\/RegisterRecords>/)?.[1] ?? '',
        /AccumulationRegister\.Target/);
    }
  });

  test('delete planning fails closed for malformed or inaccessible registered Documents', async () => {
    const fixture = await createRegisterDeleteFixture(tempRoot, ['Broken']);
    const brokenPath = fixture.documents.get('Broken')!;
    await fs.promises.writeFile(brokenPath, '<MetaDataObject><Document><RegisterRecords>', 'utf8');
    await assert.rejects(() => planDeleteMetadataObject({ configurationRootPath: tempRoot }, {
      type: MetadataType.AccumulationRegister,
      name: 'Target',
    }));
    assert.ok(fs.existsSync(fixture.registerPath));

    await fs.promises.rm(brokenPath);
    await fs.promises.mkdir(brokenPath);
    await assert.rejects(() => planDeleteMetadataObject({ configurationRootPath: tempRoot }, {
      type: MetadataType.AccumulationRegister,
      name: 'Target',
    }));
    assert.ok(fs.existsSync(fixture.registerPath));
  });

  test('recorder-document writes retain CAS expectations and abort delete after a concurrent edit', async () => {
    const fixture = await createRegisterDeleteFixture(tempRoot, ['Recorder']);
    const original = recorderDocumentXml('Recorder',
      '<xr:Item xsi:type="xr:MDObjectRef">AccumulationRegister.Target</xr:Item>');
    await fs.promises.writeFile(fixture.documents.get('Recorder')!, original, 'utf8');
    const deletion = await planDeleteMetadataObject({ configurationRootPath: tempRoot }, {
      type: MetadataType.AccumulationRegister,
      name: 'Target',
    });

    const concurrentEdit = original.replace('<Name>Recorder</Name>', '<Name>RecorderEdited</Name>');
    await fs.promises.writeFile(fixture.documents.get('Recorder')!, concurrentEdit, 'utf8');
    await assert.rejects(() => new MutationPlanExecutor(tempRoot).execute(deletion.plan), /conflict|changed/i);
    assert.ok(fs.existsSync(fixture.registerPath), 'CAS conflict must preserve the register');
    assert.strictEqual(await fs.promises.readFile(fixture.documents.get('Recorder')!, 'utf8'), concurrentEdit);
  });

  test('Sequence supports the existing UI root rename and duplicate planners', async () => {
    const context = { configurationRootPath: tempRoot };
    const executor = new MutationPlanExecutor(tempRoot);
    const sourceName = 'PostingOrder';
    const duplicateName = 'PostingOrderCopy';
    const renamedName = 'PostingOrderRenamed';
    const sourcePath = path.join(tempRoot, 'Sequences', `${sourceName}.xml`);
    const duplicatePath = path.join(tempRoot, 'Sequences', `${duplicateName}.xml`);
    const renamedPath = path.join(tempRoot, 'Sequences', `${renamedName}.xml`);

    const create = await planCreateMetadataObject(context, {
      type: MetadataType.Sequence,
      name: sourceName,
    });
    await executor.execute(create.plan);

    const configurationNode: TreeNode = {
      id: 'Configuration',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
    };
    const folderNode: TreeNode = {
      id: 'Sequences',
      name: 'Sequences',
      type: MetadataType.Sequence,
      filePath: path.join(tempRoot, 'Sequences'),
      parent: configurationNode,
      children: [],
      properties: {},
    };
    const sourceNode: TreeNode = {
      id: `Sequences.${sourceName}`,
      name: sourceName,
      type: MetadataType.Sequence,
      filePath: sourcePath,
      parent: folderNode,
      properties: {},
    };
    folderNode.children = [sourceNode];

    const duplicatePlan = await planDuplicateRootElement(sourceNode, duplicateName);
    await executor.execute(duplicatePlan);
    assert.ok(fs.existsSync(duplicatePath), 'Sequence duplicate planner should create a root descriptor');
    assert.match(
      await fs.promises.readFile(path.join(tempRoot, 'Configuration.xml'), 'utf8'),
      /<Sequence>PostingOrderCopy<\/Sequence>/,
    );
    const sourceUuid = (await fs.promises.readFile(sourcePath, 'utf8')).match(/<Sequence\b[^>]*\buuid="([^"]+)"/)?.[1];
    const duplicateUuid = (await fs.promises.readFile(duplicatePath, 'utf8')).match(/<Sequence\b[^>]*\buuid="([^"]+)"/)?.[1];
    assert.ok(sourceUuid);
    assert.ok(duplicateUuid);
    assert.notStrictEqual(duplicateUuid, sourceUuid, 'Sequence duplicate should receive a new root UUID');

    const duplicateNode: TreeNode = {
      id: `Sequences.${duplicateName}`,
      name: duplicateName,
      type: MetadataType.Sequence,
      filePath: duplicatePath,
      parent: folderNode,
      properties: {},
    };
    folderNode.children = [sourceNode, duplicateNode];
    const renamePlan = await planRenameRootElement(sourceNode, renamedName, tempRoot);
    await executor.execute(renamePlan);

    assert.strictEqual(fs.existsSync(sourcePath), false, 'Sequence rename should remove the old descriptor');
    assert.ok(fs.existsSync(renamedPath), 'Sequence rename should publish the renamed descriptor');
    const configuration = await fs.promises.readFile(path.join(tempRoot, 'Configuration.xml'), 'utf8');
    assert.match(configuration, /<Sequence>PostingOrderRenamed<\/Sequence>/);
    assert.match(configuration, /<Sequence>PostingOrderCopy<\/Sequence>/);
  });

  test('root duplicate plans have common UI/Agent parity and preserve XML, identities, binary artifacts and impact', async () => {
    const fixture = await createCatalogDuplicateFixture(tempRoot, 'Source');
    const sourcePath = path.join(tempRoot, 'Catalogs', 'Source.xml');
    const sourceDirectory = path.join(tempRoot, 'Catalogs', 'Source');
    const targetPath = path.join(tempRoot, 'Catalogs', 'SourceCopy.xml');
    const targetDirectory = path.join(tempRoot, 'Catalogs', 'SourceCopy');
    const targetXmlPath = path.join(targetDirectory, 'Forms', 'Main.xml');
    const targetBinaryPath = path.join(targetDirectory, 'Forms', 'Main.bin');
    const configurationPath = path.join(tempRoot, 'Configuration.xml');
    const sourceContent = await fs.promises.readFile(sourcePath, 'utf8');
    const configurationContent = await fs.promises.readFile(configurationPath, 'utf8');
    const sourceMtime = (await fs.promises.stat(sourcePath)).mtimeMs;
    const sourceUuid = sourceContent.match(/<Catalog\b[^>]*\buuid="([^"]+)"/)?.[1];
    assert.ok(sourceUuid);

    const duplicatePlanner = requireDuplicateMetadataPlanner();
    const common = await duplicatePlanner({ configurationRootPath: tempRoot }, {
      type: MetadataType.Catalog,
      sourceName: 'Source',
      newName: 'SourceCopy',
    });
    const uiPlan = await planDuplicateRootElement(catalogTreeNode(tempRoot, 'Source'), 'SourceCopy');
    const agentOperations = new AgentOperations(tempRoot) as AgentOperations & {
      planDuplicateObject?: (params: { path: string; newName: string }) => Promise<MutationPlan<unknown>>;
    };
    assert.strictEqual(typeof agentOperations.planDuplicateObject, 'function');
    const agentPlan = await agentOperations.planDuplicateObject!({ path: 'Catalog.Source', newName: 'SourceCopy' });

    const normalizedSteps = (plan: MutationPlan<unknown>) => plan.steps.map((step) => step.type === 'writeFile'
      ? { ...step, content: step.content.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<generated-uuid>') }
      : step);
    assert.deepStrictEqual(normalizedSteps(uiPlan), normalizedSteps(common.plan));
    assert.deepStrictEqual(normalizedSteps(agentPlan), normalizedSteps(common.plan));
    assert.strictEqual(agentPlan.kind, 'agent.duplicateObject');
    await assert.rejects(
      () => agentOperations.planRenameObject({ path: 'Catalog.Source.Attribute.Code', newName: 'CodeRenamed' }),
      /renameObject supports only a root object path/i,
    );
    await assert.rejects(
      () => agentOperations.planDuplicateObject!({ path: 'Catalog.Source.Attribute.Code', newName: 'CodeCopy' }),
      /root object path/i,
    );
    assert.ok(common.impact.affectedPaths.includes(targetPath));
    assert.ok(common.impact.affectedPaths.includes(targetXmlPath));
    assert.ok(common.impact.affectedPaths.includes(targetBinaryPath));
    assert.ok(common.impact.affectedPaths.includes(configurationPath));
    assert.ok(common.impact.writePaths.includes(targetBinaryPath));
    assert.ok(common.impact.directoryPaths.includes(targetDirectory));
    assert.ok(!common.impact.affectedPaths.includes(sourcePath), 'the read-only source CAS check is not a mutation impact');
    assert.ok(!common.impact.affectedPaths.includes(sourceDirectory), 'the read-only directory CAS check is not a mutation impact');
    assert.ok(!common.impact.directoryPaths.includes(sourceDirectory), 'the source tree is never a planned output directory');

    await new MutationPlanExecutor(tempRoot).execute(common.plan);
    assert.strictEqual(await fs.promises.readFile(sourcePath, 'utf8'), sourceContent);
    assert.strictEqual((await fs.promises.stat(sourcePath)).mtimeMs, sourceMtime,
      'duplicating must not rewrite or touch the source descriptor');
    const duplicateContent = await fs.promises.readFile(targetPath, 'utf8');
    const duplicateUuid = duplicateContent.match(/<Catalog\b[^>]*\buuid="([^"]+)"/)?.[1];
    assert.ok(duplicateUuid);
    assert.notStrictEqual(duplicateUuid, sourceUuid, 'the root UUID is regenerated');
    assert.match(duplicateContent, /<Name>SourceCopy<\/Name>/);
    assert.match(duplicateContent, /<v8:content>SourceCopy<\/v8:content>/);
    assert.match(duplicateContent, /name="CatalogObject\.SourceCopy"/);
    assert.match(duplicateContent, /CatalogObject\.SourceArchive/,
      'an identity with a similar name is not rewritten');
    assert.match(duplicateContent, /Catalog\.SourceArchive/,
      'a similarly named reference is not rewritten');

    const sourceMainXml = await fs.promises.readFile(fixture.mainXmlPath, 'utf8');
    const duplicateMainXml = await fs.promises.readFile(targetXmlPath, 'utf8');
    const sourceThisNode = sourceMainXml.match(/<ThisNode>([^<]+)<\/ThisNode>/)?.[1];
    const duplicateThisNode = duplicateMainXml.match(/<ThisNode>([^<]+)<\/ThisNode>/)?.[1];
    assert.ok(sourceThisNode && duplicateThisNode);
    assert.notStrictEqual(duplicateThisNode, sourceThisNode, 'bundle identities are regenerated');
    assert.strictEqual(duplicateThisNode, duplicateContent.match(/<xr:TypeId>([^<]+)<\/xr:TypeId>/)?.[1],
      'shared identity references inside the copied bundle use the same remapped UUID');
    assert.deepStrictEqual(await fs.promises.readFile(targetBinaryPath), fixture.binaryContent,
      'non-XML bundle artifacts are copied byte for byte');
    assert.match(await fs.promises.readFile(configurationPath, 'utf8'), /<Catalog>SourceCopy<\/Catalog>/);

    const agentDuplicate = agentOperations as AgentOperations & {
      duplicateObject?: (params: { path: string; newName: string }) => Promise<{ success: boolean; error?: string }>;
    };
    assert.strictEqual(typeof agentDuplicate.duplicateObject, 'function');
    const agentResult = await agentDuplicate.duplicateObject!({ path: 'Catalog.Source', newName: 'SourceAgentCopy' });
    assert.strictEqual(agentResult.success, true, agentResult.error);
    assert.ok(fs.existsSync(path.join(tempRoot, 'Catalogs', 'SourceAgentCopy.xml')));

    await duplicateElement(catalogTreeNode(tempRoot, 'Source'), 'SourceDirectCopy');
    assert.ok(fs.existsSync(path.join(tempRoot, 'Catalogs', 'SourceDirectCopy.xml')),
      'the direct root duplicate entry point delegates to the shared planner and executor');
  });

  test('duplicate planner rejects target collisions, invalid root scope and malformed or unreadable sources', async () => {
    const fixture = await createCatalogDuplicateFixture(tempRoot, 'Source');
    const duplicatePlanner = requireDuplicateMetadataPlanner();
    const catalogsPath = path.join(tempRoot, 'Catalogs');
    await fs.promises.writeFile(path.join(catalogsPath, 'ExistingFile.xml'), '<existing/>', 'utf8');
    await fs.promises.mkdir(path.join(catalogsPath, 'ExistingDirectory'));
    const configurationPath = path.join(tempRoot, 'Configuration.xml');
    const configuration = await fs.promises.readFile(configurationPath, 'utf8');
    await fs.promises.writeFile(configurationPath,
      configuration.replace('</ChildObjects>', '<Catalog>RegisteredOnly</Catalog></ChildObjects>'), 'utf8');

    await assert.rejects(() => duplicatePlanner({ configurationRootPath: tempRoot }, {
      type: MetadataType.Catalog, sourceName: 'Source', newName: 'ExistingFile',
    }), /already exists|File already exists|уже существует/i);
    await assert.rejects(() => duplicatePlanner({ configurationRootPath: tempRoot }, {
      type: MetadataType.Catalog, sourceName: 'Source', newName: 'ExistingDirectory',
    }), /directory already exists|Каталог объекта уже существует/i);
    await assert.rejects(() => duplicatePlanner({ configurationRootPath: tempRoot }, {
      type: MetadataType.Catalog, sourceName: 'Source', newName: 'RegisteredOnly',
    }), /already registered|уже зарегистрирован/i);
    await assert.rejects(() => duplicatePlanner({ configurationRootPath: tempRoot }, {
      type: MetadataType.Attribute, sourceName: 'Source', newName: 'NestedCopy',
    }), /root object|supported Designer root/i);

    await fs.promises.writeFile(fixture.sourcePath, '<MetaDataObject><Catalog>', 'utf8');
    await assert.rejects(() => duplicatePlanner({ configurationRootPath: tempRoot }, {
      type: MetadataType.Catalog, sourceName: 'Source', newName: 'MalformedCopy',
    }), /Malformed XML/i);

    await fs.promises.writeFile(fixture.sourcePath, catalogSourceXml('Source'), 'utf8');
    const originalReadFile = fs.promises.readFile;
    try {
      (fs.promises as any).readFile = async (filePath: fs.PathLike, ...args: unknown[]) => {
        if (path.resolve(String(filePath)) === path.resolve(fixture.sourcePath)) {
          const error = new Error('EACCES: simulated source read failure');
          (error as NodeJS.ErrnoException).code = 'EACCES';
          throw error;
        }
        return (originalReadFile as (...values: unknown[]) => Promise<Buffer | string>).call(fs.promises, filePath, ...args);
      };
      await assert.rejects(() => duplicatePlanner({ configurationRootPath: tempRoot }, {
        type: MetadataType.Catalog, sourceName: 'Source', newName: 'UnreadableCopy',
      }), /EACCES|source read failure/i);
    } finally {
      fs.promises.readFile = originalReadFile;
    }
  });

  test('duplicate planner rejects companion artifacts that escape the configuration through a symlink', async function () {
    const fixture = await createCatalogDuplicateFixture(tempRoot, 'Source');
    const externalRoot = await createTempDir('1cviewer-duplicate-outside-');
    const linkedDirectory = path.join(path.dirname(fixture.mainXmlPath), 'External');
    await fs.promises.writeFile(path.join(externalRoot, 'outside.bin'), Buffer.from([1, 2, 3]));
    try {
      await fs.promises.symlink(externalRoot, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      await cleanupTempDir(externalRoot);
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') {
        this.skip();
        return;
      }
      throw error;
    }

    try {
      await assert.rejects(
        () => requireDuplicateMetadataPlanner()({ configurationRootPath: tempRoot }, {
          type: MetadataType.Catalog,
          sourceName: 'Source',
          newName: 'EscapingCopy',
        }),
        (error: unknown) => Boolean(error && typeof error === 'object'
          && (error as { code?: string }).code === 'PATH_OUTSIDE_ROOT'),
      );
      assert.strictEqual(fs.existsSync(path.join(tempRoot, 'Catalogs', 'EscapingCopy.xml')), false);
      assert.strictEqual(fs.existsSync(path.join(tempRoot, 'Catalogs', 'EscapingCopy')), false);
    } finally {
      await cleanupTempDir(externalRoot);
    }
  });

  test('duplicate source CAS rejects stale plans before publishing any target and leaves source bytes untouched', async () => {
    const fixture = await createCatalogDuplicateFixture(tempRoot, 'Source');
    const duplicatePlanner = requireDuplicateMetadataPlanner();
    const plan = await duplicatePlanner({ configurationRootPath: tempRoot }, {
      type: MetadataType.Catalog, sourceName: 'Source', newName: 'StaleCopy',
    });
    const changedSource = catalogSourceXml('Source').replace('</Properties>', '<Description>Changed</Description></Properties>');
    await fs.promises.writeFile(fixture.sourcePath, changedSource, 'utf8');
    const configurationBefore = await fs.promises.readFile(path.join(tempRoot, 'Configuration.xml'), 'utf8');

    await assert.rejects(() => new MutationPlanExecutor(tempRoot).execute(plan.plan), /Pre-state changed|conflict/i);
    assert.strictEqual(await fs.promises.readFile(fixture.sourcePath, 'utf8'), changedSource);
    assert.strictEqual(await fs.promises.readFile(path.join(tempRoot, 'Configuration.xml'), 'utf8'), configurationBefore);
    assert.strictEqual(fs.existsSync(path.join(tempRoot, 'Catalogs', 'StaleCopy.xml')), false);
  });

  test('duplicate source directory CAS rejects companion XML changes after planning', async () => {
    await assertDuplicateDirectoryConflict(tempRoot, async (fixture) => {
      const xml = await fs.promises.readFile(fixture.mainXmlPath, 'utf8');
      await fs.promises.writeFile(fixture.mainXmlPath, xml.replace('<Name>Main</Name>', '<Name>Changed</Name>'), 'utf8');
    }, 'Forms/Main.xml');
  });

  test('duplicate source directory CAS rejects binary artifact changes after planning', async () => {
    await assertDuplicateDirectoryConflict(tempRoot, async (fixture) => {
      await fs.promises.writeFile(path.join(path.dirname(fixture.mainXmlPath), 'Main.bin'), Buffer.from([9, 8, 7]));
    }, 'Forms/Main.bin');
  });

  test('duplicate source directory CAS rejects membership changes after planning', async () => {
    await assertDuplicateDirectoryConflict(tempRoot, async (fixture) => {
      await fs.promises.writeFile(path.join(path.dirname(fixture.mainXmlPath), 'AddedAfterPlanning.bin'), Buffer.from([1, 2, 3]));
    }, 'Forms/AddedAfterPlanning.bin');
  });

  test('duplicate source directory CAS rejects a directory that appears after planning', async () => {
    const fixture = await createCatalogDuplicateFixture(tempRoot, 'Source');
    const sourceDirectory = path.join(tempRoot, 'Catalogs', 'Source');
    await fs.promises.rm(sourceDirectory, { recursive: true, force: true });
    const configurationPath = path.join(tempRoot, 'Configuration.xml');
    const configurationBefore = await fs.promises.readFile(configurationPath, 'utf8');
    const plan = await requireDuplicateMetadataPlanner()({ configurationRootPath: tempRoot }, {
      type: MetadataType.Catalog,
      sourceName: 'Source',
      newName: 'AppearedDirectoryCopy',
    });
    await fs.promises.mkdir(sourceDirectory, { recursive: true });
    const addedContent = Buffer.from([4, 5, 6]);
    const addedPath = path.join(sourceDirectory, 'AddedAfterPlanning.bin');
    await fs.promises.writeFile(addedPath, addedContent);

    await assert.rejects(
      () => new MutationPlanExecutor(tempRoot).execute(plan.plan),
      (error: unknown) => Boolean(error && typeof error === 'object'
        && (error as { code?: string }).code === 'PLAN_CONFLICT'),
    );
    assert.deepStrictEqual(await fs.promises.readFile(addedPath), addedContent, 'source directory content remains untouched');
    assert.strictEqual(await fs.promises.readFile(configurationPath, 'utf8'), configurationBefore);
    assert.strictEqual(fs.existsSync(path.join(tempRoot, 'Catalogs', 'AppearedDirectoryCopy.xml')), false);
    assert.strictEqual(fs.existsSync(path.join(tempRoot, 'Catalogs', 'AppearedDirectoryCopy')), false);
    assert.ok(fs.existsSync(fixture.sourcePath), 'the source descriptor remains present');
  });

  test('duplicate source assertion stays read-only and rollback restores copies after a later step failure', async () => {
    const fixture = await createCatalogDuplicateFixture(tempRoot, 'Source');
    const sourceDirectoryPath = path.join(tempRoot, 'Catalogs', 'Source');
    const sourceStat = await fs.promises.stat(fixture.sourcePath);
    const sourceContent = await fs.promises.readFile(fixture.sourcePath, 'utf8');
    const sourceBinaryContent = await fs.promises.readFile(path.join(sourceDirectoryPath, 'Forms', 'Main.bin'));
    const configurationPath = path.join(tempRoot, 'Configuration.xml');
    const configurationContent = await fs.promises.readFile(configurationPath, 'utf8');
    const duplicatePlanner = requireDuplicateMetadataPlanner();
    const plan = await duplicatePlanner({ configurationRootPath: tempRoot }, {
      type: MetadataType.Catalog, sourceName: 'Source', newName: 'RollbackCopy',
    });
    const originalMkdir = fs.promises.mkdir;
    const originalCopyFile = fs.promises.copyFile;
    const failingDirectory = path.join(tempRoot, 'Catalogs', 'RollbackCopy', 'Forms');
    let failLaterStep = true;
    let sourceWasBackedUp = false;
    try {
      (fs.promises as any).mkdir = async (directory: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
        if (failLaterStep && path.resolve(String(directory)) === path.resolve(failingDirectory)) {
          failLaterStep = false;
          throw new Error('Simulated companion directory creation failure');
        }
        return originalMkdir.call(fs.promises, directory, options);
      };
      (fs.promises as any).copyFile = async (source: fs.PathLike, destination: fs.PathLike, ...args: unknown[]) => {
        const sourcePath = path.resolve(String(source));
        if (sourcePath === path.resolve(fixture.sourcePath)
          || sourcePath.startsWith(`${path.resolve(sourceDirectoryPath)}${path.sep}`)) {
          sourceWasBackedUp = true;
        }
        return (originalCopyFile as (...values: unknown[]) => Promise<void>).call(
          fs.promises,
          source,
          destination,
          ...args,
        );
      };
      await assert.rejects(() => new MutationPlanExecutor(tempRoot).execute(plan.plan), /rolled back|directory creation failure/i);
    } finally {
      fs.promises.mkdir = originalMkdir;
      fs.promises.copyFile = originalCopyFile;
    }

    assert.strictEqual(sourceWasBackedUp, false, 'read-only source assertions must never create rollback backups');
    assert.strictEqual(await fs.promises.readFile(fixture.sourcePath, 'utf8'), sourceContent);
    assert.strictEqual((await fs.promises.stat(fixture.sourcePath)).mtimeMs, sourceStat.mtimeMs,
      'asserting the source must not alter its contents or timestamp, including on rollback');
    assert.deepStrictEqual(await fs.promises.readFile(path.join(sourceDirectoryPath, 'Forms', 'Main.bin')), sourceBinaryContent);
    assert.strictEqual(await fs.promises.readFile(configurationPath, 'utf8'), configurationContent);
    assert.strictEqual(fs.existsSync(path.join(tempRoot, 'Catalogs', 'RollbackCopy.xml')), false);
    assert.strictEqual(fs.existsSync(path.join(tempRoot, 'Catalogs', 'RollbackCopy')), false);
  });

  test('nested duplicateElement keeps its existing XMLWriter path', async () => {
    const sourcePath = path.join(tempRoot, 'Catalogs', 'Source.xml');
    await fs.promises.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.promises.writeFile(sourcePath, `<?xml version="1.0"?><MetaDataObject version="2.20"><Catalog uuid="11111111-1111-4111-8111-111111111111"><Properties><Name>Source</Name></Properties><ChildObjects><Attribute uuid="22222222-2222-4222-8222-222222222222"><Properties><Name>Existing</Name></Properties></Attribute></ChildObjects></Catalog></MetaDataObject>`, 'utf8');
    const owner = catalogTreeNode(tempRoot, 'Source');
    const attribute: TreeNode = {
      id: 'Catalogs.Source.Attributes.Existing', name: 'Existing', type: MetadataType.Attribute,
      parent: owner, parentFilePath: sourcePath, properties: {},
    };

    await duplicateElement(attribute, 'NewAttribute');
    const xml = await fs.promises.readFile(sourcePath, 'utf8');
    assert.match(xml, /<Name>NewAttribute<\/Name>/);
    assert.match(xml, /<Name>Existing<\/Name>/);
  });
});

interface CatalogDuplicateFixture {
  readonly sourcePath: string;
  readonly mainXmlPath: string;
  readonly binaryContent: Buffer;
}

async function createCatalogDuplicateFixture(rootPath: string, name: string): Promise<CatalogDuplicateFixture> {
  const catalogFolder = path.join(rootPath, 'Catalogs');
  const sourcePath = path.join(catalogFolder, `${name}.xml`);
  const sourceDirectory = path.join(catalogFolder, name);
  const mainXmlPath = path.join(sourceDirectory, 'Forms', 'Main.xml');
  const binaryContent = Buffer.from([0, 1, 2, 127, 128, 255]);
  await fs.promises.mkdir(path.dirname(mainXmlPath), { recursive: true });
  const configuration = await fs.promises.readFile(path.join(rootPath, 'Configuration.xml'), 'utf8');
  await fs.promises.writeFile(path.join(rootPath, 'Configuration.xml'),
    configuration.replace('<ChildObjects/>', `<ChildObjects><Catalog>${name}</Catalog></ChildObjects>`), 'utf8');
  await fs.promises.writeFile(sourcePath, catalogSourceXml(name), 'utf8');
  await fs.promises.writeFile(mainXmlPath, catalogMainXml(name), 'utf8');
  await fs.promises.writeFile(path.join(sourceDirectory, 'Forms', 'Main.bin'), binaryContent);
  return { sourcePath, mainXmlPath, binaryContent };
}

function catalogSourceXml(name: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject version="2.20" xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable">
  <Catalog uuid="11111111-1111-4111-8111-111111111111">
    <InternalInfo>
      <xr:GeneratedType name="CatalogObject.${name}"><xr:TypeId>22222222-2222-4222-8222-222222222222</xr:TypeId></xr:GeneratedType>
      <xr:GeneratedType name="CatalogObject.SourceArchive"><xr:TypeId>33333333-3333-4333-8333-333333333333</xr:TypeId></xr:GeneratedType>
    </InternalInfo>
    <Properties><Name>${name}</Name><Synonym><v8:content>${name}</v8:content></Synonym></Properties>
    <ChildObjects><xr:Field>Catalog.${name}</xr:Field><xr:Field>Catalog.SourceArchive</xr:Field></ChildObjects>
  </Catalog>
</MetaDataObject>`;
}

function catalogMainXml(name: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable">
  <Form uuid="44444444-4444-4444-8444-444444444444">
    <Properties><Name>Main</Name></Properties>
    <ThisNode>22222222-2222-4222-8222-222222222222</ThisNode>
    <xr:Field>Catalog.${name}</xr:Field>
  </Form>
</MetaDataObject>`;
}

function catalogTreeNode(rootPath: string, name: string): TreeNode {
  const configurationNode: TreeNode = {
    id: 'Configuration', name: 'Configuration', type: MetadataType.Configuration,
    filePath: path.join(rootPath, 'Configuration.xml'), properties: {},
  };
  const folderNode: TreeNode = {
    id: 'Catalogs', name: 'Catalogs', type: MetadataType.Catalog,
    filePath: path.join(rootPath, 'Catalogs'), parent: configurationNode, properties: {}, children: [],
  };
  const sourceNode: TreeNode = {
    id: `Catalogs.${name}`, name, type: MetadataType.Catalog,
    filePath: path.join(rootPath, 'Catalogs', `${name}.xml`), parent: folderNode, properties: {},
  };
  folderNode.children = [sourceNode];
  return sourceNode;
}

async function assertDuplicateDirectoryConflict(
  rootPath: string,
  changeSourceDirectory: (fixture: CatalogDuplicateFixture) => Promise<void>,
  changedRelativePath: string,
): Promise<void> {
  const fixture = await createCatalogDuplicateFixture(rootPath, 'Source');
  const plan = await requireDuplicateMetadataPlanner()({ configurationRootPath: rootPath }, {
    type: MetadataType.Catalog,
    sourceName: 'Source',
    newName: 'StaleDirectoryCopy',
  });
  const configurationPath = path.join(rootPath, 'Configuration.xml');
  const configurationBefore = await fs.promises.readFile(configurationPath, 'utf8');
  await changeSourceDirectory(fixture);
  const changedPath = path.join(rootPath, 'Catalogs', 'Source', changedRelativePath);
  const changedContent = await fs.promises.readFile(changedPath);

  await assert.rejects(
    () => new MutationPlanExecutor(rootPath).execute(plan.plan),
    (error: unknown) => Boolean(error && typeof error === 'object'
      && (error as { code?: string }).code === 'PLAN_CONFLICT'),
    'a stale companion directory snapshot must fail as a plan conflict',
  );
  assert.deepStrictEqual(await fs.promises.readFile(changedPath), changedContent,
    'the source mutation that caused the conflict must remain untouched');
  assert.strictEqual(await fs.promises.readFile(configurationPath, 'utf8'), configurationBefore);
  assert.strictEqual(fs.existsSync(path.join(rootPath, 'Catalogs', 'StaleDirectoryCopy.xml')), false);
  assert.strictEqual(fs.existsSync(path.join(rootPath, 'Catalogs', 'StaleDirectoryCopy')), false);
}

interface RegisterDeleteFixture {
  readonly registerPath: string;
  readonly documents: ReadonlyMap<string, string>;
}

async function createRootMetadataObject(
  context: { readonly configurationRootPath: string },
  type: MetadataType,
  name: string,
): Promise<void> {
  const create = await planCreateMetadataObject(context, { type, name });
  await new MutationPlanExecutor(context.configurationRootPath).execute(create.plan);
}

function readRootProperties(xml: string, rootTag: string): Record<string, unknown> {
  const document = XmlParser.parseString(xml)['MetaDataObject'] as Record<string, unknown>;
  const root = document[rootTag] as Record<string, unknown>;
  return root['Properties'] as Record<string, unknown>;
}

async function createRegisterDeleteFixture(
  rootPath: string,
  registeredDocuments: readonly string[],
  unregisteredDocuments: readonly string[] = [],
): Promise<RegisterDeleteFixture> {
  const documentEntries = registeredDocuments.map((name) => `<Document>${name}</Document>`).join('');
  const configContent = MINIMAL_CONFIG_XML.replace('<ChildObjects/>',
    `<ChildObjects><AccumulationRegister>Target</AccumulationRegister>${documentEntries}</ChildObjects>`);
  await fs.promises.writeFile(path.join(rootPath, 'Configuration.xml'), configContent, 'utf8');
  const registersPath = path.join(rootPath, 'AccumulationRegisters');
  const documentsPath = path.join(rootPath, 'Documents');
  await fs.promises.mkdir(registersPath, { recursive: true });
  await fs.promises.mkdir(documentsPath, { recursive: true });
  const registerPath = path.join(registersPath, 'Target.xml');
  await fs.promises.writeFile(registerPath,
    '<MetaDataObject><AccumulationRegister><Properties><Name>Target</Name></Properties></AccumulationRegister></MetaDataObject>',
    'utf8');
  const documents = new Map<string, string>();
  for (const name of [...registeredDocuments, ...unregisteredDocuments]) {
    const filePath = path.join(documentsPath, `${name}.xml`);
    documents.set(name, filePath);
    await fs.promises.writeFile(filePath, recorderDocumentXml(name, ''), 'utf8');
  }
  return { registerPath, documents };
}

function recorderDocumentXml(name: string, records: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject version="2.20" xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Document uuid="11111111-1111-4111-8111-111111111111">
    <Properties><Name>${name}</Name><RegisterRecords>${records}</RegisterRecords></Properties>
    <ChildObjects><Wrapper><xr:Item xsi:type="xr:MDObjectRef">AccumulationRegister.Target</xr:Item></Wrapper></ChildObjects>
  </Document>
</MetaDataObject>`;
}

function designerTemplateRecorderDocumentXml(
  template: string,
  name: string,
  uuid: string,
  records: string,
  nestedRecords: string,
): string {
  const namedTemplate = template.replace('{uuid}', uuid).replace(/\{Name\}/g, name);
  const withPropertiesRecords = namedTemplate.replace(/<RegisterRecords\s*\/>/, `<RegisterRecords>${records}</RegisterRecords>`);
  const withNestedRecords = withPropertiesRecords.replace(/<ChildObjects\s*\/>/,
    `<ChildObjects><Wrapper><RegisterRecords>${nestedRecords}</RegisterRecords></Wrapper></ChildObjects>`);
  if (namedTemplate === withPropertiesRecords || withPropertiesRecords === withNestedRecords) {
    throw new Error('Designer Document template did not contain expected insertion points.');
  }
  return withNestedRecords;
}

function extractPropertiesRegisterRecords(xml: string): string {
  const properties = xml.match(/<Properties>([\s\S]*?)<\/Properties>/)?.[1];
  assert.ok(properties, 'Designer Document template should contain Properties');
  const records = properties.match(/<RegisterRecords>([\s\S]*?)<\/RegisterRecords>/)?.[1];
  assert.ok(records, 'Designer Document template should contain Properties/RegisterRecords');
  return records;
}
