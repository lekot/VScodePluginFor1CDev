/**
 * Paths for form editor: Form.xml and Module.bsl from form node filePath.
 * Designer: `Forms/{Name}.xml` (метаданные) + каталог `Forms/{Name}/Ext/…` — filePath узла формы обычно указывает на `.xml`.
 * Устаревшая выкладка: каталог `Forms/{Name}/` с `{Name}.xml` внутри — filePath = каталог.
 */

import * as path from 'path';
import * as fs from 'fs';

export interface FormPaths {
  /** Directory of the form. */
  formDirectory: string;
  /** Path to Ext/Form.xml (form structure). */
  formXmlPath: string;
  /** Path to Ext/Form/Module.bsl (form module). */
  modulePath: string;
}

/**
 * Compute paths to Form.xml and Module.bsl from the form node's filePath.
 * filePath can be: form directory, path to {FormName}.xml, or path to Ext/Form.xml (when editor is opened for Ext/Form.xml).
 */
export function getFormPaths(formNodeFilePath: string): FormPaths {
  const normalized = path.normalize(formNodeFilePath);
  const basename = path.basename(normalized);
  const parentDir = path.dirname(normalized);

  // Already Ext/Form.xml — editor was opened with this file (e.g. from tree → formXmlPath)
  if (basename === 'Form.xml' && path.basename(parentDir) === 'Ext') {
    const formDirectory = parentDir;
    const formXmlPath = normalized;
    const modulePath = path.join(formDirectory, 'Form', 'Module.bsl');
    return { formDirectory, formXmlPath, modulePath };
  }

  // Метаданные формы в Designer: Forms/{Name}.xml + каталог Forms/{Name}/Ext/… (ibcmd ищет именно .xml рядом с папкой)
  if (path.extname(normalized).toLowerCase() === '.xml') {
    const formsParent = path.dirname(normalized);
    const formStem = path.basename(normalized, path.extname(normalized));
    const extRoot = path.join(formsParent, formStem);
    const formXmlPath = path.join(extRoot, 'Ext', 'Form.xml');
    const modulePath = path.join(extRoot, 'Ext', 'Form', 'Module.bsl');
    return { formDirectory: extRoot, formXmlPath, modulePath };
  }

  const formDirectory = formNodeFilePath;
  const formXmlPath = path.join(formDirectory, 'Ext', 'Form.xml');
  const modulePath = path.join(formDirectory, 'Ext', 'Form', 'Module.bsl');
  return { formDirectory, formXmlPath, modulePath };
}

/**
 * Check if Form.xml exists at the computed path.
 */
export function formXmlExists(formNodeFilePath: string): boolean {
  const { formXmlPath } = getFormPaths(formNodeFilePath);
  return fs.existsSync(formXmlPath);
}
