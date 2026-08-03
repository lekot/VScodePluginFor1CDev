import type { McpToolDefinition } from './types';
import { WRITE_OPEN } from './types';
import {
  agentBuildExternalProcessorSchema,
  agentDumpExternalProcessorSchema,
} from './schemas';

export const EXTERNAL_PROCESSOR_MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'cdt_dump_external_processor',
    description: 'Decompile/dump an external processor (.epf) or report (.erf) binary file into XML sources.',
    command: '1c-metadata-tree.agent.dumpExternalProcessor',
    inputSchema: agentDumpExternalProcessorSchema,
    annotations: WRITE_OPEN,
  },
  {
    name: 'cdt_build_external_processor',
    description: 'Compile/build an external processor (.epf) or report (.erf) binary file from XML sources.',
    command: '1c-metadata-tree.agent.buildExternalProcessor',
    inputSchema: agentBuildExternalProcessorSchema,
    annotations: WRITE_OPEN,
  },
];
