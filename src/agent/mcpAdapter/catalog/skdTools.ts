import { z } from 'zod';
import type { McpToolDefinition } from './types';
import { WRITE_OPEN } from './types';
import { nonEmptyString } from './schemas';

const skdCompileInput = z.strictObject({
  definitionFile: z.string().optional(),
  value: z.string().optional(),
  outputPath: nonEmptyString,
  background: z.boolean().default(true),
}).refine(
  (input) => Number(Boolean(input.definitionFile)) + Number(Boolean(input.value)) === 1,
  { message: 'exactly one of definitionFile or value is required' },
);

const skdMode = z.enum([
  'overview', 'query', 'fields', 'links', 'calculated', 'resources',
  'params', 'variant', 'trace', 'templates', 'full',
]);

const skdInfoInput = z.strictObject({
  templatePath: nonEmptyString,
  mode: skdMode.optional(),
  name: z.string().optional(),
  batch: z.number().optional(),
  limit: z.number().optional(),
  offset: z.number().optional(),
  outFile: z.string().optional(),
  background: z.boolean().default(true),
});

const skdEditOperation = z.enum([
  'add-field', 'add-total', 'add-calculated-field', 'add-parameter', 'add-filter',
  'add-dataParameter', 'add-order', 'add-selection', 'add-dataSetLink',
  'add-dataSet', 'add-variant', 'add-conditionalAppearance',
  'set-query', 'set-outputParameter', 'set-structure',
  'modify-field', 'modify-filter', 'modify-dataParameter',
  'clear-selection', 'clear-order', 'clear-filter',
  'remove-field', 'remove-total', 'remove-calculated-field', 'remove-parameter', 'remove-filter',
]);

const skdEditInput = z.strictObject({
  templatePath: nonEmptyString,
  operation: skdEditOperation,
  value: z.string(),
  dataSet: z.string().optional(),
  variant: z.string().optional(),
  noSelection: z.boolean().optional(),
  background: z.boolean().default(true),
});

const skdValidateInput = z.strictObject({
  templatePath: nonEmptyString,
  detailed: z.boolean().optional(),
  maxErrors: z.number().optional(),
  outFile: z.string().optional(),
  background: z.boolean().default(true),
});

export const SKD_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'cdt_skd_compile',
    description: 'Compile SKD JSON into a local XML file through PowerShell. Returns a task receipt by default; set background=false to wait synchronously.',
    command: '1c-metadata-tree.agent.skd.compile',
    inputSchema: skdCompileInput,
    annotations: WRITE_OPEN,
  },
  {
    name: 'cdt_skd_info',
    description: 'Inspect an SKD template through PowerShell; outFile may write a local report. Returns a task receipt by default; set background=false to wait synchronously.',
    command: '1c-metadata-tree.agent.skd.info',
    inputSchema: skdInfoInput,
    annotations: WRITE_OPEN,
  },
  {
    name: 'cdt_skd_edit',
    description: 'Apply an atomic SKD edit through PowerShell. Returns a task receipt by default; set background=false to wait synchronously.',
    command: '1c-metadata-tree.agent.skd.edit',
    inputSchema: skdEditInput,
    annotations: WRITE_OPEN,
  },
  {
    name: 'cdt_skd_validate',
    description: 'Validate an SKD template through PowerShell; outFile may write a local report. Returns a task receipt by default; set background=false to wait synchronously.',
    command: '1c-metadata-tree.agent.skd.validate',
    inputSchema: skdValidateInput,
    annotations: WRITE_OPEN,
  },
] as const;
