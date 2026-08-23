import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import '../helpers/vscodeStubRegister';
import {
  DeployService,
  type DeployRunSummary,
} from '../../src/bindings/deployService';
import type { ConfigurationBinding } from '../../src/bindings/models/configurationBinding';
import type { InfobaseEntry } from '../../src/infobases/models/infobaseEntry';
import { findBinding } from '../../src/agent/agentBindingResolver';
import { resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';

suite('Agent deploy partial result projection', () => {
  setup(() => resetVscodeTestState());

  teardown(() => resetVscodeTestState());

  test('partial UI summary stays unsuccessful and preserves skipped files in Agent data', async () => {
    const original = DeployService.prototype.deployChangedFiles;
    const summary: DeployRunSummary = {
      results: [{
        infobaseId: 'ib-1',
        name: 'Base',
        status: 'skipped',
        message: 'partially applied',
        skippedFiles: ['CommonModules/Locked.xml'],
      }],
      successCount: 0,
      errorCount: 0,
      skippedCount: 1,
      hasPartial: true,
      cancelledMidChain: false,
    };
    DeployService.prototype.deployChangedFiles = async () => summary;
    try {
      const { AgentDeployOperations } = await import('../../src/agent/agentDeployOperations');
      const binding: ConfigurationBinding = {
        workspaceFolder: 'ws',
        configRelativePath: 'Configuration.xml',
        infobaseIds: ['ib-1'],
        massDeployment: false,
      };
      const catalog: InfobaseEntry[] = [{
        id: 'ib-1',
        name: 'Base',
        type: 'file',
        filePath: 'C:/base',
        hasStoredPassword: false,
        createdAt: '2026-07-29T00:00:00.000Z',
      }];
      const operations = new AgentDeployOperations({
        bindingManager: {} as never,
        infobaseStorage: {} as never,
        getConfigPath: () => null,
      });
      Reflect.set(operations, 'resolveDeployContext', async () => ({
        success: true,
        data: {
          configRoot: 'C:/configuration',
          binding,
          entries: catalog,
          catalog,
          workspaceFolderRoot: 'C:/workspace',
        },
      }));

      const result = await operations.deploySelectedObjects({
        files: ['CommonModules/Locked.xml'],
      });

      assert.strictEqual(result.success, false);
      assert.ok(result.data, result.error);
      assert.strictEqual(result.data?.summary.hasPartial, true);
      assert.strictEqual(result.data?.summary.skipped, 1);
      assert.deepStrictEqual(
        result.data?.results[0]?.skippedFiles,
        ['CommonModules/Locked.xml'],
      );
      assert.ok(result.error);
    } finally {
      DeployService.prototype.deployChangedFiles = original;
    }
  });

  test('binding resolver selects the deepest CFE binding and exposes its extension name', async () => {
    const base: ConfigurationBinding = {
      workspaceFolder: 'ws',
      configRelativePath: 'Configuration.xml',
      infobaseIds: ['ib-1'],
      massDeployment: false,
    };
    const extension: ConfigurationBinding = {
      workspaceFolder: 'ws',
      configRelativePath: 'ConfigurationExtensions/SalesPatch/Configuration.xml',
      infobaseIds: ['ib-1'],
      massDeployment: false,
      ibcmdExtensionName: 'SalesPatch',
    };
    const matched = findBinding(
      'ConfigurationExtensions/SalesPatch/Catalogs/Goods.xml',
      [base, extension],
    );
    assert.strictEqual(matched, extension);

    const { listBindingsCommand, resolveBindingCommand } = await import('../../src/agent/agentBindingResolver');
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-cfe-binding-'));
    try {
      vscodeTestState.mockWorkspaceFolders = [{
        name: 'ws',
        index: 0,
        uri: { fsPath: root, scheme: 'file' },
      }];
      assert.strictEqual(
        findBinding('ConfigurationExtensions/SalesPatch/Catalogs/Goods.xml', [base, extension]),
        extension,
        'relative CFE path must resolve with a configured workspace folder',
      );
      const result = await resolveBindingCommand(
        { configPath: path.join(root, 'ConfigurationExtensions', 'SalesPatch', 'Catalogs', 'Goods.xml') },
        {
          bindingManager: { listAll: async () => [base, extension] },
          infobaseStorage: { load: async () => [] },
          getConfigPath: () => null,
        } as never,
      );
      assert.strictEqual(result.success, true, result.error);
      assert.strictEqual(result.data?.ibcmdExtensionName, 'SalesPatch');
      assert.strictEqual(
        result.data?.configRelativePath,
        'ConfigurationExtensions/SalesPatch/Configuration.xml',
      );
      const listed = await listBindingsCommand({
        bindingManager: { listAll: async () => [base, extension] },
        infobaseStorage: { load: async () => [] },
      } as never);
      assert.strictEqual(listed.data?.[1]?.ibcmdExtensionName, 'SalesPatch');
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  test('deploy resolver does not fall back from an unbound nested CFE to its base CF', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-cfe-deploy-'));
    try {
      const extensionRoot = path.join(root, 'ConfigurationExtensions', 'SalesPatch');
      await fs.promises.mkdir(extensionRoot, { recursive: true });
      await fs.promises.writeFile(path.join(root, 'Configuration.xml'), '<Configuration/>', 'utf8');
      await fs.promises.writeFile(path.join(extensionRoot, 'Configuration.xml'), '<Configuration/>', 'utf8');
      vscodeTestState.mockWorkspaceFolders = [{
        name: 'ws',
        index: 0,
        uri: { fsPath: root, scheme: 'file' },
      }];
      const base: ConfigurationBinding = {
        workspaceFolder: 'ws',
        configRelativePath: 'Configuration.xml',
        infobaseIds: ['ib-1'],
        massDeployment: false,
      };
      assert.strictEqual(
        findBinding(path.join(extensionRoot, 'Catalogs', 'Goods.xml'), [base]),
        undefined,
        'nested CFE path must not resolve to the base binding on case-sensitive platforms',
      );
      const catalog: InfobaseEntry[] = [{
        id: 'ib-1', name: 'Base', type: 'file', filePath: root,
        hasStoredPassword: false, createdAt: '2026-08-23T00:00:00.000Z',
      }];
      const { AgentDeployOperations } = await import('../../src/agent/agentDeployOperations');
      const operations = new AgentDeployOperations({
        bindingManager: { listAll: async () => [base] } as never,
        infobaseStorage: { load: async () => catalog } as never,
        getConfigPath: () => null,
      });

      const resolver = Reflect.get(operations, 'resolveDeployContext') as (configPath: string) => Promise<{
        success: boolean;
        error?: string;
      }>;
      const result = await resolver.call(operations, path.join(extensionRoot, 'Catalogs', 'Goods.xml'));
      assert.strictEqual(result.success, false);
      assert.match(result.error ?? '', /привязка базы/i);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  test('exportStatus forwards the binding extension name to ibcmd', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-cfe-status-'));
    const configDumpInfoPath = path.join(root, 'ConfigDumpInfo.xml');
    await fs.promises.writeFile(configDumpInfoPath, '<ConfigDumpInfo/>', 'utf8');
    const commands = await import('../../src/infobases/infobaseConfigCommands');
    const original = commands.runInfobaseConfigExportStatus;
    let passedExtensionName: string | undefined;
    const stub: typeof original = async (params) => {
      passedExtensionName = params.ibcmdExtensionName;
      return { status: 'success', exitCode: 0, userMessage: 'ok', logExcerpt: '' };
    };
    (commands as { runInfobaseConfigExportStatus: typeof original }).runInfobaseConfigExportStatus = stub;
    try {
      const { AgentDeployOperations } = await import('../../src/agent/agentDeployOperations');
      const binding: ConfigurationBinding = {
        workspaceFolder: 'ws',
        configRelativePath: 'ConfigurationExtensions/SalesPatch/Configuration.xml',
        infobaseIds: ['ib-1'],
        massDeployment: false,
        ibcmdExtensionName: 'SalesPatch',
      };
      const entry: InfobaseEntry = {
        id: 'ib-1', name: 'Base', type: 'file', filePath: root,
        hasStoredPassword: false, createdAt: '2026-08-23T00:00:00.000Z',
      };
      const operations = new AgentDeployOperations({
        bindingManager: {} as never,
        infobaseStorage: {} as never,
        getConfigPath: () => null,
      });
      Reflect.set(operations, 'resolveDeployContext', async () => ({
        success: true,
        data: {
          configRoot: root,
          binding,
          entries: [entry],
          catalog: [entry],
          workspaceFolderRoot: root,
        },
      }));

      const result = await operations.exportStatus({});
      assert.strictEqual(result.success, true, result.error);
      assert.strictEqual(passedExtensionName, 'SalesPatch');
    } finally {
      (commands as { runInfobaseConfigExportStatus: typeof original }).runInfobaseConfigExportStatus = original;
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});
