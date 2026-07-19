import { z } from 'zod';
import type { McpToolDefinition } from './types';
import { READ_OPEN, WRITE_OPEN } from './types';
import { emptyInput, nonEmptyString } from './schemas';

const formsStartInput = z.strictObject({
  url: z.string().optional(),
  dbPath: z.string().optional(),
  platformPath: z.string().optional(),
  readyTimeoutMs: z.number().optional(),
}).refine((value) => Boolean(value.url || value.dbPath), {
  message: 'url or dbPath is required',
});

const formsExecInput = z.strictObject({
  script: nonEmptyString,
  timeoutMs: z.number().optional(),
});

const formsShotInput = z.strictObject({ file: z.string().optional() });

export const FORMS_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'cdt_forms_start',
    description: 'Start or connect to a 1C web-client forms session. When both dbPath and url are present, dbPath takes priority.',
    command: '1c-metadata-tree.agent.forms.start',
    inputSchema: formsStartInput,
    annotations: WRITE_OPEN,
  },
  {
    name: 'cdt_forms_exec',
    description: 'Execute arbitrary JavaScript in the connected 1C forms browser session.',
    command: '1c-metadata-tree.agent.forms.exec',
    inputSchema: formsExecInput,
    annotations: WRITE_OPEN,
  },
  {
    name: 'cdt_forms_stop',
    description: 'Stop the browser and any ibsrv process owned by the forms session.',
    command: '1c-metadata-tree.agent.forms.stop',
    inputSchema: emptyInput,
    annotations: WRITE_OPEN,
  },
  {
    name: 'cdt_forms_shot',
    description: 'Capture a screenshot of the connected 1C forms browser, optionally overwriting a local file.',
    command: '1c-metadata-tree.agent.forms.shot',
    inputSchema: formsShotInput,
    annotations: WRITE_OPEN,
  },
  {
    name: 'cdt_forms_status',
    description: 'Read the current 1C forms browser and ibsrv process status.',
    command: '1c-metadata-tree.agent.forms.status',
    inputSchema: emptyInput,
    annotations: READ_OPEN,
  },
] as const;
