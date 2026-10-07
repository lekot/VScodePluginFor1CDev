import * as assert from 'assert';
import * as vscode from 'vscode';
import { runFilterCriterionWizard } from '../../src/wizards/filterCriterionWizard';
import { ExtensionState } from '../../src/state/extensionState';
import { TreeNode, MetadataType } from '../../src/models/treeNode';
import { createTempDir, cleanupTempDir } from '../helpers/testHelpers';
import * as path from 'path';
import * as fs from 'fs';

suite('FilterCriterionWizard UI Flow', () => {
  let tmpDir: string;
  let state: ExtensionState;
  let origShowInputBox: typeof vscode.window.showInputBox;
  let origShowQuickPick: typeof vscode.window.showQuickPick;
  let origShowInformationMessage: typeof vscode.window.showInformationMessage;
  let origShowWarningMessage: typeof vscode.window.showWarningMessage;
  let origShowErrorMessage: typeof vscode.window.showErrorMessage;

  setup(async () => {
    tmpDir = await createTempDir('1cviewer-fc-wizard-');
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
      id: 'FilterCriteria',
      name: 'Критерии отбора',
      type: MetadataType.FilterCriterion,
      filePath: path.join(tmpDir, 'FilterCriteria'),
      properties: {},
    };

    const executed = await runFilterCriterionWizard({ state, target });
    assert.strictEqual(executed, false, 'wizard must return false when cancelled');
  });

  test('cancels wizard when user cancels synonym input', async () => {
    let callCount = 0;
    vscode.window.showInputBox = async () => {
      callCount++;
      return callCount === 1 ? 'ПоДоговору' : undefined;
    };

    const target: TreeNode = {
      id: 'FilterCriteria',
      name: 'Критерии отбора',
      type: MetadataType.FilterCriterion,
      filePath: path.join(tmpDir, 'FilterCriteria'),
      properties: {},
    };

    const executed = await runFilterCriterionWizard({ state, target });
    assert.strictEqual(executed, false);
  });

  test('cancels wizard when user selects no types', async () => {
    let warningShown = false;
    vscode.window.showInputBox = async () => 'ПоДоговору';
    vscode.window.showQuickPick = (async () => []) as any;
    vscode.window.showWarningMessage = (async () => {
      warningShown = true;
      return undefined;
    }) as any;

    const target: TreeNode = {
      id: 'FilterCriteria',
      name: 'Критерии отбора',
      type: MetadataType.FilterCriterion,
      filePath: path.join(tmpDir, 'FilterCriteria'),
      properties: {},
    };

    const executed = await runFilterCriterionWizard({ state, target });
    assert.strictEqual(executed, false);
    assert.strictEqual(warningShown, true, 'warning message must be shown when no types chosen');
  });

  test('cancels wizard when no candidate attributes exist in configuration for chosen types', async () => {
    let warningMessage = '';
    vscode.window.showInputBox = async () => 'ПоДоговору';
    vscode.window.showQuickPick = (async () => [{ label: 'Строка (xs:string)', description: 'xs:string' }]) as any;
    vscode.window.showWarningMessage = (async (msg: string) => {
      warningMessage = msg;
      return undefined;
    }) as any;

    const target: TreeNode = {
      id: 'FilterCriteria',
      name: 'Критерии отбора',
      type: MetadataType.FilterCriterion,
      filePath: path.join(tmpDir, 'FilterCriteria'),
      properties: {},
    };

    const executed = await runFilterCriterionWizard({ state, target });
    assert.strictEqual(executed, false);
    assert.ok(warningMessage.includes('не найдено подходящих'), `expected candidates warning, got: "${warningMessage}"`);
  });

  test('cancels wizard when user picks empty content list from quickpick', async () => {
    // Create a catalog with attribute so candidates exist
    const catDir = path.join(tmpDir, 'Catalogs');
    await fs.promises.mkdir(catDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(catDir, 'Товары.xml'),
      `<?xml version="1.0" encoding="UTF-8"?><MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses"><Catalog uuid="c1"><Properties><Name>Товары</Name></Properties><ChildObjects><Attribute uuid="a1"><Properties><Name>Артикул</Name><Type><v8:Type>xs:string</v8:Type></Type></Properties></Attribute></ChildObjects></Catalog></MetaDataObject>`,
      'utf-8'
    );

    let warningMessage = '';
    vscode.window.showInputBox = async () => 'ПоАртикулу';
    let qpStep = 0;
    vscode.window.showQuickPick = (async () => {
      qpStep++;
      if (qpStep === 1) {
        return [{ label: 'Строка (xs:string)', description: 'xs:string' }];
      }
      return []; // empty selection in content step
    }) as any;
    vscode.window.showWarningMessage = (async (msg: string) => {
      warningMessage = msg;
      return undefined;
    }) as any;

    const target: TreeNode = {
      id: 'FilterCriteria',
      name: 'Критерии отбора',
      type: MetadataType.FilterCriterion,
      filePath: path.join(tmpDir, 'FilterCriteria'),
      properties: {},
    };

    const executed = await runFilterCriterionWizard({ state, target });
    assert.strictEqual(executed, false);
    assert.ok(warningMessage.includes('не выбран ни один элемент состава') || warningMessage.includes('не может быть пустым'), `expected empty content warning, got: "${warningMessage}"`);
  });

  test('completes successfully on valid user inputs and runs configuration plan', async () => {
    // Create a catalog fixture so candidates exist for selection
    const catDir = path.join(tmpDir, 'Catalogs');
    await fs.promises.mkdir(catDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(catDir, 'Контрагенты.xml'),
      `<?xml version="1.0" encoding="UTF-8"?><MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses"><Catalog uuid="c1"><Properties><Name>Контрагенты</Name></Properties><ChildObjects><Attribute uuid="a1"><Properties><Name>Код</Name><Type><v8:Type>xs:string</v8:Type></Type></Properties></Attribute></ChildObjects></Catalog></MetaDataObject>`,
      'utf-8'
    );

    let inputStep = 0;
    vscode.window.showInputBox = async () => {
      inputStep++;
      return inputStep === 1 ? 'ПоКонтрагенту' : 'По контрагенту';
    };

    let quickPickStep = 0;
    vscode.window.showQuickPick = (async (items: any) => {
      quickPickStep++;
      if (quickPickStep === 1) {
        // Types step
        return [{ label: 'Строка (xs:string)', description: 'xs:string' }];
      }
      // Content step
      return [{ label: 'Catalog.Контрагенты.Attribute.Код' }];
    }) as any;

    let planExecuted = false;
    let cacheReloaded = false;

    const target: TreeNode = {
      id: 'FilterCriteria',
      name: 'Критерии отбора',
      type: MetadataType.FilterCriterion,
      filePath: path.join(tmpDir, 'FilterCriteria'),
      properties: {},
    };

    const executed = await runFilterCriterionWizard({
      state,
      target,
      runConfigurationPlan: async (_configPath, plan) => {
        planExecuted = true;
        for (const step of plan.steps) {
          if (step.type === 'ensureDirectory') {
            await fs.promises.mkdir(step.targetPath, { recursive: true });
          } else if (step.type === 'writeFile') {
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
    assert.ok(fs.existsSync(path.join(tmpDir, 'FilterCriteria', 'ПоКонтрагенту.xml')), 'xml file must exist');
    assert.ok(fs.existsSync(path.join(tmpDir, 'FilterCriteria', 'ПоКонтрагенту')), 'dir must exist');
  });
});
