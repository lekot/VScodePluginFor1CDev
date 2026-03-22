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
/* eslint-disable @typescript-eslint/naming-convention -- Designer template placeholders use platform XML names */
export type DesignerTemplateParams = {
  uuid: string;
  Name: string;
  Synonym_ru: string;
  uuidDim?: string;
  uuidResource?: string;
  /** e.g. Document.ИмяДокумента — для регистраторов, журналов документов */
  RecorderDocumentRef?: string;
};
/* eslint-enable @typescript-eslint/naming-convention */

/**
 * Substitute placeholders in a Designer template XML with the given parameters.
 * Replaces {uuid}, {Name}, {Synonym_ru}, опционально {uuidDim}, {uuidResource}, {RecorderDocumentRef}.
 */
export function substituteDesignerTemplate(
  templateXml: string,
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
  const recorderRef = params.RecorderDocumentRef?.trim();
  if (recorderRef) {
    out = out.replace(/\{RecorderDocumentRef\}/g, escapeXml(recorderRef));
  } else if (out.includes('{RecorderDocumentRef}')) {
    out = out.replace(
      /<RegisteredDocuments>\s*<xr:Item[^>]*>\{RecorderDocumentRef\}<\/xr:Item>\s*<\/RegisteredDocuments>/,
      '<RegisteredDocuments/>'
    );
  }
  return out;
}
