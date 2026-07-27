import * as path from 'path';
import type { ConfigurationId } from '../services/configurationSession/types';
import type {
  SupportApplicationServiceRegistry,
  SupportConfigurationRegistration,
} from './supportApplicationServiceRegistry';
import type {
  SupportStateWatcher,
  SupportWatcherDisposable,
} from './supportStateWatcher';

interface ActiveRegistration {
  readonly registration: SupportConfigurationRegistration;
  readonly watcherRegistration: SupportWatcherDisposable;
}

export interface SupportRootRegistrationLifecycleDeps {
  readonly registry: Pick<
    SupportApplicationServiceRegistry,
    'registerConfiguration' | 'unregisterConfiguration'
  >;
  readonly watcher: Pick<SupportStateWatcher, 'register'>;
  readonly resolveRegistrations: (
    configRoots: readonly string[],
  ) => Promise<readonly SupportConfigurationRegistration[]>;
  readonly loadRegistration: (
    registration: SupportConfigurationRegistration,
  ) => Promise<void>;
  readonly onDidLoad: (registration: SupportConfigurationRegistration) => void;
  readonly onError: (error: unknown) => void;
}

/**
 * Serializes provider root snapshots and rejects stale async resolutions by epoch.
 * The provider callback remains synchronous while every rejected async reconciliation is reported.
 */
export class SupportRootRegistrationLifecycle {
  private readonly activeByRoot = new Map<string, ActiveRegistration>();
  private tail: Promise<void> = Promise.resolve();
  private epoch = 0;
  private disposed = false;

  constructor(private readonly deps: SupportRootRegistrationLifecycleDeps) {}

  accept(configRoots: readonly string[]): void {
    if (this.disposed) {
      return;
    }
    const epoch = ++this.epoch;
    const roots = Object.freeze([...configRoots]);
    const reconciliation = this.tail.then(() => this.reconcile(roots, epoch));
    this.tail = reconciliation.catch((error) => {
      this.deps.onError(error);
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.epoch += 1;
    await this.tail;
    for (const active of this.activeByRoot.values()) {
      active.watcherRegistration.dispose();
      this.deps.registry.unregisterConfiguration(active.registration.configurationId);
    }
    this.activeByRoot.clear();
  }

  private async reconcile(configRoots: readonly string[], epoch: number): Promise<void> {
    const registrations = await this.deps.resolveRegistrations(configRoots);
    if (!this.isCurrent(epoch)) {
      return;
    }
    const desiredByRoot = validateRegistrations(registrations);

    for (const [rootKey, active] of this.activeByRoot) {
      const desired = desiredByRoot.get(rootKey);
      if (
        !desired
        || desired.configurationId !== active.registration.configurationId
      ) {
        active.watcherRegistration.dispose();
        this.deps.registry.unregisterConfiguration(active.registration.configurationId);
        this.activeByRoot.delete(rootKey);
      }
    }

    for (const [rootKey, registration] of desiredByRoot) {
      const existing = this.activeByRoot.get(rootKey);
      this.deps.registry.registerConfiguration(registration);
      if (!existing) {
        let watcherRegistration: SupportWatcherDisposable | undefined;
        try {
          watcherRegistration = this.deps.watcher.register(
            registration.configRoot,
            registration.configurationId,
          );
          this.activeByRoot.set(rootKey, { registration, watcherRegistration });
        } catch (error) {
          watcherRegistration?.dispose();
          this.deps.registry.unregisterConfiguration(registration.configurationId);
          throw error;
        }
      } else if (!registrationsEqual(existing.registration, registration)) {
        this.activeByRoot.set(rootKey, {
          registration,
          watcherRegistration: existing.watcherRegistration,
        });
      }
    }

    for (const registration of desiredByRoot.values()) {
      await this.deps.loadRegistration(registration);
      if (!this.isCurrent(epoch)) {
        return;
      }
      this.deps.onDidLoad(registration);
    }
  }

  private isCurrent(epoch: number): boolean {
    return !this.disposed && this.epoch === epoch;
  }
}

function validateRegistrations(
  registrations: readonly SupportConfigurationRegistration[],
): ReadonlyMap<string, SupportConfigurationRegistration> {
  const byRoot = new Map<string, SupportConfigurationRegistration>();
  const rootByConfigurationId = new Map<ConfigurationId, string>();
  for (const registration of registrations) {
    const rootKey = normalizeRootKey(registration.configRoot);
    const rootOwner = byRoot.get(rootKey);
    if (rootOwner && rootOwner.configurationId !== registration.configurationId) {
      throw new Error('Support root resolution returned two identities for one root.');
    }
    const identityRoot = rootByConfigurationId.get(registration.configurationId);
    if (identityRoot !== undefined && identityRoot !== rootKey) {
      throw new Error('Support root resolution returned two roots for one identity.');
    }
    byRoot.set(rootKey, registration);
    rootByConfigurationId.set(registration.configurationId, rootKey);
  }
  return byRoot;
}

function registrationsEqual(
  left: SupportConfigurationRegistration,
  right: SupportConfigurationRegistration,
): boolean {
  return left.configurationId === right.configurationId
    && normalizeRootKey(left.configRoot) === normalizeRootKey(right.configRoot)
    && left.workspaceFolderName === right.workspaceFolderName
    && left.configRelativePath === right.configRelativePath;
}

function normalizeRootKey(configRoot: string): string {
  const resolved = path.resolve(configRoot);
  return process.platform === 'win32' ? resolved.toLocaleLowerCase() : resolved;
}
