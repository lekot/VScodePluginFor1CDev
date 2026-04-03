import * as path from 'path';
import * as vscode from 'vscode';

/** Minimal `ExtensionContext` for `RolesRightsEditorProvider` core tests. */
export function createFakeExtensionContext(): vscode.ExtensionContext {
  const extensionRoot = vscode.Uri.file(path.resolve(__dirname, '..', '..'));
  return {
    subscriptions: [] as vscode.Disposable[],
    extensionPath: extensionRoot.fsPath,
    extensionUri: extensionRoot,
    globalState: {} as vscode.Memento,
    workspaceState: {} as vscode.Memento,
    secrets: {} as vscode.SecretStorage,
    storageUri: undefined,
    storagePath: undefined,
    globalStorageUri: extensionRoot,
    globalStoragePath: extensionRoot.fsPath,
    logUri: extensionRoot,
    logPath: extensionRoot.fsPath,
    extensionMode: vscode.ExtensionMode.Test,
    extension: {} as vscode.Extension<unknown>,
    environmentVariableCollection: {} as vscode.EnvironmentVariableCollection,
    languageModelAccessInformation: {} as vscode.LanguageModelAccessInformation,
    asAbsolutePath: (p: string) => path.resolve(extensionRoot.fsPath, p),
  } as vscode.ExtensionContext;
}

export type WebviewToExtensionMessage = {
  command?: string;
  data?: { requestId?: string; restrictionTemplatesText?: string; [key: string]: unknown };
};

/**
 * Fake `WebviewPanel` with configurable `postMessage` behavior.
 * Records every message sent from the extension to the webview (typically `requestSavePayload`).
 */
export function createFakeWebviewPanel(options?: {
  /**
   * Invoked for each `webview.postMessage` after the message is recorded.
   * Use to auto-reply with `savePayload`, simulate delays, or inject wrong `requestId` first.
   * Not used when `autoReplyFlushWith` is set.
   */
  onPostMessage?: (msg: WebviewToExtensionMessage) => void | Promise<void>;
  /**
   * When set, responds to `requestSavePayload` with `savePayload` using this text (simulates webview).
   * Avoids forward-reference issues when wiring `onPostMessage` before `getOnMessageHandler` exists.
   */
  autoReplyFlushWith?: string | ((requestId: string) => string | Promise<string>);
  /** If set, `dispose()` sets this flag (optional observability). */
  trackDisposed?: { value: boolean };
}): {
  panel: vscode.WebviewPanel;
  getPostedMessages: () => WebviewToExtensionMessage[];
  getOnMessageHandler: () => ((message: unknown) => Promise<void>) | undefined;
} {
  const posted: WebviewToExtensionMessage[] = [];
  let onMessageHandler: ((message: unknown) => Promise<void>) | undefined;

  const defaultAutoReply = async (m: WebviewToExtensionMessage): Promise<void> => {
    if (options?.autoReplyFlushWith === undefined) {
      return;
    }
    if (m.command !== 'requestSavePayload' || !m.data?.requestId) {
      return;
    }
    const h = onMessageHandler;
    if (!h) {
      return;
    }
    const text =
      typeof options.autoReplyFlushWith === 'function'
        ? await options.autoReplyFlushWith(m.data.requestId)
        : options.autoReplyFlushWith;
    await h({
      command: 'savePayload',
      data: {
        requestId: m.data.requestId,
        restrictionTemplatesText: text,
      },
    });
  };

  const panel = {
    reveal: () => undefined,
    onDidDispose: () => ({ dispose: () => undefined }),
    webview: {
      html: '',
      onDidReceiveMessage: (cb: (message: unknown) => Promise<void>) => {
        onMessageHandler = cb;
        return { dispose: () => undefined };
      },
      postMessage: async (msg: unknown) => {
        const m = msg as WebviewToExtensionMessage;
        posted.push(m);
        if (options?.autoReplyFlushWith !== undefined) {
          await defaultAutoReply(m);
        }
        await options?.onPostMessage?.(m);
        return true;
      },
    },
    dispose: () => {
      if (options?.trackDisposed) {
        options.trackDisposed.value = true;
      }
    },
  } as unknown as vscode.WebviewPanel;

  return {
    panel,
    getPostedMessages: () => [...posted],
    getOnMessageHandler: () => onMessageHandler,
  };
}

export function patchCreateWebviewPanel(panel: vscode.WebviewPanel): () => void {
  const w = vscode.window as unknown as { createWebviewPanel: typeof vscode.window.createWebviewPanel };
  const original = w.createWebviewPanel;
  w.createWebviewPanel = (() => panel) as typeof vscode.window.createWebviewPanel;
  return () => {
    w.createWebviewPanel = original;
  };
}
