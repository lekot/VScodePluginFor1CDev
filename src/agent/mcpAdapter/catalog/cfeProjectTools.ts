import { z } from 'zod';
import type { McpToolDefinition } from './types';
import { READ_CLOSED, WRITE_CLOSED, WRITE_CLOSED_IDEMPOTENT } from './types';
import {
  cfeCompatibilityMode,
  cfeConfigurationId,
  cfeNamePrefix,
  cfeSourceUuid,
  cfeTargetPath,
  configurationScopeShape,
  rootObjectPath,
  trimmedElementName,
} from './schemas';

const cfeInterceptorInput = z.strictObject({
  extensionConfigurationId: cfeConfigurationId,
  targetSourceUuid: cfeSourceUuid,
  moduleKind: z.enum(['Module', 'ObjectModule', 'ManagerModule', 'RecordSetModule', 'ValueManagerModule']),
  methodName: trimmedElementName,
  kind: z.enum(['before', 'after', 'instead', 'changeAndValidate']),
  expectedSourceHash: z.string().regex(/^[0-9a-f]{64}$/iu).optional(),
}).superRefine((value, context) => {
  if (value.kind === 'changeAndValidate' && value.expectedSourceHash === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'expectedSourceHash is required for changeAndValidate' });
  }
});
const cfeCreateOwnFormInput = z.strictObject({
  extensionConfigurationId: cfeConfigurationId,
  ownerDotPath: rootObjectPath,
  formName: trimmedElementName,
  formType: z.literal('Managed').optional(),
});
const cfeBorrowFormInput = z.strictObject({
  extensionConfigurationId: cfeConfigurationId,
  ownerSourceUuid: cfeSourceUuid,
  sourceFormUuid: cfeSourceUuid.optional(),
  sourceFormName: trimmedElementName.optional(),
}).refine(
  (value) => (value.sourceFormUuid === undefined) !== (value.sourceFormName === undefined),
  { message: 'must provide exactly one of sourceFormUuid or sourceFormName' },
);
const cfeCallType = z.enum(['Before', 'After', 'Override']);
const cfeFormOperation = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('addAttribute'), name: trimmedElementName, type: z.strictObject({ typeName: z.string().min(1) }), title: z.string().optional() }),
  z.strictObject({ kind: z.literal('addCommand'), name: trimmedElementName, title: z.string().optional(), actions: z.array(z.strictObject({ handler: trimmedElementName, callType: cfeCallType })).optional() }),
  z.strictObject({ kind: z.literal('addElement'), elementType: z.enum(['UsualGroup', 'InputField', 'Button']), name: trimmedElementName, parentName: trimmedElementName.optional(), attributeName: trimmedElementName.optional(), commandName: trimmedElementName.optional(), title: z.string().optional() }),
  z.strictObject({ kind: z.literal('setFormEvent'), eventName: trimmedElementName, handler: trimmedElementName, callType: cfeCallType }),
  z.strictObject({ kind: z.literal('setElementEvent'), elementName: trimmedElementName, eventName: trimmedElementName, handler: trimmedElementName, callType: cfeCallType }),
  z.strictObject({ kind: z.literal('addCommandAction'), commandName: trimmedElementName, handler: trimmedElementName, callType: cfeCallType }),
]);
const cfeExtendFormInput = z.strictObject({
  extensionConfigurationId: cfeConfigurationId,
  sourceFormUuid: cfeSourceUuid,
  expectedFormHash: z.string().regex(/^[0-9a-f]{64}$/iu),
  operations: z.array(cfeFormOperation).min(1),
});

const cfeListProjectsInput = z.strictObject({ ...configurationScopeShape });
const cfeGetContextInput = z.strictObject({ configurationId: cfeConfigurationId });
const cfeValidateInput = z.strictObject({ ...configurationScopeShape });
const cfeCreateProjectInput = z.strictObject({
  baseConfigurationId: cfeConfigurationId,
  extensionName: trimmedElementName,
  purpose: z.enum(['Customization', 'Patch', 'AddOn']),
  namePrefix: cfeNamePrefix,
  compatibilityMode: cfeCompatibilityMode,
  target: cfeTargetPath.optional(),
  includeDefaultRole: z.boolean().optional(),
});
const cfeBorrowObjectInput = z.strictObject({
  extensionConfigurationId: cfeConfigurationId,
  sourceDotPath: rootObjectPath.optional(),
  sourceUuid: cfeSourceUuid.optional(),
}).refine(
  (value) => (value.sourceDotPath === undefined) !== (value.sourceUuid === undefined),
  { message: 'must provide exactly one of sourceDotPath or sourceUuid' },
);

export const CFE_PROJECT_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'cdt_cfe_list_projects',
    description: 'List persisted CFE projects for the selected configuration workspace.',
    command: '1c-metadata-tree.agent.cfe.listProjects',
    inputSchema: cfeListProjectsInput,
    annotations: READ_CLOSED,
  },
  {
    name: 'cdt_cfe_get_context',
    description: 'Read the CFE project context for a base or extension configuration.',
    command: '1c-metadata-tree.agent.cfe.getContext',
    inputSchema: cfeGetContextInput,
    annotations: READ_CLOSED,
  },
  {
    name: 'cdt_cfe_validate',
    description: 'Validate persisted CFE project relations in the selected workspace.',
    command: '1c-metadata-tree.agent.cfe.validate',
    inputSchema: cfeValidateInput,
    annotations: READ_CLOSED,
  },
  {
    name: 'cdt_cfe_create_project',
    description: 'Create a CFE project and persist its relation to the selected base configuration.',
    command: '1c-metadata-tree.agent.cfe.createProject',
    inputSchema: cfeCreateProjectInput,
    annotations: WRITE_CLOSED,
  },
  {
    name: 'cdt_cfe_borrow_object',
    description: 'Borrow one supported root object from the linked base configuration into a CFE project.',
    command: '1c-metadata-tree.agent.cfe.borrowObject',
    inputSchema: cfeBorrowObjectInput,
    annotations: WRITE_CLOSED_IDEMPOTENT,
  },
  {
    name: 'cdt_cfe_create_interceptor',
    description: 'Create one structural BSL interceptor for an already borrowed CFE object.',
    command: '1c-metadata-tree.agent.cfe.createInterceptor',
    inputSchema: cfeInterceptorInput,
    annotations: WRITE_CLOSED_IDEMPOTENT,
  },
  {
    name: 'cdt_cfe_create_own_form',
    description: 'Create an extension-owned managed form under an existing CFE Catalog or Document.',
    command: '1c-metadata-tree.agent.cfe.createOwnForm',
    inputSchema: cfeCreateOwnFormInput,
    annotations: WRITE_CLOSED_IDEMPOTENT,
  },
  {
    name: 'cdt_cfe_borrow_form',
    description: 'Borrow one managed base form into an already borrowed CFE owner.',
    command: '1c-metadata-tree.agent.cfe.borrowForm',
    inputSchema: cfeBorrowFormInput,
    annotations: WRITE_CLOSED_IDEMPOTENT,
  },
  {
    name: 'cdt_cfe_extend_form',
    description: 'Apply additive CFE form extensions to a borrowed form with source hash protection.',
    command: '1c-metadata-tree.agent.cfe.extendForm',
    inputSchema: cfeExtendFormInput,
    annotations: WRITE_CLOSED_IDEMPOTENT,
  },
];
