import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { registerElementCommands } from '../../src/commands/elementCommands';
import { createElementCommandsContext } from '../../src/extension/extensionFeatureContexts';
import { MetadataType, TreeNode } from '../../src/models/treeNode';
import { MetadataTreeDataProvider } from '../../src/providers/treeDataProvider';
import { configureConfigurationMutationGateway } from '../../src/services/configurationSession/configurationMutationGateway';
import { ConfigurationSession } from '../../src/services/configurationSession/ConfigurationSession';
import type { MutationOutcome, MutationRequest } from '../../src/services/configurationSession/ConfigurationSession';
import { WorkspaceRegistry } from '../../src/services/configurationSession/WorkspaceRegistry';
import { cleanupTempDir, createTempDir } from '../helpers/testHelpers';
import { createExtensionStateFixture } from '../helpers/extensionStateFixture';

function createElementCommandsState(configPath: string) {
  const treeDataProvider = new MetadataTreeDataProvider();
  treeDataProvider.getConfigPath = () => configPath;
  treeDataProvider.getConfigPathForNode = () => configPath;
  const treeView = vscode.window.createTreeView('nested-gateway-test', { treeDataProvider });
  return createElementCommandsContext(createExtensionStateFixture({ treeDataProvider, treeView }).state);
}

suite('ConfigurationSession nested mutation gateway', () => {
  test('UI createForm completes through one real session FIFO entry', async () => {
    const tempRoot = await fs.promises.realpath(await createTempDir('configuration-session-ui-form-'));
    const configRoot = path.join(tempRoot, 'Config');
    const catalogDir = path.join(configRoot, 'Catalogs', 'Products');
    const formsDir = path.join(catalogDir, 'Forms');
    const configXmlPath = path.join(configRoot, 'Configuration.xml');
    const ownerXmlPath = path.join(configRoot, 'Catalogs', 'Products.xml');
    await fs.promises.mkdir(formsDir, { recursive: true });
    await fs.promises.writeFile(configXmlPath,
      '<?xml version="1.0" encoding="UTF-8"?><MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.16"><Configuration uuid="11111111-1111-1111-1111-111111111111"><Properties><Name>SessionTest</Name></Properties><ChildObjects><Catalog>Products</Catalog></ChildObjects></Configuration></MetaDataObject>',
      'utf8');
    await fs.promises.writeFile(ownerXmlPath,
      '<?xml version="1.0" encoding="UTF-8"?><MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.16"><Catalog uuid="22222222-2222-2222-2222-222222222222"><Properties><Name>Products</Name></Properties><ChildObjects/></Catalog></MetaDataObject>',
      'utf8');

    const registry = new WorkspaceRegistry();
    let sessionForCleanup: ConfigurationSession | undefined;
    let gateway: { dispose(): void } | undefined;
    let commandPromise: Promise<unknown> | undefined;
    let commandSettled = false;
    const shownErrors: string[] = [];
    let handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    const originalRegisterCommand = vscode.commands.registerCommand;
    const originalInputBox = vscode.window.showInputBox;
    const originalInformationMessage = vscode.window.showInformationMessage;
    const originalErrorMessage = vscode.window.showErrorMessage;
    const originalWarningMessage = vscode.window.showWarningMessage;
    const commandApi = vscode.commands as unknown as {
      registerCommand: (id: string, handler: (...args: unknown[]) => Promise<unknown>) => vscode.Disposable;
    };
    const windowApi = vscode.window as unknown as {
      showInputBox: (...args: unknown[]) => Promise<string | undefined>;
      showInformationMessage: (...args: unknown[]) => Promise<unknown>;
      showErrorMessage: (message: string, ...args: unknown[]) => Promise<unknown>;
      showWarningMessage: (message: string, ...args: unknown[]) => Promise<unknown>;
    };
    commandApi.registerCommand = (id, handler) => {
      handlers.set(id, handler);
      return { dispose: () => undefined };
    };
    windowApi.showInputBox = async () => 'PrimaryForm';
    windowApi.showInformationMessage = async () => undefined;
    windowApi.showErrorMessage = async (message) => {
      shownErrors.push(message);
      return undefined;
    };
    windowApi.showWarningMessage = async () => undefined;

    try {
      const session = await registry.registerTargetedRoot({ configPath: configRoot });
      sessionForCleanup = session;
      let enqueueCalls = 0;
      const sessionInternals = session as unknown as {
        enqueue: <T>(request: MutationRequest<T>) => Promise<MutationOutcome<T>>;
        queue: unknown[];
        runningWriters: number;
        processQueue: () => void;
      };
      const enqueue = session.enqueue.bind(session);
      sessionInternals.enqueue = <T>(request: MutationRequest<T>) => {
        enqueueCalls++;
        return enqueue(request);
      };

      gateway = configureConfigurationMutationGateway(
        async (resourcePath, kind, operation) => {
          const owner = await registry.resolveResource(resourcePath);
          return owner.runMutationValue({ kind, execute: operation }, {
            failureMessage: 'Операция конфигурации не выполнена.',
            cancelledMessage: 'Операция конфигурации отменена.',
          });
        },
        async (resourcePath, plan) => {
          const owner = await registry.resolveResource(resourcePath);
          return owner.runPlanValue(plan);
        },
      );

      const catalogNode: TreeNode = {
        id: 'Catalog.Products',
        name: 'Products',
        type: MetadataType.Catalog,
        filePath: ownerXmlPath,
        properties: {},
      };
      const formsNode: TreeNode = {
        id: 'Forms',
        name: 'Forms',
        type: MetadataType.Form,
        filePath: formsDir,
        properties: {},
        parent: catalogNode,
      };
      registerElementCommands({
        state: createElementCommandsState(configRoot),
        loadMetadataTree: async () => undefined,
        requestConfigurationReload: async () => undefined,
        scheduleDeleteReconcile: () => undefined,
      });

      const createForm = handlers.get('1c-metadata-tree.createForm');
      assert.ok(createForm, 'UI createForm handler should be registered');
      commandPromise = createForm(formsNode);
      void commandPromise.finally(() => { commandSettled = true; });

      const completed = await Promise.race([
        commandPromise.then(() => true, () => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
      ]);
      const nestedQueueLength = sessionInternals.queue.length;
      assert.ok(
        completed,
        `UI createForm must finish rather than waiting on its own session FIFO (enqueues=${enqueueCalls}, queued=${nestedQueueLength})`,
      );
      assert.strictEqual(nestedQueueLength, 0, 'the plan must execute inside the active session lease');
      assert.strictEqual(enqueueCalls, 1, 'the callback and its plan must share one FIFO entry');
      assert.deepStrictEqual(shownErrors, [], 'UI form creation should report no mutation errors');
      assert.strictEqual(session.snapshotVersion, 1, 'a nested plan must advance the session snapshot only once');
      assert.strictEqual(fs.existsSync(path.join(formsDir, 'PrimaryForm.xml')), true);
      assert.strictEqual(fs.existsSync(path.join(formsDir, 'PrimaryForm', 'Ext', 'Form.xml')), true);
      assert.strictEqual(fs.existsSync(path.join(formsDir, 'PrimaryForm', 'Ext', 'Form', 'Module.bsl')), true);
    } finally {
      if (commandPromise && !commandSettled) {
        const session = sessionForCleanup;
        if (session) {
          const internals = session as unknown as { queue: unknown[]; runningWriters: number; processQueue: () => void };
          if (internals.queue.length > 0 && internals.runningWriters > 0) {
            // Release the baseline deadlock after the failed assertion so teardown remains bounded.
            internals.runningWriters = 0;
            internals.processQueue();
          }
        }
        await Promise.race([
          commandPromise.catch(() => undefined),
          new Promise<void>((resolve) => setTimeout(resolve, 2000)),
        ]);
      }
      gateway?.dispose();
      await registry.dispose();
      commandApi.registerCommand = originalRegisterCommand;
      windowApi.showInputBox = originalInputBox as unknown as (...args: unknown[]) => Promise<string | undefined>;
      windowApi.showInformationMessage = originalInformationMessage as unknown as (...args: unknown[]) => Promise<unknown>;
      windowApi.showErrorMessage = originalErrorMessage as unknown as (message: string, ...args: unknown[]) => Promise<unknown>;
      windowApi.showWarningMessage = originalWarningMessage as unknown as (message: string, ...args: unknown[]) => Promise<unknown>;
      handlers = new Map();
      await cleanupTempDir(tempRoot);
    }
  });
});
