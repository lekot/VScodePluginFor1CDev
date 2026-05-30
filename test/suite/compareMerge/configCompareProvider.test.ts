import * as assert from 'assert';
import * as path from 'path';

import {
  bindConfigurationCompareWebview,
  renderConfigCompareWebviewHtml,
} from '../../../src/compareMerge/configCompareProvider';
import type { ConfigCompareHostToWebviewMessage } from '../../../src/compareMerge/configCompareMessages';
import type { CompareTreeNode } from '../../../src/compareMerge/compareTreeTypes';
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
  const panel = {
    posts: [] as ConfigCompareHostToWebviewMessage[],
    webview: {
      cspSource: 'vscode-resource:',
      html: '',
      postMessage: async (message: ConfigCompareHostToWebviewMessage) => {
        (message as any).__payloadText = JSON.stringify((message as any).payload ?? {});
        delete (message as any).__payloadText;
        (panel.posts as ConfigCompareHostToWebviewMessage[]).push(message);
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
    dispose: () => {
      disposeHandler?.();
    },
  };
  return panel;
}

function makeWorkspace(options: { failExecutionWithBackup?: boolean } = {}) {
  const calls: string[] = [];
  const preview = makePreview();
  return {
    calls,
    payload: makePayload(),
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
        payload: makePayload(),
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
  };
}

function makePayload(): ConfigCompareWebviewPayload {
  return {
    root: makeTree(),
    stats: { total: 3, different: 2, mergeable: 1 },
    sourceRoots: {
      left: 'C:/left',
      right: 'C:/right',
    },
    locked: false,
  };
}

function makeTree(): CompareTreeNode {
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

function makePreview() {
  return {
    previewId: 'preview-1',
    summary: '1 routine can be merged.',
    operationCount: 1,
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
