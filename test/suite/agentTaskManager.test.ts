import * as assert from 'assert';
import '../helpers/vscodeStubRegister';
import type * as vscode from 'vscode';
import { AgentTaskManager } from '../../src/agent/agentTaskManager';
import type { AgentResult } from '../../src/agent/types';

class TestCancellationSource implements vscode.CancellationTokenSource {
  private cancelled = false;
  readonly token: vscode.CancellationToken;
  cancelCalls = 0;
  disposeCalls = 0;

  constructor() {
    const source = this;
    this.token = {
      get isCancellationRequested(): boolean { return source.cancelled; },
      onCancellationRequested: () => ({ dispose: () => undefined }),
    };
  }

  cancel(): void {
    this.cancelCalls += 1;
    this.cancelled = true;
  }

  dispose(): void { this.disposeCalls += 1; }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

suite('AgentTaskManager', () => {
  test('exposes running/completed states and freezes elapsed time after completion', async () => {
    let now = 5_000;
    const pending = deferred<AgentResult<unknown>>();
    const manager = new AgentTaskManager({ now: () => now });
    const started = manager.start('deploy', async () => pending.promise);
    assert.strictEqual(started.data?.status, 'working', 'receipt contract remains immediate working');
    const taskId = started.data!.taskId;
    await settle();

    now = 5_100;
    const running = manager.status(taskId).data as unknown as { status: string; elapsedMs: number };
    assert.strictEqual(running.status, 'running');
    assert.strictEqual(running.elapsedMs, 100);

    pending.resolve({ success: true, data: { deployed: true } });
    await settle();
    now = 5_130;
    const completed = manager.status(taskId).data as unknown as { status: string; elapsedMs: number };
    assert.strictEqual(completed.status, 'completed');
    assert.strictEqual(completed.elapsedMs, 100, 'terminal duration must use frozen finishedAt');
    manager.dispose();
  });

  test('redacts credential-shaped text from unexpected task exceptions before storing task.result', async () => {
    const manager = new AgentTaskManager();
    const started = manager.start('repository.connect', async () => {
      throw new Error('Transport failure password=repo-secret token=opaque-secret');
    });
    const taskId = started.data!.taskId;
    await settle();

    const result = manager.result(taskId);
    assert.strictEqual(result.data?.result?.code, 'TASK_EXECUTION_FAILED');
    assert.strictEqual(
      result.data?.result?.error,
      'Transport failure password=<redacted> token=<redacted>',
    );
    assert.ok(!JSON.stringify(result).includes('repo-secret'));
    assert.ok(!JSON.stringify(result).includes('opaque-secret'));
    manager.dispose();
  });

  test('cancel is a request until the operation settles and preserves the original inDoubt result', async () => {
    const source = new TestCancellationSource();
    const pending = deferred<AgentResult<unknown>>();
    const manager = new AgentTaskManager({ createCancellationSource: () => source });
    const started = manager.start('repository.commit', async (token) => {
      assert.strictEqual(token, source.token);
      return pending.promise;
    });
    assert.strictEqual(started.success, true);
    const taskId = started.data!.taskId;
    await settle();

    const cancelFirst = manager.cancel(taskId);
    const cancelSecond = manager.cancel(taskId);
    assert.strictEqual(cancelFirst.data?.status, 'running');
    assert.strictEqual(cancelFirst.data?.cancellationRequested, true);
    assert.strictEqual(source.cancelCalls, 1);
    assert.strictEqual(manager.status(taskId).data?.status, 'running');

    const serviceResult = {
      success: false,
      code: 'REPOSITORY_IN_DOUBT',
      error: 'Reconcile before retrying.',
      data: { status: 'inDoubt', affectedFullNames: ['Справочник.Goods'] },
    };
    pending.resolve(serviceResult);
    await settle();
    const result = manager.result(taskId).data!;
    assert.strictEqual(result.status, 'failed');
    assert.deepStrictEqual(result.result, serviceResult);
    assert.deepStrictEqual(manager.result(taskId).data, result);
    assert.strictEqual(cancelSecond.data?.status, 'running');
    manager.dispose();
  });

  test('marks typed confirmed cancellation as cancelled but preserves unrelated failures after cancel request', async () => {
    const confirmedCancellation = deferred<AgentResult<unknown>>();
    const unrelatedFailure = deferred<AgentResult<unknown>>();
    const manager = new AgentTaskManager();
    const cancelledStart = manager.start('deploy', async () => confirmedCancellation.promise);
    const cancelledTaskId = cancelledStart.data!.taskId;
    await settle();
    manager.cancel(cancelledTaskId);
    confirmedCancellation.resolve({
      success: false,
      code: 'REQUEST_CANCELLED',
      error: 'Operation was cancelled before its side effect started.',
    });
    await settle();
    assert.strictEqual(manager.status(cancelledTaskId).data?.status, 'cancelled');

    const failedStart = manager.start('deploy', async () => unrelatedFailure.promise);
    const failedTaskId = failedStart.data!.taskId;
    await settle();
    manager.cancel(failedTaskId);
    const originalFailure = {
      success: false,
      code: 'CONFIGURATOR_IN_DOUBT',
      error: 'Configurator stopped after start; its effect is unknown.',
      data: { state: 'inDoubt', effectPossible: true },
    };
    unrelatedFailure.resolve(originalFailure);
    await settle();
    const failed = manager.result(failedTaskId).data!;
    assert.strictEqual(failed.status, 'failed');
    assert.deepStrictEqual(failed.result, originalFailure);
    manager.dispose();
  });

  test('bounds task count, terminal TTL, stage tail, and credential-shaped stage content', async () => {
    let now = 10_000;
    const source = new TestCancellationSource();
    const pending = deferred<AgentResult<unknown>>();
    const manager = new AgentTaskManager({
      now: () => now,
      maxTasks: 1,
      terminalTtlMs: 100,
      maxRecentMessages: 2,
      createCancellationSource: () => source,
    });
    const first = manager.start('task', async (_token, reportStage) => {
      reportStage('phase one');
      reportStage('password=very-secret token=also-secret');
      reportStage('phase three');
      return pending.promise;
    });
    const taskId = first.data!.taskId;
    await settle();
    assert.strictEqual(manager.status(taskId).data!.recentMessages.length, 2);
    assert.ok(!JSON.stringify(manager.status(taskId).data).includes('very-secret'));
    assert.ok(!JSON.stringify(manager.status(taskId).data).includes('also-secret'));

    const full = manager.start('second', async () => ({ success: true }));
    assert.strictEqual(full.success, false);
    assert.strictEqual(full.code, 'TASK_CAPACITY_REACHED');

    pending.resolve({ success: true, data: { complete: true } });
    await settle();
    now += 101;
    assert.strictEqual(manager.status(taskId).code, 'TASK_NOT_FOUND');
    manager.dispose();
  });
});
