import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { ConfigurationId } from '../../src/services/configurationSession/types';
import {
  SupportRunJournal,
  SupportRunJournalError,
  type SupportRunJournalFileSystem,
} from '../../src/support/supportRunJournal';
import type { TargetGenerationRef } from '../../src/support/supportTypes';

suite('SupportRunJournal', () => {
  let root: string;
  let journalPath: string;

  setup(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'support-journal-test-'));
    journalPath = path.join(root, 'journal.json');
  });

  teardown(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test('enforces legal transitions and survives terminal restart', async () => {
    const journal = new SupportRunJournal(journalPath);
    await journal.begin(header(), [targetRef()]);
    await assert.rejects(
      journal.transition(configurationId(), 'run-1', {
        ...targetRef(),
        state: 'applied',
        acknowledgedGenerationId: generation(),
        evidence: 'configuratorAck',
      }),
      (error: unknown) =>
        error instanceof SupportRunJournalError && error.code === 'SUPPORT_JOURNAL_CONFLICT',
    );
    await journal.transition(configurationId(), 'run-1', {
      ...targetRef(),
      state: 'preparing',
      startedAt: '2026-01-01T00:00:00.000Z',
    });
    await journal.transition(configurationId(), 'run-1', {
      ...targetRef(),
      state: 'applying',
      startedAt: '2026-01-01T00:00:01.000Z',
    });
    const applied = {
      ...targetRef(),
      state: 'applied' as const,
      acknowledgedGenerationId: generation(),
      evidence: 'configuratorAck' as const,
    };
    await journal.transition(configurationId(), 'run-1', applied);
    await journal.complete({
      ...header(),
      scope: 'replicated',
      state: 'complete',
      targets: [applied],
    });

    assert.strictEqual((await journal.getLastRun(configurationId()))?.state, 'complete');
    const restarted = new SupportRunJournal(journalPath);
    const persisted = await restarted.getLastRun(configurationId());
    assert.strictEqual(persisted?.runId, 'run-1');
    assert.strictEqual(persisted?.targets[0]?.state, 'applied');
    assert.strictEqual(await restarted.getActiveRun(configurationId()), undefined);
  });

  test('restart normalizes an active run to a durable interrupted terminal run', async () => {
    const first = new SupportRunJournal(journalPath);
    await first.begin(header(), [targetRef()]);
    await first.transition(configurationId(), 'run-1', {
      ...targetRef(),
      state: 'preparing',
      startedAt: '2026-01-01T00:00:00.000Z',
    });

    const restarted = new SupportRunJournal(journalPath);
    const terminal = await restarted.getLastRun(configurationId());
    assert.ok(terminal);
    assert.strictEqual(terminal!.state, 'cancelled');
    assert.strictEqual(terminal!.targets[0]?.state, 'skipped');
    if (terminal!.targets[0]?.state === 'skipped') {
      assert.strictEqual(terminal!.targets[0].reason, 'cancelled');
    }
    assert.strictEqual(await restarted.getActiveRun(configurationId()), undefined);

    const secondRestart = new SupportRunJournal(journalPath);
    assert.strictEqual((await secondRestart.getLastRun(configurationId()))?.state, 'cancelled');
  });

  test('rename failure does not publish or mutate in-memory run state', async () => {
    const memory = new MemoryJournalFs();
    memory.renameError = new Error('rename failed');
    const journal = new SupportRunJournal('C:/journal/journal.json', {
      fileSystem: memory,
      createTemporaryId: () => 'tmp',
    });
    await assert.rejects(journal.begin(header(), [targetRef()]), /rename failed/);
    memory.renameError = undefined;
    assert.strictEqual(await journal.getActiveRun(configurationId()), undefined);
  });

  test('proven rename with failed directory barrier reports limitation but retains committed state', async () => {
    const memory = new MemoryJournalFs();
    memory.syncError = new Error('directory fsync unavailable');
    const journal = new SupportRunJournal('C:/journal/journal.json', {
      fileSystem: memory,
      createTemporaryId: () => 'tmp',
    });
    await assert.rejects(
      journal.begin(header(), [targetRef()]),
      (error: unknown) =>
        error instanceof SupportRunJournalError
        && error.code === 'SUPPORT_JOURNAL_DURABILITY_BARRIER_FAILED',
    );
    assert.strictEqual((await journal.getActiveRun(configurationId()))?.runId, 'run-1');
  });
});

function configurationId(): ConfigurationId {
  return 'cfg-journal' as ConfigurationId;
}

function generation(): string {
  return 'generation-1';
}

function header() {
  return {
    runId: 'run-1',
    configurationId: configurationId(),
    desiredGenerationId: generation(),
    operation: 'sync' as const,
  };
}

function targetRef(): TargetGenerationRef {
  return {
    canonicalTargetId: 'file:c:/db/base.1cd',
    infobaseIds: ['ib-1'],
    desiredGenerationId: generation(),
  };
}

class MemoryJournalFs implements SupportRunJournalFileSystem {
  readonly files = new Map<string, string>();
  renameError: Error | undefined;
  syncError: Error | undefined;

  async readFile(filePath: string): Promise<string> {
    const value = this.files.get(filePath);
    if (value === undefined) {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    }
    return value;
  }

  async mkdir(): Promise<void> {}

  async writeNewFile(filePath: string, contents: string): Promise<void> {
    if (this.files.has(filePath)) {
      throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    }
    this.files.set(filePath, contents);
  }

  async rename(sourcePath: string, targetPath: string): Promise<void> {
    if (this.renameError) {
      throw this.renameError;
    }
    const value = await this.readFile(sourcePath);
    this.files.set(targetPath, value);
    this.files.delete(sourcePath);
  }

  async remove(filePath: string): Promise<void> {
    this.files.delete(filePath);
  }

  async syncDirectory(): Promise<void> {
    if (this.syncError) {
      throw this.syncError;
    }
  }
}
