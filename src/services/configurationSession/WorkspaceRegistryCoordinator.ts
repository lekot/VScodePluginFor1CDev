import * as fs from 'fs';
import * as path from 'path';
import { FormatDetector } from '../../parsers/formatDetector';
import type { ConfigurationSession } from './ConfigurationSession';
import { WorkspaceRegistry, WorkspaceRegistryError } from './WorkspaceRegistry';
import type { DiscoveredConfiguration } from './WorkspaceRegistry';
import { awaitAllDrains } from './awaitAllDrains';

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
  private accepting = true;
  private disposed = false;
  private quiescePromise: Promise<void> | null = null;
  private disposePromise: Promise<void> | null = null;

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
      this.ensureAccepting();
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
    this.ensureAccepting();
    const runInitial = async () => {
      if (this.isInitialized) {
        return;
      }
      this.ensureAccepting();
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
    this.ensureAccepting();
    const runRefresh = async () => {
      this.ensureAccepting();
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
    if (!this.isInitialized) {
      this.ensureAccepting();
      await this.ensureInitialized();
    }

    try {
      return await this.registry.resolveResource(resource);
    } catch (error) {
      if (!(error instanceof WorkspaceRegistryError && error.code === 'CONFIGURATION_NOT_FOUND')) {
        throw error;
      }
    }
    this.ensureAccepting();

    // Targeted fallback: check if resource itself or its ancestor is a configuration root
    const finder = this.deps.findConfigurationRoot ?? ((p: string) => FormatDetector.findConfigurationRoot(p));
    const candidateRoot = await finder(resource);
    this.ensureAccepting();
    if (!candidateRoot) {
      throw new WorkspaceRegistryError(
        'CONFIGURATION_NOT_FOUND',
        `Ресурс не принадлежит конфигурации: ${resource}`,
      );
    }

    const detector = this.deps.detectFormat ?? ((p: string) => FormatDetector.detect(p));
    const format = await detector(candidateRoot);
    this.ensureAccepting();
    const workspaceFolders = this.deps.getWorkspaceFolders();
    const workspaceFolder = await this.findContainingWorkspaceFolder(candidateRoot, workspaceFolders);
    this.ensureAccepting();
    if (!workspaceFolder) {
      throw new WorkspaceRegistryError(
        'CONFIGURATION_NOT_FOUND',
        `Конфигурация находится вне открытого workspace: ${candidateRoot}`,
      );
    }

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
    this.ensureAccepting();
    const workspaceFolders = this.deps.getWorkspaceFolders();
    const workspaceFolder = await this.findContainingWorkspaceFolder(candidate.configPath, workspaceFolders);
    this.ensureAccepting();
    if (!workspaceFolder) {
      throw new WorkspaceRegistryError(
        'CONFIGURATION_NOT_FOUND',
        `Конфигурация находится вне открытого workspace: ${candidate.configPath}`,
      );
    }
    const passedWf = candidate.workspaceFolderPath;
    if (passedWf) {
      const canonicalPassed = await fs.promises.realpath(path.resolve(passedWf)).catch(() => path.resolve(passedWf));
      if (!isSamePath(canonicalPassed, workspaceFolder)) {
        throw new WorkspaceRegistryError(
          'CONFIGURATION_NOT_FOUND',
          `Указанная папка workspace не соответствует расположению конфигурации: ${passedWf}`,
        );
      }
    }
    return this.registry.registerTargetedRoot({
      ...candidate,
      workspaceFolderPath: workspaceFolder,
    });
  }

  /**
   * Unregisters a single configuration root from the registry.
   */
  async unregisterTargetedRoot(configPath: string): Promise<void> {
    this.ensureAccepting();
    return this.registry.unregisterTargetedRoot(configPath);
  }

  quiesce(): Promise<void> {
    if (this.quiescePromise) {
      return this.quiescePromise;
    }
    this.accepting = false;
    // Close registry and session admission synchronously. An in-flight scan can no longer
    // publish fresh sessions; its tail is drained before the session drain is considered done.
    const registryDrain = this.registry.quiesce();
    const refreshDrain = this.refreshTail;
    this.quiescePromise = awaitAllDrains('Workspace registry coordinator quiescence', [registryDrain, refreshDrain]);
    return this.quiescePromise;
  }

  dispose(): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise;
    }
    const quiescence = this.quiesce();
    this.disposePromise = Promise.resolve().then(async () => {
      let disposeError: unknown;
      let disposeFailed = false;
      try {
        await quiescence;
      } catch (error) {
        disposeFailed = true;
        disposeError = error;
      }
      this.disposed = true;
      try {
        await this.registry.dispose();
      } catch (error) {
        if (!disposeFailed) {
          disposeFailed = true;
          disposeError = error;
        }
      }
      if (disposeFailed) {
        throw disposeError;
      }
    });
    return this.disposePromise;
  }

  private ensureActive(): void {
    if (this.disposed) {
      throw new WorkspaceRegistryError('REGISTRY_DISPOSED', 'Coordinator конфигураций уже закрыт.');
    }
  }

  private ensureAccepting(): void {
    this.ensureActive();
    if (!this.accepting) {
      throw new WorkspaceRegistryError('REGISTRY_DISPOSED', 'Coordinator конфигураций уже закрыт для новых операций.');
    }
  }

  private async findContainingWorkspaceFolder(
    candidateRoot: string,
    workspaceFolders: readonly string[],
  ): Promise<string | undefined> {
    const canonicalCandidate = await fs.promises.realpath(path.resolve(candidateRoot)).catch(() => path.resolve(candidateRoot));

    const fromDep = this.deps.getWorkspaceFolderForPath?.(canonicalCandidate)
      ?? this.deps.getWorkspaceFolderForPath?.(candidateRoot);
    if (fromDep) {
      const canonicalFromDep = await fs.promises.realpath(path.resolve(fromDep)).catch(() => path.resolve(fromDep));
      let isKnownWf = false;
      for (const wf of workspaceFolders) {
        const canonicalWf = await fs.promises.realpath(path.resolve(wf)).catch(() => path.resolve(wf));
        if (isSamePath(canonicalWf, canonicalFromDep)) {
          isKnownWf = true;
          break;
        }
      }
      if (isKnownWf && isCanonicalPathInside(canonicalFromDep, canonicalCandidate)) {
        return canonicalFromDep;
      }
    }

    for (const wf of workspaceFolders) {
      const canonicalWf = await fs.promises.realpath(path.resolve(wf)).catch(() => path.resolve(wf));
      if (isCanonicalPathInside(canonicalWf, canonicalCandidate)) {
        return canonicalWf;
      }
    }

    return undefined;
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

function isCanonicalPathInside(parent: string, child: string): boolean {
  const normParent = process.platform === 'win32' ? parent.toLowerCase() : parent;
  const normChild = process.platform === 'win32' ? child.toLowerCase() : child;
  const rel = path.relative(normParent, normChild);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function isSamePath(a: string, b: string): boolean {
  const normA = process.platform === 'win32' ? a.toLowerCase() : a;
  const normB = process.platform === 'win32' ? b.toLowerCase() : b;
  return normA === normB;
}
