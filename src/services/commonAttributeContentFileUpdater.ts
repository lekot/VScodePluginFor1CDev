/**
 * Reads and writes CommonAttribute Content from the main XML file.
 * XML path: MetaDataObject → CommonAttribute → Properties → Content → xr:Item
 */
import * as fs from 'fs';
import { XmlParser } from '../parsers/xmlParser';
import { validateSubsystemCompositionRef } from '../parsers/xmlChildObjects';
import type { ContentReadResult, ContentUpdateDiff } from '../compositionEditor/compositionContracts';

function localName(key: string): string {
  return key.includes(':') ? key.split(':').pop()! : key;
}

function getValueByLocalName(obj: Record<string, unknown>, name: string): unknown {
  for (const [k, v] of Object.entries(obj)) {
    if (k === ':@' || k === '@_' || k.startsWith('#')) {
      continue;
    }
    if (localName(k) === name) {
      return v;
    }
  }
  return undefined;
}

function getCommonAttributePropertiesFromParsed(parsed: Record<string, unknown>): Record<string, unknown> | null {
  const metaRaw = getValueByLocalName(parsed, 'MetaDataObject');
  if (metaRaw === undefined || metaRaw === null) {
    return null;
  }
  const meta = Array.isArray(metaRaw) ? metaRaw[0] : metaRaw;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return null;
  }
  const caRaw = getValueByLocalName(meta as Record<string, unknown>, 'CommonAttribute');
  if (caRaw === undefined || caRaw === null) {
    return null;
  }
  const caObj = Array.isArray(caRaw) ? caRaw[0] : caRaw;
  if (!caObj || typeof caObj !== 'object' || Array.isArray(caObj)) {
    return null;
  }
  const propsRaw = getValueByLocalName(caObj as Record<string, unknown>, 'Properties');
  if (!propsRaw || typeof propsRaw !== 'object' || Array.isArray(propsRaw)) {
    return null;
  }
  return propsRaw as Record<string, unknown>;
}

function extractItems(contentRaw: unknown): Array<{ ref: string; use: string }> {
  if (!contentRaw || typeof contentRaw !== 'object') {
    return [];
  }
  const content = Array.isArray(contentRaw) ? contentRaw[0] : contentRaw;
  if (!content || typeof content !== 'object') {
    return [];
  }
  const itemsRaw = getValueByLocalName(content as Record<string, unknown>, 'Item');
  if (!itemsRaw) {
    return [];
  }
  const items = Array.isArray(itemsRaw) ? itemsRaw : [itemsRaw];
  const result: Array<{ ref: string; use: string }> = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const metadataRaw = getValueByLocalName(item as Record<string, unknown>, 'Metadata');
    const useRaw = getValueByLocalName(item as Record<string, unknown>, 'Use');
    const ref = typeof metadataRaw === 'string' ? metadataRaw.trim() : '';
    const use = typeof useRaw === 'string' ? useRaw.trim() : 'Use';
    if (ref) {
      result.push({ ref, use });
    }
  }
  return result;
}

function buildContentItems(
  refsWithUse: Array<{ ref: string; use: string }>,
): unknown {
  const items = refsWithUse.map(({ ref, use }) => ({
    'xr:Metadata': ref,
    'xr:Use': use,
    'xr:ConditionalSeparation': '',
  }));
  return { 'xr:Item': items };
}

export async function readCommonAttributeContent(filePath: string): Promise<ContentReadResult> {
  const parsed = await XmlParser.parseFileAsync(filePath);
  const props = getCommonAttributePropertiesFromParsed(parsed);
  if (!props) {
    return { refs: [], itemSettings: new Map() };
  }
  const items = extractItems(props.Content);
  const refs = items.map((i) => i.ref);
  const itemSettings = new Map<string, Record<string, string>>();
  for (const { ref, use } of items) {
    itemSettings.set(ref, { Use: use });
  }
  return { refs, itemSettings };
}

export async function applyCommonAttributeContentUpdate(
  filePath: string,
  diff: ContentUpdateDiff,
): Promise<{ rejected: Array<{ ref: string; reason: string }> }> {
  const parsed = await XmlParser.parseFileAsync(filePath);
  const props = getCommonAttributePropertiesFromParsed(parsed);
  if (!props) {
    throw new Error(
      `Not a CommonAttribute metadata file (expected MetaDataObject/CommonAttribute/Properties): ${filePath}`,
    );
  }

  const currentItems = extractItems(props.Content);
  const rejected: Array<{ ref: string; reason: string }> = [];

  // Build working map: ref → use value
  const workingMap = new Map<string, string>(currentItems.map(({ ref, use }) => [ref, use]));

  // Apply removals
  for (const ref of diff.remove) {
    workingMap.delete(ref);
  }

  // Apply additions (validate first)
  for (const raw of diff.add) {
    const ref = typeof raw === 'string' ? raw.trim() : '';
    const err = validateSubsystemCompositionRef(ref);
    if (err) {
      rejected.push({ ref: String(raw), reason: err });
      continue;
    }
    if (!workingMap.has(ref)) {
      workingMap.set(ref, 'Use');
    }
  }

  // Apply settings changes
  for (const [ref, settings] of diff.settingsChanged) {
    if (workingMap.has(ref) && settings.Use !== undefined) {
      workingMap.set(ref, settings.Use);
    }
  }

  const refsWithUse = Array.from(workingMap.entries()).map(([ref, use]) => ({ ref, use }));
  props.Content = buildContentItems(refsWithUse);

  const xml = XmlParser.objectToXml(parsed);
  await fs.promises.writeFile(filePath, xml, 'utf-8');

  return { rejected };
}
