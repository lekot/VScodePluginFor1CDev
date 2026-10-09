import * as vscode from 'vscode';
import { TreeNode } from '../models/treeNode';
import { ExtensionState } from '../state/extensionState';
import { validateElementName } from '../utils/elementNameValidator';
import {
  collectAvailableFilterTypes,
  collectAvailableFilterCandidates,
  planCreateFilterCriterion,
  type FilterCriterionWizardParams,
} from '../services/filterCriterionWizardService';
import { Logger } from '../utils/logger';
import { getSelectedNode, requireDesignerFormat } from '../helpers/commandHelpers';

import type { MutationPlan } from '../services/configurationSession/mutationPlan';
import { runConfigurationPlan as defaultRunConfigurationPlan } from '../services/configurationSession/configurationMutationGateway';

export interface RunFilterCriterionWizardOptions {
  state: ExtensionState;
  target?: TreeNode;
  runConfigurationPlan?: <T>(configPath: string, plan: MutationPlan<T>) => Promise<T>;
  invalidateCacheAndReload?: (configPath: string) => Promise<void>;
}

/**
 * Interactive step-by-step wizard for creating a valid FilterCriterion.
 */
export async function runFilterCriterionWizard(options: RunFilterCriterionWizardOptions): Promise<boolean> {
  const { state, target, runConfigurationPlan, invalidateCacheAndReload } = options;

  const selectedNode = getSelectedNode(state, target);
  if (!selectedNode) {
    vscode.window.showWarningMessage('Выберите узел папки «Критерии отбора» или откройте конфигурацию.');
    return false;
  }

  const designerCtx = await requireDesignerFormat(state, selectedNode, {
    notLoadedMessage: 'Дерево метаданных не загружено. Откройте конфигурацию.',
    nonDesignerMessage: 'Мастер критерия отбора поддерживается только для формата Designer.',
  });
  if (!designerCtx) {
    return false;
  }
  const { configPath } = designerCtx;

  // Step 1: Element Name
  const existingSiblings = (target?.children || []).map((c) => c.name);
  const name = await vscode.window.showInputBox({
    title: 'Мастер создания критерия отбора (1/4): Имя',
    prompt: 'Введите имя нового критерия отбора (латиница, кириллица, цифры, _)',
    placeHolder: 'Например: ПоПартнеру',
    validateInput: (val) => validateElementName(val.trim(), existingSiblings) ?? undefined,
  });
  if (!name || !name.trim()) {
    return false;
  }
  const trimmedName = name.trim();

  // Step 2: Synonym
  const synonym = await vscode.window.showInputBox({
    title: 'Мастер создания критерия отбора (2/4): Синоним',
    prompt: 'Введите синоним (русский)',
    value: trimmedName,
  });
  if (synonym === undefined) {
    return false;
  }

  // Step 3: Type selection
  const availableTypes = await collectAvailableFilterTypes(configPath);
  const typePicks: vscode.QuickPickItem[] = availableTypes.map((t) => ({
    label: t.label,
    description: t.typeRef,
    picked: false,
  }));

  const selectedTypePicks = await vscode.window.showQuickPick(typePicks, {
    title: 'Мастер создания критерия отбора (3/4): Тип значения',
    placeHolder: 'Выберите один или несколько типов, значения которых будут отбираться',
    canPickMany: true,
  });
  if (!selectedTypePicks || selectedTypePicks.length === 0) {
    vscode.window.showWarningMessage('Создание отменено: необходимо выбрать хотя бы один тип значения.');
    return false;
  }
  const chosenTypes = selectedTypePicks.map((p) => p.description || p.label);

  // Step 4: Content selection
  const availableCandidates = await collectAvailableFilterCandidates(configPath, chosenTypes);
  const candidatePicks: vscode.QuickPickItem[] = availableCandidates.map((c) => ({
    label: c.ref,
    description: c.label,
    detail: c.detail ? `Тип: ${c.detail}` : undefined,
    picked: c.matchesSelectedType,
  }));

  if (candidatePicks.length === 0) {
    vscode.window.showWarningMessage('В конфигурации не найдено подходящих реквизитов/измерений для состава критерия отбора.');
    return false;
  }

  const selectedContentPicks = await vscode.window.showQuickPick(candidatePicks, {
    title: 'Мастер создания критерия отбора (4/4): Состав критерия',
    placeHolder: 'Выберите реквизиты/измерения метаданных, входящие в критерий отбора',
    canPickMany: true,
  });
  if (selectedContentPicks === undefined) {
    return false; // User hit Esc
  }
  const chosenContent = selectedContentPicks.map((p) => p.label);
  if (chosenContent.length === 0) {
    vscode.window.showWarningMessage('Не выбран ни один элемент состава критерия отбора (состав не может быть пустым).');
    return false;
  }

  // Step 5: Execute plan
  const params: FilterCriterionWizardParams = {
    name: trimmedName,
    synonym: synonym.trim() || trimmedName,
    types: chosenTypes,
    content: chosenContent,
    useStandardCommands: true,
  };

  try {
    const plan = await planCreateFilterCriterion(configPath, params);
    const executePlan = runConfigurationPlan ?? defaultRunConfigurationPlan;
    await executePlan(configPath, plan);
    vscode.window.showInformationMessage(`Создан критерий отбора: ${trimmedName}`);

    if (invalidateCacheAndReload) {
      void invalidateCacheAndReload(configPath).catch((err) => {
        Logger.error('Background reload after createFilterCriterion failed', err);
      });
    }
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Ошибка при создании критерия отбора: ${msg}`);
    return false;
  }
}
