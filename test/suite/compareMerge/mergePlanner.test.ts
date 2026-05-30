import * as assert from 'assert';
import * as path from 'path';

import { indexBslModuleSource, type BslModuleIdentity } from '../../../src/compareMerge/bsl/bslModuleIndexer';
import { createBslRoutineLogicalMergePlan } from '../../../src/compareMerge/bsl/bslRoutineLogicalMerge';
import type { BslRoutineLogicalMergePlan } from '../../../src/compareMerge/bsl/bslRoutineMergePlanTypes';
import { CompareSession } from '../../../src/compareMerge/domain/compareSession';
import type { IdentityConflict } from '../../../src/compareMerge/domain/compareContracts';
import {
  createMergePreview,
  validateMergePreflight,
  type BackupPlan,
  type MergeCandidate,
  type MergeOperation,
  type RollbackPlan,
} from '../../../src/compareMerge/merge/mergePlanner';

suite('MergePlanner preview/preflight', () => {
  test('creates preview only for safe BSL logical operation and registers it in session store', () => {
    const session = makeSession();
    const plan = createAutoLogicalPlan();

    const result = createMergePreview({
      session,
      previewId: 'preview-logical',
      targetSourceId: 'left-source',
      snapshotIds: { left: 'snapshot-left-1', right: 'snapshot-right-1' },
      createdAt: '2026-05-30T10:10:00.000Z',
      candidates: [logicalCandidate(plan)],
      currentTargetHashes: {
        'file:///repo/Catalogs/Products/Ext/ObjectModule.bsl': 'sha256:old',
      },
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.preview.previewId, 'preview-logical');
    assert.strictEqual(result.preview.sessionId, 'session-1');
    assert.strictEqual(result.preview.operations.length, 1);
    assert.strictEqual(result.preview.operations[0].kind, 'bslLogicalRoutineMerge');
    assert.strictEqual(
      result.preview.operations[0].logicalRoutine?.plan.operations.length,
      plan.operations.length
    );
    assert.deepStrictEqual(
      session.state.previews.map((preview) => preview.previewId),
      ['preview-logical']
    );
  });

  test('unresolved identity conflict blocks preview creation', () => {
    const session = makeSession();
    const result = createMergePreview({
      session,
      previewId: 'preview-conflict',
      targetSourceId: 'left-source',
      snapshotIds: { left: 'snapshot-left-1', right: 'snapshot-right-1' },
      createdAt: '2026-05-30T10:10:00.000Z',
      candidates: [leafCandidate()],
      currentTargetHashes: {
        'file:///repo/Catalogs/Products/Ext/ObjectModule.bsl': 'sha256:old',
      },
      identityConflicts: [identityConflict()],
    });

    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(
      result.diagnostics.map((diagnostic) => diagnostic.code),
      ['MERGE_IDENTITY_CONFLICT']
    );
    assert.deepStrictEqual(session.state.previews, []);
  });

  test('metadata add/remove and Configuration.xml structural operation are unsupported blocking operations', () => {
    const session = makeSession();
    const unsupportedKinds: MergeCandidate['kind'][] = [
      'metadataObjectAdd',
      'metadataObjectRemove',
      'configurationXmlStructuralMerge',
    ];

    const result = createMergePreview({
      session,
      previewId: 'preview-unsupported',
      targetSourceId: 'left-source',
      snapshotIds: { left: 'snapshot-left-1', right: 'snapshot-right-1' },
      createdAt: '2026-05-30T10:10:00.000Z',
      candidates: unsupportedKinds.map((kind, index) => ({
        kind,
        sourceId: 'right-source',
        snapshotId: 'snapshot-right-1',
        nodeId: `node-${index}`,
      })),
      currentTargetHashes: {},
    });

    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(
      result.diagnostics.map((diagnostic) => diagnostic.code),
      [
        'MERGE_UNSUPPORTED_OPERATION',
        'MERGE_UNSUPPORTED_OPERATION',
        'MERGE_UNSUPPORTED_OPERATION',
      ]
    );
    assert.deepStrictEqual(session.state.previews, []);
  });

  test('stale target hash blocks file operation preview', () => {
    const session = makeSession();
    const result = createMergePreview({
      session,
      previewId: 'preview-stale',
      targetSourceId: 'left-source',
      snapshotIds: { left: 'snapshot-left-1', right: 'snapshot-right-1' },
      createdAt: '2026-05-30T10:10:00.000Z',
      candidates: [leafCandidate()],
      currentTargetHashes: {
        'file:///repo/Catalogs/Products/Ext/ObjectModule.bsl': 'sha256:changed',
      },
    });

    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(
      result.diagnostics.map((diagnostic) => diagnostic.code),
      ['MERGE_STALE_TARGET_HASH']
    );
    assert.deepStrictEqual(session.state.previews, []);
  });

  test('logical routine operation with guard diagnostics blocks preview', () => {
    const session = makeSession();
    const manualPlan: BslRoutineLogicalMergePlan = {
      ...createAutoLogicalPlan(),
      status: 'manual',
      operations: [],
      diagnostics: [
        {
          reason: 'changed-existing-node',
          message: 'Existing routine logic changed.',
        },
      ],
    };

    const result = createMergePreview({
      session,
      previewId: 'preview-manual-logical',
      targetSourceId: 'left-source',
      snapshotIds: { left: 'snapshot-left-1', right: 'snapshot-right-1' },
      createdAt: '2026-05-30T10:10:00.000Z',
      candidates: [logicalCandidate(manualPlan)],
      currentTargetHashes: {
        'file:///repo/Catalogs/Products/Ext/ObjectModule.bsl': 'sha256:old',
      },
    });

    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(
      result.diagnostics.map((diagnostic) => diagnostic.code),
      ['MERGE_LOGICAL_GUARD_BLOCKED', 'MERGE_LOGICAL_GUARD_BLOCKED']
    );
    assert.deepStrictEqual(session.state.previews, []);
  });

  test('valid logical plan becomes first-class operation payload', () => {
    const session = makeSession();
    const plan = createAutoLogicalPlan();
    const result = createMergePreview({
      session,
      previewId: 'preview-payload',
      targetSourceId: 'left-source',
      snapshotIds: { left: 'snapshot-left-1', right: 'snapshot-right-1' },
      createdAt: '2026-05-30T10:10:00.000Z',
      candidates: [logicalCandidate(plan)],
      currentTargetHashes: {
        'file:///repo/Catalogs/Products/Ext/ObjectModule.bsl': 'sha256:old',
      },
    });

    assert.strictEqual(result.ok, true);
    const operation = result.preview.operations[0];
    assert.strictEqual(operation.kind, 'bslLogicalRoutineMerge');
    assert.strictEqual(operation.sourceId, 'right-source');
    assert.strictEqual(operation.snapshotId, 'snapshot-right-1');
    assert.strictEqual(operation.targetUri, 'file:///repo/Catalogs/Products/Ext/ObjectModule.bsl');
    assert.strictEqual(operation.expectedOldHash, 'sha256:old');
    assert.strictEqual(operation.logicalRoutine?.moduleId, 'Catalog.Products.Object');
    assert.strictEqual(operation.logicalRoutine?.plan.kind, 'logicalRoutineMergePlan');
  });

  test('preflight validates approved preview id path, hashes, resolutions and backup metadata', () => {
    const session = makeSession();
    const previewResult = createMergePreview({
      session,
      previewId: 'preview-preflight',
      targetSourceId: 'left-source',
      snapshotIds: { left: 'snapshot-left-1', right: 'snapshot-right-1' },
      createdAt: '2026-05-30T10:10:00.000Z',
      candidates: [leafCandidate({ conflictId: 'conflict-1' })],
      currentTargetHashes: {
        'file:///repo/Catalogs/Products/Ext/ObjectModule.bsl': 'sha256:old',
      },
      conflictResolutions: { 'conflict-1': 'acceptIncoming' },
    });
    assert.strictEqual(previewResult.ok, true);

    const preview = previewResult.preview;
    const backupPlan = backupPlanFor(preview.previewId, preview.operations[0].operationId);
    const rollbackPlan = rollbackPlanFor(preview.previewId, preview.operations[0].operationId);
    session.approvePreview(preview.previewId);

    const result = validateMergePreflight({
      session,
      previewId: preview.previewId,
      approvedPreviewId: preview.previewId,
      currentTargetHashes: {
        'file:///repo/Catalogs/Products/Ext/ObjectModule.bsl': 'sha256:old',
      },
      conflictResolutions: { 'conflict-1': 'acceptIncoming' },
      backupPlan,
      rollbackPlan,
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.approvedPreviewId, 'preview-preflight');
    assert.deepStrictEqual(result.diagnostics, []);
  });

  test('preflight uses approved stored preview payload instead of caller-mutated preview operations', () => {
    const session = makeSession();
    const previewResult = createMergePreview({
      session,
      previewId: 'preview-trusted-payload',
      targetSourceId: 'left-source',
      snapshotIds: { left: 'snapshot-left-1', right: 'snapshot-right-1' },
      createdAt: '2026-05-30T10:10:00.000Z',
      candidates: [leafCandidate()],
      currentTargetHashes: {
        'file:///repo/Catalogs/Products/Ext/ObjectModule.bsl': 'sha256:old',
      },
    });
    assert.strictEqual(previewResult.ok, true);

    const preview = previewResult.preview;
    const storedOperationId = preview.operations[0].operationId;
    const backupPlan = backupPlanFor(preview.previewId, storedOperationId);
    const rollbackPlan = rollbackPlanFor(preview.previewId, storedOperationId);

    preview.operations[0] = {
      ...preview.operations[0],
      operationId: 'forged-operation',
      nodeId: 'Catalog.Products.Object.Forged',
      newHash: 'sha256:forged',
    };

    session.approvePreview(preview.previewId);
    const result = validateMergePreflight({
      session,
      previewId: preview.previewId,
      approvedPreviewId: preview.previewId,
      currentTargetHashes: {
        'file:///repo/Catalogs/Products/Ext/ObjectModule.bsl': 'sha256:old',
      },
      backupPlan,
      rollbackPlan,
    });

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(
      result.operations.map((operation) => operation.operationId),
      [storedOperationId]
    );
    assert.strictEqual(result.operations[0].nodeId, 'Catalog.Products.Object.Run');
  });

  test('preflight rejects forged approved stored payload with unsupported operation kind', () => {
    const session = makeSession();
    const forgedOperation = {
      ...leafCandidate(),
      operationId: 'configurationXmlStructuralMerge:0:Configuration',
      kind: 'configurationXmlStructuralMerge',
      nodeId: 'Configuration',
      targetUri: 'file:///repo/Configuration.xml',
      expectedOldHash: 'sha256:configuration-old',
      newHash: 'sha256:configuration-new',
    } as unknown as MergeOperation;

    const preview = session.createPreview({
      previewId: 'preview-forged-unsupported-kind',
      targetSourceId: 'left-source',
      snapshotIds: { left: 'snapshot-left-1', right: 'snapshot-right-1' },
      createdAt: '2026-05-30T10:10:00.000Z',
      summary: 'Forged unsupported operation.',
      payload: {
        kind: 'mergePreviewPayload',
        operations: [forgedOperation],
        diagnostics: [],
      },
    });
    session.approvePreview(preview.previewId);

    const result = validateMergePreflight({
      session,
      previewId: preview.previewId,
      approvedPreviewId: preview.previewId,
      currentTargetHashes: {
        'file:///repo/Configuration.xml': 'sha256:configuration-old',
      },
      backupPlan: backupPlanFor(preview.previewId, forgedOperation.operationId, {
        targetUri: 'file:///repo/Configuration.xml',
        backupUri: 'file:///backup/Configuration.xml',
        expectedOldHash: 'sha256:configuration-old',
      }),
      rollbackPlan: rollbackPlanFor(preview.previewId, forgedOperation.operationId, {
        targetUri: 'file:///repo/Configuration.xml',
        backupUri: 'file:///backup/Configuration.xml',
        restoreHash: 'sha256:configuration-old',
      }),
    });

    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(
      result.diagnostics.map((diagnostic) => diagnostic.code),
      ['MERGE_UNSUPPORTED_OPERATION']
    );
    assert.deepStrictEqual(result.operations, []);
  });

  test('preflight rejects preview id that was not approved in session lifecycle', () => {
    const session = makeSession();
    const previewResult = createMergePreview({
      session,
      previewId: 'preview-not-approved',
      targetSourceId: 'left-source',
      snapshotIds: { left: 'snapshot-left-1', right: 'snapshot-right-1' },
      createdAt: '2026-05-30T10:10:00.000Z',
      candidates: [leafCandidate()],
      currentTargetHashes: {
        'file:///repo/Catalogs/Products/Ext/ObjectModule.bsl': 'sha256:old',
      },
    });
    assert.strictEqual(previewResult.ok, true);

    const preview = previewResult.preview;
    const result = validateMergePreflight({
      session,
      previewId: preview.previewId,
      approvedPreviewId: preview.previewId,
      currentTargetHashes: {
        'file:///repo/Catalogs/Products/Ext/ObjectModule.bsl': 'sha256:old',
      },
      backupPlan: backupPlanFor(preview.previewId, preview.operations[0].operationId),
      rollbackPlan: rollbackPlanFor(preview.previewId, preview.operations[0].operationId),
    });

    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(
      result.diagnostics.map((diagnostic) => diagnostic.code),
      ['MERGE_PREVIEW_NOT_EXECUTABLE']
    );
  });

  test('keepTarget conflict resolution creates no write operation', () => {
    const session = makeSession();
    const result = createMergePreview({
      session,
      previewId: 'preview-keep-target',
      targetSourceId: 'left-source',
      snapshotIds: { left: 'snapshot-left-1', right: 'snapshot-right-1' },
      createdAt: '2026-05-30T10:10:00.000Z',
      candidates: [leafCandidate({ conflictId: 'conflict-keep-target' })],
      currentTargetHashes: {
        'file:///repo/Catalogs/Products/Ext/ObjectModule.bsl': 'sha256:old',
      },
      conflictResolutions: { 'conflict-keep-target': 'keepTarget' },
    });

    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(
      result.diagnostics.map((diagnostic) => diagnostic.code),
      ['MERGE_NO_EXECUTABLE_OPERATIONS']
    );
    assert.deepStrictEqual(session.state.previews, []);
  });

  test('preflight rejects backup and rollback items that are not tied to approved operations', () => {
    const session = makeSession();
    const previewResult = createMergePreview({
      session,
      previewId: 'preview-extra-plan-items',
      targetSourceId: 'left-source',
      snapshotIds: { left: 'snapshot-left-1', right: 'snapshot-right-1' },
      createdAt: '2026-05-30T10:10:00.000Z',
      candidates: [leafCandidate()],
      currentTargetHashes: {
        'file:///repo/Catalogs/Products/Ext/ObjectModule.bsl': 'sha256:old',
      },
    });
    assert.strictEqual(previewResult.ok, true);

    const preview = previewResult.preview;
    const operationId = preview.operations[0].operationId;
    const backupPlan = backupPlanFor(preview.previewId, operationId);
    const rollbackPlan = rollbackPlanFor(preview.previewId, operationId);
    backupPlan.items.push({
      operationId: 'extra-operation',
      targetUri: 'file:///repo/Catalogs/Products/Ext/ManagerModule.bsl',
      backupUri: 'file:///backup/ManagerModule.bsl',
      expectedOldHash: 'sha256:extra-old',
    });
    rollbackPlan.items.push({
      operationId: 'extra-operation',
      targetUri: 'file:///repo/Catalogs/Products/Ext/ManagerModule.bsl',
      backupUri: 'file:///backup/ManagerModule.bsl',
      restoreHash: 'sha256:extra-old',
    });

    session.approvePreview(preview.previewId);
    const result = validateMergePreflight({
      session,
      previewId: preview.previewId,
      approvedPreviewId: preview.previewId,
      currentTargetHashes: {
        'file:///repo/Catalogs/Products/Ext/ObjectModule.bsl': 'sha256:old',
      },
      backupPlan,
      rollbackPlan,
    });

    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(
      result.diagnostics.map((diagnostic) => diagnostic.code),
      ['MERGE_BACKUP_PLAN_EXTRA_ITEM', 'MERGE_ROLLBACK_PLAN_EXTRA_ITEM']
    );
  });

  test('preflight rejects duplicate backup or rollback items for the same operation', () => {
    const session = makeSession();
    const previewResult = createMergePreview({
      session,
      previewId: 'preview-duplicate-plan-items',
      targetSourceId: 'left-source',
      snapshotIds: { left: 'snapshot-left-1', right: 'snapshot-right-1' },
      createdAt: '2026-05-30T10:10:00.000Z',
      candidates: [leafCandidate()],
      currentTargetHashes: {
        'file:///repo/Catalogs/Products/Ext/ObjectModule.bsl': 'sha256:old',
      },
    });
    assert.strictEqual(previewResult.ok, true);

    const preview = previewResult.preview;
    const operationId = preview.operations[0].operationId;
    const backupPlan = backupPlanFor(preview.previewId, operationId);
    backupPlan.items.push({
      operationId,
      targetUri: 'file:///repo/Catalogs/Products/Ext/ObjectModule.bsl',
      backupUri: 'file:///backup/ObjectModule-duplicate.bsl',
      expectedOldHash: 'sha256:old',
    });

    session.approvePreview(preview.previewId);
    const duplicateBackupResult = validateMergePreflight({
      session,
      previewId: preview.previewId,
      approvedPreviewId: preview.previewId,
      currentTargetHashes: {
        'file:///repo/Catalogs/Products/Ext/ObjectModule.bsl': 'sha256:old',
      },
      backupPlan,
      rollbackPlan: rollbackPlanFor(preview.previewId, operationId),
    });

    assert.strictEqual(duplicateBackupResult.ok, false);
    assert.deepStrictEqual(
      duplicateBackupResult.diagnostics.map((diagnostic) => diagnostic.code),
      ['MERGE_BACKUP_PLAN_DUPLICATE_ITEM']
    );
    assert.strictEqual(duplicateBackupResult.backupPlan.items.length, 1);

    const rollbackPlan = rollbackPlanFor(preview.previewId, operationId);
    rollbackPlan.items.push({
      operationId,
      targetUri: 'file:///repo/Catalogs/Products/Ext/ObjectModule.bsl',
      backupUri: 'file:///backup/ObjectModule-duplicate.bsl',
      restoreHash: 'sha256:old',
    });

    const duplicateRollbackResult = validateMergePreflight({
      session,
      previewId: preview.previewId,
      approvedPreviewId: preview.previewId,
      currentTargetHashes: {
        'file:///repo/Catalogs/Products/Ext/ObjectModule.bsl': 'sha256:old',
      },
      backupPlan: backupPlanFor(preview.previewId, operationId),
      rollbackPlan,
    });

    assert.strictEqual(duplicateRollbackResult.ok, false);
    assert.deepStrictEqual(
      duplicateRollbackResult.diagnostics.map((diagnostic) => diagnostic.code),
      ['MERGE_ROLLBACK_PLAN_DUPLICATE_ITEM']
    );
    assert.strictEqual(duplicateRollbackResult.rollbackPlan.items.length, 1);
  });

  test('approved preview lifecycle remains owned by PreviewStore, not returned preview payload', () => {
    const session = makeSession();
    const result = createMergePreview({
      session,
      previewId: 'preview-lifecycle',
      targetSourceId: 'left-source',
      snapshotIds: { left: 'snapshot-left-1', right: 'snapshot-right-1' },
      createdAt: '2026-05-30T10:10:00.000Z',
      candidates: [leafCandidate()],
      currentTargetHashes: {
        'file:///repo/Catalogs/Products/Ext/ObjectModule.bsl': 'sha256:old',
      },
    });
    assert.strictEqual(result.ok, true);

    result.preview.approvalState = 'approved';

    assert.strictEqual(session.canExecutePreview(result.preview.previewId), false);
    session.approvePreview(result.preview.previewId);
    assert.strictEqual(session.canExecutePreview(result.preview.previewId), true);
  });
});

function leafCandidate(overrides: Partial<MergeCandidate> = {}): MergeCandidate {
  return {
    kind: 'bslLeafReplace',
    sourceId: 'right-source',
    snapshotId: 'snapshot-right-1',
    nodeId: 'Catalog.Products.Object.Run',
    targetUri: 'file:///repo/Catalogs/Products/Ext/ObjectModule.bsl',
    expectedOldHash: 'sha256:old',
    newHash: 'sha256:new',
    ...overrides,
  };
}

function logicalCandidate(plan: BslRoutineLogicalMergePlan): MergeCandidate {
  return {
    kind: 'bslLogicalRoutineMerge',
    sourceId: 'right-source',
    snapshotId: 'snapshot-right-1',
    nodeId: 'Catalog.Products.Object.Run',
    targetUri: 'file:///repo/Catalogs/Products/Ext/ObjectModule.bsl',
    expectedOldHash: 'sha256:old',
    newHash: 'sha256:logical-new',
    logicalRoutine: {
      moduleId: 'Catalog.Products.Object',
      plan,
      current: snapshot([
        'Procedure Run()',
        '  If A Then',
        '    A = 1;',
        '  EndIf;',
        '  If B Then',
        '    B = 1;',
        '  EndIf;',
        'EndProcedure',
      ]),
    },
  };
}

function createAutoLogicalPlan(): BslRoutineLogicalMergePlan {
  const base = snapshot([
    'Procedure Run()',
    '  If A Then',
    '    A = 1;',
    '  EndIf;',
    '  If B Then',
    '    B = 1;',
    '  EndIf;',
    'EndProcedure',
  ]);
  const incoming = snapshot([
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
  ]);

  return createBslRoutineLogicalMergePlan({
    moduleId: 'Catalog.Products.Object',
    base,
    current: base,
    incoming,
  });
}

function snapshot(lines: string[]) {
  const source = lines.join('\n');
  const module = indexBslModuleSource({
    identity: makeIdentity(),
    source,
  });
  return {
    source,
    routine: module.routines[0],
  };
}

function makeIdentity(): BslModuleIdentity {
  return {
    sourceId: 'merge',
    side: 'left',
    filePath: path.join('root', 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl'),
    configRoot: 'root',
    metadataType: 'Catalog',
    objectName: 'Products',
    moduleKind: 'Object',
    moduleId: 'Catalog.Products.Object',
    displayName: 'Catalog.Products.Object',
  };
}

function identityConflict(): IdentityConflict {
  return {
    kind: 'sameNameDifferentUuid',
    resolution: 'manual',
    blocking: true,
    message: 'Catalog.Products has different UUIDs.',
    qualifiedName: 'Catalog.Products',
    identities: [],
  };
}

function backupPlanFor(
  previewId: string,
  operationId: string,
  overrides: Partial<BackupPlan['items'][number]> = {}
): BackupPlan {
  return {
    previewId,
    strategy: 'copyBeforeWrite',
    items: [
      {
        operationId,
        targetUri: 'file:///repo/Catalogs/Products/Ext/ObjectModule.bsl',
        backupUri: 'file:///backup/ObjectModule.bsl',
        expectedOldHash: 'sha256:old',
        ...overrides,
      },
    ],
  };
}

function rollbackPlanFor(
  previewId: string,
  operationId: string,
  overrides: Partial<RollbackPlan['items'][number]> = {}
): RollbackPlan {
  return {
    previewId,
    strategy: 'restoreBackups',
    items: [
      {
        operationId,
        targetUri: 'file:///repo/Catalogs/Products/Ext/ObjectModule.bsl',
        backupUri: 'file:///backup/ObjectModule.bsl',
        restoreHash: 'sha256:old',
        ...overrides,
      },
    ],
  };
}

function makeSession(): CompareSession {
  const session = CompareSession.create({
    sessionId: 'session-1',
    createdAt: '2026-05-30T10:00:00.000Z',
    sources: [
      {
        sourceId: 'left-source',
        side: 'left',
        kind: 'workspace',
        displayName: 'Current workspace',
        rootUri: 'file:///repo',
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
    snapshotRoot: 'file:///tmp/compare/session-1/left',
    origin: 'file:///repo',
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
