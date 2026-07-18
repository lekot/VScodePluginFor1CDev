import type { ConfigurationSession } from '../services/configurationSession/ConfigurationSession';
import {
  WorkspaceRegistry,
  WorkspaceRegistryError,
} from '../services/configurationSession/WorkspaceRegistry';
import type { ConfigurationIdentity } from '../services/configurationSession/types';

export interface AgentConfigurationSelector {
  readonly configurationId?: string;
}

export function resolveAgentConfiguration(
  registry: WorkspaceRegistry,
  selector: AgentConfigurationSelector,
  requiredCapability: keyof ConfigurationIdentity['capabilities'],
): ConfigurationSession {
  const session = selector.configurationId
    ? registry.require(selector.configurationId)
    : registry.resolveLegacyDefault(requiredCapability);
  if (!session.identity.capabilities[requiredCapability]) {
    throw new WorkspaceRegistryError(
      'CONFIGURATION_CAPABILITY_UNSUPPORTED',
      `Конфигурация ${session.identity.configurationId} не поддерживает ${requiredCapability}.`,
    );
  }
  return session;
}
