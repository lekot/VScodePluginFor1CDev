import { z } from 'zod';
import type { McpToolDefinition } from './types';
import { READ_CLOSED, WRITE_CLOSED } from './types';
import {
  configurationScopeShape,
  hasExactlyOneExternalSource,
  hasExternalSource,
  hasXdtoSelector,
  trimmedElementName,
  trimmedNonEmptyString,
  xdtoSelectorShape,
} from './schemas';

const xsdOutputPath = trimmedNonEmptyString.refine(
  (value) => value.trim().toLocaleLowerCase().endsWith('.xsd'),
  { message: 'must have the .xsd extension' },
);

const listPackagesInput = z.strictObject({ ...configurationScopeShape });

const getPackageInput = z.strictObject({
  ...xdtoSelectorShape,
  includeSource: z.boolean().optional(),
}).refine(hasXdtoSelector, { message: 'packageName or metadataPath is required' });

const exportXsdInput = z.strictObject({
  ...xdtoSelectorShape,
  outputPath: xsdOutputPath.optional(),
  includeSource: z.boolean().optional(),
}).refine(hasXdtoSelector, { message: 'packageName or metadataPath is required' });

const importXsdInput = z.strictObject({
  ...xdtoSelectorShape,
  inputPath: z.string().optional(),
  source: z.string().optional(),
})
  .refine(hasXdtoSelector, { message: 'packageName or metadataPath is required' })
  .refine(hasExactlyOneExternalSource, { message: 'exactly one of inputPath or source is required' });

const createFromXsdInput = z.strictObject({
  ...configurationScopeShape,
  packageName: trimmedElementName,
  inputPath: z.string().optional(),
  source: z.string().optional(),
}).refine(hasExactlyOneExternalSource, { message: 'exactly one of inputPath or source is required' });

const joinStrategy = z.enum(['left', 'right', 'full']);

const compareInput = z.strictObject({
  ...xdtoSelectorShape,
  inputPath: z.string().optional(),
  source: z.string().optional(),
  includeTree: z.boolean().optional(),
  joinStrategy: joinStrategy.optional(),
})
  .refine(hasXdtoSelector, { message: 'packageName or metadataPath is required' })
  .refine(hasExternalSource, { message: 'inputPath or source is required' });

const mergeInput = z.strictObject({
  ...xdtoSelectorShape,
  inputPath: z.string().optional(),
  source: z.string().optional(),
  selectedIds: z.array(z.string()),
  joinStrategy: joinStrategy.optional(),
})
  .refine(hasXdtoSelector, { message: 'packageName or metadataPath is required' })
  .refine(hasExternalSource, { message: 'inputPath or source is required' });

export const XDTO_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'cdt_xdto_list_packages',
    description: 'List XDTO packages in a metadata configuration.',
    command: '1c-metadata-tree.agent.xdto.listPackages',
    inputSchema: listPackagesInput,
    annotations: READ_CLOSED,
  },
  {
    name: 'cdt_xdto_get_package',
    description: 'Read an XDTO package model and optionally its source XML.',
    command: '1c-metadata-tree.agent.xdto.getPackage',
    inputSchema: getPackageInput,
    annotations: READ_CLOSED,
  },
  {
    name: 'cdt_xdto_export_xsd',
    description: 'Convert an XDTO package to XSD; outputPath writes inside the configuration root.',
    command: '1c-metadata-tree.agent.xdto.exportXsd',
    inputSchema: exportXsdInput,
    annotations: WRITE_CLOSED,
  },
  {
    name: 'cdt_xdto_import_xsd',
    description: 'Replace an existing XDTO package schema from an XSD file or inline source.',
    command: '1c-metadata-tree.agent.xdto.importXsd',
    inputSchema: importXsdInput,
    annotations: WRITE_CLOSED,
  },
  {
    name: 'cdt_xdto_create_from_xsd',
    description: 'Create a new XDTO package from an XSD file or inline source.',
    command: '1c-metadata-tree.agent.xdto.createFromXsd',
    inputSchema: createFromXsdInput,
    annotations: WRITE_CLOSED,
  },
  {
    name: 'cdt_xdto_compare',
    description: 'Compare an XDTO package with an XSD file or inline source.',
    command: '1c-metadata-tree.agent.xdto.compare',
    inputSchema: compareInput,
    annotations: READ_CLOSED,
  },
  {
    name: 'cdt_xdto_merge',
    description: 'Merge selected differences from an XSD file or inline source into an XDTO package.',
    command: '1c-metadata-tree.agent.xdto.merge',
    inputSchema: mergeInput,
    annotations: WRITE_CLOSED,
  },
] as const;
