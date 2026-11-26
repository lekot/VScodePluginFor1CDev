import * as vscode from 'vscode';

import { Logger } from '../utils/logger';
import type { CompareBuildProgress } from './compareProgress';
import type { CompareTreeProjection } from './projection/compareTreeProjection';
import {
  bindConfigurationCompareWebview,
  createEmptyComparePayload,
  parseWebviewMessage,
  renderConfigCompareWebviewHtml,
  safeErrorMessage,
  toWebviewPayload,
  type ConfigCompareLoadStateMessage,
  type ConfigCompareWorkspaceLike,
} from './configCompareProvider';

export interface ConfigCompareBuildGeneration {
  readonly id: number;
  readonly token: vscode.CancellationToken;
  report(progress: CompareBuildProgress): void;
  complete(workspace: ConfigCompareWorkspaceLike): void;
  fail(error: unknown): void;
  isCurrent(): boolean;
}

export interface ConfigCompareLoadingSession {
  readonly panel: vscode.WebviewPanel;
  beginGeneration(options?: { retainCurrentView?: boolean }): ConfigCompareBuildGeneration;
  setRetryHandler(handler: () => void): void;
  dispose(): void;
}

export function showConfigurationCompareLoading(
  context: vscode.ExtensionContext,
  title: string,
  labels: { target: string; source: string }
): ConfigCompareLoadingSession {
  const panel = vscode.window.createWebviewPanel(
    '1c-config-compare',
    title,
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      localResourceRoots: [context.extensionUri],
    }
  );
  const emptyPayload = createEmptyComparePayload(labels.target, labels.source);
  const initialPayload = toWebviewPayload(emptyPayload, [], title, true);
  let activePayload = initialPayload;
  let currentWorkspace: ConfigCompareWorkspaceLike | undefined;
  let currentSource: vscode.CancellationTokenSource | undefined;
  let queuedProgress: CompareBuildProgress | undefined;
  let activeProjection: CompareTreeProjection | undefined;
  let progressTimer: ReturnType<typeof setTimeout> | undefined;
  let retryHandler: (() => void) | undefined;
  let currentGeneration = 0;
  let ready = false;
  let disposed = false;
  let transferredWorkspace = false;
  let messageSubscription: vscode.Disposable | undefined;
  let disposeSubscription: vscode.Disposable | undefined;
  let loadState: Omit<ConfigCompareLoadStateMessage, 'type'> = {
    generation: 0,
    status: 'loading',
    phase: 'detecting',
    partial: true,
    payload: activePayload,
  };

  panel.webview.html = renderConfigCompareWebviewHtml({
    webview: panel.webview,
    payload: emptyPayload,
    executableNodeIds: [],
    title,
    initialLoadState: loadState,
  });

  const clearProgressTimer = (): void => {
    if (progressTimer !== undefined) {
      clearTimeout(progressTimer);
      progressTimer = undefined;
    }
  };

  const publishLoadState = async (): Promise<void> => {
    if (!ready || disposed) {
      return;
    }
    try {
      await panel.webview.postMessage({ type: 'loadState', ...loadState });
    } catch (error) {
      Logger.warn('Configuration compare webview stopped accepting progress messages', error);
      panel.dispose();
      cleanup();
    }
  };

  const switchToWorkspace = (workspace: ConfigCompareWorkspaceLike): void => {
    if (disposed || !ready || loadState.status !== 'ready' || currentWorkspace !== workspace) {
      return;
    }
    messageSubscription?.dispose();
    messageSubscription = undefined;
    currentWorkspace = undefined;
    transferredWorkspace = true;
    bindConfigurationCompareWebview(panel, workspace, title, {
      renderHtml: false,
      alreadyReady: true,
      generation: loadState.generation,
    });
  };

  const cleanup = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    currentSource?.cancel();
    currentSource?.dispose();
    currentSource = undefined;
    clearProgressTimer();
    queuedProgress = undefined;
    activeProjection = undefined;
    messageSubscription?.dispose();
    messageSubscription = undefined;
    disposeSubscription?.dispose();
    disposeSubscription = undefined;
    if (!transferredWorkspace) {
      currentWorkspace?.dispose();
    }
    currentWorkspace = undefined;
  };

  const publishQueuedProgress = (generationId: number, source: vscode.CancellationTokenSource): void => {
    progressTimer = undefined;
    const progress = queuedProgress;
    queuedProgress = undefined;
    if (
      !progress ||
      disposed ||
      generationId !== currentGeneration ||
      source.token.isCancellationRequested
    ) {
      return;
    }
    if (progress.projection) {
      activePayload = toWebviewPayload(
        {
          ...emptyPayload,
          root: progress.projection.root,
          stats: progress.projection.stats,
          locked: true,
        },
        [],
        title,
        true
      );
    }
    loadState = {
      generation: generationId,
      status: 'loading',
      phase: progress.phase,
      completed: progress.completed,
      total: progress.total,
      partial: true,
      payload: activePayload,
    };
    void publishLoadState();
  };

  const beginGeneration = (
    options: { retainCurrentView?: boolean } = {}
  ): ConfigCompareBuildGeneration => {
    if (disposed) {
      const cancelled = new vscode.CancellationTokenSource();
      cancelled.cancel();
      const generationId = ++currentGeneration;
      const token = cancelled.token;
      cancelled.dispose();
      return {
        id: generationId,
        token,
        report: () => undefined,
        complete: (workspace) => workspace.dispose(),
        fail: () => undefined,
        isCurrent: () => false,
      };
    }
    currentSource?.cancel();
    currentSource?.dispose();
    clearProgressTimer();
    queuedProgress = undefined;
    activeProjection = undefined;
    const generationId = ++currentGeneration;
    const source = new vscode.CancellationTokenSource();
    currentSource = source;
    if (!options.retainCurrentView || !currentWorkspace) {
      activePayload = initialPayload;
    }
    loadState = {
      generation: generationId,
      status: 'loading',
      phase: 'detecting',
      partial: true,
      payload: activePayload,
    };
    void publishLoadState();

    let settled = false;
    const isCurrent = (): boolean =>
      !disposed && !settled && generationId === currentGeneration && !source.token.isCancellationRequested;
    return {
      id: generationId,
      token: source.token,
      report: (progress) => {
        if (!isCurrent()) {
          return;
        }
        if (progress.projection) {
          activeProjection = progress.projection;
        }
        queuedProgress = activeProjection && !progress.projection
          ? { ...progress, projection: activeProjection }
          : progress;
        if (progressTimer === undefined) {
          progressTimer = setTimeout(() => publishQueuedProgress(generationId, source), 60);
        }
      },
      complete: (workspace) => {
        if (!isCurrent()) {
          if (workspace !== currentWorkspace) {
            workspace.dispose();
          }
          return;
        }
        settled = true;
        clearProgressTimer();
        queuedProgress = undefined;
        activeProjection = undefined;
        currentSource?.dispose();
        currentSource = undefined;
        if (currentWorkspace && currentWorkspace !== workspace && !transferredWorkspace) {
          currentWorkspace.dispose();
        }
        currentWorkspace = workspace;
        transferredWorkspace = false;
        activePayload = toWebviewPayload(
          workspace.payload,
          workspace.listMergeableNodeIds?.() ?? [],
          title
        );
        loadState = {
          generation: generationId,
          status: 'ready',
          payload: activePayload,
        };
        void publishLoadState().then(() => {
          if (disposed || generationId !== currentGeneration) {
            if (workspace !== currentWorkspace) {
              workspace.dispose();
            }
            return;
          }
          switchToWorkspace(workspace);
        });
      },
      fail: (error) => {
        if (!isCurrent()) {
          return;
        }
        settled = true;
        clearProgressTimer();
        queuedProgress = undefined;
        activeProjection = undefined;
        currentSource?.dispose();
        currentSource = undefined;
        loadState = {
          generation: generationId,
          status: 'error',
          payload: activePayload,
          error: safeErrorMessage(error),
          retryAvailable: Boolean(retryHandler),
        };
        void publishLoadState();
      },
      isCurrent,
    };
  };

  messageSubscription = panel.webview.onDidReceiveMessage(async (rawMessage: unknown) => {
    const message = parseWebviewMessage(rawMessage);
    if (!message) {
      Logger.warn('Ignored invalid configuration compare webview message', rawMessage);
      return;
    }
    if (message.type === 'ready') {
      ready = true;
      await publishLoadState();
      if (currentWorkspace && loadState.status === 'ready') {
        switchToWorkspace(currentWorkspace);
      }
      return;
    }
    if (message.type === 'cancel') {
      currentSource?.cancel();
      currentSource?.dispose();
      currentSource = undefined;
      clearProgressTimer();
      queuedProgress = undefined;
      activeProjection = undefined;
      loadState = {
        generation: currentGeneration,
        status: 'cancelled',
        payload: activePayload,
        retryAvailable: Boolean(retryHandler),
      };
      await publishLoadState();
      return;
    }
    if (message.type === 'retry') {
      if (loadState.status === 'error' || loadState.status === 'cancelled') {
        retryHandler?.();
      }
      return;
    }
    if (message.type === 'close') {
      panel.dispose();
    }
  });
  disposeSubscription = panel.onDidDispose(cleanup);

  return {
    panel,
    beginGeneration,
    setRetryHandler: (handler) => {
      retryHandler = handler;
      if (loadState.status === 'error' || loadState.status === 'cancelled') {
        loadState.retryAvailable = true;
        void publishLoadState();
      }
    },
    dispose: cleanup,
  };
}
