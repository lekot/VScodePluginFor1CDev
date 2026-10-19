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

  test('Root instances without generic Attribute support (Subsystem, Enum, Sequence, HTTPService, IntegrationService, SettingsStorage, DocumentJournal) are false for isMatrixTarget', () => {
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

    const nonAttributeRootCases: Array<{ folderId: string; type: MetadataType; underCommon?: boolean }> = [
      { folderId: 'Subsystems', type: MetadataType.Subsystem, underCommon: true },
      { folderId: 'Enums', type: MetadataType.Enum },
      { folderId: 'Sequences', type: MetadataType.Sequence },
      { folderId: 'HTTPServices', type: MetadataType.HTTPService, underCommon: true },
      { folderId: 'IntegrationServices', type: MetadataType.IntegrationService, underCommon: true },
      { folderId: 'SettingsStorages', type: MetadataType.SettingsStorage, underCommon: true },
      { folderId: 'DocumentJournals', type: MetadataType.DocumentJournal },
      { folderId: 'WebServices', type: MetadataType.WebService, underCommon: true },
      { folderId: 'FilterCriteria', type: MetadataType.FilterCriterion, underCommon: true },
      { folderId: 'ExternalDataSources', type: MetadataType.ExternalDataSource },
    ];

    for (const c of nonAttributeRootCases) {
      const folderParent = c.underCommon ? common : configuration;
      const typeFolder: TreeNode = {
        id: c.folderId,
        name: c.folderId,
        type: c.type,
        properties: {},
        parent: folderParent,
        children: [],
      };
      const instanceNode: TreeNode = {
        id: `${c.folderId}.TestObj1`,
        name: 'TestObj1',
        type: c.type,
        properties: {},
        parent: typeFolder,
        children: [],
      };
      assert.strictEqual(
        isMatrixTarget(instanceNode),
        false,
        `${c.folderId}.TestObj1 (${c.type}) must not be a direct Attribute create target`
      );
    }

    const catalogsFolder: TreeNode = {
      id: 'Catalogs',
      name: 'Справочники',
      type: MetadataType.Catalog,
      properties: {},
      parent: configuration,
      children: [],
    };
    const catalogInstance: TreeNode = {
      id: 'Catalogs.TestCatalog1',
      name: 'TestCatalog1',
      type: MetadataType.Catalog,
      properties: {},
      parent: catalogsFolder,
      children: [],
    };
    assert.strictEqual(isMatrixTarget(catalogInstance), true, 'Catalog instance supports direct Attribute creation');
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

  test('isNestedMatrixTargetUnderMatrixObject: Dimensions/Resources under AccountingRegister and CalculationRegister false', () => {
    const accFolder: TreeNode = {
      id: 'AccountingRegisters',
      name: 'Регистры бухгалтерии',
      type: MetadataType.AccountingRegister,
      properties: {},
    };
    const matrixAcc: TreeNode = {
      id: 'AccountingRegisters.Matrix_acc',
      name: 'Matrix_acc',
      type: MetadataType.AccountingRegister,
      properties: {},
      parent: accFolder,
    };
    const accDims: TreeNode = {
      id: 'Dimensions',
      name: 'Субконто',
      type: MetadataType.Dimension,
      properties: {},
      parent: matrixAcc,
    };
    const accRes: TreeNode = {
      id: 'Resources',
      name: 'Ресурсы',
      type: MetadataType.Resource,
      properties: {},
      parent: matrixAcc,
    };
    assert.strictEqual(isNestedMatrixTargetUnderMatrixObject(accDims), false);
    assert.strictEqual(isNestedMatrixTargetUnderMatrixObject(accRes), false);

    const calcFolder: TreeNode = {
      id: 'CalculationRegisters',
      name: 'Регистры расчета',
      type: MetadataType.CalculationRegister,
      properties: {},
    };
    const matrixCalc: TreeNode = {
      id: 'CalculationRegisters.Matrix_calc',
      name: 'Matrix_calc',
      type: MetadataType.CalculationRegister,
      properties: {},
      parent: calcFolder,
    };
    const calcDims: TreeNode = {
      id: 'Dimensions',
      name: 'Измерения',
      type: MetadataType.Dimension,
      properties: {},
      parent: matrixCalc,
    };
    const calcRes: TreeNode = {
      id: 'Resources',
      name: 'Ресурсы',
      type: MetadataType.Resource,
      properties: {},
      parent: matrixCalc,
    };
    assert.strictEqual(isNestedMatrixTargetUnderMatrixObject(calcDims), false);
    assert.strictEqual(isNestedMatrixTargetUnderMatrixObject(calcRes), false);
  });
});

suite('matrixTargetPredicate (isIbcmdFragileTypeFolder rules)', () => {
  const originalRecorderDoc = process.env.IBCMD_RECORDER_DOCUMENT;

  teardown(() => {
    if (originalRecorderDoc === undefined) {
      delete process.env.IBCMD_RECORDER_DOCUMENT;
    } else {
      process.env.IBCMD_RECORDER_DOCUMENT = originalRecorderDoc;
    }
  });

  test('DocumentJournals and AccumulationRegisters depend on IBCMD_RECORDER_DOCUMENT', () => {
    const configuration: TreeNode = {
      id: 'cfg',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      children: [],
    };
    const djFolder: TreeNode = {
      id: 'DocumentJournals',
      name: 'Журналы документов',
      type: MetadataType.DocumentJournal,
      properties: {},
      parent: configuration,
    };
    const arFolder: TreeNode = {
      id: 'AccumulationRegisters',
      name: 'Регистры накопления',
      type: MetadataType.AccumulationRegister,
      properties: {},
      parent: configuration,
    };

    delete process.env.IBCMD_RECORDER_DOCUMENT;
    assert.strictEqual(isMatrixTarget(djFolder), false, 'DocumentJournals must be skipped when IBCMD_RECORDER_DOCUMENT unset');
    assert.strictEqual(isMatrixTarget(arFolder), false, 'AccumulationRegisters must be skipped when IBCMD_RECORDER_DOCUMENT unset');

    process.env.IBCMD_RECORDER_DOCUMENT = 'ДокументТестРаботает';
    assert.strictEqual(isMatrixTarget(djFolder), true, 'DocumentJournals allowed when IBCMD_RECORDER_DOCUMENT set');
    assert.strictEqual(isMatrixTarget(arFolder), true, 'AccumulationRegisters allowed when IBCMD_RECORDER_DOCUMENT set');
  });

  test('Fragile folders without minimal Designer template (ChartsOfAccounts, AccountingRegisters, CalculationRegisters, CommonCommands) are always skipped', () => {
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
    const folders: Array<{ id: string; type: MetadataType; underCommon?: boolean }> = [
      { id: 'ChartsOfAccounts', type: MetadataType.ChartOfAccounts },
      { id: 'AccountingRegisters', type: MetadataType.AccountingRegister },
      { id: 'CalculationRegisters', type: MetadataType.CalculationRegister },
      { id: 'CommonCommands', type: MetadataType.CommonCommand, underCommon: true },
      { id: 'WebServices', type: MetadataType.WebService, underCommon: true },
      { id: 'EventSubscriptions', type: MetadataType.EventSubscription, underCommon: true },
      { id: 'ScheduledJobs', type: MetadataType.ScheduledJob, underCommon: true },
      { id: 'FunctionalOptions', type: MetadataType.FunctionalOption, underCommon: true },
      { id: 'FunctionalOptionsParameters', type: MetadataType.FunctionalOptionsParameter, underCommon: true },
      { id: 'FilterCriteria', type: MetadataType.FilterCriterion, underCommon: true },
      { id: 'ExternalDataSources', type: MetadataType.ExternalDataSource },
    ];

    process.env.IBCMD_RECORDER_DOCUMENT = 'ДокументТестРаботает';
    for (const f of folders) {
      const node: TreeNode = {
        id: f.id,
        name: f.id,
        type: f.type,
        properties: {},
        parent: f.underCommon ? common : configuration,
      };
      assert.strictEqual(
        isMatrixTarget(node),
        false,
        `${f.id} must be skipped in ibcmd fragile type folder checks`
      );
    }
  });
});

