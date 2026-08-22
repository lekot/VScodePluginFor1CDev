import {
  buildCanonicalMetaDataObjectOpenTag,
  DEFAULT_FORMAT_VERSION,
  detectFormatVersionFromXml,
} from '../format/formatRank';

/**
 * Replace the opening <MetaDataObject ...> tag with the canonical one,
 * preserving the rest of the XML and injecting the target format version.
 * If targetVersion is not provided, it preserves the version in xml or falls back to DEFAULT_FORMAT_VERSION.
 */
export function normalizeMetaDataObjectRoot(xml: string, targetVersion?: string): string {
  if (!xml.includes('<MetaDataObject')) {
    return xml;
  }
  const version = targetVersion || detectFormatVersionFromXml(xml).version || DEFAULT_FORMAT_VERSION;
  const canonicalTag = buildCanonicalMetaDataObjectOpenTag(version);
  return xml.replace(/<MetaDataObject\b[^>]*>/, canonicalTag);
}
