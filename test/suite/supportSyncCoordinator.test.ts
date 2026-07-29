import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { InfobaseEntry } from '../../src/infobases/models/infobaseEntry';
import type { ConfigurationId } from '../../src/services/configurationSession/types';
import { SupportRunJournal } from '../../src/support/supportRunJournal';
import {
  type CoordinatorReadySupportTarget,
  SupportSyncCoordinator,
} from '../../src/support/supportSyncCoordinator';
import type {
  MasterSupportSnapshot,
  PreparedTargetSupportPayload,
  SupportApplicator,
  SupportCancellation,
  SupportSyncRunSummary,
} from '../../src/support/supportTypes';

suite('SupportSyncCoordinator', () => {
  let root: string;
  let journal: SupportRunJournal;

  setup(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'support-coordinator-test-'));
    journal = new SupportRunJournal(path.join(root, 'journal.json'));
  });

  teardown(async () => {
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  test('strict sync serializes targets and verifies each acknowledged apply', async () => {
    const snapshot = master();
    const targets = [readyTarget('a'), readyTarget('b')] as const;
    const firstPrepare = deferred<void>();
    const prepareEntered = deferred<void>();
    const events: string[] = [];
    let activeTargets = 0;
    let maxActiveTargets = 0;
    const applicator: SupportApplicator = {
      probe: async (entry) => ({
        supported: true,
        canonicalTargetId: targetId(entry.id),
        platformVersion: '8.3.27.1859',
        strategyId: 'certified',
      }),
      prepare: async (entry) => {
        events.push(`prepare:${entry.id}`);
        if (entry.id === 'a') {
          prepareEntered.resolve();
          await firstPrepare.promise;
        }
        return { status: 'prepared', payload: payload(entry.id, snapshot) };
      },
      apply: async (entry) => {
        events.push(`apply:${entry.id}`);
        return {
          status: 'acknowledged',
          acknowledgedGenerationId: snapshot.generationId,
        };
      },
      verify: async (entry) => {
        events.push(`verify:${entry.id}`);
        return {
          status: 'matched',
          verifiedGenerationId: snapshot.generationId,
        };
      },
    };
    const coordinator = new SupportSyncCoordinator({
      applicator,
      journal,
      preflight: async () => ({
        accepted: true,
        scope: 'replicated',
        targets,
      }),
      getCurrentGenerationId: async () => snapshot.generationId,
      runTargetExclusive: async (_target, operation) => {
        activeTargets += 1;
        maxActiveTargets = Math.max(maxActiveTargets, activeTargets);
        try {
          return await operation();
        } finally {
          activeTargets -= 1;
        }
      },
      createRunId: () => 'strict-run',
      now: () => '2026-01-01T00:00:00.000Z',
    });

    const running = coordinator.sync({
      snapshot,
      verification: 'strict',
      targets: { kind: 'all' },
    });
    await withTimeout(prepareEntered.promise);
    assert.deepStrictEqual(events, ['prepare:a']);
    firstPrepare.resolve();
    const outcome = await running;

    assert.strictEqual(outcome.status, 'completed');
    if (outcome.status === 'completed') {
      assert.strictEqual(outcome.run.state, 'complete');
      assert.deepStrictEqual(outcome.run.targets.map((target) => target.state), ['verified', 'verified']);
    }
    assert.deepStrictEqual(events, [
      'prepare:a',
      'apply:a',
      'verify:a',
      'prepare:b',
      'apply:b',
      'verify:b',
    ]);
    assert.strictEqual(maxActiveTargets, 1);
    assert.strictEqual((await journal.getLastRun(snapshot.configurationId))?.runId, 'strict-run');
  });

  test('verifyOnly is read-only and reports mixed verification without prepare/apply', async () => {
    const snapshot = master();
    const calls = { prepare: 0, apply: 0, verify: 0 };
    const applicator: SupportApplicator = {
      probe: async (entry) => ({
        supported: true,
        canonicalTargetId: targetId(entry.id),
        platformVersion: '8.3.27.1859',
        strategyId: 'certified',
      }),
      prepare: async () => {
        calls.prepare += 1;
        throw new Error('verifyOnly must not prepare');
      },
      apply: async () => {
        calls.apply += 1;
        throw new Error('verifyOnly must not apply');
      },
      verify: async (entry) => {
        calls.verify += 1;
        return entry.id === 'a'
          ? {
              status: 'mismatch',
              lastAppliedGenerationId: 'older',
              payload: payload(entry.id, snapshot),
            }
          : {
              status: 'matched',
              verifiedGenerationId: snapshot.generationId,
            };
      },
    };
    const coordinator = coordinatorFor(
      journal,
      applicator,
      [readyTarget('a'), readyTarget('b')],
      () => snapshot.generationId,
      'verify-run',
    );

    const outcome = await coordinator.verifyOnly({
      snapshot,
      targets: { kind: 'all' },
    });

    assert.strictEqual(outcome.status, 'completed');
    if (outcome.status === 'completed') {
      assert.strictEqual(outcome.run.operation, 'verify');
      assert.strictEqual(outcome.run.state, 'partial');
      assert.deepStrictEqual(outcome.run.targets.map((target) => target.state), ['stale', 'verified']);
    }
    assert.deepStrictEqual(calls, { prepare: 0, apply: 0, verify: 2 });
  });

  test('rejects invalid and empty target selections before journal publication for sync and verify', async () => {
    const snapshot = master();
    const applicator: SupportApplicator = {
      probe: async (entry) => ({
        supported: true,
        canonicalTargetId: targetId(entry.id),
        platformVersion: '8.3.27.1859',
        strategyId: 'certified',
      }),
      prepare: async () => { throw new Error('rejected selection must not prepare'); },
      apply: async () => { throw new Error('rejected selection must not apply'); },
      verify: async () => { throw new Error('rejected selection must not verify'); },
    };
    const coordinator = coordinatorFor(
      journal,
      applicator,
      [readyTarget('a'), readyTarget('b')],
      () => snapshot.generationId,
      'selection-must-not-start',
    );
    const cases = [
      {
        reason: 'empty' as const,
        selection: { kind: 'ids' as const, targetIds: [] },
      },
      {
        reason: 'duplicate' as const,
        selection: { kind: 'ids' as const, targetIds: [targetId('a'), targetId('a')] },
      },
      {
        reason: 'unknown' as const,
        selection: { kind: 'ids' as const, targetIds: [targetId('missing')] },
      },
      {
        reason: 'noMatch' as const,
        selection: {
          kind: 'retryable' as const,
          include: ['failed', 'inDoubt', 'targetDrift'] as const,
        },
      },
    ];

    for (const candidate of cases) {
      const sync = await coordinator.sync({
        snapshot,
        verification: 'fast',
        targets: candidate.selection,
      });
      assert.strictEqual(sync.status, 'targetSelectionRejected');
      if (sync.status === 'targetSelectionRejected') {
        assert.strictEqual(sync.errorCode, 'SUPPORT_TARGET_SELECTION_REJECTED');
        assert.strictEqual(sync.reason, candidate.reason);
      }
      assert.strictEqual(await journal.getLastRun(snapshot.configurationId), undefined);

      const verify = await coordinator.verifyOnly({
        snapshot,
        targets: candidate.selection,
      });
      assert.strictEqual(verify.status, 'targetSelectionRejected');
      if (verify.status === 'targetSelectionRejected') {
        assert.strictEqual(verify.errorCode, 'SUPPORT_TARGET_SELECTION_REJECTED');
        assert.strictEqual(verify.reason, candidate.reason);
      }
      assert.strictEqual(await journal.getLastRun(snapshot.configurationId), undefined);
    }
  });

  test('retryable selection is generation-scoped, excludes permanent failures and reconciles inDoubt', async () => {
    const snapshot = master();
    const oldGeneration = 'd'.repeat(64);
    const oldRun: SupportSyncRunSummary = {
      runId: 'old-run',
      configurationId: snapshot.configurationId,
      desiredGenerationId: oldGeneration,
      operation: 'sync',
      scope: 'replicated',
      targets: [{
        canonicalTargetId: targetId('a'),
        infobaseIds: ['a'],
        desiredGenerationId: oldGeneration,
        state: 'failed',
        stage: 'prepare',
        errorCode: 'SUPPORT_PREPARE_FAILED',
        retryable: true,
      }],
      state: 'failed',
    };
    await journal.complete(oldRun);
    const events: string[] = [];
    const applicator: SupportApplicator = {
      probe: async (entry) => ({
        supported: true,
        canonicalTargetId: targetId(entry.id),
        platformVersion: '8.3.27.1859',
        strategyId: 'certified',
      }),
      prepare: async (entry) => {
        events.push(`prepare:${entry.id}`);
        return {
          status: 'alreadyAcknowledged',
          acknowledgedGenerationId: snapshot.generationId,
          evidence: 'cachedConfiguratorAck',
        };
      },
      apply: async (entry) => {
        events.push(`apply:${entry.id}`);
        throw new Error('selected retry states do not require apply in this scenario');
      },
      verify: async (entry) => {
        events.push(`verify:${entry.id}`);
        return {
          status: 'matched',
          verifiedGenerationId: snapshot.generationId,
        };
      },
    };
    const targets = [readyTarget('a'), readyTarget('b'), readyTarget('d')] as const;
    const coordinator = coordinatorFor(
      journal,
      applicator,
      targets,
      () => snapshot.generationId,
      'retry-run',
    );
    const retrySelection = {
      kind: 'retryable' as const,
      include: ['failed', 'inDoubt'] as const,
    };

    const oldOutcome = await coordinator.sync({
      snapshot,
      verification: 'fast',
      targets: retrySelection,
    });
    assert.strictEqual(oldOutcome.status, 'targetSelectionRejected');
    if (oldOutcome.status === 'targetSelectionRejected') {
      assert.strictEqual(oldOutcome.reason, 'noMatch');
    }
    assert.strictEqual((await journal.getLastRun(snapshot.configurationId))?.runId, 'old-run');

    const currentRun: SupportSyncRunSummary = {
      runId: 'current-run',
      configurationId: snapshot.configurationId,
      desiredGenerationId: snapshot.generationId,
      operation: 'sync',
      scope: 'replicated',
      targets: [
        {
          canonicalTargetId: targetId('a'),
          infobaseIds: ['a'],
          desiredGenerationId: snapshot.generationId,
          state: 'failed',
          stage: 'prepare',
          errorCode: 'SUPPORT_PREPARE_FAILED',
          retryable: true,
        },
        {
          canonicalTargetId: targetId('b'),
          infobaseIds: ['b'],
          desiredGenerationId: snapshot.generationId,
          state: 'failed',
          stage: 'prepare',
          errorCode: 'CONFIGURATOR_FATAL_MARKER',
          retryable: false,
        },
        {
          canonicalTargetId: targetId('d'),
          infobaseIds: ['d'],
          desiredGenerationId: snapshot.generationId,
          state: 'inDoubt',
          stage: 'apply',
          errorCode: 'SUPPORT_RUN_INTERRUPTED',
        },
      ],
      state: 'failed',
    };
    await journal.complete(currentRun);

    const outcome = await coordinator.sync({
      snapshot,
      verification: 'fast',
      targets: retrySelection,
    });
    assert.strictEqual(outcome.status, 'completed');
    if (outcome.status === 'completed') {
      assert.deepStrictEqual(
        outcome.run.targets.map((target) => [target.canonicalTargetId, target.state]),
        [
          [targetId('a'), 'applied'],
          [targetId('d'), 'verified'],
        ],
      );
    }
    assert.deepStrictEqual(events, ['prepare:a', 'verify:d']);
  });

  test('cancellation after an acknowledged target skips every remaining target and drains the run', async () => {
    const snapshot = master();
    const cancellation = mutableCancellation();
    const prepared: string[] = [];
    const applicator: SupportApplicator = {
      probe: async (entry) => ({
        supported: true,
        canonicalTargetId: targetId(entry.id),
        platformVersion: '8.3.27.1859',
        strategyId: 'certified',
      }),
      prepare: async (entry) => {
        prepared.push(entry.id);
        return { status: 'prepared', payload: payload(entry.id, snapshot) };
      },
      apply: async () => {
        cancellation.cancel();
        return {
          status: 'acknowledged',
          acknowledgedGenerationId: snapshot.generationId,
        };
      },
      verify: async () => {
        throw new Error('fast sync must not verify');
      },
    };
    const coordinator = coordinatorFor(
      journal,
      applicator,
      [readyTarget('a'), readyTarget('b'), readyTarget('c')],
      () => snapshot.generationId,
      'cancel-run',
    );

    const outcome = await coordinator.sync({
      snapshot,
      verification: 'fast',
      targets: { kind: 'all' },
      cancellation,
    });

    assert.strictEqual(outcome.status, 'completed');
    if (outcome.status === 'completed') {
      assert.strictEqual(outcome.run.state, 'cancelled');
      assert.deepStrictEqual(outcome.run.targets.map((target) => target.state), [
        'applied',
        'skipped',
        'skipped',
      ]);
      assert.deepStrictEqual(
        outcome.run.targets.slice(1).map((target) =>
          target.state === 'skipped' ? target.reason : undefined),
        ['cancelled', 'cancelled'],
      );
    }
    assert.deepStrictEqual(prepared, ['a']);
    assert.strictEqual(await journal.getActiveRun(snapshot.configurationId), undefined);
  });

  test('generation CAS immediately before apply blocks the effect and obsoletes the run', async () => {
    const snapshot = master();
    let generationReads = 0;
    let applyCalls = 0;
    const prepared: string[] = [];
    const applicator: SupportApplicator = {
      probe: async (entry) => ({
        supported: true,
        canonicalTargetId: targetId(entry.id),
        platformVersion: '8.3.27.1859',
        strategyId: 'certified',
      }),
      prepare: async (entry) => {
        prepared.push(entry.id);
        return { status: 'prepared', payload: payload(entry.id, snapshot) };
      },
      apply: async (_entry, _snapshot, _payload, _cancellation, beforeEffect) => {
        if (!await beforeEffect()) {
          return { status: 'stale', reason: 'masterAdvanced' };
        }
        applyCalls += 1;
        return {
          status: 'acknowledged',
          acknowledgedGenerationId: snapshot.generationId,
        };
      },
      verify: async () => {
        throw new Error('fast sync must not verify');
      },
    };
    const coordinator = coordinatorFor(
      journal,
      applicator,
      [readyTarget('a'), readyTarget('b')],
      () => {
        generationReads += 1;
        return generationReads <= 1 ? snapshot.generationId : 'advanced-generation';
      },
      'obsolete-run',
    );

    const outcome = await coordinator.sync({
      snapshot,
      verification: 'fast',
      targets: { kind: 'all' },
    });

    assert.strictEqual(outcome.status, 'completed');
    if (outcome.status === 'completed') {
      assert.strictEqual(outcome.run.state, 'obsolete');
      assert.strictEqual(outcome.run.supersededByGenerationId, 'advanced-generation');
      assert.deepStrictEqual(outcome.run.targets.map((target) => target.state), ['stale', 'skipped']);
      const first = outcome.run.targets[0];
      assert.strictEqual(first?.state === 'stale' ? first.reason : undefined, 'masterAdvanced');
      const second = outcome.run.targets[1];
      assert.strictEqual(second?.state === 'skipped' ? second.reason : undefined, 'obsolete');
    }
    assert.deepStrictEqual(prepared, ['a']);
    assert.strictEqual(applyCalls, 0);
  });
});

function coordinatorFor(
  journal: SupportRunJournal,
  applicator: SupportApplicator,
  targets: readonly [CoordinatorReadySupportTarget, ...CoordinatorReadySupportTarget[]],
  generation: () => string,
  runId: string,
): SupportSyncCoordinator {
  return new SupportSyncCoordinator({
    applicator,
    journal,
    preflight: async () => ({
      accepted: true,
      scope: 'replicated',
      targets,
    }),
    getCurrentGenerationId: async () => generation(),
    runTargetExclusive: async (_target, operation) => operation(),
    createRunId: () => runId,
    now: () => '2026-01-01T00:00:00.000Z',
  });
}

function master(): MasterSupportSnapshot {
  return {
    configurationId: 'cfg-coordinator' as ConfigurationId,
    generationId: 'a'.repeat(64),
    semanticDigest: 'b'.repeat(64),
    filePath: path.resolve('Ext', 'ParentConfigurations.bin'),
    formatRevision: '6',
    globalEditability: 'enabled',
    configurationMode: 'mixed',
    objectModes: new Map(),
    supplierConfigurations: [{
      supplierConfigurationId: 'supplier-a',
      name: 'Supplier',
      vendor: 'Vendor',
      version: '1',
      blockEditability: 'disabled',
    }],
  };
}

function readyTarget(id: string): CoordinatorReadySupportTarget {
  return {
    canonicalTargetId: targetId(id),
    infobaseIds: [id],
    state: 'ready',
    entry: infobase(id),
  };
}

function infobase(id: string): InfobaseEntry {
  return {
    id,
    name: id,
    type: 'file',
    filePath: path.resolve(`${id}.1cd`),
    hasStoredPassword: false,
    launchSettings: { platformVersion: '8.3.27.1859' },
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function targetId(id: string): string {
  return `file:${id}`;
}

function payload(id: string, snapshot: MasterSupportSnapshot): PreparedTargetSupportPayload {
  return {
    cacheKey: {
      canonicalTargetId: targetId(id),
      platformVersion: '8.3.27.1859',
      configurationId: snapshot.configurationId,
      supplierConfigurationIds: ['supplier-a'],
      formatRevision: '6',
    },
    canonicalTargetId: targetId(id),
    platformVersion: '8.3.27.1859',
    databaseStamp: {
      resolvedPath: path.resolve(`${id}.1cd`),
      fileId: id,
      length: 1,
      lastWriteTimeUtcTicks: '1',
    },
    observedSemanticDigest: 'c'.repeat(64),
    supplierFiles: [],
    desiredGenerationId: snapshot.generationId,
    desiredMasterBytes: Buffer.from('desired'),
  };
}

function mutableCancellation(): SupportCancellation & { cancel(): void } {
  const listeners = new Set<() => void>();
  let cancelled = false;
  return {
    get isCancellationRequested(): boolean {
      return cancelled;
    },
    onCancellationRequested(listener: () => void) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    cancel(): void {
      cancelled = true;
      for (const listener of listeners) {
        listener();
      }
      listeners.clear();
    },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function withTimeout(promise: Promise<void>): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Timed out waiting for support coordinator test condition.')),
          5_000,
        );
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
