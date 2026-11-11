import * as assert from 'assert';
import * as path from 'path';

import {
  bindConfigurationCompareWebview,
  renderConfigCompareWebviewHtml,
} from '../../../src/compareMerge/configCompareProvider';
import type { ConfigCompareHostToWebviewMessage } from '../../../src/compareMerge/configCompareMessages';
import type { CompareBuildOptions, CompareBuildProgress } from '../../../src/compareMerge/compareProgress';
import type { CompareTreeNode } from '../../../src/compareMerge/compareTreeTypes';
import type { CompareTreeProjection } from '../../../src/compareMerge/projection/compareTreeProjection';
import type {
  ConfigCompareWebviewPayload,
  WorkspaceApprovalResult,
  WorkspaceExecutionResult,
  WorkspacePreviewResult,
  WorkspaceRefreshResult,
  WorkspaceSelectionState,
} from '../../../src/compareMerge/configurationCompareWorkspace';
import type { CompareMessage } from '../../../src/compareMerge/domain/compareContracts';

suite('ConfigCompareProvider', () => {
  test('renders CSP nonce and bootstraps only redacted payload', () => {
    const html = renderConfigCompareWebviewHtml({
      webview: { cspSource: 'vscode-resource:' },
      payload: makePayload(),
      executableNodeIds: ['bsl:routine:Catalog.Products.Object:run'],
      title: 'Compare',
      nonce: 'nonce-test',
      htmlPath: path.join(process.cwd(), 'src', 'compareMerge', 'configCompareWebview.html'),
    });

    assert.match(html, /Content-Security-Policy[^>]+nonce-nonce-test/);
    assert.match(html, /<script nonce="nonce-test">/);
    assert.match(html, /window\.__configCompareData = /);
    assert.doesNotMatch(html, /C:\/left/);
    assert.doesNotMatch(html, /C:\/right/);
    assert.doesNotMatch(html, /sha256/);
    assert.doesNotMatch(html, /\bMVP\b/i);
    assert.doesNotMatch(html, /showNotice\(/);
  });

  test('handles preview approve and execute with redacted workspace messages', async () => {
    const panel = makePanel();
    const workspace = makeWorkspace();

    bindConfigurationCompareWebview(panel as any, workspace, 'Compare');

    await panel.send({ type: 'ready' });
    await panel.send({
      type: 'createPreview',
      nodeIds: ['bsl:routine:Catalog.Products.Object:run'],
    });
    await panel.send({ type: 'approvePreview', previewId: 'preview-1' });
    await panel.send({ type: 'executeMerge', previewId: 'preview-1' });

    const messageTypes = panel.posts.map((message) => message.type);
    assert.deepStrictEqual(messageTypes, [
      'state',
      'state',
      'previewReady',
      'state',
      'state',
      'previewReady',
      'state',
      'state',
      'mergeSuccess',
      'state',
    ]);
    assert.deepStrictEqual(workspace.calls, [
      'createPreview:bsl:routine:Catalog.Products.Object:run',
      'approve:preview-1',
      'execute:preview-1',
    ]);

    const serializedPosts = JSON.stringify(panel.posts);
    assert.doesNotMatch(serializedPosts, /targetUri|expectedOldHash|newHash|operationPayload|payloadRef/);
    assert.match(
      serializedPosts,
      /C:\\\\extension\\\\storage\\\\merge-backups\\\\preview-1\\\\[0-9a-f-]+\.bak/
    );
  });

  test('requires explicit confirmation before executing destructive preview', async () => {
    const panel = makePanel();
    const workspace = makeWorkspace({ destructivePreview: true });

    bindConfigurationCompareWebview(panel as any, workspace, 'Compare');

    await panel.send({
      type: 'createPreview',
      nodeIds: ['bsl:routine:Catalog.Products.Object:run'],
    });
    await panel.send({ type: 'approvePreview', previewId: 'preview-1' });
    await panel.send({ type: 'executeMerge', previewId: 'preview-1' });
    await panel.send({ type: 'executeMerge', previewId: 'preview-1', destructiveConfirmed: true });

    assert.deepStrictEqual(workspace.calls, [
      'createPreview:bsl:routine:Catalog.Products.Object:run',
      'approve:preview-1',
      'execute:preview-1',
    ]);
    const error = panel.posts.find((message) => message.type === 'mergeError');
    assert.ok(error);
    assert.match(error.message, /destructive|удален|перезапис/i);
    const preview = panel.posts.find((message) => message.type === 'previewReady');
    assert.ok(preview);
    assert.strictEqual(preview.destructiveCount, 1);
    assert.strictEqual(preview.items[0].destructive, true);
  });

  test('keeps approved destructive preview bound after selection changes', async () => {
    const panel = makePanel();
    const workspace = makeWorkspace({ destructivePreview: true });

    bindConfigurationCompareWebview(panel as any, workspace, 'Compare');

    await panel.send({
      type: 'createPreview',
      nodeIds: ['bsl:routine:Catalog.Products.Object:run'],
    });
    await panel.send({ type: 'approvePreview', previewId: 'preview-1' });
    await panel.send({ type: 'selectionChanged', nodeIds: [] });
    await panel.send({ type: 'executeMerge', previewId: 'preview-1' });

    assert.deepStrictEqual(workspace.calls, [
      'createPreview:bsl:routine:Catalog.Products.Object:run',
      'approve:preview-1',
      'select:',
    ]);
    const error = panel.posts.find((message) => message.type === 'mergeError');
    assert.ok(error);
    assert.match(error.message, /Preview.*не активен/i);
  });

  test('rejects strategy changes while an operation is busy', async () => {
    const panel = makePanel();
    const workspace = makeWorkspace({ deferPreview: true });

    bindConfigurationCompareWebview(panel as any, workspace, 'Compare');

    const previewRequest = panel.send({
      type: 'createPreview',
      nodeIds: ['bsl:routine:Catalog.Products.Object:run'],
    });
    await panel.waitForPost((message) => message.type === 'state' && message.busy);
    await panel.send({ type: 'setStrategy', strategy: 'full' });
    workspace.releasePreview();
    await previewRequest;

    assert.deepStrictEqual(workspace.calls, ['createPreview:bsl:routine:Catalog.Products.Object:run']);
    const error = panel.posts.find((message) => message.type === 'mergeError');
    assert.ok(error);
    assert.match(error.message, /busy|выполняется/i);
  });

  test('recovers busy state after rejected preview creation and accepts a retry', async () => {
    const panel = makePanel();
    const workspace = makeWorkspace({ rejectPreviewOnce: true });
    const request = {
      type: 'createPreview' as const,
      nodeIds: ['bsl:routine:Catalog.Products.Object:run'],
    };

    bindConfigurationCompareWebview(panel as any, workspace, 'Compare');

    await panel.send(request);

    const errorIndex = panel.posts.findIndex((message) => message.type === 'mergeError');
    assert.ok(errorIndex >= 0);
    const recoveredState = panel.posts[errorIndex + 1];
    assert.ok(recoveredState?.type === 'state');
    assert.strictEqual(recoveredState.busy, false);

    await panel.send(request);

    assert.deepStrictEqual(workspace.calls, [
      'createPreview:bsl:routine:Catalog.Products.Object:run',
      'createPreview:bsl:routine:Catalog.Products.Object:run',
    ]);
    assert.strictEqual(
      panel.posts.filter((message) => message.type === 'previewReady').length,
      1
    );
    const finalState = panel.posts[panel.posts.length - 1];
    assert.ok(finalState?.type === 'state');
    assert.strictEqual(finalState.busy, false);
  });

  test('rejects refresh and strategy changes while preview creation is pending', async () => {
    const panel = makePanel();
    const baseWorkspace = makeWorkspace({ deferPreview: true });
    const workspace = Object.assign(baseWorkspace, {
      setStrategy: async () => {
        baseWorkspace.calls.push('strategy');
        return { ok: true as const, payload: baseWorkspace.payload, diagnostics: [] as [] };
      },
    });
    workspace.refresh = async () => {
      baseWorkspace.calls.push('refresh');
      return { ok: true, payload: baseWorkspace.payload, locked: false, diagnostics: [] };
    };

    bindConfigurationCompareWebview(panel as any, workspace, 'Compare');
    const previewRequest = panel.send({
      type: 'createPreview',
      nodeIds: ['bsl:routine:Catalog.Products.Object:run'],
    });
    await panel.waitForPost((message) => message.type === 'state' && message.busy);

    await panel.send({ type: 'refresh' });
    await panel.send({ type: 'setStrategy', strategy: 'full' });

    assert.deepStrictEqual(
      workspace.calls.filter((call) => call === 'refresh' || call === 'strategy'),
      []
    );
    workspace.releasePreview();
    await previewRequest;
  });

  test('rejects refresh and strategy changes while merge execution is pending', async () => {
    const panel = makePanel();
    const baseWorkspace = makeWorkspace();
    const workspace = Object.assign(baseWorkspace, {
      setStrategy: async () => {
        baseWorkspace.calls.push('strategy');
        return { ok: true as const, payload: baseWorkspace.payload, diagnostics: [] as [] };
      },
    });
    workspace.refresh = async () => {
      baseWorkspace.calls.push('refresh');
      return { ok: true, payload: baseWorkspace.payload, locked: false, diagnostics: [] };
    };
    const execute = workspace.executeApprovedPreview;
    let releaseExecution!: () => void;
    let markExecutionStarted!: () => void;
    const executionStarted = new Promise<void>((resolve) => {
      markExecutionStarted = resolve;
    });
    const executionGate = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    workspace.executeApprovedPreview = async (previewId) => {
      markExecutionStarted();
      await executionGate;
      return execute(previewId);
    };

    bindConfigurationCompareWebview(panel as any, workspace, 'Compare');
    await panel.send({
      type: 'createPreview',
      nodeIds: ['bsl:routine:Catalog.Products.Object:run'],
    });
    await panel.send({ type: 'approvePreview', previewId: 'preview-1' });
    const executionRequest = panel.send({ type: 'executeMerge', previewId: 'preview-1' });
    await executionStarted;

    await panel.send({ type: 'refresh' });
    await panel.send({ type: 'setStrategy', strategy: 'full' });

    assert.deepStrictEqual(
      workspace.calls.filter((call) => call === 'refresh' || call === 'strategy'),
      []
    );
    releaseExecution();
    await executionRequest;
  });

  test('preserves surviving canonical selection on refresh and keeps all candidates in ready payload', async () => {
    const panel = makePanel();
    const workspace = makeWorkspace();
    const firstId = 'bsl:routine:Catalog.Products.Object:first';
    const survivingId = 'bsl:routine:Catalog.Products.Object:survives';
    const addedId = 'bsl:routine:Catalog.Products.Object:added';
    let mergeableIds = [firstId, survivingId];
    workspace.listMergeableNodeIds = () => [...mergeableIds];
    workspace.selectNodeIds = (nodeIds: readonly string[]): WorkspaceSelectionState => {
      workspace.calls.push(`select:${nodeIds.join(',')}`);
      return {
        selectedNodeIds: [...nodeIds],
        executableNodeIds: nodeIds.filter((nodeId) => nodeId === survivingId),
        canCreatePreview: nodeIds.includes(survivingId),
        diagnostics: [],
      };
    };
    workspace.refresh = async () => {
      workspace.calls.push('refresh');
      mergeableIds = [survivingId, addedId];
      return { ok: true, payload: workspace.payload, locked: false, diagnostics: [] };
    };

    bindConfigurationCompareWebview(panel as any, workspace, 'Compare');
    await panel.send({ type: 'selectionChanged', nodeIds: [firstId, survivingId] });
    await panel.send({ type: 'refresh' });

    const readyMessage = [...panel.posts].reverse().find(
      (message) => message.type === 'loadState' && message.status === 'ready'
    );
    assert.ok(readyMessage?.type === 'loadState');
    assert.deepStrictEqual(readyMessage.payload?.executableNodeIds, [survivingId, addedId]);
    assert.ok(
      panel.posts.some((message) =>
        message.type === 'state' &&
        message.selectedNodeIds.length === 1 &&
        message.selectedNodeIds[0] === survivingId
      )
    );
    assert.deepStrictEqual(workspace.calls.filter((call) => call.startsWith('select:')), [
      `select:${firstId},${survivingId}`,
      `select:${survivingId}`,
    ]);
  });

  test('keeps throttled partial projection through phase-only refresh progress updates', async () => {
    const panel = makePanel();
    const workspace = makeWorkspace();
    let report!: (progress: CompareBuildProgress) => void;
    let markStarted!: () => void;
    let releaseRefresh!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    workspace.refresh = async (options?: CompareBuildOptions): Promise<WorkspaceRefreshResult> => {
      workspace.calls.push('refresh');
      report = options?.onProgress ?? (() => undefined);
      report({
        phase: 'metadata',
        completed: 1,
        total: 3,
        projection: makePartialProjection('Catalog.Partial'),
      });
      report({ phase: 'inventory', completed: 2, total: 5 });
      markStarted();
      await refreshGate;
      return { ok: true, payload: workspace.payload, locked: false, diagnostics: [] };
    };

    bindConfigurationCompareWebview(panel as any, workspace, 'Compare');
    const refreshRequest = panel.send({ type: 'refresh' });
    await started;
    await panel.waitForPost((message) => message.type === 'loadState' && message.status === 'loading' && message.phase === 'inventory');

    let progress = [...panel.posts].reverse().find((message) =>
      message.type === 'loadState' && message.status === 'loading' && message.phase === 'inventory'
    );
    assert.ok(progress?.type === 'loadState');
    assert.strictEqual(progress.partial, true);
    assert.match(JSON.stringify(progress.payload), /Partial/);

    const firstProgressPostCount = panel.posts.filter((message) => message.type === 'loadState' && message.status === 'loading').length;
    report({ phase: 'bsl', completed: 1, total: 2 });
    await new Promise((resolve) => setTimeout(resolve, 80));

    const loadingPosts = panel.posts.filter((message) => message.type === 'loadState' && message.status === 'loading');
    assert.ok(loadingPosts.length > firstProgressPostCount);
    progress = loadingPosts[loadingPosts.length - 1];
    assert.ok(progress?.type === 'loadState');
    assert.strictEqual(progress.phase, 'bsl');
    assert.strictEqual(progress.partial, true);
    assert.match(JSON.stringify(progress.payload), /Partial/);

    releaseRefresh();
    await refreshRequest;
  });

  test('superseding refreshes discard the old timer and publish only the new generation projection', async () => {
    const panel = makePanel();
    const workspace = makeWorkspace();
    const reports: Array<(progress: CompareBuildProgress) => void> = [];
    const releases: Array<() => void> = [];
    const startResolvers: Array<() => void> = [];
    workspace.refresh = async (options?: CompareBuildOptions): Promise<WorkspaceRefreshResult> => {
      reports.push(options?.onProgress ?? (() => undefined));
      startResolvers.shift()?.();
      await new Promise<void>((resolve) => { releases.push(resolve); });
      return { ok: true, payload: workspace.payload, locked: false, diagnostics: [] };
    };
    const firstStarted = new Promise<void>((resolve) => { startResolvers.push(resolve); });
    const secondStarted = new Promise<void>((resolve) => { startResolvers.push(resolve); });

    bindConfigurationCompareWebview(panel as any, workspace, 'Compare');
    const firstRefresh = panel.send({ type: 'refresh' });
    await firstStarted;
    reports[0]!({
      phase: 'metadata',
      completed: 1,
      total: 2,
      projection: makePartialProjection('Catalog.OldGeneration'),
    });

    const secondRefresh = panel.send({ type: 'refresh' });
    await secondStarted;
    reports[1]!({
      phase: 'inventory',
      completed: 2,
      total: 4,
      projection: makePartialProjection('Catalog.NewGeneration'),
    });
    await new Promise((resolve) => setTimeout(resolve, 80));

    const progressPosts = panel.posts.filter((message) => message.type === 'loadState' && message.status === 'loading');
    const latest = progressPosts[progressPosts.length - 1];
    assert.ok(latest?.type === 'loadState');
    assert.strictEqual(latest.phase, 'inventory');
    assert.strictEqual(latest.partial, true);
    assert.match(JSON.stringify(latest.payload), /NewGeneration/);
    assert.doesNotMatch(JSON.stringify(latest.payload), /OldGeneration/);

    releases.splice(0).forEach((release) => release());
    await Promise.all([firstRefresh, secondRefresh]);
  });

  test('ignores invalid and forged messages without executing workspace actions', async () => {
    const panel = makePanel();
    const workspace = makeWorkspace();

    bindConfigurationCompareWebview(panel as any, workspace, 'Compare');

    await panel.send({ type: 'executeMerge', previewId: 'preview-1', targetUri: 'file:///forged.bsl' });
    await panel.send({ type: 'executeMerge', previewId: 42 });
    await panel.send({ type: 'unknown', nodeIds: ['bsl:routine:Catalog.Products.Object:run'] });

    assert.deepStrictEqual(workspace.calls, []);
    assert.deepStrictEqual(panel.posts, []);
  });

  test('redacts POSIX absolute paths from rendered payload', () => {
    const payload = makePayload();
    payload.root.children[1].leftValue = '/home/max/config/Catalogs/Products.xml';
    payload.root.children[1].rightValue = '/tmp/right/Catalogs/Products.xml';

    const html = renderConfigCompareWebviewHtml({
      webview: { cspSource: 'vscode-resource:' },
      payload,
      executableNodeIds: ['bsl:routine:Catalog.Products.Object:run'],
      title: 'Compare',
      nonce: 'nonce-test',
      htmlPath: path.join(process.cwd(), 'src', 'compareMerge', 'configCompareWebview.html'),
    });

    assert.doesNotMatch(html, /\/home\/max\/config/);
    assert.doesNotMatch(html, /\/tmp\/right/);
  });

  test('posts backup paths on failed execution after backup creation', async () => {
    const panel = makePanel();
    const workspace = makeWorkspace({ failExecutionWithBackup: true });

    bindConfigurationCompareWebview(panel as any, workspace, 'Compare');

    await panel.send({
      type: 'createPreview',
      nodeIds: ['bsl:routine:Catalog.Products.Object:run'],
    });
    await panel.send({ type: 'approvePreview', previewId: 'preview-1' });
    await panel.send({ type: 'executeMerge', previewId: 'preview-1' });

    const error = panel.posts.find((message) => message.type === 'mergeError');
    assert.ok(error);
    assert.deepStrictEqual(error.backupPaths, [
      'C:\\extension\\storage\\merge-backups\\preview-1\\4b42f7ce-8a2a-4a7d-87cc-9f934dd44d8e.bak',
    ]);
    assert.deepStrictEqual(error.mutationFailure, {
      status: 'recoveryRequired',
      code: 'RECOVERY_REQUIRED',
      effectPossible: true,
      message: 'Операция требует проверки после частичного эффекта.',
    });
  });

  test('disposes workspace with panel', () => {
    const panel = makePanel();
    const workspace = makeWorkspace();

    bindConfigurationCompareWebview(panel as any, workspace, 'Compare');
    panel.dispose();

    assert.deepStrictEqual(workspace.calls, ['dispose']);
  });
});

function makePanel() {
  let messageHandler: ((message: unknown) => unknown) | undefined;
  let disposeHandler: (() => void) | undefined;
  let postWaiters: Array<{
    predicate: (message: ConfigCompareHostToWebviewMessage) => boolean;
    resolve: () => void;
  }> = [];
  const panel = {
    posts: [] as ConfigCompareHostToWebviewMessage[],
    webview: {
      cspSource: 'vscode-resource:',
      html: '',
      postMessage: async (message: ConfigCompareHostToWebviewMessage) => {
        (message as any).__payloadText = JSON.stringify((message as any).payload ?? {});
        delete (message as any).__payloadText;
        (panel.posts as ConfigCompareHostToWebviewMessage[]).push(message);
        const ready = postWaiters.filter((waiter) => waiter.predicate(message));
        postWaiters = postWaiters.filter((waiter) => !waiter.predicate(message));
        ready.forEach((waiter) => waiter.resolve());
        return true;
      },
      onDidReceiveMessage: (handler: (message: unknown) => unknown) => {
        messageHandler = handler;
        return { dispose: () => undefined };
      },
    },
    onDidDispose: (handler: () => void) => {
      disposeHandler = handler;
      return { dispose: () => undefined };
    },
    send: async (message: unknown) => {
      await messageHandler?.(message);
    },
    waitForPost: async (predicate: (message: ConfigCompareHostToWebviewMessage) => boolean) => {
      if (panel.posts.some(predicate)) {
        return;
      }
      await new Promise<void>((resolve) => {
        postWaiters.push({ predicate, resolve });
      });
    },
    dispose: () => {
      disposeHandler?.();
    },
  };
  return panel;
}

function makeWorkspace(options: {
  failExecutionWithBackup?: boolean;
  destructivePreview?: boolean;
  deferPreview?: boolean;
  rejectPreviewOnce?: boolean;
} = {}) {
  const calls: string[] = [];
  const preview = makePreview();
  let releasePreview: (() => void) | undefined;
  let previewAttempts = 0;
  return {
    calls,
    payload: makePayload(options.destructivePreview),
    listMergeableNodeIds: () => ['bsl:routine:Catalog.Products.Object:run'],
    selectNodeIds: (nodeIds: readonly string[]): WorkspaceSelectionState => {
      calls.push(`select:${nodeIds.join(',')}`);
      return {
        selectedNodeIds: [...nodeIds],
        executableNodeIds: nodeIds.filter((nodeId) => nodeId.endsWith(':run')),
        canCreatePreview: nodeIds.length === 1 && nodeIds[0].endsWith(':run'),
        diagnostics: [],
      };
    },
    createPreviewForNodeIds: async (nodeIds: readonly string[]): Promise<WorkspacePreviewResult> => {
      calls.push(`createPreview:${nodeIds.join(',')}`);
      previewAttempts += 1;
      if (options.rejectPreviewOnce && previewAttempts === 1) {
        throw new Error('preview failed');
      }
      if (options.deferPreview) {
        await new Promise<void>((resolve) => {
          releasePreview = resolve;
        });
      }
      return { ok: true, preview, diagnostics: [] };
    },
    approvePreview: (previewId: string): WorkspaceApprovalResult => {
      calls.push(`approve:${previewId}`);
      return { ok: true, preview, diagnostics: [] };
    },
    executeApprovedPreview: async (previewId: string): Promise<WorkspaceExecutionResult> => {
      calls.push(`execute:${previewId}`);
      if (options.failExecutionWithBackup) {
        return {
          ok: false,
          locked: false,
          diagnostics: [],
          result: {
            previewId,
            approvedPreviewId: previewId,
            applied: [],
            skipped: [],
            failed: [
              {
                operationId: 'operation-0',
                kind: 'bslLogicalRoutineMerge' as const,
                backupPath:
                  'C:\\extension\\storage\\merge-backups\\preview-1\\4b42f7ce-8a2a-4a7d-87cc-9f934dd44d8e.bak',
              },
            ],
            backupPaths: [
              'C:\\extension\\storage\\merge-backups\\preview-1\\4b42f7ce-8a2a-4a7d-87cc-9f934dd44d8e.bak',
            ],
            diagnostics: [],
            mutationFailure: {
              status: 'recoveryRequired',
              code: 'RECOVERY_REQUIRED',
              effectPossible: true,
              message: 'Операция требует проверки после частичного эффекта.',
            },
          },
        };
      }
      return {
        ok: true,
        result: {
          previewId,
          approvedPreviewId: previewId,
          applied: [
            {
              operationId: 'operation-0',
              kind: 'bslLogicalRoutineMerge' as const,
              targetUri: 'file:///hidden.bsl',
            },
          ],
          skipped: [],
          failed: [],
          backupPaths: ['C:\\extension\\storage\\merge-backups\\preview-1\\4b42f7ce-8a2a-4a7d-87cc-9f934dd44d8e.bak'],
          diagnostics: [],
        },
        payload: makePayload(options.destructivePreview),
        locked: false,
        diagnostics: [],
      };
    },
    refresh: async (): Promise<WorkspaceRefreshResult> => ({
      ok: true,
      payload: makePayload(),
      locked: false,
      diagnostics: [],
    }),
    dispose: () => {
      calls.push('dispose');
    },
    releasePreview: () => releasePreview?.(),
  };
}

function makePayload(destructiveRoutine = false): ConfigCompareWebviewPayload {
  return {
    root: makeTree(destructiveRoutine),
    stats: { total: 3, different: 2, mergeable: 1 },
    sourceRoots: {
      left: 'C:/left',
      right: 'C:/right',
    },
    locked: false,
  };
}

function makeTree(destructiveRoutine = false): CompareTreeNode {
  return {
    id: 'configCompare',
    label: 'Configuration compare',
    kind: 'configCompare',
    status: 'changed',
    children: [
      {
        id: 'bsl:routine:Catalog.Products.Object:run',
        label: 'Run',
        kind: 'bslRoutine',
        status: 'changed',
        mergeable: true,
        destructive: destructiveRoutine,
        mergeState: { state: 'ready', targetFilePath: 'C:/left/ObjectModule.bsl' },
        leftValue: 'sha256:left',
        rightValue: 'sha256:right',
        children: [],
      },
      {
        id: 'metadata:match:Catalog.Products',
        label: 'Catalog.Products',
        kind: 'metadataMatch',
        status: 'changed',
        mergeable: false,
        mergeState: { state: 'readOnly', reason: 'Manual merge required.' },
        leftValue: 'C:/left/Catalogs/Products.xml',
        rightValue: 'C:/right/Catalogs/Products.xml',
        children: [],
      },
    ],
  };
}

function makePartialProjection(qualifiedName: string): CompareTreeProjection {
  const owner: CompareTreeNode = {
    id: `metadata:${qualifiedName}`,
    label: qualifiedName,
    kind: 'metadataObject',
    status: 'changed',
    mergeable: false,
    presentation: {
      ownerKey: `Catalog:name:${qualifiedName}`,
      ownerAliases: [`Catalog:name:${qualifiedName}`],
      metadataType: 'Catalog',
      qualifiedName,
      identities: [{ side: 'left', qualifiedName }],
    },
    children: [],
  };
  return {
    root: {
      id: 'configCompare',
      label: 'Compare',
      kind: 'configCompare',
      status: 'changed',
      children: [{
        id: 'metadata',
        label: 'Metadata',
        kind: 'metadataGroup',
        status: 'changed',
        children: [owner],
      }],
    },
    stats: { total: 1, different: 1, mergeable: 0 },
  };
}

function makePreview() {
  return {
    previewId: 'preview-1',
    summary: '1 routine can be merged.',
    operationCount: 1,
    destructiveCount: 0,
    items: [
      {
        nodeId: 'bsl:routine:Catalog.Products.Object:run',
        label: 'Run',
        kind: 'bslRoutine',
        status: 'changed' as const,
      },
    ],
    diagnostics: [] as CompareMessage[],
  };
}
