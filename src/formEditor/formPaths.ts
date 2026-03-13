/**
 * Paths for form editor: Form.xml and Module.bsl from form node filePath.
 * Form node in tree has filePath = path to {FormName}.xml (metadata file).
 */

import * as path from 'path';
import * as fs from 'fs';

export interface FormPaths {
  /** Directory of the form: parent of {FormName}.xml. */
  formDirectory: string;
  /** Path to Ext/Form.xml (form structure). */
  formXmlPath: string;
  /** Path to Ext/Form/Module.bsl (form module). */
  modulePath: string;
}

/**
 * Compute paths to Form.xml and Module.bsl from the form node's filePath.
 * filePath is the path to {FormName}.xml (metadata file).
 */
export function getFormPaths(formNodeFilePath: string): FormPaths {
  const formDirectory = path.dirname(formNodeFilePath);
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
