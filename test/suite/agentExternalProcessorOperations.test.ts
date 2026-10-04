import * as assert from 'assert';
import * as path from 'path';
import type * as vscode from 'vscode';
import {
  agentBuildExternalProcessor,
  agentDumpExternalProcessor,
} from '../../src/agent/agentExternalProcessorOperations';
import type {
  BuildExternalProcessorOptions,
  DumpExternalProcessorOptions,
  ExternalProcessorOperationResult,
} from '../../src/services/externalProcessor/externalProcessorTypes';

interface ServiceModule {
  dumpExternalProcessor(options: DumpExternalProcessorOptions): Promise<ExternalProcessorOperationResult>;
  buildExternalProcessor(options: BuildExternalProcessorOptions): Promise<ExternalProcessorOperationResult>;
}

const serviceModule = module.require(
  '../../src/services/externalProcessor/externalProcessorService'
) as ServiceModule;
const originalDump = serviceModule.dumpExternalProcessor;
const originalBuild = serviceModule.buildExternalProcessor;

suite('agentExternalProcessorOperations', () => {
  teardown(() => {
    serviceModule.dumpExternalProcessor = originalDump;
    serviceModule.buildExternalProcessor = originalBuild;
  });

  test('dump resolves default sibling outDir and forwards format/context/timeout', async () => {
    let captured: DumpExternalProcessorOptions | undefined;
    serviceModule.dumpExternalProcessor = async (options) => {
      captured = options;
      return completed(options.outputDirectory);
    };

    const result = await agentDumpExternalProcessor({
      srcPath: path.join('relative', 'MyProcessor.epf'),
      format: 'Plain',
      context: { kind: 'standalone', acknowledgeTypeLoss: true },
      timeoutMs: 321,
    });

    const expectedSource = path.resolve('relative', 'MyProcessor.epf');
    assert.deepStrictEqual(captured, {
      externalFilePath: expectedSource,
      outputDirectory: path.join(path.dirname(expectedSource), 'MyProcessor_src'),
      format: 'Plain',
      context: { kind: 'standalone', acknowledgeTypeLoss: true },
      timeoutMs: 321,
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data?.state, 'completed');
  });

  test('build resolves root/destination/infobase paths and maps failed result', async () => {
    let captured: BuildExternalProcessorOptions | undefined;
    serviceModule.buildExternalProcessor = async (options) => {
      captured = options;
      return {
        state: 'failed',
        code: 'EXTERNAL_OUTPUT_EXISTS',
        message: 'already exists',
        retryable: false,
        effectPossible: false,
        combinedLog: '',
      };
    };

    const result = await agentBuildExternalProcessor({
      rootXmlPath: path.join('relative', 'Report_src', 'Report.xml'),
      dstPath: path.join('relative', 'Report.erf'),
      context: {
        kind: 'infobase',
        infobasePath: path.join('relative', 'db'),
        credentials: { user: 'operator', password: 'secret' },
      },
      timeoutMs: 777,
    });

    assert.deepStrictEqual(captured, {
      rootXmlPath: path.resolve('relative', 'Report_src', 'Report.xml'),
      destinationPath: path.resolve('relative', 'Report.erf'),
      context: {
        kind: 'infobase',
        infobasePath: path.resolve('relative', 'db'),
        credentials: { user: 'operator', password: 'secret' },
      },
      timeoutMs: 777,
    });
    assert.deepStrictEqual(result, {
      success: false,
      code: 'EXTERNAL_OUTPUT_EXISTS',
      error: 'already exists',
      data: capturedFailed(),
    });
  });

  test('forwards a supplied cancellation token to both services', async () => {
    let capturedDump: DumpExternalProcessorOptions | undefined;
    let capturedBuild: BuildExternalProcessorOptions | undefined;
    const token: vscode.CancellationToken = {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose: () => undefined }),
    };
    serviceModule.dumpExternalProcessor = async (options) => {
      capturedDump = options;
      return completed(options.outputDirectory);
    };
    serviceModule.buildExternalProcessor = async (options) => {
      capturedBuild = options;
      return completed(options.destinationPath ?? 'built.epf');
    };

    await agentDumpExternalProcessor({
      srcPath: 'Processor.epf',
      format: 'Plain',
      context: { kind: 'standalone', acknowledgeTypeLoss: true },
    }, token);
    await agentBuildExternalProcessor({
      rootXmlPath: 'Processor_src/Processor.xml',
      context: { kind: 'standalone', acknowledgeTypeLoss: true },
    }, token);

    assert.strictEqual(capturedDump?.cancellation, token);
    assert.strictEqual(capturedBuild?.cancellation, token);
  });

  test('preserves direct-call service options when no stage reporter is supplied', async () => {
    let capturedDump: DumpExternalProcessorOptions | undefined;
    let capturedBuild: BuildExternalProcessorOptions | undefined;
    serviceModule.dumpExternalProcessor = async (options) => {
      capturedDump = options;
      return completed(options.outputDirectory);
    };
    serviceModule.buildExternalProcessor = async (options) => {
      capturedBuild = options;
      return completed(options.destinationPath ?? 'built.epf');
    };

    await agentDumpExternalProcessor({
      srcPath: 'Processor.epf',
      format: 'Plain',
      context: { kind: 'standalone', acknowledgeTypeLoss: true },
    });
    await agentBuildExternalProcessor({
      rootXmlPath: 'Processor_src/Processor.xml',
      context: { kind: 'standalone', acknowledgeTypeLoss: true },
    });

    assert.strictEqual(capturedDump?.onOutput, undefined);
    assert.strictEqual(capturedBuild?.onOutput, undefined);
  });

  test('forwards bounded process lines to a supplied stage reporter', async () => {
    const dumpStages: string[] = [];
    const buildStages: string[] = [];
    serviceModule.dumpExternalProcessor = async (options) => {
      options.onOutput?.('preparing artifact\nwriting artifact\n');
      return completed(options.outputDirectory);
    };
    serviceModule.buildExternalProcessor = async (options) => {
      options.onOutput?.('loading source');
      return completed(options.destinationPath ?? 'built.epf');
    };

    await agentDumpExternalProcessor({
      srcPath: 'Processor.epf',
      format: 'Plain',
      context: { kind: 'standalone', acknowledgeTypeLoss: true },
    }, undefined, (message) => dumpStages.push(message));
    await agentBuildExternalProcessor({
      rootXmlPath: 'Processor_src/Processor.xml',
      context: { kind: 'standalone', acknowledgeTypeLoss: true },
    }, undefined, (message) => buildStages.push(message));

    assert.deepStrictEqual(dumpStages, ['preparing artifact', 'writing artifact']);
    assert.deepStrictEqual(buildStages, ['loading source']);
  });

  test('inDoubt remains an Agent error and preserves staging details in data', async () => {
    const doubtful: ExternalProcessorOperationResult = {
      state: 'inDoubt',
      code: 'CONFIGURATOR_IN_DOUBT',
      message: 'outcome unknown',
      retryable: false,
      effectPossible: true,
      stagingPath: path.resolve('.stage'),
      combinedLog: 'safe',
    };
    serviceModule.buildExternalProcessor = async () => doubtful;

    const result = await agentBuildExternalProcessor({
      rootXmlPath: 'Report.xml',
      context: { kind: 'standalone', acknowledgeTypeLoss: true },
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.code, 'CONFIGURATOR_IN_DOUBT');
    assert.strictEqual(result.error, 'outcome unknown');
    assert.strictEqual(result.data, doubtful);
  });

  test('maps confirmed cancellation before Configurator start to REQUEST_CANCELLED and preserves the service result', async () => {
    const cancelledBeforeStart = {
      state: 'failed',
      code: 'CONFIGURATOR_CANCELLED_BEFORE_START',
      message: 'Configurator operation was cancelled before process start.',
      retryable: true,
      effectPossible: false,
      combinedLog: '',
    } as unknown as ExternalProcessorOperationResult;
    serviceModule.dumpExternalProcessor = async () => cancelledBeforeStart;

    const result = await agentDumpExternalProcessor({
      srcPath: 'Processor.epf',
      format: 'Plain',
      context: { kind: 'standalone', acknowledgeTypeLoss: true },
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.code, 'REQUEST_CANCELLED');
    assert.strictEqual(result.data, cancelledBeforeStart);
  });

  test('missing or malformed explicit context is a closed Agent error without invoking the service', async () => {
    let calls = 0;
    serviceModule.dumpExternalProcessor = async () => {
      calls += 1;
      return completed('unexpected');
    };
    serviceModule.buildExternalProcessor = async () => {
      calls += 1;
      return completed('unexpected');
    };

    const results = await Promise.all([
      agentDumpExternalProcessor({ srcPath: 'Processor.epf', format: 'Plain' } as never),
      agentDumpExternalProcessor({
        srcPath: 'Processor.epf',
        format: 'Plain',
        context: { kind: 'standalone', acknowledgeTypeLoss: false },
      } as never),
      agentBuildExternalProcessor({ rootXmlPath: 'Processor.xml' } as never),
      agentBuildExternalProcessor({
        rootXmlPath: 'Processor.xml',
        context: { kind: 'infobase', infobasePath: '', credentials: { password: 'secret' } },
      } as never),
    ]);

    for (const result of results) {
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.code, 'EXTERNAL_CONTEXT_INVALID');
      assert.strictEqual(result.data?.state, 'failed');
      assert.strictEqual(result.data?.code, 'EXTERNAL_CONTEXT_INVALID');
    }
    assert.strictEqual(calls, 0);
  });
});

function completed(artifactPath: string): ExternalProcessorOperationResult {
  return {
    state: 'completed',
    artifactPath,
    combinedLog: '',
  };
}

function capturedFailed(): ExternalProcessorOperationResult {
  return {
    state: 'failed',
    code: 'EXTERNAL_OUTPUT_EXISTS',
    message: 'already exists',
    retryable: false,
    effectPossible: false,
    combinedLog: '',
  };
}
