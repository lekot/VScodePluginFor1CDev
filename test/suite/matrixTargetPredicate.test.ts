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

  test('isNestedMatrixTargetUnderMatrixObject: EnumValues under Matrix_* enum true', () => {
    const enumsFolder: TreeNode = { id: 'Enums', name: 'Перечисления', type: MetadataType.Enum, properties: {} };
    const matrixEnum: TreeNode = {
      id: 'Enums.Matrix_e',
      name: 'Matrix_e',
      type: MetadataType.Enum,
      properties: {},
      parent: enumsFolder,
    };
    const enumValues: TreeNode = {
      id: 'EnumValues',
      name: 'Значения',
      type: MetadataType.EnumValue,
      properties: {},
      parent: matrixEnum,
    };
    assert.strictEqual(isNestedMatrixTargetUnderMatrixObject(enumValues), true);
  });

  test('isNestedMatrixTargetUnderMatrixObject: Dimensions under Matrix_* IR true', () => {
    const irFolder: TreeNode = {
      id: 'InformationRegisters',
      name: 'Регистры сведений',
      type: MetadataType.InformationRegister,
      properties: {},
    };
    const matrixIr: TreeNode = {
      id: 'InformationRegisters.Matrix_ir',
      name: 'Matrix_ir',
      type: MetadataType.InformationRegister,
      properties: {},
      parent: irFolder,
    };
    const dims: TreeNode = {
      id: 'Dimensions',
      name: 'Измерения',
      type: MetadataType.Dimension,
      properties: {},
      parent: matrixIr,
    };
    assert.strictEqual(isNestedMatrixTargetUnderMatrixObject(dims), true);
  });

  test('isNestedMatrixTargetUnderMatrixObject: PredefinedData under Matrix_* catalog true', () => {
    const catalogsFolder: TreeNode = {
      id: 'Catalogs',
      name: 'Справочники',
      type: MetadataType.Catalog,
      properties: {},
    };
    const matrixCatalog: TreeNode = {
      id: 'Catalogs.Matrix_c',
      name: 'Matrix_c',
      type: MetadataType.Catalog,
      properties: {},
      parent: catalogsFolder,
    };
    const predef: TreeNode = {
      id: 'PredefinedData',
      name: 'Предопределённые',
      type: MetadataType.PredefinedItem,
      properties: {},
      parent: matrixCatalog,
    };
    assert.strictEqual(isNestedMatrixTargetUnderMatrixObject(predef), true);
  });

  test('isNestedMatrixTargetUnderMatrixObject: PredefinedData under Matrix_* ChartOfAccounts false (ibcmd matrix scope)', () => {
    const coaFolder: TreeNode = {
      id: 'ChartsOfAccounts',
      name: 'Планы счетов',
      type: MetadataType.ChartOfAccounts,
      properties: {},
    };
    const matrixCoa: TreeNode = {
      id: 'ChartsOfAccounts.Matrix_coa',
      name: 'Matrix_coa',
      type: MetadataType.ChartOfAccounts,
      properties: {},
      parent: coaFolder,
    };
    const predef: TreeNode = {
      id: 'PredefinedData',
      name: 'Предопределённые',
      type: MetadataType.PredefinedItem,
      properties: {},
      parent: matrixCoa,
    };
    assert.strictEqual(isNestedMatrixTargetUnderMatrixObject(predef), false);
  });
});
