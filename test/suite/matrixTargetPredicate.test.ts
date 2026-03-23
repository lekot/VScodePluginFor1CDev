import * as assert from 'assert';
import { MetadataType, TreeNode } from '../../src/models/treeNode';
import { isMatrixTarget, isNestedMatrixTargetUnderMatrixObject } from '../matrix/matrixTargetPredicate';

suite('matrixTargetPredicate (isMatrixTarget)', () => {
  test('CommonModules type folder true, CommonModule instance false', () => {
    const configuration: TreeNode = {
      id: 'cfg',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      children: [],
    };
    const common: TreeNode = {
      id: 'Common',
      name: 'Общие',
      type: MetadataType.Unknown,
      properties: {},
      parent: configuration,
      children: [],
    };
    configuration.children = [common];
    const commonModulesFolder: TreeNode = {
      id: 'CommonModules',
      name: 'Общие модули',
      type: MetadataType.CommonModule,
      properties: {},
      parent: common,
      children: [],
    };
    common.children = [commonModulesFolder];
    assert.strictEqual(isMatrixTarget(commonModulesFolder), true);

    const moduleInstance: TreeNode = {
      id: 'CommonModules.M1',
      name: 'M1',
      type: MetadataType.CommonModule,
      properties: {},
      parent: commonModulesFolder,
    };
    assert.strictEqual(isMatrixTarget(moduleInstance), false);
  });

  test('Languages type folder true, Language instance false', () => {
    const configuration: TreeNode = {
      id: 'cfg',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      children: [],
    };
    const common: TreeNode = {
      id: 'Common',
      name: 'Общие',
      type: MetadataType.Unknown,
      properties: {},
      parent: configuration,
      children: [],
    };
    configuration.children = [common];
    const languagesFolder: TreeNode = {
      id: 'Languages',
      name: 'Языки',
      type: MetadataType.Language,
      properties: {},
      parent: common,
      children: [],
    };
    common.children = [languagesFolder];
    assert.strictEqual(isMatrixTarget(languagesFolder), true);

    const languageInstance: TreeNode = {
      id: 'Languages.Русский',
      name: 'Русский',
      type: MetadataType.Language,
      properties: {},
      parent: languagesFolder,
    };
    assert.strictEqual(isMatrixTarget(languageInstance), false);
  });

  test('Constants type folder true, Constant instance false', () => {
    const configuration: TreeNode = {
      id: 'cfg',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      children: [],
    };
    const constantsFolder: TreeNode = {
      id: 'Constants',
      name: 'Константы',
      type: MetadataType.Constant,
      properties: {},
      parent: configuration,
      children: [],
    };
    configuration.children = [constantsFolder];
    assert.strictEqual(isMatrixTarget(constantsFolder), true);

    const constantInstance: TreeNode = {
      id: 'Constants.МояКонстанта',
      name: 'МояКонстанта',
      type: MetadataType.Constant,
      properties: {},
      parent: constantsFolder,
    };
    assert.strictEqual(isMatrixTarget(constantInstance), false);
  });
});

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
