import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { buildConfigurationCompare } from '../../../src/compareMerge/configurationCompareService';
import type { CompareTreeNode } from '../../../src/compareMerge/compareTreeTypes';

suite('ConfigurationCompareService', () => {
  test('builds session projection and workspace with non-executable right-only BSL routine', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-compare-'));
    const leftRoot = path.join(tempRoot, 'left');
    const rightRoot = path.join(tempRoot, 'right');
    const leftModulePath = path.join(leftRoot, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');
    const rightModulePath = path.join(rightRoot, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');

    try {
      await writeCatalog(leftRoot, 'Products', 'catalog-products');
      await writeCatalog(rightRoot, 'Products', 'catalog-products');
      await writeFile(
        leftModulePath,
        [
          'Procedure Shared()',
          '  Value = 1;',
          'EndProcedure',
        ].join('\n')
      );
      await writeFile(
        rightModulePath,
        [
          'Procedure Shared()',
          '  Value = 1;',
          'EndProcedure',
          '',
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

      assert.strictEqual(result.session.state.sources[0]?.rootUri, pathToFileURL(leftRoot).toString());
      assert.strictEqual(result.session.state.sources[1]?.rootUri, pathToFileURL(rightRoot).toString());

      const addedRoutine = requireNode(
        result.projection.root,
        'bsl:routine:Catalog.Products.Object:addedonright'
      );
      assert.strictEqual(addedRoutine.kind, 'bslRoutine');
      assert.strictEqual(addedRoutine.status, 'rightOnly');
      assert.strictEqual(addedRoutine.mergeable, false);
      assert.strictEqual(addedRoutine.mergeState?.state, 'readOnly');
      assert.ok(result.workspace, 'Expected build result to expose workspace for provider.');
      assert.deepStrictEqual(result.workspace.listMergeableNodeIds(), []);
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

      const execution = await result.workspace.executeApprovedPreview(preview.preview.previewId);

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

      const execution = await result.workspace.executeApprovedPreview(preview.preview.previewId);

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

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
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
