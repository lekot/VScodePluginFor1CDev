/**
 * Reads and writes CommonAttribute Content from the main XML file.
 * XML path: MetaDataObject → CommonAttribute → Properties → Content → xr:Item
 */
import * as fs from 'fs';
import { XmlParser } from '../parsers/xmlParser';
import { validateSubsystemCompositionRef } from '../parsers/xmlChildObjects';
import type { ContentReadResult, ContentUpdateDiff } from '../compositionEditor/compositionContracts';
import { getValueByLocalName, getPropertiesFromParsed } from '../parsers/xmlNavHelpers';

function extractItems(contentRaw: unknown): Array<{ ref: string; use: string; condSep: string }> {
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
  const result: Array<{ ref: string; use: string; condSep: string }> = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const metadataRaw = getValueByLocalName(item as Record<string, unknown>, 'Metadata');
    const useRaw = getValueByLocalName(item as Record<string, unknown>, 'Use');
    const condSepRaw = getValueByLocalName(item as Record<string, unknown>, 'ConditionalSeparation');
    const ref = typeof metadataRaw === 'string' ? metadataRaw.trim() : '';
    const use = typeof useRaw === 'string' ? useRaw.trim() : 'Use';
    const condSep = typeof condSepRaw === 'string' ? condSepRaw : '';
    if (ref) {
      result.push({ ref, use, condSep });
    }
  }
  return result;
}

function buildContentItems(
  refsWithSettings: Array<{ ref: string; use: string; condSep: string }>,
): unknown {
  const items = refsWithSettings.map(({ ref, use, condSep }) => ({
    'xr:Metadata': ref,
    'xr:Use': use,
    'xr:ConditionalSeparation': condSep,
  }));
  return { 'xr:Item': items };
}

export async function readCommonAttributeContent(filePath: string): Promise<ContentReadResult> {
  const parsed = await XmlParser.parseFileAsync(filePath);
  const props = getPropertiesFromParsed(parsed, 'CommonAttribute');
  if (!props) {
    return { refs: [], itemSettings: new Map() };
  }
  const items = extractItems(props.Content);
  const refs = items.map((i) => i.ref);
  const itemSettings = new Map<string, Record<string, string>>();
  for (const { ref, use, condSep } of items) {
    itemSettings.set(ref, { Use: use, ConditionalSeparation: condSep });
  }
  return { refs, itemSettings };
}

export async function applyCommonAttributeContentUpdate(
  filePath: string,
  diff: ContentUpdateDiff,
): Promise<{ rejected: Array<{ ref: string; reason: string }> }> {
  const parsed = await XmlParser.parseFileAsync(filePath);
  const props = getPropertiesFromParsed(parsed, 'CommonAttribute');
  if (!props) {
    throw new Error(
      `Not a CommonAttribute metadata file (expected MetaDataObject/CommonAttribute/Properties): ${filePath}`,
    );
  }

  const currentItems = extractItems(props.Content);
  const rejected: Array<{ ref: string; reason: string }> = [];

  // Build working map: ref → { use, condSep }
  const workingMap = new Map<string, { use: string; condSep: string }>(
    currentItems.map(({ ref, use, condSep }) => [ref, { use, condSep }]),
  );

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
      workingMap.set(ref, { use: 'Use', condSep: '' });
    }
  }

  // Apply settings changes (only update Use; condSep is not user-editable)
  for (const [ref, settings] of diff.settingsChanged) {
    const current = workingMap.get(ref);
    if (current !== undefined && settings.Use !== undefined) {
      workingMap.set(ref, { use: settings.Use, condSep: current.condSep });
    }
  }

  const refsWithSettings = Array.from(workingMap.entries()).map(([ref, { use, condSep }]) => ({ ref, use, condSep }));
  props.Content = buildContentItems(refsWithSettings);

  const xml = XmlParser.objectToXml(parsed);
  await fs.promises.writeFile(filePath, xml, 'utf-8');

  return { rejected };
}
