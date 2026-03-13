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

function buildChildItem(item: FormChildItem): Record<string, unknown[]> {
  const content: unknown[] = [];
  const at: Record<string, string> = {};
  if (item.name) at['@_name'] = item.name;
  if (item.id) at['@_id'] = item.id;
  if (Object.keys(at).length) content.push({ ':@': at });
  for (const [k, v] of Object.entries(item.properties)) {
    if (k === ':@' || k.startsWith('@')) continue;
    content.push({ [k]: v });
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
  return { [item.tag]: content };
}

function buildFormContent(model: FormModel): unknown[] {
  const formContent: unknown[] = [];
  formContent.push({
    ':@': {
      '@_xmlns': 'http://v8.1c.ru/8.3/xcf/logform',
      '@_version': '2.20',
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
        if (attr.name) at['@_name'] = attr.name;
        if (attr.id) at['@_id'] = attr.id;
        if (Object.keys(at).length) arr.push({ ':@': at });
        for (const [k, v] of Object.entries(attr.properties)) {
          if (k === ':@' || k.startsWith('@')) continue;
          arr.push({ [k]: v });
        }
        return { Attribute: arr };
      }),
    });
  }
  if (model.commands && model.commands.length) {
    formContent.push({
      Commands: model.commands.map((cmd) => {
        const arr: unknown[] = [];
        const at: Record<string, string> = {};
        if (cmd.name) at['@_name'] = cmd.name;
        if (cmd.id) at['@_id'] = cmd.id;
        if (Object.keys(at).length) arr.push({ ':@': at });
        for (const [k, v] of Object.entries(cmd.properties)) {
          if (k === ':@' || k.startsWith('@')) continue;
          arr.push({ [k]: v });
        }
        return { Command: arr };
      }),
    });
  }
  return formContent;
}

/**
 * Write FormModel to Ext/Form.xml. Creates backup before write; on write failure restores from backup.
 */
export async function writeFormXml(formXmlPath: string, model: FormModel): Promise<void> {
  const root = [{ Form: buildFormContent(model) }];
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
    if (fs.existsSync(backupPath)) await fs.promises.unlink(backupPath);
  } catch {
    Logger.debug(`Could not remove backup ${backupPath}`);
  }
  Logger.info(`Form.xml written: ${formXmlPath}`);
}
