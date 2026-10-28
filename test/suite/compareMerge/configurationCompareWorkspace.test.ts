import * as assert from 'assert';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

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
import { hashXmlText } from '../../../src/compareMerge/xml/xmlPatch';

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

  test('rejects semantically invalid selected XML before creating or approving preview', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'compare-workspace-semantic-xml-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const targetPath = path.join(leftRoot, 'Catalogs', 'Products', 'Forms', 'Edit', 'Ext', 'Form.xml');
    const sourcePath = path.join(rightRoot, 'Catalogs', 'Products', 'Forms', 'Edit', 'Ext', 'Form.xml');
    const backupRootPath = path.join(tempRoot, 'backups');
    const baseline = '<Form><ChildItems><InputField name="A" id="1"/><InputField name="B" id="2"/></ChildItems><Attributes/><Commands/></Form>';
    const invalidFinal = '<Form><ChildItems><InputField name="A" id="1"/><InputField name="B" id="1"/></ChildItems><Attributes/><Commands/></Form>';
    const incoming = baseline.replace('id="2"', 'id="1"');
    const targetUri = pathToFileURL(targetPath).toString();
    const rightRootUri = pathToFileURL(rightRoot).toString();

    try {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.writeFile(targetPath, baseline, 'utf8');
      await fs.writeFile(sourcePath, incoming, 'utf8');

      const session = CompareSession.create({
        sessionId: 'semantic-workspace-session',
        createdAt: '2026-05-30T10:00:00.000Z',
        sources: [
          { sourceId: 'left-source', side: 'left', kind: 'workspace', displayName: 'Left', rootUri: pathToFileURL(leftRoot).toString(), writable: true },
          { sourceId: 'right-source', side: 'right', kind: 'snapshot', displayName: 'Right', rootUri: rightRootUri, writable: false },
        ],
      });
      session.registerSnapshot({
        snapshotId: 'snapshot-left-1', sourceId: 'left-source', snapshotRoot: pathToFileURL(leftRoot).toString(),
        origin: pathToFileURL(leftRoot).toString(), createdAt: '2026-05-30T10:00:00.000Z',
        retentionUntil: '2026-05-30T12:00:00.000Z', sourceRevision: 'left', readOnly: false,
        cleanupPolicy: 'manual', contentHash: 'left',
      });
      session.registerSnapshot({
        snapshotId: 'snapshot-right-1', sourceId: 'right-source', snapshotRoot: rightRootUri,
        origin: rightRootUri, createdAt: '2026-05-30T10:00:00.000Z',
        retentionUntil: '2026-05-30T12:00:00.000Z', sourceRevision: 'right', readOnly: true,
        cleanupPolicy: 'manual', contentHash: 'right',
      });

      const nodeId = 'xml:form:duplicate-id';
      const candidate: MergeCandidate = {
        kind: 'xmlNodeReplace', sourceId: 'right-source', snapshotId: 'snapshot-right-1', nodeId,
        targetUri, expectedOldHash: hashXmlText(baseline), newHash: hashXmlText(invalidFinal),
        xmlPatch: {
          kind: 'replaceNode',
          target: { filePath: targetUri, pointer: '/Form/ChildItems/InputField[1]', displayPath: 'Form/ChildItems/InputField[1]' },
          expectedOldHash: hashXmlText(baseline), newHash: hashXmlText(invalidFinal),
          replacementXml: '<InputField name="B" id="1"/>', semanticKind: 'formXml',
          sourceWitnesses: [{ sourceId: 'right-source', relativePath: path.relative(rightRoot, sourcePath), expectedHash: createHash('sha256').update(Buffer.from(incoming, 'utf8')).digest('hex'), kind: 'file' }],
        },
      };
      const node: CompareTreeNode = {
        id: nodeId, label: 'InputField B', kind: 'formItem', status: 'changed', mergeable: true,
        mergeState: { state: 'ready', targetFilePath: targetPath }, children: [],
      };
      const workspace = new ConfigurationCompareWorkspace({
        session,
        projection: { root: { id: 'root', label: 'Compare', kind: 'configCompare', status: 'changed', children: [node] }, stats: { total: 1, different: 1, mergeable: 1 } },
        candidateFactories: new Map([[nodeId, async () => ({ ok: true, candidate })]]),
        leftRootPath: leftRoot, rightRootPath: rightRoot, backupRootPath,
      });

      const preview = await workspace.createPreviewForNodeIds([nodeId]);

      assert.strictEqual(preview.ok, false);
      assert.ok(preview.diagnostics.some((item) => item.code === 'XML_FORM_DUPLICATE_ID'));
      assert.strictEqual(workspace.approvePreview('preview-1').ok, false);
      assert.strictEqual(await fs.readFile(targetPath, 'utf8'), baseline);

      const legacyNodeId = 'xml:form:legacy-patch';
      const legacyFinal = baseline.replace('name="A"', 'name="A2"');
      const legacyCandidate: MergeCandidate = {
        ...candidate,
        nodeId: legacyNodeId,
        newHash: hashXmlText(legacyFinal),
        xmlPatch: {
          kind: 'replaceNode',
          target: { filePath: targetUri, pointer: '/Form/ChildItems/InputField[1]', displayPath: 'Form/ChildItems/InputField[1]' },
          expectedOldHash: hashXmlText(baseline), newHash: hashXmlText(legacyFinal),
          replacementXml: '<InputField name="A2" id="1"/>',
        },
      };
      const combinedWorkspace = new ConfigurationCompareWorkspace({
        session,
        projection: {
          root: {
            id: 'root', label: 'Compare', kind: 'configCompare', status: 'changed', children: [
              node,
              { ...node, id: legacyNodeId, label: 'Legacy XML edit' },
            ],
          },
          stats: { total: 2, different: 2, mergeable: 2 },
        },
        candidateFactories: new Map([
          [nodeId, async () => ({ ok: true, candidate })],
          [legacyNodeId, async () => ({ ok: true, candidate: legacyCandidate })],
        ]),
        leftRootPath: leftRoot, rightRootPath: rightRoot, backupRootPath,
      });
      const mixedPreview = await combinedWorkspace.createPreviewForNodeIds([nodeId, legacyNodeId]);
      assert.strictEqual(mixedPreview.ok, false);
      assert.ok(mixedPreview.diagnostics.some((item) => item.code === 'MERGE_XML_SEMANTIC_KIND_MISMATCH'));

      const unsupportedNodeId = 'xml:form:unsupported-kind';
      const unsupportedCandidate = {
        ...candidate,
        nodeId: unsupportedNodeId,
        xmlPatch: { ...candidate.xmlPatch!, semanticKind: 'futureXml' },
      } as unknown as MergeCandidate;
      const unsupportedWorkspace = new ConfigurationCompareWorkspace({
        session,
        projection: {
          root: {
            id: 'root', label: 'Compare', kind: 'configCompare', status: 'changed',
            children: [{ ...node, id: unsupportedNodeId }],
          },
          stats: { total: 1, different: 1, mergeable: 1 },
        },
        candidateFactories: new Map([[unsupportedNodeId, async () => ({ ok: true, candidate: unsupportedCandidate })]]),
        leftRootPath: leftRoot, rightRootPath: rightRoot, backupRootPath,
      });
      const unsupportedPreview = await unsupportedWorkspace.createPreviewForNodeIds([unsupportedNodeId]);
      assert.strictEqual(unsupportedPreview.ok, false);
      assert.ok(unsupportedPreview.diagnostics.some((item) => item.code === 'MERGE_XML_SEMANTIC_KIND_UNSUPPORTED'));
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
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

  test('requires workspace-level confirmation for destructive approved preview', async () => {
    let executeCalls = 0;
    const workspace = makeWorkspace({
      candidate: fileDeleteCandidate(),
      executeMerge: async (input) => {
        executeCalls += 1;
        return emptyExecutionResult(input.preflight.previewId);
      },
    });
    const preview = await workspace.createPreviewForNodeIds(['bsl:routine:Catalog.Products.Object:run']);
    assert.strictEqual(preview.ok, true);
    workspace.approvePreview(preview.preview.previewId);

    const withoutConfirmation = await workspace.executeApprovedPreview(preview.preview.previewId);
    const withConfirmation = await workspace.executeApprovedPreview(preview.preview.previewId, {
      destructiveConfirmed: true,
    });

    assert.strictEqual(withoutConfirmation.ok, false);
    assert.strictEqual(
      withoutConfirmation.diagnostics[0]?.code,
      'CONFIG_COMPARE_DESTRUCTIVE_CONFIRMATION_REQUIRED'
    );
    assert.strictEqual(withConfirmation.ok, true);
    assert.strictEqual(executeCalls, 1);
  });

  test('treats a noncommitted receipt as failure even when legacy failures are empty', async () => {
    const workspace = makeWorkspace({
      executeMerge: async (input) => ({
        ...emptyExecutionResult(input.preflight.previewId),
        receipt: {
          status: 'recoveryRequired',
          code: 'RECOVERY_REQUIRED',
          message: 'Injected recovery uncertainty.',
          kind: 'configuration-compare-merge',
          resourcePath: path.join('repo', 'left'),
        },
      }),
    });
    const preview = await workspace.createPreviewForNodeIds(['bsl:routine:Catalog.Products.Object:run']);
    assert.strictEqual(preview.ok, true);
    workspace.approvePreview(preview.preview.previewId);

    const execution = await workspace.executeApprovedPreview(preview.preview.previewId);
    const afterRecovery = await workspace.createPreviewForNodeIds(['bsl:routine:Catalog.Products.Object:run']);

    assert.strictEqual(execution.ok, false);
    assert.strictEqual(execution.locked, true);
    assert.strictEqual(execution.result?.failed.length, 0);
    assert.strictEqual(execution.result?.receipt?.status, 'recoveryRequired');
    assert.strictEqual(afterRecovery.ok, false);
    assert.strictEqual(afterRecovery.diagnostics[0]?.code, 'CONFIG_COMPARE_WORKSPACE_LOCKED');
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

  test('refresh disposes the replaced session and workspace close disposes the current session once', async () => {
    const initialSession = makeSession();
    const refreshedSession = makeSession();
    let initialDisposals = 0;
    let refreshedDisposals = 0;
    const disposeInitial = initialSession.dispose.bind(initialSession);
    const disposeRefreshed = refreshedSession.dispose.bind(refreshedSession);
    initialSession.dispose = () => { initialDisposals += 1; disposeInitial(); };
    refreshedSession.dispose = () => { refreshedDisposals += 1; disposeRefreshed(); };
    const workspace = new ConfigurationCompareWorkspace({
      session: initialSession,
      projection: makeProjection(),
      leftRootPath: path.join('repo', 'left'),
      rightRootPath: path.join('repo', 'right'),
      candidateFactories: makeCandidateFactories({}),
      backupRootPath: path.join('repo', 'backups'),
      refreshWorkspace: async () => ({
        session: refreshedSession,
        projection: makeProjection(),
        candidateFactories: makeCandidateFactories({}),
      }),
    });

    await workspace.refresh();
    workspace.dispose();
    workspace.dispose();

    assert.strictEqual(initialDisposals, 1);
    assert.strictEqual(refreshedDisposals, 1);
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

function fileDeleteCandidate(): MergeCandidate {
  return {
    kind: 'fileDelete',
    sourceId: 'right-source',
    snapshotId: 'snapshot-right-1',
    nodeId: 'bsl:routine:Catalog.Products.Object:run',
    targetUri: 'file:///repo/Catalogs/Products/Ext/ObjectModule.bsl',
    expectedOldHash: 'sha256:old',
    fileOperation: {
      kind: 'fileDelete',
      targetPath: 'file:///repo/Catalogs/Products/Ext/ObjectModule.bsl',
      expectedOldHash: 'sha256:old',
      destructive: true,
    },
  };
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
