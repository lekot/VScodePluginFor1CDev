import { z } from 'zod';
import type { McpToolDefinition } from './types';
import { READ_CLOSED, WRITE_OPEN } from './types';
import { trimmedNonEmptyString } from './schemas';

const taskInput = z.strictObject({ taskId: trimmedNonEmptyString });

export const TASK_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'cdt_task_status',
    description: 'Read the current state and bounded recent stage messages for an Agent background task.',
    command: '1c-metadata-tree.agent.task.status',
    inputSchema: taskInput,
    annotations: READ_CLOSED,
  },
  {
    name: 'cdt_task_result',
    description: 'Read the state and original AgentResult for an Agent background task.',
    command: '1c-metadata-tree.agent.task.result',
    inputSchema: taskInput,
    annotations: READ_CLOSED,
  },
  {
    name: 'cdt_task_cancel',
    description: 'Request cancellation of an Agent background task and read whether it is still settling.',
    command: '1c-metadata-tree.agent.task.cancel',
    inputSchema: taskInput,
    annotations: WRITE_OPEN,
  },
] as const;
