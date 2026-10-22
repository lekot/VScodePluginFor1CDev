import * as vscode from 'vscode';

export type CompositionQuiescePhase = 'ingress' | 'producers' | 'sessions';

export interface CompositionResourceOptions {
  readonly quiescePhase?: CompositionQuiescePhase;
  /** Stops admission or producers while keeping the owned resource available for session drain. */
  readonly quiesce?: () => Promise<void> | void;
}

type DisposableLike = vscode.Disposable | { dispose: () => Promise<void> | void };
type DisposableInput = DisposableLike | (() => Promise<void> | void);

interface OwnedResource {
  readonly name: string;
  readonly dispose: () => Promise<void>;
  quiescePhase?: CompositionQuiescePhase;
  quiesce?: () => Promise<void> | void;
  quiesceActionRegistered: boolean;
  quiesceUsesDisposer: boolean;
  quiesceAttempted: boolean;
  disposeErrorReported: boolean;
}

interface QuiesceAction {
  readonly name: string;
  readonly phase: CompositionQuiescePhase;
  readonly run: () => Promise<void> | void;
  readonly resource?: OwnedResource;
}

/** Owns the resource graph and drains it in quiesce phases followed by LIFO disposal. */
export class ExtensionCompositionOwnership {
  private readonly resources: OwnedResource[] = [];
  private readonly quiesceActions: QuiesceAction[] = [];
  private readonly completedQuiesceActions = new Set<QuiesceAction>();
  private readonly completedPhases = new Set<CompositionQuiescePhase>();
  private readonly resourcesByIdentity = new Map<unknown, OwnedResource>();
  private readonly lateOperations = new Set<Promise<void>>();
  private admissionClosed = false;
  private resourcesDisposalStarted = false;
  private quiescePromise: Promise<void> | null = null;
  private disposePromise: Promise<void> | null = null;

  constructor(private readonly reportError: (message: string, error: unknown) => void) {}

  registerDisposable(
    name: string,
    disposable: DisposableInput,
    options: CompositionResourceOptions = {},
  ): void {
    const existing = this.resourcesByIdentity.get(disposable);
    if (existing) {
      this.mergeOptions(existing, name, options);
      return;
    }

    let disposePromise: Promise<void> | undefined;
    const dispose = (): Promise<void> => {
      if (!disposePromise) {
        disposePromise = Promise.resolve().then(async () => {
          if (typeof disposable === 'function') {
            await disposable();
          } else {
            await disposable.dispose();
          }
        });
      }
      return disposePromise;
    };
    const resource: OwnedResource = {
      name,
      dispose,
      ...(options.quiescePhase ? { quiescePhase: options.quiescePhase } : {}),
      ...(options.quiesce ? { quiesce: options.quiesce } : {}),
      quiesceActionRegistered: false,
      quiesceUsesDisposer: false,
      quiesceAttempted: false,
      disposeErrorReported: false,
    };
    this.resourcesByIdentity.set(disposable, resource);
    this.registerResourceQuiesce(resource);
    if (this.admissionClosed) {
      this.resources.push(resource);
      if (this.resourcesDisposalStarted) {
        this.trackLateOperation(name, async () => {
          if (resource.quiescePhase && this.completedPhases.has(resource.quiescePhase)) {
            await this.runResourceQuiesce(resource);
          }
          await resource.dispose();
        }, resource);
      } else if (resource.quiescePhase && this.completedPhases.has(resource.quiescePhase)) {
        this.trackLateOperation(name, () => this.runResourceQuiesce(resource));
      }
      return;
    }
    this.resources.push(resource);
  }

  registerQuiesce(name: string, phase: CompositionQuiescePhase, action: () => Promise<void> | void): void {
    const item: QuiesceAction = { name, phase, run: action };
    if (this.admissionClosed) {
      if (this.completedPhases.has(phase)) {
        this.trackLateOperation(name, () => this.runQuiesceAction(item));
      } else {
        this.quiesceActions.push(item);
      }
      return;
    }
    this.quiesceActions.push(item);
  }

  /** Closes admission synchronously, before the returned promise can yield. */
  beginQuiescence(): Promise<void> {
    if (this.quiescePromise) {
      return this.quiescePromise;
    }
    this.admissionClosed = true;
    this.quiescePromise = Promise.resolve().then(() => this.performQuiescence());
    return this.quiescePromise;
  }

  /** Runs final resource cleanup exactly once after all quiesce and late-adoption work. */
  disposeResources(): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise;
    }
    const quiescence = this.beginQuiescence();
    this.disposePromise = Promise.resolve().then(async () => {
      await quiescence;
      this.resourcesDisposalStarted = true;
      while (this.resources.length > 0 || this.lateOperations.size > 0) {
        await this.drainLateOperations();
        for (const resource of this.resources.splice(0).reverse()) {
          try {
            await resource.dispose();
          } catch (error) {
            this.reportResourceDisposalError(resource, error);
          }
        }
      }
    });
    return this.disposePromise;
  }

  private mergeOptions(resource: OwnedResource, name: string, options: CompositionResourceOptions): void {
    if (options.quiescePhase && resource.quiescePhase && resource.quiescePhase !== options.quiescePhase) {
      throw new Error(`Composition resource "${name}" cannot have multiple quiesce phases.`);
    }
    if (options.quiesce && resource.quiesce && options.quiesce !== resource.quiesce) {
      throw new Error(`Composition resource "${name}" cannot have multiple quiesce actions.`);
    }
    const hadPhase = resource.quiescePhase !== undefined;
    const phase = options.quiescePhase ?? resource.quiescePhase;
    const quiesce = options.quiesce ?? resource.quiesce;
    if (phase) {
      resource.quiescePhase = phase;
    }
    if (quiesce) {
      resource.quiesce = quiesce;
    }
    resource.quiesceUsesDisposer = resource.quiesce === undefined;
    if (phase && !hadPhase) {
      this.registerResourceQuiesce(resource);
    }
  }

  private registerResourceQuiesce(resource: OwnedResource): void {
    if (!resource.quiescePhase || resource.quiesceActionRegistered) {
      return;
    }
    resource.quiesceActionRegistered = true;
    resource.quiesceUsesDisposer = resource.quiesce === undefined;
    const action: QuiesceAction = {
      name: resource.name,
      phase: resource.quiescePhase,
      resource,
      // For ingress-only registrations, disposing is the intended quiesce action. Long-lived
      // producers provide an explicit quiesce callback and remain alive through session drain.
      run: () => resource.quiesceUsesDisposer ? resource.dispose() : resource.quiesce?.(),
    };
    this.quiesceActions.push(action);
  }

  private async performQuiescence(): Promise<void> {
    const phases: readonly CompositionQuiescePhase[] = ['ingress', 'producers', 'sessions'];
    for (const phase of phases) {
      let action = [...this.quiesceActions].reverse().find((item) =>
          item.phase === phase && !this.completedQuiesceActions.has(item));
      while (action) {
        await this.runQuiesceAction(action);
        this.completedQuiesceActions.add(action);
        action = [...this.quiesceActions].reverse().find((item) =>
          item.phase === phase && !this.completedQuiesceActions.has(item));
      }
      this.completedPhases.add(phase);
    }
  }

  private async runQuiesceAction(action: QuiesceAction): Promise<void> {
    if (action.resource && action.resource.quiesceUsesDisposer) {
      action.resource.quiesceAttempted = true;
    }
    try {
      await action.run();
    } catch (error) {
      this.reportSafely(`ExtensionCompositionRoot quiesce error for ${action.name}`, error);
    }
  }

  private async runResourceQuiesce(resource: OwnedResource): Promise<void> {
    if (!resource.quiescePhase) {
      return;
    }
    await this.runQuiesceAction({
      name: resource.name,
      phase: resource.quiescePhase,
      resource,
      run: () => resource.quiesceUsesDisposer ? resource.dispose() : resource.quiesce?.(),
    });
  }

  private trackLateOperation(
    name: string,
    operation: () => Promise<void> | void,
    resource?: OwnedResource,
  ): void {
    const pending = Promise.resolve()
      .then(operation)
      .catch((error) => {
        if (resource) {
          this.reportResourceDisposalError(resource, error);
        } else {
          this.reportSafely(`ExtensionCompositionRoot late cleanup error for ${name}`, error);
        }
      })
      .then(() => undefined)
      .finally(() => this.lateOperations.delete(pending));
    this.lateOperations.add(pending);
  }

  private reportResourceDisposalError(resource: OwnedResource, error: unknown): void {
    if (resource.quiesceAttempted || resource.disposeErrorReported) {
      return;
    }
    resource.disposeErrorReported = true;
    this.reportSafely(`ExtensionCompositionRoot cleanup error for ${resource.name}`, error);
  }

  private async drainLateOperations(): Promise<void> {
    while (this.lateOperations.size > 0) {
      await Promise.all([...this.lateOperations]);
    }
  }

  private reportSafely(message: string, error: unknown): void {
    try {
      this.reportError(message, error);
    } catch {
      // Cleanup must continue even if diagnostics are unavailable.
    }
  }
}
