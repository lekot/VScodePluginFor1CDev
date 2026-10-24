import * as vscode from 'vscode';
import { registerExternalProcessorCommands } from './externalProcessorCommands';
import { registerFilterCriterionCommands } from './filterCriterionCommands';
import { registerPictureCommands } from './pictureCommands';
import { registerElementCommands } from './elementCommands';
import { registerNavigationCommands } from './navigationCommands';
import { registerEditorCommands } from './editorCommands';
import { registerChartOfAccountsCommands } from './chartOfAccountsCommands';
import { registerConfigurationCompareCommands } from './configurationCompareCommands';
import { registerCfCommands } from './cfCommands';
import { registerFilterCommands } from './filterCommands';
import {
  registerUtilityCommandsLeading,
  registerUtilityCommandsTrailing,
} from './utilityCommands';
import { registerExtensionCommands } from '../extensionSupport/extensionCommands';
import { registerCfeProjectCommands } from '../extensionSupport/cfeProject/cfeProjectCommands';
import { registerConfigurationProjectCommands } from '../configurationProject/configurationProjectCommands';
import type { MetadataTreeFeatureLifecycle } from '../extension/metadataTreeLifecycle';
import {
  type CfCommandsContext,
  type ConfigurationCompareContext,
  type ConfigurationRepositoryContext,
  type EditorCommandsContext,
  type ElementCommandsContext,
  type ExtensionSupportCommandsContext,
  type FilterCommandsContext,
  type TreeNavigationContext,
  type TreeWizardContext,
  type UtilityCommandsContext,
} from '../extension/extensionFeatureContexts';
import type { RegisterSupportCommandsDeps } from '../support/supportCommands';
import { registerSupportCommands } from '../support/supportCommands';
import type { ConfigurationInfrastructure } from '../extension/extensionCompositionRoot';
import type { RequestConfigurationReload } from '../reload/requestConfigurationReload';
import { registerConfigurationRepositoryCommands } from './configurationRepositoryCommands';
import { registerSyntaxHelpCommands } from '../providers/syntaxHelpProvider';
import { registerAgentCommands } from '../agent/agentCommands';
import type { RegisterAgentCommandsDependencies } from '../agent/agentCommands';

export interface RegisterAllCommandsArgs {
  readonly context: vscode.ExtensionContext;
  readonly lifecycle: MetadataTreeFeatureLifecycle;
  readonly requestConfigurationReload: RequestConfigurationReload;
  readonly infrastructure: ConfigurationInfrastructure;
  readonly agentCommands: RegisterAgentCommandsDependencies;
  readonly featureContexts: {
    readonly cf: CfCommandsContext;
    readonly chartOfAccounts: TreeWizardContext;
    readonly configurationCompare: ConfigurationCompareContext;
    readonly configurationRepository: ConfigurationRepositoryContext;
    readonly editor: EditorCommandsContext;
    readonly element: ElementCommandsContext;
    readonly extensionSupport: ExtensionSupportCommandsContext;
    readonly filter: FilterCommandsContext;
    readonly filterCriterion: TreeWizardContext;
    readonly navigation: TreeNavigationContext;
    readonly supportCommands: RegisterSupportCommandsDeps;
    readonly utility: UtilityCommandsContext;
  };
}

/** Registers command adapters from already assembled feature contexts. */
export async function registerAllCommands({
  context,
  lifecycle,
  requestConfigurationReload,
  infrastructure,
  agentCommands,
  featureContexts,
}: RegisterAllCommandsArgs): Promise<vscode.Disposable[]> {
  const returnOnlyDisposables = new Set<vscode.Disposable>();
  const collectReturned = (disposables: vscode.Disposable[]): vscode.Disposable[] => {
    for (const disposable of disposables) {
      if (!context.subscriptions.includes(disposable)) {
        returnOnlyDisposables.add(disposable);
      }
    }
    return disposables;
  };
  const utilityDeps = {
    state: featureContexts.utility,
    loadMetadataTree: lifecycle.loadMetadataTree,
    extensionContext: context,
  };

  registerExternalProcessorCommands(context);
  registerPictureCommands(context);
  registerFilterCriterionCommands(
    context,
    featureContexts.filterCriterion,
    infrastructure.runConfigurationPlan,
    requestConfigurationReload,
  );
  registerCfeProjectCommands({
    context,
    state: featureContexts.extensionSupport,
    getConfigurationRegistry: infrastructure.getConfigurationRegistry,
    refreshWorkspace: infrastructure.refreshWorkspace,
    refreshTree: lifecycle.loadMetadataTree,
  });
  registerConfigurationProjectCommands({
    context,
    refreshTree: lifecycle.loadMetadataTree,
  });
  registerExtensionCommands({
    context,
    state: featureContexts.extensionSupport,
    getConfigurationRegistry: infrastructure.getConfigurationRegistry,
    refreshTree: lifecycle.loadMetadataTree,
  });

  try {
    const supportDisposables = collectReturned(
      registerSupportCommands(featureContexts.supportCommands),
    );
    registerAgentCommands(agentCommands);
    registerChartOfAccountsCommands(
      context,
      featureContexts.chartOfAccounts,
      infrastructure.runConfigurationPlan,
      requestConfigurationReload,
    );
    return [
      ...supportDisposables,
      ...collectReturned(registerUtilityCommandsLeading(utilityDeps)),
      ...collectReturned(registerConfigurationCompareCommands({
        context,
        state: featureContexts.configurationCompare,
      })),
      ...collectReturned(registerCfCommands({ state: featureContexts.cf })),
      ...collectReturned(registerEditorCommands({ state: featureContexts.editor, context })),
      ...collectReturned(registerSyntaxHelpCommands()),
      ...collectReturned(registerElementCommands({
        state: featureContexts.element,
        loadMetadataTree: lifecycle.loadMetadataTree,
        requestConfigurationReload,
        scheduleDeleteReconcile: lifecycle.reloadOrchestratorHandlers.scheduleDeleteReconcile,
        runConfigurationMutation: infrastructure.runConfigurationMutation,
        runConfigurationPlan: infrastructure.runConfigurationPlan,
      })),
      ...collectReturned(registerNavigationCommands({ state: featureContexts.navigation })),
      ...collectReturned(registerUtilityCommandsTrailing(utilityDeps)),
      ...collectReturned(registerFilterCommands({
        state: featureContexts.filter,
        loadMetadataTree: lifecycle.loadMetadataTree,
        invalidateTreeCacheOnly: lifecycle.invalidateTreeCacheOnly,
      })),
      ...collectReturned(registerConfigurationRepositoryCommands(featureContexts.configurationRepository)),
    ];
  } catch (error) {
    for (const disposable of [...returnOnlyDisposables].reverse()) {
      try {
        disposable.dispose();
      } catch {
        // Preserve the registration error while allowing the root to finish rollback.
      }
    }
    throw error;
  }
}
