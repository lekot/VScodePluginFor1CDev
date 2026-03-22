import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

let extensionContext: vscode.ExtensionContext | undefined;

/**
 * Initialize the designer template repository with the extension context.
 * Must be called from activate() before any template access.
 */
export function initDesignerTemplateRepository(context: vscode.ExtensionContext): void {
  extensionContext = context;
}

/**
 * Drops cached extension context (for test isolation after suites that call `initDesignerTemplateRepository`).
 */
export function clearDesignerTemplateRepositoryForTests(): void {
  extensionContext = undefined;
}

/**
 * Load Designer template XML for a given root tag (e.g. Catalog, Document).
 * @param rootTag - Metadata type tag (e.g. Catalog, Document, Enum).
 * @returns Template XML string or null if file not found / read error.
 */
export async function getDesignerTemplateXml(rootTag: string): Promise<string | null> {
  if (!extensionContext) {
    return null;
  }
  const templatePath = extensionContext.asAbsolutePath(
    path.join('resources', 'designerTemplates', 'Designer', `${rootTag}.xml`)
  );
  try {
    const content = await fs.promises.readFile(templatePath, 'utf-8');
    return content;
  } catch {
    return null;
  }
}
