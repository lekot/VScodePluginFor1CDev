/**
 * B.3 — persist subsystem `Properties.Content` composition (Designer MetaDataObject → Subsystem).
 */
import * as fs from 'fs';
import { XmlParser } from '../parsers/xmlParser';
import {
  buildSubsystemCompositionContentNode,
  extractSubsystemCompositionRefs,
  reconcileSubsystemCompositionRefs,
  type SubsystemCompositionReconcileRejected,
} from '../parsers/xmlChildObjects';

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

/** Navigate to Subsystem `<Properties>` object inside parsed root (MetaDataObject). */
export function getSubsystemPropertiesFromParsed(parsed: Record<string, unknown>): Record<string, unknown> | null {
  const metaRaw = getValueByLocalName(parsed, 'MetaDataObject');
  if (metaRaw === undefined || metaRaw === null) {
    return null;
  }
  const meta = Array.isArray(metaRaw) ? metaRaw[0] : metaRaw;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return null;
  }
  const subRaw = getValueByLocalName(meta as Record<string, unknown>, 'Subsystem');
  if (subRaw === undefined || subRaw === null) {
    return null;
  }
  const subObj = Array.isArray(subRaw) ? subRaw[0] : subRaw;
  if (!subObj || typeof subObj !== 'object' || Array.isArray(subObj)) {
    return null;
  }
  const propsRaw = getValueByLocalName(subObj as Record<string, unknown>, 'Properties');
  if (!propsRaw || typeof propsRaw !== 'object' || Array.isArray(propsRaw)) {
    return null;
  }
  return propsRaw as Record<string, unknown>;
}

export interface ApplySubsystemCompositionFileResult {
  refs: string[];
  rejected: SubsystemCompositionReconcileRejected[];
}

/**
 * Read Designer subsystem XML, merge composition add/remove (validated), write back.
 */
/** Read current composition refs from a Designer `Subsystem.xml` without mutating. */
export async function readSubsystemCompositionRefsFromFile(filePath: string): Promise<string[]> {
  const parsed = await XmlParser.parseFileAsync(filePath);
  const props = getSubsystemPropertiesFromParsed(parsed);
  if (!props) {
    return [];
  }
  return extractSubsystemCompositionRefs(props.Content);
}

export async function applySubsystemCompositionFileUpdate(
  filePath: string,
  options: { add?: string[]; remove?: string[] }
): Promise<ApplySubsystemCompositionFileResult> {
  const parsed = await XmlParser.parseFileAsync(filePath);
  const props = getSubsystemPropertiesFromParsed(parsed);
  if (!props) {
    throw new Error(`Not a subsystem metadata file (expected MetaDataObject/Subsystem/Properties): ${filePath}`);
  }
  const current = extractSubsystemCompositionRefs(props.Content);
  const { refs, rejected } = reconcileSubsystemCompositionRefs(current, options);
  props.Content = buildSubsystemCompositionContentNode(refs);
  const xml = XmlParser.objectToXml(parsed);
  await fs.promises.writeFile(filePath, xml, 'utf-8');
  return { refs, rejected };
}
