import * as assert from 'assert';

import { CompareSession } from '../../../src/compareMerge/domain/compareSession';
import { PreviewStore } from '../../../src/compareMerge/domain/previewStore';

suite('CompareSession domain', () => {
  test('creates session and durable snapshots with retention metadata', () => {
    const session = CompareSession.create({
      sessionId: 'session-1',
      createdAt: '2026-05-30T10:00:00.000Z',
      sources: [
        {
          sourceId: 'left-source',
          side: 'left',
          kind: 'workspace',
          displayName: 'Current workspace',
          rootUri: 'file:///repo',
          writable: true,
        },
        {
          sourceId: 'right-source',
          side: 'right',
          kind: 'snapshot',
          displayName: 'Incoming snapshot',
          rootUri: 'file:///snapshots/right',
          writable: false,
        },
      ],
    });

    const snapshot = session.registerSnapshot({
      snapshotId: 'snapshot-right-1',
      sourceId: 'right-source',
      snapshotRoot: 'file:///tmp/compare/session-1/right',
      origin: 'file:///snapshots/right',
      createdAt: '2026-05-30T10:01:00.000Z',
      retentionUntil: '2026-05-31T10:01:00.000Z',
      sourceRevision: 'rev-42',
      readOnly: true,
      cleanupPolicy: 'retainUntil',
      contentHash: 'sha256:abc123',
    });

    assert.strictEqual(session.state.sessionId, 'session-1');
    assert.strictEqual(snapshot.snapshotId, 'snapshot-right-1');
    assert.strictEqual(snapshot.sourceId, 'right-source');
    assert.strictEqual(snapshot.retentionUntil, '2026-05-31T10:01:00.000Z');
    assert.strictEqual(snapshot.sourceRevision, 'rev-42');
    assert.strictEqual(snapshot.readOnly, true);
    assert.strictEqual(session.state.sources[1].snapshotId, 'snapshot-right-1');
  });

  test('tracks blocking diagnostics as session messages', () => {
    const session = makeSession();

    session.addMessage({
      severity: 'error',
      code: 'SNAPSHOT_STALE',
      phase: 'snapshot',
      sourceId: 'right-source',
      nodeId: 'Catalog.Products',
      path: 'Catalogs/Products.xml',
      range: {
        startLine: 12,
        startCharacter: 4,
        endLine: 12,
        endCharacter: 15,
      },
      blocking: true,
      suggestedAction: 'Refresh right snapshot before preview.',
    });

    assert.strictEqual(session.state.messages.length, 1);
    assert.strictEqual(session.state.messages[0].blocking, true);
    assert.strictEqual(session.hasBlockingMessages(), true);
  });

  test('approves and executes preview only when it belongs to current session snapshots', () => {
    const session = makeSession();
    const preview = session.createPreview({
      previewId: 'preview-1',
      targetSourceId: 'left-source',
      snapshotIds: {
        left: 'snapshot-left-1',
        right: 'snapshot-right-1',
      },
      createdAt: '2026-05-30T10:05:00.000Z',
      summary: 'Apply right package name',
    });

    const approved = session.approvePreview(preview.previewId);

    assert.strictEqual(approved.approvalState, 'approved');
    assert.strictEqual(session.canExecutePreview(preview.previewId), true);
    assert.strictEqual(session.requireExecutablePreview(preview.previewId).previewId, 'preview-1');
  });

  test('does not allow executed preview to be approved or executed again', () => {
    const session = makeSession();
    const preview = session.createPreview({
      previewId: 'executed-preview',
      targetSourceId: 'left-source',
      snapshotIds: {
        left: 'snapshot-left-1',
        right: 'snapshot-right-1',
      },
      createdAt: '2026-05-30T10:05:00.000Z',
      summary: 'Apply right package name',
    });

    session.approvePreview(preview.previewId);
    const executed = session.markPreviewExecuted(preview.previewId);

    assert.strictEqual(executed.approvalState, 'executed');
    assert.throws(() => session.approvePreview(preview.previewId), /not draft/);
    assert.strictEqual(session.canExecutePreview(preview.previewId), false);
    assert.throws(() => session.markPreviewExecuted(preview.previewId), /not executable/);
    assert.strictEqual(session.canExecutePreview(preview.previewId), false);
  });

  test('rejects approval for preview from another session', () => {
    const previewStore = new PreviewStore();
    const preview = previewStore.createPreview({
      previewId: 'foreign-preview',
      sessionId: 'session-from-other-tab',
      targetSourceId: 'left-source',
      snapshotIds: {
        left: 'snapshot-left-1',
        right: 'snapshot-right-1',
      },
      createdAt: '2026-05-30T10:05:00.000Z',
      summary: 'Foreign preview',
    });

    assert.throws(
      () =>
        previewStore.approvePreview(preview.previewId, {
          sessionId: 'session-1',
          snapshotIds: {
            left: 'snapshot-left-1',
            right: 'snapshot-right-1',
          },
        }),
      /session mismatch/
    );
    assert.strictEqual(
      previewStore.canExecutePreview(preview.previewId, {
        sessionId: 'session-1',
        snapshotIds: {
          left: 'snapshot-left-1',
          right: 'snapshot-right-1',
        },
      }),
      false
    );
  });

  test('does not expose preview store as a runtime session property', () => {
    const session = makeSession();
    const runtimeSession = session as unknown as { previewStore?: unknown };

    assert.strictEqual('previewStore' in runtimeSession, false);
    assert.strictEqual(runtimeSession.previewStore, undefined);
  });

  test('lists only previews that belong to requested session id', () => {
    const previewStore = new PreviewStore();
    previewStore.createPreview({
      previewId: 'session-preview',
      sessionId: 'session-1',
      targetSourceId: 'left-source',
      snapshotIds: {
        left: 'snapshot-left-1',
      },
      createdAt: '2026-05-30T10:05:00.000Z',
      summary: 'Session preview',
    });
    previewStore.createPreview({
      previewId: 'foreign-preview',
      sessionId: 'session-2',
      targetSourceId: 'left-source',
      snapshotIds: {
        left: 'snapshot-left-1',
      },
      createdAt: '2026-05-30T10:06:00.000Z',
      summary: 'Foreign preview',
    });

    const previews = previewStore.listPreviews('session-1');

    assert.deepStrictEqual(
      previews.map((preview) => preview.previewId),
      ['session-preview']
    );
    previews[0].approvalState = 'approved';
    assert.strictEqual(previewStore.getPreview('session-preview')?.approvalState, 'draft');
  });

  test('rejects approval and execute for preview with stale snapshot ids', () => {
    const session = makeSession();
    const preview = session.createPreview({
      previewId: 'stale-preview',
      targetSourceId: 'left-source',
      snapshotIds: {
        left: 'snapshot-left-0',
        right: 'snapshot-right-1',
      },
      createdAt: '2026-05-30T10:05:00.000Z',
      summary: 'Stale preview',
    });

    assert.throws(() => session.approvePreview(preview.previewId), /snapshot mismatch/);
    assert.strictEqual(session.canExecutePreview(preview.previewId), false);
    assert.throws(() => session.requireExecutablePreview(preview.previewId), /not executable/);
  });

  test('rejects preview creation without snapshot ids', () => {
    const session = makeSession();

    assert.throws(
      () =>
        session.createPreview({
          previewId: 'empty-snapshot-preview',
          targetSourceId: 'left-source',
          snapshotIds: {},
          createdAt: '2026-05-30T10:05:00.000Z',
          summary: 'Preview without snapshots',
        }),
      /at least one snapshot/
    );
  });

  test('rejects preview store creation and guard validation without snapshot ids', () => {
    const previewStore = new PreviewStore();

    assert.throws(
      () =>
        previewStore.createPreview({
          previewId: 'empty-store-preview',
          sessionId: 'session-1',
          targetSourceId: 'left-source',
          snapshotIds: {},
          createdAt: '2026-05-30T10:05:00.000Z',
          summary: 'Store preview without snapshots',
        }),
      /at least one snapshot/
    );

    const preview = previewStore.createPreview({
      previewId: 'guarded-preview',
      sessionId: 'session-1',
      targetSourceId: 'left-source',
      snapshotIds: {
        left: 'snapshot-left-1',
      },
      createdAt: '2026-05-30T10:06:00.000Z',
      summary: 'Guarded preview',
    });

    assert.throws(
      () =>
        previewStore.approvePreview(preview.previewId, {
          sessionId: 'session-1',
          snapshotIds: {},
        }),
      /at least one snapshot/
    );
    previewStore.approvePreview(preview.previewId, {
      sessionId: 'session-1',
      snapshotIds: {
        left: 'snapshot-left-1',
      },
    });

    assert.strictEqual(
      previewStore.canExecutePreview(preview.previewId, {
        sessionId: 'session-1',
        snapshotIds: {},
      }),
      false
    );
    assert.throws(
      () =>
        previewStore.requireExecutablePreview(preview.previewId, {
          sessionId: 'session-1',
          snapshotIds: {},
        }),
      /not executable/
    );
  });

  test('does not let returned session state mutate preview lifecycle guard', () => {
    const session = makeSession();
    const preview = session.createPreview({
      previewId: 'stale-preview',
      targetSourceId: 'left-source',
      snapshotIds: {
        left: 'snapshot-left-0',
        right: 'snapshot-right-1',
      },
      createdAt: '2026-05-30T10:05:00.000Z',
      summary: 'Stale preview',
    });

    session.state.sources[0].snapshotId = 'snapshot-left-0';

    assert.throws(() => session.approvePreview(preview.previewId), /snapshot mismatch/);
    assert.strictEqual(session.canExecutePreview(preview.previewId), false);
    assert.strictEqual(session.state.sources[0].snapshotId, 'snapshot-left-1');
  });

  test('does not let returned snapshots messages or previews mutate stored session data', () => {
    const session = makeSession();
    const message = session.addMessage({
      severity: 'error',
      code: 'SNAPSHOT_STALE',
      phase: 'snapshot',
      sourceId: 'right-source',
      blocking: true,
    });
    const preview = session.createPreview({
      previewId: 'preview-to-mutate',
      targetSourceId: 'left-source',
      snapshotIds: {
        left: 'snapshot-left-1',
        right: 'snapshot-right-1',
      },
      createdAt: '2026-05-30T10:05:00.000Z',
      summary: 'Apply right package name',
    });
    const state = session.state;

    message.blocking = false;
    state.snapshots[0].contentHash = 'sha256:tampered';
    state.messages[0].blocking = false;
    preview.approvalState = 'approved';
    (preview.snapshotIds as Partial<Record<'left' | 'right', string>>).left = 'snapshot-left-0';
    state.previews[0].approvalState = 'executed';

    assert.strictEqual(session.hasBlockingMessages(), true);
    assert.strictEqual(session.state.snapshots[0].contentHash, 'sha256:left');
    assert.strictEqual(session.state.messages[0].blocking, true);
    assert.strictEqual(session.canExecutePreview(preview.previewId), false);

    const approved = session.approvePreview(preview.previewId);
    assert.strictEqual(approved.approvalState, 'approved');
    assert.strictEqual(approved.snapshotIds.left, 'snapshot-left-1');
  });

  test('rejects preview when snapshot ids contain an extra absent guard side', () => {
    const previewStore = new PreviewStore();
    const preview = previewStore.createPreview({
      previewId: 'preview-with-extra-side',
      sessionId: 'session-1',
      targetSourceId: 'left-source',
      snapshotIds: {
        left: 'snapshot-left-1',
        right: 'stale-right-snapshot',
      },
      createdAt: '2026-05-30T10:05:00.000Z',
      summary: 'Preview with stale extra side',
    });

    assert.throws(
      () =>
        previewStore.approvePreview(preview.previewId, {
          sessionId: 'session-1',
          snapshotIds: {
            left: 'snapshot-left-1',
          },
        }),
      /snapshot mismatch/
    );
    assert.strictEqual(
      previewStore.canExecutePreview(preview.previewId, {
        sessionId: 'session-1',
        snapshotIds: {
          left: 'snapshot-left-1',
        },
      }),
      false
    );
  });
});

function makeSession(): CompareSession {
  const session = CompareSession.create({
    sessionId: 'session-1',
    createdAt: '2026-05-30T10:00:00.000Z',
    sources: [
      {
        sourceId: 'left-source',
        side: 'left',
        kind: 'workspace',
        displayName: 'Current workspace',
        rootUri: 'file:///repo',
        writable: true,
      },
      {
        sourceId: 'right-source',
        side: 'right',
        kind: 'snapshot',
        displayName: 'Incoming snapshot',
        rootUri: 'file:///snapshots/right',
        writable: false,
      },
    ],
  });

  session.registerSnapshot({
    snapshotId: 'snapshot-left-1',
    sourceId: 'left-source',
    snapshotRoot: 'file:///tmp/compare/session-1/left',
    origin: 'file:///repo',
    createdAt: '2026-05-30T10:01:00.000Z',
    retentionUntil: '2026-05-30T12:01:00.000Z',
    sourceRevision: 'worktree:abc',
    readOnly: false,
    cleanupPolicy: 'deleteOnSessionClose',
    contentHash: 'sha256:left',
  });
  session.registerSnapshot({
    snapshotId: 'snapshot-right-1',
    sourceId: 'right-source',
    snapshotRoot: 'file:///tmp/compare/session-1/right',
    origin: 'file:///snapshots/right',
    createdAt: '2026-05-30T10:01:00.000Z',
    retentionUntil: '2026-05-30T12:01:00.000Z',
    sourceRevision: 'snapshot:42',
    readOnly: true,
    cleanupPolicy: 'retainUntil',
    contentHash: 'sha256:right',
  });

  return session;
}
