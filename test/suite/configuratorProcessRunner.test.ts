import * as assert from 'assert';
import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ConfiguratorBatchArguments } from '../../src/services/configurator/configuratorBatchArgs';
import {
  runConfiguratorProcess,
  type ConfiguratorProcessRunnerOptions,
} from '../../src/services/configurator/configuratorProcessRunner';
import type { SupportCancellation } from '../../src/support/supportTypes';

const NEVER_CANCELLED: SupportCancellation = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
};

suite('ConfiguratorProcessRunner', () => {
  test('effect-possible non-zero exit remains in doubt', async () => {
    const process = controllableProcess();
    const outcomePromise = runConfiguratorProcess(options(process.spawnImpl));
    const child = await process.waitForChild();
    child.emit('spawn');
    process.close(7, null);

    const outcome = await outcomePromise;
    assert.strictEqual(outcome.status, 'inDoubt');
    if (outcome.status === 'inDoubt') {
      assert.strictEqual(outcome.errorCode, 'CONFIGURATOR_EXIT_FAILED');
      assert.strictEqual(outcome.effectPossible, true);
      assert.strictEqual(outcome.exitCode, 7);
    }
  });

  test('effect-possible fatal marker remains in doubt', async () => {
    const process = controllableProcess();
    const outcomePromise = runConfiguratorProcess(options(process.spawnImpl));
    const child = await process.waitForChild();
    child.emit('spawn');
    process.pushStderr('Error: partial load failed');
    process.close(0, null);

    const outcome = await outcomePromise;
    assert.strictEqual(outcome.status, 'inDoubt');
    if (outcome.status === 'inDoubt') {
      assert.strictEqual(outcome.errorCode, 'CONFIGURATOR_FATAL_MARKER');
      assert.strictEqual(outcome.effectPossible, true);
      assert.strictEqual(outcome.exitCode, 0);
    }
  });

  test('pre-start spawn failure remains retryable and effect-free', async () => {
    const spawnImpl = (() => {
      throw Object.assign(new Error('spawn denied'), { code: 'EACCES' });
    }) as typeof spawn;
    const outcome = await runConfiguratorProcess(options(spawnImpl));

    assert.strictEqual(outcome.status, 'failed');
    if (outcome.status === 'failed') {
      assert.strictEqual(outcome.errorCode, 'CONFIGURATOR_SPAWN_FAILED');
      assert.strictEqual(outcome.retryable, true);
      assert.strictEqual(outcome.started, false);
      assert.strictEqual(outcome.effectPossible, false);
    }
  });
});

function options(spawnImpl: typeof spawn): ConfiguratorProcessRunnerOptions {
  return {
    executablePath: '1cv8.exe',
    batchArguments: batchArguments(),
    timeoutMs: 5_000,
    cancellation: NEVER_CANCELLED,
    spawnImpl,
    removeOutputFile: async () => undefined,
    readOutputFile: async () => '',
  };
}

function batchArguments(): ConfiguratorBatchArguments {
  return {
    operation: 'partialApply',
    executionArgs: ['DESIGNER', '/F', 'C:\\base', '/Out', 'apply.log'],
    diagnosticArgs: ['DESIGNER', '/F', 'C:\\base', '/Out', 'apply.log'],
    outputFilePath: 'apply.log',
  };
}

interface ControllableProcess {
  readonly spawnImpl: typeof spawn;
  readonly waitForChild: () => Promise<ChildProcess>;
  readonly pushStderr: (value: string) => void;
  readonly close: (code: number | null, signal: NodeJS.Signals | null) => void;
}

function controllableProcess(): ControllableProcess {
  let child: ChildProcess | undefined;
  let stderr = new PassThrough();
  let resolveChild!: (value: ChildProcess) => void;
  const childReady = new Promise<ChildProcess>((resolve) => {
    resolveChild = resolve;
  });
  const spawnImpl = (() => {
    stderr = new PassThrough();
    const created = new EventEmitter() as ChildProcess;
    (created as unknown as { stdout: PassThrough }).stdout = new PassThrough();
    (created as unknown as { stderr: PassThrough }).stderr = stderr;
    (created as unknown as { killed: boolean }).killed = false;
    (created as unknown as { exitCode: number | null }).exitCode = null;
    (created as unknown as { kill: () => boolean }).kill = () => true;
    child = created;
    resolveChild(created);
    return created;
  }) as typeof spawn;
  return {
    spawnImpl,
    waitForChild: () => childReady,
    pushStderr: (value) => stderr.write(value),
    close: (code, signal) => {
      assert.ok(child, 'Process must be spawned before close.');
      child.emit('close', code, signal);
    },
  };
}
