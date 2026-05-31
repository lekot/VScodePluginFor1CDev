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

suite('ConfigCompareProvider bulk controls', () => {
  test('renders strategy/filter/search/bulk controls with nonce and side-by-side values', () => {
    const html = renderConfigCompareWebviewHtml({
      webview: { cspSource: 'vscode-resource:' },
      payload: makePayload(),
      executableNodeIds: ['xml:name', 'file:template'],
      title: 'Compare',
      nonce: 'nonce-test',
      htmlPath: path.join(process.cwd(), 'src', 'compareMerge', 'configCompareWebview.html'),
    });

    assert.match(html, /Content-Security-Policy[^>]+nonce-nonce-test/);
    assert.match(html, /data-strategy="left"/);
    assert.match(html, /data-strategy="right"/);
    assert.match(html, /data-strategy="full"/);
    assert.match(html, /id="onlyDifferences"/);
    assert.match(html, /id="searchInput"/);
    assert.match(html, /id="selectVisibleButton"/);
    assert.match(html, /id="clearSelectionButton"/);
    assert.match(html, /leftValue|rightValue/);
    assert.match(html, /"destructive":true/);
  });

  test('accepts strategy message and sends bulk create preview for selected visible nodes', async () => {
    const panel = makePanel();
    const workspace = makeWorkspace();

    bindConfigurationCompareWebview(panel as any, workspace, 'Compare');

    await panel.send({ type: 'setStrategy', strategy: 'full' });
    await panel.send({ type: 'selectionChanged', nodeIds: ['xml:name', 'file:template'] });
    await panel.send({ type: 'createPreview', nodeIds: ['xml:name', 'file:template'] });

    assert.deepStrictEqual(workspace.calls, [
      'setStrategy:full',
      'select:xml:name,file:template',
      'createPreview:xml:name,file:template',
    ]);
    const state = [...panel.posts]
      .reverse()
      .find((message): message is Extract<ConfigCompareHostToWebviewMessage, { type: 'state' }> =>
        message.type === 'state'
      );
    assert.strictEqual(state?.payload.strategy, 'full');
    assert.strictEqual(state?.canCreatePreview, true);
  });

  test('strategy change resets selection preview and posts bulk-ready refreshed state', async () => {
    const panel = makePanel();
    const workspace = makeWorkspace();

    bindConfigurationCompareWebview(panel as any, workspace, 'Compare');

    await panel.send({ type: 'selectionChanged', nodeIds: ['xml:name', 'file:template'] });
    await panel.send({ type: 'createPreview', nodeIds: ['xml:name', 'file:template'] });
    await panel.send({ type: 'setStrategy', strategy: 'full' });

    assert.deepStrictEqual(workspace.calls, [
      'select:xml:name,file:template',
      'createPreview:xml:name,file:template',
      'setStrategy:full',
    ]);
    const state = [...panel.posts]
      .reverse()
      .find((message): message is Extract<ConfigCompareHostToWebviewMessage, { type: 'state' }> =>
        message.type === 'state'
      );
    assert.ok(state);
    assert.strictEqual(state.payload.strategy, 'full');
    assert.deepStrictEqual(state.payload.executableNodeIds, ['xml:name', 'file:template', 'xml:full-only']);
    assert.deepStrictEqual(state.selectedNodeIds, []);
    assert.deepStrictEqual(state.executableNodeIds, []);
    assert.strictEqual(state.canCreatePreview, false);
    assert.strictEqual(state.preview, undefined);
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
        panel.posts.push(message);
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

function makeWorkspace() {
  const calls: string[] = [];
  let strategy: 'left' | 'right' | 'full' = 'right';
  const preview = makePreview();
  return {
    calls,
    get payload(): ConfigCompareWebviewPayload {
      return makePayload(strategy);
    },
    setStrategy: (next: 'left' | 'right' | 'full') => {
      calls.push(`setStrategy:${next}`);
      strategy = next;
      return {
        ok: true as const,
        payload: makePayload(strategy),
        diagnostics: [] as [],
      };
    },
    listMergeableNodeIds: () =>
      strategy === 'full' ? ['xml:name', 'file:template', 'xml:full-only'] : ['xml:name', 'file:template'],
    selectNodeIds: (nodeIds: readonly string[]): WorkspaceSelectionState => {
      calls.push(`select:${nodeIds.join(',')}`);
      return {
        selectedNodeIds: [...nodeIds],
        executableNodeIds: [...nodeIds],
        canCreatePreview: nodeIds.length > 0,
        diagnostics: [],
      };
    },
    createPreviewForNodeIds: async (nodeIds: readonly string[]): Promise<WorkspacePreviewResult> => {
      calls.push(`createPreview:${nodeIds.join(',')}`);
      return { ok: true, preview, diagnostics: [] };
    },
    approvePreview: (_previewId: string): WorkspaceApprovalResult => ({
      ok: true,
      preview,
      diagnostics: [],
    }),
    executeApprovedPreview: async (previewId: string): Promise<WorkspaceExecutionResult> => ({
      ok: true,
      result: {
        previewId,
        approvedPreviewId: previewId,
        applied: [],
        skipped: [],
        failed: [],
        backupPaths: [],
        diagnostics: [],
      },
      payload: makePayload(strategy),
      locked: false,
      diagnostics: [],
    }),
    refresh: async (): Promise<WorkspaceRefreshResult> => ({
      ok: true,
      payload: makePayload(strategy),
      locked: false,
      diagnostics: [],
    }),
    dispose: () => undefined,
  };
}

function makePayload(strategy: 'left' | 'right' | 'full' = 'right'): ConfigCompareWebviewPayload {
  return {
    root: makeTree(),
    stats: { total: 4, different: 3, mergeable: 2 },
    sourceRoots: {
      left: 'C:/left',
      right: 'C:/right',
    },
    locked: false,
    strategy,
  };
}

function makeTree(): CompareTreeNode {
  return {
    id: 'root',
    label: 'Configuration compare',
    kind: 'configCompare',
    status: 'changed',
    children: [
      {
        id: 'xml:name',
        label: 'Name',
        kind: 'metadataXml',
        status: 'changed',
        mergeable: true,
        leftValue: 'Old',
        rightValue: 'New',
        mergeState: { state: 'ready' },
        children: [],
      },
      {
        id: 'file:template',
        label: 'Print.mxl',
        kind: 'binaryFile',
        status: 'rightOnly',
        mergeable: true,
        destructive: true,
        leftValue: '',
        rightValue: 'Print.mxl',
        mergeState: { state: 'ready' },
        children: [],
      },
      {
        id: 'same:name',
        label: 'Blocked',
        kind: 'metadataMatch',
        status: 'changed',
        mergeable: false,
        leftValue: 'uuid-left',
        rightValue: 'uuid-right',
        mergeState: { state: 'identityConflict', reason: 'UUID conflict.' },
        children: [],
      },
    ],
  };
}

function makePreview() {
  return {
    previewId: 'preview-1',
    summary: '2 operations can be merged.',
    operationCount: 2,
    items: [
      {
        nodeId: 'xml:name',
        label: 'Name',
        kind: 'metadataXml',
        status: 'changed' as const,
      },
      {
        nodeId: 'file:template',
        label: 'Print.mxl',
        kind: 'binaryFile',
        status: 'rightOnly' as const,
      },
    ],
    diagnostics: [] as CompareMessage[],
  };
}
