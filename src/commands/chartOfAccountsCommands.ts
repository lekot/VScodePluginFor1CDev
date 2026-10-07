import * as vscode from 'vscode';
import { TreeNode } from '../models/treeNode';
import { ExtensionState } from '../state/extensionState';
import { getSelectedNode } from '../helpers/commandHelpers';
import { runChartOfAccountsWizard } from '../wizards/chartOfAccountsWizard';
import type { MutationPlan } from '../services/configurationSession/mutationPlan';

export function registerChartOfAccountsCommands(
  context: vscode.ExtensionContext,
  state: ExtensionState,
  runConfigurationPlan?: <T>(configPath: string, plan: MutationPlan<T>) => Promise<T>,
  invalidateCacheAndReload?: (configPath: string) => Promise<void>
): void {
  const createChartOfAccountsCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.createChartOfAccounts',
    async (node?: TreeNode) => {
      const target = getSelectedNode(state, node);
      await runChartOfAccountsWizard({
        state,
        target,
        runConfigurationPlan,
        invalidateCacheAndReload,
      });
    }
  );

  context.subscriptions.push(createChartOfAccountsCommand);
}
