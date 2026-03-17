/**
 * XML-escape a string for safe use in XML text or attributes.
 * Same rules as XMLWriter: & -> &amp;, < -> &lt;, > -> &gt;, " -> &quot;, ' -> &apos;
 */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Substitute placeholders in a Designer template XML with the given parameters.
 * Replaces {uuid}, {Name}, {Synonym_ru} with XML-escaped values.
 * @param templateXml - Raw template XML string.
 * @param params - uuid, Name, Synonym_ru (all are XML-escaped before replacement).
 * @returns Resulting XML string.
 */
export function substituteDesignerTemplate(
  templateXml: string,
  params: { uuid: string; Name: string; Synonym_ru: string }
): string {
  const uuid = escapeXml(params.uuid);
  const name = escapeXml(params.Name);
  const synonymRu = escapeXml(params.Synonym_ru);
  return templateXml
    .replace(/\{uuid\}/g, uuid)
    .replace(/\{Name\}/g, name)
    .replace(/\{Synonym_ru\}/g, synonymRu);
}
