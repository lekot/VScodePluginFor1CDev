import { z } from 'zod';
import type { McpToolDefinition } from './types';
import { READ_CLOSED, WRITE_CLOSED } from './types';
import {
  agentPath,
  attributePath,
  configurationScopeShape,
  elementName,
  emptyInput,
  pathInput,
  rootObjectPath,
  tabularSectionPath,
} from './schemas';

const createObjectInput = z.strictObject({
  ...configurationScopeShape,
  type: elementName,
  name: elementName,
  synonym: z.string().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
});

const listObjectsInput = z.strictObject({
  ...configurationScopeShape,
  type: z.string().optional(),
  query: z.string().optional(),
});

const pathNameInput = z.strictObject({
  ...configurationScopeShape,
  path: agentPath,
  name: elementName,
});

const tabularPathNameInput = z.strictObject({
  ...configurationScopeShape,
  path: tabularSectionPath,
  name: elementName,
});

const renameObjectInput = z.strictObject({
  ...configurationScopeShape,
  path: rootObjectPath,
  newName: elementName,
});

const setPropertiesInput = z.strictObject({
  ...configurationScopeShape,
  path: agentPath,
  properties: z.record(z.string(), z.unknown()).refine(
    (properties) => !Object.prototype.hasOwnProperty.call(properties, 'Name'),
    { message: 'Name cannot be changed through setProperties' },
  ),
});

const deleteAttributeInput = z.strictObject({
  ...configurationScopeShape,
  path: attributePath,
});

const deleteTabularSectionInput = z.strictObject({
  ...configurationScopeShape,
  path: tabularSectionPath,
});

export const METADATA_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'cdt_list_configurations',
    description: 'List metadata configurations available in the current VS Code workspace.',
    command: '1c-metadata-tree.agent.listConfigurations',
    inputSchema: emptyInput,
    annotations: READ_CLOSED,
  },
  {
    name: 'cdt_create_object',
    description: 'Create a metadata object in a configuration.',
    command: '1c-metadata-tree.agent.createObject',
    inputSchema: createObjectInput,
    annotations: WRITE_CLOSED,
  },
  {
    name: 'cdt_get_yaml',
    description: 'Read the YAML representation of a metadata object by Agent API path.',
    command: '1c-metadata-tree.agent.getYaml',
    inputSchema: pathInput,
    annotations: READ_CLOSED,
  },
  {
    name: 'cdt_list_objects',
    description: 'List metadata objects, optionally filtered by exact type and name substring.',
    command: '1c-metadata-tree.agent.listObjects',
    inputSchema: listObjectsInput,
    annotations: READ_CLOSED,
  },
  {
    name: 'cdt_get_properties',
    description: 'Read metadata object properties by Agent API path.',
    command: '1c-metadata-tree.agent.getProperties',
    inputSchema: pathInput,
    annotations: READ_CLOSED,
  },
  {
    name: 'cdt_add_attribute',
    description: 'Add an attribute to a metadata object.',
    command: '1c-metadata-tree.agent.addAttribute',
    inputSchema: pathNameInput,
    annotations: WRITE_CLOSED,
  },
  {
    name: 'cdt_add_tabular_section',
    description: 'Add a tabular section to a metadata object.',
    command: '1c-metadata-tree.agent.addTabularSection',
    inputSchema: pathNameInput,
    annotations: WRITE_CLOSED,
  },
  {
    name: 'cdt_add_tabular_section_column',
    description: 'Add a column to a metadata object tabular section.',
    command: '1c-metadata-tree.agent.addTabularSectionColumn',
    inputSchema: tabularPathNameInput,
    annotations: WRITE_CLOSED,
  },
  {
    name: 'cdt_delete_attribute',
    description: 'Delete an attribute or tabular-section column by Agent API path.',
    command: '1c-metadata-tree.agent.deleteAttribute',
    inputSchema: deleteAttributeInput,
    annotations: WRITE_CLOSED,
  },
  {
    name: 'cdt_delete_tabular_section',
    description: 'Delete a metadata object tabular section by Agent API path.',
    command: '1c-metadata-tree.agent.deleteTabularSection',
    inputSchema: deleteTabularSectionInput,
    annotations: WRITE_CLOSED,
  },
  {
    name: 'cdt_delete_object',
    description: 'Delete a metadata object by Agent API path.',
    command: '1c-metadata-tree.agent.deleteObject',
    inputSchema: pathInput,
    annotations: WRITE_CLOSED,
  },
  {
    name: 'cdt_rename_object',
    description: 'Rename a metadata object and update its configuration references.',
    command: '1c-metadata-tree.agent.renameObject',
    inputSchema: renameObjectInput,
    annotations: WRITE_CLOSED,
  },
  {
    name: 'cdt_set_properties',
    description: 'Update metadata object properties by Agent API path.',
    command: '1c-metadata-tree.agent.setProperties',
    inputSchema: setPropertiesInput,
    annotations: WRITE_CLOSED,
  },
] as const;
