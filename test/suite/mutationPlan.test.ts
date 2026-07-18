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
    await fs.promises.rm(tempDir, { recursive: true, force: true });
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
});
