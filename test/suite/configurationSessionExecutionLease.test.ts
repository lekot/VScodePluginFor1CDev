import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { MetadataType, type TreeNode } from '../../src/models/treeNode';
import {
  ConfigurationSession,
  ConfigurationSessionWriteFromReadError,
  type MutationRequest,
} from '../../src/services/configurationSession/ConfigurationSession';
import type { ReconciliationOutcome } from '../../src/types/reloadContracts';
import { hashContent } from '../../src/services/configurationSession/atomicFileStorage';
import {
  configureConfigurationMutationGateway,
  runConfigurationMutation,
  runConfigurationPlan,
} from '../../src/services/configurationSession/configurationMutationGateway';
import { MutationPlanError, type MutationPlan } from '../../src/services/configurationSession/mutationPlan';
import { WorkspaceRegistry } from '../../src/services/configurationSession/WorkspaceRegistry';
import { planDuplicateRootElement, planRenameRootElement } from '../../src/services/elementOperations';
import { planCreateMetadataObject, planDeleteMetadataObject } from '../../src/services/metadataCrudService';
import { cleanupTempDir, createTempDir } from '../helpers/testHelpers';
import { Logger } from '../../src/utils/logger';

interface ConfigurationFixture {
  readonly root: string;
  readonly registry: WorkspaceRegistry;
  readonly session: ConfigurationSession;
  dispose(): Promise<void>;
}

async function createConfigurationFixture(prefix: string): Promise<ConfigurationFixture> {
  const tempPath = await createTempDir(prefix);
  const root = await fs.promises.realpath(tempPath);
  await fs.promises.writeFile(path.join(root, 'Configuration.xml'),
    '<?xml version="1.0" encoding="UTF-8"?><MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Configuration uuid="11111111-1111-4111-8111-111111111111"><Properties><Name>LeaseTest</Name></Properties><ChildObjects/></Configuration></MetaDataObject>',
    'utf8');
  const registry = new WorkspaceRegistry();
  const session = await registry.registerTargetedRoot({ configPath: root });
  return {
    root,
    registry,
    session,
    dispose: async () => {
      await registry.dispose();
      await cleanupTempDir(tempPath);
    },
  };
}

function writePlan(targetPath: string, content: string, expected: { state: 'missing' } | { state: 'file'; hash: string }): MutationPlan<string> {
  return {
    kind: 'lease.test.write',
    steps: [{ type: 'writeFile', targetPath, content, encoding: 'utf8', expected }],
    result: targetPath,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function mustSettle<T>(operation: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 1000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

suite('ConfigurationSession scoped execution lease', () => {
  test('runs reconciliation after releasing the writer and preserves a committed receipt when reload fails', async () => {
    const fixture = await createConfigurationFixture('configuration-session-post-commit-');
    const commits: Array<{
      configurationId: string;
      rootPath: string;
      operationId: string;
      snapshotVersion: number;
      kind: string;
    }> = [];
    let callbackReadStatus: string | undefined;
    let session!: ConfigurationSession;
    const ObserverAwareSession = ConfigurationSession as unknown as new (
      identity: ConfigurationSession['identity'],
      observer: (commit: typeof commits[number]) => Promise<ReconciliationOutcome>,
    ) => ConfigurationSession;
    session = new ObserverAwareSession(fixture.session.identity, async (commit) => {
      commits.push(commit);
      const internals = session as unknown as { runningWriters: number };
      assert.strictEqual(internals.runningWriters, 0, 'the observer must run after the writer lease is released');
      const read = await session.runRead(async () => 'read-after-commit');
      callbackReadStatus = read.status;
      return { status: 'failed', code: 'RELOAD_TIMEOUT', message: 'Reload timed out.' };
    });

    try {
      const outcome = await session.enqueue({
        kind: 'test.committed-write',
        operationId: 'post-commit-operation',
        execute: async () => 'written',
      });

      assert.strictEqual(outcome.status, 'committed');
      assert.strictEqual(outcome.value, 'written');
      assert.deepStrictEqual(outcome.reconciliation, {
        status: 'failed',
        code: 'RELOAD_TIMEOUT',
        message: 'Reload timed out.',
      });
      assert.strictEqual(callbackReadStatus, 'ok', 'a reload-triggered session read must not deadlock');
      assert.deepStrictEqual(commits, [{
        configurationId: session.identity.configurationId,
        rootPath: fixture.root,
        operationId: 'post-commit-operation',
        snapshotVersion: 1,
        kind: 'test.committed-write',
      }]);
    } finally {
      await session.dispose();
      await fixture.dispose();
    }
  });

  test('settles a committed receipt when reconciliation returns failed and diagnostic logging throws', async () => {
    const fixture = await createConfigurationFixture('configuration-session-reconcile-log-failure-');
    const ObserverAwareSession = ConfigurationSession as unknown as new (
      identity: ConfigurationSession['identity'],
      observer: () => Promise<ReconciliationOutcome>,
    ) => ConfigurationSession;
    const session = new ObserverAwareSession(fixture.session.identity, async () => ({
      status: 'failed',
      code: 'RELOAD_FAILED',
      message: 'Reload failed after the file was saved.',
    }));
    const originalWarn = Logger.warn;
    Logger.warn = () => { throw new Error('diagnostic output channel failed'); };

    try {
      const savedPath = path.join(fixture.root, 'committed-before-reload.txt');
      const outcome = await mustSettle(session.enqueue({
        kind: 'test.committed-write',
        execute: async () => {
          await fs.promises.writeFile(savedPath, 'saved', 'utf8');
          return 'saved';
        },
      }), 'The committed receipt must settle when reconciliation logging fails.');

      assert.strictEqual(outcome.status, 'committed');
      assert.strictEqual(outcome.value, 'saved');
      assert.deepStrictEqual(outcome.reconciliation, {
        status: 'failed',
        code: 'RELOAD_FAILED',
        message: 'Reload failed after the file was saved.',
      });
      assert.strictEqual(session.snapshotVersion, 1);
      assert.strictEqual(await fs.promises.readFile(savedPath, 'utf8'), 'saved');
    } finally {
      Logger.warn = originalWarn;
      await mustSettle(session.dispose(), 'Disposing the session must release the post-commit observer count.');
      await fixture.dispose();
    }
  });

  test('settles a committed receipt when the observer throws and diagnostic logging throws', async () => {
    const fixture = await createConfigurationFixture('configuration-session-observer-throw-log-failure-');
    const ObserverAwareSession = ConfigurationSession as unknown as new (
      identity: ConfigurationSession['identity'],
      observer: () => Promise<ReconciliationOutcome>,
    ) => ConfigurationSession;
    const session = new ObserverAwareSession(fixture.session.identity, async () => {
      throw Object.assign(new Error('Reload rejected after the file was saved.'), { code: 'RELOAD_REJECTED' });
    });
    const originalWarn = Logger.warn;
    Logger.warn = () => { throw new Error('diagnostic output channel failed'); };

    try {
      const outcome = await mustSettle(session.enqueue({
        kind: 'test.committed-write',
        execute: async () => 'saved',
      }), 'The committed receipt must settle when observer and diagnostic logging fail.');

      assert.strictEqual(outcome.status, 'committed');
      assert.strictEqual(outcome.value, 'saved');
      assert.deepStrictEqual(outcome.reconciliation, {
        status: 'failed',
        code: 'RELOAD_REJECTED',
        message: 'Reload rejected after the file was saved.',
      });
      assert.strictEqual(session.snapshotVersion, 1);
    } finally {
      Logger.warn = originalWarn;
      await mustSettle(session.dispose(), 'Disposing the session must release the post-commit observer count.');
      await fixture.dispose();
    }
  });

  test('settles a committed receipt when the reconciliation predicate throws during diagnostic logging', async () => {
    const fixture = await createConfigurationFixture('configuration-session-predicate-log-failure-');
    let observerCalls = 0;
    const ObserverAwareSession = ConfigurationSession as unknown as new (
      identity: ConfigurationSession['identity'],
      observer: () => Promise<ReconciliationOutcome>,
    ) => ConfigurationSession;
    const session = new ObserverAwareSession(fixture.session.identity, async () => {
      observerCalls++;
      return { status: 'succeeded' };
    });
    const originalWarn = Logger.warn;
    Logger.warn = () => { throw new Error('diagnostic output channel failed'); };

    try {
      const outcome = await mustSettle(session.enqueue({
        kind: 'test.committed-write',
        shouldReconcile: () => { throw new Error('reconciliation predicate failed'); },
        execute: async () => 'saved',
      }), 'The committed receipt must settle when predicate diagnostics fail.');

      assert.strictEqual(outcome.status, 'committed');
      assert.strictEqual(outcome.value, 'saved');
      assert.strictEqual(outcome.reconciliation, undefined);
      assert.strictEqual(session.snapshotVersion, 1);
      assert.strictEqual(observerCalls, 0);
    } finally {
      Logger.warn = originalWarn;
      await mustSettle(session.dispose(), 'Disposing the session must release the post-commit observer count.');
      await fixture.dispose();
    }
  });

  test('preserves an outer committed receipt when a nested predicate and diagnostic logger both throw', async () => {
    const fixture = await createConfigurationFixture('configuration-session-nested-predicate-log-failure-');
    let observerCalls = 0;
    const ObserverAwareSession = ConfigurationSession as unknown as new (
      identity: ConfigurationSession['identity'],
      observer: () => Promise<ReconciliationOutcome>,
    ) => ConfigurationSession;
    const session = new ObserverAwareSession(fixture.session.identity, async () => {
      observerCalls++;
      return { status: 'succeeded' };
    });
    const originalWarn = Logger.warn;
    Logger.warn = () => { throw new Error('diagnostic output channel failed'); };

    try {
      const savedPath = path.join(fixture.root, 'nested-committed-before-reload.txt');
      const outer = await mustSettle(session.enqueue({
        kind: 'test.outer-write',
        execute: async () => {
          const nested = await session.enqueue({
            kind: 'test.nested-write',
            shouldReconcile: () => { throw new Error('nested reconciliation predicate failed'); },
            execute: async () => {
              await fs.promises.writeFile(savedPath, 'saved', 'utf8');
              return 'saved';
            },
          });
          assert.strictEqual(nested.status, 'committed');
          assert.strictEqual(nested.value, 'saved');
          return 'outer-completed';
        },
      }), 'The outer committed receipt must settle when nested predicate diagnostics fail.');

      assert.strictEqual(outer.status, 'committed');
      assert.strictEqual(outer.value, 'outer-completed');
      assert.deepStrictEqual(outer.reconciliation, { status: 'succeeded' });
      assert.strictEqual(await fs.promises.readFile(savedPath, 'utf8'), 'saved');
      assert.strictEqual(observerCalls, 1);
      assert.strictEqual(session.snapshotVersion, 1);
    } finally {
      Logger.warn = originalWarn;
      await mustSettle(session.dispose(), 'Disposing the session must release the post-commit observer count.');
      await fixture.dispose();
    }
  });

  test('an outer write notifies once when a nested plan reuses its writer lease', async () => {
    const fixture = await createConfigurationFixture('configuration-session-nested-reconcile-');
    const commits: Array<{ operationId: string; snapshotVersion: number; kind: string }> = [];
    const ObserverAwareSession = ConfigurationSession as unknown as new (
      identity: ConfigurationSession['identity'],
      observer: (commit: typeof commits[number] & { configurationId: string; rootPath: string }) => Promise<ReconciliationOutcome>,
    ) => ConfigurationSession;
    const session = new ObserverAwareSession(fixture.session.identity, async (commit) => {
      commits.push(commit);
      return { status: 'succeeded' };
    });
    try {
      const targetPath = path.join(fixture.root, 'NestedReconciliation.txt');
      const outcome = await session.enqueue({
        kind: 'test.outer-write',
        operationId: 'outer-reconciliation-operation',
        execute: async () => session.runPlanValue(writePlan(targetPath, 'nested', { state: 'missing' }), {
          operationId: 'inner-plan-operation',
        }),
      });

      assert.strictEqual(outcome.status, 'committed');
      assert.strictEqual(outcome.snapshotVersion, 1);
      assert.deepStrictEqual(commits, [{
        configurationId: session.identity.configurationId,
        rootPath: fixture.root,
        operationId: 'outer-reconciliation-operation',
        snapshotVersion: 1,
        kind: 'test.outer-write',
      }]);
    } finally {
      await session.dispose();
      await fixture.dispose();
    }
  });

  test('a nested value-only plan reuses the outer operation identity and requests one post-commit reconciliation', async () => {
    const fixture = await createConfigurationFixture('configuration-session-nested-value-reconcile-');
    const commits: Array<{ operationId: string; snapshotVersion: number; kind: string }> = [];
    const ObserverAwareSession = ConfigurationSession as unknown as new (
      identity: ConfigurationSession['identity'],
      observer: (commit: { configurationId: string; rootPath: string; operationId: string; snapshotVersion: number; kind: string }) => Promise<ReconciliationOutcome>,
    ) => ConfigurationSession;
    const session = new ObserverAwareSession(fixture.session.identity, async (commit) => {
      commits.push({ operationId: commit.operationId, snapshotVersion: commit.snapshotVersion, kind: commit.kind });
      return { status: 'succeeded' };
    });
    try {
      const targetPath = path.join(fixture.root, 'NestedValueReconciliation.txt');
      const outcome = await session.enqueue({
        kind: 'test.outer-value-write',
        operationId: 'outer-value-operation',
        execute: async () => session.runPlanValue(writePlan(targetPath, 'nested value write', { state: 'missing' }), {
          operationId: 'inner-value-operation',
        }),
      });

      assert.strictEqual(outcome.status, 'committed');
      assert.strictEqual(outcome.value, targetPath);
      assert.deepStrictEqual(commits, [{
        operationId: 'outer-value-operation',
        snapshotVersion: 1,
        kind: 'test.outer-value-write',
      }]);
      assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'nested value write');
    } finally {
      await session.dispose();
      await fixture.dispose();
    }
  });

  test('a commit observer keeps the operation identity captured before a later session replacement', async () => {
    const fixture = await createConfigurationFixture('configuration-session-identity-reconcile-');
    const observerStarted = deferred<{
      configurationId: string;
      rootPath: string;
      operationId: string;
      snapshotVersion: number;
      kind: string;
    }>();
    const finishObserver = deferred<ReconciliationOutcome>();
    const ObserverAwareSession = ConfigurationSession as unknown as new (
      identity: ConfigurationSession['identity'],
      observer: (commit: Parameters<typeof observerStarted.resolve>[0]) => Promise<ReconciliationOutcome>,
    ) => ConfigurationSession;
    const session = new ObserverAwareSession(fixture.session.identity, async (commit) => {
      observerStarted.resolve(commit);
      return finishObserver.promise;
    });

    try {
      const write = session.enqueue({
        kind: 'test.identity-replacement-write',
        operationId: 'identity-replacement-operation',
        execute: async () => 'written',
      });
      const captured = await observerStarted.promise;
      const replacementRoot = path.join(fixture.root, 'replacement-root');
      session.updateIdentity({
        ...session.identity,
        rootPath: replacementRoot,
        rootUri: `file:///${replacementRoot.replace(/\\/g, '/')}`,
      });
      finishObserver.resolve({ status: 'succeeded' });
      const outcome = await write;

      assert.strictEqual(captured.configurationId, fixture.session.identity.configurationId);
      assert.strictEqual(captured.rootPath, fixture.root);
      assert.strictEqual(captured.operationId, 'identity-replacement-operation');
      assert.strictEqual(captured.snapshotVersion, 1);
      assert.strictEqual(outcome.configurationId, fixture.session.identity.configurationId);
      assert.strictEqual(outcome.status, 'committed');
    } finally {
      finishObserver.resolve({ status: 'succeeded' });
      await session.dispose();
      await fixture.dispose();
    }
  });

  test('an outcome-aware nested mutation shares the outer operation and notifies only once', async () => {
    const fixture = await createConfigurationFixture('configuration-session-nested-outcome-');
    const commits: Array<{ operationId: string; snapshotVersion: number; kind: string }> = [];
    const ObserverAwareSession = ConfigurationSession as unknown as new (
      identity: ConfigurationSession['identity'],
      observer: (commit: { configurationId: string; rootPath: string; operationId: string; snapshotVersion: number; kind: string }) => Promise<ReconciliationOutcome>,
    ) => ConfigurationSession;
    const session = new ObserverAwareSession(fixture.session.identity, async (commit) => {
      commits.push({ operationId: commit.operationId, snapshotVersion: commit.snapshotVersion, kind: commit.kind });
      return { status: 'succeeded' };
    });

    try {
      const outer = await session.enqueue({
        kind: 'test.outer-engine-write',
        operationId: 'outer-engine-operation',
        execute: async () => {
          const inner = await session.enqueue({
            kind: 'test.inner-engine-write',
            operationId: 'inner-engine-operation',
            execute: async () => 'inner',
            shouldReconcile: (outcome) => outcome.status === 'committed',
          });
          assert.strictEqual(inner.status, 'committed');
          assert.strictEqual(inner.operationId, 'outer-engine-operation');
          return 'outer';
        },
      });

      assert.strictEqual(outer.status, 'committed');
      assert.strictEqual(outer.operationId, 'outer-engine-operation');
      assert.strictEqual(outer.snapshotVersion, 1);
      assert.deepStrictEqual(commits, [{
        operationId: 'outer-engine-operation',
        snapshotVersion: 1,
        kind: 'test.outer-engine-write',
      }]);
    } finally {
      await session.dispose();
      await fixture.dispose();
    }
  });

  test('a nested uncertain outcome requests one outer reconciliation without becoming committed', async () => {
    const fixture = await createConfigurationFixture('configuration-session-nested-uncertain-');
    const commits: Array<{ operationId: string; snapshotVersion: number; kind: string }> = [];
    const ObserverAwareSession = ConfigurationSession as unknown as new (
      identity: ConfigurationSession['identity'],
      observer: (commit: { configurationId: string; rootPath: string; operationId: string; snapshotVersion: number; kind: string }) => Promise<ReconciliationOutcome>,
    ) => ConfigurationSession;
    const session = new ObserverAwareSession(fixture.session.identity, async (commit) => {
      commits.push({ operationId: commit.operationId, snapshotVersion: commit.snapshotVersion, kind: commit.kind });
      return { status: 'succeeded' };
    });

    try {
      const outer = await session.enqueue({
        kind: 'test.outer-uncertain-agent',
        operationId: 'outer-uncertain-operation',
        commitWhen: () => false,
        execute: async () => {
          const inner = await session.enqueue({
            kind: 'test.inner-in-doubt',
            operationId: 'inner-uncertain-operation',
            reconcile: true,
            commitWhen: () => false,
            execute: async () => 'possible-write',
            shouldReconcile: (outcome) => outcome.status === 'failed' && outcome.value === 'possible-write',
          });
          assert.strictEqual(inner.status, 'failed');
          assert.strictEqual(inner.value, 'possible-write');
          return 'agent-failure';
        },
      });

      assert.strictEqual(outer.status, 'failed');
      assert.strictEqual(outer.value, 'agent-failure');
      assert.deepStrictEqual(outer.reconciliation, { status: 'succeeded' });
      assert.strictEqual(session.snapshotVersion, 0, 'possible effects remain failed and do not become committed');
      assert.deepStrictEqual(commits, [{
        operationId: 'outer-uncertain-operation',
        snapshotVersion: 0,
        kind: 'test.outer-uncertain-agent',
      }]);
    } finally {
      await session.dispose();
      await fixture.dispose();
    }
  });

  test('read, cancel, conflict, failure, and assertion-only plan never notify a normal commit observer', async () => {
    const fixture = await createConfigurationFixture('configuration-session-nonwrite-outcomes-');
    let observerCalls = 0;
    const ObserverAwareSession = ConfigurationSession as unknown as new (
      identity: ConfigurationSession['identity'],
      observer: () => Promise<ReconciliationOutcome>,
    ) => ConfigurationSession;
    const session = new ObserverAwareSession(fixture.session.identity, async () => {
      observerCalls++;
      return { status: 'succeeded' };
    });

    try {
      assert.strictEqual((await session.runRead(async () => 'read')).status, 'ok');
      assert.strictEqual((await session.enqueue({
        kind: 'test.cancelled',
        cancellation: { isCancellationRequested: true },
        execute: async () => 'unused',
      })).status, 'cancelled');
      assert.strictEqual((await session.enqueue({
        kind: 'test.conflict',
        execute: async () => { throw new MutationPlanError('PLAN_CONFLICT', 'stale'); },
      })).status, 'conflict');
      assert.strictEqual((await session.enqueue({
        kind: 'test.failure',
        execute: async () => { throw new Error('write failed'); },
      })).status, 'failed');
      const descriptorPath = path.join(fixture.root, 'Configuration.xml');
      const descriptor = await fs.promises.readFile(descriptorPath, 'utf8');
      const assertion = await session.enqueuePlan({
        kind: 'test.assert-only',
        steps: [{
          type: 'assertFile',
          targetPath: descriptorPath,
          expected: { state: 'file', hash: hashContent(descriptor) },
        }],
        result: 'asserted',
      });

      assert.strictEqual(assertion.status, 'committed');
      assert.strictEqual(assertion.value, 'asserted');
      const valueOnlyAssertion = await session.runPlanValue({
        kind: 'test.assert-only-value-runner',
        steps: [{
          type: 'assertFile',
          targetPath: descriptorPath,
          expected: { state: 'file', hash: hashContent(descriptor) },
        }],
        result: 'asserted-through-value-runner',
      });
      assert.strictEqual(valueOnlyAssertion, 'asserted-through-value-runner');
      assert.strictEqual(observerCalls, 0);
    } finally {
      await session.dispose();
      await fixture.dispose();
    }
  });

  test('a recovery-required failure is reconciled without changing its noncommitted outcome', async () => {
    const fixture = await createConfigurationFixture('configuration-session-recovery-reconcile-');
    let observerCalls = 0;
    const ObserverAwareSession = ConfigurationSession as unknown as new (
      identity: ConfigurationSession['identity'],
      observer: () => Promise<ReconciliationOutcome>,
    ) => ConfigurationSession;
    const session = new ObserverAwareSession(fixture.session.identity, async () => {
      observerCalls++;
      return { status: 'succeeded' };
    });

    try {
      const outcome = await session.enqueue({
        kind: 'test.recovery-required',
        execute: async () => { throw new MutationPlanError('RECOVERY_REQUIRED', 'Recovery is required.'); },
      });

      assert.strictEqual(outcome.status, 'failed');
      assert.strictEqual(outcome.error?.message, 'Recovery is required.');
      assert.deepStrictEqual(outcome.reconciliation, { status: 'succeeded' });
      assert.strictEqual(session.snapshotVersion, 0);
      assert.strictEqual(observerCalls, 1);
    } finally {
      await session.dispose();
      await fixture.dispose();
    }
  });

  test('disposing a scoped gateway restores the previously installed mutation adapter', async () => {
    let previousAdapterCalls = 0;
    const previous = configureConfigurationMutationGateway(async (_resourcePath, _kind, operation) => {
      previousAdapterCalls++;
      return operation();
    });
    const scoped = configureConfigurationMutationGateway(async () => {
      throw new Error('The scoped adapter should have been disposed.');
    });
    try {
      scoped.dispose();
      const result = await runConfigurationMutation('fixture/resource.xml', 'after-scoped-dispose', async () => 'restored');

      assert.strictEqual(result, 'restored');
      assert.strictEqual(previousAdapterCalls, 1);
    } finally {
      previous.dispose();
    }
  });

  test('a raw session enqueue can call a nested plan without a second receipt or snapshot advance', async () => {
    const fixture = await createConfigurationFixture('configuration-session-inline-plan-');
    try {
      const targetPath = path.join(fixture.root, 'LeaseMarker.txt');
      const plan = writePlan(targetPath, 'committed once', { state: 'missing' });
      const session = fixture.session as ConfigurationSession & { enqueue: ConfigurationSession['enqueue'] };
      const originalEnqueue = session.enqueue.bind(session);
      let enqueueCalls = 0;
      session.enqueue = (<T>(request: MutationRequest<T>) => {
        enqueueCalls++;
        return originalEnqueue(request);
      });

      const receipt = await session.enqueue({
        kind: 'agent.outerMutation',
        operationId: 'outer-agent-operation',
        execute: async () => fixture.session.runPlanValue(plan, { operationId: 'inner-plan-operation' }),
      });

      assert.strictEqual(enqueueCalls, 1, 'the direct outer entry must be the only FIFO enqueue');
      assert.deepStrictEqual(receipt, {
        configurationId: fixture.session.identity.configurationId,
        operationId: 'outer-agent-operation',
        snapshotVersion: 1,
        status: 'committed',
        value: targetPath,
      });
      assert.strictEqual(fixture.session.snapshotVersion, 1);
      assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), 'committed once');
    } finally {
      await fixture.dispose();
    }
  });

  test('a nested plan CAS conflict preserves original bytes and the outer typed conflict receipt', async () => {
    const fixture = await createConfigurationFixture('configuration-session-inline-cas-');
    try {
      const targetPath = path.join(fixture.root, 'Revision.xml');
      const original = '<Revision>original</Revision>';
      await fs.promises.writeFile(targetPath, original, 'utf8');
      const plan = writePlan(targetPath, '<Revision>replacement</Revision>', {
        state: 'file',
        hash: hashContent('<Revision>different-revision</Revision>'),
      });

      const receipt = await fixture.session.enqueue({
        kind: 'agent.outerCAS',
        operationId: 'outer-cas-operation',
        execute: async () => fixture.session.runPlanValue(plan),
      });

      assert.strictEqual(receipt.status, 'conflict');
      assert.strictEqual(receipt.code, 'PLAN_CONFLICT');
      assert.strictEqual(receipt.operationId, 'outer-cas-operation');
      assert.strictEqual(receipt.snapshotVersion, 0);
      assert.ok(receipt.error instanceof MutationPlanError);
      assert.strictEqual((receipt.error as MutationPlanError).code, 'PLAN_CONFLICT');
      assert.strictEqual(fixture.session.snapshotVersion, 0);
      assert.strictEqual(await fs.promises.readFile(targetPath, 'utf8'), original);
    } finally {
      await fixture.dispose();
    }
  });

  test('nested root create, duplicate, rename and delete plans share each outer session writer lease', async () => {
    const fixture = await createConfigurationFixture('configuration-session-root-crud-');
    const gateway = configureConfigurationMutationGateway(
      async (resourcePath, kind, operation) => {
        const owner = await fixture.registry.resolveResource(resourcePath);
        return owner.runMutationValue({ kind, execute: operation }, {
          failureMessage: 'Операция конфигурации не выполнена.',
          cancelledMessage: 'Операция конфигурации отменена.',
        });
      },
      async (resourcePath, plan) => {
        const owner = await fixture.registry.resolveResource(resourcePath);
        return owner.runPlanValue(plan);
      },
    );
    const originalEnqueue = fixture.session.enqueue.bind(fixture.session);
    let enqueueCalls = 0;
    fixture.session.enqueue = (<T>(request: MutationRequest<T>) => {
      enqueueCalls++;
      return originalEnqueue(request);
    });
    try {
      const create = await planCreateMetadataObject({ configurationRootPath: fixture.root }, {
        type: MetadataType.Sequence,
        name: 'PostingOrder',
      });
      await runConfigurationMutation(fixture.root, 'ui.createElement', async () => {
        await runConfigurationPlan(fixture.root, create.plan);
      });
      assert.strictEqual(fixture.session.snapshotVersion, 1);

      const configurationNode: TreeNode = {
        id: 'Configuration', name: 'Configuration', type: MetadataType.Configuration,
        filePath: path.join(fixture.root, 'Configuration.xml'), properties: {},
      };
      const folderNode: TreeNode = {
        id: 'Sequences', name: 'Sequences', type: MetadataType.Sequence,
        filePath: path.join(fixture.root, 'Sequences'), parent: configurationNode,
        children: [], properties: {},
      };
      const sourceNode: TreeNode = {
        id: 'Sequences.PostingOrder', name: 'PostingOrder', type: MetadataType.Sequence,
        filePath: path.join(fixture.root, 'Sequences', 'PostingOrder.xml'), parent: folderNode, properties: {},
      };
      folderNode.children = [sourceNode];

      const duplicate = await planDuplicateRootElement(sourceNode, 'PostingOrderCopy');
      await runConfigurationMutation(fixture.root, 'ui.duplicateElement', async () => {
        await runConfigurationPlan(fixture.root, duplicate);
      });
      assert.strictEqual(fixture.session.snapshotVersion, 2);

      const rename = await planRenameRootElement(sourceNode, 'PostingOrderRenamed', fixture.root);
      await runConfigurationMutation(fixture.root, 'ui.renameElement', async () => {
        await runConfigurationPlan(fixture.root, rename);
      });
      assert.strictEqual(fixture.session.snapshotVersion, 3);

      const deletion = await planDeleteMetadataObject({ configurationRootPath: fixture.root }, {
        type: MetadataType.Sequence,
        name: 'PostingOrderRenamed',
      });
      await runConfigurationMutation(fixture.root, 'ui.deleteElement', async () => {
        await runConfigurationPlan(fixture.root, deletion.plan);
      });
      assert.strictEqual(fixture.session.snapshotVersion, 4);
      assert.strictEqual(enqueueCalls, 4, 'each UI-style outer mutation must own exactly one FIFO entry');
      assert.strictEqual(fs.existsSync(path.join(fixture.root, 'Sequences', 'PostingOrder.xml')), false);
      assert.strictEqual(fs.existsSync(path.join(fixture.root, 'Sequences', 'PostingOrderCopy.xml')), true);
      assert.strictEqual(fs.existsSync(path.join(fixture.root, 'Sequences', 'PostingOrderRenamed.xml')), false);
      assert.doesNotMatch(await fs.promises.readFile(path.join(fixture.root, 'Configuration.xml'), 'utf8'), /<Sequence>PostingOrderRenamed<\/Sequence>/);
    } finally {
      gateway.dispose();
      await fixture.dispose();
    }
  });

  test('a writer in another session queues normally instead of borrowing the ambient lease', async () => {
    const first = await createConfigurationFixture('configuration-session-root-a-');
    const second = await createConfigurationFixture('configuration-session-root-b-');
    try {
      const secondTarget = path.join(second.root, 'OtherRoot.txt');
      const secondPlan = writePlan(secondTarget, 'second root', { state: 'missing' });
      const originalEnqueue = second.session.enqueue.bind(second.session);
      let secondEnqueueCalls = 0;
      second.session.enqueue = (<T>(request: MutationRequest<T>) => {
        secondEnqueueCalls++;
        return originalEnqueue(request);
      });

      const firstValue = await first.session.runMutationValue({
        kind: 'first.root.outer',
        execute: async () => second.session.runPlanValue(secondPlan),
      });

      assert.strictEqual(firstValue, secondTarget);
      assert.strictEqual(secondEnqueueCalls, 1);
      assert.strictEqual(first.session.snapshotVersion, 1);
      assert.strictEqual(second.session.snapshotVersion, 1);
      assert.strictEqual(await fs.promises.readFile(secondTarget, 'utf8'), 'second root');
    } finally {
      await Promise.all([first.dispose(), second.dispose()]);
    }
  });

  test('a write started from an active read is rejected with a typed error', async () => {
    const fixture = await createConfigurationFixture('configuration-session-read-upgrade-');
    try {
      const targetPath = path.join(fixture.root, 'Forbidden.txt');
      const outcome = await fixture.session.runRead(async () => fixture.session.runMutationValue({
        kind: 'read.upgrade',
        execute: async () => {
          await fs.promises.writeFile(targetPath, 'must not run', 'utf8');
          return undefined;
        },
      }));

      assert.strictEqual(outcome.status, 'failed');
      assert.ok(outcome.error instanceof ConfigurationSessionWriteFromReadError);
      assert.strictEqual((outcome.error as ConfigurationSessionWriteFromReadError).code, 'WRITE_FROM_READ');
      assert.strictEqual(fixture.session.snapshotVersion, 0);
      assert.strictEqual(fs.existsSync(targetPath), false);
    } finally {
      await fixture.dispose();
    }
  });

  test('a writer requested while a read is active waits for the read and then commits', async () => {
    const fixture = await createConfigurationFixture('configuration-session-reader-then-writer-');
    try {
      const enteredRead = deferred<void>();
      const finishRead = deferred<void>();
      let writerStarted = false;
      const readPromise = fixture.session.runRead(async () => {
        enteredRead.resolve();
        await finishRead.promise;
        return 'read finished';
      });
      await enteredRead.promise;
      const writePromise = fixture.session.runMutationValue({
        kind: 'queued.after.read',
        execute: async () => {
          writerStarted = true;
          return 'write finished';
        },
      });

      assert.strictEqual(writerStarted, false);
      finishRead.resolve();
      assert.deepStrictEqual(await readPromise, {
        status: 'ok',
        value: 'read finished',
        snapshotVersion: 0,
        configurationId: fixture.session.identity.configurationId,
      });
      assert.strictEqual(await writePromise, 'write finished');
      assert.strictEqual(writerStarted, true);
      assert.strictEqual(fixture.session.snapshotVersion, 1);
    } finally {
      await fixture.dispose();
    }
  });

  test('an async callback detached from a settled writer lease is queued as a new writer', async () => {
    const fixture = await createConfigurationFixture('configuration-session-expired-writer-');
    try {
      const detachedTarget = path.join(fixture.root, 'Detached.txt');
      const detachedSettled = deferred<void>();
      let enqueueCalls = 0;
      const originalEnqueue = fixture.session.enqueue.bind(fixture.session);
      fixture.session.enqueue = (<T>(request: MutationRequest<T>) => {
        enqueueCalls++;
        return originalEnqueue(request);
      });

      await fixture.session.runMutationValue({
        kind: 'outer.writer',
        execute: async () => {
          setTimeout(() => {
            void fixture.session.runPlanValue(writePlan(detachedTarget, 'later write', { state: 'missing' }))
              .then(() => detachedSettled.resolve(), (error) => detachedSettled.reject(error));
          }, 0);
          return 'outer committed';
        },
      });
      assert.strictEqual(fixture.session.snapshotVersion, 1);
      await detachedSettled.promise;

      assert.strictEqual(enqueueCalls, 2);
      assert.strictEqual(fixture.session.snapshotVersion, 2);
      assert.strictEqual(await fs.promises.readFile(detachedTarget, 'utf8'), 'later write');
    } finally {
      await fixture.dispose();
    }
  });

  test('an expired read lease cannot reject a later detached writer as a read upgrade', async () => {
    const fixture = await createConfigurationFixture('configuration-session-expired-reader-');
    try {
      const detachedTarget = path.join(fixture.root, 'AfterRead.txt');
      const detachedSettled = deferred<void>();
      let enqueueCalls = 0;
      const originalEnqueue = fixture.session.enqueue.bind(fixture.session);
      fixture.session.enqueue = (<T>(request: MutationRequest<T>) => {
        enqueueCalls++;
        return originalEnqueue(request);
      });

      const outcome = await fixture.session.runRead(async () => {
        setTimeout(() => {
          void fixture.session.runMutationValue({
            kind: 'writer.after.read.settled',
            execute: async () => {
              await fs.promises.writeFile(detachedTarget, 'normal queued write', 'utf8');
              return undefined;
            },
          }).then(() => detachedSettled.resolve(), (error) => detachedSettled.reject(error));
        }, 0);
        return 'read complete';
      });

      assert.strictEqual(outcome.status, 'ok');
      await detachedSettled.promise;
      assert.strictEqual(enqueueCalls, 1);
      assert.strictEqual(fixture.session.snapshotVersion, 1);
      assert.strictEqual(await fs.promises.readFile(detachedTarget, 'utf8'), 'normal queued write');
    } finally {
      await fixture.dispose();
    }
  });

  test('a cancelled nested plan does not apply bytes or increment the outer snapshot', async () => {
    const fixture = await createConfigurationFixture('configuration-session-nested-cancel-');
    try {
      const targetPath = path.join(fixture.root, 'Cancelled.txt');
      const outcome = await fixture.session.enqueue({
        kind: 'outer.cancelledPlan',
        execute: async () => {
          await fixture.session.runPlanValue(writePlan(targetPath, 'must not be written', { state: 'missing' }), {
            cancellation: { isCancellationRequested: true },
          });
        },
      });

      assert.strictEqual(outcome.status, 'failed');
      assert.match(outcome.error?.message ?? '', /cancelled/i);
      assert.strictEqual(fixture.session.snapshotVersion, 0);
      assert.strictEqual(fs.existsSync(targetPath), false);
    } finally {
      await fixture.dispose();
    }
  });
});
