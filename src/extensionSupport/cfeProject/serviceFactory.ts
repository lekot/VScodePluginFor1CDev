import * as path from 'path';
import { fileURLToPath } from 'url';
import type { WorkspaceRegistry } from '../../services/configurationSession/WorkspaceRegistry';
import type { ConfigurationId, ConfigurationIdentity } from '../../services/configurationSession/types';
import { CfeProjectService, type CfeProjectServiceOptions } from './createProject';
import { CfeProjectError } from './types';

/**
 * Creates the CFE application service for one exact configuration session.
 * UI and Agent adapters share this boundary so neither can guess a workspace.
 */
export class CfeProjectServiceFactory {
  constructor(
    private readonly workspaceRegistry: WorkspaceRegistry,
    private readonly options: Pick<CfeProjectServiceOptions, 'refreshWorkspace'> = {},
  ) {}

  forConfiguration(configurationId: ConfigurationId | string): CfeProjectService {
    const session = this.workspaceRegistry.require(configurationId);
    return new CfeProjectService(resolveWorkspaceRoot(session.identity), this.workspaceRegistry, this.options);
  }
}

function resolveWorkspaceRoot(identity: ConfigurationIdentity): string {
  const roots = [...new Set(identity.workspaceFolderUris.map(workspaceUriToPath))]
    .filter((workspaceRoot) => isPathInside(workspaceRoot, identity.rootPath));
  if (roots.length !== 1) {
    throw new CfeProjectError(
      'CFE_RELATION_AMBIGUOUS',
      roots.length === 0
        ? 'Конфигурация не принадлежит открытому workspace.'
        : 'Конфигурация принадлежит нескольким workspace. Уточните workspace.',
    );
  }
  return roots[0]!;
}

function workspaceUriToPath(uri: string): string {
  try {
    return path.resolve(fileURLToPath(uri));
  } catch {
    return path.resolve(uri);
  }
}

function isPathInside(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
