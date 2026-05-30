import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

import { indexBslModuleSource, type BslModuleIdentity } from '../../../src/compareMerge/bsl/bslModuleIndexer';
import { createBslRoutineLogicalMergePlan } from '../../../src/compareMerge/bsl/bslRoutineLogicalMerge';
import { hashText } from '../../../src/compareMerge/bsl/bslRoutineLogicalScanner';
import type {
  BslRoutineLogicalMergePlan,
  BslRoutineLogicalSnapshot,
} from '../../../src/compareMerge/bsl/bslRoutineMergePlanTypes';
import { CompareSession } from '../../../src/compareMerge/domain/compareSession';
import { executeBslMergePreview } from '../../../src/compareMerge/merge/mergeExecutor';
import {
  createMergePreview,
  validateMergePreflight,
  type BackupPlan,
  type MergeCandidate,
  type MergeOperation,
  type PreflightResult,
  type RollbackPlan,
} from '../../../src/compareMerge/merge/mergePlanner';

suite('MergeExecutor approved BSL logical operations', () => {
  const tempDirs: string[] = [];

  teardown(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  test('unapproved preview/preflight does not write', async () => {
    const context = await createExecutionContext();
    const preflight = createPreflight(context, { approve: false });

    const result = await executeBslMergePreview({
      session: context.session,
      preflight,
    });

    assert.strictEqual(result.applied.length, 0);
    assert.strictEqual(result.failed.length, 1);
    assert.strictEqual(result.failed[0].code, 'MERGE_PREFLIGHT_REQUIRED');
    assert.strictEqual(await readText(context.targetPath), context.targetSource);
    await assertFileMissing(context.backupPath);
  });

  test('approved logical insert writes block at anchor and preserves other module text', async () => {
    const context = await createExecutionContext({
      targetSource: moduleSource([
        '// header',
        'Procedure Run()',
        '  If A Then',
        '    A = 1;',
        '  EndIf;',
        '  If B Then',
        '    B = 1;',
        '  EndIf;',
        'EndProcedure',
        '// footer',
      ]),
      incomingSource: moduleSource([
        '// header',
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
        '// footer',
      ]),
    });
    const preflight = createPreflight(context, { approve: true });

    const result = await executeBslMergePreview({
      session: context.session,
      preflight,
    });

    const actual = await readText(context.targetPath);
    assert.strictEqual(result.applied.length, 1);
    assert.strictEqual(result.skipped.length, 0);
    assert.strictEqual(result.failed.length, 0);
    assert.strictEqual(actual, context.incomingSource);
    assert.ok(actual.startsWith('// header\nProcedure Run()'));
    assert.ok(actual.endsWith('EndProcedure\n// footer'));
  });

  test('hash mismatch writes nothing', async () => {
    const context = await createExecutionContext();
    const preflight = createPreflight(context, { approve: true });
    const changedSource = context.targetSource.replace('A = 1;', 'A = 2;');
    await fs.writeFile(context.targetPath, changedSource, 'utf8');

    const result = await executeBslMergePreview({
      session: context.session,
      preflight,
    });

    assert.strictEqual(result.applied.length, 0);
    assert.strictEqual(result.failed.length, 1);
    assert.strictEqual(result.failed[0].code, 'MERGE_STALE_TARGET_HASH');
    assert.strictEqual(await readText(context.targetPath), changedSource);
    await assertFileMissing(context.backupPath);
  });

  test('guard failure writes nothing', async () => {
    const changedTargetSource = moduleSource([
      'Procedure Run()',
      '  If A Then',
      '    A = 99;',
      '  EndIf;',
      '  If B Then',
      '    B = 1;',
      '  EndIf;',
      'EndProcedure',
    ]);
    const context = await createExecutionContext({
      targetSource: changedTargetSource,
      plannedCurrentSource: defaultTargetSource(),
    });
    const preflight = createPreflight(context, { approve: true });

    const result = await executeBslMergePreview({
      session: context.session,
      preflight,
    });

    assert.strictEqual(result.applied.length, 0);
    assert.strictEqual(result.failed.length, 1);
    assert.strictEqual(result.failed[0].code, 'MERGE_LOGICAL_GUARD_BLOCKED');
    assert.strictEqual(await readText(context.targetPath), changedTargetSource);
    await assertFileMissing(context.backupPath);
  });

  test('backup file is created before write', async () => {
    const context = await createExecutionContext();
    const preflight = createPreflight(context, { approve: true });

    const result = await executeBslMergePreview({
      session: context.session,
      preflight,
    });

    assert.strictEqual(result.applied.length, 1);
    assert.deepStrictEqual(result.backupPaths, [context.backupPath]);
    assert.strictEqual(await readText(context.backupPath), context.targetSource);
  });

  test('caller-mutated preflight operation cannot write forged target', async () => {
    const context = await createExecutionContext();
    const preflight = createPreflight(context, { approve: true });
    const forgedTargetPath = path.join(context.tempDir, 'Catalogs', 'Forged', 'Ext', 'ObjectModule.bsl');
    const forgedTargetUri = pathToFileURL(forgedTargetPath).toString();
    await fs.mkdir(path.dirname(forgedTargetPath), { recursive: true });
    await fs.writeFile(forgedTargetPath, context.targetSource, 'utf8');

    preflight.operations[0] = {
      ...preflight.operations[0],
      nodeId: 'Catalog.Forged.Object.Run',
      targetUri: forgedTargetUri,
    };

    const result = await executeBslMergePreview({
      session: context.session,
      preflight,
    });

    assert.strictEqual(result.applied.length, 1);
    assert.strictEqual(result.applied[0].targetUri, context.targetUri);
    assert.strictEqual(result.failed.length, 0);
    assert.strictEqual(await readText(context.targetPath), context.incomingSource);
    assert.strictEqual(await readText(forgedTargetPath), context.targetSource);
    assert.strictEqual(await readText(context.backupPath), context.targetSource);
  });

  test('caller-mutated preflight backup uri cannot overwrite forged backup file', async () => {
    const context = await createExecutionContext();
    const preflight = createPreflight(context, { approve: true });
    const forgedBackupPath = path.join(context.tempDir, 'backups', 'forged-existing.bak');
    const forgedBackupUri = pathToFileURL(forgedBackupPath).toString();
    const forgedBackupSource = 'do-not-overwrite';
    await fs.mkdir(path.dirname(forgedBackupPath), { recursive: true });
    await fs.writeFile(forgedBackupPath, forgedBackupSource, 'utf8');

    preflight.backupPlan.items[0] = {
      ...preflight.backupPlan.items[0],
      backupUri: forgedBackupUri,
    };

    const result = await executeBslMergePreview({
      session: context.session,
      preflight,
    });

    assert.strictEqual(await readText(forgedBackupPath), forgedBackupSource);
    if (result.applied.length > 0) {
      assert.strictEqual(result.applied[0].backupPath, context.backupPath);
      assert.strictEqual(await readText(context.backupPath), context.targetSource);
    }
  });

  test('multiple operations for same target file fail without writes', async () => {
    const context = await createExecutionContext({ storedOperationMode: 'duplicateLogical' });
    const preflight = createPreflight(context, { approve: true });

    const result = await executeBslMergePreview({
      session: context.session,
      preflight,
    });

    assert.strictEqual(result.applied.length, 0);
    assert.strictEqual(result.failed.length, 2);
    assert.ok(result.failed.every((item) => item.code === 'MERGE_MULTIPLE_OPERATIONS_SAME_TARGET'));
    assert.strictEqual(await readText(context.targetPath), context.targetSource);
    await assertFileMissing(context.backupPath);
  });

  test('Windows treats case-varied file uri targets as same target file', async function () {
    if (process.platform !== 'win32') {
      this.skip();
    }

    const context = await createExecutionContext({ storedOperationMode: 'caseVariantTarget' });
    const preflight = createPreflight(context, { approve: true });

    const result = await executeBslMergePreview({
      session: context.session,
      preflight,
    });

    assert.strictEqual(result.applied.length, 0);
    assert.strictEqual(result.failed.length, 2);
    assert.ok(result.failed.every((item) => item.code === 'MERGE_MULTIPLE_OPERATIONS_SAME_TARGET'));
    assert.strictEqual(await readText(context.targetPath), context.targetSource);
    await assertFileMissing(context.backupPath);
  });

  test('write failure reports created backup path', async () => {
    const context = await createExecutionContext();
    const preflight = createPreflight(context, { approve: true });

    const result = await executeBslMergePreview({
      session: context.session,
      preflight,
      fileSystem: {
        mkdir: async (directoryPath, options) => {
          await fs.mkdir(directoryPath, options);
        },
        readFile: fs.readFile,
        writeFile: async (filePath, content, encoding) => {
          if (filePath === context.targetPath) {
            throw new Error('target write denied');
          }

          await fs.writeFile(filePath, content, encoding);
        },
      },
    });

    assert.strictEqual(result.applied.length, 0);
    assert.strictEqual(result.failed.length, 1);
    assert.strictEqual(result.failed[0].code, 'MERGE_WRITE_FAILED');
    assert.strictEqual(result.failed[0].backupPath, context.backupPath);
    assert.strictEqual(await readText(context.backupPath), context.targetSource);
    assert.strictEqual(await readText(context.targetPath), context.targetSource);
  });

  test('mixed unsupported and logical operations fail without writes', async () => {
    const context = await createExecutionContext({ storedOperationMode: 'logicalAndLeaf' });
    const preflight = createPreflight(context, { approve: true });

    const result = await executeBslMergePreview({
      session: context.session,
      preflight,
    });

    assert.strictEqual(result.applied.length, 0);
    assert.strictEqual(result.failed.length, 1);
    assert.strictEqual(result.failed[0].code, 'MERGE_UNSUPPORTED_EXECUTOR_OPERATION');
    assert.strictEqual(await readText(context.targetPath), context.targetSource);
    await assertFileMissing(context.backupPath);
  });

  test('preserves CRLF target EOL', async () => {
    const context = await createExecutionContext({
      targetSource: moduleSource(defaultTargetLines(), '\r\n'),
      incomingSource: moduleSource(defaultIncomingLines(), '\r\n'),
    });
    const preflight = createPreflight(context, { approve: true });

    await executeBslMergePreview({
      session: context.session,
      preflight,
    });

    const actual = await readText(context.targetPath);
    assert.ok(actual.includes('  EndIf;\r\n  Try\r\n'));
    assert.strictEqual(actual, context.incomingSource);
  });

  test('does not write conflict markers', async () => {
    const context = await createExecutionContext();
    const preflight = createPreflight(context, { approve: true });

    await executeBslMergePreview({
      session: context.session,
      preflight,
    });

    assert.doesNotMatch(await readText(context.targetPath), /<<<<<<<|=======|>>>>>>>/);
  });

  async function createExecutionContext(options: Partial<ExecutionContextInput> = {}) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bsl-merge-executor-'));
    tempDirs.push(tempDir);
    const targetPath = path.join(tempDir, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');
    const backupPath = path.join(tempDir, 'backups', 'ObjectModule.bsl.bak');
    const targetSource = options.targetSource ?? defaultTargetSource();
    const plannedCurrentSource = options.plannedCurrentSource ?? targetSource;
    const incomingSource = options.incomingSource ?? defaultIncomingSource();

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, targetSource, 'utf8');

    const session = makeSession(tempDir);
    const plannedCurrent = snapshot(plannedCurrentSource, targetPath, tempDir);
    const plan = createBslRoutineLogicalMergePlan({
      moduleId: 'Catalog.Products.Object',
      base: plannedCurrent,
      current: plannedCurrent,
      incoming: snapshot(incomingSource, targetPath, tempDir),
    });
    const targetUri = pathToFileURL(targetPath).toString();
    const backupUri = pathToFileURL(backupPath).toString();
    const operationHash = hashText(targetSource);
    const baseOperation = logicalOperation(plan, targetUri, operationHash, plannedCurrent);
    const previewId = 'preview-execute';
    let operationIds: string[];
    let operationTargetUris: string[];
    if (options.storedOperationMode) {
      const operations = storedOperationsForMode(options.storedOperationMode, baseOperation);
      session.createPreview({
        previewId,
        targetSourceId: 'left-source',
        snapshotIds: { left: 'snapshot-left-1', right: 'snapshot-right-1' },
        createdAt: '2026-05-30T10:10:00.000Z',
        summary: 'Executor test stored preview.',
        payload: {
          kind: 'mergePreviewPayload',
          operations,
          diagnostics: [],
        },
      });
      operationIds = operations.map((operation) => operation.operationId);
      operationTargetUris = operations.map((operation) => operation.targetUri ?? targetUri);
    } else {
      const previewResult = createMergePreview({
        session,
        previewId,
        targetSourceId: 'left-source',
        snapshotIds: { left: 'snapshot-left-1', right: 'snapshot-right-1' },
        createdAt: '2026-05-30T10:10:00.000Z',
        candidates: [logicalCandidate(plan, targetUri, operationHash, plannedCurrent)],
        currentTargetHashes: {
          [targetUri]: operationHash,
        },
      });
      assert.strictEqual(previewResult.ok, true);
      operationIds = previewResult.preview.operations.map((operation) => operation.operationId);
      operationTargetUris = previewResult.preview.operations.map(
        (operation) => operation.targetUri ?? targetUri
      );
    }

    return {
      tempDir,
      targetPath,
      backupPath,
      targetUri,
      backupUri,
      targetSource,
      incomingSource,
      session,
      previewId,
      operationId: operationIds[0],
      operationIds,
      operationTargetUris,
      operationHash,
    };
  }
});

interface ExecutionContextInput {
  targetSource: string;
  plannedCurrentSource: string;
  incomingSource: string;
  storedOperationMode: 'duplicateLogical' | 'caseVariantTarget' | 'logicalAndLeaf';
}

interface ExecutionContext {
  backupUri: string;
  operationHash: string;
  operationId: string;
  operationIds: string[];
  operationTargetUris: string[];
  previewId: string;
  session: CompareSession;
  tempDir: string;
  targetPath: string;
  targetUri: string;
}

function createPreflight(
  context: ExecutionContext,
  options: { approve: boolean }
): PreflightResult {
  if (options.approve) {
    context.session.approvePreview(context.previewId);
  }

  return validateMergePreflight({
    session: context.session,
    previewId: context.previewId,
    approvedPreviewId: context.previewId,
    currentTargetHashes: {
      ...Object.fromEntries(
        context.operationTargetUris.map((targetUri) => [targetUri, context.operationHash])
      ),
    },
    backupPlan: backupPlanForContext(context),
    rollbackPlan: rollbackPlanForContext(context),
  });
}

function logicalOperation(
  plan: BslRoutineLogicalMergePlan,
  targetUri: string,
  expectedOldHash: string,
  current: BslRoutineLogicalSnapshot
): MergeOperation {
  const candidate = logicalCandidate(plan, targetUri, expectedOldHash, current);
  return {
    operationId: 'bslLogicalRoutineMerge:0:Catalog.Products.Object.Run',
    kind: 'bslLogicalRoutineMerge',
    sourceId: candidate.sourceId,
    snapshotId: candidate.snapshotId,
    nodeId: candidate.nodeId,
    targetUri: candidate.targetUri,
    expectedOldHash: candidate.expectedOldHash,
    newHash: candidate.newHash,
    logicalRoutine: candidate.logicalRoutine,
  };
}

function storedOperationsForMode(
  mode: ExecutionContextInput['storedOperationMode'],
  baseOperation: MergeOperation
): MergeOperation[] {
  if (mode === 'duplicateLogical') {
    return [
      baseOperation,
      {
        ...baseOperation,
        operationId: `${baseOperation.operationId}:duplicate`,
      },
    ];
  }

  if (mode === 'caseVariantTarget') {
    return [
      baseOperation,
      {
        ...baseOperation,
        operationId: `${baseOperation.operationId}:case-variant`,
        targetUri: baseOperation.targetUri?.toLowerCase(),
      },
    ];
  }

  return [
    baseOperation,
    {
      ...baseOperation,
      operationId: 'bslLeafReplace:1:Catalog.Products.Object.Run',
      kind: 'bslLeafReplace',
      logicalRoutine: undefined,
    },
  ];
}

function logicalCandidate(
  plan: BslRoutineLogicalMergePlan,
  targetUri: string,
  expectedOldHash: string,
  current: BslRoutineLogicalSnapshot
): MergeCandidate {
  return {
    kind: 'bslLogicalRoutineMerge',
    sourceId: 'right-source',
    snapshotId: 'snapshot-right-1',
    nodeId: 'Catalog.Products.Object.Run',
    targetUri,
    expectedOldHash,
    newHash: 'sha256:logical-new',
    logicalRoutine: {
      moduleId: 'Catalog.Products.Object',
      plan,
      current,
    },
  };
}

function backupPlanForContext(context: ExecutionContext): BackupPlan {
  return {
    previewId: context.previewId,
    strategy: 'copyBeforeWrite',
    items: context.operationIds.map((operationId, index) => ({
      operationId,
      targetUri: context.operationTargetUris[index] ?? context.targetUri,
      backupUri: backupUriFor(context, index),
      expectedOldHash: context.operationHash,
    })),
  };
}

function rollbackPlanForContext(context: ExecutionContext): RollbackPlan {
  return {
    previewId: context.previewId,
    strategy: 'restoreBackups',
    items: context.operationIds.map((operationId, index) => ({
      operationId,
      targetUri: context.operationTargetUris[index] ?? context.targetUri,
      backupUri: backupUriFor(context, index),
      restoreHash: context.operationHash,
    })),
  };
}

function backupUriFor(context: ExecutionContext, index: number): string {
  if (index === 0) {
    return context.backupUri;
  }

  return pathToFileURL(path.join(context.tempDir, 'backups', `ObjectModule.${index}.bsl.bak`)).toString();
}

function snapshot(source: string, filePath: string, configRoot: string) {
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
    sourceId: 'merge',
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

function makeSession(rootUri: string): CompareSession {
  const session = CompareSession.create({
    sessionId: 'session-1',
    createdAt: '2026-05-30T10:00:00.000Z',
    sources: [
      {
        sourceId: 'left-source',
        side: 'left',
        kind: 'workspace',
        displayName: 'Current workspace',
        rootUri: pathToFileURL(rootUri).toString(),
        writable: true,
      },
      {
        sourceId: 'right-source',
        side: 'right',
        kind: 'snapshot',
        displayName: 'Incoming snapshot',
        rootUri: 'file:///snapshots/right',
        writable: false,
      },
    ],
  });

  session.registerSnapshot({
    snapshotId: 'snapshot-left-1',
    sourceId: 'left-source',
    snapshotRoot: pathToFileURL(rootUri).toString(),
    origin: pathToFileURL(rootUri).toString(),
    createdAt: '2026-05-30T10:01:00.000Z',
    retentionUntil: '2026-05-30T12:01:00.000Z',
    sourceRevision: 'worktree:abc',
    readOnly: false,
    cleanupPolicy: 'deleteOnSessionClose',
    contentHash: 'sha256:left',
  });
  session.registerSnapshot({
    snapshotId: 'snapshot-right-1',
    sourceId: 'right-source',
    snapshotRoot: 'file:///tmp/compare/session-1/right',
    origin: 'file:///snapshots/right',
    createdAt: '2026-05-30T10:01:00.000Z',
    retentionUntil: '2026-05-30T12:01:00.000Z',
    sourceRevision: 'snapshot:42',
    readOnly: true,
    cleanupPolicy: 'retainUntil',
    contentHash: 'sha256:right',
  });

  return session;
}

function defaultTargetSource(): string {
  return moduleSource(defaultTargetLines());
}

function defaultIncomingSource(): string {
  return moduleSource(defaultIncomingLines());
}

function defaultTargetLines(): string[] {
  return [
    'Procedure Run()',
    '  If A Then',
    '    A = 1;',
    '  EndIf;',
    '  If B Then',
    '    B = 1;',
    '  EndIf;',
    'EndProcedure',
  ];
}

function defaultIncomingLines(): string[] {
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
  ];
}

function moduleSource(lines: readonly string[], eol = '\n'): string {
  return lines.join(eol);
}

async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf8');
}

async function assertFileMissing(filePath: string): Promise<void> {
  await assert.rejects(() => fs.stat(filePath), { code: 'ENOENT' });
}
