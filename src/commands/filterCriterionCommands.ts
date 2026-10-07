import * as vscode from 'vscode';
import { TreeNode } from '../models/treeNode';
import { ExtensionState } from '../state/extensionState';
import { getSelectedNode } from '../helpers/commandHelpers';
import { runFilterCriterionWizard } from '../wizards/filterCriterionWizard';
import type { MutationPlan } from '../services/configurationSession/mutationPlan';

export function registerFilterCriterionCommands(
  context: vscode.ExtensionContext,
  state: ExtensionState,
  runConfigurationPlan?: <T>(configPath: string, plan: MutationPlan<T>) => Promise<T>,
  invalidateCacheAndReload?: (configPath: string) => Promise<void>
): void {
  const createFilterCriterionCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.createFilterCriterion',
    async (node?: TreeNode) => {
      const target = getSelectedNode(state, node);
      await runFilterCriterionWizard({
        state,
        target,
        runConfigurationPlan,
        invalidateCacheAndReload,
      });
    }
  );

  context.subscriptions.push(createFilterCriterionCommand);
}
