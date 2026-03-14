/**
 * File I/O operations for the form editor.
 * Encapsulates loading, saving, and BSL module access for Ext/Form.xml.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { Logger } from '../utils/logger';
import { parseFormXml } from './formXmlParser';
import { isFormParseError, isFormParseFileMissing } from './formModel';
import type { FormModel } from './formModel';
import { writeFormXml } from './formXmlWriter';
import { parseBslModuleProcedures } from './bslModuleParser';
import { getFormPaths } from './formPaths';
import { getFormEditorTitle } from './formEditorTitle';

export interface LoadFormResult {
  model: FormModel;
  formXmlPath: string;
  modulePath: string;
  fileMissing?: boolean;
}

/**
 * Load form model from disk.
 * Returns LoadFormResult on success, or { error: string } on parse failure.
 */
export async function loadFormModel(
  formXmlFsPath: string
): Promise<LoadFormResult | { error: string }> {
  const formDirectory = path.dirname(path.dirname(formXmlFsPath));
  const modulePath = path.join(formDirectory, 'Ext', 'Form', 'Module.bsl');

  const result = await parseFormXml(formXmlFsPath, true);
  if (isFormParseError(result)) {
    return { error: (result as { error: string }).error };
  }

  const model = (result as { model: FormModel }).model;
  const fileMissing = isFormParseFileMissing(result) || undefined;

  return {
    model,
    formXmlPath: formXmlFsPath,
    modulePath,
    fileMissing,
  };
}

/**
 * Save form model to disk (writes Ext/Form.xml).
 */
export async function saveFormModel(formXmlFsPath: string, model: FormModel): Promise<void> {
  await writeFormXml(formXmlFsPath, model);
}

/**
 * Get list of procedures/functions from the form's Module.bsl.
 */
export async function getFormProcedures(
  formXmlFsPath: string
): Promise<Array<{ name: string; line?: number }>> {
  const formDirectory = path.dirname(path.dirname(formXmlFsPath));
  const modulePath = path.join(formDirectory, 'Ext', 'Form', 'Module.bsl');
  const procedures = await parseBslModuleProcedures(modulePath);
  return procedures.map((p) => ({ name: p.name, line: p.line }));
}

/**
 * Open the form's Module.bsl in the editor, optionally navigating to a procedure.
 */
export async function openModuleInEditor(
  formXmlFsPath: string,
  procedureName?: string
): Promise<void> {
  const { modulePath } = getFormPaths(formXmlFsPath);
  try {
    const uri = vscode.Uri.file(modulePath);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.One,
    });
    if (procedureName) {
      const procedures = await parseBslModuleProcedures(modulePath);
      const proc = procedures.find((p) => p.name === procedureName);
      if (proc && proc.line) {
        const line = Math.max(0, proc.line - 1);
        const range = new vscode.Range(line, 0, line, 0);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        editor.selection = new vscode.Selection(line, 0, line, 0);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    Logger.error('Form editor: openModule failed', err);
    vscode.window.showErrorMessage(
      message.includes('ENOENT') || message.includes('not found')
        ? `Файл модуля формы не найден: ${modulePath}`
        : `Не удалось открыть модуль: ${message}`
    );
  }
}

// Re-export getFormEditorTitle for convenience (used by formMessageHandler when setting webview title)
export { getFormEditorTitle };
