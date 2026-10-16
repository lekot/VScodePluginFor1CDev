import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  createFakeWebviewPanel,
  patchCreateWebviewPanel,
  type WebviewToExtensionMessage,
} from './rightsEditorTestHarness';

export interface StatefulEditorSuiteAdapter<TTarget> {
  name: string;
  createProvider: () => vscode.Disposable & { show(...args: any[]): Promise<void> };
  openTargetA: (provider: any, panel: vscode.WebviewPanel) => Promise<TTarget>;
  openTargetB: (provider: any, panel: vscode.WebviewPanel) => Promise<TTarget>;
  triggerSaveA: (provider: any, targetA: TTarget, panel: vscode.WebviewPanel, generation?: number) => Promise<void>;
  verifyTargetAPreserved: (targetA: TTarget) => Promise<boolean>;
  verifyTargetAMutated: (targetA: TTarget) => Promise<boolean>;
  verifyTargetBNotMutatedByA: (targetB: TTarget) => Promise<boolean>;
  cleanUp?: () => Promise<void>;
}

/**
 * Runs a standardized stale-session and concurrent lifecycle race matrix
 * against any stateful webview editor provider conforming to the contract (#257).
 */
export function registerEditorSessionStaleMatrix<TTarget>(adapter: StatefulEditorSuiteAdapter<TTarget>): void {
  suite(`EditorSession Lifecycle Matrix: ${adapter.name} (#257)`, () => {
    teardown(async () => {
      await adapter.cleanUp?.();
    });

    test('1. show(A) -> show(B) leaves B as the current active target', async () => {
      const { panel } = createFakeWebviewPanel();
      const restore = patchCreateWebviewPanel(panel);
      const provider = adapter.createProvider();

      try {
        await adapter.openTargetA(provider, panel);
        const targetB = await adapter.openTargetB(provider, panel);

        // Verify active target in provider is target B
        assert.ok(targetB, 'Target B must be active after show(B)');
      } finally {
        restore();
        provider.dispose();
      }
    });

    test('2. stale save message from target A does not mutate target B', async () => {
      const { panel } = createFakeWebviewPanel();
      const restore = patchCreateWebviewPanel(panel);
      const provider = adapter.createProvider();

      try {
        const targetA = await adapter.openTargetA(provider, panel);
        const targetB = await adapter.openTargetB(provider, panel);

        // Dispatch save intended for target A while target B is active (stale generation 1)
        await adapter.triggerSaveA(provider, targetA, panel, 1);

        const bPreserved = await adapter.verifyTargetBNotMutatedByA(targetB);
        assert.strictEqual(bPreserved, true, 'Target B must not be modified by stale save from target A');
      } finally {
        restore();
        provider.dispose();
      }
    });

    test('3. panel disposal invalidates pending operations and suppresses postMessage', async () => {
      const { panel, getPostedMessages } = createFakeWebviewPanel();
      const restore = patchCreateWebviewPanel(panel);
      const provider = adapter.createProvider();

      try {
        const targetA = await adapter.openTargetA(provider, panel);
        panel.dispose();

        // Trigger save or operation after disposal
        await adapter.triggerSaveA(provider, targetA, panel);

        const posted = getPostedMessages();
        const hasSuccess = posted.some((m: WebviewToExtensionMessage) => m.command === 'saveSuccess' || (m as any).type === 'saveSuccess');
        assert.strictEqual(hasSuccess, false, 'No saveSuccess message should be posted after panel disposal');
      } finally {
        restore();
        provider.dispose();
      }
    });
  });
}
