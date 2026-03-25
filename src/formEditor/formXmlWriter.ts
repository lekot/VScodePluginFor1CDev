/**
 * Writes FormModel to Ext/Form.xml with backup (same approach as XMLWriter).
 */

import * as fs from 'fs';
import { XMLBuilder } from 'fast-xml-parser';
import { Logger } from '../utils/logger';
import type { FormModel, FormChildItem, FormEventItem } from './formModel';

const BUILDER_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  preserveOrder: true,
  ignoreNameSpace: true,
  format: true,
  indentBy: '\t',
};

function buildEventsArray(events: FormEventItem[]): unknown[] {
  return events.map((ev) => ({
    Event: [{ ':@': { '@_name': ev.name } }, { '#text': ev.method || '' }],
  }));
}

/** Normalize property value for XMLBuilder: skip undefined; primitives as text node; return array for preserveOrder. */
function normalizePropertyValue(v: unknown): unknown[] | undefined {
  if (v === undefined) {return undefined;}
  if (v === null) {return [{ '#text': '' }];}
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return [{ '#text': String(v) }];
  }
  if (Array.isArray(v)) {return v;}
  if (typeof v === 'object' && v !== null) {return [v];}
  return [{ '#text': String(v) }];
}

function localName(key: string): string {
  return key.includes(':') ? key.split(':').pop()! : key;
}

/**
 * fast-xml-parser XMLBuilder with preserveOrder:true expects each tag as
 * `{ TagName: children[], ':@'?: attrs }`, not `{ TagName: [ { ':@': attrs }, ...children ] }`.
 * The latter drops attributes (and a lone `{ ':@': ... }` list item has no tag name and is skipped).
 */
function normalizePreserveOrderNode(node: unknown): unknown {
  if (node === null || typeof node !== 'object') {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map(normalizePreserveOrderNode);
  }
  const o = node as Record<string, unknown>;
  const tagKeys = Object.keys(o).filter((k) => k !== ':@');
  if (tagKeys.length === 1) {
    const tag = tagKeys[0];
    const children = o[tag];
    if (Array.isArray(children) && children.length > 0) {
      const first = children[0];
      if (first !== null && typeof first === 'object' && !Array.isArray(first)) {
        const fo = first as Record<string, unknown>;
        if (Object.keys(fo).length === 1 && fo[':@'] !== undefined) {
          const attrs = fo[':@'];
          const rest = children.slice(1).map(normalizePreserveOrderNode);
          return {
            [tag]: rest.map(normalizePreserveOrderNode),
            ':@': attrs,
          };
        }
      }
      return { ...o, [tag]: children.map(normalizePreserveOrderNode) };
    }
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    out[k] = normalizePreserveOrderNode(v);
  }
  return out;
}

/**
 * preserveOrder + XMLBuilder: put name/id on sibling `:@` of the tag key (same object),
 * not as first node inside the tag array — otherwise attributes are dropped in output.
 */
function buildChildItem(item: FormChildItem): Record<string, unknown> {
  const content: unknown[] = [];
  const at: Record<string, string> = {};
  if (item.name != null && String(item.name) !== '') {at['@_name'] = String(item.name);}
  if (item.id != null && String(item.id) !== '') {at['@_id'] = String(item.id);}
  const props = item.properties ?? {};
  for (const [k, v] of Object.entries(props)) {
    if (k === ':@' || k.startsWith('@')) {continue;}
    const value = normalizePropertyValue(v);
    if (value === undefined) {continue;}
    content.push({ [k]: value });
  }
  if (item.childItems && item.childItems.length) {
    content.push({
      ChildItems: item.childItems.map((c) => buildChildItem(c)),
    });
  }
  if (item.events && Object.keys(item.events).length) {
    content.push({
      Events: buildEventsArray(
        Object.entries(item.events).map(([name, method]) => ({ name, method }))
      ),
    });
  }
  const wrap: Record<string, unknown> = { [item.tag]: content };
  if (Object.keys(at).length) {
    wrap[':@'] = at;
  }
  return wrap;
}

export function buildFormContent(model: FormModel): unknown[] {
  const formContent: unknown[] = [];
  const rootAttrs: Record<string, string> = {};
  if (model.xmlnsDeclarations && Object.keys(model.xmlnsDeclarations).length) {
    for (const [key, uri] of Object.entries(model.xmlnsDeclarations)) {
      rootAttrs[`@_${key}`] = uri;
    }
  } else {
    rootAttrs['@_xmlns'] = 'http://v8.1c.ru/8.3/xcf/logform';
  }
  if (model.version) {
    rootAttrs['@_version'] = model.version;
  } else {
    rootAttrs['@_version'] = '2.20';
  }
  formContent.push({ ':@': rootAttrs });
  const topLevelFields = model.topLevelFields ?? [];
  const rawCommandSet = topLevelFields.find((field) => localName(field.tag) === 'CommandSet');
  const rawParameters = topLevelFields.find((field) => localName(field.tag) === 'Parameters');
  const canWriteCommandSetFirstClass = model.commandSetFirstClassLossless !== false;
  const canWriteParametersFirstClass = model.parametersFirstClassLossless !== false;
  if (model.topLevelFields && model.topLevelFields.length) {
    for (const field of model.topLevelFields) {
      const tagName = localName(field.tag);
      if (tagName === 'CommandSet' || tagName === 'Parameters') {continue;}
      formContent.push({ [field.tag]: field.content });
    }
  }
  if (canWriteCommandSetFirstClass && model.excludedCommands && model.excludedCommands.length) {
    formContent.push({
      CommandSet: model.excludedCommands.map((commandName) => ({
        ExcludedCommand: [{ '#text': commandName }],
      })),
    });
  } else if (rawCommandSet) {
    formContent.push({ [rawCommandSet.tag]: rawCommandSet.content });
  }
  const autoCommandBarName = model.autoCommandBarName !== undefined && model.autoCommandBarName !== ''
    ? model.autoCommandBarName
    : 'ФормаКоманднаяПанель';
  const autoCommandBarId = model.autoCommandBarId !== undefined && model.autoCommandBarId !== ''
    ? model.autoCommandBarId
    : '-1';
  formContent.push({
    AutoCommandBar: [],
    ':@': {
      '@_name': autoCommandBarName,
      '@_id': autoCommandBarId,
    },
  });
  if (model.formEvents && model.formEvents.length) {
    formContent.push({ Events: buildEventsArray(model.formEvents) });
  }
  if (model.childItemsRoot && model.childItemsRoot.length) {
    formContent.push({
      ChildItems: model.childItemsRoot.map((c) => buildChildItem(c)),
    });
  }
  if (model.attributes && model.attributes.length) {
    formContent.push({
      Attributes: model.attributes.map((attr) => {
        const arr: unknown[] = [];
        const at: Record<string, string> = {};
        if (attr.name != null && String(attr.name) !== '') {at['@_name'] = String(attr.name);}
        if (attr.id != null && String(attr.id) !== '') {at['@_id'] = String(attr.id);}
        const props = attr.properties ?? {};
        for (const [k, v] of Object.entries(props)) {
          if (k === ':@' || k.startsWith('@')) {continue;}
          const value = normalizePropertyValue(v);
          if (value === undefined) {continue;}
          arr.push({ [k]: value });
        }
        const wrap: Record<string, unknown> = { Attribute: arr };
        if (Object.keys(at).length) {
          wrap[':@'] = at;
        }
        return wrap;
      }),
    });
  }
  if (canWriteParametersFirstClass && model.parameters && model.parameters.length) {
    formContent.push({
      Parameters: model.parameters.map((param) => {
        const arr: unknown[] = [];
        const at: Record<string, string> = {};
        if (param.name != null && String(param.name) !== '') {at['@_name'] = String(param.name);}
        if (param.id != null && String(param.id) !== '') {at['@_id'] = String(param.id);}
        const props = param.properties ?? {};
        for (const [k, v] of Object.entries(props)) {
          if (k === ':@' || k.startsWith('@')) {continue;}
          const value = normalizePropertyValue(v);
          if (value === undefined) {continue;}
          arr.push({ [k]: value });
        }
        const wrap: Record<string, unknown> = { Parameter: arr };
        if (Object.keys(at).length) {
          wrap[':@'] = at;
        }
        return wrap;
      }),
    });
  } else if (rawParameters) {
    formContent.push({ [rawParameters.tag]: rawParameters.content });
  }
  if (model.commands && model.commands.length) {
    formContent.push({
      Commands: model.commands.map((cmd) => {
        const arr: unknown[] = [];
        const at: Record<string, string> = {};
        if (cmd.name != null && String(cmd.name) !== '') {at['@_name'] = String(cmd.name);}
        if (cmd.id != null && String(cmd.id) !== '') {at['@_id'] = String(cmd.id);}
        const props = cmd.properties ?? {};
        for (const [k, v] of Object.entries(props)) {
          if (k === ':@' || k.startsWith('@')) {continue;}
          const value = normalizePropertyValue(v);
          if (value === undefined) {continue;}
          arr.push({ [k]: value });
        }
        const wrap: Record<string, unknown> = { Command: arr };
        if (Object.keys(at).length) {
          wrap[':@'] = at;
        }
        return wrap;
      }),
    });
  }
  return formContent;
}

const DEFAULT_LOGFORM_XMLNS = 'http://v8.1c.ru/8.3/xcf/logform';

function escapeXmlAttrValue(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * XMLBuilder often omits `version` and sometimes `xmlns` on the opening &lt;Form&gt; tag.
 * Ensures both are present for platform-compatible Ext/Form.xml (B.1 / sprint spec).
 */
export function injectMissingFormOpenTagAttrs(xmlString: string, model: FormModel): string {
  const versionRaw = (model.version && model.version.trim()) || '2.20';
  const version = escapeXmlAttrValue(versionRaw);
  return xmlString.replace(/<Form(\s[^>]*)?>/, (_full, inner: string | undefined) => {
    const attrs = inner ?? '';
    let add = '';
    if (!/\bxmlns\s*=/.test(attrs)) {
      add += ` xmlns="${DEFAULT_LOGFORM_XMLNS}"`;
    }
    if (!/\bversion\s*=/.test(attrs)) {
      add += ` version="${version}"`;
    }
    if (!add) {
      return `<Form${attrs}>`;
    }
    return `<Form${attrs}${add}>`;
  });
}

/**
 * Inject xmlns declarations into the <Form ...> opening tag.
 * XMLBuilder with ignoreNameSpace:true strips xmlns:* attributes, so we do it via string post-processing.
 */
export function injectXmlnsIntoFormTag(xmlString: string, xmlnsDeclarations: Record<string, string>): string {
  if (!Object.keys(xmlnsDeclarations).length) {return xmlString;}
  // Build xmlns attribute string, sorted for determinism (xmlns first, then xmlns:* alphabetically)
  const entries = Object.entries(xmlnsDeclarations).sort(([a], [b]) => {
    if (a === 'xmlns') {return -1;}
    if (b === 'xmlns') {return 1;}
    return a.localeCompare(b);
  });
  const xmlnsStr = entries.map(([k, v]) => `${k}="${v}"`).join(' ');
  // Replace <Form ...> or <Form> — insert xmlns before version or at end of opening tag
  return xmlString.replace(/^(<Form)(\s[^>]*>|>)/m, (_match, tag, rest) => {
    // rest may be ' version="2.20">' or '>'
    // Insert xmlns declarations right after <Form
    return `${tag} ${xmlnsStr}${rest}`;
  });
}

/**
 * Write FormModel to Ext/Form.xml. Creates backup before write; on write failure restores from backup.
 */
export async function writeFormXml(formXmlPath: string, model: FormModel): Promise<void> {
  const rawContent = buildFormContent(model);
  const head = rawContent[0] as Record<string, unknown> | undefined;
  const formAttrs =
    head && typeof head === 'object' && Object.keys(head).length === 1 && head[':@'] !== undefined
      ? (head[':@'] as Record<string, string>)
      : {};
  const body = head && Object.keys(head).length === 1 && head[':@'] !== undefined ? rawContent.slice(1) : rawContent;
  const normalizedBody = body.map(normalizePreserveOrderNode);
  const root = [{ Form: normalizedBody, ':@': formAttrs }];
  const builder = new XMLBuilder(BUILDER_OPTIONS);
  let xmlString: string;
  try {
    xmlString = builder.build(root);
  } catch (buildErr) {
    Logger.error(`Failed to build Form.xml for ${formXmlPath}`, buildErr);
    throw new Error(
      `Не удалось сформировать Form.xml. ${buildErr instanceof Error ? buildErr.message : String(buildErr)}`
    );
  }

  // Inject xmlns declarations (XMLBuilder strips them with ignoreNameSpace:true)
  if (model.xmlnsDeclarations && Object.keys(model.xmlnsDeclarations).length) {
    xmlString = injectXmlnsIntoFormTag(xmlString, model.xmlnsDeclarations);
  }
  xmlString = injectMissingFormOpenTagAttrs(xmlString, model);

  // Validate: never write empty Form when model has content
  if ((model.childItemsRoot?.length ?? 0) > 0 && /^<Form\s*\/>$|^<Form>\s*<\/Form>$/.test(xmlString.trim())) {
    throw new Error(
      'Validation failed: XMLBuilder generated empty <Form> for a non-empty model. Write aborted.'
    );
  }

  const declaration = '<?xml version="1.0" encoding="UTF-8"?>\n';
  const fullContent = declaration + xmlString;

  let existingContent: string;
  try {
    existingContent = await fs.promises.readFile(formXmlPath, 'utf-8');
  } catch (readErr) {
    existingContent = '';
  }
  const backupPath = `${formXmlPath}.bak`;
  try {
    await fs.promises.writeFile(backupPath, existingContent || fullContent, 'utf-8');
  } catch (backupErr) {
    Logger.warn(`Failed to create backup ${backupPath}`, backupErr);
  }
  try {
    await fs.promises.writeFile(formXmlPath, fullContent, 'utf-8');
  } catch (writeErr) {
    Logger.error(`Failed to write Form.xml: ${formXmlPath}`, writeErr);
    try {
      if (fs.existsSync(backupPath)) {
        const restored = await fs.promises.readFile(backupPath, 'utf-8');
        await fs.promises.writeFile(formXmlPath, restored, 'utf-8');
        await fs.promises.unlink(backupPath);
        Logger.info(`Rolled back ${formXmlPath} from backup`);
      }
    } catch (rollbackErr) {
      Logger.error(`Rollback failed for ${formXmlPath}`, rollbackErr);
    }
    throw new Error(
      `Не удалось записать файл. ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`
    );
  }
  try {
    if (fs.existsSync(backupPath)) {await fs.promises.unlink(backupPath);}
  } catch {
    Logger.debug(`Could not remove backup ${backupPath}`);
  }
  Logger.info(`Form.xml written: ${formXmlPath}`);
}
