/**
 * Paths for form editor: Form.xml and Module.bsl from form node filePath.
 * Form node filePath can be either the form directory or path to {FormName}.xml (metadata file).
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
 * filePath can be the form directory (EDT/Designer when FormName.xml is absent) or path to {FormName}.xml.
 */
export function getFormPaths(formNodeFilePath: string): FormPaths {
  const formDirectory =
    path.extname(formNodeFilePath) === '.xml'
      ? path.dirname(formNodeFilePath)
      : formNodeFilePath;
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
