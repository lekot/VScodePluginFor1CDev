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
import { getPropertiesFromParsed } from '../parsers/xmlNavHelpers';

/** Navigate to Subsystem `<Properties>` object inside parsed root (MetaDataObject). */
export function getSubsystemPropertiesFromParsed(parsed: Record<string, unknown>): Record<string, unknown> | null {
  return getPropertiesFromParsed(parsed, 'Subsystem');
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
