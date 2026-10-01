import * as vscode from 'vscode';
import { z } from 'zod';
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
import { SUPPORT_TOOLS } from './catalog/supportTools';
import { EXTERNAL_PROCESSOR_MCP_TOOLS } from './catalog/externalProcessorTools';
import { CFE_PROJECT_TOOLS } from './catalog/cfeProjectTools';
import { ROLE_RIGHTS_TOOLS } from './catalog/roleRightsTools';
import type { McpToolAnnotations, McpToolDefinition } from './catalog/types';
import {
  READ_CLOSED,
  READ_OPEN,
  VERIFY_OPEN,
  WRITE_CLOSED,
  WRITE_CLOSED_IDEMPOTENT,
  WRITE_OPEN,
} from './catalog/types';

export type { McpToolDefinition } from './catalog/types';

/** The original per-operation MCP tools, retained for explicit legacy opt-in. */
export const LEGACY_MCP_TOOL_CATALOG: readonly McpToolDefinition[] = [
  ...METADATA_TOOLS,
  ...DEBUG_TOOLS,
  ...BINDINGS_DEPLOY_TOOLS,
  ...ADVANCED_METADATA_TOOLS,
  ...FORMS_TOOLS,
  ...SKD_TOOLS,
  ...XDTO_TOOLS,
  ...SUPPORT_TOOLS,
  ...EXTERNAL_PROCESSOR_MCP_TOOLS,
  ...CFE_PROJECT_TOOLS,
];

export type McpToolProfile =
  | 'read'
  | 'write'
  | 'write_idempotent'
  | 'read_live'
  | 'write_live'
  | 'verify_live';

export interface McpOperationDefinition extends McpToolDefinition {
  readonly profile: McpToolProfile;
}

export interface CompactMcpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly profile?: McpToolProfile;
  readonly inputSchema: z.ZodType<Record<string, unknown>>;
  readonly annotations: McpToolAnnotations;
}

const PROFILE_ANNOTATIONS: Readonly<Record<McpToolProfile, McpToolAnnotations>> = {
  read: READ_CLOSED,
  write: WRITE_CLOSED,
  write_idempotent: WRITE_CLOSED_IDEMPOTENT,
  read_live: READ_OPEN,
  write_live: WRITE_OPEN,
  verify_live: VERIFY_OPEN,
};

function profileForAnnotations(annotations: McpToolAnnotations): McpToolProfile {
  const profile = (Object.entries(PROFILE_ANNOTATIONS) as Array<[McpToolProfile, McpToolAnnotations]>)
    .find(([, expected]) => Object.keys(expected).every((key) =>
      annotations[key as keyof McpToolAnnotations] === expected[key as keyof McpToolAnnotations],
    ))?.[0];
  if (!profile) {
    throw new Error('MCP operation has no matching compact tool profile.');
  }
  return profile;
}

/** Complete closed operation registry, including the new role-rights command. */
export const MCP_OPERATION_CATALOG: readonly McpOperationDefinition[] = [
  ...LEGACY_MCP_TOOL_CATALOG,
  ...ROLE_RIGHTS_TOOLS,
].map((tool) => ({ ...tool, profile: profileForAnnotations(tool.annotations) }));

const operationByName = new Map(MCP_OPERATION_CATALOG.map((operation) => [operation.name, operation]));

function makeProfileTool(
  name: string,
  profile: McpToolProfile,
  description: string,
): CompactMcpToolDefinition {
  const operations = MCP_OPERATION_CATALOG.filter((operation) => operation.profile === profile);
  const operationNames = operations.map((operation) => operation.name);
  if (operationNames.length === 0) {
    throw new Error(`MCP profile ${profile} has no operations.`);
  }
  const enumValues = operationNames as [string, ...string[]];
  return {
    name,
    description,
    profile,
    inputSchema: z.strictObject({
      operation: z.enum(enumValues),
      arguments: z.record(z.string(), z.unknown()),
    }),
    annotations: PROFILE_ANNOTATIONS[profile],
  };
}

const profileTools: readonly CompactMcpToolDefinition[] = [
  makeProfileTool('cdt_read', 'read', 'Run one closed-world read-only Agent operation.'),
  makeProfileTool('cdt_write', 'write', 'Run one closed-world Agent operation that writes configuration files.'),
  makeProfileTool(
    'cdt_write_idempotent',
    'write_idempotent',
    'Run one closed-world, repeat-safe Agent write operation.',
  ),
  makeProfileTool('cdt_read_live', 'read_live', 'Run one read operation that inspects a live external system.'),
  makeProfileTool('cdt_write_live', 'write_live', 'Run one write operation against a live external system.'),
  makeProfileTool('cdt_verify_live', 'verify_live', 'Run one verification operation against a live external system.'),
];

const catalogTool: CompactMcpToolDefinition = {
  name: 'cdt_catalog',
  description: 'List Agent operations and profiles, or describe one operation schema.',
  inputSchema: z.strictObject({ operation: z.string().optional() }),
  annotations: READ_CLOSED,
};

/** The seven tools visible in MCP tools/list by default. */
export const MCP_TOOL_CATALOG: readonly CompactMcpToolDefinition[] = [
  ...profileTools,
  catalogTool,
];

export type AgentCommandExecutor = (
  command: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

const defaultExecutor: AgentCommandExecutor = (command, args) =>
  Promise.resolve(vscode.commands.executeCommand(command, args));

function agentFailure(code: string, error: string, data?: Record<string, unknown>): AgentResult<unknown> {
  return { success: false, code, error, ...(data ? { data } : {}) };
}

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

export function mapAgentResult(result: AgentResult<unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result as unknown as Record<string, unknown>,
    ...(result.success ? {} : { isError: true }),
  };
}

function toInputJsonSchema(operation: McpOperationDefinition): Record<string, unknown> {
  const schema: Record<string, unknown> = {
    ...z.toJSONSchema(operation.inputSchema, {
      target: 'draft-2020-12',
      unrepresentable: 'any',
    }),
  };
  delete schema['~standard'];
  return schema;
}

function catalogResult(operationName?: string): AgentResult<unknown> {
  if (operationName === undefined) {
    return {
      success: true,
      data: {
        operations: MCP_OPERATION_CATALOG.map(({ name, description, profile }) => ({
          name,
          description,
          profile,
        })),
      },
    };
  }

  const operation = operationByName.get(operationName);
  if (!operation) {
    return agentFailure('MCP_OPERATION_NOT_FOUND', `Unknown Agent operation: ${operationName}`);
  }

  try {
    return {
      success: true,
      data: {
        operation: {
          name: operation.name,
          description: operation.description,
          profile: operation.profile,
          inputSchema: toInputJsonSchema(operation),
        },
      },
    };
  } catch {
    return agentFailure('MCP_SCHEMA_SERIALIZATION_FAILED', 'Agent operation schema is unavailable.');
  }
}

function registerOperationTool(
  server: McpServer,
  tool: McpToolDefinition,
  executeCommand: AgentCommandExecutor,
): void {
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

function registerCompactTool(
  server: McpServer,
  tool: CompactMcpToolDefinition,
  executeCommand: AgentCommandExecutor,
): void {
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    },
    async (rawArgs, extra): Promise<CallToolResult> => {
      if (extra.signal.aborted) {
        return mapAgentResult(cancellationResult());
      }

      const outer = tool.inputSchema.safeParse(rawArgs);
      if (!outer.success) {
        return mapAgentResult(agentFailure('INVALID_ARGUMENTS', 'Arguments do not match this MCP tool schema.'));
      }

      if (tool.name === catalogTool.name) {
        const result = catalogResult(outer.data.operation as string | undefined);
        return mapAgentResult(result);
      }

      const operation = operationByName.get(outer.data.operation as string);
      if (!operation) {
        return mapAgentResult(agentFailure('MCP_OPERATION_NOT_FOUND', 'Agent operation was not found.'));
      }
      if (operation.profile !== tool.profile) {
        return mapAgentResult(agentFailure('MCP_OPERATION_PROFILE_MISMATCH', 'Agent operation does not belong to this tool profile.'));
      }

      const validated = operation.inputSchema.safeParse(outer.data.arguments);
      if (!validated.success) {
        return mapAgentResult(agentFailure('INVALID_ARGUMENTS', 'Arguments do not match the selected Agent operation schema.', {
          issues: validated.error.issues.map((issue) => ({
            path: issue.path,
            code: issue.code,
            message: issue.message,
          })),
        }));
      }

      let result: AgentResult;
      try {
        result = await executeCommand(operation.command, validated.data) as AgentResult;
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

export function registerMcpTools(
  server: McpServer,
  executeCommand: AgentCommandExecutor = defaultExecutor,
): void {
  for (const tool of MCP_TOOL_CATALOG) {
    registerCompactTool(server, tool, executeCommand);
  }

  if (process.env.CDT_MCP_LEGACY_TOOLS === '1') {
    for (const tool of MCP_OPERATION_CATALOG) {
      registerOperationTool(server, tool, executeCommand);
    }
  }
}
