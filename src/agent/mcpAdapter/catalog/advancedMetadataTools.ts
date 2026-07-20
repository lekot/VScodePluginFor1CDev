import { z } from 'zod';
import type { McpToolDefinition } from './types';
import { READ_CLOSED, WRITE_CLOSED } from './types';
import { agentPath, configurationScopeShape, metadataType, pathInput, stringArray } from './schemas';

const setTypeInput = z.strictObject({
  ...configurationScopeShape,
  path: agentPath,
  types: z.array(metadataType),
});

const predefinedPathInput = z.strictObject({
  ...configurationScopeShape,
  path: z.string(),
});

const subsystemInput = z.strictObject({
  ...configurationScopeShape,
  subsystemPath: z.string(),
});

const commandVisibilityInput = z.strictObject({
  ...configurationScopeShape,
  subsystemPath: z.string(),
  commandName: z.string(),
  common: z.enum(['visible', 'hidden']).nullable(),
});

const commandOrderEntry = z.strictObject({
  commandName: z.string(),
  commandGroup: z.string(),
});

const commandOrderInput = z.strictObject({
  ...configurationScopeShape,
  subsystemPath: z.string(),
  entries: z.array(commandOrderEntry),
});

const subsystemsOrderInput = z.strictObject({
  ...configurationScopeShape,
  subsystemPath: z.string(),
  order: stringArray,
});

const predefinedTypeInput = z.strictObject({
  ...configurationScopeShape,
  path: z.string(),
  predefinedName: z.string(),
});

const setPredefinedTypeInput = z.strictObject({
  ...configurationScopeShape,
  path: z.string(),
  predefinedName: z.string(),
  types: stringArray,
});

export const ADVANCED_METADATA_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'cdt_get_type',
    description: 'Read the type declaration of a metadata property or defined type.',
    command: '1c-metadata-tree.agent.getType',
    inputSchema: pathInput,
    annotations: READ_CLOSED,
  },
  {
    name: 'cdt_set_type',
    description: 'Replace the type declaration of a metadata property or defined type.',
    command: '1c-metadata-tree.agent.setType',
    inputSchema: setTypeInput,
    annotations: WRITE_CLOSED,
  },
  {
    name: 'cdt_get_subsystem_command_interface',
    description: 'Read a subsystem command-interface model.',
    command: '1c-metadata-tree.agent.getSubsystemCommandInterface',
    inputSchema: subsystemInput,
    annotations: READ_CLOSED,
  },
  {
    name: 'cdt_set_subsystem_command_visibility',
    description: 'Set or remove a subsystem command visibility override.',
    command: '1c-metadata-tree.agent.setSubsystemCommandVisibility',
    inputSchema: commandVisibilityInput,
    annotations: WRITE_CLOSED,
  },
  {
    name: 'cdt_set_subsystem_command_order',
    description: 'Replace the ordered subsystem command entries.',
    command: '1c-metadata-tree.agent.setSubsystemCommandOrder',
    inputSchema: commandOrderInput,
    annotations: WRITE_CLOSED,
  },
  {
    name: 'cdt_set_subsystem_subsystems_order',
    description: 'Replace the order of nested subsystems in a subsystem command interface.',
    command: '1c-metadata-tree.agent.setSubsystemSubsystemsOrder',
    inputSchema: subsystemsOrderInput,
    annotations: WRITE_CLOSED,
  },
  {
    name: 'cdt_list_predefined_characteristics',
    description: 'List predefined characteristics for a chart of characteristic types.',
    command: '1c-metadata-tree.agent.listPredefinedCharacteristics',
    inputSchema: predefinedPathInput,
    annotations: READ_CLOSED,
  },
  {
    name: 'cdt_get_predefined_characteristic_type',
    description: 'Read the type of one predefined characteristic.',
    command: '1c-metadata-tree.agent.getPredefinedCharacteristicType',
    inputSchema: predefinedTypeInput,
    annotations: READ_CLOSED,
  },
  {
    name: 'cdt_set_predefined_characteristic_type',
    description: 'Replace the type of one predefined characteristic.',
    command: '1c-metadata-tree.agent.setPredefinedCharacteristicType',
    inputSchema: setPredefinedTypeInput,
    annotations: WRITE_CLOSED,
  },
  {
    name: 'cdt_get_characteristic_value_registers',
    description: 'List information registers that reference a chart of characteristic types.',
    command: '1c-metadata-tree.agent.getCharacteristicValueRegisters',
    inputSchema: predefinedPathInput,
    annotations: READ_CLOSED,
  },
] as const;
