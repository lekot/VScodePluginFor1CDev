import * as assert from 'assert';
import {
  EditorSessionCoordinator,
  type WebviewEditorSession,
  type EditorSessionSnapshot,
} from '../../src/services/editorSession/editorSessionCoordinator';
import { createFakeWebviewPanel } from '../helpers/rightsEditorTestHarness';

suite('EditorSessionCoordinator (#257)', () => {
  interface TestTarget {
    id: string;
    filePath: string;
  }

  test('1. begin allocates monotonic generation and unique sessionId', () => {
    const coordinator = new EditorSessionCoordinator<TestTarget>();
    const { panel: panel1 } = createFakeWebviewPanel();
    const { panel: panel2 } = createFakeWebviewPanel();

    const target1: TestTarget = { id: 'item-1', filePath: '/path/1' };
    const target2: TestTarget = { id: 'item-2', filePath: '/path/2' };

    const session1 = coordinator.begin({ panel: panel1 as any, target: target1 });
    assert.strictEqual(session1.generation, 1);
    assert.strictEqual(session1.isCurrent(), true);
    assert.strictEqual(session1.target, target1);

    const session2 = coordinator.begin({ panel: panel2 as any, target: target2 });
    assert.strictEqual(session2.generation, 2);
    assert.strictEqual(session2.isCurrent(), true);
    assert.strictEqual(session2.target, target2);

    assert.notStrictEqual(session1.id, session2.id, 'Session IDs must be distinct');
    assert.strictEqual(session1.isCurrent(), false, 'Session 1 must be marked superseded');
  });

  test('2. stale result suppression: async load A completing after begin B is discarded', async () => {
    const coordinator = new EditorSessionCoordinator<TestTarget>();
    const { panel, getPostedMessages } = createFakeWebviewPanel();

    const targetA: TestTarget = { id: 'A', filePath: '/path/A' };
    const targetB: TestTarget = { id: 'B', filePath: '/path/B' };

    const sessionA = coordinator.begin({ panel: panel as any, target: targetA });
    const snapshotA = sessionA.snapshot();

    // Begin session B before A's load finishes
    const sessionB = coordinator.begin({ panel: panel as any, target: targetB });
    const snapshotB = sessionB.snapshot();

    // Async load A finishes late:
    assert.strictEqual(sessionA.isCurrent(snapshotA), false, 'Late A snapshot must not be current');
    assert.strictEqual(sessionB.isCurrent(snapshotB), true, 'B snapshot must remain current');

    // Attempting postMessage from stale session A must be dropped
    const postedA = sessionA.postMessage({ type: 'loadData', target: 'A' });
    assert.strictEqual(postedA, false, 'Stale postMessage from A must return false');
    assert.strictEqual(getPostedMessages().length, 0, 'No message should be posted to webview for stale A');

    // postMessage from session B succeeds
    const postedB = sessionB.postMessage({ type: 'loadData', target: 'B' });
    assert.strictEqual(postedB, true);
    assert.strictEqual(getPostedMessages().length, 1);
    assert.deepStrictEqual(getPostedMessages()[0], { type: 'loadData', target: 'B' });
  });

  test('3. queued save A executing after opening B mutates target A only and suppresses UI events to B', async () => {
    const coordinator = new EditorSessionCoordinator<TestTarget>();
    const { panel, getPostedMessages } = createFakeWebviewPanel();

    const targetA: TestTarget = { id: 'A', filePath: '/path/A' };
    const targetB: TestTarget = { id: 'B', filePath: '/path/B' };

    const sessionA = coordinator.begin({ panel: panel as any, target: targetA });
    const snapshotA = sessionA.snapshot();

    let mutatedTarget: TestTarget | undefined;
    let saveAInProgressDuringB = false;

    // Simulate queued save A
    const savePromiseA = sessionA.runGuardedSave(snapshotA, async (target) => {
      // Simulate delay in FIFO mutation queue while user opens B
      await new Promise((r) => setTimeout(r, 20));
      saveAInProgressDuringB = coordinator.currentSession?.target.id === 'B';
      mutatedTarget = target;
      return { success: true };
    });

    // User switches to B while save A is in flight
    const sessionB = coordinator.begin({ panel: panel as any, target: targetB });

    const resultA = await savePromiseA;
    assert.strictEqual(saveAInProgressDuringB, true, 'Save A should have executed while B is current session');
    assert.strictEqual(mutatedTarget?.id, 'A', 'Save A must operate exclusively on target A');
    assert.deepStrictEqual(resultA, { success: true });

    // Stale session A must not publish saveSuccess or saveError into webview B
    const postedSuccessA = sessionA.postMessage({ type: 'saveSuccess', target: snapshotA.target.id });
    assert.strictEqual(postedSuccessA, false, 'sessionA must not post saveSuccess to webview');
    assert.strictEqual(getPostedMessages().length, 0, 'Webview must receive no messages from stale save A');
  });

  test('4. panel disposal automatically invalidates session and cancels pending operations', () => {
    const coordinator = new EditorSessionCoordinator<TestTarget>();
    const { panel, getPostedMessages } = createFakeWebviewPanel();

    const target: TestTarget = { id: 'A', filePath: '/path/A' };
    const session = coordinator.begin({ panel: panel as any, target });
    assert.strictEqual(session.isCurrent(), true);

    // Dispose panel
    panel.dispose();

    assert.strictEqual(session.isCurrent(), false, 'Session must not be current after panel disposal');
    assert.strictEqual(session.isDisposed, true, 'Session must be marked disposed');
    assert.strictEqual(session.postMessage({ type: 'update' }), false, 'postMessage on disposed session must fail');
    assert.strictEqual(getPostedMessages().length, 0);
  });

  test('5. isCurrentMessage validates generation and target identifiers', () => {
    const coordinator = new EditorSessionCoordinator<TestTarget>({
      targetEquals: (a, b) => a.filePath === b.filePath,
    });
    const { panel } = createFakeWebviewPanel();

    const targetA: TestTarget = { id: 'A', filePath: '/path/A' };
    const targetB: TestTarget = { id: 'B', filePath: '/path/B' };

    const sessionA = coordinator.begin({ panel: panel as any, target: targetA });

    // Valid message for active session A
    assert.strictEqual(sessionA.isCurrentMessage({ generation: 1, filePath: '/path/A' }), true);
    assert.strictEqual(sessionA.isCurrentMessage({ sessionId: sessionA.id }), true);

    // Switch to B
    const sessionB = coordinator.begin({ panel: panel as any, target: targetB });

    // Message from webview A with generation 1
    assert.strictEqual(sessionB.isCurrentMessage({ generation: 1, filePath: '/path/A' }), false);
    assert.strictEqual(sessionB.isCurrentMessage({ sessionId: sessionA.id }), false);

    // Valid message for active session B
    assert.strictEqual(sessionB.isCurrentMessage({ generation: 2, filePath: '/path/B' }), true);
  });

  test('6. coordinator dispose invalidates active session and cleans up', () => {
    const coordinator = new EditorSessionCoordinator<TestTarget>();
    const { panel } = createFakeWebviewPanel();

    const target: TestTarget = { id: 'A', filePath: '/path/A' };
    const session = coordinator.begin({ panel: panel as any, target });
    assert.strictEqual(session.isCurrent(), true);

    coordinator.dispose();
    assert.strictEqual(session.isCurrent(), false);
    assert.strictEqual(coordinator.currentSession, undefined);
  });
});
