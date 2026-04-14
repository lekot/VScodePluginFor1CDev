/**
 * B.x — persist ExchangePlan `Ext/Content.xml` composition.
 */
import * as fs from 'fs';
import * as path from 'path';
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

/**
 * Navigate to the Item array inside the parsed ExchangePlanContent root.
 * Returns null if the root element is not found.
 */
function getItemsFromParsed(parsed: Record<string, unknown>): unknown[] | null {
  const contentRaw = getValueByLocalName(parsed, 'ExchangePlanContent');
  if (contentRaw === undefined || contentRaw === null) {
    return null;
  }
  const content = Array.isArray(contentRaw) ? contentRaw[0] : contentRaw;
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    return null;
  }
  const itemsRaw = getValueByLocalName(content as Record<string, unknown>, 'Item');
  if (itemsRaw === undefined || itemsRaw === null) {
    return [];
  }
  return Array.isArray(itemsRaw) ? itemsRaw : [itemsRaw];
}

/**
 * Navigate to the ExchangePlanContent element (as a mutable object) and return
 * a setter that replaces its Item list.
 */
function getContentNodeAndSetter(
  parsed: Record<string, unknown>,
): { contentNode: Record<string, unknown>; setItems: (items: unknown[]) => void } | null {
  for (const [k, v] of Object.entries(parsed)) {
    if (k === ':@' || k === '@_' || k.startsWith('#')) {
      continue;
    }
    if (localName(k) === 'ExchangePlanContent') {
      const arr = Array.isArray(v) ? v : [v];
      const contentNode = arr[0] as Record<string, unknown>;
      const itemKey = Object.keys(contentNode).find(
        (ck) => ck !== ':@' && ck !== '@_' && !ck.startsWith('#') && localName(ck) === 'Item',
      );
      const setItems = (items: unknown[]) => {
        if (itemKey) {
          (contentNode as Record<string, unknown>)[itemKey] = items;
        } else {
          // No Item key yet — insert plain 'Item'
          (contentNode as Record<string, unknown>)['Item'] = items;
        }
      };
      return { contentNode, setItems };
    }
  }
  return null;
}

/**
 * Read ExchangePlan `Content.xml` and return current refs + AutoRecord settings.
 * Returns empty result if the file does not exist.
 */
export async function readExchangePlanContent(filePath: string): Promise<ContentReadResult> {
  try {
    await fs.promises.access(filePath);
  } catch {
    return { refs: [], itemSettings: new Map() };
  }

  const parsed = await XmlParser.parseFileAsync(filePath);
  const items = getItemsFromParsed(parsed);
  if (!items) {
    return { refs: [], itemSettings: new Map() };
  }

  const refs: string[] = [];
  const itemSettings: Map<string, Record<string, string>> = new Map();

  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const metaRaw = getValueByLocalName(item as Record<string, unknown>, 'Metadata');
    const autoRaw = getValueByLocalName(item as Record<string, unknown>, 'AutoRecord');

    const ref = typeof metaRaw === 'string' ? metaRaw.trim() : String(metaRaw ?? '').trim();
    const autoRecord = typeof autoRaw === 'string' ? autoRaw.trim() : 'Allow';

    if (!ref) {
      continue;
    }
    refs.push(ref);
    itemSettings.set(ref, { AutoRecord: autoRecord });
  }

  return { refs, itemSettings };
}

/**
 * Apply add/remove/settingsChanged diff to ExchangePlan `Content.xml` and write back.
 */
export async function applyExchangePlanContentUpdate(
  filePath: string,
  diff: ContentUpdateDiff,
): Promise<{ rejected: Array<{ ref: string; reason: string }> }> {
  const rejected: Array<{ ref: string; reason: string }> = [];

  // Read existing content (or start with empty state)
  let parsed: Record<string, unknown>;
  let existingRefs: string[];
  let existingSettings: Map<string, Record<string, string>>;

  try {
    await fs.promises.access(filePath);
    parsed = await XmlParser.parseFileAsync(filePath);
    const items = getItemsFromParsed(parsed);
    existingRefs = [];
    existingSettings = new Map();
    if (items) {
      for (const item of items) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) { continue; }
        const metaRaw = getValueByLocalName(item as Record<string, unknown>, 'Metadata');
        const autoRaw = getValueByLocalName(item as Record<string, unknown>, 'AutoRecord');
        const ref = typeof metaRaw === 'string' ? metaRaw.trim() : String(metaRaw ?? '').trim();
        if (!ref) { continue; }
        existingRefs.push(ref);
        existingSettings.set(ref, { AutoRecord: typeof autoRaw === 'string' ? autoRaw.trim() : 'Allow' });
      }
    }
  } catch {
    // File does not exist — build a minimal root
    parsed = {
      ExchangePlanContent: {
        '@_xmlns': 'http://v8.1c.ru/8.3/xcf/extrnprops',
        '@_xmlns:xr': 'http://v8.1c.ru/8.3/xcf/readable',
        '@_xmlns:xs': 'http://www.w3.org/2001/XMLSchema',
        '@_xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
        '@_version': '2.20',
        Item: [],
      },
    };
    existingRefs = [];
    existingSettings = new Map();
  }

  // Build working set: start from existing refs
  const seen = new Set(existingRefs);
  const out: string[] = [...existingRefs];
  const settingsMap: Map<string, Record<string, string>> = new Map(existingSettings);

  // Apply removes
  for (const ref of diff.remove) {
    const trimmed = ref.trim();
    if (seen.has(trimmed)) {
      seen.delete(trimmed);
      const idx = out.indexOf(trimmed);
      if (idx !== -1) {
        out.splice(idx, 1);
      }
      settingsMap.delete(trimmed);
    }
  }

  // Apply adds
  for (const raw of diff.add) {
    const ref = typeof raw === 'string' ? raw.trim() : '';
    const err = validateSubsystemCompositionRef(ref);
    if (err) {
      rejected.push({ ref: String(raw), reason: err });
      continue;
    }
    if (seen.has(ref)) {
      continue;
    }
    seen.add(ref);
    out.push(ref);
    settingsMap.set(ref, { AutoRecord: 'Allow' });
  }

  // Apply settings changes
  for (const [ref, settings] of diff.settingsChanged) {
    if (!seen.has(ref)) {
      continue;
    }
    const existing = settingsMap.get(ref) ?? { AutoRecord: 'Allow' };
    settingsMap.set(ref, { ...existing, ...settings });
  }

  // Build new Item array
  const newItems = out.map((ref) => {
    const settings = settingsMap.get(ref) ?? { AutoRecord: 'Allow' };
    return { Metadata: ref, AutoRecord: settings['AutoRecord'] ?? 'Allow' };
  });

  // Inject into parsed object
  const accessor = getContentNodeAndSetter(parsed);
  if (accessor) {
    accessor.setItems(newItems);
  }

  const xml = XmlParser.objectToXml(parsed);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, xml, 'utf-8');

  return { rejected };
}
