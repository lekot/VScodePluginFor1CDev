import '../helpers/vscodeStubRegister';
import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  publishExportedObjectsTree,
} from '../../src/infobases/exportedObjectsTreePublisher';
import { DeployService } from '../../src/bindings/deployService';
import {
  configureConfigurationMutationGateway,
  resetConfigurationMutationGateway,
} from '../../src/services/configurationSession/configurationMutationGateway';
import { vscodeTestState } from '../helpers/vscodeModuleStub';
import { resetIbcmdServiceSingletonForTests } from '../../src/services/ibcmd/ibcmdServiceSingleton';
import type { InfobaseEntry } from '../../src/infobases/models/infobaseEntry';
import type { ConfigurationBinding } from '../../src/bindings/models/configurationBinding';
import type { InfobaseStorageService } from '../../src/infobases/infobaseStorageService';
import { MetadataType } from '../../src/models/treeNode';

suite('pullSelectedObjects integrity and atomic publishing', () => {
  let rootTestDir: string;

  setup(async () => {
    rootTestDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-pull-test-'));
    resetConfigurationMutationGateway();
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.path'] = process.execPath;
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.autoDetect'] = false;
    resetIbcmdServiceSingletonForTests();
  });

  teardown(async () => {
    resetIbcmdServiceSingletonForTests();
    resetConfigurationMutationGateway();
    try {
      await fs.rm(rootTestDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  });

  test('publishExportedObjectsTree atomically replaces object XML and companion directory without disturbing siblings', async () => {
    const source = path.join(rootTestDir, 'source');
    const destination = path.join(rootTestDir, 'destination');

    // Create source with exported Catalog1 and CommonModule1
    await fs.mkdir(path.join(source, 'Catalogs', 'Catalog1', 'Forms', 'Form1'), { recursive: true });
    await fs.writeFile(path.join(source, 'Catalogs', 'Catalog1.xml'), '<Catalog1_New/>', 'utf8');
    await fs.writeFile(path.join(source, 'Catalogs', 'Catalog1', 'Forms', 'Form1', 'Form.xml'), '<Form1_New/>', 'utf8');
    await fs.mkdir(path.join(source, 'CommonModules'), { recursive: true });
    await fs.writeFile(path.join(source, 'CommonModules', 'Module1.xml'), '<Module1_New/>', 'utf8');
    await fs.writeFile(path.join(source, 'ConfigDumpInfo.xml'), '<ConfigDumpInfo_New/>', 'utf8');

    // Create destination with pre-existing Catalog1 (old), Catalog2 (sibling), and unrelated files
    await fs.mkdir(path.join(destination, 'Catalogs', 'Catalog1', 'Forms', 'OldForm'), { recursive: true });
    await fs.writeFile(path.join(destination, 'Catalogs', 'Catalog1.xml'), '<Catalog1_Old/>', 'utf8');
    await fs.writeFile(path.join(destination, 'Catalogs', 'Catalog1', 'Forms', 'OldForm', 'Form.xml'), '<OldForm/>', 'utf8');

    await fs.mkdir(path.join(destination, 'Catalogs', 'Catalog2', 'Forms', 'Form2'), { recursive: true });
    await fs.writeFile(path.join(destination, 'Catalogs', 'Catalog2.xml'), '<Catalog2_Untouched/>', 'utf8');
    await fs.writeFile(path.join(destination, 'Catalogs', 'Catalog2', 'Forms', 'Form2', 'Form.xml'), '<Form2_Untouched/>', 'utf8');

    await fs.mkdir(path.join(destination, 'Documents', 'Doc1'), { recursive: true });
    await fs.writeFile(path.join(destination, 'Documents', 'Doc1.xml'), '<Doc1/>', 'utf8');
    await fs.writeFile(path.join(destination, 'README.md'), 'Keep user markdown', 'utf8');
    await fs.writeFile(path.join(destination, 'ConfigDumpInfo.xml'), '<ConfigDumpInfo_Old/>', 'utf8');

    const copiedCount = await publishExportedObjectsTree(source, destination);
    assert.ok(copiedCount > 0, 'Must report copied count');

    // 1. Exported Catalog1 is updated
    assert.strictEqual(await fs.readFile(path.join(destination, 'Catalogs', 'Catalog1.xml'), 'utf8'), '<Catalog1_New/>');
    assert.strictEqual(
      await fs.readFile(path.join(destination, 'Catalogs', 'Catalog1', 'Forms', 'Form1', 'Form.xml'), 'utf8'),
      '<Form1_New/>',
    );

    // 2. Orphan cleanup: OldForm in Catalog1 was deleted in infobase, must NOT exist in workspace
    await assert.rejects(
      fs.access(path.join(destination, 'Catalogs', 'Catalog1', 'Forms', 'OldForm')),
      'Orphaned old form directory must be removed during replacement',
    );

    // 3. Sibling Catalog2 in Catalogs directory is completely preserved
    assert.strictEqual(await fs.readFile(path.join(destination, 'Catalogs', 'Catalog2.xml'), 'utf8'), '<Catalog2_Untouched/>');
    assert.strictEqual(
      await fs.readFile(path.join(destination, 'Catalogs', 'Catalog2', 'Forms', 'Form2', 'Form.xml'), 'utf8'),
      '<Form2_Untouched/>',
    );

    // 4. Other categories and workspace files are completely preserved
    assert.strictEqual(await fs.readFile(path.join(destination, 'Documents', 'Doc1.xml'), 'utf8'), '<Doc1/>');
    assert.strictEqual(await fs.readFile(path.join(destination, 'README.md'), 'utf8'), 'Keep user markdown');

    // 5. CommonModule1 and ConfigDumpInfo are updated
    assert.strictEqual(await fs.readFile(path.join(destination, 'CommonModules', 'Module1.xml'), 'utf8'), '<Module1_New/>');
    assert.strictEqual(await fs.readFile(path.join(destination, 'ConfigDumpInfo.xml'), 'utf8'), '<ConfigDumpInfo_New/>');
  });

  test('publishExportedObjectsTree cleans up companion folder when object has no children in infobase', async () => {
    const source = path.join(rootTestDir, 'source');
    const destination = path.join(rootTestDir, 'destination');

    // In source, Catalog1 has only .xml and NO companion folder
    await fs.mkdir(path.join(source, 'Catalogs'), { recursive: true });
    await fs.writeFile(path.join(source, 'Catalogs', 'Catalog1.xml'), '<Catalog1_NoChildren/>', 'utf8');

    // In destination, Catalog1 had an old companion folder
    await fs.mkdir(path.join(destination, 'Catalogs', 'Catalog1', 'Ext'), { recursive: true });
    await fs.writeFile(path.join(destination, 'Catalogs', 'Catalog1.xml'), '<Catalog1_Old/>', 'utf8');
    await fs.writeFile(path.join(destination, 'Catalogs', 'Catalog1', 'Ext', 'Predefined.xml'), '<Old/>', 'utf8');

    await publishExportedObjectsTree(source, destination);

    assert.strictEqual(await fs.readFile(path.join(destination, 'Catalogs', 'Catalog1.xml'), 'utf8'), '<Catalog1_NoChildren/>');
    // Companion directory must be cleaned up because it no longer exists in source
    await assert.rejects(
      fs.access(path.join(destination, 'Catalogs', 'Catalog1')),
      'Empty/deleted companion directory should not remain in destination',
    );
  });

  test('publishExportedObjectsTree rolls back to pre-export state if installation fails midway', async () => {
    const source = path.join(rootTestDir, 'source');
    const destination = path.join(rootTestDir, 'destination');

    await fs.mkdir(path.join(source, 'Catalogs', 'Catalog1'), { recursive: true });
    await fs.writeFile(path.join(source, 'Catalogs', 'Catalog1.xml'), '<Catalog1_New/>', 'utf8');

    await fs.mkdir(path.join(destination, 'Catalogs', 'Catalog1'), { recursive: true });
    await fs.writeFile(path.join(destination, 'Catalogs', 'Catalog1.xml'), '<Catalog1_Initial/>', 'utf8');
    await fs.writeFile(path.join(destination, 'Catalogs', 'Catalog1', 'initial.txt'), 'initial content', 'utf8');

    let renameCount = 0;
    const failingRename = async (from: string, to: string) => {
      // In staging -> destination step, trigger failure
      if (from.includes('staging')) {
        renameCount++;
        if (renameCount > 0) {
          throw new Error('Simulated atomic rename failure during install');
        }
      }
      await fs.rename(from, to);
    };

    await assert.rejects(
      publishExportedObjectsTree(source, destination, { rename: failingRename }),
      /Simulated atomic rename failure during install/,
    );

    // Verify rollback restored initial destination state
    assert.strictEqual(await fs.readFile(path.join(destination, 'Catalogs', 'Catalog1.xml'), 'utf8'), '<Catalog1_Initial/>');
    assert.strictEqual(
      await fs.readFile(path.join(destination, 'Catalogs', 'Catalog1', 'initial.txt'), 'utf8'),
      'initial content',
    );
  });

  test('DeployService.pullSelectedObjects acquires session lock and triggers reload on success', async () => {
    const configRoot = path.join(rootTestDir, 'workspace');
    await fs.mkdir(path.join(configRoot, 'Catalogs'), { recursive: true });
    await fs.writeFile(path.join(configRoot, 'Configuration.xml'), '<Configuration/>', 'utf8');

    let mutationKindAcquired: string | undefined;
    let mutationResourceAcquired: string | undefined;
    const gateway = configureConfigurationMutationGateway(async (resourcePath, kind, operation) => {
      mutationResourceAcquired = resourcePath;
      mutationKindAcquired = kind;
      return operation();
    });

    let reloadTriggeredRoot: string | undefined;
    let reloadTriggeredReason: string | undefined;

    const mockExportObjects = async () => ({
      status: 'success' as const,
      exitCode: 0,
      userMessage: 'Export ok',
      logExcerpt: '',
    });

    const deployService = new DeployService({
      runExportObjects: mockExportObjects as any,
      requestConfigurationReload: async (root, reason) => {
        reloadTriggeredRoot = root;
        reloadTriggeredReason = reason;
      },
    });

    const entry: InfobaseEntry = {
      id: 'ib-1',
      name: 'TestIB',
      type: 'file',
      filePath: path.join(rootTestDir, 'ib'),
      hasStoredPassword: false,
      createdAt: '2026-01-01',
    };
    const binding: ConfigurationBinding = {
      workspaceFolder: 'ws',
      configRelativePath: 'Configuration.xml',
      infobaseIds: ['ib-1'],
      massDeployment: false,
    };
    const mockStorage: InfobaseStorageService = {
      readPasswordSecret: async () => null,
    } as any;

    try {
      const summary = await deployService.pullSelectedObjects({
        binding,
        workspaceFolderRoot: configRoot,
        storage: mockStorage,
        entry,
        selectedNodes: [
          {
            id: 'Catalog.Catalog1',
            name: 'Catalog1',
            type: MetadataType.Catalog,
            properties: {},
          },
        ],
        progress: { report: () => undefined },
        token: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) },
      });

      assert.strictEqual(summary.successCount, 1);
      assert.strictEqual(mutationKindAcquired, 'pullSelectedObjects', 'Must acquire write lock via runConfigurationMutation');
      assert.strictEqual(mutationResourceAcquired, configRoot, 'Lock must be scoped to configRoot');
      assert.strictEqual(reloadTriggeredRoot, configRoot, 'Reload must be requested for configRoot');
      assert.strictEqual(reloadTriggeredReason, 'pull-command', 'Reload reason must be pull-command');
    } finally {
      gateway.dispose();
    }
  });

  test('publishExportedObjectsTree creates category directory when installing into clean destination', async () => {
    const source = path.join(rootTestDir, 'source');
    const destination = path.join(rootTestDir, 'destination');

    await fs.mkdir(path.join(source, 'Catalogs', 'NewCat'), { recursive: true });
    await fs.writeFile(path.join(source, 'Catalogs', 'NewCat.xml'), '<NewCat/>', 'utf8');
    await fs.writeFile(path.join(source, 'Catalogs', 'NewCat', 'module.bsl'), 'Procedure Foo() EndProcedure', 'utf8');

    // Destination exists but has no Catalogs/ directory at all
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(path.join(destination, 'Configuration.xml'), '<Config/>', 'utf8');

    const copied = await publishExportedObjectsTree(source, destination);
    assert.ok(copied >= 2, 'Both .xml and companion bsl must be copied');
    assert.strictEqual(await fs.readFile(path.join(destination, 'Catalogs', 'NewCat.xml'), 'utf8'), '<NewCat/>');
    assert.strictEqual(
      await fs.readFile(path.join(destination, 'Catalogs', 'NewCat', 'module.bsl'), 'utf8'),
      'Procedure Foo() EndProcedure',
    );
  });

  test('publishExportedObjectsTree retains recovery backup and discloses path when rollback itself fails', async () => {
    const source = path.join(rootTestDir, 'source');
    const destination = path.join(rootTestDir, 'destination');

    await fs.mkdir(path.join(source, 'Catalogs', 'Cat1'), { recursive: true });
    await fs.writeFile(path.join(source, 'Catalogs', 'Cat1.xml'), '<Cat1_New/>', 'utf8');

    await fs.mkdir(path.join(destination, 'Catalogs', 'Cat1'), { recursive: true });
    await fs.writeFile(path.join(destination, 'Catalogs', 'Cat1.xml'), '<Cat1_Original/>', 'utf8');

    let failInstall = true;
    let failRestore = true;
    const doubleFailingRename = async (from: string, to: string) => {
      if (failInstall && from.includes('staging')) {
        failInstall = false;
        throw new Error('Simulated install failure');
      }
      if (failRestore && from.includes('backup')) {
        failRestore = false;
        throw new Error('Simulated restore failure');
      }
      await fs.rename(from, to);
    };

    let recoveryPath = '';
    await assert.rejects(
      publishExportedObjectsTree(source, destination, { rename: doubleFailingRename }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Резервная копия сохранена:/u);
        assert.match(err.message, /Simulated install failure/u);
        assert.match(err.message, /Simulated restore failure/u);
        const match = err.message.match(/Резервная копия сохранена:\s*(.*?)\.\s+Исходная/u);
        recoveryPath = match?.[1] ?? '';
        return recoveryPath.length > 0;
      },
    );

    assert.ok(recoveryPath, 'Must report recovery path in error message');
    const stat = await fs.stat(recoveryPath);
    assert.ok(stat.isDirectory(), 'Backup directory must survive double failure for explicit recovery');
  });

  test('DeployService.pullSelectedObjects falls back to direct run when mutation runner is not configured', async () => {
    const configRoot = path.join(rootTestDir, 'workspace-standalone');
    await fs.mkdir(path.join(configRoot, 'Catalogs'), { recursive: true });
    await fs.writeFile(path.join(configRoot, 'Configuration.xml'), '<Configuration/>', 'utf8');

    // Ensure gateway is explicitly NOT configured
    resetConfigurationMutationGateway();

    let exportCalled = false;
    const deployService = new DeployService({
      runExportObjects: async () => {
        exportCalled = true;
        return {
          status: 'success' as const,
          exitCode: 0,
          userMessage: 'Export standalone ok',
          logExcerpt: '',
        };
      },
    });

    const summary = await deployService.pullSelectedObjects({
      binding: {
        workspaceFolder: 'ws',
        configRelativePath: 'Configuration.xml',
        infobaseIds: ['ib-1'],
        massDeployment: false,
      },
      workspaceFolderRoot: configRoot,
      storage: { readPasswordSecret: async () => null } as any,
      entry: { id: 'ib-1', name: 'TestIB', type: 'file', filePath: 'C:\\ib', hasStoredPassword: false, createdAt: '2026-01-01' },
      selectedNodes: [{ id: 'Catalog.Cat1', name: 'Cat1', type: MetadataType.Catalog, properties: {} }],
      progress: { report: () => undefined },
      token: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) },
    });

    assert.strictEqual(summary.successCount, 1);
    assert.strictEqual(exportCalled, true, 'Export must execute directly when gateway runner is not configured');
  });

  test('DeployService.pullSelectedObjects does not trigger reload when export fails', async () => {
    const configRoot = path.join(rootTestDir, 'workspace-fail');
    await fs.mkdir(path.join(configRoot, 'Catalogs'), { recursive: true });
    await fs.writeFile(path.join(configRoot, 'Configuration.xml'), '<Configuration/>', 'utf8');

    let reloadTriggered = false;
    const deployService = new DeployService({
      runExportObjects: async () => ({
        status: 'error' as const,
        exitCode: 1,
        userMessage: 'Export failed by ibcmd',
        logExcerpt: 'syntax error',
      }),
      requestConfigurationReload: async () => {
        reloadTriggered = true;
      },
    });

    const summary = await deployService.pullSelectedObjects({
      binding: {
        workspaceFolder: 'ws',
        configRelativePath: 'Configuration.xml',
        infobaseIds: ['ib-1'],
        massDeployment: false,
      },
      workspaceFolderRoot: configRoot,
      storage: { readPasswordSecret: async () => null } as any,
      entry: { id: 'ib-1', name: 'TestIB', type: 'file', filePath: 'C:\\ib', hasStoredPassword: false, createdAt: '2026-01-01' },
      selectedNodes: [{ id: 'Catalog.Cat1', name: 'Cat1', type: MetadataType.Catalog, properties: {} }],
      progress: { report: () => undefined },
      token: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) },
    });

    assert.strictEqual(summary.errorCount, 1);
    assert.strictEqual(reloadTriggered, false, 'Reload must not be requested on failed export');
  });
});
