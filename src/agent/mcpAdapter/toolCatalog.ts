import * as vscode from 'vscode';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AgentResult } from '../types';

const configurationId = z.string().min(1).optional();

const emptyInput = z.strictObject({});
const listObjectsInput = z.strictObject({
  configurationId,
  type: z.string().min(1).optional(),
  query: z.string().optional(),
});
const pathInput = z.strictObject({
  configurationId,
  path: z.string().min(1),
});
const exportStatusInput = z.strictObject({
  configurationId,
  configPath: z.string().min(1).optional(),
});

export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly command: string;
  readonly inputSchema: z.ZodType<Record<string, unknown>>;
}

/** The single public registry for the first MCP vertical. */
export const MCP_TOOL_CATALOG: readonly McpToolDefinition[] = [
  {
    name: 'cdt_list_configurations',
    description: 'List metadata configurations available in the current VS Code workspace.',
    command: '1c-metadata-tree.agent.listConfigurations',
    inputSchema: emptyInput,
  },
  {
    name: 'cdt_list_objects',
    description: 'List metadata objects, optionally filtered by exact type and name substring.',
    command: '1c-metadata-tree.agent.listObjects',
    inputSchema: listObjectsInput,
  },
  {
    name: 'cdt_get_yaml',
    description: 'Read the YAML representation of a metadata object by Agent API path.',
    command: '1c-metadata-tree.agent.getYaml',
    inputSchema: pathInput,
  },
  {
    name: 'cdt_get_properties',
    description: 'Read metadata object properties by Agent API path.',
    command: '1c-metadata-tree.agent.getProperties',
    inputSchema: pathInput,
  },
  {
    name: 'cdt_list_bindings',
    description: 'List configured metadata-to-infobase bindings using the redacted Agent API DTO.',
    command: '1c-metadata-tree.agent.listBindings',
    inputSchema: emptyInput,
  },
  {
    name: 'cdt_export_status',
    description: 'Read ibcmd export status for a configuration. This may start a local ibcmd process.',
    command: '1c-metadata-tree.agent.exportStatus',
    inputSchema: exportStatusInput,
  },
] as const;

export type AgentCommandExecutor = (
  command: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

const defaultExecutor: AgentCommandExecutor = (command, args) =>
  Promise.resolve(vscode.commands.executeCommand(command, args));

function cancellationResult(): AgentResult {
  return {
    success: false,
    code: 'REQUEST_CANCELLED',
    error: 'MCP request was cancelled',
  };
}

function exceptionResult(): AgentResult {
  return {
    success: false,
    code: 'AGENT_COMMAND_FAILED',
    error: 'Agent command failed',
  };
}

export function mapAgentResult(result: AgentResult): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result as unknown as Record<string, unknown>,
    ...(result.success ? {} : { isError: true }),
  };
}

export function registerMcpTools(
  server: McpServer,
  executeCommand: AgentCommandExecutor = defaultExecutor,
): void {
  for (const tool of MCP_TOOL_CATALOG) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: true },
      },
      async (args, extra): Promise<CallToolResult> => {
        if (extra.signal.aborted) {
          return mapAgentResult(cancellationResult());
        }

        let result: AgentResult;
        try {
          result = await executeCommand(tool.command, args) as AgentResult;
        } catch {
          result = exceptionResult();
        }

        if (extra.signal.aborted) {
          return mapAgentResult(cancellationResult());
        }
        return mapAgentResult(result);
      },
    );
  }
}
