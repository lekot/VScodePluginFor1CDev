import * as vscode from 'vscode';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AgentResult } from '../types';
import { METADATA_TOOLS } from './catalog/metadataTools';
import { DEBUG_TOOLS } from './catalog/debugTools';
import { BINDINGS_DEPLOY_TOOLS } from './catalog/bindingsDeployTools';
import { ADVANCED_METADATA_TOOLS } from './catalog/advancedMetadataTools';
import { FORMS_TOOLS } from './catalog/formsTools';
import { SKD_TOOLS } from './catalog/skdTools';
import { XDTO_TOOLS } from './catalog/xdtoTools';
import type { McpToolDefinition } from './catalog/types';

export type { McpToolDefinition } from './catalog/types';

/** The single public registry for the complete Agent API MCP surface. */
export const MCP_TOOL_CATALOG: readonly McpToolDefinition[] = [
  ...METADATA_TOOLS,
  ...DEBUG_TOOLS,
  ...BINDINGS_DEPLOY_TOOLS,
  ...ADVANCED_METADATA_TOOLS,
  ...FORMS_TOOLS,
  ...SKD_TOOLS,
  ...XDTO_TOOLS,
];

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
        annotations: tool.annotations,
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
