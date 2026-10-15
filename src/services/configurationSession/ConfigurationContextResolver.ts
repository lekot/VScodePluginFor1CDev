import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import type { ConfigurationSession } from './ConfigurationSession';
import {
  WorkspaceRegistry,
  WorkspaceRegistryError,
} from './WorkspaceRegistry';
import { WorkspaceRegistryCoordinator } from './WorkspaceRegistryCoordinator';
import type {
  ConfigurationCapabilities,
  ConfigurationContext,
  ConfigurationId,
} from './types';

export type ResourceLike =
  | string
  | { readonly fsPath: string }
  | { readonly path: string }
  | { toString(): string };

export interface TreeNodeLike {
  readonly id?: string;
  readonly name?: string;
  readonly type?: string;
  readonly configurationId?: ConfigurationId;
  readonly parent?: TreeNodeLike;
  readonly properties?: Record<string, unknown>;
  readonly filePath?: string;
  readonly parentFilePath?: string;
}

export type RegistrySource =
  | WorkspaceRegistry
  | WorkspaceRegistryCoordinator
  | (() =>
      | WorkspaceRegistry
      | WorkspaceRegistryCoordinator
      | Promise<WorkspaceRegistry | WorkspaceRegistryCoordinator>);

export interface ConfigurationContextResolverDeps {
  readonly getWorkspaceFolderForPath?: (filePath: string) => string | undefined;
}

/**
 * Boundary resolver that translates heterogeneous application targets
 * (TreeNode, resource paths/URIs, agent configuration IDs, default context)
 * into immutable typed ConfigurationContext snapshots.
 */
export class ConfigurationContextResolver {
  constructor(
    private readonly source: RegistrySource,
    private readonly deps?: ConfigurationContextResolverDeps,
  ) {}

  /**
   * Resolves a ConfigurationContext from a file path, file:// URI, or VS Code Uri-like object.
   * Resolves to the deepest canonical owning configuration for nested roots.
   * Fails closed with CONFIGURATION_NOT_FOUND for non-configuration resources.
   */
  async resolveFromResource(
    resource: ResourceLike,
    requiredCapability?: keyof ConfigurationCapabilities,
  ): Promise<ConfigurationContext> {
    const rawTarget = normalizeResourceTarget(resource);
    if (!rawTarget) {
      throw new WorkspaceRegistryError('CONFIGURATION_NOT_FOUND', 'Ресурс не указан.');
    }

    const session = await this.resolveSessionForResource(rawTarget);
    this.assertCapability(session, requiredCapability);
    return toConfigurationContext(session, rawTarget, this.deps?.getWorkspaceFolderForPath);
  }

  /**
   * Resolves a ConfigurationContext from a TreeNode by inspecting filePath, parentFilePath,
   * or traversing parent hierarchy.
   */
  async resolveFromTreeNode(
    node: TreeNodeLike,
    requiredCapability?: keyof ConfigurationCapabilities,
  ): Promise<ConfigurationContext> {
    let current: TreeNodeLike | undefined = node;
    let candidatePath: string | undefined;
    let candidateConfigId: string | undefined;

    while (current) {
      if (typeof current.configurationId === 'string' && current.configurationId.length > 0) {
        candidateConfigId = current.configurationId;
        break;
      }
      if (typeof current.properties?.configurationId === 'string' && current.properties.configurationId.length > 0) {
        candidateConfigId = current.properties.configurationId;
        break;
      }
      if (current.filePath && typeof current.filePath === 'string' && current.filePath.trim().length > 0) {
        candidatePath = current.filePath.trim();
        break;
      }
      if (current.parentFilePath && typeof current.parentFilePath === 'string' && current.parentFilePath.trim().length > 0) {
        candidatePath = current.parentFilePath.trim();
        break;
      }
      if (typeof current.properties?.configPath === 'string' && current.properties.configPath.trim().length > 0) {
        candidatePath = current.properties.configPath.trim();
        break;
      }
      current = current.parent;
    }

    if (candidateConfigId) {
      return this.resolveFromConfigurationId(candidateConfigId, requiredCapability);
    }

    if (candidatePath) {
      return this.resolveFromResource(candidatePath, requiredCapability);
    }

    throw new WorkspaceRegistryError(
      'CONFIGURATION_NOT_FOUND',
      `Не удалось определить конфигурацию для узла дерева: ${node.name ?? node.id ?? 'unknown'}`,
    );
  }

  /**
   * Resolves a ConfigurationContext directly by stable ConfigurationId.
   */
  async resolveFromConfigurationId(
    configurationId: ConfigurationId | string,
    requiredCapability?: keyof ConfigurationCapabilities,
  ): Promise<ConfigurationContext> {
    const registry = await this.getRegistry();
    const session = registry.require(configurationId);
    this.assertCapability(session, requiredCapability);
    return toConfigurationContext(session, undefined, this.deps?.getWorkspaceFolderForPath);
  }

  /**
   * Resolves the default workspace configuration satisfying the specified capability.
   * Throws CONFIGURATION_SELECTION_REQUIRED if multiple configurations match.
   */
  async resolveDefault(
    requiredCapability: keyof ConfigurationCapabilities = 'read',
  ): Promise<ConfigurationContext> {
    const registry = await this.getRegistry();
    const session = registry.resolveLegacyDefault(requiredCapability);
    this.assertCapability(session, requiredCapability);
    return toConfigurationContext(session, undefined, this.deps?.getWorkspaceFolderForPath);
  }

  /**
   * Lists ConfigurationContext snapshots for all currently active registered configurations.
   */
  async list(): Promise<ConfigurationContext[]> {
    const registry = await this.getRegistry();
    const descriptors = registry.list();
    return descriptors.map((desc) => {
      const session = registry.require(desc.configurationId);
      return toConfigurationContext(session, undefined, this.deps?.getWorkspaceFolderForPath);
    });
  }

  /**
   * Checks whether a configuration ID is currently registered.
   */
  async has(configurationId: ConfigurationId | string): Promise<boolean> {
    const registry = await this.getRegistry();
    return registry.has(configurationId);
  }

  private async getRegistry(): Promise<WorkspaceRegistry> {
    const resolved = typeof this.source === 'function' ? await this.source() : this.source;
    if (resolved instanceof WorkspaceRegistryCoordinator) {
      return resolved.getRegistry();
    }
    return resolved;
  }

  private async resolveSessionForResource(rawTarget: string): Promise<ConfigurationSession> {
    const resolved = typeof this.source === 'function' ? await this.source() : this.source;
    if (resolved instanceof WorkspaceRegistryCoordinator) {
      return resolved.resolveResource(rawTarget);
    }
    return resolved.resolveResource(rawTarget);
  }

  private assertCapability(
    session: ConfigurationSession,
    requiredCapability?: keyof ConfigurationCapabilities,
  ): void {
    if (requiredCapability && !session.identity.capabilities[requiredCapability]) {
      throw new WorkspaceRegistryError(
        'CONFIGURATION_CAPABILITY_UNSUPPORTED',
        `Конфигурация ${session.identity.configurationId} не поддерживает ${requiredCapability}.`,
      );
    }
  }
}

function toConfigurationContext(
  session: ConfigurationSession,
  resourceTarget?: string,
  getWorkspaceFolderForPath?: (filePath: string) => string | undefined,
): ConfigurationContext {
  const identity = session.identity;
  let workspaceFolderUri: string | undefined;

  if (resourceTarget && getWorkspaceFolderForPath) {
    try {
      const raw = resourceTarget.startsWith('file:') ? fileURLToPath(resourceTarget) : resourceTarget;
      const wf = getWorkspaceFolderForPath(raw);
      if (wf) {
        workspaceFolderUri = pathToFileURL(path.resolve(wf)).toString();
      }
    } catch {
      // Fallback to identity workspace folders
    }
  }

  if (!workspaceFolderUri && identity.workspaceFolderUris.length > 0) {
    workspaceFolderUri = identity.workspaceFolderUris[0];
  }

  if (!workspaceFolderUri) {
    workspaceFolderUri = identity.rootUri;
  }

  const context: ConfigurationContext = {
    configurationId: identity.configurationId,
    rootPath: identity.rootPath,
    rootUri: identity.rootUri,
    workspaceFolderUri,
    format: identity.format,
    capabilities: Object.freeze({ ...identity.capabilities }),
    descriptorUri: identity.descriptorUri,
    descriptorUuid: identity.descriptorUuid,
    session,
  };

  return Object.freeze(context);
}

function normalizeResourceTarget(resource: ResourceLike): string {
  if (typeof resource === 'string') {
    return resource.trim();
  }
  if (resource && typeof resource === 'object') {
    if ('fsPath' in resource && typeof (resource as { fsPath: unknown }).fsPath === 'string') {
      return (resource as { fsPath: string }).fsPath.trim();
    }
    if ('path' in resource && typeof (resource as { path: unknown }).path === 'string') {
      return (resource as { path: string }).path.trim();
    }
    if (typeof resource.toString === 'function') {
      return resource.toString().trim();
    }
  }
  throw new WorkspaceRegistryError(
    'CONFIGURATION_NOT_FOUND',
    `Некорректный ресурс: ${String(resource)}`,
  );
}
