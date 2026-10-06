import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { hashContent } from '../../src/services/configurationSession/atomicFileStorage';
import { MutationPlanExecutor, MutationPlanError } from '../../src/services/configurationSession/mutationPlan';

suite('MutationPlanExecutor', () => {
  let tempDir: string;

  setup(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mutation-plan-'));
  });

  teardown(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined);
  });

  test('rolls every file back when a later step fails', async () => {
    const first = path.join(tempDir, 'first.xml');
    const second = path.join(tempDir, 'second.xml');
    await fs.promises.writeFile(first, 'first-old', 'utf8');
    await fs.promises.writeFile(second, 'second-old', 'utf8');
    const executor = new MutationPlanExecutor(tempDir);

    await assert.rejects(
      executor.execute({
        kind: 'test.rollback',
        steps: [
          {
            type: 'writeFile', targetPath: first, content: 'first-new', encoding: 'utf8',
            expected: { state: 'file', hash: hashContent('first-old') },
          },
          {
            type: 'writeFile', targetPath: first, content: 'never', encoding: 'utf8',
            expected: { state: 'file', hash: hashContent('unexpected') },
          },
          {
            type: 'writeFile', targetPath: second, content: 'second-new', encoding: 'utf8',
            expected: { state: 'file', hash: hashContent('second-old') },
          },
        ],
        result: undefined,
      }),
      (error: MutationPlanError) => error.code === 'PLAN_CONFLICT',
    );

    assert.strictEqual(await fs.promises.readFile(first, 'utf8'), 'first-old');
    assert.strictEqual(await fs.promises.readFile(second, 'utf8'), 'second-old');
    assert.strictEqual(fs.existsSync(path.join(tempDir, '.cdt-journal')), false);
  });

  test('serializes plans per root and reports a stale second writer as a typed conflict', async () => {
    const target = path.join(tempDir, 'Configuration.xml');
    await fs.promises.writeFile(target, 'original', 'utf8');
    const expected = { state: 'file' as const, hash: hashContent('original') };
    const originalRealpathDescriptor = Object.getOwnPropertyDescriptor(fs.promises, 'realpath');
    if (!originalRealpathDescriptor || typeof originalRealpathDescriptor.value !== 'function') {
      throw new Error('fs.promises.realpath must be a configurable data property for this test.');
    }
    const originalRealpath = originalRealpathDescriptor.value as typeof fs.promises.realpath;
    let rootRealpathCalls = 0;
    let markFirstRealpathEntered!: () => void;
    let releaseFirstRealpath!: () => void;
    const firstRealpathEntered = new Promise<void>((resolve) => { markFirstRealpathEntered = resolve; });
    const firstRealpathGate = new Promise<void>((resolve) => { releaseFirstRealpath = resolve; });
    const interceptedRealpath = async (requestedPath: fs.PathLike): Promise<string> => {
      if (path.resolve(String(requestedPath)) === path.resolve(tempDir)) {
        rootRealpathCalls++;
        if (rootRealpathCalls === 1) {
          markFirstRealpathEntered();
          await firstRealpathGate;
        }
      }
      return originalRealpath(requestedPath);
    };
    Object.defineProperty(fs.promises, 'realpath', {
      ...originalRealpathDescriptor,
      value: interceptedRealpath,
    });

    let first: Promise<string> | undefined;
    let second: Promise<string> | undefined;
    try {
      first = new MutationPlanExecutor(tempDir).execute({
        kind: 'test.concurrent.first',
        steps: [{
          type: 'writeFile', targetPath: target, content: 'first', encoding: 'utf8', expected,
        }],
        result: 'first',
      });
      await firstRealpathEntered;
      second = new MutationPlanExecutor(tempDir).execute({
        kind: 'test.concurrent.second',
        steps: [{
          type: 'writeFile', targetPath: target, content: 'second', encoding: 'utf8', expected,
        }],
        result: 'second',
      });

      assert.strictEqual(rootRealpathCalls, 1, 'The second writer must queue before canonicalization.');
      releaseFirstRealpath();
      const outcomes = await Promise.allSettled([first, second]);
      assert.strictEqual(outcomes[0].status, 'fulfilled');
      assert.strictEqual(outcomes[1].status, 'rejected');
      const rejection = outcomes[1] as PromiseRejectedResult;
      assert.ok(rejection.reason instanceof MutationPlanError);
      assert.strictEqual((rejection.reason as MutationPlanError).code, 'PLAN_CONFLICT');
      assert.strictEqual(await fs.promises.readFile(target, 'utf8'), 'first');
      assert.strictEqual(fs.existsSync(path.join(tempDir, '.cdt-journal')), false);
    } finally {
      releaseFirstRealpath();
      Object.defineProperty(fs.promises, 'realpath', originalRealpathDescriptor);
      await Promise.allSettled([first, second].filter((value): value is Promise<string> => value !== undefined));
    }
    assert.deepStrictEqual(
      Object.getOwnPropertyDescriptor(fs.promises, 'realpath'),
      originalRealpathDescriptor,
    );
  });

  test('recovers an interrupted journal before accepting another mutation', async () => {
    const target = path.join(tempDir, 'Configuration.xml');
    await fs.promises.writeFile(target, 'original', 'utf8');
    const operationPath = path.join(tempDir, '.cdt-journal', 'interrupted');
    await fs.promises.mkdir(path.join(operationPath, 'backups'), { recursive: true });
    await fs.promises.writeFile(path.join(operationPath, 'backups', '0'), 'original', 'utf8');
    await fs.promises.writeFile(target, 'partial-effect', 'utf8');
    await fs.promises.writeFile(path.join(operationPath, 'journal.json'), JSON.stringify({
      version: 1,
      operationId: 'interrupted',
      plan: { kind: 'test.interrupted', steps: [], result: null },
      state: 'applying',
      appliedSteps: 1,
      snapshots: [{
        targetPath: target,
        state: 'file',
        hash: hashContent('original'),
        backupName: '0',
        contentsBackedUp: true,
      }],
    }), 'utf8');

    await new MutationPlanExecutor(tempDir).recover();

    assert.strictEqual(await fs.promises.readFile(target, 'utf8'), 'original');
    assert.strictEqual(fs.existsSync(path.join(tempDir, '.cdt-journal')), false);
  });

  test('Issue #167: failed preparation cleans up pre-effect operation directory and unblocks next plan', async () => {
    const fileA = path.join(tempDir, 'fileA.xml');
    const fileB = path.join(tempDir, 'fileB.xml');
    await fs.promises.writeFile(fileA, 'initial-A', 'utf8');
    await fs.promises.writeFile(fileB, 'initial-B', 'utf8');
    const executor = new MutationPlanExecutor(tempDir);

    const origWriteFile = fs.promises.writeFile;
    let failTempJournal = true;
    (fs.promises as any).writeFile = async (targetPath: any, data: any, options: any) => {
      if (failTempJournal && typeof targetPath === 'string' && targetPath.includes('.journal-') && targetPath.endsWith('.tmp')) {
        const err = new Error('ENOSPC: write failed');
        (err as any).code = 'ENOSPC';
        throw err;
      }
      return origWriteFile.call(fs.promises, targetPath, data, options);
    };

    try {
      await assert.rejects(
        executor.execute({
          kind: 'test.plan1',
          steps: [{
            type: 'writeFile', targetPath: fileA, content: 'mutated-A', encoding: 'utf8',
            expected: { state: 'file', hash: hashContent('initial-A') },
          }],
          result: null,
        }),
        (err: Error) => (err as any).code === 'ENOSPC' || err.message.includes('ENOSPC'),
      );
    } finally {
      (fs.promises as any).writeFile = origWriteFile;
    }

    // Target fileA was never modified
    assert.strictEqual(await fs.promises.readFile(fileA, 'utf8'), 'initial-A');

    // Preparation failure must clean up immediately, not rely on next recover()
    assert.strictEqual(
      fs.existsSync(path.join(tempDir, '.cdt-journal')),
      false,
      'failed preparation must clean up immediately, not rely on next recover()',
    );

    // Subsequent plan2 must succeed without RECOVERY_REQUIRED
    await executor.execute({
      kind: 'test.plan2',
      steps: [{
        type: 'writeFile', targetPath: fileB, content: 'mutated-B', encoding: 'utf8',
        expected: { state: 'file', hash: hashContent('initial-B') },
      }],
      result: null,
    });

    assert.strictEqual(await fs.promises.readFile(fileB, 'utf8'), 'mutated-B');
    assert.strictEqual(fs.existsSync(path.join(tempDir, '.cdt-journal')), false);
  });

  test('Issue #167: failed snapshot copying during preparation cleans up partially written backups immediately', async () => {
    const fileA = path.join(tempDir, 'fileA.xml');
    await fs.promises.writeFile(fileA, 'initial-A', 'utf8');
    const executor = new MutationPlanExecutor(tempDir);

    const origCopyFile = fs.promises.copyFile;
    (fs.promises as any).copyFile = async () => {
      throw new Error('EACCES: copyFile denied during snapshot');
    };

    try {
      await assert.rejects(
        executor.execute({
          kind: 'test.snapshotFailure',
          steps: [{
            type: 'writeFile', targetPath: fileA, content: 'mutated-A', encoding: 'utf8',
            expected: { state: 'file', hash: hashContent('initial-A') },
          }],
          result: null,
        }),
        /EACCES: copyFile denied/,
      );
    } finally {
      (fs.promises as any).copyFile = origCopyFile;
    }

    assert.strictEqual(await fs.promises.readFile(fileA, 'utf8'), 'initial-A');
    assert.strictEqual(
      fs.existsSync(path.join(tempDir, '.cdt-journal')),
      false,
      'snapshot preparation failure must remove operation directory and journal root immediately',
    );
  });

  test('Issue #167: execute() rejects unsafe operationId with path traversal or hidden prefix', async () => {
    const fileA = path.join(tempDir, 'fileA.xml');
    await fs.promises.writeFile(fileA, 'initial-A', 'utf8');
    const executor = new MutationPlanExecutor(tempDir);

    for (const badOpId of ['../escape', 'foo/bar', '.hidden', '..']) {
      await assert.rejects(
        executor.execute(
          {
            kind: 'test.unsafeOpId',
            steps: [{
              type: 'writeFile', targetPath: fileA, content: 'mutated', encoding: 'utf8',
              expected: { state: 'file', hash: hashContent('initial-A') },
            }],
            result: null,
          },
          badOpId,
        ),
        (err: MutationPlanError) => {
          assert.strictEqual(err.code, 'PLAN_CONFLICT');
          return true;
        },
      );
    }
  });

  test('Issue #167: recover() does NOT treat unreadable journal.json as orphan and preserves backups with RECOVERY_REQUIRED', async () => {
    const unreadableOp = path.join(tempDir, '.cdt-journal', 'unreadable-journal-op');
    await fs.promises.mkdir(path.join(unreadableOp, 'backups'), { recursive: true });
    await fs.promises.writeFile(path.join(unreadableOp, 'backups', '0'), 'critical-backup', 'utf8');
    // Create journal.json as a directory so readFile throws EISDIR (non-ENOENT)
    await fs.promises.mkdir(path.join(unreadableOp, 'journal.json'));

    const executor = new MutationPlanExecutor(tempDir);
    await assert.rejects(
      executor.recover(),
      (err: MutationPlanError) => {
        assert.strictEqual(err.code, 'RECOVERY_REQUIRED');
        assert.ok(err.message.includes('unreadable-journal-op'));
        return true;
      },
    );

    assert.ok(
      fs.existsSync(path.join(unreadableOp, 'backups', '0')),
      'Backups must survive when journal read fails with non-ENOENT error',
    );
  });

  test('Issue #167: recover() safely cleans up orphan operation directories without journal.json', async () => {
    const orphanOp = path.join(tempDir, '.cdt-journal', 'orphan-op-1');
    await fs.promises.mkdir(path.join(orphanOp, 'backups'), { recursive: true });
    await fs.promises.writeFile(path.join(orphanOp, '.journal-abandoned.tmp'), '{"partial":true}', 'utf8');

    const fileB = path.join(tempDir, 'fileB.xml');
    await fs.promises.writeFile(fileB, 'initial-B', 'utf8');

    const executor = new MutationPlanExecutor(tempDir);
    // recover() must not throw RECOVERY_REQUIRED due to missing journal.json
    await executor.recover();

    assert.strictEqual(fs.existsSync(path.join(tempDir, '.cdt-journal')), false);

    // After recover(), plans can execute normally
    await executor.execute({
      kind: 'test.plan2',
      steps: [{
        type: 'writeFile', targetPath: fileB, content: 'mutated-B', encoding: 'utf8',
        expected: { state: 'file', hash: hashContent('initial-B') },
      }],
      result: null,
    });
    assert.strictEqual(await fs.promises.readFile(fileB, 'utf8'), 'mutated-B');
  });

  test('Issue #167: recover() cleans up orphan directory while still rolling back valid interrupted journal', async () => {
    const targetA = path.join(tempDir, 'fileA.xml');
    const targetB = path.join(tempDir, 'fileB.xml');
    await fs.promises.writeFile(targetA, 'interrupted-effect', 'utf8');
    await fs.promises.writeFile(targetB, 'initial-B', 'utf8');

    // 1. Orphan operation folder with no journal.json
    const orphanOp = path.join(tempDir, '.cdt-journal', 'orphan-op-empty');
    await fs.promises.mkdir(path.join(orphanOp, 'backups'), { recursive: true });

    // 2. Real interrupted operation folder with valid journal.json
    const interruptedOp = path.join(tempDir, '.cdt-journal', 'real-interrupted');
    await fs.promises.mkdir(path.join(interruptedOp, 'backups'), { recursive: true });
    await fs.promises.writeFile(path.join(interruptedOp, 'backups', '0'), 'original-A', 'utf8');
    await fs.promises.writeFile(path.join(interruptedOp, 'journal.json'), JSON.stringify({
      version: 1,
      operationId: 'real-interrupted',
      plan: { kind: 'test.interrupted', steps: [], result: null },
      state: 'applying',
      appliedSteps: 1,
      snapshots: [{
        targetPath: targetA,
        state: 'file',
        hash: hashContent('original-A'),
        backupName: '0',
        contentsBackedUp: true,
      }],
    }), 'utf8');

    const executor = new MutationPlanExecutor(tempDir);
    await executor.recover();

    // targetA rolled back to original
    assert.strictEqual(await fs.promises.readFile(targetA, 'utf8'), 'original-A');
    // .cdt-journal fully cleaned up
    assert.strictEqual(fs.existsSync(path.join(tempDir, '.cdt-journal')), false);
  });

  test('Issue #167: recover() still throws RECOVERY_REQUIRED if journal.json is corrupt', async () => {
    const corruptOp = path.join(tempDir, '.cdt-journal', 'corrupt-op');
    await fs.promises.mkdir(corruptOp, { recursive: true });
    await fs.promises.writeFile(path.join(corruptOp, 'journal.json'), '{corrupt-json', 'utf8');

    const executor = new MutationPlanExecutor(tempDir);
    await assert.rejects(
      executor.recover(),
      (err: MutationPlanError) => {
        assert.strictEqual(err.code, 'RECOVERY_REQUIRED');
        assert.ok(err.message.includes('corrupt-op'));
        return true;
      },
    );
  });

  test('Issue #167: recover() fails-closed with PLAN_CONFLICT and preserves backups when pre-effect operation has active owner PID', async () => {
    const activeOp = path.join(tempDir, '.cdt-journal', 'active-snapshotting-op');
    await fs.promises.mkdir(path.join(activeOp, 'backups'), { recursive: true });
    await fs.promises.writeFile(path.join(activeOp, 'backups', '0'), 'precious-backup-data', 'utf8');
    await fs.promises.writeFile(
      path.join(activeOp, 'owner.json'),
      JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
      'utf8',
    );

    const executor = new MutationPlanExecutor(tempDir);
    await assert.rejects(
      executor.recover(),
      (err: MutationPlanError) => {
        assert.strictEqual(err.code, 'PLAN_CONFLICT');
        assert.ok(err.message.includes('active-snapshotting-op'));
        assert.ok(err.message.includes(String(process.pid)));
        return true;
      },
    );

    // Fail-closed guarantee: operation directory and backups must NOT be deleted while process is alive
    assert.strictEqual(fs.existsSync(activeOp), true, 'active operation directory must be preserved');
    assert.strictEqual(
      await fs.promises.readFile(path.join(activeOp, 'backups', '0'), 'utf8'),
      'precious-backup-data',
      'backups must not be deleted while owner process is alive',
    );
  });

  test('Issue #167: recover() fails-closed with PLAN_CONFLICT when in-progress journal has active owner PID', async () => {
    const targetFile = path.join(tempDir, 'active-target.xml');
    await fs.promises.writeFile(targetFile, 'current-in-flight-content', 'utf8');

    const activeOp = path.join(tempDir, '.cdt-journal', 'active-applying-op');
    await fs.promises.mkdir(path.join(activeOp, 'backups'), { recursive: true });
    await fs.promises.writeFile(path.join(activeOp, 'backups', '0'), 'initial-content', 'utf8');
    await fs.promises.writeFile(
      path.join(activeOp, 'owner.json'),
      JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
      'utf8',
    );
    await fs.promises.writeFile(
      path.join(activeOp, 'journal.json'),
      JSON.stringify({
        version: 1,
        operationId: 'active-applying-op',
        plan: { kind: 'test.activePlan', steps: [], result: null },
        state: 'applying',
        appliedSteps: 1,
        snapshots: [{
          targetPath: targetFile,
          state: 'file',
          hash: hashContent('initial-content'),
          backupName: '0',
          contentsBackedUp: true,
        }],
      }),
      'utf8',
    );

    const executor = new MutationPlanExecutor(tempDir);
    await assert.rejects(
      executor.recover(),
      (err: MutationPlanError) => {
        assert.strictEqual(err.code, 'PLAN_CONFLICT');
        assert.ok(err.message.includes('active-applying-op'));
        assert.ok(err.message.includes(String(process.pid)));
        return true;
      },
    );

    // Operation directory and in-flight file must NOT be rolled back or deleted while process is alive
    assert.strictEqual(fs.existsSync(activeOp), true);
    assert.strictEqual(await fs.promises.readFile(targetFile, 'utf8'), 'current-in-flight-content');
  });

  test('Issue #167: recover() safely cleans up orphan directory without journal.json when owner process is terminated', async () => {
    const deadOp = path.join(tempDir, '.cdt-journal', 'terminated-orphan-op');
    await fs.promises.mkdir(path.join(deadOp, 'backups'), { recursive: true });
    await fs.promises.writeFile(path.join(deadOp, 'backups', '0'), 'abandoned-backup', 'utf8');
    await fs.promises.writeFile(
      path.join(deadOp, 'owner.json'),
      JSON.stringify({ pid: 999999, createdAt: Date.now() - 60000 }),
      'utf8',
    );

    const executor = new MutationPlanExecutor(tempDir);
    await executor.recover();

    assert.strictEqual(fs.existsSync(deadOp), false);
    assert.strictEqual(fs.existsSync(path.join(tempDir, '.cdt-journal')), false);
  });

  test('Issue #167: execute() writes owner.json with process PID before capturing snapshots and applying plan', async () => {
    const fileA = path.join(tempDir, 'fileA.xml');
    await fs.promises.writeFile(fileA, 'initial-A', 'utf8');
    const executor = new MutationPlanExecutor(tempDir);

    let observedOwnerPid: number | undefined;
    const origCopyFile = fs.promises.copyFile;
    (fs.promises as any).copyFile = async (src: any, dest: any) => {
      // While copying snapshots during preparation, verify owner.json is already present on disk
      const journalDir = path.dirname(path.dirname(dest));
      const ownerPath = path.join(journalDir, 'owner.json');
      if (fs.existsSync(ownerPath)) {
        const raw = await fs.promises.readFile(ownerPath, 'utf8');
        observedOwnerPid = JSON.parse(raw).pid;
      }
      return origCopyFile.call(fs.promises, src, dest);
    };

    try {
      await executor.execute({
        kind: 'test.ownerCheck',
        steps: [{
          type: 'writeFile', targetPath: fileA, content: 'mutated-A', encoding: 'utf8',
          expected: { state: 'file', hash: hashContent('initial-A') },
        }],
        result: 'success',
      });
    } finally {
      (fs.promises as any).copyFile = origCopyFile;
    }

    assert.strictEqual(observedOwnerPid, process.pid, 'owner.json must be written with process.pid prior to copying snapshots');
    assert.strictEqual(await fs.promises.readFile(fileA, 'utf8'), 'mutated-A');
    assert.strictEqual(fs.existsSync(path.join(tempDir, '.cdt-journal')), false, 'journal cleaned up after success');
  });

  test('Issue #167: recover() fails-closed with RECOVERY_REQUIRED if owner.json is corrupt', async () => {
    const corruptOwnerOp = path.join(tempDir, '.cdt-journal', 'corrupt-owner-op');
    await fs.promises.mkdir(path.join(corruptOwnerOp, 'backups'), { recursive: true });
    await fs.promises.writeFile(path.join(corruptOwnerOp, 'backups', '0'), 'precious-backup', 'utf8');
    await fs.promises.writeFile(path.join(corruptOwnerOp, 'owner.json'), '{corrupt-json', 'utf8');

    const executor = new MutationPlanExecutor(tempDir);
    await assert.rejects(
      executor.recover(),
      (err: MutationPlanError) => {
        assert.strictEqual(err.code, 'RECOVERY_REQUIRED');
        assert.ok(err.message.includes('corrupt-owner-op'));
        return true;
      },
    );

    // Fail-closed: backups must survive when owner metadata is corrupt/unreadable
    assert.strictEqual(fs.existsSync(corruptOwnerOp), true);
    assert.strictEqual(fs.existsSync(path.join(corruptOwnerOp, 'backups', '0')), true);
  });

  test('Issue #167: recover() fails-closed with RECOVERY_REQUIRED if owner.json has invalid PID type', async () => {
    const invalidPidOp = path.join(tempDir, '.cdt-journal', 'invalid-pid-op');
    await fs.promises.mkdir(path.join(invalidPidOp, 'backups'), { recursive: true });
    await fs.promises.writeFile(path.join(invalidPidOp, 'backups', '0'), 'precious-backup', 'utf8');
    await fs.promises.writeFile(path.join(invalidPidOp, 'owner.json'), JSON.stringify({ pid: 'not-a-number' }), 'utf8');

    const executor = new MutationPlanExecutor(tempDir);
    await assert.rejects(
      executor.recover(),
      (err: MutationPlanError) => {
        assert.strictEqual(err.code, 'RECOVERY_REQUIRED');
        assert.ok(err.message.includes('invalid-pid-op'));
        return true;
      },
    );

    assert.strictEqual(fs.existsSync(invalidPidOp), true);
    assert.strictEqual(fs.existsSync(path.join(invalidPidOp, 'backups', '0')), true);
  });

  test('Issue #167: recover() stops with PLAN_CONFLICT when encountering active owner alongside terminated orphan', async () => {
    const terminatedOp = path.join(tempDir, '.cdt-journal', '01-terminated-op');
    await fs.promises.mkdir(path.join(terminatedOp, 'backups'), { recursive: true });
    await fs.promises.writeFile(path.join(terminatedOp, 'backups', '0'), 'stale-backup', 'utf8');
    await fs.promises.writeFile(path.join(terminatedOp, 'owner.json'), JSON.stringify({ pid: 999999, createdAt: 100 }), 'utf8');

    const activeOp = path.join(tempDir, '.cdt-journal', '02-active-op');
    await fs.promises.mkdir(path.join(activeOp, 'backups'), { recursive: true });
    await fs.promises.writeFile(path.join(activeOp, 'backups', '0'), 'active-backup', 'utf8');
    await fs.promises.writeFile(path.join(activeOp, 'owner.json'), JSON.stringify({ pid: process.pid, createdAt: 200 }), 'utf8');

    const executor = new MutationPlanExecutor(tempDir);
    await assert.rejects(
      executor.recover(),
      (err: MutationPlanError) => {
        assert.strictEqual(err.code, 'PLAN_CONFLICT');
        assert.ok(err.message.includes('02-active-op'));
        return true;
      },
    );

    assert.strictEqual(fs.existsSync(activeOp), true);
    assert.strictEqual(fs.existsSync(path.join(activeOp, 'backups', '0')), true);
  });

  test('Issue #167: recover() cleans up committed journal even if owner process PID is alive and unblocks next plan', async () => {
    const fileA = path.join(tempDir, 'fileA.xml');
    await fs.promises.writeFile(fileA, 'committed-content', 'utf8');

    const committedOp = path.join(tempDir, '.cdt-journal', 'committed-op-alive-pid');
    await fs.promises.mkdir(committedOp, { recursive: true });
    await fs.promises.writeFile(
      path.join(committedOp, 'owner.json'),
      JSON.stringify({ pid: process.pid, createdAt: Date.now() - 5000 }),
      'utf8',
    );
    await fs.promises.writeFile(
      path.join(committedOp, 'journal.json'),
      JSON.stringify({
        version: 1,
        operationId: 'committed-op-alive-pid',
        plan: { kind: 'test.committed', steps: [], result: null },
        state: 'committed',
        appliedSteps: 1,
        snapshots: [],
      }),
      'utf8',
    );

    const executor = new MutationPlanExecutor(tempDir);
    // recover() must NOT throw PLAN_CONFLICT even though process.pid is alive!
    await executor.recover();

    // Committed operation directory must be removed and journal root cleaned up
    assert.strictEqual(fs.existsSync(committedOp), false, 'committed directory must be cleaned up');
    assert.strictEqual(fs.existsSync(path.join(tempDir, '.cdt-journal')), false);

    // Next plan executes cleanly without being blocked
    const fileB = path.join(tempDir, 'fileB.xml');
    await fs.promises.writeFile(fileB, 'initial-B', 'utf8');
    await executor.execute({
      kind: 'test.planB',
      steps: [{
        type: 'writeFile', targetPath: fileB, content: 'mutated-B', encoding: 'utf8',
        expected: { state: 'file', hash: hashContent('initial-B') },
      }],
      result: null,
    });
    assert.strictEqual(await fs.promises.readFile(fileB, 'utf8'), 'mutated-B');
  });

  test('Issue #167: recover() fails-closed with PLAN_CONFLICT on recent staging directory without owner.json', async () => {
    const stagingOp = path.join(tempDir, '.cdt-journal', '.prep-in-flight-tmp');
    await fs.promises.mkdir(stagingOp, { recursive: true });
    // In-flight staging directory created just now, owner.json not yet written

    const executor = new MutationPlanExecutor(tempDir);
    await assert.rejects(
      executor.recover(),
      (err: MutationPlanError) => {
        assert.strictEqual(err.code, 'PLAN_CONFLICT');
        assert.ok(err.message.includes('.prep-in-flight-tmp'));
        return true;
      },
    );

    // Fail-closed: recent staging directory must NOT be deleted while another process might be initializing it
    assert.strictEqual(fs.existsSync(stagingOp), true, 'recent staging directory must be preserved');
  });

  test('Issue #167: executor collision on same operationId does not delete first executor journal/backups on rename failure', async () => {
    const fileA = path.join(tempDir, 'fileA.xml');
    await fs.promises.writeFile(fileA, 'initial-content', 'utf8');
    const sharedOpId = 'collision-op-id';
    const activeOpDir = path.join(tempDir, '.cdt-journal', sharedOpId);
    const executor2 = new MutationPlanExecutor(tempDir);

    const origRename = fs.promises.rename;
    try {
      (fs.promises as any).rename = async (oldPath: string, newPath: string) => {
        if (newPath === activeOpDir) {
          // Simulate Process 1 winning the race and publishing activeOpDir just before Process 2's rename
          await fs.promises.mkdir(path.join(activeOpDir, 'backups'), { recursive: true });
          await fs.promises.writeFile(
            path.join(activeOpDir, 'owner.json'),
            JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
            'utf8',
          );
          await fs.promises.writeFile(
            path.join(activeOpDir, 'journal.json'),
            JSON.stringify({
              version: 1,
              operationId: sharedOpId,
              plan: { kind: 'test.proc1', steps: [], result: null },
              state: 'prepared',
              appliedSteps: 0,
              snapshots: [],
            }),
            'utf8',
          );
          await fs.promises.writeFile(path.join(activeOpDir, 'backups', 'backup-0'), 'precious-backup', 'utf8');

          const err = new Error('EEXIST: file already exists, rename') as NodeJS.ErrnoException;
          err.code = 'EEXIST';
          throw err;
        }
        return origRename(oldPath, newPath);
      };

      // Now executor2 executes with operationId: sharedOpId
      // Both processes passed recoverLocked(), Process 1 published activeOpDir, and Process 2's rename threw EEXIST
      await assert.rejects(
        executor2.execute({
          kind: 'test.proc2',
          steps: [{
            type: 'writeFile', targetPath: fileA, content: 'from-proc2', encoding: 'utf8',
            expected: { state: 'file', hash: hashContent('initial-content') },
          }],
          result: null,
        }, sharedOpId),
        /EEXIST/,
      );

      // CRITICAL ASSERTION:
      // Executor 2's catch block MUST NOT have deleted activeOpDir, journal.json, or precious-backup!
      assert.strictEqual(fs.existsSync(activeOpDir), true, 'activeOpDir must NOT be deleted by failed second executor');
      assert.strictEqual(fs.existsSync(path.join(activeOpDir, 'journal.json')), true, 'journal.json must remain intact');
      assert.strictEqual(fs.existsSync(path.join(activeOpDir, 'backups', 'backup-0')), true, 'backups must remain intact');
    } finally {
      (fs.promises as any).rename = origRename;
    }
  });

  test('Issue #167: persistent cleanup failure on committed operation does not throw or block subsequent plans', async () => {
    const fileA = path.join(tempDir, 'fileA.xml');
    await fs.promises.writeFile(fileA, 'initial-A', 'utf8');

    const committedOp = path.join(tempDir, '.cdt-journal', 'committed-unremovable-op');
    await fs.promises.mkdir(committedOp, { recursive: true });
    await fs.promises.writeFile(
      path.join(committedOp, 'owner.json'),
      JSON.stringify({ pid: process.pid, createdAt: Date.now() - 5000 }),
      'utf8',
    );
    await fs.promises.writeFile(
      path.join(committedOp, 'journal.json'),
      JSON.stringify({
        version: 1,
        operationId: 'committed-unremovable-op',
        plan: { kind: 'test.committed', steps: [], result: null },
        state: 'committed',
        appliedSteps: 1,
        snapshots: [],
      }),
      'utf8',
    );

    const origRm = fs.promises.rm;
    try {
      (fs.promises as any).rm = async (targetPath: string, opts?: any) => {
        if (targetPath === committedOp) {
          const err = new Error('EBUSY: resource busy or locked, rm') as NodeJS.ErrnoException;
          err.code = 'EBUSY';
          throw err;
        }
        return origRm(targetPath, opts);
      };

      const executor = new MutationPlanExecutor(tempDir);
      // recover() should NOT throw even if removing committedOp fails with EBUSY!
      await executor.recover();

      // Subsequent execute() must succeed without error
      await executor.execute({
        kind: 'test.planSubsequent',
        steps: [{
          type: 'writeFile', targetPath: fileA, content: 'mutated-A', encoding: 'utf8',
          expected: { state: 'file', hash: hashContent('initial-A') },
        }],
        result: 'success',
      });
      assert.strictEqual(await fs.promises.readFile(fileA, 'utf8'), 'mutated-A');
    } finally {
      (fs.promises as any).rm = origRm;
    }
  });
});

