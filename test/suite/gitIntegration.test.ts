import * as assert from 'assert';
import '../helpers/vscodeStubRegister';
import * as vscode from 'vscode';
import { registerGitPhase4HeadChangeHandlers } from '../../src/services/gitIntegration';
import { resetVscodeTestState, vscodeExtensionsTestState } from '../helpers/vscodeModuleStub';

suite('gitIntegration registerGitPhase4HeadChangeHandlers', () => {
  teardown(() => {
    resetVscodeTestState();
  });

  test('when vscode.git is absent, returns a disposable without requiring a context registry', async () => {
    vscodeExtensionsTestState.getExtensionImpl = () => undefined;
    const d = registerGitPhase4HeadChangeHandlers({
      onRefreshInfobaseManager: () => undefined,
    });
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

    const d = registerGitPhase4HeadChangeHandlers({
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

  test('disposal before Git activation resolves prevents late repository subscriptions', async () => {
    let finishActivation!: (value: { getAPI: (_version: 1) => unknown }) => void;
    let stateSubscriptions = 0;
    let repositorySubscriptions = 0;
    let stateDisposals = 0;
    let repositoryDisposals = 0;
    vscodeExtensionsTestState.getExtensionImpl = () => ({
      activate: () => new Promise((resolve) => { finishActivation = resolve; }),
    });

    const disposable = registerGitPhase4HeadChangeHandlers({
      onRefreshInfobaseManager: () => undefined,
    });
    disposable.dispose();
    finishActivation({
      getAPI: () => ({
        repositories: [{
          rootUri: vscode.Uri.file('C:\\repo'),
          state: {
            HEAD: { commit: 'commit-a' },
            onDidChange: () => {
              stateSubscriptions += 1;
              return { dispose: () => { stateDisposals += 1; } };
            },
          },
        }],
        onDidOpenRepository: () => {
          repositorySubscriptions += 1;
          return { dispose: () => { repositoryDisposals += 1; } };
        },
      }),
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.strictEqual(stateSubscriptions, 0);
    assert.strictEqual(repositorySubscriptions, 0);
    assert.strictEqual(stateDisposals, 0);
    assert.strictEqual(repositoryDisposals, 0);
  });
});
