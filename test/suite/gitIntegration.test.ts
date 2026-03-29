import * as assert from 'assert';
import '../helpers/vscodeStubRegister';
import * as vscode from 'vscode';
import { registerGitPhase4HeadChangeHandlers } from '../../src/services/gitIntegration';
import { resetVscodeTestState, vscodeExtensionsTestState } from '../helpers/vscodeModuleStub';

suite('gitIntegration registerGitPhase4HeadChangeHandlers', () => {
  teardown(() => {
    resetVscodeTestState();
  });

  test('when vscode.git is absent, returns disposable noop without context subscription', async () => {
    vscodeExtensionsTestState.getExtensionImpl = () => undefined;
    const subs: { dispose(): void }[] = [];
    const ctx = { subscriptions: subs } as unknown as vscode.ExtensionContext;
    const d = registerGitPhase4HeadChangeHandlers(ctx, {
      onRefreshInfobaseManager: () => undefined,
    });
    assert.strictEqual(subs.length, 0);
    d.dispose();
    assert.ok(true);
  });

  test('HEAD change after debounce invokes onRefreshInfobaseManager', async function () {
    this.timeout(5000);
    let refreshCalls = 0;
    const headEmitter = new vscode.EventEmitter<void>();
    const repo = {
      rootUri: vscode.Uri.file('C:\\repo'),
      state: {
        HEAD: { commit: 'commit-a' } as { commit?: string },
        onDidChange: headEmitter.event,
      },
    };
    const gitExports = {
      getAPI: (_version: 1) => ({
        repositories: [repo],
        onDidOpenRepository: (_listener: (r: unknown) => void) => ({ dispose: () => undefined }),
      }),
    };
    vscodeExtensionsTestState.getExtensionImpl = () => ({
      activate: async () => gitExports,
    });

    const subs: { dispose(): void }[] = [];
    const ctx = { subscriptions: subs } as unknown as vscode.ExtensionContext;
    const d = registerGitPhase4HeadChangeHandlers(ctx, {
      onRefreshInfobaseManager: () => {
        refreshCalls += 1;
      },
    });

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    repo.state.HEAD = { commit: 'commit-b' };
    headEmitter.fire();

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1300);
    });

    assert.strictEqual(refreshCalls, 1);
    d.dispose();
  });
});
