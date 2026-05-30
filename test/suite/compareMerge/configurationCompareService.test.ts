import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { buildConfigurationCompare } from '../../../src/compareMerge/configurationCompareService';
import type { CompareTreeNode } from '../../../src/compareMerge/compareTreeTypes';

suite('ConfigurationCompareService', () => {
  test('builds session and projection with mergeable right-only BSL routine', async () => {
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
      });

      assert.strictEqual(result.session.state.sources[0]?.rootUri, leftRoot);
      assert.strictEqual(result.session.state.sources[1]?.rootUri, rightRoot);

      const addedRoutine = requireNode(
        result.projection.root,
        'bsl:routine:Catalog.Products.Object:addedonright'
      );
      assert.strictEqual(addedRoutine.kind, 'bslRoutine');
      assert.strictEqual(addedRoutine.status, 'rightOnly');
      assert.strictEqual(addedRoutine.mergeable, true);
      assert.deepStrictEqual(addedRoutine.mergeState, {
        state: 'ready',
        targetFilePath: leftModulePath,
      });
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
