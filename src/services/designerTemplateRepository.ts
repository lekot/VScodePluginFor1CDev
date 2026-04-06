import * as fs from 'fs';
import * as path from 'path';

let extensionPath: string | undefined;

/**
 * Initialize the designer template repository with the extension path.
 * Must be called from activate() before any template access.
 */
export function initDesignerTemplateRepository(extPath: string): void {
  extensionPath = extPath;
}

/**
 * Drops cached extension path (for test isolation after suites that call `initDesignerTemplateRepository`).
 */
export function clearDesignerTemplateRepositoryForTests(): void {
  extensionPath = undefined;
}

/**
 * Load Designer template XML for a given root tag (e.g. Catalog, Document).
 * @param rootTag - Metadata type tag (e.g. Catalog, Document, Enum).
 * @returns Template XML string or null if file not found / read error.
 */
export async function getDesignerTemplateXml(rootTag: string): Promise<string | null> {
  if (!extensionPath) {
    return null;
  }
  const templatePath = path.join(extensionPath, 'resources', 'designerTemplates', 'Designer', `${rootTag}.xml`);
  try {
    const content = await fs.promises.readFile(templatePath, 'utf-8');
    return content;
  } catch {
    return null;
  }
}
