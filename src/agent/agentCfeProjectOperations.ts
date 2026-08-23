import * as path from 'path';
import type { WorkspaceRegistryError } from '../services/configurationSession/WorkspaceRegistry';
import { CfeProjectError, CfeProjectServiceFactory, type CfeCreateProjectRequest, type CfeProjectContext } from '../extensionSupport/cfeProject';
import type { AgentResult, ConfigurationScopedParams } from './types';

export const AGENT_CFE_COMMAND_IDS = {
  listProjects: '1c-metadata-tree.agent.cfe.listProjects',
  getContext: '1c-metadata-tree.agent.cfe.getContext',
  validate: '1c-metadata-tree.agent.cfe.validate',
  createProject: '1c-metadata-tree.agent.cfe.createProject',
} as const;

export type AgentCfeListProjectsParams = ConfigurationScopedParams;
export type AgentCfeGetContextParams = Required<Pick<ConfigurationScopedParams, 'configurationId'>>;
export type AgentCfeValidateParams = ConfigurationScopedParams;
export interface AgentCfeCreateProjectParams extends CfeCreateProjectRequest {}

/** JSON-safe public representation. ConfigurationSession never crosses the Agent boundary. */
export interface AgentCfeProjectDto {
  readonly baseConfigurationId: string;
  readonly extensionConfigurationId: string;
  readonly extensionName: string;
  readonly purpose: string;
  readonly namePrefix: string;
  readonly formatVersion: string;
  readonly compatibilityMode: string;
  readonly baseConfigurationUuid: string;
  readonly baseFingerprint: string;
}

export interface AgentCfeCreateProjectOutcome {
  readonly status: 'created' | 'outcome-unknown';
  readonly code?: 'CFE_OUTCOME_UNKNOWN';
  readonly recoveryJournalPath?: string;
  readonly context?: AgentCfeProjectDto;
}

export class AgentCfeProjectOperations {
  constructor(
    private readonly getRegistry: () => Promise<import('../services/configurationSession/WorkspaceRegistry').WorkspaceRegistry | null>,
    private readonly refreshWorkspace: () => Promise<void>,
  ) {}

  async listProjects(params: AgentCfeListProjectsParams = {}): Promise<AgentResult<{ projects: readonly AgentCfeProjectDto[] }>> {
    return this.run(params.configurationId, async (service) => ({ projects: (await service.listProjects()).map(toDto) }));
  }

  async getContext(params: AgentCfeGetContextParams): Promise<AgentResult<AgentCfeProjectDto>> {
    return this.run(params.configurationId, async (service) => {
      try {
        return toDto(await service.getContext(params.configurationId));
      } catch (error) {
        if (!(error instanceof CfeProjectError) || error.code !== 'CFE_PROJECT_NOT_FOUND') {
          throw error;
        }
        return toDto(await service.getContextByExtension(params.configurationId));
      }
    });
  }

  async validate(params: AgentCfeValidateParams = {}): Promise<AgentResult<{ valid: true }>> {
    return this.run(params.configurationId, async (service) => {
      await service.validate();
      return { valid: true };
    });
  }

  async createProject(params: AgentCfeCreateProjectParams): Promise<AgentResult<AgentCfeCreateProjectOutcome>> {
    return this.run(params.baseConfigurationId, async (service) => {
      const outcome = await service.createProject(params);
      return {
        status: outcome.status,
        ...(outcome.code ? { code: outcome.code } : {}),
        ...(outcome.recoveryJournalPath
          ? { recoveryJournalPath: toWorkspaceRelativePath(service.workspaceRoot, outcome.recoveryJournalPath) }
          : {}),
        ...(outcome.context ? { context: toDto(outcome.context) } : {}),
      };
    }, 'write');
  }

  private async run<T>(
    configurationId: string | undefined,
    operation: (service: import('../extensionSupport/cfeProject').CfeProjectService) => Promise<T>,
    requiredCapability: 'read' | 'write' = 'read',
  ): Promise<AgentResult<T>> {
    try {
      const registry = await this.getRegistry();
      if (!registry) {
        throw new Error('Корень конфигурации не найден.');
      }
      const session = configurationId
        ? registry.require(configurationId)
        : registry.resolveLegacyDefault(requiredCapability);
      if (!session.identity.capabilities[requiredCapability]) {
        throw new Error(`Конфигурация ${session.identity.configurationId} не поддерживает ${requiredCapability}.`);
      }
      const service = new CfeProjectServiceFactory(registry, { refreshWorkspace: this.refreshWorkspace })
        .forConfiguration(session.identity.configurationId);
      return { success: true, data: await operation(service), configurationId: session.identity.configurationId };
    } catch (error) {
      return {
        success: false,
        code: error instanceof CfeProjectError || isRegistryError(error) ? error.code : 'CFE_OPERATION_FAILED',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

/** Never expose an absolute workspace path through the Agent/MCP boundary. */
function toWorkspaceRelativePath(workspaceRoot: string, targetPath: string): string {
  const relative = path.relative(workspaceRoot, targetPath).replace(/\\/g, '/');
  return relative && !relative.startsWith('../') && relative !== '..' && !path.isAbsolute(relative)
    ? relative
    : '.vscode/cfe-project-recovery.json';
}

function toDto(context: CfeProjectContext): AgentCfeProjectDto {
  return {
    baseConfigurationId: context.baseSession.identity.configurationId,
    extensionConfigurationId: context.extensionSession.identity.configurationId,
    extensionName: context.extensionName,
    purpose: context.purpose,
    namePrefix: context.namePrefix,
    formatVersion: context.formatVersion,
    compatibilityMode: context.compatibilityMode,
    baseConfigurationUuid: context.baseConfigurationUuid,
    baseFingerprint: context.baseFingerprint,
  };
}

function isRegistryError(error: unknown): error is WorkspaceRegistryError {
  return Boolean(error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    && error.constructor?.name === 'WorkspaceRegistryError');
}
