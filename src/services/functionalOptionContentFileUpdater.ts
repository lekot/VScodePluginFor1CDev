/**
 * Reads and writes FunctionalOption Content from the main XML file.
 * XML path: MetaDataObject → FunctionalOption → Properties → Content → xr:Object
 */
import { XmlParser } from '../parsers/xmlParser';
import { mutateCompositionFile } from './compositionFileMutation';
import { reconcileSimpleReferenceRefs } from './compositionReconciliation';
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
  return mutateCompositionFile(filePath, 'ui.functionalOption.content', async ({ rawContent, exists }) => {
    if (!exists) {
      throw new Error(
        `Not a FunctionalOption metadata file (expected MetaDataObject/FunctionalOption/Properties): ${filePath}`,
      );
    }
    const parsed = XmlParser.parseString(rawContent);
    const props = getPropertiesFromParsed(parsed, 'FunctionalOption');
    if (!props) {
      throw new Error(
        `Not a FunctionalOption metadata file (expected MetaDataObject/FunctionalOption/Properties): ${filePath}`,
      );
    }

    const current = extractFunctionalOptionRefs(props.Content);
    const { refs, rejected } = reconcileSimpleReferenceRefs(current, diff);

    if (refs.length === 0) {
      props.Content = {};
    } else {
      props.Content = { 'xr:Object': refs.map((r) => r) };
    }

    const nextXml = XmlParser.objectToXml(parsed);
    return { nextXml, result: { rejected } };
  });
}
