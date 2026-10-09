import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigurationSession } from '../../src/services/configurationSession/ConfigurationSession';
import type { ConfigurationIdentity } from '../../src/services/configurationSession/types';

import { ConfigFormat } from '../../src/parsers/formatDetector';

suite('ConfigurationSession Read/Write Consistency (Issue #214)', () => {
  let tempDir: string;
  let identity: ConfigurationIdentity;

  setup(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cs-consistency-'));
    identity = {
      configurationId: 'test-conf-214' as any,
      rootPath: tempDir,
      rootUri: `file://${tempDir}`,
      descriptorUri: `file://${tempDir}/Configuration.xml`,
      workspaceFolderUris: [`file://${tempDir}`],
      format: ConfigFormat.Designer,
      capabilities: { read: true, write: true, process: true },
    };
  });


  teardown(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  test('runRead executes concurrently with other readers', async () => {
    const session = new ConfigurationSession(identity);
    try {
      let activeReaders = 0;
      let maxConcurrentReaders = 0;

      const makeReader = (delayMs: number) =>
        (session as any).runRead(async () => {
          activeReaders++;
          maxConcurrentReaders = Math.max(maxConcurrentReaders, activeReaders);
          await new Promise((r) => setTimeout(r, delayMs));
          activeReaders--;
          return 'ok';
        });

      const [r1, r2, r3] = await Promise.all([makeReader(30), makeReader(30), makeReader(30)]);

      assert.strictEqual(r1.status, 'ok');
      assert.strictEqual(r2.status, 'ok');
      assert.strictEqual(r3.status, 'ok');
      assert.strictEqual(maxConcurrentReaders, 3, 'All 3 readers should run concurrently');
      assert.strictEqual(session.snapshotVersion, 0, 'Read must not increment snapshotVersion');
    } finally {
      await session.dispose();
    }
  });

  test('queued read waits for active mutation to complete and sees bumped snapshotVersion', async () => {
    const session = new ConfigurationSession(identity);
    try {
      const log: string[] = [];
      let finishMutation!: () => void;
      const mutationGate = new Promise<void>((r) => { finishMutation = r; });

      const mutationPromise = session.enqueue({
        kind: 'write-op',
        execute: async () => {
          log.push('mutation-start');
          await mutationGate;
          log.push('mutation-end');
          return 'mutated';
        },
      });

      // Give event loop tick to ensure mutation starts
      await new Promise((r) => setTimeout(r, 5));

      const readPromise = (session as any).runRead(async (ctx: { snapshotVersion: number }) => {
        log.push(`read-at-v${ctx.snapshotVersion}`);
        return ctx.snapshotVersion;
      });

      // While mutation is pending, read must not have executed yet
      assert.deepStrictEqual(log, ['mutation-start']);

      finishMutation();
      await mutationPromise;
      const readOutcome = await readPromise;

      assert.deepStrictEqual(log, ['mutation-start', 'mutation-end', 'read-at-v1']);
      assert.strictEqual(readOutcome.status, 'ok');
      assert.strictEqual(readOutcome.snapshotVersion, 1);
      assert.strictEqual(session.snapshotVersion, 1);
    } finally {
      await session.dispose();
    }
  });

  test('queued mutation waits for active readers to complete and reader sees pre-mutation version', async () => {
    const session = new ConfigurationSession(identity);
    try {
      const log: string[] = [];
      let finishRead!: () => void;
      const readGate = new Promise<void>((r) => { finishRead = r; });

      const readPromise = (session as any).runRead(async (ctx: { snapshotVersion: number }) => {
        log.push(`read-start-v${ctx.snapshotVersion}`);
        await readGate;
        log.push('read-end');
        return ctx.snapshotVersion;
      });

      await new Promise((r) => setTimeout(r, 5));

      const mutationPromise = session.enqueue({
        kind: 'write-op',
        execute: async () => {
          log.push('mutation-executed');
          return 'done';
        },
      });

      // Mutation must not execute while read is active
      assert.deepStrictEqual(log, ['read-start-v0']);

      finishRead();
      const readOutcome = await readPromise;
      await mutationPromise;

      assert.deepStrictEqual(log, ['read-start-v0', 'read-end', 'mutation-executed']);
      assert.strictEqual(readOutcome.snapshotVersion, 0);
      assert.strictEqual(session.snapshotVersion, 1);
    } finally {
      await session.dispose();
    }
  });

  test('cancelled read returns cancelled status and does not block queued writer', async () => {
    const session = new ConfigurationSession(identity);
    try {
      const readOutcome = await session.runRead(
        async () => 'should-not-run',
        { isCancellationRequested: true },
      );
      assert.strictEqual(readOutcome.status, 'cancelled');

      // Subsequent mutation executes normally
      const mutationOutcome = await session.enqueue({
        kind: 'post-cancel-write',
        execute: async () => 'mutation-ok',
      });
      assert.strictEqual(mutationOutcome.status, 'committed');
      assert.strictEqual(session.snapshotVersion, 1);
    } finally {
      await session.dispose();
    }
  });

  test('error in reader resolves failed status and releases lock for subsequent writer', async () => {
    const session = new ConfigurationSession(identity);
    try {
      const readOutcome = await session.runRead(async () => {
        throw new Error('read-disk-error');
      });
      assert.strictEqual(readOutcome.status, 'failed');
      assert.strictEqual(readOutcome.error?.message, 'read-disk-error');

      // Queue is unblocked and writer succeeds
      const mutationOutcome = await session.enqueue({
        kind: 'write-after-read-fail',
        execute: async () => 'write-success',
      });
      assert.strictEqual(mutationOutcome.status, 'committed');
      assert.strictEqual(session.snapshotVersion, 1);
    } finally {
      await session.dispose();
    }
  });

  test('dispose cancels queued reads and drains active operations cleanly', async () => {
    const session = new ConfigurationSession(identity);
    let finishRead!: () => void;
    const readGate = new Promise<void>((r) => { finishRead = r; });

    const activeRead = session.runRead(async () => {
      await readGate;
      return 'active-done';
    });

    // Wait for activeRead to begin execution
    await new Promise((r) => setTimeout(r, 5));

    // Queue a writer and a second read
    const queuedWrite = session.enqueue({
      kind: 'blocked-write',
      execute: async () => 'write-done',
    });
    const queuedRead = session.runRead(async () => 'queued-never');

    const disposePromise = session.dispose();
    finishRead();

    const [activeOutcome, writeOutcome, queuedOutcome] = await Promise.all([
      activeRead,
      queuedWrite,
      queuedRead,
    ]);
    await disposePromise;

    assert.strictEqual(activeOutcome.status, 'ok');
    assert.strictEqual(writeOutcome.status, 'cancelled');
    assert.strictEqual(queuedOutcome.status, 'cancelled');
  });
});


