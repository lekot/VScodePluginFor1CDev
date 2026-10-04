import { z } from 'zod';
import type { McpToolDefinition } from './types';
import { READ_CLOSED, WRITE_OPEN } from './types';
import { rootObjectPath, trimmedNonEmptyString } from './schemas';

const configuration = { configurationId: trimmedNonEmptyString } as const;
const optionalBoolean = z.boolean().optional();

const repositoryTool = (
  name: string,
  suffix: string,
  description: string,
  inputSchema: z.ZodType<Record<string, unknown>>,
  annotations: McpToolDefinition['annotations'] = WRITE_OPEN,
): McpToolDefinition => ({
  name,
  description,
  command: `1c-metadata-tree.agent.repository.${suffix}`,
  inputSchema,
  annotations,
});

export const REPOSITORY_TOOLS: readonly McpToolDefinition[] = [
  repositoryTool('cdt_repository_connect', 'connect', 'Bind one selected configuration to a configuration repository using an explicit local file infobase.', z.strictObject({
    ...configuration,
    executionInfobaseId: trimmedNonEmptyString,
    repositoryPath: trimmedNonEmptyString,
    repositoryUser: trimmedNonEmptyString,
    repositoryPassword: z.string().optional(),
    background: z.boolean().default(true),
  })),
  repositoryTool('cdt_repository_disconnect', 'disconnect', 'Disconnect the selected configuration from its configuration repository.', z.strictObject({
    ...configuration,
    force: optionalBoolean,
    background: z.boolean().default(true),
  })),
  repositoryTool('cdt_repository_lock', 'lock', 'Lock one root metadata object in the configuration repository.', z.strictObject({
    ...configuration,
    path: rootObjectPath,
    recursive: optionalBoolean,
    revised: optionalBoolean,
    background: z.boolean().default(true),
  })),
  repositoryTool('cdt_repository_unlock', 'unlock', 'Unlock one root metadata object in the configuration repository.', z.strictObject({
    ...configuration,
    path: rootObjectPath,
    recursive: optionalBoolean,
    force: optionalBoolean,
    background: z.boolean().default(true),
  })),
  repositoryTool('cdt_repository_commit', 'commit', 'Commit one root metadata object to the configuration repository with a required nonblank comment.', z.strictObject({
    ...configuration,
    path: rootObjectPath,
    comment: z.string().trim().min(1),
    recursive: optionalBoolean,
    keepLocked: optionalBoolean,
    force: optionalBoolean,
    background: z.boolean().default(true),
  })),
  repositoryTool('cdt_repository_update_object', 'updateObject', 'Update one root metadata object from the configuration repository.', z.strictObject({
    ...configuration,
    path: rootObjectPath,
    recursive: optionalBoolean,
    force: optionalBoolean,
    background: z.boolean().default(true),
  })),
  repositoryTool('cdt_repository_update_configuration', 'updateConfiguration', 'Update a complete configuration from the configuration repository.', z.strictObject({
    ...configuration,
    force: optionalBoolean,
    background: z.boolean().default(true),
  })),
  repositoryTool('cdt_repository_get_status', 'getStatus', 'Read the last observed local repository binding and state; this does not query the live repository.', z.strictObject({
    ...configuration,
  }), READ_CLOSED),
] as const;
