import * as path from 'path';
import type { ConfigurationId } from '../services/configurationSession/types';
import type { CachedSupportStatus, SupportStateCache } from './supportStateCache';

export const SUPPORT_MASTER_WATCH_GLOB = '**/Ext/ParentConfigurations.bin';

export interface SupportWatcherDisposable {
  dispose(): void;
}

export interface SupportWatcherUri {
  readonly fsPath: string;
}

export interface SupportFileSystemWatcher {
  onDidCreate(listener: (uri: SupportWatcherUri) => void): SupportWatcherDisposable;
  onDidChange(listener: (uri: SupportWatcherUri) => void): SupportWatcherDisposable;
  onDidDelete(listener: (uri: SupportWatcherUri) => void): SupportWatcherDisposable;
  dispose(): void;
}

export interface SupportFileSystemWatcherFactory {
  createFileSystemWatcher(globPattern: typeof SUPPORT_MASTER_WATCH_GLOB): SupportFileSystemWatcher;
}

export interface SupportStateWatcherCallbacks {
  /** Called only for the affected registered root, after its support state was reloaded. */
  readonly onDidReload: (configRoot: string, status: CachedSupportStatus) => void | Promise<void>;
  readonly onReloadError?: (configRoot: string, error: unknown) => void | Promise<void>;
}

interface RegisteredRoot {
  readonly configRoot: string;
  readonly configurationId: ConfigurationId;
  registrations: number;
}

/**
 * Watches only the support master file. It never invokes metadata parsing or metadata lifecycle
 * reload; consumers receive a targeted root callback after the support-only cache refresh.
 */
export class SupportStateWatcher implements SupportWatcherDisposable {
  private readonly watcher: SupportFileSystemWatcher;
  private readonly subscriptions: SupportWatcherDisposable[];
  private readonly roots = new Map<string, RegisteredRoot>();
  private readonly eventVersions = new Map<string, number>();
  private readonly refreshTails = new Map<string, Promise<void>>();
  private disposed = false;

  constructor(
    factory: SupportFileSystemWatcherFactory,
    private readonly cache: SupportStateCache,
    private readonly callbacks: SupportStateWatcherCallbacks,
  ) {
    this.watcher = factory.createFileSystemWatcher(SUPPORT_MASTER_WATCH_GLOB);
    const accept = (uri: SupportWatcherUri): void => { this.accept(uri); };
    this.subscriptions = [
      this.watcher.onDidCreate(accept),
      this.watcher.onDidChange(accept),
      this.watcher.onDidDelete(accept),
    ];
  }

  register(configRoot: string, configurationId: ConfigurationId): SupportWatcherDisposable {
    if (this.disposed) {
      throw new Error('Cannot register a configuration root on a disposed support watcher.');
    }
    const resolvedRoot = path.resolve(configRoot);
    const rootKey = normalizePath(resolvedRoot);
    const existing = this.roots.get(rootKey);
    if (existing && existing.configurationId !== configurationId) {
      throw new Error('A configuration root cannot be registered with two identities.');
    }
    if (existing) {
      existing.registrations += 1;
    } else {
      this.roots.set(rootKey, { configRoot: resolvedRoot, configurationId, registrations: 1 });
      this.cache.register(resolvedRoot, configurationId);
    }
    let active = true;
    return {
      dispose: () => {
        if (!active) {
          return;
        }
        active = false;
        this.unregister(rootKey);
      },
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.watcher.dispose();
    for (const root of this.roots.values()) {
      this.cache.unregister(root.configRoot);
    }
    this.roots.clear();
    this.eventVersions.clear();
  }

  private accept(uri: SupportWatcherUri): void {
    if (this.disposed) {
      return;
    }
    const root = this.resolveRegisteredRoot(uri.fsPath);
    if (!root) {
      return;
    }
    const rootKey = normalizePath(root.configRoot);
    const eventVersion = (this.eventVersions.get(rootKey) ?? 0) + 1;
    this.eventVersions.set(rootKey, eventVersion);
    this.cache.invalidate(root.configRoot);

    const predecessor = this.refreshTails.get(rootKey) ?? Promise.resolve();
    const refresh = predecessor
      .catch(() => undefined)
      .then(() => this.reload(rootKey, root, eventVersion))
      .catch(() => undefined);
    this.refreshTails.set(rootKey, refresh);
    void refresh.finally(() => {
      if (this.refreshTails.get(rootKey) === refresh) {
        this.refreshTails.delete(rootKey);
      }
    });
  }

  private async reload(
    rootKey: string,
    registered: RegisteredRoot,
    eventVersion: number,
  ): Promise<void> {
    try {
      const status = await this.cache.load(registered.configRoot);
      if (this.isCurrent(rootKey, registered, eventVersion)) {
        await this.callbacks.onDidReload(registered.configRoot, status);
      }
    } catch (error) {
      if (this.isCurrent(rootKey, registered, eventVersion)) {
        await this.callbacks.onReloadError?.(registered.configRoot, error);
      }
    }
  }

  private isCurrent(
    rootKey: string,
    registered: RegisteredRoot,
    eventVersion: number,
  ): boolean {
    return !this.disposed
      && this.roots.get(rootKey) === registered
      && this.eventVersions.get(rootKey) === eventVersion;
  }

  private resolveRegisteredRoot(filePath: string): RegisteredRoot | undefined {
    const normalizedFile = normalizePath(filePath);
    for (const root of this.roots.values()) {
      const expected = normalizePath(path.join(root.configRoot, 'Ext', 'ParentConfigurations.bin'));
      if (normalizedFile === expected) {
        return root;
      }
    }
    return undefined;
  }

  private unregister(rootKey: string): void {
    const registered = this.roots.get(rootKey);
    if (!registered) {
      return;
    }
    registered.registrations -= 1;
    if (registered.registrations > 0) {
      return;
    }
    this.roots.delete(rootKey);
    this.eventVersions.set(rootKey, (this.eventVersions.get(rootKey) ?? 0) + 1);
    this.cache.unregister(registered.configRoot);
  }
}

function normalizePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLocaleLowerCase() : resolved;
}
