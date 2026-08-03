import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { registerExternalProcessorCommands } from '../../src/commands/externalProcessorCommands';
import type {
  BuildExternalProcessorOptions,
  DumpExternalProcessorOptions,
  ExternalProcessorOperationResult,
  ExternalProcessorRootInspection,
} from '../../src/services/externalProcessor/externalProcessorTypes';
import {
  resetVscodeTestState,
  vscodeTestState,
} from '../helpers/vscodeModuleStub';

interface ServiceModule {
  dumpExternalProcessor(options: DumpExternalProcessorOptions): Promise<ExternalProcessorOperationResult>;
  buildExternalProcessor(options: BuildExternalProcessorOptions): Promise<ExternalProcessorOperationResult>;
  inspectExternalProcessorRoot(rootXmlPath: string): Promise<ExternalProcessorRootInspection>;
}

const serviceModule = module.require(
  '../../src/services/externalProcessor/externalProcessorService'
) as ServiceModule;
const originalDump = serviceModule.dumpExternalProcessor;
const originalBuild = serviceModule.buildExternalProcessor;
const originalInspect = serviceModule.inspectExternalProcessorRoot;

suite('externalProcessorCommands UI behavior', () => {
  setup(resetVscodeTestState);
  teardown(() => {
    serviceModule.dumpExternalProcessor = originalDump;
    serviceModule.buildExternalProcessor = originalBuild;
    serviceModule.inspectExternalProcessorRoot = originalInspect;
    resetVscodeTestState();
  });

  test('standalone dump requires explicit confirmation and propagates cancellation token', async () => {
    let calls = 0;
    let captured: DumpExternalProcessorOptions | undefined;
    serviceModule.dumpExternalProcessor = async (options) => {
      calls += 1;
      captured = options;
      return completed(options.outputDirectory);
    };
    const handler = registerAndGet('1c-metadata-tree.dumpExternalProcessor');
    const source = vscode.Uri.file(path.resolve('Processor.epf'));

    queueDumpDialogs(path.resolve('Processor_src'), undefined);
    await handler(source);
    assert.strictEqual(calls, 0);
    assert.match(vscodeTestState.warningLog[0], /ссылочные типы/iu);

    queueDumpDialogs(path.resolve('Processor_src'), 'Продолжить');
    vscodeTestState.progressCancellationRequested = true;
    await handler(source);
    assert.strictEqual(calls, 1);
    assert.deepStrictEqual(captured?.context, {
      kind: 'standalone',
      acknowledgeTypeLoss: true,
    });
    assert.strictEqual(captured?.format, 'Hierarchical');
    assert.strictEqual(captured?.cancellation?.isCancellationRequested, true);
    assert.strictEqual(vscodeTestState.progressOptionsLog.at(-1)?.cancellable, true);
  });

  test('file-infobase selection validates 1Cv8.1CD and forwards credentials', async () => {
    let captured: DumpExternalProcessorOptions | undefined;
    serviceModule.dumpExternalProcessor = async (options) => {
      captured = options;
      return completed(options.outputDirectory);
    };
    const handler = registerAndGet('1c-metadata-tree.dumpExternalProcessor');
    const databaseDirectory = path.resolve('db');
    vscodeTestState.workspaceFsFiles.add(path.normalize(path.join(databaseDirectory, '1Cv8.1CD')));
    vscodeTestState.inputBoxQueue.push(path.resolve('Processor_src'), 'operator', 'secret');
    vscodeTestState.quickPickQueue.push(
      { label: 'Plain' },
      { contextKind: 'infobase', label: 'Файловая информационная база' },
    );
    vscodeTestState.openDialogQueue.push([vscode.Uri.file(databaseDirectory)]);

    await handler(vscode.Uri.file(path.resolve('Processor.epf')));

    assert.deepStrictEqual(captured?.context, {
      kind: 'infobase',
      infobasePath: databaseDirectory,
      credentials: { user: 'operator', password: 'secret' },
    });
  });

  test('ERF build uses ERF save contract and renders inDoubt staging as warning', async () => {
    let captured: BuildExternalProcessorOptions | undefined;
    const rootXml = path.resolve('Report_src', 'Report.xml');
    const destination = path.resolve('Report_built.erf');
    const staging = path.resolve('.Report_built.erf.stage');
    serviceModule.inspectExternalProcessorRoot = async () => ({
      kind: 'ExternalReport',
      extension: '.erf',
      defaultDestinationPath: destination,
    });
    serviceModule.buildExternalProcessor = async (options) => {
      captured = options;
      return {
        state: 'inDoubt',
        code: 'CONFIGURATOR_IN_DOUBT',
        message: 'outcome unknown',
        retryable: false,
        effectPossible: true,
        stagingPath: staging,
        combinedLog: 'safe',
      };
    };
    vscodeTestState.saveDialogQueue.push(vscode.Uri.file(destination));
    vscodeTestState.quickPickQueue.push({
      contextKind: 'standalone',
      label: 'Автономный режим',
    });
    vscodeTestState.warningMessageReturnQueue.push('Продолжить');
    const handler = registerAndGet('1c-metadata-tree.buildExternalProcessor');

    await handler(vscode.Uri.file(rootXml));

    assert.strictEqual(captured?.rootXmlPath, rootXml);
    assert.strictEqual(captured?.destinationPath, destination);
    assert.deepStrictEqual(captured?.context, {
      kind: 'standalone',
      acknowledgeTypeLoss: true,
    });
    const saveOptions = vscodeTestState.saveDialogOptionsLog[0] as {
      defaultUri: { fsPath: string };
      filters: Record<string, string[]>;
    };
    assert.strictEqual(saveOptions.defaultUri.fsPath, destination);
    assert.deepStrictEqual(saveOptions.filters, { 'Внешний отчёт 1С': ['erf'] });
    assert.ok(vscodeTestState.warningLog.some((message) =>
      message.includes(staging) && message.includes('не подтверждён')));
  });
});

function registerAndGet(commandId: string): (...args: unknown[]) => Promise<unknown> {
  const context = { subscriptions: [] as Array<{ dispose(): void }> };
  registerExternalProcessorCommands(context as never);
  const handler = vscodeTestState.registeredCommandHandlers.get(commandId);
  assert.ok(handler, `Missing handler ${commandId}`);
  return async (...args: unknown[]) => handler(...args);
}

function queueDumpDialogs(outputDirectory: string, confirmation: string | undefined): void {
  vscodeTestState.inputBoxQueue.push(outputDirectory);
  vscodeTestState.quickPickQueue.push(
    { label: 'Hierarchical' },
    { contextKind: 'standalone', label: 'Автономный режим' },
  );
  vscodeTestState.warningMessageReturnQueue.push(confirmation);
}

function completed(artifactPath: string): ExternalProcessorOperationResult {
  return {
    state: 'completed',
    artifactPath,
    combinedLog: '',
  };
}
