import { z } from 'zod';
import type { McpToolDefinition } from './types';
import { READ_CLOSED, WRITE_CLOSED, WRITE_CLOSED_IDEMPOTENT } from './types';
import {
  cfeCompatibilityMode,
  cfeConfigurationId,
  cfeNamePrefix,
  cfeSourceUuid,
  cfeTargetPath,
  configurationScopeShape,
  rootObjectPath,
  trimmedElementName,
} from './schemas';

const cfeListProjectsInput = z.strictObject({ ...configurationScopeShape });
const cfeGetContextInput = z.strictObject({ configurationId: cfeConfigurationId });
const cfeValidateInput = z.strictObject({ ...configurationScopeShape });
const cfeCreateProjectInput = z.strictObject({
  baseConfigurationId: cfeConfigurationId,
  extensionName: trimmedElementName,
  purpose: z.enum(['Customization', 'Patch', 'AddOn']),
  namePrefix: cfeNamePrefix,
  compatibilityMode: cfeCompatibilityMode,
  target: cfeTargetPath.optional(),
  includeDefaultRole: z.boolean().optional(),
});
const cfeBorrowObjectInput = z.strictObject({
  extensionConfigurationId: cfeConfigurationId,
  sourceDotPath: rootObjectPath.optional(),
  sourceUuid: cfeSourceUuid.optional(),
}).refine(
  (value) => (value.sourceDotPath === undefined) !== (value.sourceUuid === undefined),
  { message: 'must provide exactly one of sourceDotPath or sourceUuid' },
);

export const CFE_PROJECT_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'cdt_cfe_list_projects',
    description: 'List persisted CFE projects for the selected configuration workspace.',
    command: '1c-metadata-tree.agent.cfe.listProjects',
    inputSchema: cfeListProjectsInput,
    annotations: READ_CLOSED,
  },
  {
    name: 'cdt_cfe_get_context',
    description: 'Read the CFE project context for a base or extension configuration.',
    command: '1c-metadata-tree.agent.cfe.getContext',
    inputSchema: cfeGetContextInput,
    annotations: READ_CLOSED,
  },
  {
    name: 'cdt_cfe_validate',
    description: 'Validate persisted CFE project relations in the selected workspace.',
    command: '1c-metadata-tree.agent.cfe.validate',
    inputSchema: cfeValidateInput,
    annotations: READ_CLOSED,
  },
  {
    name: 'cdt_cfe_create_project',
    description: 'Create a CFE project and persist its relation to the selected base configuration.',
    command: '1c-metadata-tree.agent.cfe.createProject',
    inputSchema: cfeCreateProjectInput,
    annotations: WRITE_CLOSED,
  },
  {
    name: 'cdt_cfe_borrow_object',
    description: 'Borrow one supported root object from the linked base configuration into a CFE project.',
    command: '1c-metadata-tree.agent.cfe.borrowObject',
    inputSchema: cfeBorrowObjectInput,
    annotations: WRITE_CLOSED_IDEMPOTENT,
  },
];
