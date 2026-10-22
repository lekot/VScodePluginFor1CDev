import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';
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
import { WorkspaceRegistry } from '../../src/services/configurationSession/WorkspaceRegistry';
import { ConfigurationSession } from '../../src/services/configurationSession/ConfigurationSession';
import { WorkspaceRegistryCoordinator } from '../../src/services/configurationSession/WorkspaceRegistryCoordinator';
import {
  configureConfigurationMutationGateway,
  runConfigurationMutation,
} from '../../src/services/configurationSession/configurationMutationGateway';
import { registerAgentCommands } from '../helpers/agentCommandRegistration';
import { DebugSessionRegistry } from '../../src/agent/debugSessionRegistry';
import type { AgentResult } from '../../src/agent/types';
import { BindingManager } from '../../src/bindings/bindingManager';
import { ConfigFormat } from '../../src/parsers/formatDetector';
import { reconcileAfterCommit } from '../../src/reload/reconciliation';

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
    const rawTemp = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-pull-test-'));
    tempRoot = await fs.realpath(rawTemp);
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

    test('publishes one EDT object unit without replacing its whole type folder or sibling objects', async () => {
      const source = path.join(tempRoot, 'source');
      const destination = path.join(tempRoot, 'dest');
      const sourceObject = path.join(source, 'src', 'Catalogs', 'Goods');
      const destinationType = path.join(destination, 'src', 'Catalogs');
      const selectedObject = path.join(destinationType, 'Goods');
      const siblingObject = path.join(destinationType, 'Other');

      await fs.mkdir(path.join(sourceObject, 'Ext'), { recursive: true });
      await fs.mkdir(path.join(selectedObject, 'Ext'), { recursive: true });
      await fs.mkdir(siblingObject, { recursive: true });
      await fs.writeFile(path.join(sourceObject, 'Goods.mdo'), '<Goods new="true"/>', 'utf8');
      await fs.writeFile(path.join(sourceObject, 'Ext', 'ManagerModule.bsl'), 'new module', 'utf8');
      await fs.writeFile(path.join(selectedObject, 'Goods.mdo'), '<Goods old="true"/>', 'utf8');
      await fs.writeFile(path.join(siblingObject, 'Other.mdo'), '<Other/>', 'utf8');

      await publishExportedObjects(source, destination);

      assert.strictEqual(await fs.readFile(path.join(selectedObject, 'Goods.mdo'), 'utf8'), '<Goods new="true"/>');
      assert.strictEqual(await fs.readFile(path.join(selectedObject, 'Ext', 'ManagerModule.bsl'), 'utf8'), 'new module');
      assert.strictEqual(await fs.readFile(path.join(siblingObject, 'Other.mdo'), 'utf8'), '<Other/>');
    });

    test('rejects a destination type folder that is a junction to an external workspace path', async () => {
      const source = path.join(tempRoot, 'source');
      const destination = path.join(tempRoot, 'dest');
      const external = path.join(tempRoot, 'external');
      await fs.mkdir(path.join(source, 'Catalogs'), { recursive: true });
      await fs.mkdir(external, { recursive: true });
      await fs.mkdir(destination, { recursive: true });
      await fs.writeFile(path.join(source, 'Catalogs', 'Goods.xml'), '<Goods new="true"/>', 'utf8');
      await fs.writeFile(path.join(external, 'Goods.xml'), '<Goods external="preserve"/>', 'utf8');
      await fs.symlink(external, path.join(destination, 'Catalogs'), 'junction');

      await assert.rejects(publishExportedObjects(source, destination));
      assert.strictEqual(await fs.readFile(path.join(external, 'Goods.xml'), 'utf8'), '<Goods external="preserve"/>');
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

    test('restores the source entry when backup rename moves it before throwing', async () => {
      const source = path.join(tempRoot, 'source');
      const destination = path.join(tempRoot, 'dest');
      const relativePath = path.join('Catalogs', 'Goods.xml');
      const destinationFile = path.join(destination, relativePath);
      await fs.mkdir(path.dirname(destinationFile), { recursive: true });
      await fs.mkdir(path.join(source, 'Catalogs'), { recursive: true });
      await fs.writeFile(destinationFile, '<Goods old="true"/>', 'utf8');
      await fs.writeFile(path.join(source, relativePath), '<Goods new="true"/>', 'utf8');

      const failingHooks = {
        rename: async (from: string, to: string) => {
          await fs.rename(from, to);
          if (from.endsWith(path.join('Catalogs', 'Goods.xml')) && to.includes(`${path.sep}backup${path.sep}`)) {
            throw new Error('backup renamed before reported failure');
          }
        },
      };

      await assert.rejects(
        publishExportedObjects(source, destination, failingHooks),
        /backup renamed before reported failure/u,
      );
      assert.strictEqual(await fs.readFile(destinationFile, 'utf8'), '<Goods old="true"/>');
    });

    test('preserves a competing install file and retains backup instead of overwriting it during rollback', async () => {
      const source = path.join(tempRoot, 'source');
      const destination = path.join(tempRoot, 'dest');
      const relativePath = path.join('Catalogs', 'Goods.xml');
      const destinationFile = path.join(destination, relativePath);
      const original = '<Goods old="true"/>';
      const competitor = '<Goods from="another-writer"/>';
      await fs.mkdir(path.dirname(destinationFile), { recursive: true });
      await fs.mkdir(path.join(source, 'Catalogs'), { recursive: true });
      await fs.writeFile(destinationFile, original, 'utf8');
      await fs.writeFile(path.join(source, relativePath), '<Goods new="true"/>', 'utf8');

      await assert.rejects(
        publishExportedObjects(source, destination, {
          beforeRename: async (from: string, to: string) => {
            if (from.includes(`${path.sep}staging${path.sep}`) && to.endsWith(path.join('Catalogs', 'Goods.xml'))) {
              await fs.writeFile(destinationFile, competitor, 'utf8');
            }
          },
        }),
        (error: unknown) => error instanceof Error && /Резервная копия сохранена:/u.test(error.message),
      );

      assert.strictEqual(await fs.readFile(destinationFile, 'utf8'), competitor);
      const transaction = (await fs.readdir(destination)).find((entry) => entry.startsWith('.cdt-objects-publish-'));
      assert.ok(transaction, 'transaction evidence must be retained when rollback meets a competing file');
      const backupFile = path.join(destination, transaction!, 'backup', relativePath);
      assert.strictEqual(await fs.readFile(backupFile, 'utf8'), original);
    });

    test('preserves a file that appears immediately before rollback restore', async () => {
      const source = path.join(tempRoot, 'source');
      const destination = path.join(tempRoot, 'dest');
      const relativePath = path.join('Catalogs', 'Goods.xml');
      const destinationFile = path.join(destination, relativePath);
      const original = '<Goods old="true"/>';
      const competitor = '<Goods from="late-writer"/>';
      await fs.mkdir(path.dirname(destinationFile), { recursive: true });
      await fs.mkdir(path.join(source, 'Catalogs'), { recursive: true });
      await fs.writeFile(destinationFile, original, 'utf8');
      await fs.writeFile(path.join(source, relativePath), '<Goods new="true"/>', 'utf8');

      await assert.rejects(
        publishExportedObjects(source, destination, {
          beforeRename: async (from: string, to: string) => {
            if (from.includes(`${path.sep}backup${path.sep}`) && to.endsWith(path.join('Catalogs', 'Goods.xml'))) {
              await fs.writeFile(destinationFile, competitor, 'utf8');
            }
          },
          rename: async (from: string, to: string) => {
            if (from.includes(`${path.sep}staging${path.sep}`) && to.endsWith(path.join('Catalogs', 'Goods.xml'))) {
              throw new Error('injected install failure before moving');
            }
            await fs.rename(from, to);
          },
        }),
        (error: unknown) => error instanceof Error && /Резервная копия сохранена:/u.test(error.message),
      );

      assert.strictEqual(await fs.readFile(destinationFile, 'utf8'), competitor);
      const transaction = (await fs.readdir(destination)).find((entry) => entry.startsWith('.cdt-objects-publish-'));
      assert.ok(transaction, 'rollback must retain the original backup on a destination conflict');
      assert.strictEqual(
        await fs.readFile(path.join(destination, transaction!, 'backup', relativePath), 'utf8'),
        original,
      );
    });

    test('removes an installed entry and restores the original when install rename moves then throws', async () => {
      const source = path.join(tempRoot, 'source');
      const destination = path.join(tempRoot, 'dest');
      const relativePath = path.join('Catalogs', 'Goods.xml');
      const destinationFile = path.join(destination, relativePath);
      await fs.mkdir(path.dirname(destinationFile), { recursive: true });
      await fs.mkdir(path.join(source, 'Catalogs'), { recursive: true });
      await fs.writeFile(destinationFile, '<Goods old="true"/>', 'utf8');
      await fs.writeFile(path.join(source, relativePath), '<Goods new="true"/>', 'utf8');

      await assert.rejects(
        publishExportedObjects(source, destination, {
          rename: async (from: string, to: string) => {
            await fs.rename(from, to);
            if (from.includes(`${path.sep}staging${path.sep}`) && to.endsWith(path.join('Catalogs', 'Goods.xml'))) {
              throw new Error('install moved before reported failure');
            }
          },
        }),
        /install moved before reported failure/u,
      );

      assert.strictEqual(await fs.readFile(destinationFile, 'utf8'), '<Goods old="true"/>');
      assert.ok(!(await fs.readdir(destination)).some((entry) => entry.startsWith('.cdt-objects-publish-')));
    });

    test('retains recovery backup when an install post-check finds a substituted junction', async () => {
      const source = path.join(tempRoot, 'source');
      const destination = path.join(tempRoot, 'dest');
      const external = path.join(tempRoot, 'external');
      const relativePath = path.join('Catalogs', 'Goods.xml');
      const destinationFile = path.join(destination, relativePath);
      await fs.mkdir(path.dirname(destinationFile), { recursive: true });
      await fs.mkdir(path.join(source, 'Catalogs'), { recursive: true });
      await fs.mkdir(external, { recursive: true });
      await fs.writeFile(destinationFile, '<Goods old="true"/>', 'utf8');
      await fs.writeFile(path.join(source, relativePath), '<Goods new="true"/>', 'utf8');
      await fs.writeFile(path.join(external, 'sentinel.txt'), 'external data', 'utf8');

      await assert.rejects(
        publishExportedObjects(source, destination, {
          rename: async (from: string, to: string) => {
            await fs.rename(from, to);
            if (from.includes(`${path.sep}staging${path.sep}`) && to.endsWith(path.join('Catalogs', 'Goods.xml'))) {
              await fs.rm(to, { recursive: true, force: true });
              await fs.symlink(external, to, process.platform === 'win32' ? 'junction' : 'dir');
            }
          },
        }),
        (error: unknown) => error instanceof Error && /Резервная копия сохранена:/u.test(error.message),
      );

      assert.strictEqual(await fs.readFile(path.join(external, 'sentinel.txt'), 'utf8'), 'external data');
      const transaction = (await fs.readdir(destination)).find((entry) => entry.startsWith('.cdt-objects-publish-'));
      assert.ok(transaction, 'transaction evidence must survive a failed post-rename validation');
      assert.strictEqual(
        await fs.readFile(path.join(destination, transaction!, 'backup', relativePath), 'utf8'),
        '<Goods old="true"/>',
      );
    });

    test('publishes EDT partial export across multiple categories preserving sibling objects and configuration descriptor', async () => {
      const source = path.join(tempRoot, 'source');
      const destination = path.join(tempRoot, 'dest');

      const srcRoot = path.join(source, 'src');
      const dstRoot = path.join(destination, 'src');

      await fs.mkdir(path.join(dstRoot, 'Catalogs', 'Goods'), { recursive: true });
      await fs.mkdir(path.join(dstRoot, 'Catalogs', 'Other'), { recursive: true });
      await fs.mkdir(path.join(dstRoot, 'Documents', 'Invoice'), { recursive: true });
      await fs.mkdir(path.join(dstRoot, 'Documents', 'Receipt'), { recursive: true });
      await fs.mkdir(path.join(dstRoot, 'Configuration'), { recursive: true });

      await fs.writeFile(path.join(dstRoot, 'Catalogs', 'Goods', 'Goods.mdo'), '<Goods old="true"/>', 'utf8');
      await fs.writeFile(path.join(dstRoot, 'Catalogs', 'Other', 'Other.mdo'), '<Other intact="true"/>', 'utf8');
      await fs.writeFile(path.join(dstRoot, 'Documents', 'Invoice', 'Invoice.mdo'), '<Invoice old="true"/>', 'utf8');
      await fs.writeFile(path.join(dstRoot, 'Documents', 'Receipt', 'Receipt.mdo'), '<Receipt intact="true"/>', 'utf8');
      await fs.writeFile(path.join(dstRoot, 'Configuration', 'Configuration.mdo'), '<Configuration intact="true"/>', 'utf8');
      await fs.writeFile(path.join(dstRoot, 'README.md'), '# Preserved documentation', 'utf8');

      await fs.mkdir(path.join(srcRoot, 'Catalogs', 'Goods'), { recursive: true });
      await fs.mkdir(path.join(srcRoot, 'Documents', 'Invoice'), { recursive: true });

      await fs.writeFile(path.join(srcRoot, 'Catalogs', 'Goods', 'Goods.mdo'), '<Goods new="true"/>', 'utf8');
      await fs.writeFile(path.join(srcRoot, 'Documents', 'Invoice', 'Invoice.mdo'), '<Invoice new="true"/>', 'utf8');

      const copied = await publishExportedObjects(source, destination);
      assert.strictEqual(copied, 2);

      assert.strictEqual(await fs.readFile(path.join(dstRoot, 'Catalogs', 'Goods', 'Goods.mdo'), 'utf8'), '<Goods new="true"/>');
      assert.strictEqual(await fs.readFile(path.join(dstRoot, 'Documents', 'Invoice', 'Invoice.mdo'), 'utf8'), '<Invoice new="true"/>');
      assert.strictEqual(await fs.readFile(path.join(dstRoot, 'Catalogs', 'Other', 'Other.mdo'), 'utf8'), '<Other intact="true"/>');
      assert.strictEqual(await fs.readFile(path.join(dstRoot, 'Documents', 'Receipt', 'Receipt.mdo'), 'utf8'), '<Receipt intact="true"/>');
      assert.strictEqual(await fs.readFile(path.join(dstRoot, 'Configuration', 'Configuration.mdo'), 'utf8'), '<Configuration intact="true"/>');
      assert.strictEqual(await fs.readFile(path.join(dstRoot, 'README.md'), 'utf8'), '# Preserved documentation');
    });

    test('rolls back mid-install failure across multiple categories, restoring originals and preserving siblings', async () => {
      const source = path.join(tempRoot, 'source');
      const destination = path.join(tempRoot, 'dest');

      const srcRoot = path.join(source, 'src');
      const dstRoot = path.join(destination, 'src');

      await fs.mkdir(path.join(dstRoot, 'Catalogs', 'Goods'), { recursive: true });
      await fs.mkdir(path.join(dstRoot, 'Catalogs', 'Other'), { recursive: true });
      await fs.mkdir(path.join(dstRoot, 'Documents', 'Invoice'), { recursive: true });

      await fs.writeFile(path.join(dstRoot, 'Catalogs', 'Goods', 'Goods.mdo'), '<Goods orig="true"/>', 'utf8');
      await fs.writeFile(path.join(dstRoot, 'Catalogs', 'Other', 'Other.mdo'), '<Other intact="true"/>', 'utf8');
      await fs.writeFile(path.join(dstRoot, 'Documents', 'Invoice', 'Invoice.mdo'), '<Invoice orig="true"/>', 'utf8');

      await fs.mkdir(path.join(srcRoot, 'Catalogs', 'Goods'), { recursive: true });
      await fs.mkdir(path.join(srcRoot, 'Documents', 'Invoice'), { recursive: true });
      await fs.writeFile(path.join(srcRoot, 'Catalogs', 'Goods', 'Goods.mdo'), '<Goods new="true"/>', 'utf8');
      await fs.writeFile(path.join(srcRoot, 'Documents', 'Invoice', 'Invoice.mdo'), '<Invoice new="true"/>', 'utf8');

      const failingHooks = {
        rename: async (from: string, to: string) => {
          if (from.includes('staging') && to.includes('Invoice')) {
            throw new Error('Simulated failure during Documents.Invoice install');
          }
          await fs.rename(from, to);
        },
      };

      await assert.rejects(
        publishExportedObjects(source, destination, failingHooks),
        /Simulated failure during Documents\.Invoice install/,
      );

      assert.strictEqual(await fs.readFile(path.join(dstRoot, 'Catalogs', 'Goods', 'Goods.mdo'), 'utf8'), '<Goods orig="true"/>');
      assert.strictEqual(await fs.readFile(path.join(dstRoot, 'Documents', 'Invoice', 'Invoice.mdo'), 'utf8'), '<Invoice orig="true"/>');
      assert.strictEqual(await fs.readFile(path.join(dstRoot, 'Catalogs', 'Other', 'Other.mdo'), 'utf8'), '<Other intact="true"/>');
    });

    test('rejects destination file that is a symlink pointing outside configRoot before any staging or backup', async () => {
      const source = path.join(tempRoot, 'source');
      const destination = path.join(tempRoot, 'dest');
      const external = path.join(tempRoot, 'external');
      await fs.mkdir(path.join(source, 'Catalogs'), { recursive: true });
      await fs.mkdir(external, { recursive: true });
      await fs.mkdir(path.join(destination, 'Catalogs'), { recursive: true });
      await fs.writeFile(path.join(source, 'Catalogs', 'Goods.xml'), '<Goods new="true"/>', 'utf8');
      const externalFile = path.join(external, 'Escaped.xml');
      await fs.writeFile(externalFile, '<Escaped/>', 'utf8');

      try {
        await fs.symlink(externalFile, path.join(destination, 'Catalogs', 'Goods.xml'), 'file');
      } catch (err: unknown) {
        if (process.platform === 'win32' && (err as NodeJS.ErrnoException)?.code === 'EPERM') {
          return;
        }
        throw err;
      }

      await assert.rejects(
        publishExportedObjects(source, destination),
        /(?:Символическая ссылка запрещена в дереве публикации|Путь выходит за границы конфигурации)/u,
      );
      assert.strictEqual(await fs.readFile(externalFile, 'utf8'), '<Escaped/>');
      const destEntries = await fs.readdir(destination);
      assert.ok(!destEntries.some((e) => e.startsWith('.cdt-objects-publish-')), 'Transaction directory must not remain');
    });

    test('rejects destination object directory that is a junction pointing outside configRoot before any staging or backup', async () => {
      const source = path.join(tempRoot, 'source');
      const destination = path.join(tempRoot, 'dest');
      const external = path.join(tempRoot, 'external');
      await fs.mkdir(path.join(source, 'Catalogs', 'Goods'), { recursive: true });
      await fs.mkdir(external, { recursive: true });
      await fs.mkdir(path.join(destination, 'Catalogs'), { recursive: true });
      await fs.writeFile(path.join(source, 'Catalogs', 'Goods.xml'), '<Goods new="true"/>', 'utf8');
      await fs.writeFile(path.join(source, 'Catalogs', 'Goods', 'Form.xml'), '<Form/>', 'utf8');
      await fs.writeFile(path.join(external, 'Secret.txt'), 'secret data', 'utf8');

      await fs.symlink(external, path.join(destination, 'Catalogs', 'Goods'), process.platform === 'win32' ? 'junction' : 'dir');

      await assert.rejects(
        publishExportedObjects(source, destination),
        /(?:Символическая ссылка запрещена в дереве публикации|Путь выходит за границы конфигурации)/u,
      );
      assert.strictEqual(await fs.readFile(path.join(external, 'Secret.txt'), 'utf8'), 'secret data');
      const destEntries = await fs.readdir(destination);
      assert.ok(!destEntries.some((e) => e.startsWith('.cdt-objects-publish-')), 'Transaction directory must not remain');
    });

    test('rejects nested symlink inside destination object companion folder before any staging or backup', async () => {
      const source = path.join(tempRoot, 'source');
      const destination = path.join(tempRoot, 'dest');
      const external = path.join(tempRoot, 'external');
      await fs.mkdir(path.join(source, 'Catalogs', 'Goods'), { recursive: true });
      await fs.mkdir(external, { recursive: true });
      await fs.mkdir(path.join(destination, 'Catalogs', 'Goods', 'Forms'), { recursive: true });
      await fs.writeFile(path.join(source, 'Catalogs', 'Goods.xml'), '<Goods new="true"/>', 'utf8');
      await fs.writeFile(path.join(source, 'Catalogs', 'Goods', 'Form.xml'), '<Form/>', 'utf8');
      await fs.writeFile(path.join(destination, 'Catalogs', 'Goods.xml'), '<Goods old="true"/>', 'utf8');

      const externalTarget = path.join(external, 'TargetDir');
      await fs.mkdir(externalTarget, { recursive: true });
      await fs.writeFile(path.join(externalTarget, 'data.txt'), 'untouchable', 'utf8');

      await fs.symlink(externalTarget, path.join(destination, 'Catalogs', 'Goods', 'Forms', 'ItemForm'), process.platform === 'win32' ? 'junction' : 'dir');

      await assert.rejects(
        publishExportedObjects(source, destination),
        /(?:Символическая ссылка запрещена в дереве публикации|Путь выходит за границы конфигурации)/u,
      );
      assert.strictEqual(await fs.readFile(path.join(externalTarget, 'data.txt'), 'utf8'), 'untouchable');
      assert.strictEqual(await fs.readFile(path.join(destination, 'Catalogs', 'Goods.xml'), 'utf8'), '<Goods old="true"/>');
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

    test('returns cancelled export without reconciliation', async () => {
      const configRoot = tempRoot;
      await fs.writeFile(path.join(configRoot, 'Configuration.xml'), '<Configuration/>', 'utf8');

      const service = new DeployService({
        runConfigurationExportObjects: async () => ({
          status: 'cancelled',
          exitCode: null,
          userMessage: 'Cancelled',
          logExcerpt: '',
        }),
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
    });

    test('serializes UI pullSelectedObjects with a real ConfigurationSession and blocks a concurrent writer until completion', async () => {
      const configRoot = tempRoot;
      await fs.writeFile(
        path.join(configRoot, 'Configuration.xml'),
        '<?xml version="1.0" encoding="UTF-8"?><MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Configuration uuid="11111111-1111-4111-8111-111111111111"><Properties><Name>PullUiTest</Name></Properties></Configuration></MetaDataObject>',
        'utf8',
      );

      let mockReload: (configPath: string, reason: ReloadReason) => Promise<void> = async () => undefined;
      const registry = new WorkspaceRegistry(undefined, (identity) => new ConfigurationSession(identity, (commit) =>
        reconcileAfterCommit(
          commit.rootPath,
          commit.kind === 'agent.pullSelectedObjects' ? 'pull-objects' : 'agent-mutation',
          (configPath, reason) => mockReload(configPath, reason),
        )));
      const session = await registry.registerTargetedRoot({ configPath: configRoot, format: ConfigFormat.Designer });
      const coordinator = new WorkspaceRegistryCoordinator(registry, {
        getWorkspaceFolders: () => [tempRoot],
        getWorkspaceFolderForPath: () => tempRoot,
      });

      const gateway = configureConfigurationMutationGateway(
        async (resourcePath, kind, operation) => {
          const owner = await coordinator.resolveResource(resourcePath);
          return owner.runMutationValue({ kind, execute: operation }, {
            failureMessage: 'Операция конфигурации не выполнена.',
            cancelledMessage: 'Операция конфигурации отменена.',
          });
        },
      );

      let exportStartedResolve!: () => void;
      const exportStarted = new Promise<void>((r) => { exportStartedResolve = r; });
      let finishExportResolve!: () => void;
      const finishExport = new Promise<void>((r) => { finishExportResolve = r; });

      const service = new DeployService({
        runConfigurationMutation: (resPath, kind, op) => runConfigurationMutation(resPath, kind, op),
        runConfigurationExportObjects: async () => {
          exportStartedResolve();
          await finishExport;
          return { status: 'success', exitCode: 0, userMessage: 'Export OK', logExcerpt: '' };
        },
      });

      try {
        const pullPromise = service.pullSelectedObjects({
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

        await exportStarted;

        let concurrentWriterRan = false;
        let concurrentWriterFinished = false;
        const concurrentWriterPromise = runConfigurationMutation(configRoot, 'test.concurrentWriter', async () => {
          concurrentWriterRan = true;
          return 'writer-done';
        }).then((res) => {
          concurrentWriterFinished = true;
          return res;
        });

        await new Promise((r) => setTimeout(r, 50));
        assert.strictEqual(concurrentWriterRan, false, 'Concurrent writer must wait in FIFO while pullSelectedObjects is running');
        assert.strictEqual(concurrentWriterFinished, false);

        finishExportResolve();

        const summary = await pullPromise;
        assert.strictEqual(summary.successCount, 1);

        const writerResult = await concurrentWriterPromise;
        assert.strictEqual(writerResult, 'writer-done');
        assert.strictEqual(concurrentWriterRan, true);
        assert.strictEqual(concurrentWriterFinished, true);
        assert.strictEqual(session.snapshotVersion, 2, 'Two serialized mutations must increment snapshotVersion to 2');
      } finally {
        gateway.dispose();
        await registry.dispose();
      }
    });

    test('reconciles registered agent pull after commit and preserves its receipt when reload fails', async () => {
      const configRoot = tempRoot;
      await fs.writeFile(
        path.join(configRoot, 'Configuration.xml'),
        '<?xml version="1.0" encoding="UTF-8"?><MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Configuration uuid="22222222-2222-4222-8222-222222222222"><Properties><Name>PullAgentTest</Name></Properties></Configuration></MetaDataObject>',
        'utf8',
      );

      vscodeTestState.mockWorkspaceFolders = [
        { name: 'ws', index: 0, uri: { fsPath: tempRoot, scheme: 'file' } },
      ];

      let mockReload: (configPath: string, reason: ReloadReason) => Promise<void> = async () => undefined;
      const registry = new WorkspaceRegistry(undefined, (identity) => new ConfigurationSession(identity, async (commit) => {
        return reconcileAfterCommit(
          commit.rootPath,
          commit.kind === 'agent.pullSelectedObjects' ? 'pull-objects' : 'agent-mutation',
          (configPath, reason) => mockReload(configPath, reason),
        );
      }));
      const session = await registry.registerTargetedRoot({ configPath: configRoot, format: ConfigFormat.Designer });
      const configurationId = session.identity.configurationId;

      const coordinator = new WorkspaceRegistryCoordinator(registry, {
        getWorkspaceFolders: () => [tempRoot],
        getWorkspaceFolderForPath: () => tempRoot,
      });

      const gateway = configureConfigurationMutationGateway(
        async (resourcePath, kind, operation) => {
          const owner = await coordinator.resolveResource(resourcePath);
          return owner.runMutationValue({ kind, execute: operation }, {
            failureMessage: 'Операция конфигурации не выполнена.',
            cancelledMessage: 'Операция конфигурации отменена.',
          });
        },
      );

      const reloadCalls: Array<{ configPath: string; reason: ReloadReason }> = [];
      const reloadObservations: Array<{
        snapshotVersion: number;
        writerCount: number;
        readCompletedDuringReload: boolean;
        readSnapshotVersion?: number;
        nestedWriterCompleted: boolean;
      }> = [];
      let reloadStartedResolve!: () => void;
      const reloadStarted = new Promise<void>((resolve) => { reloadStartedResolve = resolve; });
      let finishReloadResolve!: () => void;
      const finishReload = new Promise<void>((resolve) => { finishReloadResolve = resolve; });
      let reloadExecutionActive = false;
      mockReload = async (p: string, reason: ReloadReason): Promise<void> => {
        reloadCalls.push({ configPath: p, reason });
        if (reloadExecutionActive) {
          return;
        }
        reloadExecutionActive = true;
        const observation: typeof reloadObservations[number] = {
          snapshotVersion: session.snapshotVersion,
          writerCount: (session as unknown as { runningWriters: number }).runningWriters,
          readCompletedDuringReload: false,
          nestedWriterCompleted: false,
        };
        reloadObservations.push(observation);

        const readPromise = session.runRead(async ({ snapshotVersion: readSnapshotVersion }) => readSnapshotVersion);
        if (observation.writerCount === 0) {
          const readResult = await readPromise;
          observation.readCompletedDuringReload = readResult.status === 'ok';
          if (readResult.status === 'ok') {
            observation.readSnapshotVersion = readResult.value;
          }
        } else {
          void readPromise;
        }

        await runConfigurationMutation(configRoot, 'test.reloadWriter', async () => 'reload-writer-done');
        observation.nestedWriterCompleted = true;
        reloadStartedResolve();
        await finishReload;
        reloadExecutionActive = false;
        throw Object.assign(new Error('injected reconciliation failure'), { code: 'AUDIT_RELOAD_FAILURE' });
      };

      let exportStartedResolve!: () => void;
      const exportStarted = new Promise<void>((r) => { exportStartedResolve = r; });
      let finishExportResolve!: () => void;
      const finishExport = new Promise<void>((r) => { finishExportResolve = r; });

      const binding = baseBinding({ workspaceFolder: 'ws', configRelativePath: 'Configuration.xml', infobaseIds: ['base1'] });
      const targetEntry = fileEntry('base1', 'Base 1', 'C:\\ib');

      const bindingManager = {
        get: async () => binding,
        listAll: async () => [binding],
        getBindingForConfig: () => binding,
        getBindingsForWorkspaceFolder: () => [binding],
      } as unknown as BindingManager;

      const infobaseStorage = {
        load: async () => [targetEntry],
        readCatalog: async () => [targetEntry],
        readPasswordSecret: async () => null,
      } as unknown as InfobaseStorageService;

      const service = new DeployService({
        runConfigurationMutation: (resPath, kind, op) => runConfigurationMutation(resPath, kind, op),
        runConfigurationExportObjects: async () => {
          exportStartedResolve();
          await finishExport;
          return { status: 'success', exitCode: 0, userMessage: 'Export OK', logExcerpt: '' };
        },
      });

      const context = { subscriptions: [] as Array<{ dispose(): void }> };
      registerAgentCommands(
        context as never,
        () => null,
        async () => registry,
        new DebugSessionRegistry(),
        undefined,
        () => ({
          bindingManager,
          infobaseStorage,
          getConfigPath: () => configRoot,
          deployService: service,
          runConfigurationMutation: (resPath, kind, op) => runConfigurationMutation(resPath, kind, op),
          requestConfigurationReload: mockReload,
        }),
        undefined,
        undefined,
        undefined,
        mockReload,
      );

      try {
        const pullHandler = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.pullSelectedObjects');
        assert.ok(pullHandler, 'agent.pullSelectedObjects command must be registered');

        const taskReceipt = await pullHandler({
          configurationId,
          objectIds: ['Catalog.Products'],
          background: true,
        }) as AgentResult<{ status: string; taskId: string }>;
        assert.strictEqual(taskReceipt.success, true, 'background pull must return its task receipt');
        assert.strictEqual(taskReceipt.data?.status, 'working');
        const taskId = taskReceipt.data!.taskId;

        await exportStarted;
        finishExportResolve();
        await reloadStarted;

        const statusHandler = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.task.status');
        const resultHandler = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.task.result');
        const cancelHandler = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.task.cancel');
        assert.ok(statusHandler && resultHandler && cancelHandler, 'background task lifecycle commands must be registered');
        const whileReconciling = await statusHandler({ taskId }) as AgentResult<{ status: string; cancellationRequested: boolean }>;
        assert.strictEqual(whileReconciling.data?.status, 'running', 'task must remain running while reload reconciliation is pending');
        const pendingResult = await resultHandler({ taskId }) as AgentResult<{ status: string; result?: AgentResult<unknown> }>;
        assert.strictEqual(pendingResult.data?.status, 'running');
        assert.strictEqual(pendingResult.data?.result, undefined, 'the task must not settle before reconciliation completes');

        const lateCancel = await cancelHandler({ taskId }) as AgentResult<{ status: string; cancellationRequested: boolean }>;
        assert.strictEqual(lateCancel.data?.status, 'running');
        assert.strictEqual(lateCancel.data?.cancellationRequested, true, 'a late cancellation request must not erase the committed pull');
        assert.strictEqual(reloadCalls.length, 2, 'the pull and the callback writer both cross the common post-commit boundary');
        finishReloadResolve();

        let completed: AgentResult<{ status: string; result?: AgentResult<unknown> }> | undefined;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          completed = await resultHandler({ taskId }) as AgentResult<{ status: string; result?: AgentResult<unknown> }>;
          if (completed.data?.status !== 'running') break;
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        assert.strictEqual(completed?.data?.status, 'completed', 'successfully committed pull remains completed after a late cancel');
        const agentResult = completed?.data?.result;
        assert.ok(agentResult?.success, `agent.pullSelectedObjects must succeed: ${agentResult?.error}`);
        assert.deepStrictEqual(reloadCalls.map((call) => call.reason), ['pull-objects', 'agent-mutation']);
        assert.deepStrictEqual(reloadObservations, [{
          snapshotVersion: 1,
          writerCount: 0,
          readCompletedDuringReload: true,
          readSnapshotVersion: 1,
          nestedWriterCompleted: true,
        }], 'reload must observe the committed snapshot with the writer released and allow session reads/writes');
        assert.strictEqual(agentResult?.configurationId, configurationId);
        assert.ok(agentResult?.operationId, 'the committed operation receipt must be preserved');
        assert.strictEqual(agentResult?.snapshotVersion, 1);
        assert.deepStrictEqual(agentResult?.reconciliation, {
          status: 'failed',
          code: 'AUDIT_RELOAD_FAILURE',
          message: 'injected reconciliation failure',
        });
        assert.strictEqual(session.snapshotVersion, 2, 'reload callback writer should finish after the pull commit');

        const reloadCallsBeforeNoOp = reloadCalls.length;
        const noOpSummary = {
          successCount: 0,
          errorCount: 0,
          inDoubtCount: 0,
          skippedCount: 1,
          hasPartial: false,
          cancelledMidChain: false,
          results: [{ infobaseId: 'base1', name: 'Base 1', status: 'skipped' as const, message: 'No exported files' }],
        };
        const noOpService = {
          pullSelectedObjects: async (_params: PullSelectedObjectsParams) => noOpSummary,
        } as unknown as DeployService;
        registerAgentCommands(
          context as never,
          () => null,
          async () => registry,
          new DebugSessionRegistry(),
          undefined,
          () => ({
            bindingManager,
            infobaseStorage,
            getConfigPath: () => configRoot,
            deployService: noOpService,
            runConfigurationMutation: (resourcePath, kind, operation) => runConfigurationMutation(resourcePath, kind, operation),
            requestConfigurationReload: mockReload,
          }),
          undefined,
          undefined,
          undefined,
          mockReload,
        );
        const noOpHandler = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.pullSelectedObjects');
        assert.ok(noOpHandler);
        const noOpResult = await noOpHandler({ configurationId, objectIds: ['Catalog.Products'] }) as AgentResult<{
          summary: { success: number };
        }>;
        assert.strictEqual(noOpResult.success, true, 'a confirmed no-op remains an Agent success result');
        assert.strictEqual(noOpResult.data?.summary.success, 0);
        assert.strictEqual(noOpResult.snapshotVersion, 2, 'a confirmed pull no-op does not advance the configuration snapshot');
        assert.strictEqual(reloadCalls.length, reloadCallsBeforeNoOp, 'a receipt without an exported success must not trigger reconciliation');
      } finally {
        gateway.dispose();
        await registry.dispose();
      }
    });

    test('registered agent pull holds its writer lease while export runs', async () => {
      const configRoot = tempRoot;
      await fs.writeFile(
        path.join(configRoot, 'Configuration.xml'),
        '<?xml version="1.0" encoding="UTF-8"?><MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Configuration uuid="33333333-3333-4333-8333-333333333333"><Properties><Name>PullAgentQueueTest</Name></Properties></Configuration></MetaDataObject>',
        'utf8',
      );
      vscodeTestState.mockWorkspaceFolders = [
        { name: 'ws', index: 0, uri: { fsPath: tempRoot, scheme: 'file' } },
      ];

      const reloadReasons: ReloadReason[] = [];
      const mockReload = async (_configPath: string, reason: ReloadReason): Promise<void> => { reloadReasons.push(reason); };
      const registry = new WorkspaceRegistry(undefined, (identity) => new ConfigurationSession(identity, (commit) =>
        reconcileAfterCommit(
          commit.rootPath,
          commit.kind === 'agent.pullSelectedObjects' ? 'pull-objects' : 'agent-mutation',
          (configPath, reason) => mockReload(configPath, reason),
        )));
      const session = await registry.registerTargetedRoot({ configPath: configRoot, format: ConfigFormat.Designer });
      const configurationId = session.identity.configurationId;
      const coordinator = new WorkspaceRegistryCoordinator(registry, {
        getWorkspaceFolders: () => [tempRoot],
        getWorkspaceFolderForPath: () => tempRoot,
      });
      const gateway = configureConfigurationMutationGateway(
        async (resourcePath, kind, operation) => {
          const owner = await coordinator.resolveResource(resourcePath);
          return owner.runMutationValue({ kind, execute: operation }, {
            failureMessage: 'Операция конфигурации не выполнена.',
            cancelledMessage: 'Операция конфигурации отменена.',
          });
        },
      );

      let exportStartedResolve!: () => void;
      const exportStarted = new Promise<void>((resolve) => { exportStartedResolve = resolve; });
      let finishExportResolve!: () => void;
      const finishExport = new Promise<void>((resolve) => { finishExportResolve = resolve; });
      const binding = baseBinding({ workspaceFolder: 'ws', configRelativePath: 'Configuration.xml', infobaseIds: ['base1'] });
      const targetEntry = fileEntry('base1', 'Base 1', 'C:\\ib');
      const bindingManager = {
        get: async () => binding,
        listAll: async () => [binding],
        getBindingForConfig: () => binding,
        getBindingsForWorkspaceFolder: () => [binding],
      } as unknown as BindingManager;
      const infobaseStorage = {
        load: async () => [targetEntry],
        readCatalog: async () => [targetEntry],
        readPasswordSecret: async () => null,
      } as unknown as InfobaseStorageService;
      const service = new DeployService({
        runConfigurationMutation: (resourcePath, kind, operation) => runConfigurationMutation(resourcePath, kind, operation),
        runConfigurationExportObjects: async () => {
          exportStartedResolve();
          await finishExport;
          return { status: 'success', exitCode: 0, userMessage: 'Export OK', logExcerpt: '' };
        },
      });
      const context = { subscriptions: [] as Array<{ dispose(): void }> };
      registerAgentCommands(
        context as never,
        () => null,
        async () => registry,
        new DebugSessionRegistry(),
        undefined,
        () => ({
          bindingManager,
          infobaseStorage,
          getConfigPath: () => configRoot,
          deployService: service,
          runConfigurationMutation: (resourcePath, kind, operation) => runConfigurationMutation(resourcePath, kind, operation),
          requestConfigurationReload: mockReload,
        }),
        undefined,
        undefined,
        undefined,
        mockReload,
      );

      try {
        const pullHandler = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.pullSelectedObjects');
        assert.ok(pullHandler, 'agent.pullSelectedObjects command must be registered');
        const pullPromise = pullHandler({ configurationId, objectIds: ['Catalog.Products'] }) as Promise<AgentResult<unknown>>;
        await exportStarted;

        let concurrentWriterRan = false;
        const concurrentWriter = session.enqueue({
          kind: 'test.concurrentAgentWriter',
          execute: async () => {
            concurrentWriterRan = true;
            return 'writer-done';
          },
        });
        assert.strictEqual(concurrentWriterRan, false, 'a concurrent session writer must wait while the registered Agent export is running');

        finishExportResolve();
        const result = await pullPromise;
        assert.strictEqual(result.success, true, `agent.pullSelectedObjects must succeed: ${result.error}`);
        assert.ok(result.operationId);
        const writerOutcome = await concurrentWriter;
        assert.strictEqual(writerOutcome.status, 'committed');
        assert.strictEqual(concurrentWriterRan, true);
        assert.deepStrictEqual(reloadReasons.sort(), ['agent-mutation', 'pull-objects']);
      } finally {
        for (const disposable of context.subscriptions) {
          disposable.dispose();
        }
        gateway.dispose();
        await registry.dispose();
      }
    });
  });
});
