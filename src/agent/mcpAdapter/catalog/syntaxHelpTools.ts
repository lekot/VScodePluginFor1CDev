import { z } from 'zod';
import type { McpToolDefinition } from './types';
import { READ_CLOSED } from './types';

const syntaxHelpId = z.union([
  z.string().min(1).max(200).refine((value) => value.trim().length > 0),
  z.number().int().positive().safe(),
]);

const syntaxHelpInput = z.strictObject({
  source: z.enum(['syntax', 'standards', 'all']).optional(),
  action: z.enum(['search', 'searchLine', 'get', 'children']).optional(),
  query: z.string().min(1).max(500).refine((query) => query.trim().length > 0).optional(),
  line: z.string().min(1).max(2000).optional(),
  cursorColumn: z.number().int().min(0).optional(),
  id: syntaxHelpId.optional(),
  parentId: syntaxHelpId.nullable().optional(),
  limit: z.number().int().min(1).max(50).optional(),
  snippetLength: z.number().int().min(40).max(1000).optional(),
}).superRefine((input, context) => {
  const action = input.action ?? 'search';
  if (action === 'search') {
    if (!input.query) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['query'], message: 'search requires query' });
    }
    if (input.id !== undefined || input.parentId !== undefined || input.line !== undefined || input.cursorColumn !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'search does not accept id, parentId, line, or cursorColumn' });
    }
  } else if (action === 'searchLine') {
    if (input.line === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['line'], message: 'searchLine requires line' });
    }
    if (input.line !== undefined && input.cursorColumn !== undefined && input.cursorColumn > input.line.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['cursorColumn'], message: 'cursorColumn exceeds line length' });
    }
    if (input.query !== undefined || input.id !== undefined || input.parentId !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'searchLine does not accept query, id, or parentId' });
    }
  } else if (action === 'get') {
    if (input.id === undefined && !input.query) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'get requires id or query' });
    }
    if (input.id !== undefined && input.query !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'get accepts either id or query, not both' });
    }
    if (input.parentId !== undefined || input.limit !== undefined || input.snippetLength !== undefined
      || input.line !== undefined || input.cursorColumn !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'get does not accept parentId, limit, snippetLength, line, or cursorColumn' });
    }
  } else if (input.id !== undefined || input.query !== undefined || input.snippetLength !== undefined
    || input.line !== undefined || input.cursorColumn !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'children does not accept id, query, snippetLength, line, or cursorColumn' });
  }
});

export const SYNTAX_HELP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'cdt_syntax_help',
    description: 'Search or navigate the bundled 1C syntax database and original Russian development-standard notes, including search from a BSL line and cursor position.',
    command: '1c-metadata-tree.agent.syntaxHelp',
    inputSchema: syntaxHelpInput,
    annotations: READ_CLOSED,
  },
] as const;
