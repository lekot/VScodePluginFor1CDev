import type * as vscode from 'vscode';
import type { ExtensionState } from '../state/extensionState';
import type { ExtensionRuntimeHandles } from '../state/extensionStateComposition';

/** A feature receives only the runtime handles it must have in order to register. */
export type RequiredFeatureHandles<Keys extends keyof ExtensionRuntimeHandles> = Readonly<{
  [Key in Keys]: NonNullable<ExtensionRuntimeHandles[Key]>;
}>;

type ExtensionContextHandle = { readonly extensionContext: vscode.ExtensionContext };

export type MetadataTreeLifecycleContext = RequiredFeatureHandles<
  'configurationContextResolver' | 'treeDataProvider' | 'propertiesProvider'
> & ExtensionContextHandle;
/**
 * Bootstrap-only view used by the metadata lifecycle before composition has
 * published its services. Registered features must use required contexts below.
 */
export interface MetadataTreeLifecycleRuntimeView {
  readonly configurationContextResolver: ExtensionRuntimeHandles['configurationContextResolver'];
  readonly treeDataProvider: ExtensionRuntimeHandles['treeDataProvider'];
  readonly propertiesProvider: ExtensionRuntimeHandles['propertiesProvider'];
  readonly reloadCoordinator: ExtensionRuntimeHandles['reloadCoordinator'];
  readonly extensionContext: vscode.ExtensionContext | undefined;
}
export type BindingCommandsContext = RequiredFeatureHandles<
  | 'bindingManager'
  | 'infobaseStorage'
  | 'reloadCoordinator'
  | 'supportComposition'
  | 'supportStateCache'
>;
export type BindingDialogContext = RequiredFeatureHandles<
  'bindingManager' | 'infobaseStorage' | 'treeView' | 'refreshBindingTreeDecorations'
>;
export type BindingDialogCommandsContext = BindingDialogContext & BindingCommandsContext &
  RequiredFeatureHandles<'treeDataProvider'>;
export type BindingTreeDecorationsContext = RequiredFeatureHandles<
  'bindingManager' | 'infobaseStorage' | 'treeDataProvider'
>;
export type InfobaseTreeCommandsContext = RequiredFeatureHandles<
  'infobaseManager' | 'infobaseStorage' | 'infobaseTreeProvider'
>;
export type TreeProviderContext = RequiredFeatureHandles<'treeDataProvider'>;
export type TreeWizardContext = RequiredFeatureHandles<'treeDataProvider' | 'treeView'>;
export type TreeNavigationContext = RequiredFeatureHandles<'treeDataProvider' | 'treeView' | 'formEditorProvider'>;
export type TreeSelectionContext = RequiredFeatureHandles<'treeView'>;
export type CfCommandsContext = RequiredFeatureHandles<'treeDataProvider' | 'treeView'>;
export type ConfigurationCompareContext = RequiredFeatureHandles<
  'configurationContextResolver' | 'configurationMutationEngine' | 'treeDataProvider' | 'treeView'
>;
export type ConfigurationRepositoryContext = RequiredFeatureHandles<
  'bindingManager' | 'infobaseStorage' | 'configurationRepositoryService' | 'treeView'
>;
export type EditorCommandsContext = RequiredFeatureHandles<
  | 'bindingManager'
  | 'commonAttributeCompositionEditorProvider'
  | 'exchangePlanCompositionEditorProvider'
  | 'filterCriterionCompositionEditorProvider'
  | 'functionalOptionCompositionEditorProvider'
  | 'infobaseStorage'
  | 'propertiesProvider'
  | 'rolesRightsEditorProvider'
  | 'subsystemCommandInterfaceProvider'
  | 'subsystemCompositionEditorProvider'
  | 'treeDataProvider'
  | 'treeView'
  | 'xdtoPackageEditorProvider'
> & ExtensionContextHandle;
export type UtilityCommandsContext = RequiredFeatureHandles<
  'propertiesProvider' | 'treeDataProvider' | 'treeView'
>;
export type ElementCommandsContext = RequiredFeatureHandles<'treeDataProvider' | 'treeView'>;
export type FilterCommandsContext = RequiredFeatureHandles<'treeDataProvider' | 'treeView'>;
export type ExtensionSupportCommandsContext = RequiredFeatureHandles<'treeDataProvider' | 'treeView'>;
export type SupportFeatureContext = RequiredFeatureHandles<
  'bindingManager' | 'infobaseStorage' | 'treeDataProvider'
> & ExtensionContextHandle;
export type AgentFeatureContext = RequiredFeatureHandles<
  | 'bindingManager'
  | 'configurationRepositoryService'
  | 'infobaseStorage'
  | 'supportComposition'
  | 'supportStateCache'
  | 'treeDataProvider'
> & ExtensionContextHandle;
export type RequestReloadContext = RequiredFeatureHandles<'reloadCoordinator'>;
export type ReloadOrchestratorContext = RequiredFeatureHandles<'reloadCoordinator' | 'treeDataProvider'>;
export type ReloadOrchestratorLifecycleContext = Pick<
  MetadataTreeLifecycleRuntimeView,
  'reloadCoordinator' | 'treeDataProvider'
>;
export type QueryBuilderContext = RequiredFeatureHandles<'treeDataProvider'>;

/**
 * Verifies a named feature's mandatory handles once, at the composition boundary,
 * then returns an immutable object containing only those handles.
 */
function requireFeatureHandles<Keys extends keyof ExtensionRuntimeHandles>(
  state: ExtensionState,
  featureName: string,
  keys: readonly Keys[],
): RequiredFeatureHandles<Keys> {
  const result: Partial<Record<Keys, NonNullable<ExtensionRuntimeHandles[Keys]>>> =
    Object.create(null) as Partial<Record<Keys, NonNullable<ExtensionRuntimeHandles[Keys]>>>;
  for (const key of keys) {
    const value = state[key];
    if (value === null || value === undefined) {
      throw new Error(`${featureName} requires extension handle "${key}" before registration.`);
    }
    result[key] = value;
  }
  return Object.freeze(result) as RequiredFeatureHandles<Keys>;
}

function createExtensionContextHandle(extensionContext: vscode.ExtensionContext): ExtensionContextHandle {
  return Object.freeze({ extensionContext });
}

export function createMetadataTreeLifecycleRuntimeView(state: ExtensionState): MetadataTreeLifecycleRuntimeView {
  const view = Object.create(null) as MetadataTreeLifecycleRuntimeView;
  for (const key of [
    'configurationContextResolver',
    'treeDataProvider',
    'propertiesProvider',
    'reloadCoordinator',
    'extensionContext',
  ] as const) {
    Object.defineProperty(view, key, {
      configurable: false,
      enumerable: true,
      get: () => state[key],
    });
  }
  return Object.freeze(view);
}

export function createBindingCommandsContext(state: ExtensionState): BindingCommandsContext {
  return requireFeatureHandles(state, 'Binding commands', [
    'bindingManager', 'infobaseStorage', 'reloadCoordinator', 'supportComposition', 'supportStateCache',
  ]);
}

export function createBindingDialogContext(state: ExtensionState): BindingDialogContext {
  return requireFeatureHandles(state, 'Binding dialog', [
    'bindingManager', 'infobaseStorage', 'treeView', 'refreshBindingTreeDecorations',
  ]);
}

export function createBindingDialogCommandsContext(state: ExtensionState): BindingDialogCommandsContext {
  return Object.freeze({
    ...createBindingDialogContext(state),
    ...createBindingCommandsContext(state),
    ...requireFeatureHandles(state, 'Binding dialog commands', ['treeDataProvider']),
  });
}

export function createBindingTreeDecorationsContext(state: ExtensionState): BindingTreeDecorationsContext {
  return requireFeatureHandles(state, 'Binding tree decorations', [
    'bindingManager', 'infobaseStorage', 'treeDataProvider',
  ]);
}

export function createInfobaseTreeCommandsContext(state: ExtensionState): InfobaseTreeCommandsContext {
  return requireFeatureHandles(state, 'Infobase tree commands', [
    'infobaseManager', 'infobaseStorage', 'infobaseTreeProvider',
  ]);
}

export function createTreeProviderContext(state: ExtensionState): TreeProviderContext {
  return requireFeatureHandles(state, 'Tree provider feature', ['treeDataProvider']);
}

export function createTreeWizardContext(state: ExtensionState): TreeWizardContext {
  return requireFeatureHandles(state, 'Tree-backed wizard', ['treeDataProvider', 'treeView']);
}

export function createTreeNavigationContext(state: ExtensionState): TreeNavigationContext {
  return requireFeatureHandles(state, 'Tree navigation', [
    'treeDataProvider', 'treeView', 'formEditorProvider',
  ]);
}

export function createTreeSelectionContext(state: ExtensionState): TreeSelectionContext {
  return requireFeatureHandles(state, 'Tree selection', ['treeView']);
}

export function createCfCommandsContext(state: ExtensionState): CfCommandsContext {
  return requireFeatureHandles(state, 'CF commands', ['treeDataProvider', 'treeView']);
}

export function createConfigurationCompareContext(state: ExtensionState): ConfigurationCompareContext {
  return requireFeatureHandles(state, 'Configuration compare commands', [
    'configurationContextResolver', 'configurationMutationEngine', 'treeDataProvider', 'treeView',
  ]);
}

export function createConfigurationRepositoryContext(state: ExtensionState): ConfigurationRepositoryContext {
  return requireFeatureHandles(state, 'Configuration repository commands', [
    'bindingManager', 'infobaseStorage', 'configurationRepositoryService', 'treeView',
  ]);
}

export function createEditorCommandsContext(
  state: ExtensionState,
  extensionContext: vscode.ExtensionContext,
): EditorCommandsContext {
  return Object.freeze({
    ...requireFeatureHandles(state, 'Editor commands', [
      'bindingManager',
      'commonAttributeCompositionEditorProvider',
      'exchangePlanCompositionEditorProvider',
      'filterCriterionCompositionEditorProvider',
      'functionalOptionCompositionEditorProvider',
      'infobaseStorage',
      'propertiesProvider',
      'rolesRightsEditorProvider',
      'subsystemCommandInterfaceProvider',
      'subsystemCompositionEditorProvider',
      'treeDataProvider',
      'treeView',
      'xdtoPackageEditorProvider',
    ]),
    ...createExtensionContextHandle(extensionContext),
  });
}

export function createUtilityCommandsContext(state: ExtensionState): UtilityCommandsContext {
  return requireFeatureHandles(state, 'Utility commands', [
    'propertiesProvider', 'treeDataProvider', 'treeView',
  ]);
}

export function createElementCommandsContext(state: ExtensionState): ElementCommandsContext {
  return requireFeatureHandles(state, 'Element commands', ['treeDataProvider', 'treeView']);
}

export function createFilterCommandsContext(state: ExtensionState): FilterCommandsContext {
  return requireFeatureHandles(state, 'Filter commands', ['treeDataProvider', 'treeView']);
}

export function createExtensionSupportCommandsContext(state: ExtensionState): ExtensionSupportCommandsContext {
  return requireFeatureHandles(state, 'Extension support commands', ['treeDataProvider', 'treeView']);
}

export function createSupportFeatureContext(
  state: ExtensionState,
  extensionContext: vscode.ExtensionContext,
): SupportFeatureContext {
  return Object.freeze({
    ...requireFeatureHandles(state, 'Support feature composition', [
      'bindingManager', 'infobaseStorage', 'treeDataProvider',
    ]),
    ...createExtensionContextHandle(extensionContext),
  });
}

export function createAgentFeatureContext(
  state: ExtensionState,
  extensionContext: vscode.ExtensionContext,
): AgentFeatureContext {
  return Object.freeze({
    ...requireFeatureHandles(state, 'Agent feature composition', [
      'bindingManager',
      'configurationRepositoryService',
      'infobaseStorage',
      'supportComposition',
      'supportStateCache',
      'treeDataProvider',
    ]),
    ...createExtensionContextHandle(extensionContext),
  });
}

export function createRequestReloadContext(state: ExtensionState): RequestReloadContext {
  return requireFeatureHandles(state, 'Configuration reload requests', ['reloadCoordinator']);
}

export function createReloadOrchestratorContext(state: ExtensionState): ReloadOrchestratorContext {
  return requireFeatureHandles(state, 'Reload orchestrator', ['reloadCoordinator', 'treeDataProvider']);
}

export function createQueryBuilderContext(state: ExtensionState): QueryBuilderContext {
  return requireFeatureHandles(state, 'Query builder', ['treeDataProvider']);
}
