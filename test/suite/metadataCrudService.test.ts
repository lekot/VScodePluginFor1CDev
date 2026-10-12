import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { AgentOperations } from '../../src/agent/agentOperations';
import { MetadataType, type TreeNode } from '../../src/models/treeNode';
import {
  deleteElement,
  planDuplicateRootElement,
  planRenameRootElement,
} from '../../src/services/elementOperations';
import {
  planCreateMetadataObject,
  planDeleteMetadataObject,
} from '../../src/services/metadataCrudService';
import { MutationPlanExecutor } from '../../src/services/configurationSession/mutationPlan';
import { createTempDir, cleanupTempDir } from '../helpers/testHelpers';

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
    await fs.promises.writeFile(path.join(tempRoot, 'Configuration.xml'), MINIMAL_CONFIG_XML, 'utf8');
  });

  teardown(async () => {
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
});

interface RegisterDeleteFixture {
  readonly registerPath: string;
  readonly documents: ReadonlyMap<string, string>;
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
