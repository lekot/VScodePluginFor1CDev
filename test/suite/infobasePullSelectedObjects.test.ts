import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { resetVscodeTestState } from '../helpers/vscodeModuleStub';
import {
  publishExportedObjects,
  runInfobaseConfigExportObjects,
} from '../../src/infobases/infobaseConfigCommands';
import {
  DeployService,
  type PullSelectedObjectsParams,
} from '../../src/bindings/deployService';
import type { ConfigurationBinding } from '../../src/bindings/models/configurationBinding';
import type { InfobaseEntry } from '../../src/infobases/models/infobaseEntry';
import type { InfobaseStorageService } from '../../src/infobases/infobaseStorageService';
import { MetadataType } from '../../src/models/treeNode';
import type { ReloadReason } from '../../src/types/reloadContracts';

function baseBinding(overrides: Partial<ConfigurationBinding> = {}): ConfigurationBinding {
  return {
    workspaceFolder: 'ws',
    configRelativePath: 'Configuration.xml',
    infobaseIds: ['base1'],
    massDeployment: false,
    ...overrides,
  };
}

function fileEntry(id: string, name: string, filePath: string): InfobaseEntry {
  return {
    id,
    name,
    type: 'file',
    filePath,
    hasStoredPassword: false,
    createdAt: '2020-01-01T00:00:00.000Z',
  };
}

const mockStorage: InfobaseStorageService = {
  readPasswordSecret: async () => null,
  storePasswordSecret: async () => undefined,
  deletePasswordSecret: async () => undefined,
} as unknown as InfobaseStorageService;

interface MutableIbcmdServiceModule {
  getIbcmdService(): { resolveExecutablePathAsync: () => Promise<{ kind: string; path: string }>; getTimeoutMs: () => number };
}
const ibcmdServiceModule = module.require('../../src/services/ibcmd/ibcmdServiceSingleton') as MutableIbcmdServiceModule;
const originalGetIbcmdService = ibcmdServiceModule.getIbcmdService;

suite('infobasePullSelectedObjects #350', () => {
  let tempRoot: string;

  setup(async () => {
    resetVscodeTestState();
    ibcmdServiceModule.getIbcmdService = () => ({
      resolveExecutablePathAsync: async () => ({ kind: 'resolved', path: 'ibcmd-mock' }),
      getTimeoutMs: () => 30_000,
    } as unknown as any);
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-pull-test-'));
  });

  teardown(async () => {
    resetVscodeTestState();
    ibcmdServiceModule.getIbcmdService = originalGetIbcmdService;
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  suite('publishExportedObjects transactional staging', () => {
    test('atomically installs exported descriptor and object directory', async () => {
      const source = path.join(tempRoot, 'source');
      const destination = path.join(tempRoot, 'dest');
      await fs.mkdir(path.join(source, 'Catalogs', 'Products', 'Forms', 'ItemForm'), { recursive: true });
      await fs.mkdir(path.join(destination, 'Catalogs'), { recursive: true });

      await fs.writeFile(path.join(source, 'Catalogs', 'Products.xml'), '<ProductDescriptor/>', 'utf8');
      await fs.writeFile(
        path.join(source, 'Catalogs', 'Products', 'Forms', 'ItemForm', 'Form.xml'),
        '<ItemFormXml/>',
        'utf8',
      );

      const copied = await publishExportedObjects(source, destination);
      assert.strictEqual(copied, 2);

      const destXml = await fs.readFile(path.join(destination, 'Catalogs', 'Products.xml'), 'utf8');
      assert.strictEqual(destXml, '<ProductDescriptor/>');
      const destForm = await fs.readFile(
        path.join(destination, 'Catalogs', 'Products', 'Forms', 'ItemForm', 'Form.xml'),
        'utf8',
      );
      assert.strictEqual(destForm, '<ItemFormXml/>');

      // Verify transaction artifacts were cleaned up
      const destEntries = await fs.readdir(destination);
      assert.ok(!destEntries.some((e) => e.startsWith('.cdt-objects-publish-')));
    });

    test('removes stale nested files and forms when infobase object replaces workspace object', async () => {
      const source = path.join(tempRoot, 'source');
      const destination = path.join(tempRoot, 'dest');

      // Destination has Products with Form1 and Form2, plus a sibling Customers catalog
      await fs.mkdir(path.join(destination, 'Catalogs', 'Products', 'Forms', 'Form1'), { recursive: true });
      await fs.mkdir(path.join(destination, 'Catalogs', 'Products', 'Forms', 'Form2'), { recursive: true });
      await fs.mkdir(path.join(destination, 'Catalogs', 'Customers'), { recursive: true });
      await fs.writeFile(path.join(destination, 'Catalogs', 'Products.xml'), '<OldProducts/>', 'utf8');
      await fs.writeFile(path.join(destination, 'Catalogs', 'Products', 'Forms', 'Form1', 'Form.xml'), '<OldF1/>', 'utf8');
      await fs.writeFile(path.join(destination, 'Catalogs', 'Products', 'Forms', 'Form2', 'Form.xml'), '<OldF2/>', 'utf8');
      await fs.writeFile(path.join(destination, 'Catalogs', 'Customers.xml'), '<CustomersXml/>', 'utf8');
      await fs.writeFile(path.join(destination, 'Catalogs', 'Customers', 'Cust.xml'), '<CustChild/>', 'utf8');

      // Source has Products where Form1 was DELETED in infobase, Form2 was UPDATED, and Form3 was ADDED
      await fs.mkdir(path.join(source, 'Catalogs', 'Products', 'Forms', 'Form2'), { recursive: true });
      await fs.mkdir(path.join(source, 'Catalogs', 'Products', 'Forms', 'Form3'), { recursive: true });
      await fs.writeFile(path.join(source, 'Catalogs', 'Products.xml'), '<NewProducts/>', 'utf8');
      await fs.writeFile(path.join(source, 'Catalogs', 'Products', 'Forms', 'Form2', 'Form.xml'), '<UpdatedF2/>', 'utf8');
      await fs.writeFile(path.join(source, 'Catalogs', 'Products', 'Forms', 'Form3', 'Form.xml'), '<NewF3/>', 'utf8');

      await publishExportedObjects(source, destination);

      // Form1 must be completely removed
      let form1Exists = true;
      try {
        await fs.access(path.join(destination, 'Catalogs', 'Products', 'Forms', 'Form1'));
      } catch {
        form1Exists = false;
      }
      assert.strictEqual(form1Exists, false, 'Form1 was deleted in infobase and must not remain in destination');

      // Form2 must be updated, Form3 must exist
      const f2 = await fs.readFile(path.join(destination, 'Catalogs', 'Products', 'Forms', 'Form2', 'Form.xml'), 'utf8');
      assert.strictEqual(f2, '<UpdatedF2/>');
      const f3 = await fs.readFile(path.join(destination, 'Catalogs', 'Products', 'Forms', 'Form3', 'Form.xml'), 'utf8');
      assert.strictEqual(f3, '<NewF3/>');

      // Sibling Customers catalog must be completely intact
      const custXml = await fs.readFile(path.join(destination, 'Catalogs', 'Customers.xml'), 'utf8');
      assert.strictEqual(custXml, '<CustomersXml/>');
      const custChild = await fs.readFile(path.join(destination, 'Catalogs', 'Customers', 'Cust.xml'), 'utf8');
      assert.strictEqual(custChild, '<CustChild/>');
    });

    test('removes orphan object directory when infobase object has no child artifacts', async () => {
      const source = path.join(tempRoot, 'source');
      const destination = path.join(tempRoot, 'dest');

      // Destination has Products.xml and Products/ directory with forms
      await fs.mkdir(path.join(destination, 'Catalogs', 'Products', 'Forms', 'ItemForm'), { recursive: true });
      await fs.writeFile(path.join(destination, 'Catalogs', 'Products.xml'), '<OldProducts/>', 'utf8');
      await fs.writeFile(
        path.join(destination, 'Catalogs', 'Products', 'Forms', 'ItemForm', 'Form.xml'),
        '<OldForm/>',
        'utf8',
      );

      // In infobase, all forms were deleted, so source ONLY contains Products.xml without Products/ directory
      await fs.mkdir(path.join(source, 'Catalogs'), { recursive: true });
      await fs.writeFile(path.join(source, 'Catalogs', 'Products.xml'), '<StrippedProducts/>', 'utf8');

      await publishExportedObjects(source, destination);

      const destXml = await fs.readFile(path.join(destination, 'Catalogs', 'Products.xml'), 'utf8');
      assert.strictEqual(destXml, '<StrippedProducts/>');

      let dirExists = true;
      try {
        await fs.access(path.join(destination, 'Catalogs', 'Products'));
      } catch {
        dirExists = false;
      }
      assert.strictEqual(dirExists, false, 'Products/ directory must be removed when object has no children in infobase');
    });

    test('rolls back destination on mid-install failure, restoring original files', async () => {
      const source = path.join(tempRoot, 'source');
      const destination = path.join(tempRoot, 'dest');

      await fs.mkdir(path.join(destination, 'Catalogs', 'Products'), { recursive: true });
      await fs.writeFile(path.join(destination, 'Catalogs', 'Products.xml'), '<OriginalDescriptor/>', 'utf8');
      await fs.writeFile(path.join(destination, 'Catalogs', 'Products', 'Original.txt'), 'ORIGINAL', 'utf8');

      await fs.mkdir(path.join(source, 'Catalogs', 'Products'), { recursive: true });
      await fs.writeFile(path.join(source, 'Catalogs', 'Products.xml'), '<NewDescriptor/>', 'utf8');
      await fs.writeFile(path.join(source, 'Catalogs', 'Products', 'New.txt'), 'NEW', 'utf8');

      let renameCount = 0;
      const failingHooks = {
        rename: async (from: string, to: string) => {
          renameCount++;
          // Fail on the install step when moving staged files into destination
          if (from.includes('staging') && to.endsWith('.xml')) {
            throw new Error('Simulated disk failure during install');
          }
          await fs.rename(from, to);
        },
      };

      await assert.rejects(
        publishExportedObjects(source, destination, failingHooks),
        /Simulated disk failure during install/,
      );

      // Verify rollback restored original files intact
      const restoredXml = await fs.readFile(path.join(destination, 'Catalogs', 'Products.xml'), 'utf8');
      assert.strictEqual(restoredXml, '<OriginalDescriptor/>');
      const restoredTxt = await fs.readFile(path.join(destination, 'Catalogs', 'Products', 'Original.txt'), 'utf8');
      assert.strictEqual(restoredTxt, 'ORIGINAL');

      // Verify no leaked staged files in destination
      let newTxtExists = true;
      try {
        await fs.access(path.join(destination, 'Catalogs', 'Products', 'New.txt'));
      } catch {
        newTxtExists = false;
      }
      assert.strictEqual(newTxtExists, false);
    });
  });

  suite('DeployService.pullSelectedObjects session lock and reload trigger', () => {
    test('routes through runConfigurationMutation with kind infobase.pullSelectedObjects', async () => {
      const configRoot = tempRoot;
      await fs.writeFile(path.join(configRoot, 'Configuration.xml'), '<Configuration/>', 'utf8');

      const mutationCalls: Array<{ path: string; kind: string }> = [];
      const mockRunMutation = async <T>(resPath: string, kind: string, op: () => Promise<T>): Promise<T> => {
        mutationCalls.push({ path: resPath, kind });
        return op();
      };

      let exportCalled = false;
      const service = new DeployService({
        runConfigurationMutation: mockRunMutation,
        runConfigurationExportObjects: async (params) => {
          exportCalled = true;
          return { status: 'success', exitCode: 0, userMessage: 'OK', logExcerpt: '' };
        },
      });

      const summary = await service.pullSelectedObjects({
        binding: baseBinding({ configRelativePath: 'Configuration.xml', infobaseIds: ['base1'] }),
        workspaceFolderRoot: tempRoot,
        storage: mockStorage,
        entry: fileEntry('base1', 'Base 1', 'C:\\ib'),
        selectedNodes: [{
          id: 'Catalog.Products',
          name: 'Products',
          type: MetadataType.Catalog,
          properties: {},
        }],
        progress: { report: () => undefined },
        token: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) },
      });

      assert.strictEqual(exportCalled, true);
      assert.strictEqual(summary.successCount, 1);
      assert.strictEqual(mutationCalls.length, 1);
      assert.strictEqual(mutationCalls[0]!.kind, 'infobase.pullSelectedObjects');
      assert.strictEqual(mutationCalls[0]!.path, configRoot);
    });

    test('triggers requestConfigurationReload with pull-objects on successful pull', async () => {
      const configRoot = tempRoot;
      await fs.writeFile(path.join(configRoot, 'Configuration.xml'), '<Configuration/>', 'utf8');

      const reloadCalls: Array<{ configPath: string; reason: ReloadReason }> = [];
      const mockReload = async (p: string, reason: ReloadReason): Promise<void> => {
        reloadCalls.push({ configPath: p, reason });
      };

      const service = new DeployService({
        runConfigurationExportObjects: async () => ({
          status: 'success',
          exitCode: 0,
          userMessage: 'OK',
          logExcerpt: '',
        }),
        requestConfigurationReload: mockReload,
      });

      const summary = await service.pullSelectedObjects({
        binding: baseBinding({ configRelativePath: 'Configuration.xml', infobaseIds: ['base1'] }),
        workspaceFolderRoot: tempRoot,
        storage: mockStorage,
        entry: fileEntry('base1', 'Base 1', 'C:\\ib'),
        selectedNodes: [{
          id: 'Catalog.Products',
          name: 'Products',
          type: MetadataType.Catalog,
          properties: {},
        }],
        progress: { report: () => undefined },
        token: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) },
      });

      assert.strictEqual(summary.successCount, 1);
      assert.strictEqual(reloadCalls.length, 1);
      assert.strictEqual(reloadCalls[0]!.configPath, configRoot);
      assert.strictEqual(reloadCalls[0]!.reason, 'pull-objects');
    });

    test('does not trigger reload when export is cancelled or in doubt', async () => {
      const configRoot = tempRoot;
      await fs.writeFile(path.join(configRoot, 'Configuration.xml'), '<Configuration/>', 'utf8');

      const reloadCalls: Array<{ configPath: string; reason: ReloadReason }> = [];
      const mockReload = async (p: string, reason: ReloadReason): Promise<void> => {
        reloadCalls.push({ configPath: p, reason });
      };

      const service = new DeployService({
        runConfigurationExportObjects: async () => ({
          status: 'cancelled',
          exitCode: null,
          userMessage: 'Cancelled',
          logExcerpt: '',
        }),
        requestConfigurationReload: mockReload,
      });

      const summary = await service.pullSelectedObjects({
        binding: baseBinding({ configRelativePath: 'Configuration.xml', infobaseIds: ['base1'] }),
        workspaceFolderRoot: tempRoot,
        storage: mockStorage,
        entry: fileEntry('base1', 'Base 1', 'C:\\ib'),
        selectedNodes: [{
          id: 'Catalog.Products',
          name: 'Products',
          type: MetadataType.Catalog,
          properties: {},
        }],
        progress: { report: () => undefined },
        token: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) },
      });

      assert.strictEqual(summary.skippedCount, 1);
      assert.strictEqual(reloadCalls.length, 0, 'Must not reload on cancelled pull');
    });
  });
});
