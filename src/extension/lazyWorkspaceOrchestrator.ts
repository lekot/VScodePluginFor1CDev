export interface LazyWorkspaceView {
  readonly visible: boolean;
  onDidChangeVisibility(
    listener: (event: { readonly visible: boolean }) => unknown
  ): { dispose(): void };
}

export interface LazyWorkspaceOrchestratorOptions {
  metadataView: LazyWorkspaceView;
  infobaseView?: LazyWorkspaceView;
  loadMetadataTree: () => Promise<void>;
  registerGitHeadChangeHandlers: () => void;
  onAutoLoadError: (error: unknown) => void;
}

/**
 * Defers metadata discovery and vscode.git activation until their Explorer views are used.
 * Explicit commands continue to call the lifecycle directly and do not pass through this gate.
 */
export function registerLazyWorkspaceOrchestrator(
  options: LazyWorkspaceOrchestratorOptions
): { dispose(): void } {
  let metadataLoadStarted = false;
  let gitHandlersRegistered = false;
  let disposed = false;

  const ensureGitHandlers = (): void => {
    if (gitHandlersRegistered) {
      return;
    }
    gitHandlersRegistered = true;
    options.registerGitHeadChangeHandlers();
  };

  const ensureMetadataLoaded = (): void => {
    if (metadataLoadStarted) {
      return;
    }
    metadataLoadStarted = true;
    void Promise.resolve()
      .then(options.loadMetadataTree)
      .catch((error) => {
        metadataLoadStarted = false;
        if (disposed) {
          return;
        }
        try {
          options.onAutoLoadError(error);
        } catch {
          // Error reporting must not create an unhandled rejection.
        }
      });
  };

  const onMetadataVisibility = (visible: boolean): void => {
    if (!visible) {
      return;
    }
    ensureGitHandlers();
    ensureMetadataLoaded();
  };

  const onInfobaseVisibility = (visible: boolean): void => {
    if (visible) {
      ensureGitHandlers();
    }
  };

  const subscriptions = [
    options.metadataView.onDidChangeVisibility((event) => {
      onMetadataVisibility(event.visible);
    }),
  ];
  if (options.infobaseView) {
    subscriptions.push(
      options.infobaseView.onDidChangeVisibility((event) => {
        onInfobaseVisibility(event.visible);
      })
    );
  }

  onMetadataVisibility(options.metadataView.visible);
  onInfobaseVisibility(options.infobaseView?.visible === true);

  return {
    dispose: () => {
      disposed = true;
      subscriptions.forEach((subscription) => subscription.dispose());
    },
  };
}
