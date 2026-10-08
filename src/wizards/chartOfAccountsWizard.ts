import * as vscode from 'vscode';
import { TreeNode } from '../models/treeNode';
import { ExtensionState } from '../state/extensionState';
import { validateElementName } from '../utils/elementNameValidator';
import {
  collectAvailableSubcontoTypes,
  planCreateChartOfAccounts,
  type ChartOfAccountsWizardParams,
  type InitialPredefinedAccount,
  type AccountingFlagParam,
} from '../services/chartOfAccountsWizardService';
import { Logger } from '../utils/logger';
import { getSelectedNode, requireDesignerFormat } from '../helpers/commandHelpers';
import type { MutationPlan } from '../services/configurationSession/mutationPlan';
import { MutationPlanExecutor } from '../services/configurationSession/mutationPlan';

export interface RunChartOfAccountsWizardOptions {
  state: ExtensionState;
  target?: TreeNode;
  runConfigurationPlan?: <T>(configPath: string, plan: MutationPlan<T>) => Promise<T>;
  invalidateCacheAndReload?: (configPath: string) => Promise<void>;
}

/**
 * Interactive step-by-step wizard for creating a valid ChartOfAccounts.
 */
export async function runChartOfAccountsWizard(options: RunChartOfAccountsWizardOptions): Promise<boolean> {
  const { state, target, runConfigurationPlan, invalidateCacheAndReload } = options;

  const selectedNode = getSelectedNode(state, target);
  if (!selectedNode) {
    vscode.window.showWarningMessage('Выберите узел папки «Планы счетов» или откройте конфигурацию.');
    return false;
  }

  const designerCtx = await requireDesignerFormat(state, selectedNode, {
    notLoadedMessage: 'Дерево метаданных не загружено. Откройте конфигурацию.',
    nonDesignerMessage: 'Мастер плана счетов поддерживается только для формата Designer.',
  });
  if (!designerCtx) {
    return false;
  }
  const { configPath } = designerCtx;

  // Step 1: Element Name
  const existingSiblings = (target?.children || []).map((c) => c.name);
  const name = await vscode.window.showInputBox({
    title: 'Мастер создания плана счетов (1/5): Имя',
    prompt: 'Введите имя нового плана счетов (латиница, кириллица, цифры, _)',
    placeHolder: 'Например: Хозрасчетный',
    validateInput: (val) => validateElementName(val.trim(), existingSiblings) ?? undefined,
  });
  if (!name || !name.trim()) {
    return false;
  }
  const trimmedName = name.trim();

  // Step 2: Synonym
  const synonym = await vscode.window.showInputBox({
    title: 'Мастер создания плана счетов (2/5): Синоним',
    prompt: 'Введите синоним (русский)',
    value: trimmedName,
  });
  if (synonym === undefined) {
    return false;
  }

  // Step 3: Subconto / ExtDimensionTypes
  const availableSubconto = await collectAvailableSubcontoTypes(configPath);
  type SubcontoPickItem = vscode.QuickPickItem & { ref?: string };
  const subcontoItems: SubcontoPickItem[] = [
    {
      label: '(Без субконто)',
      description: 'План счетов не использует виды субконто',
      ref: undefined,
    },
    ...availableSubconto.map((cot) => ({
      label: cot.name,
      description: cot.label,
      ref: cot.ref,
    })),
  ];

  const selectedSubcontoItem = await vscode.window.showQuickPick(subcontoItems, {
    title: 'Мастер создания плана счетов (3/5): Субконто (План видов характеристик)',
    placeHolder: 'Выберите план видов характеристик для видов субконто или вариант «Без субконто»',
  });
  if (!selectedSubcontoItem) {
    return false;
  }

  let extDimensionTypes: string | undefined;
  let maxExtDimensionCount = 0;

  if (selectedSubcontoItem.ref) {
    extDimensionTypes = selectedSubcontoItem.ref;
    const maxCountStr = await vscode.window.showInputBox({
      title: 'Мастер создания плана счетов (3/5): Макс. количество субконто',
      prompt: 'Укажите максимальное количество субконто на счете (от 1 до 50)',
      value: '3',
      validateInput: (val) => {
        const num = Number.parseInt(val.trim(), 10);
        if (isNaN(num) || num < 1 || num > 50) {
          return 'Введите число от 1 до 50';
        }
        return undefined;
      },
    });
    if (maxCountStr === undefined) {
      return false;
    }
    maxExtDimensionCount = Number.parseInt(maxCountStr.trim(), 10);
  }

  // Step 4: Code Mask & Length
  type CodeMaskPickItem = vscode.QuickPickItem & { mask: string; length: number };
  const maskItems: CodeMaskPickItem[] = [
    { label: '@@@.@@.@ (маска, длина 8)', description: '3 знака счета, 2 субсчета, 1 субсубсчет', mask: '@@@.@@.@', length: 8 },
    { label: '@@.@@ (маска, длина 5)', description: '2 знака счета, 2 знака субсчета', mask: '@@.@@', length: 5 },
    { label: 'Без маски (длина 8)', description: 'Произвольный код до 8 знаков', mask: '', length: 8 },
    { label: 'Без маски (длина 9)', description: 'Произвольный код до 9 знаков', mask: '', length: 9 },
  ];

  const selectedMaskItem = await vscode.window.showQuickPick(maskItems, {
    title: 'Мастер создания плана счетов (4/5): Маска и длина кода',
    placeHolder: 'Выберите формат маски кода счетов',
  });
  if (!selectedMaskItem) {
    return false;
  }

  // Step 5: Flags & Initial Predefined Accounts
  type FeaturePickItem = vscode.QuickPickItem & { value: string };
  const featureItems: FeaturePickItem[] = [
    {
      label: 'Создать начальный предопределенный счет 000 (Вспомогательный)',
      picked: true,
      value: 'account_000',
    },
    {
      label: 'Признак учета: Валютный',
      picked: false,
      value: 'flag_Валютный',
    },
    {
      label: 'Признак учета: Количественный',
      picked: false,
      value: 'flag_Количественный',
    },
  ];

  if (extDimensionTypes) {
    featureItems.push(
      {
        label: 'Признак учета субконто: Суммовой',
        picked: true,
        value: 'subconto_Суммовой',
      },
      {
        label: 'Признак учета субконто: Валютный',
        picked: false,
        value: 'subconto_Валютный',
      },
      {
        label: 'Признак учета субконто: Количественный',
        picked: false,
        value: 'subconto_Количественный',
      }
    );
  }

  const selectedFeatures = await vscode.window.showQuickPick(featureItems, {
    title: 'Мастер создания плана счетов (5/5): Признаки учета и начальные счета',
    canPickMany: true,
  });
  if (!selectedFeatures) {
    return false;
  }

  const featureValues = new Set(selectedFeatures.map((f) => f.value));

  const accountingFlags: AccountingFlagParam[] = [];
  if (featureValues.has('flag_Валютный')) {
    accountingFlags.push({ name: 'Валютный', synonym: 'Валютный учет' });
  }
  if (featureValues.has('flag_Количественный')) {
    accountingFlags.push({ name: 'Количественный', synonym: 'Количественный учет' });
  }

  const extDimensionAccountingFlags: AccountingFlagParam[] = [];
  if (featureValues.has('subconto_Суммовой')) {
    extDimensionAccountingFlags.push({ name: 'Суммовой', synonym: 'Суммовой учет субконто' });
  }
  if (featureValues.has('subconto_Валютный')) {
    extDimensionAccountingFlags.push({ name: 'Валютный', synonym: 'Валютный учет субконто' });
  }
  if (featureValues.has('subconto_Количественный')) {
    extDimensionAccountingFlags.push({ name: 'Количественный', synonym: 'Количественный учет субконто' });
  }

  const predefinedAccounts: InitialPredefinedAccount[] = [];
  if (featureValues.has('account_000')) {
    predefinedAccounts.push({
      name: 'Вспомогательный',
      code: '000',
      description: 'Вспомогательный счет',
      accountType: 'ActivePassive',
      offBalance: false,
      order: '000',
    });
  }

  const params: ChartOfAccountsWizardParams = {
    name: trimmedName,
    synonym: synonym.trim() || trimmedName,
    codeMask: selectedMaskItem.mask,
    codeLength: selectedMaskItem.length,
    descriptionLength: 120,
    orderLength: 5,
    extDimensionTypes,
    maxExtDimensionCount,
    accountingFlags,
    extDimensionAccountingFlags,
    predefinedAccounts,
  };

  try {
    const plan = await planCreateChartOfAccounts({
      configPath,
      params,
    });

    if (runConfigurationPlan) {
      await runConfigurationPlan(configPath, plan);
    } else {
      const executor = new MutationPlanExecutor(configPath);
      const outcome = await executor.execute(plan);
      if (!outcome.success) {
        throw new Error(outcome.error || 'Не удалось выполнить план создания плана счетов.');
      }
    }

    if (invalidateCacheAndReload) {
      await invalidateCacheAndReload(configPath);
    }

    vscode.window.showInformationMessage(`План счетов «${trimmedName}» успешно создан.`);
    return true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    Logger.error(`[runChartOfAccountsWizard] Error creating ChartOfAccounts: ${message}`);
    vscode.window.showErrorMessage(`Ошибка при создании плана счетов: ${message}`);
    return false;
  }
}
