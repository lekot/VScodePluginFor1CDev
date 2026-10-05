import { z } from 'zod';
import type { McpToolDefinition } from './types';
import { READ_CLOSED, READ_OPEN, WRITE_CLOSED, WRITE_OPEN } from './types';
import { configurationScopeShape, emptyInput, nonEmptyString, trimmedNonEmptyString } from './schemas';
import { FORM_FORMAT_VERSIONS } from '../../agentStaticForms';
import type { FormChildItem } from '../../../formEditor/formModel';

const formsStartInput = z.strictObject({
  driver: z.literal('native').optional(),
  port: z.number().int().min(1).max(65535),
  host: z.string().optional(),
  platformVersion: z.string().optional(),
  background: z.boolean().default(true),
});

const formsLaunchInput = z.strictObject({
  dbPath: trimmedNonEmptyString.optional(),
  infobaseId: trimmedNonEmptyString.optional(),
  platformPath: trimmedNonEmptyString.optional(),
  port: z.number().int().min(1).max(65535).optional(),
  waitTimeoutMs: z.number().int().min(1_000).max(120_000).optional(),
  background: z.boolean().default(true),
}).refine((value) => Number(Boolean(value.dbPath)) + Number(Boolean(value.infobaseId)) === 1, {
  message: 'provide exactly one of dbPath or infobaseId',
});

const formsShotInput = z.strictObject({ file: z.string().optional(), timeoutMs: z.number().int().positive().optional(), background: z.boolean().default(true) });
const nativeRef = z.strictObject({ id: nonEmptyString });
const nativeCommon = {
  timeoutMs: z.number().int().positive().optional(),
  background: z.boolean().default(true),
};
const formsNativeInput = z.discriminatedUnion('action', [
  z.strictObject({
    ...nativeCommon,
    action: z.literal('overview'),
    maxDepth: z.number().int().min(0).max(20).optional(),
    maxNodes: z.number().int().positive().max(2000).optional(),
  }),
  z.strictObject({
    ...nativeCommon,
    action: z.literal('commandInterface'),
    maxDepth: z.number().int().min(0).max(10).optional(),
    maxNodes: z.number().int().positive().max(1000).optional(),
  }),
  z.strictObject({ ...nativeCommon, action: z.literal('executeCommand'), url: nonEmptyString }),
  z.strictObject({
    ...nativeCommon,
    action: z.literal('find'),
    name: z.string().optional(),
    className: z.string().optional(),
    text: z.string().optional(),
    exact: z.boolean().optional(),
  }),
  z.strictObject({ ...nativeCommon, action: z.literal('readField'), ref: nativeRef }),
  z.strictObject({
    ...nativeCommon,
    action: z.literal('writeField'),
    ref: nativeRef,
    value: z.string(),
  }),
  z.strictObject({
    ...nativeCommon,
    action: z.literal('act'),
    ref: nativeRef,
    method: z.enum(['click', 'activate']),
  }),
  z.strictObject({
    ...nativeCommon,
    action: z.literal('readTable'),
    ref: nativeRef,
    maxRows: z.number().int().min(0).max(10000).optional(),
  }),
  z.strictObject({
    ...nativeCommon,
    action: z.literal('formContext'),
    includeTables: z.boolean().optional(),
    maxDepth: z.number().int().min(0).max(10).optional(),
    maxNodes: z.number().int().positive().max(1000).optional(),
    maxRows: z.number().int().min(0).max(10000).optional(),
  }),
  z.strictObject({
    ...nativeCommon,
    action: z.literal('createSnapshot'),
    includeTables: z.boolean().optional(),
    maxDepth: z.number().int().min(0).max(10).optional(),
    maxNodes: z.number().int().positive().max(1000).optional(),
    maxRows: z.number().int().min(0).max(10000).optional(),
  }),
  z.strictObject({
    ...nativeCommon,
    action: z.literal('compareSnapshot'),
    snapshotId: nonEmptyString,
  }),
  z.strictObject({ ...nativeCommon, action: z.literal('listSnapshots') }),
  z.strictObject({ ...nativeCommon, action: z.literal('deleteSnapshot'), snapshotId: nonEmptyString }),
  z.strictObject({
    ...nativeCommon,
    action: z.literal('uiLog'),
    operation: z.enum(['start', 'finish', 'pause', 'resume', 'cancel']),
  }),
]).refine((value) => value.action !== 'find' || Boolean(value.name || value.className || value.text), {
  message: 'find requires at least one of name, className, or text',
});
const staticFormPath = z.string().refine((value) => {
  const target = value.trim();
  if (!target || target.includes('\0') || /^(?:[\\/]|[A-Za-z]:)/.test(target)) { return false; }
  const segments = target.replace(/\\/g, '/').split('/');
  if (segments.some((segment) => segment === '..' || segment === '')) { return false; }
  const category = segments[segments.length - 4]?.toLowerCase();
  return (category === 'forms' || category === 'commonforms')
    && Boolean(segments[segments.length - 3])
    && segments[segments.length - 2]?.toLowerCase() === 'ext'
    && segments[segments.length - 1]?.toLowerCase() === 'form.xml';
}, { message: 'must point to Forms/<name>/Ext/Form.xml or CommonForms/<name>/Ext/Form.xml' });

const formsInspectInput = z.strictObject({
  ...configurationScopeShape,
  formPath: staticFormPath,
});

const formsValidateInput = z.strictObject({
  ...configurationScopeShape,
  formPath: staticFormPath,
  formatVersion: z.enum(FORM_FORMAT_VERSIONS).optional(),
});

const formXmlSelector = z.strictObject({
  id: z.string().optional(),
  name: z.string().optional(),
}).refine((selector) => Boolean(selector.id || selector.name), {
  message: 'selector requires id or name',
});

const formXmlChildItem: z.ZodType<FormChildItem> = z.lazy(() => z.strictObject({
  tag: nonEmptyString,
  id: z.string().optional(),
  name: z.string(),
  properties: z.record(z.string(), z.unknown()),
  childItems: z.array(formXmlChildItem),
  events: z.record(z.string(), z.string()).optional(),
}));

const formXmlProperties = z.record(z.string(), z.unknown());
const formXmlEdit = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('setProperties'),
    element: formXmlSelector,
    properties: formXmlProperties,
  }),
  z.strictObject({
    type: z.literal('setElementIdentity'),
    element: formXmlSelector,
    name: z.string().optional(),
    id: z.string().optional(),
  }).refine((edit) => edit.name !== undefined || edit.id !== undefined, {
    message: 'setElementIdentity requires name or id',
  }),
  z.strictObject({
    type: z.literal('setElementEvents'),
    element: formXmlSelector,
    events: z.record(z.string(), z.string()),
  }),
  z.strictObject({
    type: z.literal('setFormEvents'),
    events: z.array(z.strictObject({ name: z.string(), method: z.string() })),
  }),
  z.strictObject({
    type: z.literal('addElement'),
    parent: formXmlSelector.optional(),
    index: z.number().int().nonnegative(),
    item: formXmlChildItem,
  }),
  z.strictObject({
    type: z.literal('moveElement'),
    element: formXmlSelector,
    parent: formXmlSelector.optional(),
    index: z.number().int().nonnegative(),
  }),
  z.strictObject({
    type: z.literal('removeElement'),
    element: formXmlSelector,
  }),
  z.strictObject({
    type: z.literal('setAttribute'),
    action: z.enum(['upsert', 'remove']),
    selector: formXmlSelector.optional(),
    name: z.string().optional(),
    id: z.string().optional(),
    properties: formXmlProperties.optional(),
  }).superRefine((edit, context) => {
    if (edit.action === 'upsert' && !edit.name) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'upsert requires name' });
    }
    if (edit.action === 'remove' && !edit.selector && !edit.name && !edit.id) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'remove requires selector, name or id' });
    }
  }),
  z.strictObject({
    type: z.literal('setCommand'),
    action: z.enum(['upsert', 'remove']),
    selector: formXmlSelector.optional(),
    name: z.string().optional(),
    id: z.string().optional(),
    properties: formXmlProperties.optional(),
  }).superRefine((edit, context) => {
    if (edit.action === 'upsert' && !edit.name) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'upsert requires name' });
    }
    if (edit.action === 'remove' && !edit.selector && !edit.name && !edit.id) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'remove requires selector, name or id' });
    }
  }),
]);

const formsEditInput = z.strictObject({
  ...configurationScopeShape,
  formPath: staticFormPath,
  operations: z.array(formXmlEdit).min(1),
  dryRun: z.boolean().optional(),
  ifRev: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});

export const FORMS_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'cdt_forms_discover',
    description: 'Find local Windows 1C TestClient processes that are listening on the exact port passed with /TestClient. Returns only PID and port; command lines and credentials are never returned.',
    command: '1c-metadata-tree.agent.forms.discover',
    inputSchema: emptyInput,
    annotations: READ_OPEN,
  },
  {
    name: 'cdt_forms_launch',
    description: 'Launch a local Windows native TestClient for one file path or Infobase Manager entry and retry native attach while it becomes ready. Default wait is 90 seconds, configurable up to 120 seconds; confirm any 1C modal prompts during this time. Returns a task receipt by default; set background=false to wait synchronously.',
    command: '1c-metadata-tree.agent.forms.launch',
    inputSchema: formsLaunchInput,
    annotations: WRITE_OPEN,
  },
  {
    name: 'cdt_forms_start',
    description: 'Connect to an already-running native 1C TestClient by TCP port. The optional driver must be "native"; host defaults to 127.0.0.1. Returns a task receipt by default; set background=false to wait synchronously.',
    command: '1c-metadata-tree.agent.forms.start',
    inputSchema: formsStartInput,
    annotations: WRITE_OPEN,
  },
  {
    name: 'cdt_forms_stop',
    description: 'Close the forms session connection. This does not stop the 1C TestClient process.',
    command: '1c-metadata-tree.agent.forms.stop',
    inputSchema: emptyInput,
    annotations: WRITE_OPEN,
  },
  {
    name: 'cdt_forms_shot',
    description: 'Capture the exact native TestClient window identified by the active session port. Requires an active session and a local Windows TestClient; remote or unavailable windows return an error. Optionally overwrites a local file. Returns a task receipt by default; set background=false to wait synchronously.',
    command: '1c-metadata-tree.agent.forms.shot',
    inputSchema: formsShotInput,
    annotations: WRITE_OPEN,
  },
  {
    name: 'cdt_forms_status',
    description: 'Read whether a native TestClient session is connected and its host and port.',
    command: '1c-metadata-tree.agent.forms.status',
    inputSchema: emptyInput,
    annotations: READ_OPEN,
  },
  {
    name: 'cdt_forms_native',
    description: 'Inspect or interact with an already-running 1C TestClient: read its form and command interface, execute a navigation URL, read table rows, capture local snapshots and compare them, or control its UI scenario recording. Table reading may temporarily change selection; the result reports whether restoration was verified. Requires forms.start with an explicit port.',
    command: '1c-metadata-tree.agent.forms.native',
    inputSchema: formsNativeInput,
    annotations: WRITE_OPEN,
  },
  {
    name: 'cdt_form_inspect',
    description: 'Read a configuration Form.xml as a stable JSON tree with attributes, commands, and source SHA-256 revision.',
    command: '1c-metadata-tree.agent.forms.inspect',
    inputSchema: formsInspectInput,
    annotations: READ_CLOSED,
  },
  {
    name: 'cdt_form_validate',
    description: 'Validate a configuration Form.xml statically, including structure, references, and available module handlers.',
    command: '1c-metadata-tree.agent.forms.validate',
    inputSchema: formsValidateInput,
    annotations: READ_CLOSED,
  },
  {
    name: 'cdt_form_edit',
    description: 'Edit a configuration Form.xml with a reviewable dry run and SHA-256 compare-and-swap commit.',
    command: '1c-metadata-tree.agent.forms.edit',
    inputSchema: formsEditInput,
    annotations: WRITE_CLOSED,
  },
] as const;
