import { FormatDetector } from '../../parsers/formatDetector';
import type { ConfigurationSession } from './ConfigurationSession';
import { WorkspaceRegistry, WorkspaceRegistryError } from './WorkspaceRegistry';
import type { DiscoveredConfiguration } from './WorkspaceRegistry';

export interface WorkspaceRegistryCoordinatorDeps {
  readonly getWorkspaceFolders: () => string[];
  readonly getWorkspaceFolderForPath?: (filePath: string) => string | undefined;
  readonly findAllConfigurationRoots?: (
    folders: string[]
  ) => Promise<Array<{ configPath: string; workspaceFolderPath: string }>>;
  readonly detectFormat?: (configPath: string) => Promise<import('../../parsers/formatDetector').ConfigFormat>;
  readonly findConfigurationRoot?: (candidatePath: string) => Promise<string | null>;
}

export class WorkspaceRegistryCoordinator {
  private isInitialized = false;
  private refreshTail: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly registry: WorkspaceRegistry,
    private readonly deps: WorkspaceRegistryCoordinatorDeps,
  ) {}

  /**
   * Returns the WorkspaceRegistry after guaranteeing initial discovery has completed.
   * If already initialized, returns immediately without re-scanning the workspace.
   */
  async getRegistry(): Promise<WorkspaceRegistry> {
    this.ensureActive();
    if (!this.isInitialized) {
      await this.ensureInitialized();
    }
    return this.registry;
  }

  /**
   * Ensures the initial workspace discovery has run once.
   * Concurrent callers share the same in-flight discovery promise.
   */
  async ensureInitialized(): Promise<void> {
    this.ensureActive();
    if (this.isInitialized) {
      return;
    }
    const runInitial = async () => {
      if (this.isInitialized) {
        return;
      }
      await this.performWorkspaceScan();
      this.isInitialized = true;
    };
    const current = this.refreshTail.then(runInitial, runInitial);
    this.refreshTail = current.then(() => undefined, () => undefined);
    await current;
  }

  /**
   * Explicitly triggers a full workspace scan and reconciles the WorkspaceRegistry.
   * Serialized so concurrent refreshes execute cleanly.
   */
  async refreshWorkspace(): Promise<void> {
    this.ensureActive();
    const runRefresh = async () => {
      await this.performWorkspaceScan();
      this.isInitialized = true;
    };
    const current = this.refreshTail.then(runRefresh, runRefresh);
    this.refreshTail = current.then(() => undefined, () => undefined);
    await current;
  }

  /**
   * Resolves a ConfigurationSession for the target resource.
   * 1. Attempts to resolve from known registry sessions (O(1) memory lookup + fast stat check).
   * 2. If not found, performs targeted discovery on the resource path. If a configuration root is found,
   *    registers that targeted root into the registry without a full workspace scan.
   * 3. Fails closed with CONFIGURATION_NOT_FOUND if the target does not belong to any valid configuration.
   */
  async resolveResource(resource: string): Promise<ConfigurationSession> {
    this.ensureActive();
    await this.ensureInitialized();

    try {
      return await this.registry.resolveResource(resource);
    } catch (error) {
      if (!(error instanceof WorkspaceRegistryError && error.code === 'CONFIGURATION_NOT_FOUND')) {
        throw error;
      }
    }

    // Targeted fallback: check if resource itself or its ancestor is a configuration root
    const finder = this.deps.findConfigurationRoot ?? ((p: string) => FormatDetector.findConfigurationRoot(p));
    const candidateRoot = await finder(resource);
    if (!candidateRoot) {
      throw new WorkspaceRegistryError(
        'CONFIGURATION_NOT_FOUND',
        `Ресурс не принадлежит конфигурации: ${resource}`,
      );
    }

    const detector = this.deps.detectFormat ?? ((p: string) => FormatDetector.detect(p));
    const format = await detector(candidateRoot);
    const workspaceFolder = this.deps.getWorkspaceFolderForPath?.(candidateRoot)
      ?? this.deps.getWorkspaceFolders().find((wf) => candidateRoot.startsWith(wf));

    await this.registry.registerTargetedRoot({
      configPath: candidateRoot,
      workspaceFolderPath: workspaceFolder,
      format,
    });

    return this.registry.resolveResource(resource);
  }

  /**
   * Registers a single configuration root directly into the registry.
   */
  async registerTargetedRoot(candidate: DiscoveredConfiguration): Promise<ConfigurationSession> {
    this.ensureActive();
    return this.registry.registerTargetedRoot(candidate);
  }

  /**
   * Unregisters a single configuration root from the registry.
   */
  async unregisterTargetedRoot(configPath: string): Promise<void> {
    this.ensureActive();
    return this.registry.unregisterTargetedRoot(configPath);
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    await this.registry.dispose();
  }

  private ensureActive(): void {
    if (this.disposed) {
      throw new WorkspaceRegistryError('REGISTRY_DISPOSED', 'Coordinator конфигураций уже закрыт.');
    }
  }

  private async performWorkspaceScan(): Promise<void> {
    const folders = this.deps.getWorkspaceFolders();
    const scanner = this.deps.findAllConfigurationRoots
      ?? ((f: string[]) => FormatDetector.findAllConfigurationRoots(f));
    const detector = this.deps.detectFormat ?? ((p: string) => FormatDetector.detect(p));

    const configs = await scanner(folders);
    const discovered = await Promise.all(
      configs.map(async (config) => ({
        ...config,
        format: await detector(config.configPath),
      })),
    );
    await this.registry.refresh(discovered);
  }
}
