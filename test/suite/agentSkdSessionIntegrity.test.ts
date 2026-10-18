import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import '../helpers/vscodeStubRegister';
import { registerAgentCommands } from '../../src/agent/agentCommands';
import { SkdOperations, type SkdOperationsDeps } from '../../src/agent/agentSkdOperations';
import { DebugSessionRegistry } from '../../src/agent/debugSessionRegistry';
import { WorkspaceRegistry } from '../../src/services/configurationSession/WorkspaceRegistry';
import type { AgentResult } from '../../src/agent/types';
import type { ReloadReason } from '../../src/types/reloadContracts';
import { resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';

suite('Agent SKD Session Integrity, Workspace Boundaries & Reload (#352)', () => {
  let tempDir: string;
  let configRoot: string;
  let outsideDir: string;
  let registry: WorkspaceRegistry;
  let reloadsRequested: Array<{ configPath: string; reason: ReloadReason }>;

  const fakeRunner = async (opts: { scriptPath: string; args: string[] }) => {
    const isCompile = opts.scriptPath.includes('skd-compile');
    const isEdit = opts.scriptPath.includes('skd-edit');
    const isInfo = opts.scriptPath.includes('skd-info');
    const isValidate = opts.scriptPath.includes('skd-validate');

    if (isCompile) {
      const outIdx = opts.args.indexOf('-OutputPath');
      const outPath = outIdx >= 0 ? opts.args[outIdx + 1] : '/dummy/out.xml';
      return {
        exitCode: 0,
        stdout: `OK  ${outPath}\n    DataSets: 1  Fields: 2  Calculated: 0  Totals: 0  Params: 0  Variants: 1\n    Size: 100 bytes`,
        stderr: '',
      };
    }
    if (isEdit) {
      const tmplIdx = opts.args.indexOf('-TemplatePath');
      const tmplPath = tmplIdx >= 0 ? opts.args[tmplIdx + 1] : '/dummy/Template.xml';
      return {
        exitCode: 0,
        stdout: `[OK] Saved ${tmplPath}`,
        stderr: '',
      };
    }
    if (isInfo) {
      return {
        exitCode: 0,
        stdout: 'SKD Structure Info: 1 DataSet, 2 Fields',
        stderr: '',
      };
    }
    if (isValidate) {
      return {
        exitCode: 0,
        stdout: 'Validation passed successfully: 0 errors',
        stderr: '',
      };
    }
    return { exitCode: 0, stdout: 'OK', stderr: '' };
  };

  setup(async () => {
    resetVscodeTestState();
    tempDir = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cdt-skd-session-')));
    configRoot = path.join(tempDir, 'configuration');
    outsideDir = path.join(tempDir, 'outside');
    await fs.promises.mkdir(configRoot, { recursive: true });
    await fs.promises.mkdir(outsideDir, { recursive: true });

    await fs.promises.writeFile(
      path.join(configRoot, 'Configuration.xml'),
      '<MetaDataObject version="2.20"><Configuration uuid="11111111-2222-3333-4444-555555555555"><ChildObjects/></Configuration></MetaDataObject>',
      'utf8',
    );

    const templateDir = path.join(configRoot, 'Catalogs', 'Items', 'Templates', 'MainSchema', 'Ext');
    await fs.promises.mkdir(templateDir, { recursive: true });
    await fs.promises.writeFile(path.join(templateDir, 'Template.xml'), '<DataCompositionSchema/>', 'utf8');

    registry = new WorkspaceRegistry();
    await registry.refresh([{ configPath: configRoot }]);

    reloadsRequested = [];
  });

  teardown(async () => {
    await registry.dispose();
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    resetVscodeTestState();
  });

  function setupAgentCommands(requestConfigurationReload?: (configPath: string, reason: ReloadReason) => Promise<void>) {
    const context = { extensionPath: tempDir, subscriptions: [] as vscode.Disposable[] };
    const debugRegistry = new DebugSessionRegistry();
    registerAgentCommands(
      context as never,
      () => null,
      async () => registry,
      debugRegistry,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      requestConfigurationReload ? () => requestConfigurationReload : undefined,
      () => ({ runPowerShellScript: fakeRunner as never }),
    );
    return context;
  }

  suite('1. Workspace Boundary Validation in SkdOperations', () => {
    test('skdCompile rejects outputPath outside configRoot', async () => {
      const ops = new SkdOperations({
        extensionPath: tempDir,
        configRoot,
        runPowerShellScript: fakeRunner as never,
      });

      const traversal = await ops.skdCompile({
        outputPath: path.join(outsideDir, 'malicious.xml'),
        value: '<Schema/>',
      });
      assert.strictEqual(traversal.success, false);
      assert.ok(
        traversal.code === 'PATH_OUTSIDE_ROOT' || traversal.code === 'PATH_TRAVERSAL',
        `Expected boundary code, got ${traversal.code}`,
      );

      const relTraversal = await ops.skdCompile({
        outputPath: '../../escaped.xml',
        value: '<Schema/>',
      });
      assert.strictEqual(relTraversal.success, false);
    });

    test('skdCompile rejects definitionFile with path traversal', async () => {
      const ops = new SkdOperations({
        extensionPath: tempDir,
        configRoot,
        runPowerShellScript: fakeRunner as never,
      });

      const result = await ops.skdCompile({
        outputPath: path.join(configRoot, 'Catalogs', 'Items', 'Templates', 'MainSchema', 'Ext', 'Template.xml'),
        definitionFile: '../../stolen.json',
      });
      assert.strictEqual(result.success, false);
    });

    test('skdEdit rejects templatePath outside configRoot', async () => {
      const ops = new SkdOperations({
        extensionPath: tempDir,
        configRoot,
        runPowerShellScript: fakeRunner as never,
      });

      const result = await ops.skdEdit({
        templatePath: path.join(outsideDir, 'ForeignTemplate.xml'),
        operation: 'set-query',
        value: 'SELECT 1',
      });
      assert.strictEqual(result.success, false);
      assert.ok(result.code === 'PATH_OUTSIDE_ROOT' || result.code === 'PATH_TRAVERSAL');
    });

    test('skdInfo and skdValidate reject templatePath or outFile outside configRoot', async () => {
      const ops = new SkdOperations({
        extensionPath: tempDir,
        configRoot,
        runPowerShellScript: fakeRunner as never,
      });

      const infoResult = await ops.skdInfo({
        templatePath: path.join(outsideDir, 'ForeignTemplate.xml'),
      });
      assert.strictEqual(infoResult.success, false);

      const infoOutResult = await ops.skdInfo({
        templatePath: path.join(configRoot, 'Catalogs', 'Items', 'Templates', 'MainSchema', 'Ext', 'Template.xml'),
        outFile: path.join(outsideDir, 'dump.txt'),
      });
      assert.strictEqual(infoOutResult.success, false);

      const validateResult = await ops.skdValidate({
        templatePath: path.join(outsideDir, 'ForeignTemplate.xml'),
      });
      assert.strictEqual(validateResult.success, false);

      const validateOutResult = await ops.skdValidate({
        templatePath: path.join(configRoot, 'Catalogs', 'Items', 'Templates', 'MainSchema', 'Ext', 'Template.xml'),
        outFile: '../../dump.txt',
      });
      assert.strictEqual(validateOutResult.success, false);
    });
  });

  suite('2. ConfigurationSession Routing & Locks in Agent Commands', () => {
    test('skd.compile acquires write lock and resolves session from outputPath', async () => {
      setupAgentCommands();
      const handler = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.skd.compile')!;
      const validOutputPath = path.join(configRoot, 'Catalogs', 'Items', 'Templates', 'MainSchema', 'Ext', 'Template.xml');

      const result = await handler({
        outputPath: validOutputPath,
        value: '<Schema/>',
      }) as AgentResult;

      assert.strictEqual(result.success, true, result.error);
      assert.ok(result.configurationId, 'Expected configurationId to be populated by session');
      assert.ok(result.operationId, 'Expected operationId to be populated by write session mutation');
      assert.strictEqual(typeof result.snapshotVersion, 'number');
    });

    test('skd.edit acquires write lock and resolves session from templatePath', async () => {
      setupAgentCommands();
      const handler = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.skd.edit')!;
      const validTemplatePath = path.join(configRoot, 'Catalogs', 'Items', 'Templates', 'MainSchema', 'Ext', 'Template.xml');

      const result = await handler({
        templatePath: validTemplatePath,
        operation: 'set-query',
        value: 'SELECT 1',
      }) as AgentResult;

      assert.strictEqual(result.success, true, result.error);
      assert.ok(result.configurationId, 'Expected configurationId to be populated by session');
      assert.ok(result.operationId, 'Expected operationId to be populated by write session mutation');
      assert.strictEqual(typeof result.snapshotVersion, 'number');
    });

    test('skd.info and skd.validate acquire read lock without operationId', async () => {
      setupAgentCommands();
      const validTemplatePath = path.join(configRoot, 'Catalogs', 'Items', 'Templates', 'MainSchema', 'Ext', 'Template.xml');

      const infoHandler = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.skd.info')!;
      const infoResult = await infoHandler({
        templatePath: validTemplatePath,
      }) as AgentResult;

      assert.strictEqual(infoResult.success, true, infoResult.error);
      assert.ok(infoResult.configurationId);
      assert.strictEqual(infoResult.operationId, undefined, 'Read operations must not generate an operationId');
      assert.strictEqual(typeof infoResult.snapshotVersion, 'number');

      const validateHandler = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.skd.validate')!;
      const validateResult = await validateHandler({
        templatePath: validTemplatePath,
      }) as AgentResult;

      assert.strictEqual(validateResult.success, true, validateResult.error);
      assert.ok(validateResult.configurationId);
      assert.strictEqual(validateResult.operationId, undefined, 'Read operations must not generate an operationId');
      assert.strictEqual(typeof validateResult.snapshotVersion, 'number');
    });

    test('rejects commands when target path does not belong to any configuration', async () => {
      setupAgentCommands();
      const handler = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.skd.info')!;

      const result = await handler({
        templatePath: path.join(outsideDir, 'Unrelated.xml'),
      }) as AgentResult;

      assert.strictEqual(result.success, false);
      assert.ok(
        result.code === 'CONFIGURATION_NOT_FOUND' || result.code === 'PATH_OUTSIDE_ROOT',
        `Expected failure code, got ${result.code}`,
      );
    });
  });

  suite('3. ReloadCoordinator Reconciliation after SKD Mutation', () => {
    test('successful skd.compile triggers ReloadCoordinator with skd-mutation reason', async () => {
      setupAgentCommands(async (cPath, reason) => {
        reloadsRequested.push({ configPath: cPath, reason });
      });

      const handler = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.skd.compile')!;
      const validOutputPath = path.join(configRoot, 'Catalogs', 'Items', 'Templates', 'MainSchema', 'Ext', 'Template.xml');

      const result = await handler({
        outputPath: validOutputPath,
        value: '<Schema/>',
      }) as AgentResult;

      assert.strictEqual(result.success, true, result.error);
      assert.strictEqual(reloadsRequested.length, 1);
      assert.strictEqual(reloadsRequested[0].configPath, configRoot);
      assert.strictEqual(reloadsRequested[0].reason, 'skd-mutation');
    });

    test('successful skd.edit triggers ReloadCoordinator with skd-mutation reason', async () => {
      setupAgentCommands(async (cPath, reason) => {
        reloadsRequested.push({ configPath: cPath, reason });
      });

      const handler = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.skd.edit')!;
      const validTemplatePath = path.join(configRoot, 'Catalogs', 'Items', 'Templates', 'MainSchema', 'Ext', 'Template.xml');

      const result = await handler({
        templatePath: validTemplatePath,
        operation: 'set-query',
        value: 'SELECT 1',
      }) as AgentResult;

      assert.strictEqual(result.success, true, result.error);
      assert.strictEqual(reloadsRequested.length, 1);
      assert.strictEqual(reloadsRequested[0].configPath, configRoot);
      assert.strictEqual(reloadsRequested[0].reason, 'skd-mutation');
    });

    test('skd.info and skd.validate do not trigger reload', async () => {
      setupAgentCommands(async (cPath, reason) => {
        reloadsRequested.push({ configPath: cPath, reason });
      });

      const validTemplatePath = path.join(configRoot, 'Catalogs', 'Items', 'Templates', 'MainSchema', 'Ext', 'Template.xml');
      const infoHandler = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.skd.info')!;
      await infoHandler({ templatePath: validTemplatePath });

      const validateHandler = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.skd.validate')!;
      await validateHandler({ templatePath: validTemplatePath });

      assert.strictEqual(reloadsRequested.length, 0);
    });
  });
});
