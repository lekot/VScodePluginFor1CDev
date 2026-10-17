import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runAgentMutation, mutationFailure, type AgentOperationsContext } from '../../src/agent/agentOperationsShared';
import { calculateRevision } from '../../src/agent/agentRevision';
import { MutationReceiptError } from '../../src/services/configurationSession/mutationReceiptError';
import type { AgentResult, MutationOptions, MutationResultData } from '../../src/agent/types';

type MutationRunnerContext = Pick<AgentOperationsContext, 'withTargetMutationLock' | 'checkMutationPreconditions'>;

function makeContext(options?: {
  currentRev?: string;
  errorResult?: AgentResult<MutationResultData>;
  events?: string[];
  receivedOptions?: MutationOptions;
}): MutationRunnerContext {
  const currentRev = options?.currentRev ?? 'a'.repeat(64);
  return {
    async withTargetMutationLock<T>(targetPath: string, action: () => Promise<AgentResult<T>>): Promise<AgentResult<T>> {
      options?.events?.push(`lock:${targetPath}`);
      try {
        return await action();
      } finally {
        options?.events?.push('release');
      }
    },
    async checkMutationPreconditions<T = MutationResultData>(
      filePath: string,
      target: string,
      mutationOptions?: MutationOptions,
    ): Promise<{ proceed: boolean; errorResult?: AgentResult<T>; currentRev: string }> {
      options?.events?.push(`precondition:${filePath}:${target}`);
      if (options?.receivedOptions) {
        Object.assign(options.receivedOptions, mutationOptions);
      }
      return options?.errorResult
        ? { proceed: false, errorResult: options.errorResult as AgentResult<T>, currentRev }
        : { proceed: true, currentRev };
    },
  };
}

suite('Agent mutation runner', () => {
  let tempDir: string;

  setup(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-mutation-runner-'));
  });

  teardown(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  test('dryRun preserves the receipt shape and skips apply under one shared lock', async () => {
    const filePath = path.join(tempDir, 'Catalog.xml');
    await fs.promises.writeFile(filePath, '<Catalog/>', 'utf8');
    const events: string[] = [];
    const receivedOptions: MutationOptions = {};
    let applyCalled = false;
    const result = await runAgentMutation(makeContext({ events, receivedOptions }), {
      filePath,
      target: 'Catalog.Items',
      options: { dryRun: true, ifRev: 'a'.repeat(64) },
      plannedChanges: { files: [filePath], summary: 'Добавление реквизита Code в Catalog.Items' },
      prepare: () => {
        events.push('prepare');
        return 'prepared';
      },
      apply: async () => {
        applyCalled = true;
      },
    });

    const expectedRev = 'a'.repeat(64);
    assert.deepStrictEqual(result, {
      success: true,
      dryRun: true,
      rev: expectedRev,
      target: 'Catalog.Items',
      data: {
        dryRun: true,
        rev: expectedRev,
        target: 'Catalog.Items',
        plannedChanges: { files: [filePath], summary: 'Добавление реквизита Code в Catalog.Items' },
      },
    });
    assert.deepStrictEqual(events, [
      `lock:${filePath}`,
      `precondition:${filePath}:Catalog.Items`,
      'prepare',
      'release',
    ]);
    assert.strictEqual(receivedOptions.dryRun, true);
    assert.strictEqual(receivedOptions.ifRev, 'a'.repeat(64));
    assert.strictEqual(applyCalled, false);
    assert.strictEqual(await fs.promises.readFile(filePath, 'utf8'), '<Catalog/>');
  });

  test('live mutation returns the exact target and the revision of bytes written by apply', async () => {
    const filePath = path.join(tempDir, 'Catalog.xml');
    await fs.promises.writeFile(filePath, '<Catalog/>', 'utf8');
    const events: string[] = [];
    const result = await runAgentMutation(makeContext({ events }), {
      filePath,
      target: 'Catalog.Items',
      plannedChanges: { files: [filePath], summary: 'unused for live mutation' },
      apply: async () => {
        events.push('apply');
        await fs.promises.writeFile(filePath, '<Catalog><Attribute>Code</Attribute></Catalog>', 'utf8');
      },
    });

    const expectedRev = await calculateRevision(filePath);
    assert.deepStrictEqual(result, {
      success: true,
      rev: expectedRev,
      target: 'Catalog.Items',
      data: { rev: expectedRev, target: 'Catalog.Items' },
    });
    assert.deepStrictEqual(events, [
      `lock:${filePath}`,
      `precondition:${filePath}:Catalog.Items`,
      'apply',
      'release',
    ]);
  });

  test('precondition rejection returns the original typed result and skips preparation and apply', async () => {
    const filePath = path.join(tempDir, 'Catalog.xml');
    const errorResult: AgentResult<MutationResultData> = {
      success: false,
      code: 'CONCURRENT_MODIFICATION_ERROR',
      error: 'Объект Catalog.Items изменился после получения ревизии; запись отменена.',
      currentRev: 'b'.repeat(64),
      target: 'Catalog.Items',
      data: { target: 'Catalog.Items', currentRev: 'b'.repeat(64) },
    };
    let prepareCalled = false;
    let applyCalled = false;
    const result = await runAgentMutation(makeContext({ errorResult }), {
      filePath,
      target: 'Catalog.Items',
      plannedChanges: { files: [filePath], summary: 'unused after rejection' },
      prepare: () => {
        prepareCalled = true;
      },
      apply: async () => {
        applyCalled = true;
      },
    });

    assert.strictEqual(result, errorResult);
    assert.strictEqual(prepareCalled, false);
    assert.strictEqual(applyCalled, false);
  });

  test('apply and revision failures propagate typed mutation receipts to the existing projection boundary', async () => {
    const filePath = path.join(tempDir, 'Catalog.xml');
    await fs.promises.writeFile(filePath, '<Catalog/>', 'utf8');
    const makeReceiptError = () => new MutationReceiptError({
      status: 'rolledBack',
      kind: 'agent.test',
      resourcePath: filePath,
      code: 'TEST_MUTATION_ROLLED_BACK',
      message: 'The mutation was rolled back.',
    });

    const applyFailure = makeReceiptError();
    await assert.rejects(
      runAgentMutation(makeContext(), {
        filePath,
        target: 'Catalog.Items',
        plannedChanges: { files: [filePath], summary: 'unused after apply failure' },
        apply: async () => { throw applyFailure; },
      }),
      (error: unknown) => error === applyFailure,
    );
    assert.strictEqual(mutationFailure(applyFailure).code, 'TEST_MUTATION_ROLLED_BACK');

    const revisionFailure = makeReceiptError();
    const originalReadFile = fs.promises.readFile;
    try {
      (fs.promises as unknown as { readFile: typeof fs.promises.readFile }).readFile = async () => {
        throw revisionFailure;
      };
      await assert.rejects(
        runAgentMutation(makeContext(), {
          filePath,
          target: 'Catalog.Items',
          plannedChanges: { files: [filePath], summary: 'unused after revision failure' },
          apply: async () => {},
        }),
        (error: unknown) => error === revisionFailure,
      );
    } finally {
      (fs.promises as unknown as { readFile: typeof fs.promises.readFile }).readFile = originalReadFile;
    }
    assert.strictEqual(mutationFailure(revisionFailure).code, 'TEST_MUTATION_ROLLED_BACK');
  });
});
