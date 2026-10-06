/**
 * Reads and writes FilterCriterion Content from the main XML file.
 * XML path: MetaDataObject → FilterCriterion → Properties → Content → xr:Item
 */
import { XmlParser } from '../parsers/xmlParser';
import { mutateCompositionFile } from './compositionFileMutation';
import { reconcileSimpleReferenceRefs } from './compositionReconciliation';
import type { ContentReadResult, ContentUpdateDiff } from '../compositionEditor/compositionContracts';
import { localName, getPropertiesFromParsed } from '../parsers/xmlNavHelpers';

/** Collect text values from xr:Item / Item elements inside Content. */
function extractFilterCriterionRefs(content: unknown): string[] {
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
    if (localName(k) === 'Item') {
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

/**
 * Read FilterCriterion Content refs from the XML file without mutating.
 */
export async function readFilterCriterionContent(filePath: string): Promise<ContentReadResult> {
  const parsed = await XmlParser.parseFileAsync(filePath);
  const props = getPropertiesFromParsed(parsed, 'FilterCriterion');
  if (!props) {
    return { refs: [], itemSettings: new Map() };
  }
  const refs = extractFilterCriterionRefs(props.Content);
  return { refs, itemSettings: new Map() };
}

/**
 * Read existing FilterCriterion XML, apply add/remove diff, write back.
 */
export async function applyFilterCriterionContentUpdate(
  filePath: string,
  diff: ContentUpdateDiff,
): Promise<{ rejected: Array<{ ref: string; reason: string }> }> {
  return mutateCompositionFile(filePath, 'ui.filterCriterion.content', async ({ rawContent, exists }) => {
    if (!exists) {
      throw new Error(
        `Not a FilterCriterion metadata file (expected MetaDataObject/FilterCriterion/Properties): ${filePath}`,
      );
    }
    const parsed = XmlParser.parseString(rawContent);
    const props = getPropertiesFromParsed(parsed, 'FilterCriterion');
    if (!props) {
      throw new Error(
        `Not a FilterCriterion metadata file (expected MetaDataObject/FilterCriterion/Properties): ${filePath}`,
      );
    }

    const current = extractFilterCriterionRefs(props.Content);
    const { refs, rejected } = reconcileSimpleReferenceRefs(current, diff);

    if (refs.length === 0) {
      props.Content = {};
    } else {
      props.Content = { 'xr:Item': refs.map((r) => ({ '#text': r, '@_xsi:type': 'xr:MDObjectRef' })) };
    }

    const nextXml = XmlParser.objectToXml(parsed);
    return { nextXml, result: { rejected } };
  });
}
