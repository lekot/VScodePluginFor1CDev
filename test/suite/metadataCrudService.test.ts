import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { AgentOperations } from '../../src/agent/agentOperations';
import { MetadataType, type TreeNode } from '../../src/models/treeNode';
import {
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
