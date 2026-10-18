import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import '../helpers/vscodeStubRegister';
import {
  publishExportedObjectsTree,
  type ConfigurationTreePublishHooks,
} from '../../src/infobases/exportedObjectsPublisher';
import {
  DeployApplicationService,
  type DeployApplicationServiceDeps,
} from '../../src/bindings/deployApplicationService';
import type { ConfigurationBinding } from '../../src/bindings/models/configurationBinding';
import type { InfobaseEntry } from '../../src/infobases/models/infobaseEntry';
import { MetadataType, type TreeNode } from '../../src/models/treeNode';
import type { ReloadReason } from '../../src/types/reloadContracts';
import { resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';

suite('pullSelectedObjects Data Integrity & Session Coordination (#350)', () => {
  let tempDir: string;
  let sourceDir: string;
  let destinationDir: string;

  setup(async () => {
    resetVscodeTestState();
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cdt-pull-integrity-'));
    sourceDir = path.join(tempDir, 'source');
    destinationDir = path.join(tempDir, 'destination');
    await fs.promises.mkdir(sourceDir, { recursive: true });
    await fs.promises.mkdir(destinationDir, { recursive: true });
  });

  teardown(async () => {
    resetVscodeTestState();
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // ─── 1. publishExportedObjectsTree: Stale Nested Artifact Cleanup ──────────

  test('publishExportedObjectsTree removes stale nested forms and updates object directory', async () => {
    // Destination has Catalog1 with OldForm and KeptForm
    const destCatDir = path.join(destinationDir, 'Catalogs', 'Catalog1');
    await fs.promises.mkdir(path.join(destCatDir, 'Forms', 'OldForm'), { recursive: true });
    await fs.promises.mkdir(path.join(destCatDir, 'Forms', 'KeptForm'), { recursive: true });
    await fs.promises.writeFile(path.join(destinationDir, 'Catalogs', 'Catalog1.xml'), '<Catalog old="true"/>', 'utf8');
    await fs.promises.writeFile(path.join(destCatDir, 'Forms', 'OldForm', 'Form.xml'), '<Form old="true"/>', 'utf8');
    await fs.promises.writeFile(path.join(destCatDir, 'Forms', 'KeptForm', 'Form.xml'), '<Form v="1"/>', 'utf8');

    // Source (exported from infobase) has Catalog1 with KeptForm and NewForm (OldForm was deleted in infobase)
    const srcCatDir = path.join(sourceDir, 'Catalogs', 'Catalog1');
    await fs.promises.mkdir(path.join(srcCatDir, 'Forms', 'KeptForm'), { recursive: true });
    await fs.promises.mkdir(path.join(srcCatDir, 'Forms', 'NewForm'), { recursive: true });
    await fs.promises.writeFile(path.join(sourceDir, 'Catalogs', 'Catalog1.xml'), '<Catalog new="true"/>', 'utf8');
    await fs.promises.writeFile(path.join(srcCatDir, 'Forms', 'KeptForm', 'Form.xml'), '<Form v="2"/>', 'utf8');
    await fs.promises.writeFile(path.join(srcCatDir, 'Forms', 'NewForm', 'Form.xml'), '<Form new="true"/>', 'utf8');
    await fs.promises.writeFile(path.join(sourceDir, 'Configuration.xml'), '<Configuration new="true"/>', 'utf8');

    const copied = await publishExportedObjectsTree(sourceDir, destinationDir);
    assert.ok(copied > 0);

    // 1. Catalog1.xml updated
    const updatedXml = await fs.promises.readFile(path.join(destinationDir, 'Catalogs', 'Catalog1.xml'), 'utf8');
    assert.strictEqual(updatedXml, '<Catalog new="true"/>');

    // 2. OldForm deleted
    const oldFormExists = fs.existsSync(path.join(destCatDir, 'Forms', 'OldForm'));
    assert.strictEqual(oldFormExists, false, 'Stale nested form must be deleted from workspace');

    // 3. KeptForm updated
    const keptXml = await fs.promises.readFile(path.join(destCatDir, 'Forms', 'KeptForm', 'Form.xml'), 'utf8');
    assert.strictEqual(keptXml, '<Form v="2"/>');

    // 4. NewForm added
    const newFormExists = fs.existsSync(path.join(destCatDir, 'Forms', 'NewForm', 'Form.xml'));
    assert.strictEqual(newFormExists, true);

    // 5. Configuration.xml updated
    const configXml = await fs.promises.readFile(path.join(destinationDir, 'Configuration.xml'), 'utf8');
    assert.strictEqual(configXml, '<Configuration new="true"/>');
  });

  // ─── 2. publishExportedObjectsTree: Object Directory Removal When Childless ──

  test('publishExportedObjectsTree removes object directory when object has no children in export', async () => {
    // Destination has EmptyCat with obsolete Forms folder
    const destCatDir = path.join(destinationDir, 'Catalogs', 'EmptyCat');
    await fs.promises.mkdir(path.join(destCatDir, 'Forms', 'ObsoleteForm'), { recursive: true });
    await fs.promises.writeFile(path.join(destCatDir, 'Forms', 'ObsoleteForm', 'Form.xml'), '<Form/>', 'utf8');
    await fs.promises.writeFile(path.join(destinationDir, 'Catalogs', 'EmptyCat.xml'), '<Catalog old="true"/>', 'utf8');

    // Source only has EmptyCat.xml without any directory
    await fs.promises.mkdir(path.join(sourceDir, 'Catalogs'), { recursive: true });
    await fs.promises.writeFile(path.join(sourceDir, 'Catalogs', 'EmptyCat.xml'), '<Catalog childless="true"/>', 'utf8');

    await publishExportedObjectsTree(sourceDir, destinationDir);

    assert.strictEqual(
      await fs.promises.readFile(path.join(destinationDir, 'Catalogs', 'EmptyCat.xml'), 'utf8'),
      '<Catalog childless="true"/>',
    );
    assert.strictEqual(fs.existsSync(destCatDir), false, 'EmptyCat directory must be removed when not present in export');
  });

  // ─── 3. publishExportedObjectsTree: Unrelated Objects Preserved ────────────

  test('publishExportedObjectsTree leaves unrelated objects and workspace files byte-identical', async () => {
    // Other object in destination
    const otherCatDir = path.join(destinationDir, 'Catalogs', 'OtherCat');
    await fs.promises.mkdir(path.join(otherCatDir, 'Forms', 'OtherForm'), { recursive: true });
    await fs.promises.writeFile(path.join(destinationDir, 'Catalogs', 'OtherCat.xml'), '<OtherCatalog/>', 'utf8');
    await fs.promises.writeFile(path.join(otherCatDir, 'Forms', 'OtherForm', 'Form.xml'), '<OtherForm/>', 'utf8');

    // Workspace notes
    await fs.promises.writeFile(path.join(destinationDir, 'README.md'), '# Notes', 'utf8');

    // Export only contains ExportedCat
    await fs.promises.mkdir(path.join(sourceDir, 'Catalogs'), { recursive: true });
    await fs.promises.writeFile(path.join(sourceDir, 'Catalogs', 'ExportedCat.xml'), '<ExportedCat/>', 'utf8');

    await publishExportedObjectsTree(sourceDir, destinationDir);

    assert.strictEqual(
      await fs.promises.readFile(path.join(destinationDir, 'Catalogs', 'OtherCat.xml'), 'utf8'),
      '<OtherCatalog/>',
    );
    assert.strictEqual(
      await fs.promises.readFile(path.join(otherCatDir, 'Forms', 'OtherForm', 'Form.xml'), 'utf8'),
      '<OtherForm/>',
    );
    assert.strictEqual(
      await fs.promises.readFile(path.join(destinationDir, 'README.md'), 'utf8'),
      '# Notes',
    );
  });

  // ─── 4. publishExportedObjectsTree: Atomic Rollback on Injected Failure ─────

  test('publishExportedObjectsTree rolls back completely when installation fails midway', async () => {
    const destCatDir = path.join(destinationDir, 'Catalogs', 'RollbackCat');
    await fs.promises.mkdir(path.join(destCatDir, 'Forms', 'OriginalForm'), { recursive: true });
    await fs.promises.writeFile(path.join(destinationDir, 'Catalogs', 'RollbackCat.xml'), '<RollbackCat original="true"/>', 'utf8');
    await fs.promises.writeFile(path.join(destCatDir, 'Forms', 'OriginalForm', 'Form.xml'), '<OriginalForm/>', 'utf8');

    const srcCatDir = path.join(sourceDir, 'Catalogs', 'RollbackCat');
    await fs.promises.mkdir(path.join(srcCatDir, 'Forms', 'NewForm'), { recursive: true });
    await fs.promises.writeFile(path.join(sourceDir, 'Catalogs', 'RollbackCat.xml'), '<RollbackCat new="true"/>', 'utf8');
    await fs.promises.writeFile(path.join(srcCatDir, 'Forms', 'NewForm', 'Form.xml'), '<NewForm/>', 'utf8');

    let failRename = true;
    const hooks: ConfigurationTreePublishHooks = {
      rename: async (from: string, to: string) => {
        // Injected failure when installing from staging into destination
        if (failRename && from.includes('staging') && to.includes('RollbackCat.xml')) {
          failRename = false;
          throw new Error('Injected rename failure');
        }
        await fs.promises.rename(from, to);
      },
    };

    await assert.rejects(
      publishExportedObjectsTree(sourceDir, destinationDir, hooks),
      /Injected rename failure/,
    );

    // Rollback restored original state
    assert.strictEqual(
      await fs.promises.readFile(path.join(destinationDir, 'Catalogs', 'RollbackCat.xml'), 'utf8'),
      '<RollbackCat original="true"/>',
    );
    assert.strictEqual(
      await fs.promises.readFile(path.join(destCatDir, 'Forms', 'OriginalForm', 'Form.xml'), 'utf8'),
      '<OriginalForm/>',
    );
    assert.strictEqual(fs.existsSync(path.join(destCatDir, 'Forms', 'NewForm')), false);
  });

  // ─── 5. DeployApplicationService: ConfigurationSession Write Lock & ReloadCoordinator ──

  test('executePullSelectedObjects acquires session write lock and triggers ReloadCoordinator on success', async () => {
    let lockAcquiredKind = '';
    let lockAcquiredPath = '';
    let reloadTriggeredPath = '';
    let reloadTriggeredReason = '';

    const mockDeployService: any = {
      pullSelectedObjects: async () => ({
        successCount: 1,
        errorCount: 0,
        inDoubtCount: 0,
        skippedCount: 0,
        hasPartial: false,
        cancelledMidChain: false,
        results: [{ infobaseId: 'ib-1', name: 'TargetBase', status: 'success', message: 'Ok' }],
      }),
    };

    const mockBinding: ConfigurationBinding = {
      workspaceFolder: 'test-ws',
      configRelativePath: 'Configuration.xml',
      infobaseIds: ['ib-1'],
      massDeployment: false,
    };

    const targetEntry: InfobaseEntry = {
      id: 'ib-1',
      name: 'TargetBase',
      type: 'file',
      filePath: path.join(tempDir, 'ib'),
      hasStoredPassword: false,
      createdAt: new Date().toISOString(),
    };

    const svc = new DeployApplicationService({
      bindingManager: {
        get: async () => mockBinding,
        listAll: async () => [mockBinding],
      } as any,
      infobaseStorage: {
        load: async () => [targetEntry],
        readPasswordSecret: async () => undefined,
      } as any,
      deployService: mockDeployService,
      runConfigurationMutation: async <T>(resourcePath: string, kind: string, operation: () => Promise<T>): Promise<T> => {
        lockAcquiredPath = resourcePath;
        lockAcquiredKind = kind;
        return operation();
      },
      requestConfigurationReload: async (configPath: string, reason: ReloadReason): Promise<void> => {
        reloadTriggeredPath = configPath;
        reloadTriggeredReason = reason;
      },
    });

    const context = {
      configRoot: destinationDir,
      workspaceFolder: { uri: vscode.Uri.file(destinationDir), name: 'test-ws', index: 0 },
      workspaceFolderRoot: destinationDir,
      binding: mockBinding,
      catalog: [targetEntry],
      deployTargets: [targetEntry],
      skippedTargets: [],
      previewLabels: [],
    };

    const node: TreeNode = {
      id: 'Catalog.Catalog1',
      name: 'Catalog1',
      type: MetadataType.Catalog,
      properties: {},
    };

    const outcome = await svc.executePullSelectedObjects(context, [node], { entry: targetEntry });

    assert.strictEqual(outcome.success, true);
    assert.strictEqual(lockAcquiredPath, destinationDir, 'Must acquire lock on configRoot');
    assert.strictEqual(lockAcquiredKind, 'pullSelectedObjects', 'Must acquire pullSelectedObjects write lock');
    assert.strictEqual(reloadTriggeredPath, destinationDir, 'Must trigger reload for configRoot');
    assert.strictEqual(reloadTriggeredReason, 'pull-objects', 'Must pass pull-objects reload reason');
  });

  test('executePullSelectedObjects does not trigger reload when operation fails', async () => {
    let reloadTriggered = false;

    const mockDeployService: any = {
      pullSelectedObjects: async () => ({
        successCount: 0,
        errorCount: 1,
        inDoubtCount: 0,
        skippedCount: 0,
        hasPartial: false,
        cancelledMidChain: false,
        results: [{ infobaseId: 'ib-1', name: 'TargetBase', status: 'error', message: 'Fail' }],
      }),
    };

    const targetEntry: InfobaseEntry = {
      id: 'ib-1',
      name: 'TargetBase',
      type: 'file',
      filePath: path.join(tempDir, 'ib'),
      hasStoredPassword: false,
      createdAt: new Date().toISOString(),
    };

    const svc = new DeployApplicationService({
      bindingManager: {} as any,
      infobaseStorage: {} as any,
      deployService: mockDeployService,
      runConfigurationMutation: async <T>(_path: string, _kind: string, op: () => Promise<T>) => op(),
      requestConfigurationReload: async () => { reloadTriggered = true; },
    });

    const context = {
      configRoot: destinationDir,
      workspaceFolder: { uri: vscode.Uri.file(destinationDir), name: 'test-ws', index: 0 },
      workspaceFolderRoot: destinationDir,
      binding: {} as any,
      catalog: [targetEntry],
      deployTargets: [targetEntry],
      skippedTargets: [],
      previewLabels: [],
    };

    const outcome = await svc.executePullSelectedObjects(context, [], { entry: targetEntry });
    assert.strictEqual(outcome.success, false);
    assert.strictEqual(reloadTriggered, false, 'Failed pull must not trigger reload');
  });

  // ─── 6. EDT Format Support ────────────────────────────────────────────────

  test('publishExportedObjectsTree handles EDT format structure with src/ prefix', async () => {
    // Destination has EDT Catalog Goods with old Form
    const destCatDir = path.join(destinationDir, 'src', 'Catalogs', 'Goods');
    await fs.promises.mkdir(path.join(destCatDir, 'Forms', 'OldForm'), { recursive: true });
    await fs.promises.mkdir(path.join(destinationDir, 'src', 'Configuration'), { recursive: true });
    await fs.promises.writeFile(path.join(destinationDir, 'src', 'Configuration', 'Configuration.mdo'), '<Configuration old="true"/>', 'utf8');
    await fs.promises.writeFile(path.join(destinationDir, 'src', 'Catalogs', 'Goods.mdo'), '<Catalog old="true"/>', 'utf8');
    await fs.promises.writeFile(path.join(destCatDir, 'Forms', 'OldForm', 'Form.form'), '<Form old="true"/>', 'utf8');

    // Source (exported from infobase) has updated Goods.mdo and NewForm
    const srcCatDir = path.join(sourceDir, 'src', 'Catalogs', 'Goods');
    await fs.promises.mkdir(path.join(srcCatDir, 'Forms', 'NewForm'), { recursive: true });
    await fs.promises.mkdir(path.join(sourceDir, 'src', 'Configuration'), { recursive: true });
    await fs.promises.writeFile(path.join(sourceDir, 'src', 'Configuration', 'Configuration.mdo'), '<Configuration new="true"/>', 'utf8');
    await fs.promises.writeFile(path.join(sourceDir, 'src', 'Catalogs', 'Goods.mdo'), '<Catalog new="true"/>', 'utf8');
    await fs.promises.writeFile(path.join(srcCatDir, 'Forms', 'NewForm', 'Form.form'), '<Form new="true"/>', 'utf8');

    const count = await publishExportedObjectsTree(sourceDir, destinationDir);
    assert.ok(count > 0);

    assert.strictEqual(
      await fs.promises.readFile(path.join(destinationDir, 'src', 'Catalogs', 'Goods.mdo'), 'utf8'),
      '<Catalog new="true"/>',
    );
    assert.strictEqual(
      await fs.promises.readFile(path.join(destinationDir, 'src', 'Configuration', 'Configuration.mdo'), 'utf8'),
      '<Configuration new="true"/>',
    );
    assert.strictEqual(
      await fs.promises.readFile(path.join(destCatDir, 'Forms', 'NewForm', 'Form.form'), 'utf8'),
      '<Form new="true"/>',
    );
    assert.strictEqual(fs.existsSync(path.join(destCatDir, 'Forms', 'OldForm')), false, 'Stale EDT form must be removed');
  });

  // ─── 7. Multiple Heterogeneous Metadata Objects ───────────────────────────

  test('publishExportedObjectsTree handles multiple heterogeneous metadata objects simultaneously', async () => {
    // Destination has Catalog1 (with OldForm) and Document1 (with OldTemplate)
    const destCatDir = path.join(destinationDir, 'Catalogs', 'Cat1');
    const destDocDir = path.join(destinationDir, 'Documents', 'Doc1');
    await fs.promises.mkdir(path.join(destCatDir, 'Forms', 'OldForm'), { recursive: true });
    await fs.promises.mkdir(path.join(destDocDir, 'Templates', 'OldTpl'), { recursive: true });
    await fs.promises.writeFile(path.join(destinationDir, 'Catalogs', 'Cat1.xml'), '<Cat1/>', 'utf8');
    await fs.promises.writeFile(path.join(destinationDir, 'Documents', 'Doc1.xml'), '<Doc1/>', 'utf8');
    await fs.promises.writeFile(path.join(destCatDir, 'Forms', 'OldForm', 'Form.xml'), '<Form/>', 'utf8');
    await fs.promises.writeFile(path.join(destDocDir, 'Templates', 'OldTpl', 'Template.xml'), '<Tpl/>', 'utf8');

    // Source has updated Cat1 (with NewForm) and updated Doc1 (with NewTpl)
    const srcCatDir = path.join(sourceDir, 'Catalogs', 'Cat1');
    const srcDocDir = path.join(sourceDir, 'Documents', 'Doc1');
    await fs.promises.mkdir(path.join(srcCatDir, 'Forms', 'NewForm'), { recursive: true });
    await fs.promises.mkdir(path.join(srcDocDir, 'Templates', 'NewTpl'), { recursive: true });
    await fs.promises.writeFile(path.join(sourceDir, 'Catalogs', 'Cat1.xml'), '<Cat1 v="2"/>', 'utf8');
    await fs.promises.writeFile(path.join(sourceDir, 'Documents', 'Doc1.xml'), '<Doc1 v="2"/>', 'utf8');
    await fs.promises.writeFile(path.join(srcCatDir, 'Forms', 'NewForm', 'Form.xml'), '<NewForm/>', 'utf8');
    await fs.promises.writeFile(path.join(srcDocDir, 'Templates', 'NewTpl', 'Template.xml'), '<NewTpl/>', 'utf8');

    await publishExportedObjectsTree(sourceDir, destinationDir);

    assert.strictEqual(await fs.promises.readFile(path.join(destinationDir, 'Catalogs', 'Cat1.xml'), 'utf8'), '<Cat1 v="2"/>');
    assert.strictEqual(await fs.promises.readFile(path.join(destinationDir, 'Documents', 'Doc1.xml'), 'utf8'), '<Doc1 v="2"/>');
    assert.strictEqual(fs.existsSync(path.join(destCatDir, 'Forms', 'OldForm')), false);
    assert.strictEqual(fs.existsSync(path.join(destDocDir, 'Templates', 'OldTpl')), false);
    assert.strictEqual(fs.existsSync(path.join(destCatDir, 'Forms', 'NewForm', 'Form.xml')), true);
    assert.strictEqual(fs.existsSync(path.join(destDocDir, 'Templates', 'NewTpl', 'Template.xml')), true);
  });
});
