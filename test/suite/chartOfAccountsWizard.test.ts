import * as assert from 'assert';
import * as vscode from 'vscode';
import { runChartOfAccountsWizard } from '../../src/wizards/chartOfAccountsWizard';
import { ExtensionState } from '../../src/state/extensionState';
import { TreeNode, MetadataType } from '../../src/models/treeNode';
import { createTempDir, cleanupTempDir } from '../helpers/testHelpers';
import * as path from 'path';
import * as fs from 'fs';

suite('ChartOfAccountsWizard UI Flow', () => {
  let tmpDir: string;
  let state: ExtensionState;
  let origShowInputBox: typeof vscode.window.showInputBox;
  let origShowQuickPick: typeof vscode.window.showQuickPick;
  let origShowInformationMessage: typeof vscode.window.showInformationMessage;
  let origShowWarningMessage: typeof vscode.window.showWarningMessage;
  let origShowErrorMessage: typeof vscode.window.showErrorMessage;

  setup(async () => {
    tmpDir = await createTempDir('1cviewer-coa-wizard-');
    state = new ExtensionState();
    state.treeDataProvider = {
      getConfigPathForNode: () => tmpDir,
      getConfigPath: () => tmpDir,
    } as any;

    // Create minimal Configuration.xml
    await fs.promises.writeFile(
      path.join(tmpDir, 'Configuration.xml'),
      `<?xml version="1.0" encoding="UTF-8"?><MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Configuration uuid="1"><Properties><Name>TestConf</Name></Properties><ChildObjects/></Configuration></MetaDataObject>`,
      'utf-8'
    );

    origShowInputBox = vscode.window.showInputBox;
    origShowQuickPick = vscode.window.showQuickPick;
    origShowInformationMessage = vscode.window.showInformationMessage;
    origShowWarningMessage = vscode.window.showWarningMessage;
    origShowErrorMessage = vscode.window.showErrorMessage;
  });

  teardown(async () => {
    vscode.window.showInputBox = origShowInputBox;
    vscode.window.showQuickPick = origShowQuickPick;
    vscode.window.showInformationMessage = origShowInformationMessage;
    vscode.window.showWarningMessage = origShowWarningMessage;
    vscode.window.showErrorMessage = origShowErrorMessage;
    await cleanupTempDir(tmpDir);
  });

  test('cancels wizard when user cancels name input', async () => {
    vscode.window.showInputBox = async () => undefined;

    const target: TreeNode = {
      id: 'ChartsOfAccounts',
      name: 'Планы счетов',
      type: MetadataType.ChartOfAccounts,
      filePath: path.join(tmpDir, 'ChartsOfAccounts'),
      properties: {},
    };

    const executed = await runChartOfAccountsWizard({ state, target });
    assert.strictEqual(executed, false, 'wizard must return false when cancelled');
  });

  test('cancels wizard when user cancels synonym input', async () => {
    let callCount = 0;
    vscode.window.showInputBox = async () => {
      callCount++;
      return callCount === 1 ? 'Хозрасчетный' : undefined;
    };

    const target: TreeNode = {
      id: 'ChartsOfAccounts',
      name: 'Планы счетов',
      type: MetadataType.ChartOfAccounts,
      filePath: path.join(tmpDir, 'ChartsOfAccounts'),
      properties: {},
    };

    const executed = await runChartOfAccountsWizard({ state, target });
    assert.strictEqual(executed, false);
  });

  test('cancels wizard when user cancels subconto pick', async () => {
    vscode.window.showInputBox = async () => 'Хозрасчетный';
    vscode.window.showQuickPick = (async () => undefined) as any;

    const target: TreeNode = {
      id: 'ChartsOfAccounts',
      name: 'Планы счетов',
      type: MetadataType.ChartOfAccounts,
      filePath: path.join(tmpDir, 'ChartsOfAccounts'),
      properties: {},
    };

    const executed = await runChartOfAccountsWizard({ state, target });
    assert.strictEqual(executed, false);
  });

  test('completes successfully on valid user inputs and runs configuration plan', async () => {
    let inputStep = 0;
    vscode.window.showInputBox = async () => {
      inputStep++;
      if (inputStep === 1) {
        return 'Хозрасчетный';
      }
      if (inputStep === 2) {
        return 'План счетов бухучета';
      }
      return '3'; // max subconto count if prompted
    };

    let quickPickStep = 0;
    vscode.window.showQuickPick = (async () => {
      quickPickStep++;
      if (quickPickStep === 1) {
        // Subconto step: choose None
        return { label: '(Без субконто)', description: 'План счетов не использует виды субконто', value: '' };
      }
      if (quickPickStep === 2) {
        // Code mask step: standard preset
        return { label: '@@@.@@.@ (маска, длина 8)', value: '@@@.@@.@' };
      }
      // Step 3: flags and predefined account
      return [
        { label: 'Создать начальный предопределенный счет 000 (Вспомогательный)', picked: true, value: 'account_000' },
        { label: 'Признак учета: Валютный', picked: true, value: 'flag_Валютный' },
      ];
    }) as any;

    let planExecuted = false;
    let cacheReloaded = false;

    const target: TreeNode = {
      id: 'ChartsOfAccounts',
      name: 'Планы счетов',
      type: MetadataType.ChartOfAccounts,
      filePath: path.join(tmpDir, 'ChartsOfAccounts'),
      properties: {},
    };

    const executed = await runChartOfAccountsWizard({
      state,
      target,
      runConfigurationPlan: async (_configPath: string, plan: any) => {
        planExecuted = true;
        for (const step of plan.steps) {
          if (step.type === 'ensureDirectory') {
            await fs.promises.mkdir(step.targetPath, { recursive: true });
          } else if (step.type === 'writeFile') {
            await fs.promises.mkdir(path.dirname(step.targetPath), { recursive: true });
            await fs.promises.writeFile(step.targetPath, step.content, 'utf-8');
          }
        }
        return plan.result;
      },
      invalidateCacheAndReload: async () => {
        cacheReloaded = true;
      },
    });

    assert.strictEqual(executed, true, 'wizard must return true upon successful creation');
    assert.strictEqual(planExecuted, true, 'configuration plan must be executed');
    assert.strictEqual(cacheReloaded, true, 'cache must be reloaded');
    assert.ok(fs.existsSync(path.join(tmpDir, 'ChartsOfAccounts', 'Хозрасчетный.xml')), 'xml file must exist');
    assert.ok(fs.existsSync(path.join(tmpDir, 'ChartsOfAccounts', 'Хозрасчетный', 'Ext', 'Predefined.xml')), 'predefined.xml must exist');
  });

  test('completes wizard with subconto selection and validates max subconto input', async () => {
    let inputStep = 0;
    vscode.window.showInputBox = async (options) => {
      inputStep++;
      if (inputStep === 1) {
        return 'Управленческий';
      }
      if (inputStep === 2) {
        return 'План счетов упр';
      }
      if (inputStep === 3) {
        const validateInput = options?.validateInput;
        assert.strictEqual(typeof validateInput, 'function', 'max subconto input must provide validation');
        assert.strictEqual(validateInput!('99'), 'Введите число от 1 до 50');
        assert.strictEqual(validateInput!('5'), undefined);
        return '5';
      }
      return undefined;
    };

    let quickPickStep = 0;
    vscode.window.showQuickPick = (async () => {
      quickPickStep++;
      if (quickPickStep === 1) {
        return { label: 'ВидыСубконто', ref: 'ChartOfCharacteristicTypes.ВидыСубконто' };
      }
      if (quickPickStep === 2) {
        return { label: '@@@.@@.@ (маска, длина 8)', mask: '@@@.@@.@', length: 8 };
      }
      return [];
    }) as any;

    const target: TreeNode = {
      id: 'ChartsOfAccounts',
      name: 'Планы счетов',
      type: MetadataType.ChartOfAccounts,
      filePath: path.join(tmpDir, 'ChartsOfAccounts'),
      properties: {},
    };

    const executed = await runChartOfAccountsWizard({
      state,
      target,
      runConfigurationPlan: async (_configPath: string, plan: any) => {
        for (const step of plan.steps) {
          if (step.type === 'ensureDirectory') {
            await fs.promises.mkdir(step.targetPath, { recursive: true });
          } else if (step.type === 'writeFile') {
            await fs.promises.mkdir(path.dirname(step.targetPath), { recursive: true });
            await fs.promises.writeFile(step.targetPath, step.content, 'utf-8');
          }
        }
        return plan.result;
      },
    });

    assert.strictEqual(executed, true);
    const chartPath = path.join(tmpDir, 'ChartsOfAccounts', 'Управленческий.xml');
    assert.ok(fs.existsSync(chartPath), 'wizard must create the selected chart of accounts');
    const chartXml = await fs.promises.readFile(chartPath, 'utf-8');
    assert.match(chartXml, /<ExtDimensionTypes>ChartOfCharacteristicTypes\.ВидыСубконто<\/ExtDimensionTypes>/);
    assert.match(chartXml, /<MaxExtDimensionCount>5<\/MaxExtDimensionCount>/);
  });
});
