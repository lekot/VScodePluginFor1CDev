import type * as vscode from 'vscode';
import type { BindingManager } from '../bindings/bindingManager';
import type { AgentBridge } from '../agent/agentBridge';
import type { AgentTaskManager } from '../agent/agentTaskManager';
import type { CompositionEditorProvider } from '../compositionEditor/compositionEditorProvider';
import type { InfobaseManager } from '../infobases/infobaseManager';
import type { InfobaseStorageService } from '../infobases/infobaseStorageService';
import type { InfobaseTreeDataProvider, InfobaseTreeNode } from '../infobases/infobaseTreeProvider';
import type { ConfigurationContextResolver } from '../services/configurationSession/ConfigurationContextResolver';
import type { ConfigurationMutationEngine } from '../services/configurationSession/ConfigurationMutationEngine';
import type { WorkspaceRegistry } from '../services/configurationSession/WorkspaceRegistry';
import type { ReloadCoordinatorService } from '../services/reloadCoordinatorService';
import type { ConfigurationRepositoryService } from '../services/configurationRepository/configurationRepositoryService';
import type { RepositoryStateProjection } from '../services/configurationRepository/repositoryTreeDecorations';
import type { SupportServiceComposition } from '../support/supportServiceComposition';
import type { SupportStateCache } from '../support/supportStateCache';
import type { SupportStateWatcher } from '../support/supportStateWatcher';
import type { SupportRootRegistrationLifecycle } from '../support/supportRootRegistrationLifecycle';
import type { FormEditorProvider } from '../formEditor/formEditorProvider';
import type { MxlPreviewProvider } from '../mxlPreview/mxlPreviewProvider';
import type { MetadataTreeDataProvider } from '../providers/treeDataProvider';
import type { PropertiesProvider } from '../providers/propertiesProvider';
import type { TypeEditorProvider } from '../providers/typeEditorProvider';
import type { RolesRightsEditorProvider } from '../rolesEditor/rolesRightsEditorProvider';
import type { SubsystemCommandInterfaceProvider } from '../subsystemCommandInterfaceEditor';
import type { XdtoPackageEditorProvider } from '../xdtoPackageEditor';
import type { TreeNode } from '../models/treeNode';
import type { RecoveryOutcome } from '../infobases/infobaseCatalogMutationService';
import type { ExtensionState } from './extensionState';

/** Mutable references published by activation and the composition root. */
export interface ExtensionRuntimeHandles {
  readonly workspaceRegistry: WorkspaceRegistry | null;
  readonly configurationContextResolver: ConfigurationContextResolver | null;
  readonly configurationMutationEngine: ConfigurationMutationEngine | null;
  readonly treeDataProvider: MetadataTreeDataProvider | null;
  readonly treeView: vscode.TreeView<TreeNode> | null;
  readonly propertiesProvider: PropertiesProvider | null;
  readonly typeEditorProvider: TypeEditorProvider | null;
  readonly rolesRightsEditorProvider: RolesRightsEditorProvider | null;
  readonly subsystemCompositionEditorProvider: CompositionEditorProvider | null;
  readonly exchangePlanCompositionEditorProvider: CompositionEditorProvider | null;
  readonly commonAttributeCompositionEditorProvider: CompositionEditorProvider | null;
  readonly functionalOptionCompositionEditorProvider: CompositionEditorProvider | null;
  readonly filterCriterionCompositionEditorProvider: CompositionEditorProvider | null;
  readonly subsystemCommandInterfaceProvider: SubsystemCommandInterfaceProvider | null;
  readonly xdtoPackageEditorProvider: XdtoPackageEditorProvider | null;
  readonly formEditorProvider: FormEditorProvider | null;
  readonly mxlPreviewProvider: MxlPreviewProvider | null;
  readonly reloadCoordinator: ReloadCoordinatorService | null;
  readonly infobaseStorage: InfobaseStorageService | null;
  readonly bindingManager: BindingManager | null;
  readonly infobaseManager: InfobaseManager | null;
  readonly infobaseMutationRecovery: Promise<RecoveryOutcome> | null;
  readonly infobaseRecoveryOutcome: RecoveryOutcome | null;
  readonly infobaseTreeProvider: InfobaseTreeDataProvider | null;
  readonly infobaseTreeView: vscode.TreeView<InfobaseTreeNode> | null;
  readonly refreshBindingTreeDecorations: (() => Promise<void>) | null;
  readonly agentBridge: AgentBridge | null;
  readonly agentTaskManager: AgentTaskManager | null;
  readonly supportComposition: SupportServiceComposition | null;
  readonly supportStateCache: SupportStateCache | null;
  readonly supportStateWatcher: SupportStateWatcher | null;
  readonly supportRootRegistrationLifecycle: SupportRootRegistrationLifecycle | null;
  readonly configurationRepositoryService: ConfigurationRepositoryService | null;
  readonly configurationRepositoryProjection: RepositoryStateProjection | null;
}

/** Write access limited to activation and the composition root. */
export interface ExtensionStateCompositionPort {
  initialize(context: vscode.ExtensionContext): void;
  publish(handles: Partial<ExtensionRuntimeHandles>): void;
  bindDispose(dispose: () => Promise<void>): void;
  stopPublishing(): void;
  clear(): void;
}

/** A fresh, isolated state assembly is created for each activation. */
export interface ExtensionStateAssembly {
  readonly state: ExtensionState;
  readonly composition: ExtensionStateCompositionPort;
}
