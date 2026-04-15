/**
 * Reads and writes FunctionalOption Content from the main XML file.
 * XML path: MetaDataObject → FunctionalOption → Properties → Content → xr:Object
 */
import * as fs from 'fs';
import { XmlParser } from '../parsers/xmlParser';
import type { ContentReadResult, ContentUpdateDiff } from '../compositionEditor/compositionContracts';
import { localName, getPropertiesFromParsed } from '../parsers/xmlNavHelpers';

/** Collect text values from xr:Object / Object elements inside Content. */
function extractFunctionalOptionRefs(content: unknown): string[] {
  if (content == null) {
    return [];
  }
  if (typeof content === 'string') {
    const t = content.trim();
    return t ? [t] : [];
  }
  if (typeof content !== 'object') {
    return [];
  }
  const obj = content as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (localName(k) === 'Object') {
      // v may be a single element or array
      const items = Array.isArray(v) ? v : [v];
      const out: string[] = [];
      for (const item of items) {
        if (item == null) {
          continue;
        }
        let text: unknown;
        if (typeof item === 'string') {
          text = item;
        } else if (typeof item === 'object') {
          text = (item as Record<string, unknown>)['#text'];
        }
        if (typeof text === 'string') {
          const trimmed = text.trim();
          if (trimmed) {
            out.push(trimmed);
          }
        }
      }
      return out;
    }
  }
  return [];
}

/** Simple validation — just non-empty trimmed string (FO refs can have multiple dots). */
function validateFunctionalOptionRef(ref: string): string | null {
  const t = typeof ref === 'string' ? ref.trim() : '';
  if (!t) {
    return 'empty reference';
  }
  return null;
}

/**
 * Read FunctionalOption Content refs from the XML file without mutating.
 */
export async function readFunctionalOptionContent(filePath: string): Promise<ContentReadResult> {
  const parsed = await XmlParser.parseFileAsync(filePath);
  const props = getPropertiesFromParsed(parsed, 'FunctionalOption');
  if (!props) {
    return { refs: [], itemSettings: new Map() };
  }
  const refs = extractFunctionalOptionRefs(props.Content);
  return { refs, itemSettings: new Map() };
}

/**
 * Read existing FunctionalOption XML, apply add/remove diff, write back.
 */
export async function applyFunctionalOptionContentUpdate(
  filePath: string,
  diff: ContentUpdateDiff,
): Promise<{ rejected: Array<{ ref: string; reason: string }> }> {
  const parsed = await XmlParser.parseFileAsync(filePath);
  const props = getPropertiesFromParsed(parsed, 'FunctionalOption');
  if (!props) {
    throw new Error(
      `Not a FunctionalOption metadata file (expected MetaDataObject/FunctionalOption/Properties): ${filePath}`,
    );
  }

  const current = extractFunctionalOptionRefs(props.Content);
  const rejected: Array<{ ref: string; reason: string }> = [];

  const normalized = current.map((r) => r.trim()).filter(Boolean);
  const seen = new Set(normalized);
  const out = [...normalized];

  for (const raw of diff.add) {
    const ref = typeof raw === 'string' ? raw.trim() : '';
    const err = validateFunctionalOptionRef(ref);
    if (err) {
      rejected.push({ ref: String(raw), reason: err });
      continue;
    }
    if (seen.has(ref)) {
      continue;
    }
    seen.add(ref);
    out.push(ref);
  }

  const removeSet = new Set(
    (diff.remove ?? []).map((r) => (typeof r === 'string' ? r.trim() : '')).filter(Boolean),
  );
  const refs = out.filter((r) => !removeSet.has(r));

  if (refs.length === 0) {
    props.Content = {};
  } else {
    props.Content = { 'xr:Object': refs.map((r) => r) };
  }

  const xml = XmlParser.objectToXml(parsed);
  await fs.promises.writeFile(filePath, xml, 'utf-8');

  return { rejected };
}
