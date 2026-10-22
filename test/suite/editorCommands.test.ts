import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { registerEditorCommands } from '../../src/commands/editorCommands';
import { BindingManager } from '../../src/bindings/bindingManager';
import { CompositionEditorProvider } from '../../src/compositionEditor/compositionEditorProvider';
import { CommonAttributeStrategy } from '../../src/compositionEditor/strategies/commonAttributeStrategy';
import { ExchangePlanStrategy } from '../../src/compositionEditor/strategies/exchangePlanStrategy';
import { FilterCriterionStrategy } from '../../src/compositionEditor/strategies/filterCriterionStrategy';
import { FunctionalOptionStrategy } from '../../src/compositionEditor/strategies/functionalOptionStrategy';
import { SubsystemStrategy } from '../../src/compositionEditor/strategies/subsystemStrategy';
import { createEditorCommandsContext, type EditorCommandsContext } from '../../src/extension/extensionFeatureContexts';
import { InfobaseStorageService } from '../../src/infobases/infobaseStorageService';
import { PropertiesProvider } from '../../src/providers/propertiesProvider';
import { MetadataTreeDataProvider } from '../../src/providers/treeDataProvider';
import { TypeEditorProvider } from '../../src/providers/typeEditorProvider';
import { RolesRightsEditorProvider } from '../../src/rolesEditor/rolesRightsEditorProvider';
import { SubsystemCommandInterfaceProvider } from '../../src/subsystemCommandInterfaceEditor';
import { XdtoPackageEditorProvider } from '../../src/xdtoPackageEditor';
import { configureConfigurationMutationGateway } from '../../src/services/configurationSession/configurationMutationGateway';
import { ConfigurationSession } from '../../src/services/configurationSession/ConfigurationSession';
import { WorkspaceRegistry } from '../../src/services/configurationSession/WorkspaceRegistry';
import { ReloadCoordinatorService } from '../../src/services/reloadCoordinatorService';
import { createRequestConfigurationReload } from '../../src/reload/requestConfigurationReload';
import { reconcileAfterCommit } from '../../src/reload/reconciliation';
import { MetadataType } from '../../src/models/treeNode';
import { createExtensionStateFixture } from '../helpers/extensionStateFixture';
import { createFakeExtensionContext } from '../helpers/rightsEditorTestHarness';

let editorTreeViewId = 0;
const editorCommandTestDisposables: vscode.Disposable[] = [];

function createEditorCommandDependencies(
  treeDataProvider: MetadataTreeDataProvider = new MetadataTreeDataProvider(),
): { state: EditorCommandsContext; context: vscode.ExtensionContext } {
  const context = createFakeExtensionContext();
  const treeView = vscode.window.createTreeView(`editor-commands-test-${editorTreeViewId++}`, {
    treeDataProvider,
  });
  editorCommandTestDisposables.push(treeView);
  const propertiesProvider = new PropertiesProvider(
    context,
    treeDataProvider,
    new TypeEditorProvider(context),
  );
  const compositionDeps = {
    loadMetadataTree: async () => undefined,
    invalidateTreeCacheOnly: async () => undefined,
  };
  const infobaseStorage = new InfobaseStorageService(context.globalState, context.secrets);
  editorCommandTestDisposables.push(infobaseStorage);
  const stateFixture = createExtensionStateFixture({
    bindingManager: new BindingManager(),
    commonAttributeCompositionEditorProvider: new CompositionEditorProvider(
      context, compositionDeps, CommonAttributeStrategy,
    ),
    exchangePlanCompositionEditorProvider: new CompositionEditorProvider(
      context, compositionDeps, ExchangePlanStrategy,
    ),
    filterCriterionCompositionEditorProvider: new CompositionEditorProvider(
      context, compositionDeps, FilterCriterionStrategy,
    ),
    functionalOptionCompositionEditorProvider: new CompositionEditorProvider(
      context, compositionDeps, FunctionalOptionStrategy,
    ),
    infobaseStorage,
    propertiesProvider,
    rolesRightsEditorProvider: new RolesRightsEditorProvider(context),
    subsystemCommandInterfaceProvider: new SubsystemCommandInterfaceProvider(context),
    subsystemCompositionEditorProvider: new CompositionEditorProvider(
      context, compositionDeps, SubsystemStrategy,
    ),
    treeDataProvider,
    treeView,
    xdtoPackageEditorProvider: new XdtoPackageEditorProvider(context),
  }, context);
  return {
    state: createEditorCommandsContext(stateFixture.state, context),
    context,
  };
}

function registerEditorCommandsForTest(
  treeDataProvider?: MetadataTreeDataProvider,
): vscode.Disposable[] {
  const disposables = registerEditorCommands(createEditorCommandDependencies(treeDataProvider));
  editorCommandTestDisposables.push(...disposables);
  return disposables;
}

suite('editorCommands', () => {
  const defaultRegisterCommand = vscode.commands.registerCommand.bind(vscode.commands);
  const defaultShowWarningMessage = vscode.window.showWarningMessage.bind(vscode.window);
  const defaultExecuteCommand = vscode.commands.executeCommand.bind(vscode.commands);

  setup(() => {
    (vscode.commands as any).registerCommand = defaultRegisterCommand;
    (vscode.commands as any).executeCommand = defaultExecuteCommand;
    (vscode.window as any).showWarningMessage = defaultShowWarningMessage;
  });

  teardown(() => {
    for (const disposable of editorCommandTestDisposables.splice(0)) {
      disposable.dispose();
    }
    (vscode.commands as any).registerCommand = defaultRegisterCommand;
    (vscode.commands as any).executeCommand = defaultExecuteCommand;
    (vscode.window as any).showWarningMessage = defaultShowWarningMessage;
  });

  test('registers editor-related command handlers', () => {
    const ids: string[] = [];
    (vscode.commands as any).registerCommand = (id: string) => {
      ids.push(id);
      return { dispose: () => undefined };
    };

    const disposables = registerEditorCommandsForTest();

    assert.strictEqual(disposables.length, ids.length);
    assert.deepStrictEqual(ids, [
      '1c-metadata-tree.showProperties',
      '1c-metadata-tree.openXML',
      '1c-metadata-tree.openBslModule',
      '1c-metadata-tree.openFormEditor',
      '1c-metadata-tree.openRightsEditor',
      '1c-metadata-tree.openTemplatePreview',
      '1c-metadata-tree.saveRightsEditor',
      '1c-metadata-tree.validateCurrentXml',
      '1c-metadata-tree.editSubsystemComposition',
      '1c-metadata-tree.editExchangePlanContent',
      '1c-metadata-tree.editCommonAttributeContent',
      '1c-metadata-tree.editFunctionalOptionContent',
      '1c-metadata-tree.editFilterCriterionContent',
      '1c-metadata-tree.editSubsystemCommandInterface',
      '1c-metadata-tree.editXdtoPackageSchema',
      '1c-metadata-tree.exportXdtoPackageToXsd',
      '1c-metadata-tree.importXsdIntoXdtoPackage',
      '1c-metadata-tree.importXsdAsNewXdtoPackage',
      '1c-metadata-tree.compareMergeXdtoPackage',
      '1c-metadata-tree.viewChartOfCharacteristicTypesPredefined',
      '1c-metadata-tree.startDebugging',
      '1c-metadata-tree.queryBuilder',
      '1c-metadata-tree.queryBuilderWithProcessing',
      '1c-metadata-tree.queryBuilderForText',
    ]);
  });

  test('openBslModule opens with preview:false', async () => {
    const handlers: Record<string, (node: any) => Promise<void> | void> = {};
    (vscode.commands as any).registerCommand = (id: string, handler: any) => {
      handlers[id] = handler;
      return { dispose: () => undefined };
    };

    const showTextCalls: Array<{ uri: vscode.Uri; options: any }> = [];
    (vscode.window as any).showTextDocument = async (uri: vscode.Uri, options?: any) => {
      showTextCalls.push({ uri, options });
      return {} as any;
    };

    registerEditorCommandsForTest();

    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), '1cv-bsl-'));
    try {
      const bslPath = path.join(tmpRoot, 'Module.bsl');
      await fs.writeFile(bslPath, '', 'utf8');

      const node = {
        id: 'mod',
        name: 'mod',
        type: MetadataType.CommonModule,
        properties: {},
        filePath: bslPath,
      };

      await handlers['1c-metadata-tree.openBslModule'](node);

      assert.strictEqual(showTextCalls.length, 1, 'showTextDocument called once');
      assert.strictEqual(showTextCalls[0].options?.preview, false, 'preview:false for BSL module');
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      (vscode.window as any).showTextDocument = undefined;
    }
  });

  test('#206: openBslModule routes missing module file creation through runConfigurationMutation gateway', async () => {
    const handlers: Record<string, (node: any) => Promise<void> | void> = {};
    (vscode.commands as any).registerCommand = (id: string, handler: any) => {
      handlers[id] = handler;
      return { dispose: () => undefined };
    };

    (vscode.window as any).showTextDocument = async () => ({} as any);

    const intercepted: { path: string; kind: string }[] = [];
    const gateway = configureConfigurationMutationGateway(
      async (resourcePath, kind, op) => {
        intercepted.push({ path: resourcePath, kind });
        return op();
      },
      async (_p, plan) => plan.result,
    );

    registerEditorCommandsForTest();

    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), '1cv-bsl-gw-'));
    try {
      const bslPath = path.join(tmpRoot, 'NewModule.bsl');

      const node = {
        id: 'newmod',
        name: 'newmod',
        type: MetadataType.CommonModule,
        properties: { isVirtual: true },
        filePath: bslPath,
      };

      await handlers['1c-metadata-tree.openBslModule'](node);

      assert.strictEqual(intercepted.length, 1, 'Missing module creation must be intercepted by gateway');
      assert.strictEqual(intercepted[0].path, bslPath);
      assert.strictEqual(intercepted[0].kind, 'bslModule.create');
      assert.strictEqual(node.properties.isVirtual, false);
      const exists = await fs.access(bslPath).then(() => true, () => false);
      assert.strictEqual(exists, true);
    } finally {
      gateway.dispose();
      await fs.rm(tmpRoot, { recursive: true, force: true });
      (vscode.window as any).showTextDocument = undefined;
    }
  });

  test('#355: XDTO package creation reconciles the committed configuration through its targeted reload coordinator', async () => {
    const handlers: Record<string, (...args: any[]) => Promise<void> | void> = {};
    (vscode.commands as any).registerCommand = (id: string, handler: (...args: any[]) => Promise<void> | void) => {
      handlers[id] = handler;
      return { dispose: () => undefined };
    };

    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), '1cv-xdto-post-commit-'));
    const root = await fs.realpath(tempRoot);
    const configurationPath = path.join(root, 'Configuration.xml');
    const inputPath = path.join(root, 'NewPackage.xsd');
    await fs.writeFile(configurationPath,
      '<MetaDataObject version="2.20"><Configuration uuid="11111111-2222-3333-4444-555555555555"><ChildObjects/></Configuration></MetaDataObject>',
      'utf8');
    await fs.writeFile(inputPath,
      '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test"><xs:element name="Root" type="xs:string"/></xs:schema>',
      'utf8');

    let cachedPackagePresent = false;
    const loadedRoots: string[] = [];
    const coordinator = new ReloadCoordinatorService(async ({ configPath: requestedRoot }) => {
      loadedRoots.push(requestedRoot);
      const diskDescriptor = await fs.readFile(path.join(requestedRoot, 'Configuration.xml'), 'utf8');
      cachedPackagePresent = diskDescriptor.includes('<XDTOPackage>NewPackage</XDTOPackage>');
    }, { defaultDebounceMs: 0 });
    const reloadState = { reloadCoordinator: coordinator } as any;
    const requestConfigurationReload = createRequestConfigurationReload(reloadState);
    const registry = new WorkspaceRegistry(undefined, (identity) => new ConfigurationSession(
      identity,
      (commit) => reconcileAfterCommit(commit.rootPath, 'agent-mutation', requestConfigurationReload),
    ));
    const session = await registry.registerTargetedRoot({ configPath: root });
    const gateway = configureConfigurationMutationGateway(
      async (_resourcePath, _kind, operation) => operation(),
      async (_resourcePath, plan, options) => session.runPlanValue(plan, options),
    );

    const originalShowOpenDialog = vscode.window.showOpenDialog;
    const originalShowInputBox = vscode.window.showInputBox;
    (vscode.window as any).showOpenDialog = async () => [vscode.Uri.file(inputPath)];
    (vscode.window as any).showInputBox = async () => 'NewPackage';

    try {
      const treeDataProvider = new MetadataTreeDataProvider();
      treeDataProvider.getConfigPath = () => root;
      registerEditorCommandsForTest(treeDataProvider);

      await handlers['1c-metadata-tree.importXsdAsNewXdtoPackage']();

      assert.strictEqual(cachedPackagePresent, true, 'the stale in-memory view must be refreshed from committed disk state');
      assert.deepStrictEqual(loadedRoots, [root], 'reload must target the configuration root that accepted the plan');
      assert.strictEqual(session.snapshotVersion, 1, 'the UI plan is one top-level configuration commit');
      assert.ok((await fs.readFile(configurationPath, 'utf8')).includes('<XDTOPackage>NewPackage</XDTOPackage>'));
    } finally {
      vscode.window.showOpenDialog = originalShowOpenDialog;
      vscode.window.showInputBox = originalShowInputBox;
      gateway.dispose();
      await coordinator.dispose();
      await registry.dispose();
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('openXML opens with preview:false', async () => {
    const handlers: Record<string, (node: any) => Promise<void> | void> = {};
    (vscode.commands as any).registerCommand = (id: string, handler: any) => {
      handlers[id] = handler;
      return { dispose: () => undefined };
    };

    const showTextCalls: Array<{ uri: vscode.Uri; options: any }> = [];
    (vscode.window as any).showTextDocument = async (uri: vscode.Uri, options?: any) => {
      showTextCalls.push({ uri, options });
      return {} as any;
    };

    registerEditorCommandsForTest();

    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), '1cv-xml-'));
    try {
      const xmlPath = path.join(tmpRoot, 'Catalog.xml');
      await fs.writeFile(xmlPath, '<root/>', 'utf8');

      const node = {
        id: 'cat',
        name: 'cat',
        type: MetadataType.Catalog,
        properties: {},
        filePath: xmlPath,
      };

      await handlers['1c-metadata-tree.openXML'](node);

      assert.strictEqual(showTextCalls.length, 1, 'showTextDocument called once');
      assert.strictEqual(showTextCalls[0].options?.preview, false, 'preview:false for XML');
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      (vscode.window as any).showTextDocument = undefined;
    }
  });

  test('openFormEditor passes preview:false to vscode.openWith', async () => {
    const handlers: Record<string, (node: any) => Promise<void> | void> = {};
    (vscode.commands as any).registerCommand = (id: string, handler: any) => {
      handlers[id] = handler;
      return { dispose: () => undefined };
    };

    const executeCalls: Array<{ command: string; args: unknown[] }> = [];
    (vscode.commands as any).executeCommand = async (command: string, ...args: unknown[]) => {
      executeCalls.push({ command, args });
      return {} as any;
    };

    registerEditorCommandsForTest();

    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), '1cv-form-'));
    try {
      const formDir = path.join(tmpRoot, 'Forms', 'MyForm');
      await fs.mkdir(formDir, { recursive: true });
      const formXml = path.join(tmpRoot, 'Forms', 'MyForm.xml');
      await fs.writeFile(formXml, '<form/>', 'utf8');
      const innerXml = path.join(formDir, 'Ext', 'Form.xml');
      await fs.mkdir(path.dirname(innerXml), { recursive: true });
      await fs.writeFile(innerXml, '<form/>', 'utf8');

      const node = {
        id: 'frm',
        name: 'MyForm',
        type: MetadataType.Form,
        properties: {},
        filePath: formXml,
      };

      await handlers['1c-metadata-tree.openFormEditor'](node);

      const openWith = executeCalls.find((c) => c.command === 'vscode.openWith');
      assert.ok(openWith, 'vscode.openWith was called');
      assert.strictEqual(openWith!.args[1], '1c-form-editor', 'uses 1c-form-editor viewType');
      const opts = openWith!.args[2] as any;
      assert.strictEqual(opts?.preview, false, 'preview:false passed to openWith');
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('openTemplatePreview opens mxl preview with resolved Ext/Template.xml URI', async () => {
    const handlers: Record<string, (node: any) => Promise<void> | void> = {};

    (vscode.commands as any).registerCommand = (id: string, handler: any) => {
      handlers[id] = handler;
      return { dispose: () => undefined };
    };

    registerEditorCommandsForTest();

    const executeCalls: Array<{ command: string; args: unknown[] }> = [];
    (vscode.commands as any).executeCommand = async (command: string, ...args: unknown[]) => {
      executeCalls.push({ command, args });
      return {} as any;
    };

    const warningCalls: string[] = [];
    (vscode.window as any).showWarningMessage = async (message: string) => {
      warningCalls.push(message);
      return undefined;
    };

    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), '1cv-ed-cmd-'));
    try {
      const bodyPath = path.join(tmpRoot, 'Templates', 'tpl', 'Ext', 'Template.xml');
      await fs.mkdir(path.dirname(bodyPath), { recursive: true });
      await fs.writeFile(bodyPath, '<mxl/>', 'utf8');
      const descPath = path.join(tmpRoot, 'Templates', 'tpl.xml');

      const templateNode = {
        id: 'tpl',
        name: 'tpl',
        type: MetadataType.Template,
        properties: {},
        filePath: descPath,
      };

      await handlers['1c-metadata-tree.openTemplatePreview'](templateNode);

      const openWith = executeCalls.find((c) => c.command === 'vscode.openWith');
      assert.ok(openWith, 'vscode.openWith invoked');
      assert.strictEqual(openWith!.args[1], '1c-mxl-preview');
      const uri = openWith!.args[0] as vscode.Uri;
      assert.strictEqual(uri.fsPath, path.normalize(bodyPath));

      const wrongNode = {
        id: 'cat',
        name: 'cat',
        type: MetadataType.Catalog,
        properties: {},
        filePath: 'C:/tmp/catalog.xml',
      };

      await handlers['1c-metadata-tree.openTemplatePreview'](wrongNode);
      assert.ok(
        warningCalls.some((m) => m.includes('Preview макета доступен только')),
        'warns for non-template node'
      );
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('validateCurrentXml warns when no active editor', async () => {
    const handlers: Record<string, () => Promise<void> | void> = {};
    (vscode.commands as any).registerCommand = (id: string, handler: any) => {
      handlers[id] = handler;
      return { dispose: () => undefined };
    };
    const warnings: string[] = [];
    (vscode.window as any).showWarningMessage = async (m: string) => {
      warnings.push(m);
      return undefined;
    };
    (vscode.window as any).activeTextEditor = undefined;
    registerEditorCommandsForTest();
    await handlers['1c-metadata-tree.validateCurrentXml']();
    assert.ok(warnings.some((m) => m.includes('XML-файл')));
  });

  test('validateCurrentXml warns for non-xml editor', async () => {
    const handlers: Record<string, () => Promise<void> | void> = {};
    (vscode.commands as any).registerCommand = (id: string, handler: any) => {
      handlers[id] = handler;
      return { dispose: () => undefined };
    };
    const warnings: string[] = [];
    (vscode.window as any).showWarningMessage = async (m: string) => {
      warnings.push(m);
      return undefined;
    };
    (vscode.window as any).activeTextEditor = {
      document: { uri: vscode.Uri.file('C:/tmp/test.bsl') },
    };
    registerEditorCommandsForTest();
    await handlers['1c-metadata-tree.validateCurrentXml']();
    assert.ok(warnings.some((m) => m.includes('только для активного XML')));
  });
});
