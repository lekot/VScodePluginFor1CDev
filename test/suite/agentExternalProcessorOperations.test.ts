import * as assert from 'assert';
import * as path from 'path';
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
