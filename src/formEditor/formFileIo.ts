/**
 * File I/O operations for the form editor.
 * Encapsulates loading, source-preserving saving, and BSL module access for Ext/Form.xml.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { AtomicFileStorage, hashContent } from '../services/configurationSession/atomicFileStorage';
import { Logger } from '../utils/logger';
import { parseFormXmlContent } from './formXmlParser';
import { createEmptyFormModel, isFormParseError } from './formModel';
import type { FormModel } from './formModel';
import { writeFormXml } from './formXmlWriter';
import { parseBslModuleProcedures } from './bslModuleParser';
import { getFormPaths } from './formPaths';
import { getFormEditorTitle } from './formEditorTitle';
import {
  applyFormXmlEdits,
  createFormXmlSourceSnapshot,
  diffFormModels,
  FormXmlEditError,
  type FormXmlSourceSnapshot,
} from './formXmlTextEditor';

export interface LoadFormResult {
  model: FormModel;
  formXmlPath: string;
  modulePath: string;
  fileMissing?: boolean;
  sourceSnapshot?: FormXmlSourceSnapshot;
}

export class FormXmlExternalChangeError extends Error {
  readonly code = 'FORM_XML_EXTERNAL_CHANGE';

  constructor(formXmlPath: string) {
    super(`Form.xml изменился после загрузки; сохранение отменено: ${formXmlPath}`);
    this.name = 'FormXmlExternalChangeError';
  }
}

/**
 * Load form model and raw source from one read, so the snapshot hash always describes
 * the exact bytes that produced the UI baseline.
 */
export async function loadFormModel(
  formXmlFsPath: string
): Promise<LoadFormResult | { error: string }> {
  const formDirectory = path.dirname(path.dirname(formXmlFsPath));
  const modulePath = path.join(formDirectory, 'Ext', 'Form', 'Module.bsl');

  let source: Buffer;
  try {
    source = await fs.readFile(formXmlFsPath);
  } catch (readErr) {
    const err = readErr as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return {
        model: createEmptyFormModel(),
        formXmlPath: formXmlFsPath,
        modulePath,
        fileMissing: true,
      };
    }
    Logger.error(`Failed to read Form.xml: ${formXmlFsPath}`, readErr);
    return { error: `Не удалось прочитать файл: ${err.message ?? String(readErr)}` };
  }

  const text = source.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(source)) {
    return { error: 'Form.xml не является корректным UTF-8; сохранение отменено.' };
  }
  const result = parseFormXmlContent(text, formXmlFsPath);
  if (isFormParseError(result)) {
    return { error: result.error };
  }

  return {
    model: result.model,
    formXmlPath: formXmlFsPath,
    modulePath,
    sourceSnapshot: createFormXmlSourceSnapshot(source, result.model),
  };
}

/**
 * Save an existing form with source splices and compare-and-swap. A source snapshot is
 * required for existing files; new files continue through the established writer.
 */
export async function saveFormModel(
  formXmlFsPath: string,
  model: FormModel,
  sourceSnapshot?: FormXmlSourceSnapshot,
): Promise<FormXmlSourceSnapshot> {
  if (!sourceSnapshot) {
    const exists = await fs.access(formXmlFsPath).then(() => true, () => false);
    if (exists) {
      throw new FormXmlEditError('Для сохранения существующего Form.xml передайте снимок из loadFormModel() третьим параметром.');
    }
    await writeFormXml(formXmlFsPath, model);
    const written = await fs.readFile(formXmlFsPath);
    const parsed = parseFormXmlContent(written.toString('utf8'), formXmlFsPath);
    if (isFormParseError(parsed)) {
      throw new FormXmlEditError(`Записанный Form.xml не удалось проверить: ${parsed.error}`);
    }
    return createFormXmlSourceSnapshot(written, parsed.model);
  }

  const edits = diffFormModels(sourceSnapshot.baseline, model);
  if (edits.length === 0) {
    const current = await fs.readFile(formXmlFsPath).catch(() => undefined);
    if (!current || hashContent(current) !== sourceSnapshot.sha256) {
      throw new FormXmlExternalChangeError(formXmlFsPath);
    }
    return createFormXmlSourceSnapshot(current, model);
  }

  const outputText = applyFormXmlEdits(sourceSnapshot.text, edits);
  const parsed = parseFormXmlContent(outputText, formXmlFsPath);
  if (isFormParseError(parsed)) {
    throw new FormXmlEditError(`Изменённый Form.xml не прошёл проверку: ${parsed.error}`);
  }
  const output = Buffer.from(outputText, 'utf8');
  const rootPath = await findConfigurationRoot(formXmlFsPath);
  const outcome = await new AtomicFileStorage(rootPath).replace(
    formXmlFsPath,
    output,
    sourceSnapshot.sha256,
  );
  if (outcome.status === 'conflict') {
    if (outcome.code === 'STALE_TARGET_HASH') {
      throw new FormXmlExternalChangeError(formXmlFsPath);
    }
    throw new FormXmlEditError(`Сохранение Form.xml отклонено: ${outcome.message}`);
  }
  if (outcome.status !== 'committed') {
    throw new Error(`Не удалось атомарно сохранить Form.xml: ${outcome.message}`);
  }
  return createFormXmlSourceSnapshot(output, parsed.model);
}

/** Save As creates a separate file through the established full-form writer. */
export async function saveFormModelAs(formXmlFsPath: string, model: FormModel): Promise<void> {
  await writeFormXml(formXmlFsPath, model);
}

async function findConfigurationRoot(formXmlFsPath: string): Promise<string> {
  let cursor = path.dirname(path.resolve(formXmlFsPath));
  let reachedFilesystemRoot = false;
  while (!reachedFilesystemRoot) {
    const designerMarker = await fs.access(path.join(cursor, 'Configuration.xml')).then(() => true, () => false);
    const edtMarker = await fs.access(path.join(cursor, 'src', 'Configuration', 'Configuration.mdo')).then(() => true, () => false);
    if (designerMarker || edtMarker) {
      return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      reachedFilesystemRoot = true;
    } else {
      cursor = parent;
    }
  }
  const segments = path.resolve(formXmlFsPath).split(path.sep).map((segment) => segment.toLocaleLowerCase());
  if (segments.some((segment) => segment === 'ext' || segment === 'forms' || segment === 'src')) {
    throw new FormXmlEditError(`Не найдена корневая метка конфигурации для Form.xml: ${formXmlFsPath}`);
  }
  return path.dirname(path.resolve(formXmlFsPath));
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
      preview: false,
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
