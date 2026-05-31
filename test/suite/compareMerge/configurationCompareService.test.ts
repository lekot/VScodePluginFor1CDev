import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { buildConfigurationCompare } from '../../../src/compareMerge/configurationCompareService';
import type { CompareTreeNode } from '../../../src/compareMerge/compareTreeTypes';

suite('ConfigurationCompareService', () => {
  test('workspace previews and executes right-only BSL routine insert from built compare', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const backupRoot = path.join(tempRoot, 'backups');
    const leftModulePath = path.join(leftRoot, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');
    const rightModulePath = path.join(rightRoot, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');
    const leftSource = [
      'Procedure Shared()',
      '  Value = 1;',
      'EndProcedure',
    ].join('\n');
    const rightSource = [
      leftSource,
      '',
      'Procedure AddedOnRight()',
      '  Value = 2;',
      'EndProcedure',
    ].join('\n');
    const expectedMergedSource = [
      leftSource,
      'Procedure AddedOnRight()',
      '  Value = 2;',
      'EndProcedure',
    ].join('\n');

    try {
      await writeCatalog(leftRoot, 'Products', 'catalog-products');
      await writeCatalog(rightRoot, 'Products', 'catalog-products');
      await writeFile(leftModulePath, leftSource);
      await writeFile(rightModulePath, rightSource);

      const result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: backupRoot,
        createdAt: new Date('2026-05-30T10:00:00.000Z'),
      });
      const nodeId = 'bsl:routine:Catalog.Products.Object:addedonright';

      assert.strictEqual(result.session.state.sources[0]?.rootUri, pathToFileURL(leftRoot).toString());
      assert.strictEqual(result.session.state.sources[1]?.rootUri, pathToFileURL(rightRoot).toString());

      const addedRoutine = requireNode(result.projection.root, nodeId);
      assert.strictEqual(addedRoutine.kind, 'bslRoutine');
      assert.strictEqual(addedRoutine.status, 'rightOnly');
      assert.strictEqual(addedRoutine.mergeable, true);
      assert.strictEqual(addedRoutine.mergeState?.state, 'ready');
      assert.ok(result.workspace, 'Expected build result to expose workspace for provider.');
      assert.deepStrictEqual(result.workspace.listMergeableNodeIds(), [nodeId]);

      const preview = await result.workspace.createPreviewForNodeIds([nodeId]);
      assert.strictEqual(preview.ok, true, JSON.stringify(preview));
      assert.strictEqual(preview.preview.operationCount, 1);
      assert.deepStrictEqual(preview.preview.items, [
        {
          nodeId,
          label: 'AddedOnRight',
          kind: 'bslRoutine',
          status: 'rightOnly',
        },
      ]);

      result.workspace.approvePreview(preview.preview.previewId);
      const execution = await result.workspace.executeApprovedPreview(preview.preview.previewId, {
        destructiveConfirmed: true,
      });

      assert.strictEqual(execution.ok, true, JSON.stringify(execution));
      assert.strictEqual(await readText(leftModulePath), expectedMergedSource);
      assert.strictEqual(await readText(rightModulePath), rightSource);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('workspace previews and executes left-only BSL routine delete from built compare', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const backupRoot = path.join(tempRoot, 'backups');
    const leftModulePath = path.join(leftRoot, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');
    const rightModulePath = path.join(rightRoot, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');
    const sharedRoutine = [
      'Procedure Shared()',
      '  Value = 1;',
      'EndProcedure',
    ].join('\n');
    const leftSource = [
      sharedRoutine,
      '',
      'Procedure RemovedOnLeft()',
      '  Value = 2;',
      'EndProcedure',
    ].join('\n');

    try {
      await writeCatalog(leftRoot, 'Products', 'catalog-products');
      await writeCatalog(rightRoot, 'Products', 'catalog-products');
      await writeFile(leftModulePath, leftSource);
      await writeFile(rightModulePath, sharedRoutine);

      const result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: backupRoot,
        createdAt: new Date('2026-05-30T10:00:00.000Z'),
      });
      const nodeId = 'bsl:routine:Catalog.Products.Object:removedonleft';
      const deletedRoutine = requireNode(result.projection.root, nodeId);

      assert.strictEqual(deletedRoutine.kind, 'bslRoutine');
      assert.strictEqual(deletedRoutine.status, 'leftOnly');
      assert.strictEqual(deletedRoutine.mergeable, true);
      assert.strictEqual(deletedRoutine.mergeState?.state, 'ready');
      assert.deepStrictEqual(result.workspace.listMergeableNodeIds(), [nodeId]);

      const preview = await result.workspace.createPreviewForNodeIds([nodeId]);
      assert.strictEqual(preview.ok, true, JSON.stringify(preview));
      assert.strictEqual(preview.preview.operationCount, 1);
      assert.deepStrictEqual(preview.preview.items, [
        {
          nodeId,
          label: 'RemovedOnLeft',
          kind: 'bslRoutine',
          status: 'leftOnly',
        },
      ]);

      result.workspace.approvePreview(preview.preview.previewId);
      const execution = await result.workspace.executeApprovedPreview(preview.preview.previewId, {
        destructiveConfirmed: true,
      });

      assert.strictEqual(execution.ok, true, JSON.stringify(execution));
      assert.strictEqual(await readText(leftModulePath), `${sharedRoutine}\n`);
      assert.strictEqual(await readText(rightModulePath), sharedRoutine);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('projects right-only BSL module as visible difference', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const rightModulePath = path.join(rightRoot, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');

    try {
      await writeCatalog(leftRoot, 'Products', 'catalog-products');
      await writeCatalog(rightRoot, 'Products', 'catalog-products');
      await writeFile(
        rightModulePath,
        [
          'Procedure AddedOnRight()',
          '  Value = 2;',
          'EndProcedure',
        ].join('\n')
      );

      const result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: path.join(tempRoot, 'backups'),
      });

      assert.ok(result.projection.stats.different > 0);

      const rightOnlyMessages = collectNodes(
        result.projection.root,
        (node) => node.kind === 'diagnostic' && node.label === 'BSL_MODULE_RIGHT_ONLY'
      );
      assert.strictEqual(rightOnlyMessages.length, 1);
      const rightOnlyMessage = rightOnlyMessages[0]!;
      assert.strictEqual(rightOnlyMessage.status, 'rightOnly');
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('does not duplicate matched BSL module diagnostics in projection', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const leftModulePath = path.join(leftRoot, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');
    const rightModulePath = path.join(rightRoot, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');

    try {
      await writeCatalog(leftRoot, 'Products', 'catalog-products');
      await writeCatalog(rightRoot, 'Products', 'catalog-products');
      await writeFile(leftModulePath, duplicateRoutineSource());
      await writeFile(rightModulePath, duplicateRoutineSource());

      const result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: path.join(tempRoot, 'backups'),
      });
      const duplicateDiagnostics = collectNodes(
        result.projection.root,
        (node) => node.kind === 'diagnostic' && node.label === 'BSL_MODULE_DUPLICATE_ROUTINE'
      );

      assert.strictEqual(duplicateDiagnostics.length, 2);
      assert.strictEqual(
        new Set(duplicateDiagnostics.map((node) => node.id)).size,
        duplicateDiagnostics.length
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('workspace preview succeeds for changed routine with automatic logical insert plan', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const leftModulePath = path.join(leftRoot, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');
    const rightModulePath = path.join(rightRoot, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');

    try {
      await writeCatalog(leftRoot, 'Products', 'catalog-products');
      await writeCatalog(rightRoot, 'Products', 'catalog-products');
      await writeFile(leftModulePath, logicalBaseRoutine());
      await writeFile(rightModulePath, logicalIncomingRoutine());

      const result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: path.join(tempRoot, 'backups'),
        createdAt: new Date('2026-05-30T10:00:00.000Z'),
      });
      const nodeId = 'bsl:routine:Catalog.Products.Object:run';
      const changedRoutine = requireNode(result.projection.root, nodeId);

      assert.strictEqual(changedRoutine.mergeable, true);
      assert.deepStrictEqual(result.workspace.listMergeableNodeIds(), [nodeId]);

      const previewResult = await result.workspace.createPreviewForNodeIds([nodeId]);

      assert.strictEqual(previewResult.ok, true);
      assert.strictEqual(previewResult.preview.operationCount, 1);
      assert.deepStrictEqual(previewResult.preview.items, [
        {
          nodeId,
          label: 'Run',
          kind: 'bslRoutine',
          status: 'changed',
        },
      ]);
      assert.deepStrictEqual(previewResult.diagnostics, []);
      assert.strictEqual(JSON.stringify(previewResult.preview).includes(leftModulePath), false);
      assert.strictEqual(JSON.stringify(previewResult.preview).includes('expectedOldHash'), false);
      assert.strictEqual(JSON.stringify(previewResult.preview).includes('operations'), false);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('workspace executes built compare with file rootUri and random exclusive backup path', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const backupRoot = path.join(tempRoot, 'backups');
    const leftModulePath = path.join(leftRoot, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');
    const rightModulePath = path.join(rightRoot, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');
    const deterministicBackupPath = path.join(backupRoot, 'preview-1', 'operation-0.bak');

    try {
      await writeCatalog(leftRoot, 'Products', 'catalog-products');
      await writeCatalog(rightRoot, 'Products', 'catalog-products');
      await writeFile(leftModulePath, logicalBaseRoutine());
      await writeFile(rightModulePath, logicalIncomingRoutine());
      await writeFile(deterministicBackupPath, 'do-not-overwrite');

      const result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: backupRoot,
        createdAt: new Date('2026-05-30T10:00:00.000Z'),
      });
      const nodeId = 'bsl:routine:Catalog.Products.Object:run';
      const preview = await result.workspace.createPreviewForNodeIds([nodeId]);
      assert.strictEqual(preview.ok, true);
      const approval = result.workspace.approvePreview(preview.preview.previewId);
      assert.strictEqual(approval.ok, true);

      const execution = await result.workspace.executeApprovedPreview(preview.preview.previewId, {
        destructiveConfirmed: true,
      });

      assert.strictEqual(execution.ok, true, JSON.stringify(execution));
      assert.strictEqual(await readText(leftModulePath), logicalIncomingRoutine());
      assert.strictEqual(await readText(deterministicBackupPath), 'do-not-overwrite');
      assert.strictEqual(execution.result.backupPaths.length, 1);
      const backupPath = execution.result.backupPaths[0]!;
      assert.notStrictEqual(backupPath, deterministicBackupPath);
      assert.strictEqual(path.dirname(backupPath), path.join(backupRoot, preview.preview.previewId));
      assert.notStrictEqual(path.basename(backupPath), 'operation-0.bak');
      assert.strictEqual(await readText(backupPath), logicalBaseRoutine());
      assert.strictEqual(
        fileURLToPath(result.session.state.sources[0]!.rootUri),
        path.resolve(leftRoot)
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('single routine execution succeeds when module has another independent changed routine', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const backupRoot = path.join(tempRoot, 'backups');
    const leftModulePath = path.join(leftRoot, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');
    const rightModulePath = path.join(rightRoot, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');

    try {
      await writeCatalog(leftRoot, 'Products', 'catalog-products');
      await writeCatalog(rightRoot, 'Products', 'catalog-products');
      await writeFile(leftModulePath, `${logicalBaseRoutine()}\n\n${secondBaseRoutine()}`);
      await writeFile(rightModulePath, `${logicalIncomingRoutine()}\n\n${secondIncomingRoutine()}`);

      const result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: backupRoot,
        createdAt: new Date('2026-05-30T10:00:00.000Z'),
      });

      assert.deepStrictEqual(result.workspace.listMergeableNodeIds(), [
        'bsl:routine:Catalog.Products.Object:other',
        'bsl:routine:Catalog.Products.Object:run',
      ]);

      const preview = await result.workspace.createPreviewForNodeIds([
        'bsl:routine:Catalog.Products.Object:run',
      ]);
      assert.strictEqual(preview.ok, true);
      result.workspace.approvePreview(preview.preview.previewId);

      const execution = await result.workspace.executeApprovedPreview(preview.preview.previewId, {
        destructiveConfirmed: true,
      });

      assert.strictEqual(execution.ok, true, JSON.stringify(execution));
      assert.strictEqual(await readText(leftModulePath), `${logicalIncomingRoutine()}\n\n${secondBaseRoutine()}`);
      assert.strictEqual(await readText(rightModulePath), `${logicalIncomingRoutine()}\n\n${secondIncomingRoutine()}`);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('manual changed routine is visible but not advertised as executable', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const leftModulePath = path.join(leftRoot, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');
    const rightModulePath = path.join(rightRoot, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');

    try {
      await writeCatalog(leftRoot, 'Products', 'catalog-products');
      await writeCatalog(rightRoot, 'Products', 'catalog-products');
      await writeFile(leftModulePath, logicalBaseRoutine());
      await writeFile(rightModulePath, logicalManualRoutine());

      const result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: path.join(tempRoot, 'backups'),
      });
      const nodeId = 'bsl:routine:Catalog.Products.Object:run';
      const changedRoutine = requireNode(result.projection.root, nodeId);

      assert.strictEqual(changedRoutine.status, 'changed');
      assert.strictEqual(changedRoutine.mergeable, false);
      assert.deepStrictEqual(result.workspace.listMergeableNodeIds(), []);
      const preview = await result.workspace.createPreviewForNodeIds([nodeId]);
      assert.strictEqual(preview.ok, false);
      assert.strictEqual(preview.diagnostics[0]?.code, 'CONFIG_COMPARE_UNKNOWN_SELECTION');
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('projects mergeable XML adapter differences from configuration inventory', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const backupRoot = path.join(tempRoot, 'backups');

    try {
      await writeCatalogDescriptor(leftRoot, 'Products', 'catalog-products', 'Old goods');
      await writeCatalogDescriptor(rightRoot, 'Products', 'catalog-products', 'New goods');
      await writeFile(
        path.join(leftRoot, 'Catalogs', 'Products', 'Ext', 'Form.xml'),
        formXml('Old title')
      );
      await writeFile(
        path.join(rightRoot, 'Catalogs', 'Products', 'Ext', 'Form.xml'),
        formXml('New title')
      );
      await writeFile(
        path.join(leftRoot, 'Catalogs', 'Products', 'Ext', 'Predefined.xml'),
        predefinedXml('Old main')
      );
      await writeFile(
        path.join(rightRoot, 'Catalogs', 'Products', 'Ext', 'Predefined.xml'),
        predefinedXml('New main')
      );
      await writeFile(path.join(leftRoot, 'Catalogs', 'Products', 'Ext', 'logo.txt'), 'old-logo');
      await writeFile(path.join(rightRoot, 'Catalogs', 'Products', 'Ext', 'logo.txt'), 'new-logo');

      const result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: backupRoot,
        createdAt: new Date('2026-05-30T10:00:00.000Z'),
      });

      const synonym = requireNodeByLabel(result.projection.root, 'Synonym', 'Old goods', 'New goods');
      const title = requireNodeByLabel(result.projection.root, 'Title', 'Old title', 'New title');
      const presentation = requireNodeByLabel(
        result.projection.root,
        'Presentation',
        'Old main',
        'New main'
      );
      const logo = requireSingleNode(
        result.projection.root,
        (node) => node.kind === 'fileArtifact' && node.label === 'logo.txt'
      );

      assert.strictEqual(synonym.mergeable, true);
      assert.strictEqual(title.mergeable, true);
      assert.strictEqual(presentation.mergeable, true);
      assert.strictEqual(logo.mergeable, true);
      assert.ok(result.workspace.listMergeableNodeIds().includes(synonym.id));
      assert.ok(result.workspace.listMergeableNodeIds().includes(title.id));
      assert.ok(result.workspace.listMergeableNodeIds().includes(presentation.id));
      assert.ok(result.workspace.listMergeableNodeIds().includes(logo.id));

      const preview = await result.workspace.createPreviewForNodeIds([title.id]);
      const filePreview = await result.workspace.createPreviewForNodeIds([logo.id]);

      assert.strictEqual(preview.ok, true);
      assert.strictEqual(preview.preview.operationCount, 1);
      assert.deepStrictEqual(preview.preview.items, [
        {
          nodeId: title.id,
          label: 'Title',
          kind: 'xmlProperty',
          status: 'changed',
        },
      ]);
      assert.strictEqual(filePreview.ok, true);
      assert.strictEqual(filePreview.preview.operationCount, 1);
      assert.deepStrictEqual(filePreview.preview.items, [
        {
          nodeId: logo.id,
          label: 'logo.txt',
          kind: 'fileArtifact',
          status: 'changed',
        },
      ]);

      result.workspace.approvePreview(preview.preview.previewId);
      const xmlExecution = await result.workspace.executeApprovedPreview(preview.preview.previewId);
      assert.strictEqual(xmlExecution.ok, true, JSON.stringify(xmlExecution));
      assert.strictEqual(
        await readText(path.join(leftRoot, 'Catalogs', 'Products', 'Ext', 'Form.xml')),
        formXml('New title')
      );

      const refreshedLogo = requireSingleNode(
        result.workspace.payload.root,
        (node) => node.kind === 'fileArtifact' && node.label === 'logo.txt'
      );
      const refreshedFilePreview = await result.workspace.createPreviewForNodeIds([refreshedLogo.id]);
      assert.strictEqual(refreshedFilePreview.ok, true);
      result.workspace.approvePreview(refreshedFilePreview.preview.previewId);
      const fileExecution = await result.workspace.executeApprovedPreview(refreshedFilePreview.preview.previewId);
      assert.strictEqual(fileExecution.ok, true, JSON.stringify(fileExecution));
      assert.strictEqual(
        await readText(path.join(leftRoot, 'Catalogs', 'Products', 'Ext', 'logo.txt')),
        'new-logo'
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('same-name different-uuid metadata conflict still exposes descriptor property merge', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');

    try {
      await writeCatalogDescriptor(leftRoot, 'Products', 'left-catalog-products', 'Old goods');
      await writeCatalogDescriptor(rightRoot, 'Products', 'right-catalog-products', 'New goods');

      const result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: path.join(tempRoot, 'backups'),
        createdAt: new Date('2026-05-30T10:00:00.000Z'),
      });

      const identityConflict = requireSingleNode(
        result.projection.root,
        (node) =>
          node.kind === 'metadataConflict' &&
          node.label === 'Catalog.Products' &&
          node.conflict?.kind === 'sameNameDifferentUuid'
      );
      const synonym = requireNodeByLabel(result.projection.root, 'Synonym', 'Old goods', 'New goods');

      assert.strictEqual(identityConflict.mergeable, false);
      assert.strictEqual(synonym.mergeable, true);
      assert.ok(result.workspace.listMergeableNodeIds().includes(synonym.id));
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('projects merge nodes for representative non-catalog metadata types', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');

    try {
      for (const fixture of representativeMetadataFixtures()) {
        await writeMetadataDescriptor(leftRoot, fixture.relativePath, fixture.metadataType, fixture.name, fixture.uuid, 'Old');
        await writeMetadataDescriptor(rightRoot, fixture.relativePath, fixture.metadataType, fixture.name, fixture.uuid, 'New');
      }
      await writeFile(
        path.join(leftRoot, 'CommonForms', 'Chooser', 'Ext', 'Form.xml'),
        formXml('Old common form title')
      );
      await writeFile(
        path.join(rightRoot, 'CommonForms', 'Chooser', 'Ext', 'Form.xml'),
        formXml('New common form title')
      );
      await writeFile(
        path.join(leftRoot, 'ChartsOfCharacteristicTypes', 'Properties', 'Ext', 'Predefined.xml'),
        predefinedXml('Old predefined')
      );
      await writeFile(
        path.join(rightRoot, 'ChartsOfCharacteristicTypes', 'Properties', 'Ext', 'Predefined.xml'),
        predefinedXml('New predefined')
      );

      const result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: path.join(tempRoot, 'backups'),
        createdAt: new Date('2026-05-30T10:00:00.000Z'),
      });

      const expectedDescriptorNodes = [
        'Document.Order',
        'Enum.Status',
        'Role.Admin',
        'InformationRegister.Stock.Dimension.Warehouse',
        'Document.Order.TabularSection.Goods',
      ];
      for (const qualifiedName of expectedDescriptorNodes) {
        const synonym = requireNodeByLabel(
          result.projection.root,
          'Synonym',
          `${qualifiedName} Old`,
          `${qualifiedName} New`
        );
        assert.strictEqual(synonym.mergeable, true, qualifiedName);
      }

      const commonFormTitle = requireNodeByLabel(
        result.projection.root,
        'Title',
        'Old common form title',
        'New common form title'
      );
      const predefinedPresentation = requireNodeByLabel(
        result.projection.root,
        'Presentation',
        'Old predefined',
        'New predefined'
      );

      assert.strictEqual(commonFormTitle.mergeable, true);
      assert.strictEqual(predefinedPresentation.mergeable, true);
      assert.ok(result.workspace.listMergeableNodeIds().includes(commonFormTitle.id));
      assert.ok(result.workspace.listMergeableNodeIds().includes(predefinedPresentation.id));
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('workspace executes right-only binary artifact copy preserving bytes', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const backupRoot = path.join(tempRoot, 'backups');
    const leftLogoPath = path.join(leftRoot, 'Catalogs', 'Products', 'Ext', 'logo.bin');
    const rightLogoPath = path.join(rightRoot, 'Catalogs', 'Products', 'Ext', 'logo.bin');
    const rightBytes = Buffer.from([0x00, 0xff, 0x41, 0x80, 0x0a]);

    try {
      await writeCatalogDescriptor(leftRoot, 'Products', 'catalog-products', 'Products');
      await writeCatalogDescriptor(rightRoot, 'Products', 'catalog-products', 'Products');
      await writeFileBytes(rightLogoPath, rightBytes);

      const result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: backupRoot,
        createdAt: new Date('2026-05-30T10:00:00.000Z'),
      });
      const strategy = await result.workspace.setStrategy('full');
      assert.strictEqual(strategy.ok, true, JSON.stringify(strategy));
      const logo = requireSingleNode(
        result.workspace.payload.root,
        (node) => node.kind === 'fileArtifact' && node.label === 'logo.bin'
      );

      const preview = await result.workspace.createPreviewForNodeIds([logo.id]);
      assert.strictEqual(preview.ok, true, JSON.stringify(preview));
      result.workspace.approvePreview(preview.preview.previewId);
      const execution = await result.workspace.executeApprovedPreview(preview.preview.previewId, {
        destructiveConfirmed: true,
      });

      assert.strictEqual(execution.ok, true, JSON.stringify(execution));
      assert.deepStrictEqual(await fs.readFile(leftLogoPath), rightBytes);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('workspace executes left-only binary artifact delete backing up bytes', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const backupRoot = path.join(tempRoot, 'backups');
    const leftLogoPath = path.join(leftRoot, 'Catalogs', 'Products', 'Ext', 'logo.bin');
    const leftBytes = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0xfe]);

    try {
      await writeCatalogDescriptor(leftRoot, 'Products', 'catalog-products', 'Products');
      await writeCatalogDescriptor(rightRoot, 'Products', 'catalog-products', 'Products');
      await writeFileBytes(leftLogoPath, leftBytes);
      await fs.rm(path.join(rightRoot, 'Catalogs', 'Products', 'Ext', 'logo.bin'), {
        force: true,
      });

      const result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: backupRoot,
        createdAt: new Date('2026-05-30T10:00:00.000Z'),
      });
      const strategy = await result.workspace.setStrategy('full');
      assert.strictEqual(strategy.ok, true, JSON.stringify(strategy));
      const logo = requireSingleNode(
        result.workspace.payload.root,
        (node) => node.kind === 'fileArtifact' && node.label === 'logo.bin'
      );

      const preview = await result.workspace.createPreviewForNodeIds([logo.id]);
      assert.strictEqual(preview.ok, true, JSON.stringify(preview));
      result.workspace.approvePreview(preview.preview.previewId);
      const execution = await result.workspace.executeApprovedPreview(preview.preview.previewId, {
        destructiveConfirmed: true,
      });

      assert.strictEqual(execution.ok, true, JSON.stringify(execution));
      await assert.rejects(fs.stat(leftLogoPath));
      assert.strictEqual(execution.result.backupPaths.length, 1);
      assert.deepStrictEqual(await fs.readFile(execution.result.backupPaths[0]!), leftBytes);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('workspace executes right-only object folder copy with missing-target guard', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const backupRoot = path.join(tempRoot, 'backups');
    const leftCatalogPath = path.join(leftRoot, 'Catalogs', 'Products');
    const rightLogoPath = path.join(rightRoot, 'Catalogs', 'Products', 'Ext', 'logo.bin');
    const rightBytes = Buffer.from([0xde, 0xad, 0xbe, 0xef]);

    try {
      await fs.mkdir(leftRoot, { recursive: true });
      await writeFileBytes(rightLogoPath, rightBytes);
      await writeCatalogDescriptor(rightRoot, 'Products', 'catalog-products', 'Products');

      const result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: backupRoot,
        createdAt: new Date('2026-05-30T10:00:00.000Z'),
      });
      const products = requireSingleNode(
        result.projection.root,
        (node) =>
          node.kind === 'metadataObject' &&
          node.label === 'Catalog.Products' &&
          node.id.startsWith('fileObject:rightOnly:') &&
          node.status === 'rightOnly'
      );

      const preview = await result.workspace.createPreviewForNodeIds([products.id]);
      assert.strictEqual(preview.ok, true, JSON.stringify(preview));
      result.workspace.approvePreview(preview.preview.previewId);
      const execution = await result.workspace.executeApprovedPreview(preview.preview.previewId, {
        destructiveConfirmed: true,
      });

      assert.strictEqual(execution.ok, true, JSON.stringify(execution));
      assert.deepStrictEqual(
        await fs.readFile(path.join(leftCatalogPath, 'Ext', 'logo.bin')),
        rightBytes
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('workspace executes left-only object folder delete with directory hash guard', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const backupRoot = path.join(tempRoot, 'backups');
    const leftCatalogPath = path.join(leftRoot, 'Catalogs', 'Products');
    const leftBytes = Buffer.from([0xca, 0xfe, 0xba, 0xbe]);

    try {
      await writeFileBytes(path.join(leftCatalogPath, 'Ext', 'logo.bin'), leftBytes);
      await writeCatalogDescriptor(leftRoot, 'Products', 'catalog-products', 'Products');
      await fs.mkdir(rightRoot, { recursive: true });

      const result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: backupRoot,
        createdAt: new Date('2026-05-30T10:00:00.000Z'),
      });
      const strategy = await result.workspace.setStrategy('full');
      assert.strictEqual(strategy.ok, true, JSON.stringify(strategy));
      const products = requireSingleNode(
        result.workspace.payload.root,
        (node) =>
          node.kind === 'metadataObject' &&
          node.label === 'Catalog.Products' &&
          node.id.startsWith('fileObject:leftOnly:') &&
          node.status === 'leftOnly'
      );

      const preview = await result.workspace.createPreviewForNodeIds([products.id]);
      assert.strictEqual(preview.ok, true, JSON.stringify(preview));
      result.workspace.approvePreview(preview.preview.previewId);
      const execution = await result.workspace.executeApprovedPreview(preview.preview.previewId, {
        destructiveConfirmed: true,
      });

      assert.strictEqual(execution.ok, true, JSON.stringify(execution));
      await assert.rejects(fs.stat(leftCatalogPath));
      assert.strictEqual(execution.result.backupPaths.length, 1);
      assert.deepStrictEqual(
        await fs.readFile(path.join(execution.result.backupPaths[0]!, 'Ext', 'logo.bin')),
        leftBytes
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('preview new hash is based on current target when unrelated text changed after compare', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const backupRoot = path.join(tempRoot, 'backups');
    const leftModulePath = path.join(leftRoot, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');
    const rightModulePath = path.join(rightRoot, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');
    const currentLeft = `// local header after compare\n${logicalBaseRoutine()}`;

    try {
      await writeCatalog(leftRoot, 'Products', 'catalog-products');
      await writeCatalog(rightRoot, 'Products', 'catalog-products');
      await writeFile(leftModulePath, `// original header\n${logicalBaseRoutine()}`);
      await writeFile(rightModulePath, `// original header\n${logicalIncomingRoutine()}`);

      const result = await buildConfigurationCompare({
        leftRootPath: leftRoot,
        rightRootPath: rightRoot,
        backupRootPath: backupRoot,
        createdAt: new Date('2026-05-30T10:00:00.000Z'),
      });
      await writeFile(leftModulePath, currentLeft);

      const preview = await result.workspace.createPreviewForNodeIds([
        'bsl:routine:Catalog.Products.Object:run',
      ]);
      assert.strictEqual(preview.ok, true);
      result.workspace.approvePreview(preview.preview.previewId);

      const execution = await result.workspace.executeApprovedPreview(preview.preview.previewId);

      assert.strictEqual(execution.ok, true, JSON.stringify(execution));
      assert.strictEqual(await readText(leftModulePath), `// local header after compare\n${logicalIncomingRoutine()}`);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

async function writeCatalog(root: string, name: string, uuid: string): Promise<void> {
  await writeFile(
    path.join(root, 'Catalogs', `${name}.xml`),
    `<MetaDataObject><Catalog uuid="${uuid}"><Properties><Name>${name}</Name></Properties></Catalog></MetaDataObject>`
  );
}

async function writeCatalogDescriptor(
  root: string,
  name: string,
  uuid: string,
  synonym: string
): Promise<void> {
  await writeFile(
    path.join(root, 'Catalogs', name, `${name}.xml`),
    [
      '<MetaDataObject>',
      `  <Catalog uuid="${uuid}">`,
      '    <Properties>',
      `      <Name>${name}</Name>`,
      `      <Synonym>${synonym}</Synonym>`,
      '    </Properties>',
      '  </Catalog>',
      '</MetaDataObject>',
    ].join('\n')
  );
}

async function writeMetadataDescriptor(
  root: string,
  relativePath: string,
  metadataType: string,
  name: string,
  uuid: string,
  synonymSuffix: string
): Promise<void> {
  const qualifiedName = qualifiedNameForFixture(relativePath);
  await writeFile(
    path.join(root, relativePath),
    [
      '<MetaDataObject>',
      `  <${metadataType} uuid="${uuid}">`,
      '    <Properties>',
      `      <Name>${name}</Name>`,
      `      <Synonym>${qualifiedName} ${synonymSuffix}</Synonym>`,
      '    </Properties>',
      `  </${metadataType}>`,
      '</MetaDataObject>',
    ].join('\n')
  );
}

function representativeMetadataFixtures(): Array<{
  relativePath: string;
  metadataType: string;
  name: string;
  uuid: string;
}> {
  return [
    {
      relativePath: path.join('Documents', 'Order', 'Order.xml'),
      metadataType: 'Document',
      name: 'Order',
      uuid: 'document-order',
    },
    {
      relativePath: path.join('Enums', 'Status', 'Status.xml'),
      metadataType: 'Enum',
      name: 'Status',
      uuid: 'enum-status',
    },
    {
      relativePath: path.join('Roles', 'Admin', 'Admin.xml'),
      metadataType: 'Role',
      name: 'Admin',
      uuid: 'role-admin',
    },
    {
      relativePath: path.join('CommonForms', 'Chooser', 'Chooser.xml'),
      metadataType: 'CommonForm',
      name: 'Chooser',
      uuid: 'common-form-chooser',
    },
    {
      relativePath: path.join('InformationRegisters', 'Stock', 'Dimensions', 'Warehouse.xml'),
      metadataType: 'Dimension',
      name: 'Warehouse',
      uuid: 'dimension-warehouse',
    },
    {
      relativePath: path.join('Documents', 'Order', 'TabularSections', 'Goods.xml'),
      metadataType: 'TabularSection',
      name: 'Goods',
      uuid: 'tabular-section-goods',
    },
    {
      relativePath: path.join('ChartsOfCharacteristicTypes', 'Properties', 'Properties.xml'),
      metadataType: 'ChartOfCharacteristicTypes',
      name: 'Properties',
      uuid: 'cct-properties',
    },
  ];
}

function qualifiedNameForFixture(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/');
  if (normalized === 'Documents/Order/Order.xml') {
    return 'Document.Order';
  }
  if (normalized === 'Enums/Status/Status.xml') {
    return 'Enum.Status';
  }
  if (normalized === 'Roles/Admin/Admin.xml') {
    return 'Role.Admin';
  }
  if (normalized === 'CommonForms/Chooser/Chooser.xml') {
    return 'CommonForm.Chooser';
  }
  if (normalized === 'InformationRegisters/Stock/Dimensions/Warehouse.xml') {
    return 'InformationRegister.Stock.Dimension.Warehouse';
  }
  if (normalized === 'Documents/Order/TabularSections/Goods.xml') {
    return 'Document.Order.TabularSection.Goods';
  }
  if (normalized === 'ChartsOfCharacteristicTypes/Properties/Properties.xml') {
    return 'ChartOfCharacteristicTypes.Properties';
  }
  throw new Error(`Unknown fixture path ${relativePath}`);
}

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

async function writeFileBytes(filePath: string, content: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf8');
}

function requireNode(root: CompareTreeNode, id: string): CompareTreeNode {
  const found = findNode(root, id);
  assert.ok(found, `Expected node ${id} to exist.`);
  return found;
}

function findNode(node: CompareTreeNode, id: string): CompareTreeNode | undefined {
  if (node.id === id) {
    return node;
  }
  for (const child of node.children) {
    const found = findNode(child, id);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function collectNodes(
  root: CompareTreeNode,
  predicate: (node: CompareTreeNode) => boolean
): CompareTreeNode[] {
  const found: CompareTreeNode[] = [];
  visit(root, (node) => {
    if (predicate(node)) {
      found.push(node);
    }
  });
  return found;
}

function requireNodeByLabel(
  root: CompareTreeNode,
  label: string,
  leftValue: string,
  rightValue: string
): CompareTreeNode {
  const matches = collectNodes(
    root,
    (node) => node.label === label && node.leftValue === leftValue && node.rightValue === rightValue
  );
  assert.strictEqual(
    matches.length,
    1,
    `Expected exactly one node ${label} with ${leftValue} -> ${rightValue}.`
  );
  return matches[0]!;
}

function requireSingleNode(
  root: CompareTreeNode,
  predicate: (node: CompareTreeNode) => boolean
): CompareTreeNode {
  const matches = collectNodes(root, predicate);
  assert.strictEqual(matches.length, 1, 'Expected exactly one matching compare node.');
  return matches[0]!;
}

function visit(node: CompareTreeNode, callback: (node: CompareTreeNode) => void): void {
  callback(node);
  for (const child of node.children) {
    visit(child, callback);
  }
}

function duplicateRoutineSource(): string {
  return [
    'Procedure Save()',
    'EndProcedure',
    '',
    'Procedure Save()',
    'EndProcedure',
  ].join('\n');
}

function logicalBaseRoutine(): string {
  return [
    'Procedure Run()',
    '  If A Then',
    '    A = 1;',
    '  EndIf;',
    '  If B Then',
    '    B = 1;',
    '  EndIf;',
    'EndProcedure',
  ].join('\n');
}

function logicalIncomingRoutine(): string {
  return [
    'Procedure Run()',
    '  If A Then',
    '    A = 1;',
    '  EndIf;',
    '  Try',
    '    C = 1;',
    '  Except',
    '    C = 0;',
    '  EndTry;',
    '  If B Then',
    '    B = 1;',
    '  EndIf;',
    'EndProcedure',
  ].join('\n');
}

function logicalManualRoutine(): string {
  return [
    'Procedure Run()',
    '  If A Then',
    '    A = 2;',
    '  EndIf;',
    '  If B Then',
    '    B = 1;',
    '  EndIf;',
    'EndProcedure',
  ].join('\n');
}

function secondBaseRoutine(): string {
  return [
    'Procedure Other()',
    '  If X Then',
    '    X = 1;',
    '  EndIf;',
    '  If Y Then',
    '    Y = 1;',
    '  EndIf;',
    'EndProcedure',
  ].join('\n');
}

function secondIncomingRoutine(): string {
  return [
    'Procedure Other()',
    '  If X Then',
    '    X = 1;',
    '  EndIf;',
    '  Try',
    '    Z = 1;',
    '  Except',
    '    Z = 0;',
    '  EndTry;',
    '  If Y Then',
    '    Y = 1;',
    '  EndIf;',
    'EndProcedure',
  ].join('\n');
}

function formXml(title: string): string {
  return [
    '<Form>',
    '  <ChildItems>',
    '    <Item>',
    '      <Name>ItemsTable</Name>',
    `      <Title>${title}</Title>`,
    '    </Item>',
    '  </ChildItems>',
    '</Form>',
  ].join('\n');
}

function predefinedXml(presentation: string): string {
  return [
    '<PredefinedData>',
    '  <Item id="main">',
    '    <Name>Main</Name>',
    `    <Presentation>${presentation}</Presentation>`,
    '  </Item>',
    '</PredefinedData>',
  ].join('\n');
}
