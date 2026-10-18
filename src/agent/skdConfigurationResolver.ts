import * as path from 'path';
import { resolveAgentConfiguration } from './agentConfigurationResolver';
import type { ConfigurationSession } from '../services/configurationSession/ConfigurationSession';
import type { ConfigurationIdentity } from '../services/configurationSession/types';
import { WorkspaceRegistry, WorkspaceRegistryError } from '../services/configurationSession/WorkspaceRegistry';
import type { ConfigurationScopedParams } from './types';

type SkdSelectionParams = ConfigurationScopedParams & {
  configPath?: string;
  templatePath?: string;
  outputPath?: string;
  definitionFile?: string;
  outFile?: string;
  value?: string;
};

/** Resolves SKD's owning configuration without interpreting relative paths against process cwd. */
export async function resolveSkdConfiguration(
  registry: WorkspaceRegistry,
  params: ConfigurationScopedParams,
  capability: keyof ConfigurationIdentity['capabilities'],
) {
  const skd = params as SkdSelectionParams;
  if (!isSkdSelection(skd)) { return undefined; }

  let session: ConfigurationSession;
  if (skd.configurationId) {
    session = resolveAgentConfiguration(registry, skd, capability);
  } else if (skd.configPath) {
    session = await registry.resolveResource(skd.configPath);
  } else {
    const absolutePath = [skd.outputPath, skd.templatePath, skd.definitionFile, skd.outFile]
      .find((value): value is string => typeof value === 'string' && path.isAbsolute(value.trim()));
    session = absolutePath
      ? await registry.resolveResource(absolutePath)
      : registry.resolveLegacyDefault(capability);
  }

  if (!session.identity.capabilities[capability]) {
    throw new WorkspaceRegistryError(
      'CONFIGURATION_CAPABILITY_UNSUPPORTED',
      `Конфигурация ${session.identity.configurationId} не поддерживает ${capability}.`,
    );
  }
  return session;
}

function isSkdSelection(params: SkdSelectionParams): boolean {
  return typeof params.templatePath === 'string'
    || typeof params.outputPath === 'string'
      && (typeof params.definitionFile === 'string' || typeof params.value === 'string');
}
