import * as vscode from 'vscode';
import { TreeNode } from '../models/treeNode';
import type { TreeWizardContext } from '../extension/extensionFeatureContexts';
import { getSelectedNode } from '../helpers/commandHelpers';
import { runChartOfAccountsWizard } from '../wizards/chartOfAccountsWizard';
import type { MutationPlan } from '../services/configurationSession/mutationPlan';
import type { RequestConfigurationReload } from '../reload/requestConfigurationReload';

export function registerChartOfAccountsCommands(
  context: vscode.ExtensionContext,
  state: TreeWizardContext,
  runConfigurationPlan: (<T>(configPath: string, plan: MutationPlan<T>) => Promise<T>) | undefined,
  requestConfigurationReload: RequestConfigurationReload
): void {
  const createChartOfAccountsCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.createChartOfAccounts',
    async (node?: TreeNode) => {
      const target = getSelectedNode(state, node);
      await runChartOfAccountsWizard({
        state,
        target,
        runConfigurationPlan,
        requestConfigurationReload,
      });
    }
  );

  context.subscriptions.push(createChartOfAccountsCommand);
}
