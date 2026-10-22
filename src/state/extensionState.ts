import type * as vscode from 'vscode';
import type {
  ExtensionRuntimeHandles,
  ExtensionStateAssembly,
  ExtensionStateCompositionPort,
} from './extensionStateComposition';

export interface ExtensionState extends ExtensionRuntimeHandles {
  readonly extensionContext: vscode.ExtensionContext | undefined;
  dispose(): Promise<void>;
}

type MutableHandles = {
  -readonly [Key in keyof ExtensionRuntimeHandles]: ExtensionRuntimeHandles[Key];
};

function createEmptyHandles(): MutableHandles {
  return {
    workspaceRegistry: null,
    configurationContextResolver: null,
    configurationMutationEngine: null,
    treeDataProvider: null,
    treeView: null,
    propertiesProvider: null,
    typeEditorProvider: null,
    rolesRightsEditorProvider: null,
    subsystemCompositionEditorProvider: null,
    exchangePlanCompositionEditorProvider: null,
    commonAttributeCompositionEditorProvider: null,
    functionalOptionCompositionEditorProvider: null,
    filterCriterionCompositionEditorProvider: null,
    subsystemCommandInterfaceProvider: null,
    xdtoPackageEditorProvider: null,
    formEditorProvider: null,
    mxlPreviewProvider: null,
    reloadCoordinator: null,
    infobaseStorage: null,
    bindingManager: null,
    infobaseManager: null,
    infobaseMutationRecovery: null,
    infobaseRecoveryOutcome: null,
    infobaseTreeProvider: null,
    infobaseTreeView: null,
    refreshBindingTreeDecorations: null,
    agentBridge: null,
    agentTaskManager: null,
    supportComposition: null,
    supportStateCache: null,
    supportStateWatcher: null,
    supportRootRegistrationLifecycle: null,
    configurationRepositoryService: null,
    configurationRepositoryProjection: null,
  };
}

/** Creates a read-only state facade and its activation-scoped composition port. */
export function createExtensionState(): ExtensionStateAssembly {
  const handles = createEmptyHandles();
  let extensionContext: vscode.ExtensionContext | undefined;
  let initialized = false;
  let publishingStopped = false;
  let cleared = false;
  let disposeOwner: (() => Promise<void>) | undefined;
  let disposePromise: Promise<void> | undefined;

  const composition: ExtensionStateCompositionPort = {
    initialize(context): void {
      if (publishingStopped || cleared) {
        throw new Error('Cannot initialize a disposed extension state assembly.');
      }
      if (initialized) {
        throw new Error('Extension state assembly is already initialized.');
      }
      initialized = true;
      extensionContext = context;
    },
    publish(nextHandles): void {
      if (publishingStopped || cleared) {
        throw new Error('Cannot publish handles to a disposed extension state assembly.');
      }
      if (!disposeOwner) {
        throw new Error('Cannot publish handles before a composition owner is bound.');
      }
      Object.assign(handles, nextHandles);
    },
    bindDispose(dispose): void {
      if (publishingStopped || cleared) {
        throw new Error('Cannot bind an owner to a disposed extension state assembly.');
      }
      if (disposeOwner) {
        throw new Error('Extension state assembly already has a disposal owner.');
      }
      disposeOwner = dispose;
    },
    stopPublishing(): void {
      publishingStopped = true;
    },
    clear(): void {
      publishingStopped = true;
      if (cleared) {
        return;
      }
      cleared = true;
      extensionContext = undefined;
      Object.assign(handles, createEmptyHandles());
    },
  };

  const state = Object.create(null) as ExtensionState;
  for (const key of Object.keys(handles) as Array<keyof ExtensionRuntimeHandles>) {
    Object.defineProperty(state, key, {
      configurable: false,
      enumerable: true,
      get: () => handles[key],
    });
  }
  Object.defineProperty(state, 'extensionContext', {
    configurable: false,
    enumerable: true,
    get: () => extensionContext,
  });
  Object.defineProperty(state, 'dispose', {
    configurable: false,
    enumerable: true,
    writable: false,
    value: (): Promise<void> => {
      if (disposePromise) {
        return disposePromise;
      }
      publishingStopped = true;
      const owner = disposeOwner;
      if (!owner) {
        composition.clear();
        disposePromise = Promise.resolve();
        return disposePromise;
      }
      disposePromise = Promise.resolve().then(owner);
      return disposePromise;
    },
  });
  Object.freeze(state);
  Object.freeze(composition);

  return Object.freeze({ state, composition });
}
