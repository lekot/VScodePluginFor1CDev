import { z } from 'zod';
import { validateElementName } from '../../../utils/elementNameValidator';

export const configurationId = z.string().optional();
export const emptyInput = z.strictObject({});
export const stringArray = z.array(z.string());
export const nonEmptyString = z.string().min(1);
export const trimmedNonEmptyString = z.string().refine((value) => value.trim().length > 0, {
  message: 'must not be empty or whitespace only',
});
export const elementName = z.string().refine((value) => validateElementName(value, []) === null, {
  message: 'must be a valid 1C metadata identifier',
});
export const trimmedElementName = z.string().trim().refine(
  (value) => validateElementName(value, []) === null,
  { message: 'must be a valid 1C metadata identifier' },
);
export const optionalElementName = z.string().refine(
  (value) => value.length === 0 || validateElementName(value, []) === null,
  { message: 'must be empty or a valid 1C metadata identifier' },
);
export const debugServerPort = z.number().int().min(1).max(65535);

const supportUuid = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  'must be a UUID',
);
const supportGenerationId = trimmedNonEmptyString;
const uniqueSupportRetryStates = z.array(
  z.enum(['failed', 'inDoubt', 'targetDrift']),
).min(1).refine(
  (values) => new Set(values).size === values.length,
  { message: 'must contain unique retry states' },
);
const uniqueSupportTargetIds = z.array(trimmedNonEmptyString).min(1).refine(
  (values) => new Set(values).size === values.length,
  { message: 'must contain unique target IDs' },
);
const supportTargetSelection = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('all') }),
  z.strictObject({
    kind: z.literal('retryable'),
    include: uniqueSupportRetryStates,
  }),
  z.strictObject({
    kind: z.literal('ids'),
    targetIds: uniqueSupportTargetIds,
  }),
]);

export const supportGetStatusInput = z.strictObject({
  configurationId: trimmedNonEmptyString,
  objectIds: z.array(supportUuid).optional(),
});

export const supportSetObjectModeInput = z.strictObject({
  configurationId: trimmedNonEmptyString,
  objectId: supportUuid,
  targetMode: z.enum(['notEditable', 'editableWithSupport', 'removedFromSupport']),
  expectedGenerationId: supportGenerationId,
});

export const supportEnableObjectRulesInput = z.strictObject({
  configurationId: trimmedNonEmptyString,
  targetObjectId: supportUuid,
  targetMode: z.enum(['editableWithSupport', 'removedFromSupport']),
  expectedGenerationId: supportGenerationId,
  expectedMetadataUniverseGenerationId: supportGenerationId,
});

export const supportSyncInput = z.strictObject({
  configurationId: trimmedNonEmptyString,
  targets: supportTargetSelection,
  verification: z.enum(['fast', 'strict']).optional(),
});

export const supportVerifyInput = z.strictObject({
  configurationId: trimmedNonEmptyString,
  targets: supportTargetSelection,
});

export const supportGetLastRunInput = z.strictObject({
  configurationId: trimmedNonEmptyString,
});

const AGENT_PATH_LENGTHS = new Set([2, 4, 6]);

function isAgentPath(value: string, allowedLengths = AGENT_PATH_LENGTHS): boolean {
  const segments = value.split('.');
  return allowedLengths.has(segments.length)
    && segments.every((segment) => validateElementName(segment, []) === null);
}

export const agentPath = z.string().refine((value) => isAgentPath(value), {
  message: 'must be a valid 2-, 4-, or 6-segment Agent API path',
});
export const rootObjectPath = z.string().refine((value) => isAgentPath(value, new Set([2])), {
  message: 'must be a valid RootTag.ObjectName path',
});
export const attributePath = z.string().refine((value) => isAgentPath(value, new Set([4, 6])), {
  message: 'must be a valid 4- or 6-segment Agent API path',
});
export const tabularSectionPath = z.string().refine((value) => {
  const segments = value.split('.');
  return isAgentPath(value, new Set([4])) && segments[2] === 'TabularSection';
}, {
  message: 'must have the form RootTag.ObjectName.TabularSection.Name',
});

const PRIMITIVE_METADATA_TYPES = new Set([
  'xs:string', 'xs:decimal', 'xs:boolean', 'xs:date', 'xs:dateTime', 'xs:time',
]);

export const metadataType = z.string().refine(
  (value) => PRIMITIVE_METADATA_TYPES.has(value)
    || (value.startsWith('cfg:') && value.slice(4).includes('.')),
  { message: 'must be a supported primitive type or cfg:ReferenceKind.ObjectName' },
);

export const configurationScopeShape = { configurationId } as const;

export const pathInput = z.strictObject({
  ...configurationScopeShape,
  path: agentPath,
});

export const configPathInput = z.strictObject({
  ...configurationScopeShape,
  configPath: z.string().optional(),
});

export const sessionInput = z.strictObject({
  sessionId: nonEmptyString,
});

export const debuggeeType = z.enum(['thinClient', 'webServer']);

export const debugThreadInput = z.strictObject({
  sessionId: nonEmptyString,
  threadId: z.number(),
});

export const xdtoSelectorShape = {
  ...configurationScopeShape,
  packageName: optionalElementName.optional(),
  metadataPath: z.string().optional(),
} as const;

export function hasXdtoSelector(value: { packageName?: string; metadataPath?: string }): boolean {
  return Boolean(value.packageName?.trim() || value.metadataPath?.trim());
}

export function hasExternalSource(value: { inputPath?: string; source?: string }): boolean {
  return Boolean(value.inputPath) || value.source !== undefined;
}

export function hasExactlyOneExternalSource(value: { inputPath?: string; source?: string }): boolean {
  return Number(Boolean(value.inputPath)) + Number(value.source !== undefined) === 1;
}
