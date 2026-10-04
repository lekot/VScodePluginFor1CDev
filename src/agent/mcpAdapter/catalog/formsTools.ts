import { z } from 'zod';
import type { McpToolDefinition } from './types';
import { READ_CLOSED, READ_OPEN, WRITE_CLOSED, WRITE_OPEN } from './types';
import { configurationScopeShape, emptyInput, nonEmptyString } from './schemas';
import { FORM_FORMAT_VERSIONS } from '../../agentStaticForms';
import type { FormChildItem } from '../../../formEditor/formModel';

const formsStartInput = z.strictObject({
  url: z.string().optional(),
  dbPath: z.string().optional(),
  platformPath: z.string().optional(),
  readyTimeoutMs: z.number().optional(),
  background: z.boolean().default(true),
}).refine((value) => Boolean(value.url || value.dbPath), {
  message: 'url or dbPath is required',
});

const formsExecInput = z.strictObject({
  script: nonEmptyString,
  timeoutMs: z.number().optional(),
  background: z.boolean().default(true),
});

const formsShotInput = z.strictObject({ file: z.string().optional(), background: z.boolean().default(true) });
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
    name: 'cdt_forms_start',
    description: 'Start or connect to a 1C web-client forms session. Returns a task receipt by default; set background=false to wait synchronously. When both dbPath and url are present, dbPath takes priority.',
    command: '1c-metadata-tree.agent.forms.start',
    inputSchema: formsStartInput,
    annotations: WRITE_OPEN,
  },
  {
    name: 'cdt_forms_exec',
    description: 'Execute arbitrary JavaScript in the connected 1C forms browser session. Returns a task receipt by default; set background=false to wait synchronously.',
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
    description: 'Capture a screenshot of the connected 1C forms browser, optionally overwriting a local file. Returns a task receipt by default; set background=false to wait synchronously.',
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
