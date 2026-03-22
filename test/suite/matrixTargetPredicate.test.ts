import * as assert from 'assert';
import { MetadataType, TreeNode } from '../../src/models/treeNode';
import { isNestedMatrixTargetUnderMatrixObject } from '../matrix/matrixTargetPredicate';

suite('matrixTargetPredicate (nested matrix pass)', () => {
  test('isNestedMatrixTargetUnderMatrixObject: Attributes under Matrix_* catalog true, plain catalog false', () => {
    const catalogsFolder: TreeNode = {
      id: 'Catalogs',
      name: 'Справочники',
      type: MetadataType.Catalog,
      properties: {},
    };
    const matrixCatalog: TreeNode = {
      id: 'Catalogs.Matrix_x',
      name: 'Matrix_x',
      type: MetadataType.Catalog,
      properties: {},
      parent: catalogsFolder,
    };
    const attrsUnderMatrix: TreeNode = {
      id: 'Attributes',
      name: 'Реквизиты',
      type: MetadataType.Attribute,
      properties: {},
      parent: matrixCatalog,
    };
    assert.strictEqual(isNestedMatrixTargetUnderMatrixObject(attrsUnderMatrix), true);

    const plainCatalog: TreeNode = {
      id: 'Catalogs.Plain',
      name: 'Plain',
      type: MetadataType.Catalog,
      properties: {},
      parent: catalogsFolder,
    };
    const attrsUnderPlain: TreeNode = {
      id: 'Attributes',
      name: 'Реквизиты',
      type: MetadataType.Attribute,
      properties: {},
      parent: plainCatalog,
    };
    assert.strictEqual(isNestedMatrixTargetUnderMatrixObject(attrsUnderPlain), false);
  });
});
