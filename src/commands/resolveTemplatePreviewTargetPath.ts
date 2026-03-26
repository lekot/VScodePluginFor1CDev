import * as fs from 'fs/promises';
import * as path from 'path';
import { MetadataType } from '../models/treeNode';

function extBodyFileName(type: MetadataType.Template | MetadataType.CommonTemplate): string {
  return type === MetadataType.CommonTemplate ? 'CommonTemplate.xml' : 'Template.xml';
}

/**
 * Resolves the on-disk path to open for MXL preview: prefer the template body under
 * `.../<name>/Ext/Template.xml` (or `Ext/CommonTemplate.xml` for common templates)
 * when the tree points at a description XML (e.g. `Templates/<name>.xml` or
 * `Templates/<name>/Template.xml`).
 */
export async function resolveTemplatePreviewTargetPath(
  filePath: string,
  type: MetadataType.Template | MetadataType.CommonTemplate
): Promise<string> {
  if (!filePath) {
    return filePath;
  }

  const normalized = path.normalize(filePath);
  const dir = path.dirname(normalized);
  const base = path.basename(normalized);
  const extName = extBodyFileName(type);

  if (path.basename(dir).toLowerCase() === 'ext') {
    const b = base.toLowerCase();
    if (b === 'template.xml' || b === 'commontemplate.xml') {
      return normalized;
    }
  }

  const candidates: string[] = [];
  const lower = base.toLowerCase();

  if (lower === 'template.xml' || lower === 'commontemplate.xml') {
    candidates.push(path.join(dir, 'Ext', extName));
    const stemFromDescriptor = base.slice(0, -'.xml'.length);
    candidates.push(path.join(dir, stemFromDescriptor, 'Ext', extName));
  } else if (lower.endsWith('.xml')) {
    const stem = base.slice(0, -'.xml'.length);
    candidates.push(path.join(dir, stem, 'Ext', extName));
  }

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return path.normalize(candidate);
    } catch {
      // try next
    }
  }

  return path.normalize(filePath);
}
