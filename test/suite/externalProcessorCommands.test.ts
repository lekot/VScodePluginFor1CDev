import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { MetadataType, type TreeNode } from '../../src/models/treeNode';
import { registerExternalProcessorCommands } from '../../src/commands/externalProcessorCommands';
import {
  ExternalArtifactProjectService,
} from '../../src/services/externalProcessor/externalArtifactProjectService';
import type {
  BuildExternalProcessorOptions,
  DumpExternalProcessorOptions,
  ExternalProcessorOperationResult,
  ExternalProcessorRootInspection,
} from '../../src/services/externalProcessor/externalProcessorTypes';
import type {
  CreateExternalArtifactProjectRequest,
  ExportEmbeddedArtifactRequest,
} from '../../src/services/externalProcessor/externalArtifactProjectTypes';
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
const originalCreateArtifact = ExternalArtifactProjectService.prototype.create;
const originalExportEmbedded = ExternalArtifactProjectService.prototype.exportEmbedded;

suite('externalProcessorCommands UI behavior', () => {
  setup(resetVscodeTestState);
  teardown(() => {
    serviceModule.dumpExternalProcessor = originalDump;
    serviceModule.buildExternalProcessor = originalBuild;
    serviceModule.inspectExternalProcessorRoot = originalInspect;
    ExternalArtifactProjectService.prototype.create = originalCreateArtifact;
    ExternalArtifactProjectService.prototype.exportEmbedded = originalExportEmbedded;
    resetVscodeTestState();
  });

  test('creates an empty ERF project in the selected workspace', async () => {
    let captured: CreateExternalArtifactProjectRequest | undefined;
    const projectDirectory = path.resolve('workspace/NewReport_src');
    ExternalArtifactProjectService.prototype.create = async (request) => {
      captured = request;
      return {
        rootXmlPath: path.join(projectDirectory, 'NewReport.xml'),
        kind: 'ExternalReport',
        projectDirectory,
      };
    };
    vscodeTestState.mockWorkspaceFolders.push({
      name: 'Workspace',
      index: 0,
      uri: vscode.Uri.file(path.resolve('workspace')),
    });
    vscodeTestState.quickPickQueue.push(
      { artifactKind: 'ExternalReport', label: 'Внешний отчёт (ERF)' },
      { language: 'en', label: 'Английский' },
    );
    vscodeTestState.inputBoxQueue.push('NewReport');

    await registerAndGet('1c-metadata-tree.createExternalArtifactProject')();

    assert.deepStrictEqual(captured, {
      workspaceRoot: path.resolve('workspace'),
      name: 'NewReport',
      kind: 'ExternalReport',
      language: 'en',
    });
    assert.ok(vscodeTestState.informationLog.some((message) => message.includes(projectDirectory)));
  });

  test('exports an embedded Report and runs the existing ERF build after user selection', async () => {
    let exportedRequest: ExportEmbeddedArtifactRequest | undefined;
    let builtOptions: BuildExternalProcessorOptions | undefined;
    const workspaceRoot = path.resolve('workspace');
    const sourceRoot = path.join(workspaceRoot, 'Configuration', 'Reports', 'Report.xml');
    const projectDirectory = path.join(workspaceRoot, 'Report_external_src');
    const rootXmlPath = path.join(projectDirectory, 'Report.xml');
    const destinationPath = path.join(workspaceRoot, 'Report.erf');
    ExternalArtifactProjectService.prototype.exportEmbedded = async (request) => {
      exportedRequest = request;
      return { rootXmlPath, kind: 'ExternalReport', projectDirectory };
    };
    serviceModule.inspectExternalProcessorRoot = async () => ({
      kind: 'ExternalReport',
      extension: '.erf',
      defaultDestinationPath: destinationPath,
    });
    serviceModule.buildExternalProcessor = async (options) => {
      builtOptions = options;
      return completed(destinationPath);
    };
    vscodeTestState.mockWorkspaceFolders.push({
      name: 'Workspace',
      index: 0,
      uri: vscode.Uri.file(workspaceRoot),
    });
    vscodeTestState.inputBoxQueue.push(path.join(workspaceRoot, 'Report_external_src'));
    vscodeTestState.informationMessageResult = 'Собрать EPF/ERF';
    vscodeTestState.saveDialogQueue.push(vscode.Uri.file(destinationPath));
    vscodeTestState.quickPickQueue.push({
      contextKind: 'standalone',
      label: 'Автономный режим',
    });
    vscodeTestState.warningMessageReturnQueue.push('Продолжить');
    const node: TreeNode = {
      id: 'Report.Report',
      name: 'Report',
      type: MetadataType.Report,
      properties: {},
      filePath: sourceRoot,
    };

    await registerAndGet('1c-metadata-tree.exportEmbeddedArtifact')(node);

    assert.deepStrictEqual(exportedRequest, {
      workspaceRoot,
      sourceRootXmlPath: sourceRoot,
      destinationDirectory: path.join(workspaceRoot, 'Report_external_src'),
    });
    assert.strictEqual(builtOptions?.rootXmlPath, rootXmlPath);
    assert.strictEqual(builtOptions?.destinationPath, destinationPath);
    assert.deepStrictEqual(builtOptions?.context, {
      kind: 'standalone',
      acknowledgeTypeLoss: true,
    });
    assert.ok(vscodeTestState.informationLog.some((message) => message.includes(projectDirectory)));
  });

  test('does not offer export for an adopted extension object', async () => {
    let exportCalls = 0;
    ExternalArtifactProjectService.prototype.exportEmbedded = async () => {
      exportCalls += 1;
      throw new Error('must not run');
    };
    const node: TreeNode = {
      id: 'DataProcessor.Borrowed',
      name: 'Borrowed',
      type: MetadataType.DataProcessor,
      properties: { objectBelonging: 'Adopted', extendedConfigurationObject: 'uuid' },
      filePath: path.resolve('workspace/Configuration/DataProcessors/Borrowed.xml'),
    };

    await registerAndGet('1c-metadata-tree.exportEmbeddedArtifact')(node);

    assert.strictEqual(exportCalls, 0);
    assert.ok(vscodeTestState.errorLog.some((message) => message.includes('заимствованный объект')));
  });

  test('does not export an own object nested under an extension root', async () => {
    let exportCalls = 0;
    ExternalArtifactProjectService.prototype.exportEmbedded = async () => {
      exportCalls += 1;
      throw new Error('must not run');
    };
    const extensionRootMarkers: Array<Pick<TreeNode, 'type' | 'properties'>> = [
      { type: MetadataType.Configuration, properties: { extensionPurpose: 'Customization' } },
      { type: MetadataType.Configuration, properties: { isExtension: true } },
      { type: MetadataType.Extension, properties: {} },
    ];
    const handler = registerAndGet('1c-metadata-tree.exportEmbeddedArtifact');
    for (const [index, marker] of extensionRootMarkers.entries()) {
      const extensionRoot: TreeNode = {
        id: `Extension.MyExtension${index}`,
        name: `MyExtension${index}`,
        ...marker,
        children: [],
      };
      const typeFolder: TreeNode = {
        id: `Extension.MyExtension${index}.DataProcessors`,
        name: 'DataProcessors',
        type: MetadataType.Unknown,
        properties: {},
        children: [],
        parent: extensionRoot,
      };
      const node: TreeNode = {
        id: `DataProcessor.Own${index}`,
        name: 'Own',
        type: MetadataType.DataProcessor,
        properties: {},
        filePath: path.resolve('workspace/Extension/DataProcessors/Own.xml'),
        children: [],
        parent: typeFolder,
      };
      await handler(node);
    }

    assert.strictEqual(exportCalls, 0);
    assert.strictEqual(
      vscodeTestState.errorLog.filter((message) => message.includes('конфигурации-расширения')).length,
      extensionRootMarkers.length
    );
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
