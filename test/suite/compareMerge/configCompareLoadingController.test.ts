import * as assert from 'assert';
import * as vscode from 'vscode';

import { showConfigurationCompareLoading } from '../../../src/compareMerge/configCompareLoadingController';
import type { CompareTreeNode } from '../../../src/compareMerge/compareTreeTypes';
import type { ConfigCompareHostToWebviewMessage } from '../../../src/compareMerge/configCompareMessages';
import type { CompareTreeProjection } from '../../../src/compareMerge/projection/compareTreeProjection';
import type { ConfigCompareWorkspaceLike } from '../../../src/compareMerge/configCompareProvider';

suite('ConfigCompareLoadingController', () => {
  test('buffers the latest progress until ready and adopts the existing panel on completion', async () => {
    const panel = makePanel();
    const restore = patchCreateWebviewPanel(panel.panel);
    const session = showConfigurationCompareLoading(makeContext(), 'Compare', {
      target: 'Target',
      source: 'Source',
    });
    const htmlAtStart = panel.panel.webview.html;

    try {
      assert.match(htmlAtStart, /__configCompareLoadState/);
      const generation = session.beginGeneration();
      generation.report({ phase: 'metadata', completed: 2, total: 3 });
      generation.report({ phase: 'inventory', completed: 7, total: 10 });
      await delay(80);
      assert.strictEqual(panel.posts.length, 0, 'progress must wait for the webview ready handshake');

      await panel.send({ type: 'ready' });
      assert.strictEqual(panel.posts.length, 1);
      const progressMessage = panel.posts[0] as Extract<ConfigCompareHostToWebviewMessage, { type: 'loadState' }> | undefined;
      assert.ok(progressMessage);
      assert.strictEqual(progressMessage.phase, 'inventory');
      assert.strictEqual(progressMessage.completed, 7);
      assert.strictEqual(progressMessage.total, 10);

      const workspace = makeWorkspace();
      generation.complete(workspace);
      await waitFor(() => panel.posts.some((message) => message.type === 'state'));
      assert.strictEqual(panel.panel.webview.html, htmlAtStart, 'completion must preserve the ready panel');
      assert.ok(panel.posts.some((message) => message.type === 'loadState' && message.status === 'ready'));
      assert.ok(panel.posts.some((message) => message.type === 'state'));
      assert.strictEqual(workspace.disposed, false);
    } finally {
      panel.panel.dispose();
      restore();
    }
  });

  test('keeps the latest partial projection across phase-only updates and clears it on retry', async () => {
    const panel = makePanel();
    const restore = patchCreateWebviewPanel(panel.panel);
    const session = showConfigurationCompareLoading(makeContext(), 'Compare', {
      target: 'Target',
      source: 'Source',
    });
    const generation = session.beginGeneration();
    let retryGeneration: ReturnType<typeof session.beginGeneration> | undefined;
    session.setRetryHandler(() => { retryGeneration = session.beginGeneration(); });

    try {
      await panel.send({ type: 'ready' });
      generation.report({
        phase: 'metadata',
        completed: 1,
        total: 3,
        projection: makePartialProjection('Catalog.Partial'),
      });
      generation.report({ phase: 'inventory', completed: 2, total: 5 });
      await delay(80);

      let progress = latestLoadState(panel.posts);
      assert.strictEqual(progress.phase, 'inventory');
      assert.strictEqual(progress.partial, true);
      assert.match(JSON.stringify(progress.payload), /Partial/);

      generation.report({ phase: 'bsl', completed: 1, total: 2 });
      await delay(80);
      progress = latestLoadState(panel.posts);
      assert.strictEqual(progress.phase, 'bsl');
      assert.strictEqual(progress.partial, true);
      assert.match(JSON.stringify(progress.payload), /Partial/);

      await panel.send({ type: 'cancel' });
      await panel.send({ type: 'retry' });
      assert.ok(retryGeneration);
      assert.notStrictEqual(retryGeneration.id, generation.id);
      retryGeneration.report({ phase: 'inventory', completed: 1, total: 4 });
      await delay(80);

      progress = latestLoadState(panel.posts);
      assert.strictEqual(progress.generation, retryGeneration.id);
      assert.strictEqual(progress.phase, 'inventory');
      assert.strictEqual(progress.partial, true);
      assert.doesNotMatch(JSON.stringify(progress.payload), /Partial/);
    } finally {
      panel.panel.dispose();
      restore();
    }
  });

  test('cancellation exposes retry and disposes a late completed workspace', async () => {
    const panel = makePanel();
    const restore = patchCreateWebviewPanel(panel.panel);
    const session = showConfigurationCompareLoading(makeContext(), 'Compare', {
      target: 'Target',
      source: 'Source',
    });
    let retries = 0;
    session.setRetryHandler(() => { retries += 1; });
    const generation = session.beginGeneration();

    try {
      await panel.send({ type: 'ready' });
      await panel.send({ type: 'cancel' });
      assert.strictEqual(generation.token.isCancellationRequested, true);
      assert.ok(panel.posts.some((message) => message.type === 'loadState' && message.status === 'cancelled' && message.retryAvailable));

      await panel.send({ type: 'retry' });
      assert.strictEqual(retries, 1);
      const lateWorkspace = makeWorkspace();
      generation.complete(lateWorkspace);
      assert.strictEqual(lateWorkspace.disposed, true);
      assert.ok(!panel.posts.some((message) => message.type === 'loadState' && message.status === 'ready'));
    } finally {
      panel.panel.dispose();
      restore();
    }
  });

  test('closing the loading panel cancels the generation and ignores late success', () => {
    const panel = makePanel();
    const restore = patchCreateWebviewPanel(panel.panel);
    const session = showConfigurationCompareLoading(makeContext(), 'Compare', {
      target: 'Target',
      source: 'Source',
    });
    const generation = session.beginGeneration();
    const workspace = makeWorkspace();

    try {
      panel.panel.dispose();
      generation.complete(workspace);

      assert.strictEqual(generation.token.isCancellationRequested, true);
      assert.strictEqual(workspace.disposed, true);
      assert.strictEqual(generation.isCurrent(), false);
    } finally {
      restore();
    }
  });
});

function makeContext(): vscode.ExtensionContext {
  return { extensionUri: vscode.Uri.file(process.cwd()) } as vscode.ExtensionContext;
}

function makeWorkspace(): ConfigCompareWorkspaceLike & { disposed: boolean } {
  const root: CompareTreeNode = {
    id: 'configCompare',
    label: 'Compare',
    kind: 'configCompare',
    status: 'equal',
    children: [],
  };
  const workspace = {
    disposed: false,
    payload: {
      root,
      stats: { total: 1, different: 0, mergeable: 0 },
      sourceRoots: { left: 'C:/target', right: 'C:/source' },
      locked: false,
    },
    listMergeableNodeIds: () => [],
    selectNodeIds: () => ({ selectedNodeIds: [], executableNodeIds: [], canCreatePreview: false, diagnostics: [] }),
    createPreviewForNodeIds: async () => ({ ok: false as const, diagnostics: [] }),
    approvePreview: () => ({ ok: false as const, diagnostics: [] }),
    executeApprovedPreview: async () => ({ ok: false as const, locked: true, diagnostics: [] }),
    refresh: async () => ({ ok: true as const, payload: workspace.payload, locked: false, diagnostics: [] }),
    dispose: () => { workspace.disposed = true; },
  };
  return workspace as unknown as ConfigCompareWorkspaceLike & { disposed: boolean };
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

function latestLoadState(posts: readonly ConfigCompareHostToWebviewMessage[]): Extract<ConfigCompareHostToWebviewMessage, { type: 'loadState' }> {
  const state = [...posts].reverse().find((message): message is Extract<ConfigCompareHostToWebviewMessage, { type: 'loadState' }> =>
    message.type === 'loadState' && message.status === 'loading'
  );
  assert.ok(state, 'a loading progress state should be posted');
  return state;
}

function makePanel() {
  let receiveMessage: ((message: unknown) => Promise<void>) | undefined;
  const disposeListeners = new Set<() => void>();
  const posts: ConfigCompareHostToWebviewMessage[] = [];
  let disposed = false;
  const panel = {
    webview: {
      cspSource: 'vscode-resource:',
      html: '',
      postMessage: async (message: ConfigCompareHostToWebviewMessage) => {
        posts.push(message);
        return true;
      },
      onDidReceiveMessage: (listener: (message: unknown) => Promise<void>) => {
        receiveMessage = listener;
        return { dispose: () => { receiveMessage = undefined; } };
      },
    },
    onDidDispose: (listener: () => void) => {
      disposeListeners.add(listener);
      return { dispose: () => { disposeListeners.delete(listener); } };
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const listener of [...disposeListeners]) listener();
      disposeListeners.clear();
    },
  } as unknown as vscode.WebviewPanel;
  return {
    panel,
    posts,
    send: async (message: unknown) => { await receiveMessage?.(message); },
  };
}

function patchCreateWebviewPanel(panel: vscode.WebviewPanel): () => void {
  const window = vscode.window as unknown as { createWebviewPanel: typeof vscode.window.createWebviewPanel };
  const original = window.createWebviewPanel;
  window.createWebviewPanel = (() => panel) as typeof vscode.window.createWebviewPanel;
  return () => { window.createWebviewPanel = original; };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await delay(5);
  }
  assert.ok(predicate(), 'condition did not become true');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
