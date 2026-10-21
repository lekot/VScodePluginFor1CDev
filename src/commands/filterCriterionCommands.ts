import * as vscode from 'vscode';
import { TreeNode } from '../models/treeNode';
import type { TreeWizardContext } from '../extension/extensionFeatureContexts';
import { getSelectedNode } from '../helpers/commandHelpers';
import { runFilterCriterionWizard } from '../wizards/filterCriterionWizard';
import type { MutationPlan } from '../services/configurationSession/mutationPlan';
import type { RequestConfigurationReload } from '../reload/requestConfigurationReload';

export function registerFilterCriterionCommands(
  context: vscode.ExtensionContext,
  state: TreeWizardContext,
  runConfigurationPlan: (<T>(configPath: string, plan: MutationPlan<T>) => Promise<T>) | undefined,
  requestConfigurationReload: RequestConfigurationReload
): void {
  const createFilterCriterionCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.createFilterCriterion',
    async (node?: TreeNode) => {
      const target = getSelectedNode(state, node);
      await runFilterCriterionWizard({
        state,
        target,
        runConfigurationPlan,
        requestConfigurationReload,
      });
    }
  );

  context.subscriptions.push(createFilterCriterionCommand);
}
