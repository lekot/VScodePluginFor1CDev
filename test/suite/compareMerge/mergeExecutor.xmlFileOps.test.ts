import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

import {
  indexBslModuleSource,
  type BslModuleIdentity,
} from '../../../src/compareMerge/bsl/bslModuleIndexer';
import type { CompareTreeNode } from '../../../src/compareMerge/compareTreeTypes';
import { createBslRoutineLogicalMergePlan } from '../../../src/compareMerge/bsl/bslRoutineLogicalMerge';
import { hashText } from '../../../src/compareMerge/bsl/bslRoutineLogicalScanner';
import type {
  BslRoutineLogicalMergePlan,
  BslRoutineLogicalSnapshot,
} from '../../../src/compareMerge/bsl/bslRoutineMergePlanTypes';
import { CompareSession } from '../../../src/compareMerge/domain/compareSession';
import { metadataXmlAdapter } from '../../../src/compareMerge/adapters/xmlMetadataAdapter';
import type { AdapterCompareInput } from '../../../src/compareMerge/adapters/mergeAdapter';
import { executeBslMergePreview } from '../../../src/compareMerge/merge/mergeExecutor';
import {
  createMergePreview,
  validateMergePreflight,
  type BackupPlan,
  type MergeCandidate,
  type PreflightResult,
  type RollbackPlan,
} from '../../../src/compareMerge/merge/mergePlanner';

suite('MergeExecutor XML and file operations', () => {
  const tempDirs: string[] = [];

  teardown(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
    );
  });

  test('applies XML patch, file copy and existing BSL logical operation in one approved preview', async () => {
    const context = await createContext(tempDirs);
    const preflight = createApprovedPreflight(context);

    const result = await executeBslMergePreview({
      session: context.session,
      preflight,
    });

    assert.strictEqual(result.failed.length, 0, JSON.stringify(result.failed));
    assert.deepStrictEqual(
      result.applied.map((item) => item.kind),
      ['xmlNodeReplace', 'fileCopy', 'bslLogicalRoutineMerge']
    );
    assert.strictEqual(await readText(context.xmlPath), context.nextXml);
    assert.strictEqual(await readText(context.fileTargetPath), context.fileSource);
    assert.strictEqual(await readText(context.bslPath), context.nextBsl);
    assert.strictEqual(await readText(context.xmlBackupPath), context.oldXml);
    assert.strictEqual(await readText(context.fileBackupPath), context.fileTargetOld);
    assert.strictEqual(await readText(context.bslBackupPath), context.oldBsl);
  });

  test('applies selected adapter XML property patch with selector pointer only', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-adapter-xml-'));
    tempDirs.push(rootDir);
    const snapshotDir = path.join(rootDir, 'snapshot');
    const backupDir = path.join(rootDir, 'backups');
    const xmlPath = path.join(rootDir, 'Catalogs', 'Products.xml');
    const backupPath = path.join(backupDir, 'Products.xml.bak');
    const leftXml = [
      '<MetaDataObject>',
      '  <Properties>',
      '    <Name>Products</Name>',
      '    <Synonym>Old goods</Synonym>',
      '    <Comment>Keep local comment</Comment>',
      '  </Properties>',
      '</MetaDataObject>',
    ].join('\n');
    const rightXml = [
      '<MetaDataObject>',
      '  <Properties>',
      '    <Name>Products</Name>',
      '    <Synonym>New goods</Synonym>',
      '    <Comment>Incoming comment not selected</Comment>',
      '  </Properties>',
      '</MetaDataObject>',
    ].join('\n');
    const expectedXml = [
      '<MetaDataObject>',
      '  <Properties>',
      '    <Name>Products</Name>',
      '    <Synonym>New goods</Synonym>',
      '    <Comment>Keep local comment</Comment>',
      '  </Properties>',
      '</MetaDataObject>',
    ].join('\n');

    await fs.mkdir(path.dirname(xmlPath), { recursive: true });
    await fs.writeFile(xmlPath, leftXml, 'utf8');

    const session = makeSession(rootDir, snapshotDir);
    const adapterResult = await metadataXmlAdapter.compare(
      makeXmlAdapterInput(session, rootDir, snapshotDir, xmlPath, leftXml, rightXml)
    );
    const synonym = requireTreeNodeByLabel(adapterResult.nodes, 'Synonym');
    const candidateResult = await adapterResult.candidateFactories.get(synonym.id)!();
    assert.strictEqual(candidateResult.ok, true);
    const candidate = candidateResult.candidate;

    const previewId = 'preview-selected-xml-property';
    const preview = createMergePreview({
      session,
      previewId,
      targetSourceId: 'left-source',
      snapshotIds: { left: 'snapshot-left-1', right: 'snapshot-right-1' },
      createdAt: '2026-05-30T10:10:00.000Z',
      candidates: [candidate],
      currentTargetHashes: {
        [candidate.targetUri!]: hashText(leftXml),
      },
    });
    assert.strictEqual(preview.ok, true, JSON.stringify(preview.diagnostics));

    session.approvePreview(previewId);
    const operationId = preview.preview.operations[0].operationId;
    const preflight = validateMergePreflight({
      session,
      previewId,
      approvedPreviewId: previewId,
      currentTargetHashes: {
        [candidate.targetUri!]: hashText(leftXml),
      },
      backupPlan: {
        previewId,
        strategy: 'copyBeforeWrite',
        items: [
          {
            operationId,
            targetUri: candidate.targetUri!,
            backupUri: pathToFileURL(backupPath).toString(),
            expectedOldHash: hashText(leftXml),
          },
        ],
      },
      rollbackPlan: {
        previewId,
        strategy: 'restoreBackups',
        items: [
          {
            operationId,
            targetUri: candidate.targetUri!,
            backupUri: pathToFileURL(backupPath).toString(),
            restoreHash: hashText(leftXml),
          },
        ],
      },
    });
    assert.strictEqual(preflight.ok, true, JSON.stringify(preflight.diagnostics));

    const result = await executeBslMergePreview({ session, preflight });

    assert.strictEqual(result.failed.length, 0, JSON.stringify(result.failed));
    assert.deepStrictEqual(result.applied.map((item) => item.kind), ['xmlNodeReplace']);
    assert.strictEqual(await readText(xmlPath), expectedXml);
    assert.strictEqual(await readText(backupPath), leftXml);
  });

  test('applies multiple selected XML property patches from the same file as one atomic write', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-adapter-xml-bulk-'));
    tempDirs.push(rootDir);
    const snapshotDir = path.join(rootDir, 'snapshot');
    const backupDir = path.join(rootDir, 'backups');
    const xmlPath = path.join(rootDir, 'Catalogs', 'Products.xml');
    const firstBackupPath = path.join(backupDir, 'Products.first.xml.bak');
    const secondBackupPath = path.join(backupDir, 'Products.second.xml.bak');
    const leftXml = [
      '<MetaDataObject>',
      '  <Properties>',
      '    <Name>Products</Name>',
      '    <Synonym>Old goods</Synonym>',
      '    <Comment>Keep local comment</Comment>',
      '  </Properties>',
      '</MetaDataObject>',
    ].join('\n');
    const rightXml = [
      '<MetaDataObject>',
      '  <Properties>',
      '    <Name>Products</Name>',
      '    <Synonym>New goods</Synonym>',
      '    <Comment>Incoming comment</Comment>',
      '  </Properties>',
      '</MetaDataObject>',
    ].join('\n');

    await fs.mkdir(path.dirname(xmlPath), { recursive: true });
    await fs.writeFile(xmlPath, leftXml, 'utf8');

    const session = makeSession(rootDir, snapshotDir);
    const adapterResult = await metadataXmlAdapter.compare(
      makeXmlAdapterInput(session, rootDir, snapshotDir, xmlPath, leftXml, rightXml)
    );
    const synonym = requireTreeNodeByLabel(adapterResult.nodes, 'Synonym');
    const comment = requireTreeNodeByLabel(adapterResult.nodes, 'Comment');
    const firstCandidateResult = await adapterResult.candidateFactories.get(synonym.id)!();
    const secondCandidateResult = await adapterResult.candidateFactories.get(comment.id)!();
    assert.strictEqual(firstCandidateResult.ok, true);
    assert.strictEqual(secondCandidateResult.ok, true);
    const candidates = [firstCandidateResult.candidate, secondCandidateResult.candidate];

    const previewId = 'preview-bulk-xml-properties';
    const preview = createMergePreview({
      session,
      previewId,
      targetSourceId: 'left-source',
      snapshotIds: { left: 'snapshot-left-1', right: 'snapshot-right-1' },
      createdAt: '2026-05-30T10:10:00.000Z',
      candidates,
      currentTargetHashes: {
        [candidates[0].targetUri!]: hashText(leftXml),
      },
    });
    assert.strictEqual(preview.ok, true, JSON.stringify(preview.diagnostics));

    session.approvePreview(previewId);
    const preflight = validateMergePreflight({
      session,
      previewId,
      approvedPreviewId: previewId,
      currentTargetHashes: {
        [candidates[0].targetUri!]: hashText(leftXml),
      },
      backupPlan: {
        previewId,
        strategy: 'copyBeforeWrite',
        items: preview.preview.operations.map((operation, index) => ({
          operationId: operation.operationId,
          targetUri: operation.targetUri!,
          backupUri: pathToFileURL(index === 0 ? firstBackupPath : secondBackupPath).toString(),
          expectedOldHash: hashText(leftXml),
        })),
      },
      rollbackPlan: {
        previewId,
        strategy: 'restoreBackups',
        items: preview.preview.operations.map((operation, index) => ({
          operationId: operation.operationId,
          targetUri: operation.targetUri!,
          backupUri: pathToFileURL(index === 0 ? firstBackupPath : secondBackupPath).toString(),
          restoreHash: hashText(leftXml),
        })),
      },
    });
    assert.strictEqual(preflight.ok, true, JSON.stringify(preflight.diagnostics));

    const result = await executeBslMergePreview({ session, preflight });

    assert.strictEqual(result.failed.length, 0, JSON.stringify(result.failed));
    assert.deepStrictEqual(result.applied.map((item) => item.kind), [
      'xmlNodeReplace',
      'xmlNodeReplace',
    ]);
    assert.strictEqual(await readText(xmlPath), rightXml);
    assert.strictEqual(await readText(firstBackupPath), leftXml);
  });

  test('applies BSL routine insert from incoming source text', async () => {
    const context = await createRoutineChangeContext(tempDirs, 'bslRoutineInsert');
    const preflight = createApprovedRoutinePreflight(context);

    const result = await executeBslMergePreview({
      session: context.session,
      preflight,
    });

    assert.strictEqual(result.failed.length, 0, JSON.stringify(result.failed));
    assert.deepStrictEqual(result.applied.map((item) => item.kind), ['bslRoutineInsert']);
    assert.strictEqual(await readText(context.bslPath), context.nextBsl);
    assert.strictEqual(await readText(context.bslBackupPath), context.oldBsl);
  });

  test('applies BSL routine delete from target source range', async () => {
    const context = await createRoutineChangeContext(tempDirs, 'bslRoutineDelete');
    const preflight = createApprovedRoutinePreflight(context);

    const result = await executeBslMergePreview({
      session: context.session,
      preflight,
    });

    assert.strictEqual(result.failed.length, 0, JSON.stringify(result.failed));
    assert.deepStrictEqual(result.applied.map((item) => item.kind), ['bslRoutineDelete']);
    assert.strictEqual(await readText(context.bslPath), context.nextBsl);
    assert.strictEqual(await readText(context.bslBackupPath), context.oldBsl);
  });

  test('rolls back already applied bulk operation when a later apply fails', async () => {
    const context = await createBulkRollbackContext(tempDirs);
    const preflight = createApprovedBulkRollbackPreflight(context);
    let firstCopyApplied = false;

    const result = await executeBslMergePreview({
      session: context.session,
      preflight,
      fileSystem: {
        ...nodeTestFileSystem(),
        copyFile: async (sourcePath, targetPath) => {
          await fs.copyFile(sourcePath, targetPath);
          if (sourcePath === context.firstSourcePath && targetPath === context.firstTargetPath) {
            firstCopyApplied = true;
            await fs.writeFile(context.secondTargetPath, 'changed during apply', 'utf8');
          }
        },
      },
    });

    assert.strictEqual(firstCopyApplied, true);
    assert.deepStrictEqual(result.applied.map((item) => item.operationId), [
      context.firstOperationId,
    ]);
    assert.strictEqual(result.failed.length, 1, JSON.stringify(result.failed));
    assert.strictEqual(result.failed[0].operationId, context.secondOperationId);
    assert.strictEqual(result.failed[0].code, 'MERGE_STALE_TARGET_HASH');
    assert.strictEqual(result.failed[0].backupPath, context.secondBackupPath);
    assert.ok(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'MERGE_STALE_TARGET_HASH' &&
          diagnostic.suggestedAction?.includes('immediately before copy')
      ),
      JSON.stringify(result.diagnostics)
    );
    assert.deepStrictEqual(result.backupPaths, [context.firstBackupPath]);
    assert.strictEqual(await readText(context.firstTargetPath), context.firstTargetOld);
    assert.strictEqual(await readText(context.firstBackupPath), context.firstTargetOld);
    assert.strictEqual(await readText(context.secondTargetPath), 'changed during apply');
  });

  test('reports rollback failure without hiding the original apply failure', async () => {
    const context = await createBulkRollbackContext(tempDirs);
    const preflight = createApprovedBulkRollbackPreflight(context);

    const result = await executeBslMergePreview({
      session: context.session,
      preflight,
      fileSystem: {
        ...nodeTestFileSystem(),
        copyFile: async (sourcePath, targetPath) => {
          if (sourcePath === context.firstBackupPath && targetPath === context.firstTargetPath) {
            throw new Error('restore denied');
          }
          await fs.copyFile(sourcePath, targetPath);
          if (sourcePath === context.firstSourcePath && targetPath === context.firstTargetPath) {
            await fs.writeFile(context.secondTargetPath, 'changed during apply', 'utf8');
          }
        },
      },
    });

    assert.deepStrictEqual(
      result.failed.map((item) => item.code),
      ['MERGE_STALE_TARGET_HASH', 'MERGE_ROLLBACK_FAILED']
    );
    assert.strictEqual(result.failed[0].operationId, context.secondOperationId);
    assert.strictEqual(result.failed[1].operationId, context.firstOperationId);
    assert.strictEqual(result.failed[1].backupPath, context.firstBackupPath);
    assert.ok(
      result.failed[1].message?.includes('restore denied'),
      JSON.stringify(result.failed[1])
    );
    assert.ok(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'MERGE_ROLLBACK_FAILED' &&
          diagnostic.suggestedAction?.includes('restore denied')
      ),
      JSON.stringify(result.diagnostics)
    );
    assert.strictEqual(await readText(context.firstTargetPath), context.firstSource);
    assert.strictEqual(await readText(context.firstBackupPath), context.firstTargetOld);
  });
});

interface ExecutionContext {
  bslBackupPath: string;
  bslPath: string;
  fileBackupPath: string;
  fileSource: string;
  fileSourcePath: string;
  fileTargetOld: string;
  fileTargetPath: string;
  nextBsl: string;
  nextXml: string;
  oldBsl: string;
  oldXml: string;
  operationIds: string[];
  previewId: string;
  session: CompareSession;
  targetUris: string[];
  xmlBackupPath: string;
  xmlPath: string;
}

interface RoutineChangeContext {
  bslBackupPath: string;
  bslPath: string;
  nextBsl: string;
  oldBsl: string;
  operationId: string;
  previewId: string;
  session: CompareSession;
  targetUri: string;
}

interface BulkRollbackContext {
  firstBackupPath: string;
  firstOperationId: string;
  firstSource: string;
  firstSourcePath: string;
  firstTargetOld: string;
  firstTargetPath: string;
  previewId: string;
  secondBackupPath: string;
  secondOperationId: string;
  secondSource: string;
  secondSourcePath: string;
  secondTargetOld: string;
  secondTargetPath: string;
  session: CompareSession;
  targetUris: string[];
}

async function createContext(tempDirs: string[]): Promise<ExecutionContext> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-xml-file-bsl-'));
  tempDirs.push(rootDir);
  const snapshotDir = path.join(rootDir, 'snapshot');
  const backupDir = path.join(rootDir, 'backups');
  const xmlPath = path.join(rootDir, 'Catalogs', 'Products.xml');
  const fileTargetPath = path.join(rootDir, 'Templates', 'Print.mxl');
  const fileSourcePath = path.join(snapshotDir, 'Templates', 'Print.mxl');
  const bslPath = path.join(rootDir, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');
  const xmlBackupPath = path.join(backupDir, 'Products.xml.bak');
  const fileBackupPath = path.join(backupDir, 'Print.mxl.bak');
  const bslBackupPath = path.join(backupDir, 'ObjectModule.bsl.bak');
  const oldXml = '<Object><Name>Old</Name></Object>';
  const nextXml = '<Object><Name>New</Name></Object>';
  const fileTargetOld = 'old template';
  const fileSource = 'new template';
  const oldBsl = baseRoutine();
  const nextBsl = incomingRoutine();

  await fs.mkdir(path.dirname(xmlPath), { recursive: true });
  await fs.writeFile(xmlPath, oldXml, 'utf8');
  await fs.mkdir(path.dirname(fileTargetPath), { recursive: true });
  await fs.writeFile(fileTargetPath, fileTargetOld, 'utf8');
  await fs.mkdir(path.dirname(fileSourcePath), { recursive: true });
  await fs.writeFile(fileSourcePath, fileSource, 'utf8');
  await fs.mkdir(path.dirname(bslPath), { recursive: true });
  await fs.writeFile(bslPath, oldBsl, 'utf8');

  const session = makeSession(rootDir, snapshotDir);
  const plan = createPlan(oldBsl, nextBsl, bslPath, rootDir);
  const previewId = 'preview-bulk-execute';
  const candidates: MergeCandidate[] = [
    xmlCandidate(xmlPath, oldXml, nextXml),
    fileCopyCandidate(fileSourcePath, fileTargetPath, fileTargetOld, fileSource),
    bslCandidate(plan, bslPath, oldBsl, nextBsl, rootDir),
  ];
  const preview = createMergePreview({
    session,
    previewId,
    targetSourceId: 'left-source',
    snapshotIds: { left: 'snapshot-left-1', right: 'snapshot-right-1' },
    createdAt: '2026-05-30T10:10:00.000Z',
    candidates,
    currentTargetHashes: Object.fromEntries(
      candidates.map((candidate) => [candidate.targetUri!, candidate.expectedOldHash!])
    ),
  });
  assert.strictEqual(preview.ok, true);

  return {
    bslBackupPath,
    bslPath,
    fileBackupPath,
    fileSource,
    fileSourcePath,
    fileTargetOld,
    fileTargetPath,
    nextBsl,
    nextXml,
    oldBsl,
    oldXml,
    operationIds: preview.preview.operations.map((operation) => operation.operationId),
    previewId,
    session,
    targetUris: preview.preview.operations.map((operation) => operation.targetUri!),
    xmlBackupPath,
    xmlPath,
  };
}

function createApprovedPreflight(context: ExecutionContext): PreflightResult {
  context.session.approvePreview(context.previewId);
  const preflight = validateMergePreflight({
    session: context.session,
    previewId: context.previewId,
    approvedPreviewId: context.previewId,
    currentTargetHashes: {
      [pathToFileURL(context.xmlPath).toString()]: hashText(context.oldXml),
      [pathToFileURL(context.fileTargetPath).toString()]: hashText(context.fileTargetOld),
      [pathToFileURL(context.bslPath).toString()]: hashText(context.oldBsl),
    },
    backupPlan: backupPlan(context),
    rollbackPlan: rollbackPlan(context),
  });
  assert.strictEqual(preflight.ok, true, JSON.stringify(preflight.diagnostics));
  return preflight;
}

async function createRoutineChangeContext(
  tempDirs: string[],
  kind: 'bslRoutineInsert' | 'bslRoutineDelete'
): Promise<RoutineChangeContext> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-bsl-routine-'));
  tempDirs.push(rootDir);
  const snapshotDir = path.join(rootDir, 'snapshot');
  const backupDir = path.join(rootDir, 'backups');
  const bslPath = path.join(rootDir, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');
  const bslBackupPath = path.join(backupDir, `${kind}.bsl.bak`);
  const targetUri = pathToFileURL(bslPath).toString();
  const oldBsl =
    kind === 'bslRoutineInsert'
      ? existingRoutine()
      : [existingRoutine(), deletedRoutine()].join('\n');
  const nextBsl =
    kind === 'bslRoutineInsert'
      ? [existingRoutine(), insertedRoutine()].join('\n')
      : existingRoutine();

  await fs.mkdir(path.dirname(bslPath), { recursive: true });
  await fs.writeFile(bslPath, oldBsl, 'utf8');

  const session = makeSession(rootDir, snapshotDir);
  const previewId = `preview-${kind}`;
  const preview = createMergePreview({
    session,
    previewId,
    targetSourceId: 'left-source',
    snapshotIds: { left: 'snapshot-left-1', right: 'snapshot-right-1' },
    createdAt: '2026-05-30T10:10:00.000Z',
    candidates: [routineChangeCandidate(kind, targetUri, oldBsl, nextBsl)],
    currentTargetHashes: {
      [targetUri]: hashText(oldBsl),
    },
  });
  assert.strictEqual(preview.ok, true, JSON.stringify(preview.diagnostics));

  return {
    bslBackupPath,
    bslPath,
    nextBsl,
    oldBsl,
    operationId: preview.preview.operations[0].operationId,
    previewId,
    session,
    targetUri,
  };
}

function createApprovedRoutinePreflight(context: RoutineChangeContext): PreflightResult {
  context.session.approvePreview(context.previewId);
  const preflight = validateMergePreflight({
    session: context.session,
    previewId: context.previewId,
    approvedPreviewId: context.previewId,
    currentTargetHashes: {
      [context.targetUri]: hashText(context.oldBsl),
    },
    backupPlan: {
      previewId: context.previewId,
      strategy: 'copyBeforeWrite',
      items: [
        {
          operationId: context.operationId,
          targetUri: context.targetUri,
          backupUri: pathToFileURL(context.bslBackupPath).toString(),
          expectedOldHash: hashText(context.oldBsl),
        },
      ],
    },
    rollbackPlan: {
      previewId: context.previewId,
      strategy: 'restoreBackups',
      items: [
        {
          operationId: context.operationId,
          targetUri: context.targetUri,
          backupUri: pathToFileURL(context.bslBackupPath).toString(),
          restoreHash: hashText(context.oldBsl),
        },
      ],
    },
  });
  assert.strictEqual(preflight.ok, true, JSON.stringify(preflight.diagnostics));
  return preflight;
}

async function createBulkRollbackContext(tempDirs: string[]): Promise<BulkRollbackContext> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-bulk-rollback-'));
  tempDirs.push(rootDir);
  const snapshotDir = path.join(rootDir, 'snapshot');
  const backupDir = path.join(rootDir, 'backups');
  const firstSourcePath = path.join(snapshotDir, 'Templates', 'First.mxl');
  const firstTargetPath = path.join(rootDir, 'Templates', 'First.mxl');
  const secondSourcePath = path.join(snapshotDir, 'Templates', 'Second.mxl');
  const secondTargetPath = path.join(rootDir, 'Templates', 'Second.mxl');
  const firstBackupPath = path.join(backupDir, 'First.mxl.bak');
  const secondBackupPath = path.join(backupDir, 'Second.mxl.bak');
  const firstTargetOld = 'first old template';
  const firstSource = 'first incoming template';
  const secondTargetOld = 'second old template';
  const secondSource = 'second incoming template';

  await fs.mkdir(path.dirname(firstSourcePath), { recursive: true });
  await fs.mkdir(path.dirname(firstTargetPath), { recursive: true });
  await fs.writeFile(firstSourcePath, firstSource, 'utf8');
  await fs.writeFile(firstTargetPath, firstTargetOld, 'utf8');
  await fs.writeFile(secondSourcePath, secondSource, 'utf8');
  await fs.writeFile(secondTargetPath, secondTargetOld, 'utf8');

  const session = makeSession(rootDir, snapshotDir);
  const previewId = 'preview-bulk-rollback';
  const candidates: MergeCandidate[] = [
    fileCopyCandidate(firstSourcePath, firstTargetPath, firstTargetOld, firstSource),
    fileCopyCandidate(secondSourcePath, secondTargetPath, secondTargetOld, secondSource),
  ];
  const preview = createMergePreview({
    session,
    previewId,
    targetSourceId: 'left-source',
    snapshotIds: { left: 'snapshot-left-1', right: 'snapshot-right-1' },
    createdAt: '2026-05-30T10:10:00.000Z',
    candidates,
    currentTargetHashes: Object.fromEntries(
      candidates.map((candidate) => [candidate.targetUri!, candidate.expectedOldHash!])
    ),
  });
  assert.strictEqual(preview.ok, true, JSON.stringify(preview.diagnostics));

  return {
    firstBackupPath,
    firstOperationId: preview.preview.operations[0].operationId,
    firstSource,
    firstSourcePath,
    firstTargetOld,
    firstTargetPath,
    previewId,
    secondBackupPath,
    secondOperationId: preview.preview.operations[1].operationId,
    secondSource,
    secondSourcePath,
    secondTargetOld,
    secondTargetPath,
    session,
    targetUris: preview.preview.operations.map((operation) => operation.targetUri!),
  };
}

function createApprovedBulkRollbackPreflight(context: BulkRollbackContext): PreflightResult {
  context.session.approvePreview(context.previewId);
  const preflight = validateMergePreflight({
    session: context.session,
    previewId: context.previewId,
    approvedPreviewId: context.previewId,
    currentTargetHashes: {
      [context.targetUris[0]!]: hashText(context.firstTargetOld),
      [context.targetUris[1]!]: hashText(context.secondTargetOld),
    },
    backupPlan: {
      previewId: context.previewId,
      strategy: 'copyBeforeWrite',
      items: [
        {
          operationId: context.firstOperationId,
          targetUri: context.targetUris[0]!,
          backupUri: pathToFileURL(context.firstBackupPath).toString(),
          expectedOldHash: hashText(context.firstTargetOld),
        },
        {
          operationId: context.secondOperationId,
          targetUri: context.targetUris[1]!,
          backupUri: pathToFileURL(context.secondBackupPath).toString(),
          expectedOldHash: hashText(context.secondTargetOld),
        },
      ],
    },
    rollbackPlan: {
      previewId: context.previewId,
      strategy: 'restoreBackups',
      items: [
        {
          operationId: context.firstOperationId,
          targetUri: context.targetUris[0]!,
          backupUri: pathToFileURL(context.firstBackupPath).toString(),
          restoreHash: hashText(context.firstTargetOld),
        },
        {
          operationId: context.secondOperationId,
          targetUri: context.targetUris[1]!,
          backupUri: pathToFileURL(context.secondBackupPath).toString(),
          restoreHash: hashText(context.secondTargetOld),
        },
      ],
    },
  });
  assert.strictEqual(preflight.ok, true, JSON.stringify(preflight.diagnostics));
  return preflight;
}

function nodeTestFileSystem() {
  return {
    mkdir(directoryPath: string, options: { recursive: true }) {
      return fs.mkdir(directoryPath, options);
    },
    realpath(filePath: string) {
      return fs.realpath(filePath);
    },
    readFile(filePath: string, encoding: 'utf8') {
      return fs.readFile(filePath, encoding);
    },
    open(filePath: string, flags: 'wx') {
      return fs.open(filePath, flags);
    },
    rename(oldPath: string, newPath: string) {
      return fs.rename(oldPath, newPath);
    },
    copyFile(sourcePath: string, targetPath: string) {
      return fs.copyFile(sourcePath, targetPath);
    },
    rm(filePath: string, options: { force: true }) {
      return fs.rm(filePath, options);
    },
  };
}

function routineChangeCandidate(
  kind: 'bslRoutineInsert' | 'bslRoutineDelete',
  targetUri: string,
  oldBsl: string,
  nextBsl: string
): MergeCandidate {
  const routineText = kind === 'bslRoutineInsert' ? insertedRoutine() : deletedRoutine();
  return {
    kind,
    sourceId: 'right-source',
    snapshotId: 'snapshot-right-1',
    nodeId: `bsl:${kind}:added`,
    targetUri,
    expectedOldHash: hashText(oldBsl),
    newHash: hashText(nextBsl),
    bslRoutine: {
      kind: kind === 'bslRoutineInsert' ? 'insertRoutine' : 'deleteRoutine',
      targetPath: targetUri,
      expectedOldHash: hashText(oldBsl),
      newHash: hashText(nextBsl),
      routine: {
        name: kind === 'bslRoutineInsert' ? 'Added' : 'Removed',
        normalizedName: kind === 'bslRoutineInsert' ? 'added' : 'removed',
        kind: kind === 'bslRoutineInsert' ? 'function' : 'procedure',
        exported: false,
      },
      sourceText: routineText,
      sourceRange:
        kind === 'bslRoutineInsert'
          ? { startLine: 4, startColumn: 1, endLine: 6, endColumn: 12 }
          : undefined,
      targetRange:
        kind === 'bslRoutineDelete'
          ? { startLine: 4, startColumn: 1, endLine: 6, endColumn: 13 }
          : undefined,
    },
  } as MergeCandidate;
}

function xmlCandidate(xmlPath: string, oldXml: string, nextXml: string): MergeCandidate {
  const targetUri = pathToFileURL(xmlPath).toString();
  return {
    kind: 'xmlNodeReplace',
    sourceId: 'right-source',
    snapshotId: 'snapshot-right-1',
    nodeId: 'xml:name',
    targetUri,
    expectedOldHash: hashText(oldXml),
    newHash: hashText(nextXml),
    xmlPatch: {
      kind: 'replaceNode',
      target: {
        filePath: targetUri,
        pointer: '/Object/Name',
        displayPath: 'Object/Name',
      },
      expectedOldHash: hashText(oldXml),
      newHash: hashText(nextXml),
      replacementXml: '<Name>New</Name>',
    },
  };
}

function fileCopyCandidate(
  sourcePath: string,
  targetPath: string,
  oldText: string,
  sourceText: string
): MergeCandidate {
  const targetUri = pathToFileURL(targetPath).toString();
  return {
    kind: 'fileCopy',
    sourceId: 'right-source',
    snapshotId: 'snapshot-right-1',
    nodeId: 'file:template',
    targetUri,
    expectedOldHash: hashText(oldText),
    newHash: hashText(sourceText),
    fileOperation: {
      kind: 'fileCopy',
      sourcePath: pathToFileURL(sourcePath).toString(),
      targetPath: targetUri,
      expectedOldHash: hashText(oldText),
      sourceHash: hashText(sourceText),
      destructive: false,
    },
  };
}

function bslCandidate(
  plan: BslRoutineLogicalMergePlan,
  targetPath: string,
  oldBsl: string,
  nextBsl: string,
  rootDir: string
): MergeCandidate {
  return {
    kind: 'bslLogicalRoutineMerge',
    sourceId: 'right-source',
    snapshotId: 'snapshot-right-1',
    nodeId: 'bsl:run',
    targetUri: pathToFileURL(targetPath).toString(),
    expectedOldHash: hashText(oldBsl),
    newHash: hashText(nextBsl),
    logicalRoutine: {
      moduleId: 'Catalog.Products.Object',
      current: snapshot(oldBsl, targetPath, rootDir),
      plan,
    },
  };
}

function backupPlan(context: ExecutionContext): BackupPlan {
  return {
    previewId: context.previewId,
    strategy: 'copyBeforeWrite',
    items: [
      backupItem(context, 0, context.xmlBackupPath, hashText(context.oldXml)),
      backupItem(context, 1, context.fileBackupPath, hashText(context.fileTargetOld)),
      backupItem(context, 2, context.bslBackupPath, hashText(context.oldBsl)),
    ],
  };
}

function rollbackPlan(context: ExecutionContext): RollbackPlan {
  const backups = backupPlan(context);
  return {
    previewId: context.previewId,
    strategy: 'restoreBackups',
    items: backups.items.map((item) => ({
      operationId: item.operationId,
      targetUri: item.targetUri,
      backupUri: item.backupUri,
      restoreHash: item.expectedOldHash,
    })),
  };
}

function backupItem(
  context: ExecutionContext,
  index: number,
  backupPath: string,
  expectedOldHash: string
): BackupPlan['items'][number] {
  return {
    operationId: context.operationIds[index]!,
    targetUri: context.targetUris[index]!,
    backupUri: pathToFileURL(backupPath).toString(),
    expectedOldHash,
  };
}

function createPlan(
  oldBsl: string,
  nextBsl: string,
  targetPath: string,
  rootDir: string
): BslRoutineLogicalMergePlan {
  const base = snapshot(oldBsl, targetPath, rootDir);
  return createBslRoutineLogicalMergePlan({
    moduleId: 'Catalog.Products.Object',
    base,
    current: base,
    incoming: snapshot(nextBsl, targetPath, rootDir),
  });
}

function snapshot(
  source: string,
  filePath: string,
  configRoot: string
): BslRoutineLogicalSnapshot {
  const module = indexBslModuleSource({
    identity: makeIdentity(filePath, configRoot),
    source,
  });
  return {
    source,
    routine: module.routines[0],
  };
}

function makeIdentity(filePath: string, configRoot: string): BslModuleIdentity {
  return {
    sourceId: 'left-source',
    side: 'left',
    filePath,
    configRoot,
    metadataType: 'Catalog',
    objectName: 'Products',
    moduleKind: 'Object',
    moduleId: 'Catalog.Products.Object',
    displayName: 'Catalog.Products.Object',
  };
}

function makeSession(rootDir: string, snapshotDir: string): CompareSession {
  const session = CompareSession.create({
    sessionId: 'session-1',
    createdAt: '2026-05-30T10:00:00.000Z',
    sources: [
      {
        sourceId: 'left-source',
        side: 'left',
        kind: 'workspace',
        displayName: 'Current workspace',
        rootUri: pathToFileURL(rootDir).toString(),
        writable: true,
      },
      {
        sourceId: 'right-source',
        side: 'right',
        kind: 'snapshot',
        displayName: 'Incoming snapshot',
        rootUri: pathToFileURL(snapshotDir).toString(),
        writable: false,
      },
    ],
  });
  session.registerSnapshot(snapshotContract('snapshot-left-1', 'left-source', rootDir, false));
  session.registerSnapshot(snapshotContract('snapshot-right-1', 'right-source', snapshotDir, true));
  return session;
}

function makeXmlAdapterInput(
  session: CompareSession,
  rootDir: string,
  snapshotDir: string,
  xmlPath: string,
  left: string,
  right: string
): AdapterCompareInput {
  return {
    strategy: 'full',
    leftInventory: { rootPath: rootDir, objects: [], artifactsByObjectId: new Map() },
    rightInventory: { rootPath: snapshotDir, objects: [], artifactsByObjectId: new Map() },
    match: {
      left: {
        objectId: 'left-products',
        qualifiedName: 'Catalog.Products',
        metadataType: 'Catalog',
        uuid: 'catalog-products',
        descriptorPath: pathToFileURL(xmlPath).toString(),
        containerPath: path.dirname(xmlPath),
      },
      right: {
        objectId: 'right-products',
        qualifiedName: 'Catalog.Products',
        metadataType: 'Catalog',
        uuid: 'catalog-products',
        descriptorPath: pathToFileURL(path.join(snapshotDir, 'Catalogs', 'Products.xml')).toString(),
        containerPath: path.join(snapshotDir, 'Catalogs', 'Products'),
      },
    },
    session,
    snapshots: { left, right },
  };
}

function requireTreeNodeByLabel(
  nodes: readonly CompareTreeNode[],
  label: string
): CompareTreeNode {
  const found: CompareTreeNode[] = [];
  const visitNode = (node: CompareTreeNode) => {
    if (node.label === label) {
      found.push(node);
    }
    node.children.forEach(visitNode);
  };
  nodes.forEach(visitNode);
  assert.strictEqual(found.length, 1, `Expected exactly one node with label ${label}.`);
  return found[0]!;
}

function snapshotContract(
  snapshotId: string,
  sourceId: string,
  root: string,
  readOnly: boolean
) {
  return {
    snapshotId,
    sourceId,
    snapshotRoot: pathToFileURL(root).toString(),
    origin: pathToFileURL(root).toString(),
    createdAt: '2026-05-30T10:00:00.000Z',
    retentionUntil: '2026-05-30T12:00:00.000Z',
    sourceRevision: `test:${sourceId}`,
    readOnly,
    cleanupPolicy: 'manual' as const,
    contentHash: `sha256:${sourceId}`,
  };
}

function baseRoutine(): string {
  return [
    'Procedure Run()',
    '  If A Then',
    '    A = 1;',
    '  EndIf;',
    '  If B Then',
    '    B = 1;',
    '  EndIf;',
    'EndProcedure',
  ].join('\n');
}

function incomingRoutine(): string {
  return [
    'Procedure Run()',
    '  If A Then',
    '    A = 1;',
    '  EndIf;',
    '  Try',
    '    C = 1;',
    '  Except',
    '    C = 0;',
    '  EndTry;',
    '  If B Then',
    '    B = 1;',
    '  EndIf;',
    'EndProcedure',
  ].join('\n');
}

function existingRoutine(): string {
  return ['Procedure Existing()', '  Value = 1;', 'EndProcedure'].join('\n');
}

function insertedRoutine(): string {
  return ['Function Added()', '  Return 42;', 'EndFunction'].join('\n');
}

function deletedRoutine(): string {
  return ['Procedure Removed()', '  Value = 0;', 'EndProcedure'].join('\n');
}

async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf8');
}
