import { z } from 'zod';
import type { McpToolDefinition } from './types';
import { elementName, configurationScopeShape } from './schemas';
import { WRITE_CLOSED } from './types';

export const agentSetRoleRightsInput = z.strictObject({
  ...configurationScopeShape,
  roleName: elementName,
  objects: z.array(z.string()).min(1),
});

/** Agent API MCP mapping for role rights. */
export const ROLE_RIGHTS_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'cdt_roles_set_rights',
    description: 'Replace rights for existing metadata objects in a role using a short rights DSL.',
    command: '1c-metadata-tree.agent.roles.setRights',
    inputSchema: agentSetRoleRightsInput,
    annotations: WRITE_CLOSED,
  },
];
