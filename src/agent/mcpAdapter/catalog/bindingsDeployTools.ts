import { z } from 'zod';
import type { McpToolDefinition } from './types';
import { READ_CLOSED, READ_OPEN, WRITE_OPEN } from './types';
import { configPathInput, configurationScopeShape, emptyInput, nonEmptyString } from './schemas';

const resolveBindingInput = z.strictObject({ configPath: nonEmptyString.optional() });

const selectedFilesInput = z.strictObject({
  ...configurationScopeShape,
  configPath: z.string().optional(),
  files: z.array(z.string()).min(1),
});

const pullObjectsInput = z.strictObject({
  ...configurationScopeShape,
  configPath: z.string().optional(),
  objectIds: z.array(z.string()).min(1),
  infobaseName: z.string().optional(),
});

export const BINDINGS_DEPLOY_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'cdt_resolve_binding',
    description: 'Resolve a configuration path to its metadata-to-infobase binding.',
    command: '1c-metadata-tree.agent.resolveBinding',
    inputSchema: resolveBindingInput,
    annotations: READ_CLOSED,
  },
  {
    name: 'cdt_list_bindings',
    description: 'List configured metadata-to-infobase bindings using the redacted Agent API DTO.',
    command: '1c-metadata-tree.agent.listBindings',
    inputSchema: emptyInput,
    annotations: READ_CLOSED,
  },
  {
    name: 'cdt_deploy',
    description: 'Deploy the complete configuration to its bound infobases.',
    command: '1c-metadata-tree.agent.deploy',
    inputSchema: configPathInput,
    annotations: WRITE_OPEN,
  },
  {
    name: 'cdt_deploy_selected_objects',
    description: 'Deploy selected configuration files to bound infobases.',
    command: '1c-metadata-tree.agent.deploySelectedObjects',
    inputSchema: selectedFilesInput,
    annotations: WRITE_OPEN,
  },
  {
    name: 'cdt_deploy_changed_files',
    description: 'Detect changed configuration files through Git and deploy them to bound infobases.',
    command: '1c-metadata-tree.agent.deployChangedFiles',
    inputSchema: configPathInput,
    annotations: WRITE_OPEN,
  },
  {
    name: 'cdt_pull_selected_objects',
    description: 'Export selected metadata objects from an infobase into the workspace configuration.',
    command: '1c-metadata-tree.agent.pullSelectedObjects',
    inputSchema: pullObjectsInput,
    annotations: WRITE_OPEN,
  },
  {
    name: 'cdt_export_status',
    description: 'Read ibcmd export status for a configuration. This starts a local ibcmd process.',
    command: '1c-metadata-tree.agent.exportStatus',
    inputSchema: configPathInput,
    annotations: READ_OPEN,
  },
] as const;
