import { AGENT_SUPPORT_COMMAND_IDS } from '../../agentSupportOperations';
import {
  supportEnableObjectRulesInput,
  supportGetLastRunInput,
  supportGetStatusInput,
  supportSetObjectModeInput,
  supportSyncInput,
  supportVerifyInput,
} from './schemas';
import type { McpToolDefinition } from './types';
import { READ_CLOSED, READ_OPEN, WRITE_OPEN } from './types';

/** Strict 1:1 MCP mappings for the six public support Agent operations. */
export const SUPPORT_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'cdt_support_get_status',
    description:
      'Read the current ParentConfigurations support state and optional object lock states.',
    command: AGENT_SUPPORT_COMMAND_IDS.getStatus,
    inputSchema: supportGetStatusInput,
    annotations: READ_CLOSED,
  },
  {
    name: 'cdt_support_set_object_mode',
    description:
      'Change one object support mode using an exact master generation and synchronize the result.',
    command: AGENT_SUPPORT_COMMAND_IDS.setObjectMode,
    inputSchema: supportSetObjectModeInput,
    annotations: WRITE_OPEN,
  },
  {
    name: 'cdt_support_enable_object_rules',
    description:
      'Enable certified object-level support rules using exact master and metadata-universe generations.',
    command: AGENT_SUPPORT_COMMAND_IDS.enableObjectRules,
    inputSchema: supportEnableObjectRulesInput,
    annotations: WRITE_OPEN,
  },
  {
    name: 'cdt_support_sync',
    description:
      'Synchronize the current support master generation with selected bound infobases.',
    command: AGENT_SUPPORT_COMMAND_IDS.sync,
    inputSchema: supportSyncInput,
    annotations: WRITE_OPEN,
  },
  {
    name: 'cdt_support_verify',
    description:
      'Verify support synchronization through read-only Configurator dumps of selected infobases.',
    command: AGENT_SUPPORT_COMMAND_IDS.verify,
    inputSchema: supportVerifyInput,
    annotations: READ_OPEN,
  },
  {
    name: 'cdt_support_get_last_run',
    description:
      'Read the durable target-by-target summary of the latest support sync or verification run.',
    command: AGENT_SUPPORT_COMMAND_IDS.getLastRun,
    inputSchema: supportGetLastRunInput,
    annotations: READ_CLOSED,
  },
] as const;
