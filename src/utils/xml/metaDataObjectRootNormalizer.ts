import {
  buildCanonicalMetaDataObjectOpenTag,
  requireDocumentWriteFormatProfile,
  requireWriteFormatProfile,
} from '../format/formatRank';

/**
 * Replace the opening <MetaDataObject ...> tag with the canonical one,
 * preserving the rest of the XML and injecting the target format version.
 * New generated files must provide the project profile explicitly. Existing
 * documents can only preserve a valid root version; there is no silent default.
 */
export function normalizeMetaDataObjectRoot(xml: string, targetVersion?: string): string {
  if (!xml.includes('<MetaDataObject')) {
    return xml;
  }
  const profile = targetVersion
    ? requireWriteFormatProfile(targetVersion)
    : requireDocumentWriteFormatProfile(xml);
  const canonicalTag = buildCanonicalMetaDataObjectOpenTag(profile.version);
  return profileGeneratedMetadataXml(
    xml.replace(/<MetaDataObject\b[^>]*>/, canonicalTag),
    profile.version
  );
}

/**
 * Filter properties emitted by our templates/rules only. This intentionally
 * does not parse or rewrite arbitrary existing metadata documents.
 */
export function profileGeneratedMetadataXml(xml: string, targetVersion: string): string {
  const profile = requireWriteFormatProfile(targetVersion);
  let result = xml;
  if (!profile.hasTypeReductionMode) {
    // Designer templates use both the local property and its `xr:` spelling.
    // This is deliberately limited to the two known generated properties; it
    // is never applied while updating arbitrary existing XML documents.
    result = result.replace(/\s*<(?:xr:)?TypeReductionMode>[^<]*<\/(?:xr:)?TypeReductionMode>/g, '');
  }
  if (!profile.hasLineNumberLength) {
    result = result.replace(/\s*<(?:xr:)?LineNumberLength>[^<]*<\/(?:xr:)?LineNumberLength>/g, '');
  }
  return result;
}
