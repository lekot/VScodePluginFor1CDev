import * as fs from 'fs/promises';
import * as path from 'path';
import { MetadataType } from '../models/treeNode';

/** Body filenames: canonical under `Ext/`, alternate — same folder as metadata (`<name>/Template.xml` без `Ext/`). */
function bodyFileNamesForType(type: MetadataType.Template | MetadataType.CommonTemplate): string[] {
  if (type === MetadataType.Template) {
    return ['Template.xml'];
  }
  return ['Template.xml', 'CommonTemplate.xml'];
}

/**
 * Resolves the on-disk path to open for MXL preview when the tree points at a description XML.
 * Tries in order: `.../<name>/Ext/<body>.xml` (канон из спеки), затем `.../<name>/<body>.xml`
 * (вариант из реальных выгрузок / формулировки issue: не `MaketTemplate.Xml`, а `MaketTemplate/Template.xml`).
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
  const names = bodyFileNamesForType(type);

  if (path.basename(dir).toLowerCase() === 'ext') {
    const b = base.toLowerCase();
    if (b === 'template.xml' || b === 'commontemplate.xml') {
      return normalized;
    }
  }

  const candidates: string[] = [];
  const lower = base.toLowerCase();

  if (lower === 'template.xml' || lower === 'commontemplate.xml') {
    const stemFromDescriptor = base.slice(0, -'.xml'.length);
    for (const fn of names) {
      candidates.push(path.join(dir, 'Ext', fn));
      candidates.push(path.join(dir, stemFromDescriptor, 'Ext', fn));
      candidates.push(path.join(dir, stemFromDescriptor, fn));
    }
  } else if (lower.endsWith('.xml')) {
    const stem = base.slice(0, -'.xml'.length);
    for (const fn of names) {
      candidates.push(path.join(dir, stem, 'Ext', fn));
      candidates.push(path.join(dir, stem, fn));
    }
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
