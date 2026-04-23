import * as assert from 'assert';
import * as path from 'path';
import { TreeNode, MetadataType } from '../../src/models/treeNode';
import { normalizePathForMatch, scoreNodeAgainstTarget } from '../../src/extensionSupport/revealPathUtils';

suite('revealPathUtils', () => {
  const getCfg = (_n: TreeNode): string | null => null;

  test('score: exact file path (module) vs directory prefix on same node', () => {
    const base = process.cwd();
    const bsl = path.join(base, 'src', 'Catalogs', 'Foo', 'Ext', 'ObjectModule.bsl');
    const node: TreeNode = {
      id: 'X',
      name: 'X',
      type: MetadataType.Catalog,
      properties: {},
      filePath: path.join(base, 'src', 'Catalogs', 'Foo'),
    };
    const t = normalizePathForMatch(bsl);
    const sBsl = scoreNodeAgainstTarget(t, node, getCfg);
    const sParent = path.join(base, 'src', 'Catalogs', 'NotFoo', 'x.xml');
    const sNo = scoreNodeAgainstTarget(normalizePathForMatch(sParent), node, getCfg);
    assert.ok(sBsl > 0, 'BSL under object dir should match');
    assert.strictEqual(sNo, 0, 'unrelated path should not match object dir');
  });

  test('score: exact on node.filePath beats short prefix on parent', () => {
    const base = process.cwd();
    const mdo = path.join(base, 'a', 'Catalogs', 'Items', 'Items.mdo');
    const catalogDir = path.join(base, 'a', 'Catalogs', 'Items');
    const typeFolder: TreeNode = {
      id: 'Catalogs',
      name: 'Catalogs',
      type: MetadataType.Catalog,
      properties: { type: 'Catalogs' },
      filePath: path.join(base, 'a', 'Catalogs'),
    };
    const objectNode: TreeNode = {
      id: 'Catalogs.Items',
      name: 'Items',
      type: MetadataType.Catalog,
      properties: { type: 'Catalogs' },
      filePath: catalogDir,
    };
    const target = normalizePathForMatch(mdo);
    const st = scoreNodeAgainstTarget(target, typeFolder, getCfg);
    const so = scoreNodeAgainstTarget(target, objectNode, getCfg);
    assert.ok(st > 0, 'type folder prefix matches file under Catalogs/*');
    assert.ok(so > st, 'object node (longer path) should score higher');
  });

  test('normalizePathForMatch is case-insensitive on same path', () => {
    if (path.sep === '\\') {
      const a = 'C:\\Proj\\A\\B.xml';
      const b = normalizePathForMatch(a);
      const c = normalizePathForMatch('c:/PROJ\\a/b.XML');
      assert.strictEqual(b, c);
    }
  });
});
