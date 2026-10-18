import { z } from 'zod';
import type { McpToolDefinition } from './types';
import { WRITE_OPEN } from './types';
import { configurationScopeShape, nonEmptyString } from './schemas';
import { SKD_EDIT_OPERATIONS } from '../../agentSkdTypes';

const skdConfigurationSelector = {
  ...configurationScopeShape,
  configPath: nonEmptyString.optional(),
};

const reportFile = z.string().trim().min(1).refine((value) => /\.(?:txt|log)$/i.test(value), {
  message: 'outFile must end in .txt or .log',
});

const skdCompileInput = z.strictObject({
  ...skdConfigurationSelector,
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
  ...skdConfigurationSelector,
  templatePath: nonEmptyString,
  mode: skdMode.optional(),
  name: z.string().optional(),
  batch: z.number().optional(),
  limit: z.number().optional(),
  offset: z.number().optional(),
  outFile: reportFile.optional(),
  background: z.boolean().default(true),
});

const skdEditOperation = z.enum(SKD_EDIT_OPERATIONS);

const skdEditInput = z.strictObject({
  ...skdConfigurationSelector,
  templatePath: nonEmptyString,
  operation: skdEditOperation,
  value: z.string(),
  dataSet: z.string().optional(),
  variant: z.string().optional(),
  noSelection: z.boolean().optional(),
  background: z.boolean().default(true),
});

const skdValidateInput = z.strictObject({
  ...skdConfigurationSelector,
  templatePath: nonEmptyString,
  detailed: z.boolean().optional(),
  maxErrors: z.number().optional(),
  outFile: reportFile.optional(),
  background: z.boolean().default(true),
});

export const SKD_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'cdt_skd_compile',
    description: 'Compile SKD JSON into a local XML file through PowerShell. Use configurationId or configPath to select the configuration root for relative paths. After a successful write, reconciliation reports whether the metadata tree reload succeeded. Returns a task receipt by default; set background=false to wait synchronously.',
    command: '1c-metadata-tree.agent.skd.compile',
    inputSchema: skdCompileInput,
    annotations: WRITE_OPEN,
  },
  {
    name: 'cdt_skd_info',
    description: 'Inspect an SKD template through PowerShell. Use configurationId or configPath to select the root for relative paths. Without outFile this is read-only; outFile writes a .txt or .log report inside the configuration and returns a mutation receipt without reloading the metadata tree. Returns a task receipt by default; set background=false to wait synchronously.',
    command: '1c-metadata-tree.agent.skd.info',
    inputSchema: skdInfoInput,
    annotations: WRITE_OPEN,
  },
  {
    name: 'cdt_skd_edit',
    description: 'Apply an atomic SKD edit through PowerShell. Use configurationId or configPath to select the configuration root for relative paths. After a successful write, reconciliation reports whether the metadata tree reload succeeded. Returns a task receipt by default; set background=false to wait synchronously.',
    command: '1c-metadata-tree.agent.skd.edit',
    inputSchema: skdEditInput,
    annotations: WRITE_OPEN,
  },
  {
    name: 'cdt_skd_validate',
    description: 'Validate an SKD template through PowerShell. Use configurationId or configPath to select the root for relative paths. Without outFile this is read-only; outFile writes a .txt or .log report inside the configuration and returns a mutation receipt without reloading the metadata tree. process success=true means execution succeeded, while result.valid indicates check results, and result.coverage (\'full\' | \'partial\') / xsdChecked indicate whether platform XSD schema validation was executed. Returns a task receipt by default; set background=false to wait synchronously.',
    command: '1c-metadata-tree.agent.skd.validate',
    inputSchema: skdValidateInput,
    annotations: WRITE_OPEN,
  },
] as const;
