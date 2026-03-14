/**
 * Message router for the form editor webview.
 * Centralizes all incoming message handling — switch by msg.type,
 * delegates to formModelCommands and formFileIo.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { Logger } from '../utils/logger';
import { MESSAGES } from '../constants/messages';
import type { FormModel, FormChildItem } from './formModel';
import { isFormParseFileMissing } from './formModel';
import {
  applyPropertyChange,
  applyDragDrop,
  applyAddElement,
  applyDeleteElements,
  applyMoveElementSibling,
  applyPasteElements,
  applyAddElementFromRequisite,
  applyAddAttribute,
  applyDeleteAttribute,
  applyAddCommand,
  applyDeleteCommand,
} from './formModelCommands';
import {
  loadFormModel,
  saveFormModel,
  getFormProcedures,
  openModuleInEditor,
  getFormEditorTitle,
} from './formFileIo';

/** Minimal custom document interface (matches FormEditorDocument). */
export interface FormEditorDocument {
  readonly uri: vscode.Uri;
}

export interface MessageHandlerContext {
  document: FormEditorDocument;
  webviewPanel: vscode.WebviewPanel;
  documentModel: Map<string, FormModel>;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function handleMessage(
  ctx: MessageHandlerContext,
  msg: { type: string; [key: string]: unknown }
): Promise<void> {
  switch (msg.type) {
    case 'load':
      await handleLoad(ctx);
      break;
    case 'cancel':
      await handleCancel(ctx);
      break;
    case 'save':
      await handleSave(ctx, msg);
      break;
    case 'propertyChange':
      handlePropertyChange(ctx, msg);
      break;
    case 'dragDrop':
      await handleDragDrop(ctx, msg);
      break;
    case 'addElement':
      await handleAddElement(ctx, msg);
      break;
    case 'deleteElement':
      await handleDeleteElement(ctx, msg);
      break;
    case 'pasteElement':
      await handlePasteElement(ctx, msg);
      break;
    case 'moveElementSibling':
      await handleMoveElementSibling(ctx, msg);
      break;
    case 'addElementFromRequisite':
      await handleAddElementFromRequisite(ctx, msg);
      break;
    case 'addAttribute':
      await handleAddAttribute(ctx);
      break;
    case 'deleteAttribute':
      await handleDeleteAttribute(ctx, msg);
      break;
    case 'addCommand':
      await handleAddCommand(ctx);
      break;
    case 'deleteCommand':
      await handleDeleteCommand(ctx, msg);
      break;
    case 'getProcedures':
      await handleGetProcedures(ctx);
      break;
    case 'openModule':
      await handleOpenModule(ctx, msg);
      break;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function postError(webviewPanel: vscode.WebviewPanel, message: string): void {
  webviewPanel.webview.postMessage({ type: 'error', message });
}

function sendFormData(
  ctx: MessageHandlerContext,
  model: FormModel
): void {
  const formXmlPath = ctx.document.uri.fsPath;
  const modulePath = path.join(path.dirname(path.dirname(formXmlPath)), 'Ext', 'Form', 'Module.bsl');
  ctx.webviewPanel.webview.postMessage({
    type: 'formData',
    formModel: model,
    formXmlPath,
    modulePath,
  });
}

/** Reload form from disk and send to webview (used by load and cancel). */
async function reloadFormAndSend(ctx: MessageHandlerContext): Promise<void> {
  const formXmlPath = ctx.document.uri.fsPath;
  const result = await loadFormModel(formXmlPath);
  if ('error' in result) {
    postError(ctx.webviewPanel, result.error);
    Logger.error('Form editor load error', result.error);
    return;
  }
  const fileMissing = isFormParseFileMissing(result as never) || result.fileMissing;
  ctx.documentModel.set(ctx.document.uri.toString(), result.model);
  ctx.webviewPanel.title = getFormEditorTitle(formXmlPath);
  ctx.webviewPanel.webview.postMessage({
    type: 'formData',
    formModel: result.model,
    formXmlPath,
    modulePath: result.modulePath,
    fileMissing: fileMissing || undefined,
    fileMissingTitle: fileMissing ? MESSAGES.EMPTY_STATE_FORM_XML_MISSING_TITLE : undefined,
    fileMissingHint: fileMissing ? MESSAGES.EMPTY_STATE_FORM_XML_MISSING_HINT : undefined,
  });
}

// ---------------------------------------------------------------------------
// Individual handlers
// ---------------------------------------------------------------------------

async function handleLoad(ctx: MessageHandlerContext): Promise<void> {
  await reloadFormAndSend(ctx);
}

async function handleCancel(ctx: MessageHandlerContext): Promise<void> {
  await reloadFormAndSend(ctx);
}

async function handleSave(
  ctx: MessageHandlerContext,
  msg: Record<string, unknown>
): Promise<void> {
  const formXmlPath = ctx.document.uri.fsPath;
  const model = (msg.formModel as FormModel | undefined) ?? ctx.documentModel.get(ctx.document.uri.toString());
  if (!model) {
    postError(ctx.webviewPanel, 'Нет данных для сохранения.');
    return;
  }
  try {
    await saveFormModel(formXmlPath, model);
    ctx.documentModel.set(ctx.document.uri.toString(), model);
    ctx.webviewPanel.webview.postMessage({ type: 'saved' });
    vscode.window.showInformationMessage(MESSAGES.SAVE_SUCCESS);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    Logger.error('Form editor save failed', err);
    postError(ctx.webviewPanel, message);
    vscode.window.showErrorMessage(message);
  }
}

function handlePropertyChange(
  ctx: MessageHandlerContext,
  msg: Record<string, unknown>
): void {
  const model = ctx.documentModel.get(ctx.document.uri.toString());
  if (!model || msg.key === undefined) {
    return;
  }
  const elementIds = msg.elementIds as string[] | undefined;
  if (elementIds && elementIds.length > 0) {
    for (const elementId of elementIds) {
      applyPropertyChange(model, {
        elementId,
        section: msg.section as string | undefined,
        key: msg.key as string,
        value: msg.value,
      });
    }
  } else {
    applyPropertyChange(model, {
      elementId: msg.elementId as string | undefined,
      section: msg.section as string | undefined,
      key: msg.key as string,
      value: msg.value,
    });
  }
  // No disk write — in-memory only (Requirement 4.4)
}

async function handleDragDrop(
  ctx: MessageHandlerContext,
  msg: Record<string, unknown>
): Promise<void> {
  const model = ctx.documentModel.get(ctx.document.uri.toString());
  const rawSource = msg.sourceId as string | undefined;
  const rawTarget = msg.targetId as string | undefined;
  const index = (msg.index as number | undefined) ?? 0;
  if (!model || rawSource === undefined || rawTarget === undefined) {
    postError(ctx.webviewPanel, 'Неверные параметры dragDrop.');
    return;
  }
  const sourceId = String(rawSource);
  const targetId = String(rawTarget);
  Logger.debug('dragDrop', { sourceId, targetId, index });
  const result = applyDragDrop(model, sourceId, targetId, index);
  if (!result.ok) {
    postError(ctx.webviewPanel, result.error);
    return;
  }
  try {
    await saveFormModel(ctx.document.uri.fsPath, model);
    sendFormData(ctx, model);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    Logger.error('Form editor save after dragDrop failed', err);
    postError(ctx.webviewPanel, message);
  }
}

async function handleAddElement(
  ctx: MessageHandlerContext,
  msg: Record<string, unknown>
): Promise<void> {
  const model = ctx.documentModel.get(ctx.document.uri.toString());
  if (!model) {
    postError(ctx.webviewPanel, 'Нет модели формы.');
    return;
  }
  const parentId = msg.parentId as string | undefined;
  const tag = (msg.tag as string) || 'InputField';
  const name = (msg.name as string) || 'NewItem';
  const index = typeof msg.index === 'number' ? msg.index : undefined;
  const result = applyAddElement(model, parentId, tag, name, index);
  if (!result.ok) {
    postError(ctx.webviewPanel, result.error);
    return;
  }
  try {
    await saveFormModel(ctx.document.uri.fsPath, model);
    sendFormData(ctx, model);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    Logger.error('Form editor save after addElement failed', err);
    postError(ctx.webviewPanel, message);
  }
}

async function handleDeleteElement(
  ctx: MessageHandlerContext,
  msg: Record<string, unknown>
): Promise<void> {
  const model = ctx.documentModel.get(ctx.document.uri.toString());
  const elementIds = msg.elementIds as string[] | undefined;
  const elementId = msg.elementId as string | undefined;
  const ids = elementIds?.length ? elementIds : (elementId ? [elementId] : []);
  if (!model || !ids.length) {
    postError(ctx.webviewPanel, 'Неверные параметры deleteElement.');
    return;
  }
  const result = applyDeleteElements(model, ids);
  if (!result.ok) {
    postError(ctx.webviewPanel, result.error);
    return;
  }
  try {
    await saveFormModel(ctx.document.uri.fsPath, model);
    sendFormData(ctx, model);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    Logger.error('Form editor save after delete failed', err);
    postError(ctx.webviewPanel, message);
  }
}

async function handlePasteElement(
  ctx: MessageHandlerContext,
  msg: Record<string, unknown>
): Promise<void> {
  const model = ctx.documentModel.get(ctx.document.uri.toString());
  const targetId = msg.targetId as string | undefined;
  const rawClipboard = msg.clipboard;
  const clipboards: FormChildItem[] = Array.isArray(rawClipboard)
    ? (rawClipboard as FormChildItem[]).filter((c): c is FormChildItem => c != null && typeof c === 'object')
    : rawClipboard != null && typeof rawClipboard === 'object'
      ? [rawClipboard as FormChildItem]
      : [];
  if (!model || !targetId || !clipboards.length) {
    postError(ctx.webviewPanel, 'Неверные параметры pasteElement (нужны targetId и clipboard).');
    return;
  }
  const index = typeof msg.index === 'number' ? msg.index : undefined;
  const result = applyPasteElements(model, targetId, clipboards, index);
  if (!result.ok) {
    postError(ctx.webviewPanel, result.error);
    return;
  }
  try {
    await saveFormModel(ctx.document.uri.fsPath, model);
    sendFormData(ctx, model);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    Logger.error('Form editor save after paste failed', err);
    postError(ctx.webviewPanel, message);
  }
}

async function handleMoveElementSibling(
  ctx: MessageHandlerContext,
  msg: Record<string, unknown>
): Promise<void> {
  const model = ctx.documentModel.get(ctx.document.uri.toString());
  const elementId = msg.elementId as string | undefined;
  const direction = msg.direction as 'up' | 'down' | undefined;
  if (!model || !elementId || (direction !== 'up' && direction !== 'down')) {
    postError(ctx.webviewPanel, 'Неверные параметры moveElementSibling.');
    return;
  }
  const result = applyMoveElementSibling(model, elementId, direction);
  if (!result.ok) {
    postError(ctx.webviewPanel, result.error);
    return;
  }
  try {
    await saveFormModel(ctx.document.uri.fsPath, model);
    sendFormData(ctx, model);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    Logger.error('Form editor save after moveSibling failed', err);
    postError(ctx.webviewPanel, message);
  }
}

async function handleAddElementFromRequisite(
  ctx: MessageHandlerContext,
  msg: Record<string, unknown>
): Promise<void> {
  const model = ctx.documentModel.get(ctx.document.uri.toString());
  const requisiteName = msg.requisiteName as string | undefined;
  const dataPath = (msg.dataPath as string | undefined) ?? requisiteName;
  const targetId = msg.targetId as string | undefined;
  const index = (msg.index as number | undefined) ?? 0;
  if (!model || !requisiteName || !targetId) {
    postError(ctx.webviewPanel, 'Неверные параметры addElementFromRequisite (requisiteName, targetId).');
    return;
  }
  const result = applyAddElementFromRequisite(model, requisiteName, dataPath ?? '', targetId, index);
  if (!result.ok) {
    postError(ctx.webviewPanel, result.error);
    return;
  }
  try {
    await saveFormModel(ctx.document.uri.fsPath, model);
    sendFormData(ctx, model);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    Logger.error('Form editor save after addElementFromRequisite failed', err);
    postError(ctx.webviewPanel, message);
  }
}

async function handleAddAttribute(ctx: MessageHandlerContext): Promise<void> {
  const model = ctx.documentModel.get(ctx.document.uri.toString());
  if (!model) {
    postError(ctx.webviewPanel, 'Нет модели формы.');
    return;
  }
  const result = applyAddAttribute(model);
  if (!result.ok) {
    postError(ctx.webviewPanel, result.error);
    return;
  }
  try {
    await saveFormModel(ctx.document.uri.fsPath, model);
    sendFormData(ctx, model);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    Logger.error('Form editor save after addAttribute failed', err);
    postError(ctx.webviewPanel, message);
  }
}

async function handleDeleteAttribute(
  ctx: MessageHandlerContext,
  msg: Record<string, unknown>
): Promise<void> {
  const model = ctx.documentModel.get(ctx.document.uri.toString());
  const attributeId = msg.attributeId as string | undefined;
  const attributeName = msg.attributeName as string | undefined;
  const key = attributeId ?? attributeName;
  if (!model || key === undefined) {
    postError(ctx.webviewPanel, 'Неверные параметры deleteAttribute.');
    return;
  }
  const result = applyDeleteAttribute(model, key);
  if (!result.ok) {
    postError(ctx.webviewPanel, result.error);
    return;
  }
  try {
    await saveFormModel(ctx.document.uri.fsPath, model);
    sendFormData(ctx, model);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    Logger.error('Form editor save after deleteAttribute failed', err);
    postError(ctx.webviewPanel, message);
  }
}

async function handleAddCommand(ctx: MessageHandlerContext): Promise<void> {
  const model = ctx.documentModel.get(ctx.document.uri.toString());
  if (!model) {
    postError(ctx.webviewPanel, 'Нет модели формы.');
    return;
  }
  const result = applyAddCommand(model);
  if (!result.ok) {
    postError(ctx.webviewPanel, result.error);
    return;
  }
  try {
    await saveFormModel(ctx.document.uri.fsPath, model);
    sendFormData(ctx, model);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    Logger.error('Form editor save after addCommand failed', err);
    postError(ctx.webviewPanel, message);
  }
}

async function handleDeleteCommand(
  ctx: MessageHandlerContext,
  msg: Record<string, unknown>
): Promise<void> {
  const model = ctx.documentModel.get(ctx.document.uri.toString());
  const commandId = msg.commandId as string | undefined;
  const commandName = msg.commandName as string | undefined;
  const key = commandId ?? commandName;
  if (!model || key === undefined) {
    postError(ctx.webviewPanel, 'Неверные параметры deleteCommand.');
    return;
  }
  const result = applyDeleteCommand(model, key);
  if (!result.ok) {
    postError(ctx.webviewPanel, result.error);
    return;
  }
  try {
    await saveFormModel(ctx.document.uri.fsPath, model);
    sendFormData(ctx, model);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    Logger.error('Form editor save after deleteCommand failed', err);
    postError(ctx.webviewPanel, message);
  }
}

async function handleGetProcedures(ctx: MessageHandlerContext): Promise<void> {
  const formXmlPath = ctx.document.uri.fsPath;
  const procedures = await getFormProcedures(formXmlPath);
  ctx.webviewPanel.webview.postMessage({
    type: 'procedures',
    names: procedures.map((p) => p.name),
    procedures: procedures.map((p) => ({ name: p.name, line: p.line })),
  });
}

async function handleOpenModule(
  ctx: MessageHandlerContext,
  msg: Record<string, unknown>
): Promise<void> {
  const procedureName = msg.procedureName as string | undefined;
  await openModuleInEditor(ctx.document.uri.fsPath, procedureName);
}
