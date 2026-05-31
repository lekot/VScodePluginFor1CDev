import * as assert from 'assert';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { indexBslModuleSource, type BslModuleIdentity } from '../../../src/compareMerge/bsl/bslModuleIndexer';
import { createBslRoutineLogicalMergePlan } from '../../../src/compareMerge/bsl/bslRoutineLogicalMerge';
import type { BslRoutineLogicalMergePlan } from '../../../src/compareMerge/bsl/bslRoutineMergePlanTypes';
import type { CompareTreeNode } from '../../../src/compareMerge/compareTreeTypes';
import {
  ConfigurationCompareWorkspace,
  type ExecutableCandidateFactory,
} from '../../../src/compareMerge/configurationCompareWorkspace';
import { CompareSession } from '../../../src/compareMerge/domain/compareSession';
import type { CompareMessage } from '../../../src/compareMerge/domain/compareContracts';
import type { MergeCandidate } from '../../../src/compareMerge/merge/mergePlanner';

suite('ConfigurationCompareWorkspace', () => {
  test('resolves only host-side registered node ids and rejects forged webview input', async () => {
    const workspace = makeWorkspace();

    const preview = await workspace.createPreviewForNodeIds(['file:///forged/ObjectModule.bsl']);

    assert.strictEqual(preview.ok, false);
    assert.deepStrictEqual(
      preview.diagnostics.map((diagnostic) => diagnostic.code),
      ['CONFIG_COMPARE_UNKNOWN_SELECTION']
    );
    assert.deepStrictEqual(workspace.listMergeableNodeIds(), ['bsl:routine:Catalog.Products.Object:run']);
  });

  test('requires at least one executable selected node for preview and accepts bulk selection', async () => {
    const workspace = makeWorkspace({ includeAddedCandidate: true });

    const empty = await workspace.createPreviewForNodeIds([]);
    const multiple = await workspace.createPreviewForNodeIds([
      'bsl:routine:Catalog.Products.Object:run',
      'bsl:routine:Catalog.Products.Object:added',
    ]);

    assert.strictEqual(empty.ok, false);
    assert.strictEqual(empty.diagnostics[0]?.code, 'CONFIG_COMPARE_SINGLE_EXECUTABLE_REQUIRED');
    assert.strictEqual(multiple.ok, true);
    assert.strictEqual(multiple.preview.operationCount, 2);
  });

  test('keeps added deleted and reordered routines non-executable while changed routine previews', async () => {
    const workspace = makeWorkspace();

    assert.deepStrictEqual(workspace.listMergeableNodeIds(), ['bsl:routine:Catalog.Products.Object:run']);

    const added = await workspace.createPreviewForNodeIds(['bsl:routine:Catalog.Products.Object:added']);
    const changed = await workspace.createPreviewForNodeIds(['bsl:routine:Catalog.Products.Object:run']);

    assert.strictEqual(added.ok, false);
    assert.strictEqual(added.diagnostics[0]?.code, 'CONFIG_COMPARE_UNKNOWN_SELECTION');
    assert.strictEqual(changed.ok, true);
    assert.strictEqual(changed.preview.operationCount, 1);
    assert.strictEqual(JSON.stringify(changed.preview).includes('targetUri'), false);
    assert.strictEqual(JSON.stringify(changed.preview).includes('backup'), false);
    assert.strictEqual(JSON.stringify(changed.preview).includes('sha256'), false);
  });

  test('manual logical plan diagnostics create no approved executable preview', async () => {
    let executeCalls = 0;
    const workspace = makeWorkspace({
      candidate: manualCandidate(),
      executeMerge: async () => {
        executeCalls += 1;
        return emptyExecutionResult('unexpected');
      },
    });

    const preview = await workspace.createPreviewForNodeIds(['bsl:routine:Catalog.Products.Object:run']);

    assert.strictEqual(preview.ok, false);
    assert.ok(preview.diagnostics.some((diagnostic) => diagnostic.code === 'MERGE_LOGICAL_GUARD_BLOCKED'));
    assert.deepStrictEqual(workspace.approvePreview('preview-1').diagnostics.map((item) => item.code), [
      'CONFIG_COMPARE_PREVIEW_NOT_FOUND',
    ]);
    assert.strictEqual(executeCalls, 0);
  });

  test('redacts candidate diagnostics before returning preview errors', async () => {
    const leakedTargetPath = 'C:/secret/config/Catalogs/Products/Ext/ObjectModule.bsl';
    const workspace = makeWorkspace({
      candidateResult: {
        ok: false,
        diagnostics: [
          {
            severity: 'error',
            code: 'MERGE_LOGICAL_GUARD_BLOCKED',
            phase: 'preview',
            sourceId: 'right-source',
            nodeId: 'bsl:routine:Catalog.Products.Object:run',
            path: leakedTargetPath,
            blocking: true,
            suggestedAction: `Refresh ${leakedTargetPath} before retrying.`,
          },
        ],
      },
    });

    const preview = await workspace.createPreviewForNodeIds(['bsl:routine:Catalog.Products.Object:run']);

    assert.strictEqual(preview.ok, false);
    assert.strictEqual(JSON.stringify(preview.diagnostics).includes(leakedTargetPath), false);
  });

  test('generates random backup basenames under backup root and preview id', async () => {
    const preflights: Parameters<NonNullable<WorkspaceOptions['executeMerge']>>[0]['preflight'][] = [];
    const workspace = makeWorkspace({
      executeMerge: async (input) => {
        preflights.push(input.preflight);
        return failedExecutionResult(input.preflight.previewId);
      },
    });

    const first = await workspace.createPreviewForNodeIds(['bsl:routine:Catalog.Products.Object:run']);
    const second = await workspace.createPreviewForNodeIds(['bsl:routine:Catalog.Products.Object:run']);
    assert.strictEqual(first.ok, true);
    assert.strictEqual(second.ok, true);
    workspace.approvePreview(first.preview.previewId);
    workspace.approvePreview(second.preview.previewId);

    await workspace.executeApprovedPreview(first.preview.previewId);
    await workspace.executeApprovedPreview(second.preview.previewId);

    const backupPaths = preflights.map((preflight) =>
      fileURLToPath(preflight.backupPlan.items[0]!.backupUri)
    );
    assert.strictEqual(backupPaths.length, 2);
    assert.notStrictEqual(path.basename(backupPaths[0]!), 'operation-0.bak');
    assert.notStrictEqual(path.basename(backupPaths[1]!), 'operation-0.bak');
    assert.notStrictEqual(path.basename(backupPaths[0]!), path.basename(backupPaths[1]!));
    assert.strictEqual(path.basename(path.dirname(backupPaths[0]!)), first.preview.previewId);
    assert.strictEqual(path.basename(path.dirname(backupPaths[1]!)), second.preview.previewId);
  });

  test('rejects execute before approve and wrong preview id', async () => {
    const workspace = makeWorkspace();
    const preview = await workspace.createPreviewForNodeIds(['bsl:routine:Catalog.Products.Object:run']);
    assert.strictEqual(preview.ok, true);

    const beforeApprove = await workspace.executeApprovedPreview(preview.preview.previewId);
    workspace.approvePreview(preview.preview.previewId);
    const wrongPreview = await workspace.executeApprovedPreview('preview-forged');

    assert.strictEqual(beforeApprove.ok, false);
    assert.strictEqual(beforeApprove.diagnostics[0]?.code, 'CONFIG_COMPARE_PREVIEW_NOT_APPROVED');
    assert.strictEqual(wrongPreview.ok, false);
    assert.strictEqual(wrongPreview.diagnostics[0]?.code, 'CONFIG_COMPARE_PREVIEW_NOT_FOUND');
  });

  test('refresh and dispose invalidate stale previews safely', async () => {
    const workspace = makeWorkspace();
    const preview = await workspace.createPreviewForNodeIds(['bsl:routine:Catalog.Products.Object:run']);
    assert.strictEqual(preview.ok, true);
    workspace.approvePreview(preview.preview.previewId);

    await workspace.refresh();
    const afterRefresh = await workspace.executeApprovedPreview(preview.preview.previewId);
    workspace.dispose();
    const afterDispose = await workspace.createPreviewForNodeIds(['bsl:routine:Catalog.Products.Object:run']);

    assert.strictEqual(afterRefresh.ok, false);
    assert.strictEqual(afterRefresh.diagnostics[0]?.code, 'CONFIG_COMPARE_PREVIEW_NOT_FOUND');
    assert.strictEqual(afterDispose.ok, false);
    assert.strictEqual(afterDispose.diagnostics[0]?.code, 'CONFIG_COMPARE_WORKSPACE_DISPOSED');
    assert.deepStrictEqual(workspace.listMergeableNodeIds(), []);
  });

  test('successful execute reports and locks refresh failure diagnostics', async () => {
    const workspace = makeWorkspace({
      refreshWorkspace: async () => {
        throw new Error('refresh denied');
      },
    });
    const preview = await workspace.createPreviewForNodeIds(['bsl:routine:Catalog.Products.Object:run']);
    assert.strictEqual(preview.ok, true);
    workspace.approvePreview(preview.preview.previewId);

    const execution = await workspace.executeApprovedPreview(preview.preview.previewId);
    const afterFailure = await workspace.createPreviewForNodeIds(['bsl:routine:Catalog.Products.Object:run']);

    assert.strictEqual(execution.ok, true);
    assert.strictEqual(execution.locked, true);
    assert.ok(
      execution.diagnostics.some((diagnostic) => diagnostic.code === 'CONFIG_COMPARE_REFRESH_FAILED')
    );
    assert.strictEqual(afterFailure.ok, false);
    assert.strictEqual(afterFailure.diagnostics[0]?.code, 'CONFIG_COMPARE_WORKSPACE_LOCKED');
  });

  test('setStrategy refreshes projection stats and executable node ids for selected strategy', async () => {
    const refreshStrategies: string[] = [];
    const workspace = makeWorkspace({
      refreshWorkspace: async (strategy) => {
        refreshStrategies.push(strategy);
        return {
          session: makeSession(),
          projection: makeProjectionForStrategy(strategy),
          candidateFactories: makeCandidateFactoriesForStrategy(strategy),
        };
      },
    });

    const result = await workspace.setStrategy('full');

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(refreshStrategies, ['full']);
    assert.strictEqual(result.payload.strategy, 'full');
    assert.strictEqual(result.payload.root.id, 'configCompare:full');
    assert.deepStrictEqual(result.payload.stats, { total: 3, different: 3, mergeable: 2 });
    assert.deepStrictEqual(workspace.listMergeableNodeIds(), [
      'bsl:routine:Catalog.Products.Object:added',
      'bsl:routine:Catalog.Products.Object:run',
    ]);
  });
});

interface WorkspaceOptions {
  candidate?: MergeCandidate;
  candidateResult?: Awaited<ReturnType<ExecutableCandidateFactory>>;
  includeAddedCandidate?: boolean;
  executeMerge?: ConstructorParameters<typeof ConfigurationCompareWorkspace>[0]['executeMerge'];
  refreshWorkspace?: ConstructorParameters<typeof ConfigurationCompareWorkspace>[0]['refreshWorkspace'];
}

function makeWorkspace(options: WorkspaceOptions = {}): ConfigurationCompareWorkspace {
  const session = makeSession();
  return new ConfigurationCompareWorkspace({
    session,
    projection: makeProjection(),
    leftRootPath: path.join('repo', 'left'),
    rightRootPath: path.join('repo', 'right'),
    candidateFactories: makeCandidateFactories(options),
    createdAt: new Date('2026-05-30T10:10:00.000Z'),
    backupRootPath: path.join('repo', 'backups'),
    executeMerge: options.executeMerge ?? (async (input) => emptyExecutionResult(input.preflight.previewId)),
    refreshWorkspace:
      options.refreshWorkspace ??
      (async () => ({
        session: makeSession(),
        projection: makeProjection(),
        candidateFactories: new Map(),
      })),
  });
}

function makeCandidateFactories(
  options: Pick<WorkspaceOptions, 'candidate' | 'candidateResult' | 'includeAddedCandidate'> = {}
): Map<string, ExecutableCandidateFactory> {
  const candidateFactories = new Map<string, ExecutableCandidateFactory>([
    [
      'bsl:routine:Catalog.Products.Object:run',
      async () => ({
        ...(options.candidateResult ?? {
          ok: true,
          candidate: options.candidate ?? logicalCandidate(createAutoLogicalPlan(), 'run'),
        }),
      }),
    ],
  ]);
  if (options.includeAddedCandidate) {
    candidateFactories.set(
      'bsl:routine:Catalog.Products.Object:added',
      async () => ({
        ok: true,
        candidate: logicalCandidate(createAutoLogicalPlan(), 'added'),
      })
    );
  }

  return candidateFactories;
}

function makeCandidateFactoriesForStrategy(strategy: 'left' | 'right' | 'full'): Map<string, ExecutableCandidateFactory> {
  if (strategy === 'full') {
    return makeCandidateFactories({ includeAddedCandidate: true });
  }

  return new Map([
    ['bsl:routine:Catalog.Products.Object:run', makeCandidateFactories().get('bsl:routine:Catalog.Products.Object:run')!],
  ]);
}

function makeProjection() {
  const root: CompareTreeNode = {
    id: 'configCompare',
    label: 'Configuration compare',
    kind: 'configCompare',
    status: 'changed',
    children: [
      branch('bsl', 'BSL routines', [
        branch('bsl:module:Catalog.Products.Object', 'Catalog.Products.Object', [
          routineNode('run', 'Run', 'changed', true),
          routineNode('added', 'Added', 'rightOnly', false),
          routineNode('deleted', 'Deleted', 'leftOnly', false),
          routineNode('save', 'Save', 'changed', false),
        ]),
      ]),
    ],
  };

  return {
    root,
    stats: { total: 6, different: 4, mergeable: 2 },
  };
}

function makeProjectionForStrategy(strategy: 'left' | 'right' | 'full') {
  const projection = makeProjection();
  if (strategy !== 'full') {
    return projection;
  }

  return {
    root: {
      ...projection.root,
      id: 'configCompare:full',
    },
    stats: { total: 3, different: 3, mergeable: 2 },
  };
}

function branch(id: string, label: string, children: CompareTreeNode[]): CompareTreeNode {
  return {
    id,
    label,
    kind: id.startsWith('bsl:module') ? 'bslModule' : 'bslGroup',
    status: 'changed',
    children,
  };
}

function routineNode(
  suffix: string,
  label: string,
  status: CompareTreeNode['status'],
  mergeable: boolean
): CompareTreeNode {
  return {
    id: `bsl:routine:Catalog.Products.Object:${suffix}`,
    label,
    kind: 'bslRoutine',
    status,
    mergeable,
    mergeState: mergeable ? { state: 'ready', targetFilePath: 'ObjectModule.bsl' } : { state: 'readOnly' },
    children: [],
  };
}

function logicalCandidate(plan: BslRoutineLogicalMergePlan, suffix = 'run'): MergeCandidate {
  return {
    kind: 'bslLogicalRoutineMerge',
    sourceId: 'right-source',
    snapshotId: 'snapshot-right-1',
    nodeId: `bsl:routine:Catalog.Products.Object:${suffix}`,
    targetUri: 'file:///repo/Catalogs/Products/Ext/ObjectModule.bsl',
    expectedOldHash: 'sha256:old',
    newHash: 'sha256:new',
    logicalRoutine: {
      moduleId: 'Catalog.Products.Object',
      current: snapshot(defaultBaseRoutine()),
      plan,
    },
  };
}

function manualCandidate(): MergeCandidate {
  return logicalCandidate({
    ...createAutoLogicalPlan(),
    status: 'manual',
    operations: [],
    diagnostics: [
      {
        reason: 'changed-existing-node',
        message: 'Existing routine logic changed.',
      },
    ],
  });
}

function createAutoLogicalPlan(): BslRoutineLogicalMergePlan {
  const base = snapshot(defaultBaseRoutine());
  return createBslRoutineLogicalMergePlan({
    moduleId: 'Catalog.Products.Object',
    base,
    current: base,
    incoming: snapshot(defaultIncomingRoutine()),
  });
}

function snapshot(source: string) {
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
    sourceId: 'left-source',
    side: 'left',
    filePath: path.join('repo', 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl'),
    configRoot: 'repo',
    metadataType: 'Catalog',
    objectName: 'Products',
    moduleKind: 'Object',
    moduleId: 'Catalog.Products.Object',
    displayName: 'Catalog.Products.Object',
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
        kind: 'file',
        displayName: 'Incoming files',
        rootUri: 'file:///right',
        writable: false,
      },
    ],
  });

  session.registerSnapshot(snapshotContract('snapshot-left-1', 'left-source', 'left'));
  session.registerSnapshot(snapshotContract('snapshot-right-1', 'right-source', 'right'));
  return session;
}

function snapshotContract(snapshotId: string, sourceId: string, side: string) {
  return {
    snapshotId,
    sourceId,
    snapshotRoot: `file:///snapshot/${side}`,
    origin: `file:///${side}`,
    createdAt: '2026-05-30T10:00:00.000Z',
    retentionUntil: '2026-05-30T12:00:00.000Z',
    sourceRevision: `test:${side}`,
    readOnly: side === 'right',
    cleanupPolicy: 'deleteOnSessionClose' as const,
    contentHash: `sha256:${side}`,
  };
}

function defaultBaseRoutine(): string {
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

function defaultIncomingRoutine(): string {
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

function emptyExecutionResult(previewId: string) {
  return {
    previewId,
    approvedPreviewId: previewId,
    applied: [],
    skipped: [],
    failed: [],
    backupPaths: [],
    diagnostics: [] as CompareMessage[],
  };
}

function failedExecutionResult(previewId: string) {
  return {
    ...emptyExecutionResult(previewId),
    failed: [
      {
        operationId: previewId,
        kind: 'bslLogicalRoutineMerge' as const,
        code: 'TEST_STOP_AFTER_PREFLIGHT',
        message: 'Test captured preflight.',
      },
    ],
  };
}
