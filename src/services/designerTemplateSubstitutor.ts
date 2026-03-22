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

/** Parameters for Designer XML templates; extra keys are optional placeholders ({uuidDim}, …). */
export type DesignerTemplateParams = {
  uuid: string;
  Name: string;
  Synonym_ru: string;
  uuidDim?: string;
  uuidResource?: string;
  /** e.g. Document.ИмяДокумента — для регистраторов, журналов документов */
  RecorderDocumentRef?: string;
};

/**
 * Substitute placeholders in a Designer template XML with the given parameters.
 * Replaces {uuid}, {Name}, {Synonym_ru}, опционально {uuidDim}, {uuidResource}, {RecorderDocumentRef}.
 */
export function substituteDesignerTemplate(
  templateXml: string,
  // eslint-disable-next-line @typescript-eslint/naming-convention -- 1C template placeholders use platform naming
  params: DesignerTemplateParams
): string {
  const uuid = escapeXml(params.uuid);
  const name = escapeXml(params.Name);
  const synonymRu = escapeXml(params.Synonym_ru);
  let out = templateXml
    .replace(/\{uuid\}/g, uuid)
    .replace(/\{Name\}/g, name)
    .replace(/\{Synonym_ru\}/g, synonymRu);
  if (params.uuidDim !== undefined) {
    out = out.replace(/\{uuidDim\}/g, escapeXml(params.uuidDim));
  }
  if (params.uuidResource !== undefined) {
    out = out.replace(/\{uuidResource\}/g, escapeXml(params.uuidResource));
  }
  if (params.RecorderDocumentRef !== undefined) {
    out = out.replace(/\{RecorderDocumentRef\}/g, escapeXml(params.RecorderDocumentRef));
  }
  return out;
}
