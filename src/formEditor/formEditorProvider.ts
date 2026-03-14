/**
 * Custom editor provider for 1C form structure (Ext/Form.xml).
 * One WebView with three zones: tree (left), properties (top-right), preview + Form/Module tabs (bottom-right).
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { Logger } from '../utils/logger';
import { MESSAGES } from '../constants/messages';
import { parseFormXml } from './formXmlParser';
import { isFormParseError, isFormParseFileMissing } from './formModel';
import type { FormModel, FormChildItem, FormAttribute, FormCommand } from './formModel';
import { writeFormXml } from './formXmlWriter';
import { parseBslModuleProcedures } from './bslModuleParser';
import { getFormPaths } from './formPaths';
import { getFormEditorTitle } from './formEditorTitle';
import {
  isContainer,
  isDescendantOf,
  findElementById,
  findParentAndIndex,
  moveNodeInModel,
  removeNodeInModel,
  moveElementSiblingInModel,
  FORM_ROOT_ID,
} from './formTreeOperations';
export { moveNodeInModel } from './formTreeOperations';

/** Minimal custom document for form editor. */
class FormEditorDocument implements vscode.CustomDocument {
  constructor(public readonly uri: vscode.Uri) {}
  dispose(): void {}
}

/** Resolve attribute type string from FormAttribute.properties (Type or v8:Type etc.). */
function getAttributeTypeString(attr: FormAttribute): string {
  if (!attr?.properties) return '';
  const v = attr.properties['Type'];
  if (v != null) {
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'object' && v !== null && '#text' in (v as object)) return String((v as { '#text'?: unknown })['#text'] ?? '').trim();
  }
  for (const k of Object.keys(attr.properties)) {
    if (k === ':@' || k.startsWith('@')) continue;
    const local = k.includes(':') ? k.split(':').pop()! : k;
    if (local === 'Type') {
      const val = attr.properties[k];
      if (typeof val === 'string') return val.trim();
      if (typeof val === 'object' && val !== null && '#text' in (val as object)) return String((val as { '#text'?: unknown })['#text'] ?? '').trim();
    }
  }
  return '';
}

/** Map form attribute type to form element tag: boolean → CheckBoxField, else InputField. */
function requisiteTypeToTag(attr: FormAttribute | undefined): string {
  if (!attr) return 'InputField';
  const typeStr = getAttributeTypeString(attr).toLowerCase();
  if (typeStr === 'xs:boolean' || typeStr === 'boolean' || typeStr.includes('boolean')) return 'CheckBoxField';
  return 'InputField';
}

/** Collect all id values from tree (numeric ones for max). */
function collectIds(items: FormChildItem[], out: Set<string>): void {
  for (const item of items) {
    if (item.id != null) out.add(String(item.id));
    if (item.childItems?.length) collectIds(item.childItems, out);
  }
}

/** Generate next free id (max numeric + 1). */
function generateNextId(model: FormModel): string {
  const ids = new Set<string>();
  collectIds(model.childItemsRoot, ids);
  let max = 0;
  for (const id of ids) {
    const n = parseInt(id, 10);
    if (!Number.isNaN(n) && n > max) max = n;
  }
  return String(max + 1);
}

/** Next numeric id for attributes (max of attribute ids + 1). */
function generateNextAttributeId(model: FormModel): string {
  let max = 0;
  for (const a of model.attributes || []) {
    if (a.id) {
      const n = parseInt(a.id, 10);
      if (!Number.isNaN(n) && n > max) max = n;
    }
  }
  return String(max + 1);
}

/** Next numeric id for commands (max of command ids + 1). */
function generateNextCommandId(model: FormModel): string {
  let max = 0;
  for (const c of model.commands || []) {
    if (c.id) {
      const n = parseInt(c.id, 10);
      if (!Number.isNaN(n) && n > max) max = n;
    }
  }
  return String(max + 1);
}

/** Deep clone FormChildItem and assign new ids via nextId(). */
function cloneWithNewIds(item: FormChildItem, nextId: () => string): FormChildItem {
  const id = item.id ? nextId() : undefined;
  return {
    tag: item.tag,
    id,
    name: item.name,
    properties: JSON.parse(JSON.stringify(item.properties || {})),
    childItems: (item.childItems || []).map((c) => cloneWithNewIds(c, nextId)),
    events: item.events ? { ...item.events } : undefined,
  };
}

/** Create nextId generator for a model (uses generateNextId and then increments). */
function createIdGenerator(model: FormModel): () => string {
  let next = 0;
  const initial = generateNextId(model);
  next = parseInt(initial, 10);
  if (Number.isNaN(next)) next = 1;
  return () => String(next++);
}

/** Update property on an element (or attribute/command by section). */
function applyPropertyChange(
  model: FormModel,
  payload: { elementId?: string; section?: string; key: string; value: unknown }
): void {
  if (payload.section === 'attributes' && payload.elementId) {
    const attr = model.attributes.find(
      (a) => a.name === payload.elementId || a.id === payload.elementId
    );
    if (attr) {
      if (payload.key === 'name') attr.name = String(payload.value ?? '');
      else if (payload.key === 'id') attr.id = String(payload.value ?? '');
      else attr.properties[payload.key] = payload.value;
    }
    return;
  }
  if (payload.section === 'commands' && payload.elementId) {
    const cmd = model.commands.find(
      (c) => c.name === payload.elementId || c.id === payload.elementId
    );
    if (cmd) {
      if (payload.key === 'name') cmd.name = String(payload.value ?? '');
      else if (payload.key === 'id') cmd.id = String(payload.value ?? '');
      else cmd.properties[payload.key] = payload.value;
    }
    return;
  }
  if (payload.section === 'events' && payload.elementId) {
    const el = findElementById(model.childItemsRoot, payload.elementId);
    if (el && payload.key) {
      if (!el.events) el.events = {};
      el.events[payload.key] = String(payload.value ?? '');
    }
    return;
  }
  if (payload.elementId) {
    const el = findElementById(model.childItemsRoot, payload.elementId);
    if (el) {
      if (payload.key === 'name') el.name = String(payload.value ?? '');
      else if (payload.key === 'id') el.id = String(payload.value ?? '');
      else el.properties[payload.key] = payload.value;
    }
  }
}

export class FormEditorProvider implements vscode.CustomReadonlyEditorProvider<FormEditorDocument> {
  private documentModel = new Map<string, FormModel>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  openCustomDocument(uri: vscode.Uri): FormEditorDocument {
    return new FormEditorDocument(uri);
  }

  async resolveCustomEditor(
    document: FormEditorDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    webviewPanel.title = getFormEditorTitle(document.uri.fsPath);
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };
    webviewPanel.webview.html = this.getWebviewHtml(webviewPanel.webview);
    webviewPanel.webview.onDidReceiveMessage(async (msg) => this.handleMessage(document, webviewPanel, msg));
  }

  private async handleMessage(
    document: FormEditorDocument,
    webviewPanel: vscode.WebviewPanel,
    msg: { type: string; [key: string]: unknown }
  ): Promise<void> {
    if (msg.type === 'load') {
      await this.handleLoad(document, webviewPanel);
    } else if (msg.type === 'propertyChange') {
      const model = this.documentModel.get(document.uri.toString());
      if (model && msg.key !== undefined) {
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
      }
    } else if (msg.type === 'save') {
      await this.handleSave(document, webviewPanel, msg);
    } else if (msg.type === 'cancel') {
      await this.handleCancel(document, webviewPanel);
    } else if (msg.type === 'dragDrop') {
      await this.handleDragDrop(document, webviewPanel, msg);
    } else if (msg.type === 'addElementFromRequisite') {
      await this.handleAddElementFromRequisite(document, webviewPanel, msg);
    } else if (msg.type === 'getProcedures') {
      await this.handleGetProcedures(document, webviewPanel);
    } else if (msg.type === 'openModule') {
      await this.handleOpenModule(document, msg);
    } else if (msg.type === 'deleteElement') {
      await this.handleDeleteElement(document, webviewPanel, msg);
    } else if (msg.type === 'moveElementSibling') {
      await this.handleMoveElementSibling(document, webviewPanel, msg);
    } else if (msg.type === 'addElement') {
      await this.handleAddElement(document, webviewPanel, msg);
    } else if (msg.type === 'pasteElement') {
      await this.handlePasteElement(document, webviewPanel, msg);
    } else if (msg.type === 'addAttribute') {
      await this.handleAddAttribute(document, webviewPanel);
    } else if (msg.type === 'deleteAttribute') {
      await this.handleDeleteAttribute(document, webviewPanel, msg);
    } else if (msg.type === 'addCommand') {
      await this.handleAddCommand(document, webviewPanel);
    } else if (msg.type === 'deleteCommand') {
      await this.handleDeleteCommand(document, webviewPanel, msg);
    }
  }

  private async handleGetProcedures(
    document: FormEditorDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    const formXmlPath = document.uri.fsPath;
    const modulePath = path.join(
      path.dirname(path.dirname(formXmlPath)),
      'Ext',
      'Form',
      'Module.bsl'
    );
    const procedures = await parseBslModuleProcedures(modulePath);
    webviewPanel.webview.postMessage({
      type: 'procedures',
      names: procedures.map((p) => p.name),
      procedures: procedures.map((p) => ({ name: p.name, line: p.line })),
    });
  }

  private async handleOpenModule(
    document: FormEditorDocument,
    msg: Record<string, unknown>
  ): Promise<void> {
    const { modulePath } = getFormPaths(document.uri.fsPath);
    const procedureName = msg.procedureName as string | undefined;
    try {
      const uri = vscode.Uri.file(modulePath);
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
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

  private async handleDragDrop(
    document: FormEditorDocument,
    webviewPanel: vscode.WebviewPanel,
    msg: Record<string, unknown>
  ): Promise<void> {
    const model = this.documentModel.get(document.uri.toString());
    const rawSource = msg.sourceId as string | undefined;
    const rawTarget = msg.targetId as string | undefined;
    const index = (msg.index as number | undefined) ?? 0;
    if (!model || rawSource === undefined || rawTarget === undefined) {
      webviewPanel.webview.postMessage({ type: 'error', message: 'Неверные параметры dragDrop.' });
      return;
    }
    const sourceId = String(rawSource);
    const targetId = String(rawTarget);
    Logger.debug('dragDrop', { sourceId, targetId, index });
    if (sourceId === targetId || isDescendantOf(model, sourceId, targetId) || isDescendantOf(model, targetId, sourceId)) {
      webviewPanel.webview.postMessage({
        type: 'error',
        message: 'Нельзя переместить элемент в себя или в своего потомка.',
      });
      return;
    }
    const sourceLoc = findParentAndIndex(model.childItemsRoot, sourceId);
    if (!sourceLoc) {
      Logger.debug('dragDrop: source not found', { sourceId });
      webviewPanel.webview.postMessage({ type: 'error', message: 'Элемент-источник не найден.' });
      return;
    }
    // Special case: drop onto the synthetic form root — move element to childItemsRoot
    if (targetId === FORM_ROOT_ID) {
      if (sourceLoc.parent === model.childItemsRoot) {
        webviewPanel.webview.postMessage({ type: 'error', message: 'Элемент уже находится на верхнем уровне формы.' });
        return;
      }
      if (!moveNodeInModel(model, sourceId, FORM_ROOT_ID, index)) {
        Logger.debug('dragDrop: moveNodeInModel to root returned false', { sourceId });
        webviewPanel.webview.postMessage({ type: 'error', message: 'Не удалось переместить элемент в корень формы.' });
        return;
      }
      try {
        await writeFormXml(document.uri.fsPath, model);
        this.sendFormData(document, webviewPanel, model);
        Logger.debug('dragDrop to root completed', { sourceId });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error('Form editor save after dragDrop to root failed', err);
        webviewPanel.webview.postMessage({ type: 'error', message });
      }
      return;
    }
    const targetEl = findElementById(model.childItemsRoot, targetId);
    if (!targetEl || !isContainer(targetEl)) {
      webviewPanel.webview.postMessage({
        type: 'error',
        message: 'Цель должна быть контейнером (группа, страница, таблица и т.д.).',
      });
      return;
    }
    if (!moveNodeInModel(model, sourceId, targetId, index)) {
      Logger.debug('dragDrop: moveNodeInModel returned false', { sourceId, targetId });
      webviewPanel.webview.postMessage({ type: 'error', message: 'Не удалось переместить элемент.' });
      return;
    }
    try {
      await writeFormXml(document.uri.fsPath, model);
      this.sendFormData(document, webviewPanel, model);
      Logger.debug('dragDrop completed', { sourceId, targetId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      Logger.error('Form editor save after dragDrop failed', err);
      webviewPanel.webview.postMessage({ type: 'error', message });
    }
  }

  private async handleAddElementFromRequisite(
    document: FormEditorDocument,
    webviewPanel: vscode.WebviewPanel,
    msg: Record<string, unknown>
  ): Promise<void> {
    const model = this.documentModel.get(document.uri.toString());
    const requisiteName = msg.requisiteName as string | undefined;
    const dataPath = (msg.dataPath as string | undefined) ?? requisiteName;
    const targetId = msg.targetId as string | undefined;
    const index = (msg.index as number | undefined) ?? 0;
    if (!model || !requisiteName || !targetId) {
      webviewPanel.webview.postMessage({ type: 'error', message: 'Неверные параметры addElementFromRequisite (requisiteName, targetId).' });
      return;
    }
    const targetEl = findElementById(model.childItemsRoot, targetId);
    if (!targetEl || !isContainer(targetEl)) {
      webviewPanel.webview.postMessage({
        type: 'error',
        message: 'Цель должна быть контейнером (группа, страница, таблица и т.д.).',
      });
      return;
    }
    const attr = model.attributes?.find((a) => a.name === requisiteName);
    const tag = requisiteTypeToTag(attr);
    const newId = generateNextId(model);
    const targetList = targetEl.childItems ?? (targetEl.childItems = []);
    const insertIndex = typeof index === 'number' ? Math.max(0, Math.min(index, targetList.length)) : targetList.length;
    const newItem: FormChildItem = {
      tag,
      id: newId,
      name: requisiteName,
      properties: { DataPath: dataPath },
      childItems: [],
    };
    targetList.splice(insertIndex, 0, newItem);
    try {
      await writeFormXml(document.uri.fsPath, model);
      this.sendFormData(document, webviewPanel, model);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      Logger.error('Form editor save after addElementFromRequisite failed', err);
      webviewPanel.webview.postMessage({ type: 'error', message });
    }
  }

  private async handleSave(
    document: FormEditorDocument,
    webviewPanel: vscode.WebviewPanel,
    msg: Record<string, unknown>
  ): Promise<void> {
    const formXmlPath = document.uri.fsPath;
    const model = (msg.formModel as FormModel | undefined) ?? this.documentModel.get(document.uri.toString());
    if (!model) {
      webviewPanel.webview.postMessage({ type: 'error', message: 'Нет данных для сохранения.' });
      return;
    }
    try {
      await writeFormXml(formXmlPath, model);
      this.documentModel.set(document.uri.toString(), model);
      webviewPanel.webview.postMessage({ type: 'saved' });
      vscode.window.showInformationMessage(MESSAGES.SAVE_SUCCESS);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      Logger.error('Form editor save failed', err);
      webviewPanel.webview.postMessage({ type: 'error', message });
      vscode.window.showErrorMessage(message);
    }
  }

  private async handleLoad(
    document: FormEditorDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    await this.reloadFormAndSend(document, webviewPanel);
  }

  /** Reload form from disk and send to webview (used by load and cancel). */
  private async reloadFormAndSend(
    document: FormEditorDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    const formXmlPath = document.uri.fsPath;
    const formDirectory = path.dirname(path.dirname(formXmlPath));
    const modulePath = path.join(formDirectory, 'Ext', 'Form', 'Module.bsl');

    const result = await parseFormXml(formXmlPath, true);
    if (isFormParseError(result)) {
      const errMsg = (result as { error: string }).error;
      webviewPanel.webview.postMessage({ type: 'error', message: errMsg });
      Logger.error('Form editor load error', errMsg);
      return;
    }
    const model = (result as { model: FormModel }).model;
    const fileMissing = isFormParseFileMissing(result);
    this.documentModel.set(document.uri.toString(), model);
    webviewPanel.title = getFormEditorTitle(formXmlPath);
    webviewPanel.webview.postMessage({
      type: 'formData',
      formModel: model,
      formXmlPath,
      modulePath,
      fileMissing: fileMissing || undefined,
      fileMissingTitle: fileMissing ? MESSAGES.EMPTY_STATE_FORM_XML_MISSING_TITLE : undefined,
      fileMissingHint: fileMissing ? MESSAGES.EMPTY_STATE_FORM_XML_MISSING_HINT : undefined,
    });
  }

  private async handleCancel(
    document: FormEditorDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    await this.reloadFormAndSend(document, webviewPanel);
  }

  private async handleDeleteElement(
    document: FormEditorDocument,
    webviewPanel: vscode.WebviewPanel,
    msg: Record<string, unknown>
  ): Promise<void> {
    const model = this.documentModel.get(document.uri.toString());
    const elementIds = msg.elementIds as string[] | undefined;
    const elementId = msg.elementId as string | undefined;
    const ids = elementIds?.length ? elementIds : (elementId ? [elementId] : []);
    if (!model || !ids.length) {
      webviewPanel.webview.postMessage({ type: 'error', message: 'Неверные параметры deleteElement.' });
      return;
    }
    const toDelete = ids.length === 1
      ? ids
      : this.orderIdsForDeletion(model, ids);
    const rootIds = new Set(
      model.childItemsRoot.length === 1
        ? [model.childItemsRoot[0].id || model.childItemsRoot[0].name].filter(Boolean)
        : []
    );
    const toDeleteFiltered = toDelete.filter((id) => !rootIds.has(id));
    let anyRemoved = false;
    for (const id of toDeleteFiltered) {
      if (removeNodeInModel(model, id)) anyRemoved = true;
    }
    if (!anyRemoved) {
      const rootOnly = toDeleteFiltered.length < toDelete.length && ids.some((id) => rootIds.has(id));
      webviewPanel.webview.postMessage({
        type: 'error',
        message: rootOnly ? 'Корневой элемент удалить нельзя.' : 'Не удалось удалить элементы.',
      });
      return;
    }
    try {
      await writeFormXml(document.uri.fsPath, model);
      this.sendFormData(document, webviewPanel, model);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      Logger.error('Form editor save after delete failed', err);
      webviewPanel.webview.postMessage({ type: 'error', message });
    }
  }

  /** Order element ids so descendants are removed before ancestors (by depth, deeper first). */
  private orderIdsForDeletion(model: FormModel, ids: string[]): string[] {
    const depthMap = new Map<string, number>();
    const walk = (items: FormChildItem[], d: number) => {
      for (const item of items) {
        const id = item.id || item.name;
        if (id) depthMap.set(id, d);
        if (item.childItems?.length) walk(item.childItems, d + 1);
      }
    };
    walk(model.childItemsRoot, 0);
    return ids.slice().sort((a, b) => (depthMap.get(b) ?? 0) - (depthMap.get(a) ?? 0));
  }

  private async handleMoveElementSibling(
    document: FormEditorDocument,
    webviewPanel: vscode.WebviewPanel,
    msg: Record<string, unknown>
  ): Promise<void> {
    const model = this.documentModel.get(document.uri.toString());
    const elementId = msg.elementId as string | undefined;
    const direction = msg.direction as 'up' | 'down' | undefined;
    if (!model || !elementId || (direction !== 'up' && direction !== 'down')) {
      webviewPanel.webview.postMessage({ type: 'error', message: 'Неверные параметры moveElementSibling.' });
      return;
    }
    if (!moveElementSiblingInModel(model, elementId, direction)) {
      webviewPanel.webview.postMessage({ type: 'error', message: 'Не удалось переместить элемент.' });
      return;
    }
    try {
      await writeFormXml(document.uri.fsPath, model);
      this.sendFormData(document, webviewPanel, model);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      Logger.error('Form editor save after moveSibling failed', err);
      webviewPanel.webview.postMessage({ type: 'error', message });
    }
  }

  private async handleAddElement(
    document: FormEditorDocument,
    webviewPanel: vscode.WebviewPanel,
    msg: Record<string, unknown>
  ): Promise<void> {
    const model = this.documentModel.get(document.uri.toString());
    const parentId = msg.parentId as string | undefined;
    const tag = (msg.tag as string) || 'InputField';
    const name = (msg.name as string) || 'NewItem';
    if (!model) {
      webviewPanel.webview.postMessage({ type: 'error', message: 'Нет модели формы.' });
      return;
    }
    const parentList = parentId
      ? (() => {
          const parentEl = findElementById(model.childItemsRoot, parentId);
          if (!parentEl || !isContainer(parentEl)) return null;
          return parentEl.childItems ?? (parentEl.childItems = []);
        })()
      : model.childItemsRoot;
    if (!parentList) {
      webviewPanel.webview.postMessage({ type: 'error', message: 'Родитель не является контейнером.' });
      return;
    }
    const newId = generateNextId(model);
    const newItem: FormChildItem = {
      tag,
      id: newId,
      name,
      properties: {},
      childItems: [],
    };
    const index = typeof msg.index === 'number' ? Math.max(0, Math.min(msg.index, parentList.length)) : parentList.length;
    parentList.splice(index, 0, newItem);
    try {
      await writeFormXml(document.uri.fsPath, model);
      this.sendFormData(document, webviewPanel, model);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      Logger.error('Form editor save after addElement failed', err);
      webviewPanel.webview.postMessage({ type: 'error', message });
    }
  }

  private async handlePasteElement(
    document: FormEditorDocument,
    webviewPanel: vscode.WebviewPanel,
    msg: Record<string, unknown>
  ): Promise<void> {
    const model = this.documentModel.get(document.uri.toString());
    const targetId = msg.targetId as string | undefined;
    const rawClipboard = msg.clipboard;
    const clipboards: FormChildItem[] = Array.isArray(rawClipboard)
      ? (rawClipboard as FormChildItem[]).filter((c): c is FormChildItem => c != null && typeof c === 'object')
      : rawClipboard != null && typeof rawClipboard === 'object'
        ? [rawClipboard as FormChildItem]
        : [];
    if (!model || !targetId || !clipboards.length) {
      webviewPanel.webview.postMessage({ type: 'error', message: 'Неверные параметры pasteElement (нужны targetId и clipboard).' });
      return;
    }
    const targetEl = findElementById(model.childItemsRoot, targetId);
    if (!targetEl || !isContainer(targetEl)) {
      webviewPanel.webview.postMessage({ type: 'error', message: 'Цель должна быть контейнером.' });
      return;
    }
    const nextId = createIdGenerator(model);
    const targetList = targetEl.childItems ?? (targetEl.childItems = []);
    let index = typeof msg.index === 'number' ? Math.max(0, Math.min(msg.index, targetList.length)) : targetList.length;
    for (const clipboard of clipboards) {
      const cloned = cloneWithNewIds(clipboard, nextId);
      targetList.splice(index, 0, cloned);
      index += 1;
    }
    try {
      await writeFormXml(document.uri.fsPath, model);
      this.sendFormData(document, webviewPanel, model);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      Logger.error('Form editor save after paste failed', err);
      webviewPanel.webview.postMessage({ type: 'error', message });
    }
  }

  private async handleAddAttribute(
    document: FormEditorDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    const model = this.documentModel.get(document.uri.toString());
    if (!model) {
      webviewPanel.webview.postMessage({ type: 'error', message: 'Нет модели формы.' });
      return;
    }
    const name = 'NewAttribute';
    const id = generateNextAttributeId(model);
    const newAttr: FormAttribute = {
      name,
      id,
      properties: { Type: 'xs:string' },
    };
    model.attributes = model.attributes || [];
    model.attributes.push(newAttr);
    try {
      await writeFormXml(document.uri.fsPath, model);
      this.sendFormData(document, webviewPanel, model);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      Logger.error('Form editor save after addAttribute failed', err);
      webviewPanel.webview.postMessage({ type: 'error', message });
    }
  }

  private async handleDeleteAttribute(
    document: FormEditorDocument,
    webviewPanel: vscode.WebviewPanel,
    msg: Record<string, unknown>
  ): Promise<void> {
    const model = this.documentModel.get(document.uri.toString());
    const attributeId = msg.attributeId as string | undefined;
    const attributeName = msg.attributeName as string | undefined;
    const key = attributeId ?? attributeName;
    if (!model || key === undefined) {
      webviewPanel.webview.postMessage({ type: 'error', message: 'Неверные параметры deleteAttribute.' });
      return;
    }
    const idx = model.attributes.findIndex(
      (a) => a.id === key || a.name === key
    );
    if (idx < 0) {
      webviewPanel.webview.postMessage({ type: 'error', message: 'Реквизит не найден.' });
      return;
    }
    model.attributes.splice(idx, 1);
    try {
      await writeFormXml(document.uri.fsPath, model);
      this.sendFormData(document, webviewPanel, model);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      Logger.error('Form editor save after deleteAttribute failed', err);
      webviewPanel.webview.postMessage({ type: 'error', message });
    }
  }

  private async handleAddCommand(
    document: FormEditorDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    const model = this.documentModel.get(document.uri.toString());
    if (!model) {
      webviewPanel.webview.postMessage({ type: 'error', message: 'Нет модели формы.' });
      return;
    }
    const name = 'NewCommand';
    const id = generateNextCommandId(model);
    const newCmd: FormCommand = {
      name,
      id,
      properties: {},
    };
    model.commands = model.commands || [];
    model.commands.push(newCmd);
    try {
      await writeFormXml(document.uri.fsPath, model);
      this.sendFormData(document, webviewPanel, model);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      Logger.error('Form editor save after addCommand failed', err);
      webviewPanel.webview.postMessage({ type: 'error', message });
    }
  }

  private async handleDeleteCommand(
    document: FormEditorDocument,
    webviewPanel: vscode.WebviewPanel,
    msg: Record<string, unknown>
  ): Promise<void> {
    const model = this.documentModel.get(document.uri.toString());
    const commandId = msg.commandId as string | undefined;
    const commandName = msg.commandName as string | undefined;
    const key = commandId ?? commandName;
    if (!model || key === undefined) {
      webviewPanel.webview.postMessage({ type: 'error', message: 'Неверные параметры deleteCommand.' });
      return;
    }
    const idx = model.commands.findIndex(
      (c) => c.id === key || c.name === key
    );
    if (idx < 0) {
      webviewPanel.webview.postMessage({ type: 'error', message: 'Команда не найдена.' });
      return;
    }
    model.commands.splice(idx, 1);
    try {
      await writeFormXml(document.uri.fsPath, model);
      this.sendFormData(document, webviewPanel, model);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      Logger.error('Form editor save after deleteCommand failed', err);
      webviewPanel.webview.postMessage({ type: 'error', message });
    }
  }

  /** Send formData message to webview (shared by load, cancel, dragDrop, delete, move, add, paste). */
  private sendFormData(
    document: FormEditorDocument,
    webviewPanel: vscode.WebviewPanel,
    model: FormModel
  ): void {
    const formXmlPath = document.uri.fsPath;
    const modulePath = path.join(path.dirname(path.dirname(formXmlPath)), 'Ext', 'Form', 'Module.bsl');
    webviewPanel.webview.postMessage({
      type: 'formData',
      formModel: model,
      formXmlPath,
      modulePath,
    });
  }

  private getWebviewHtml(_webview: vscode.Webview): string {
    return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
  <title>Редактор формы 1С</title>
  <style>
    * { box-sizing: border-box; }
    :root {
      --fe-spacing-xs: 4px;
      --fe-spacing-sm: 8px;
      --fe-spacing-md: 12px;
      --fe-spacing-lg: 16px;
      --fe-radius-sm: 2px;
      --fe-radius-md: 4px;
      --fe-radius-btn: 6px;
    }
    body {
      margin: 0;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      --tree-width: 280px;
      --preview-height: 200px;
    }
    .fe-toolbar {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      gap: 2px;
      padding: var(--fe-spacing-xs) var(--fe-spacing-sm);
      background: var(--vscode-editor-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      min-height: 28px;
    }
    .fe-toolbar-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 24px;
      padding: 0;
      border: none;
      background: transparent;
      color: var(--vscode-foreground);
      border-radius: var(--fe-radius-sm);
      cursor: pointer;
      font-size: 14px;
      font-family: var(--vscode-font-family);
    }
    .fe-toolbar-btn:hover:not(:disabled) {
      background: var(--vscode-toolbar-hoverBackground);
    }
    .fe-toolbar-btn:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .fe-toolbar-btn:focus-visible {
      outline: 2px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }
    .fe-toolbar-sep {
      width: 1px;
      height: 16px;
      background: var(--vscode-panel-border);
      margin: 0 var(--fe-spacing-xs);
      flex-shrink: 0;
    }
    .top-row {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: row;
    }
    .zone-tree {
      width: var(--tree-width);
      min-width: 120px;
      max-width: 80%;
      background: var(--vscode-sideBar-background);
      border-right: 1px solid var(--vscode-panel-border);
      overflow-y: auto;
      overflow-x: hidden;
      padding: var(--fe-spacing-sm);
      flex-shrink: 0;
    }
    .splitter-v {
      width: 6px;
      flex-shrink: 0;
      cursor: col-resize;
      background: var(--vscode-panel-border);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .splitter-v::before {
      content: '';
      width: 12px;
      height: 2px;
      background: var(--vscode-sideBar-foreground);
      opacity: 0.3;
      border-radius: 1px;
      box-shadow: 0 -4px 0 0 var(--vscode-sideBar-foreground), 0 -8px 0 0 var(--vscode-sideBar-foreground);
    }
    .splitter-v:hover { background: var(--vscode-focusBorder); }
    .splitter-v:hover::before { opacity: 0.6; }
    .zone-right-column {
      flex: 1;
      min-width: 0;
      min-height: 80px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      --right-upper-ratio: 40%;
    }
    .zone-right-upper {
      flex: 0 0 var(--right-upper-ratio);
      min-height: 100px;
      max-height: 50vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      padding: var(--fe-spacing-sm);
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .right-panel-tabs {
      display: flex;
      gap: 0;
      margin-bottom: var(--fe-spacing-sm);
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }
    .right-panel-tabs button {
      padding: var(--fe-spacing-xs) var(--fe-spacing-sm);
      background: transparent;
      color: var(--vscode-foreground);
      border: none;
      border-bottom: 2px solid transparent;
      margin-bottom: -1px;
      cursor: pointer;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      border-radius: 0;
    }
    .right-panel-tabs button:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground); }
    .right-panel-tabs button.active { border-bottom-color: var(--vscode-focusBorder); background: var(--vscode-tab-activeBackground, transparent); }
    .right-tab-panel {
      flex: 1;
      min-height: 0;
      overflow: auto;
      display: flex;
      flex-direction: column;
    }
    .fe-table-wrap { overflow: auto; flex: 1; min-height: 0; }
    .fe-table {
      width: 100%;
      border-collapse: collapse;
      font-size: var(--vscode-font-size);
    }
    .fe-table th, .fe-table td {
      padding: var(--fe-spacing-xs) var(--fe-spacing-sm);
      text-align: left;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .fe-table th { color: var(--vscode-descriptionForeground); font-weight: 500; }
    .fe-table tbody tr { cursor: pointer; }
    .fe-table tbody tr:hover { background: var(--vscode-list-hoverBackground); }
    .fe-table tbody tr.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .fe-toolbar-buttons {
      display: flex;
      gap: var(--fe-spacing-xs);
      flex-wrap: wrap;
      margin-top: var(--fe-spacing-sm);
      flex-shrink: 0;
    }
    .fe-toolbar-buttons button {
      padding: var(--fe-spacing-xs) var(--fe-spacing-sm);
      font-size: var(--vscode-font-size);
      font-family: var(--vscode-font-family);
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: var(--fe-radius-md);
      cursor: pointer;
    }
    .fe-toolbar-buttons button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .fe-toolbar-buttons button:disabled { opacity: 0.5; cursor: default; }
    .zone-props {
      flex: 1;
      min-height: 80px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      padding: var(--fe-spacing-sm);
    }
    .zone-props-scroll {
      flex: 1;
      min-height: 0;
      overflow: auto;
    }
    .splitter-h {
      height: 6px;
      flex-shrink: 0;
      cursor: row-resize;
      background: var(--vscode-panel-border);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .splitter-h::before {
      content: '';
      height: 12px;
      width: 2px;
      background: var(--vscode-sideBar-foreground);
      opacity: 0.3;
      border-radius: 1px;
      box-shadow: -4px 0 0 0 var(--vscode-sideBar-foreground), -8px 0 0 0 var(--vscode-sideBar-foreground);
    }
    .splitter-h:hover { background: var(--vscode-focusBorder); }
    .splitter-h:hover::before { opacity: 0.6; }
    .zone-preview {
      height: var(--preview-height);
      min-height: 60px;
      width: 100%;
      max-width: 100%;
      min-width: 0;
      overflow: auto;
      padding: var(--fe-spacing-sm);
      flex-shrink: 0;
      align-self: stretch;
      box-sizing: border-box;
    }
    .zone-tree h3, .zone-props h3, .zone-preview h3 {
      margin: 0 0 var(--fe-spacing-sm) 0;
      font-size: 0.9em;
      color: var(--vscode-foreground);
      opacity: 0.9;
    }
    .props-selection-header {
      margin-bottom: var(--fe-spacing-sm);
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
    }
    .tree-node {
      padding: var(--fe-radius-sm) var(--fe-spacing-xs);
      cursor: pointer;
      border-radius: var(--fe-radius-sm);
      display: flex;
      align-items: center;
      gap: var(--fe-spacing-xs);
      min-width: 0;
    }
    .tree-node:hover { background: var(--vscode-list-hoverBackground); }
    .tree-node.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .tree-node.drop-target { outline: 2px solid var(--vscode-focusBorder); }
    .tree-node:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
    .tree-node-container { font-weight: 600; flex-wrap: wrap; }
    .tree-node-container > .tree-children { flex-basis: 100%; width: 100%; }
    .tree-chevron {
      flex-shrink: 0;
      width: 14px;
      text-align: center;
      font-size: 0.7em;
      opacity: 0.8;
      transition: transform 0.15s ease;
    }
    .tree-chevron.collapsed { transform: rotate(-90deg); }
    .tree-chevron-placeholder { width: 14px; flex-shrink: 0; }
    .tree-node-label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }
    .tree-icon {
      flex-shrink: 0;
      width: 1em;
      text-align: center;
      font-size: 0.95em;
    }
    .tree-node-data-bound {
      flex-shrink: 0;
      width: 0.6em;
      font-size: 0.75em;
      color: var(--vscode-descriptionForeground);
      line-height: 1;
    }
    .tree-children {
      margin-left: var(--fe-spacing-sm);
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .tree-table-columns {
      margin-left: var(--fe-spacing-sm);
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .placeholder {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      padding: var(--fe-spacing-md) var(--fe-spacing-sm);
    }
    .preview-placeholder { color: var(--vscode-descriptionForeground); font-style: italic; padding: var(--fe-spacing-sm) 0; }
    #preview-form { width: 100%; min-width: 100%; box-sizing: border-box; }
    .preview-item { width: 100%; min-width: 0; box-sizing: border-box; padding: var(--fe-spacing-xs) var(--fe-spacing-sm); margin: 2px 0; cursor: pointer; border-radius: var(--fe-radius-md); border: 1px solid var(--vscode-panel-border); }
    .preview-item:hover { background: var(--vscode-list-hoverBackground); }
    .preview-item.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .preview-item.drop-target { outline: 2px solid var(--vscode-focusBorder); }
    .preview-container { background: var(--vscode-editor-inactiveSelectionBackground); min-height: 20px; width: 100%; box-sizing: border-box; }
    .preview-control { background: var(--vscode-input-background); width: 100%; box-sizing: border-box; }
    .preview-children { margin-left: var(--fe-spacing-md); width: 100%; box-sizing: border-box; min-width: 0; }
    .preview-control-wrap { display: flex; align-items: center; flex-wrap: wrap; gap: var(--fe-spacing-xs); min-height: 22px; }
    .preview-input { flex: 1; min-width: 80px; padding: var(--fe-radius-sm) var(--fe-spacing-sm); font-size: inherit; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: var(--fe-radius-md); }
    .preview-button { padding: var(--fe-spacing-xs) var(--fe-spacing-md); font-size: inherit; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: var(--fe-radius-btn); cursor: default; }
    .preview-label { color: var(--vscode-foreground); }
    .preview-table { padding: var(--fe-spacing-sm); border: 1px solid var(--vscode-panel-border); border-radius: var(--fe-radius-md); font-size: 0.9em; color: var(--vscode-descriptionForeground); }
    .preview-table-columns { display: flex; flex-direction: row; flex-wrap: wrap; gap: var(--fe-spacing-sm); }
    .preview-table-cols-row { display: flex; flex-direction: row; flex-wrap: wrap; gap: var(--fe-spacing-xs); }
    .preview-table-col { min-width: 60px; padding: var(--fe-spacing-xs) var(--fe-spacing-sm); border: 1px solid var(--vscode-panel-border); border-radius: var(--fe-radius-md); font-size: 0.85em; }
    .preview-page-caption, .preview-group-caption { font-weight: 600; font-size: 0.9em; margin-bottom: var(--fe-spacing-xs); color: var(--vscode-foreground); }
    .preview-fallback { font-size: 0.9em; color: var(--vscode-descriptionForeground); }
    /* Form mockup (variant B): layout as form */
    #preview-form.preview-mockup-form { padding: var(--fe-spacing-sm); width: 100%; min-width: 100%; box-sizing: border-box; }
    .preview-field-row { display: flex; align-items: center; flex-wrap: wrap; gap: var(--fe-spacing-sm); margin-bottom: var(--fe-spacing-xs); }
    .preview-field-label { min-width: 80px; color: var(--vscode-foreground); font-size: inherit; flex-shrink: 0; }
    .preview-field-row .preview-input { flex: 1; min-width: 100px; }
    .preview-buttons-row { display: flex; flex-wrap: wrap; gap: var(--fe-spacing-xs); align-items: center; }
    .preview-table-mock { overflow-x: auto; border: 1px solid var(--vscode-panel-border); border-radius: var(--fe-radius-md); margin: var(--fe-spacing-xs) 0; }
    .preview-table-mock table { width: 100%; border-collapse: collapse; font-size: 0.9em; }
    .preview-table-mock th, .preview-table-mock td { padding: var(--fe-spacing-xs) var(--fe-spacing-sm); text-align: left; border-bottom: 1px solid var(--vscode-panel-border); }
    .preview-table-mock th { background: var(--vscode-editor-inactiveSelectionBackground); font-weight: 600; color: var(--vscode-foreground); cursor: pointer; }
    .preview-table-mock th:hover { background: var(--vscode-list-hoverBackground); }
    .preview-table-mock th.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .preview-table-mock tbody tr:last-child td { border-bottom: none; }
    .preview-page-block { margin: var(--fe-spacing-sm) 0; }
    .preview-page-title { font-weight: 700; font-size: 0.95em; margin-bottom: var(--fe-spacing-xs); color: var(--vscode-foreground); padding-bottom: 2px; border-bottom: 1px solid var(--vscode-panel-border); }
    .preview-group-block { margin-left: var(--fe-spacing-md); margin-bottom: var(--fe-spacing-xs); }
    .preview-group-title { font-weight: 600; font-size: 0.9em; margin-bottom: var(--fe-spacing-xs); color: var(--vscode-descriptionForeground); }
    .preview-children.preview-buttons-container { display: flex; flex-wrap: wrap; gap: var(--fe-spacing-sm); align-items: center; margin-left: 0; }
    .empty-state { text-align: center; padding: var(--fe-spacing-lg); color: var(--vscode-descriptionForeground); }
    .empty-state h4 { margin: 0 0 var(--fe-spacing-sm) 0; font-size: 1em; color: var(--vscode-foreground); opacity: 0.9; }
    .empty-state p { margin: 0; font-size: 0.9em; }
    .preview-empty-state { text-align: center; padding: var(--fe-spacing-lg) var(--fe-spacing-md); color: var(--vscode-descriptionForeground); }
    .preview-empty-state .preview-empty-title { font-size: 0.95em; margin: 0 0 var(--fe-spacing-xs) 0; color: var(--vscode-foreground); opacity: 0.9; }
    .preview-empty-state .preview-empty-hint { margin: 0; font-size: 0.85em; }
    .error { color: var(--vscode-errorForeground); padding: var(--fe-spacing-sm); }
    .tabs {
      display: flex;
      gap: 0;
      margin-bottom: var(--fe-spacing-sm);
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .tabs button {
      padding: var(--fe-spacing-sm) var(--fe-spacing-md);
      background: transparent;
      color: var(--vscode-foreground);
      border: none;
      border-bottom: 2px solid transparent;
      margin-bottom: -1px;
      cursor: pointer;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      border-radius: 0;
    }
    .tabs button:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground); }
    .tabs button.active { border-bottom-color: var(--vscode-focusBorder); background: var(--vscode-tab-activeBackground, transparent); }
    .left-zone-tabs {
      display: flex;
      gap: 0;
      margin-bottom: var(--fe-spacing-sm);
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .left-zone-tabs button {
      padding: var(--fe-spacing-xs) var(--fe-spacing-sm);
      background: transparent;
      color: var(--vscode-foreground);
      border: none;
      border-bottom: 2px solid transparent;
      margin-bottom: -1px;
      cursor: pointer;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      border-radius: 0;
    }
    .left-zone-tabs button:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground); }
    .left-zone-tabs button.active { border-bottom-color: var(--vscode-focusBorder); background: var(--vscode-tab-activeBackground, transparent); }
    .command-interface-section { margin-bottom: var(--fe-spacing-md); }
    .command-interface-section-title { font-size: 0.8em; color: var(--vscode-descriptionForeground); margin: 0 0 var(--fe-spacing-xs) 0; text-transform: uppercase; letter-spacing: 0.02em; }
    .command-interface-list { list-style: none; margin: 0; padding: 0; }
    .command-interface-list li {
      padding: var(--fe-spacing-xs) var(--fe-spacing-sm);
      border-radius: var(--fe-radius-sm);
      font-size: 0.9em;
      color: var(--vscode-foreground);
    }
    .command-interface-list li:hover { background: var(--vscode-list-hoverBackground); }
    .command-interface-empty { color: var(--vscode-descriptionForeground); font-style: italic; font-size: 0.9em; padding: var(--fe-spacing-xs) 0; }
    .props-block { margin-bottom: var(--fe-spacing-md); }
    .props-block-title { font-size: 0.8em; color: var(--vscode-descriptionForeground); margin: 0 0 var(--fe-spacing-xs) 0; text-transform: uppercase; letter-spacing: 0.02em; }
    .prop-row { margin-bottom: var(--fe-spacing-sm); display: flex; align-items: center; flex-wrap: wrap; gap: var(--fe-spacing-xs); }
    .prop-row label { min-width: 80px; color: var(--vscode-descriptionForeground); flex-shrink: 0; }
    .prop-row .prop-input-wrap { flex: 1; min-width: 0; max-width: 280px; }
    .prop-row input {
      width: 100%;
      padding: var(--fe-spacing-sm) var(--fe-spacing-sm);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      border-radius: var(--fe-radius-md);
    }
    .prop-row input:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    .prop-row input.event-method-input { max-width: 160px; }
    .fe-badge {
      display: inline-block;
      padding: 2px var(--fe-spacing-xs);
      font-size: 0.85em;
      border-radius: var(--fe-radius-sm);
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    .props-actions-sticky {
      flex-shrink: 0;
      margin-top: auto;
      padding-top: var(--fe-spacing-sm);
      border-top: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
      display: flex;
      align-items: center;
      gap: var(--fe-spacing-sm);
    }
    #btn-cancel, #btn-save {
      padding: var(--fe-spacing-sm) var(--fe-spacing-md);
      border: none;
      cursor: pointer;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      border-radius: var(--fe-radius-btn);
    }
    #btn-cancel:focus-visible, #btn-save:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
    #btn-save {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    #btn-save:hover { background: var(--vscode-button-hoverBackground); }
    #btn-cancel {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    #btn-cancel:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .btn-goto-proc {
      padding: var(--fe-spacing-xs) var(--fe-spacing-sm);
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      cursor: pointer;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      border-radius: var(--fe-radius-md);
    }
    .btn-goto-proc:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .btn-goto-proc:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
    #btn-open-module {
      padding: var(--fe-spacing-sm) var(--fe-spacing-md);
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      cursor: pointer;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      border-radius: var(--fe-radius-btn);
    }
    #btn-open-module:hover { background: var(--vscode-button-hoverBackground); }
    #btn-open-module:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
  </style>
</head>
<body>
  <div class="fe-toolbar" role="toolbar" aria-label="Панель инструментов формы">
    <button type="button" class="fe-toolbar-btn" id="tb-add" title="Добавить элемент" aria-label="Добавить">&#43;</button>
    <button type="button" class="fe-toolbar-btn" id="tb-delete" title="Удалить" aria-label="Удалить">&#x1F5D1;</button>
    <button type="button" class="fe-toolbar-btn" id="tb-up" title="Вверх" aria-label="Вверх">&#x2191;</button>
    <button type="button" class="fe-toolbar-btn" id="tb-down" title="Вниз" aria-label="Вниз">&#x2193;</button>
    <button type="button" class="fe-toolbar-btn" id="tb-copy" title="Копировать" aria-label="Копировать">&#x2398;</button>
    <button type="button" class="fe-toolbar-btn" id="tb-paste" title="Вставить" aria-label="Вставить">&#x2399;</button>
    <span class="fe-toolbar-sep" aria-hidden="true"></span>
    <button type="button" class="fe-toolbar-btn" id="tb-save" title="Сохранить" aria-label="Сохранить">&#x1F4BE;</button>
    <button type="button" class="fe-toolbar-btn" id="tb-cancel" title="Отмена" aria-label="Отмена">&#x27F3;</button>
  </div>
  <div class="top-row">
    <div class="zone-tree">
      <h3>Элементы формы</h3>
      <div class="left-zone-tabs" role="tablist">
        <button type="button" role="tab" data-left-tab="elements" aria-selected="true">Элементы</button>
        <button type="button" role="tab" data-left-tab="command-interface" aria-selected="false">Командный интерфейс</button>
      </div>
      <div id="left-tab-elements" role="tabpanel">
        <div id="tree-selection-count" class="props-selection-header" style="display:none;"></div>
        <div id="tree-root" role="tree" aria-label="Элементы формы"></div>
        <div id="tree-empty" class="empty-state" style="display:none;">
          <h4 id="tree-empty-title"></h4>
          <p id="tree-empty-hint"></p>
        </div>
        <div id="tree-error" class="error" style="display:none;"></div>
      </div>
      <div id="left-command-interface" role="tabpanel" style="display:none;">
        <div id="command-interface-content"></div>
      </div>
    </div>
    <div class="splitter-v" id="splitter-v" title="Изменить ширину панели"></div>
    <div class="zone-right-column">
      <div class="zone-right-upper">
        <div class="right-panel-tabs" role="tablist">
          <button type="button" role="tab" data-right-tab="attributes" aria-selected="true">Реквизиты</button>
          <button type="button" role="tab" data-right-tab="commands" aria-selected="false">Команды</button>
          <button type="button" role="tab" data-right-tab="parameters" aria-selected="false">Параметры</button>
        </div>
        <div id="right-tab-attributes" class="right-tab-panel" role="tabpanel">
          <div id="attributes-table-wrap" class="fe-table-wrap">
            <table class="fe-table" id="attributes-table">
              <thead><tr><th>Реквизит</th><th>Использование</th><th>Тип</th></tr></thead>
              <tbody id="attributes-tbody"></tbody>
            </table>
          </div>
          <div id="attributes-tree-wrap" class="fe-requisite-tree-wrap" style="display:none;">
            <div id="attributes-tree-root" role="tree"></div>
          </div>
          <div class="fe-toolbar-buttons">
            <button type="button" id="btn-add-attribute" title="Добавить реквизит">Добавить</button>
            <button type="button" id="btn-edit-attribute" title="Изменить выбранный" disabled>Изменить</button>
            <button type="button" id="btn-delete-attribute" title="Удалить выбранный" disabled>Удалить</button>
          </div>
        </div>
        <div id="right-tab-commands" class="right-tab-panel" role="tabpanel" style="display:none;">
          <div class="fe-table-wrap">
            <table class="fe-table" id="commands-table">
              <thead><tr><th>Команда</th><th>Подпись</th></tr></thead>
              <tbody id="commands-tbody"></tbody>
            </table>
          </div>
          <div class="fe-toolbar-buttons">
            <button type="button" id="btn-add-command" title="Добавить команду">Добавить</button>
            <button type="button" id="btn-delete-command" title="Удалить выбранную" disabled>Удалить</button>
          </div>
        </div>
        <div id="right-tab-parameters" class="right-tab-panel" role="tabpanel" style="display:none;">
          <p class="placeholder">Параметры формы будут доступны после поддержки секции в Form.xml</p>
        </div>
      </div>
      <div class="zone-props" role="region" aria-label="Свойства элемента">
        <h3>Свойства</h3>
        <div class="zone-props-scroll">
          <div id="props-header" class="props-selection-header"></div>
          <div id="props-content" style="display:none;"></div>
          <div id="props-placeholder" class="placeholder">Выберите элемент</div>
        </div>
        <div id="props-actions" class="props-actions-sticky" style="display:none;">
          <button type="button" id="btn-cancel" title="Отмена">Отмена</button>
          <button type="button" id="btn-save" title="Сохранить">Сохранить</button>
          <span id="save-status"></span>
        </div>
      </div>
    </div>
  </div>
  <div class="splitter-h" id="splitter-h" title="Изменить высоту превью"></div>
  <div class="zone-preview">
    <h3>Превью</h3>
    <div class="tabs" role="tablist">
      <button type="button" role="tab" data-tab="form" title="Форма" aria-selected="true">Форма</button>
      <button type="button" role="tab" data-tab="module" title="Модуль" aria-selected="false">Модуль</button>
    </div>
    <div id="preview-form" class="preview-placeholder" role="tabpanel">
      <div class="preview-empty-state">
        <p class="preview-empty-title">Визуальное превью формы пока не реализовано</p>
        <p class="preview-empty-hint">Структуру можно просматривать в дереве элементов и в панели свойств.</p>
      </div>
    </div>
    <div id="preview-module" style="display:none;" role="tabpanel">
      <button type="button" id="btn-open-module" title="Модуль формы">Модуль формы</button>
      <p class="placeholder">Открывает Ext/Form/Module.bsl в редакторе</p>
    </div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    let formModel = null;
    let selectedIds = [];
    let anchorId = null;
    let clipboardBuffer = null;
    let selectedAttributeId = null;
    let selectedCommandId = null;
    (function setupSplitters() {
      var root = document.body;
      var sv = document.getElementById('splitter-v');
      var sh = document.getElementById('splitter-h');
      function px(val) { return val + 'px'; }
      function parsePx(str) { return str ? parseInt(str, 10) || 0 : 0; }
      if (sv) {
        sv.addEventListener('mousedown', function(e) {
          e.preventDefault();
          var startX = e.clientX;
          var startW = parsePx(getComputedStyle(root).getPropertyValue('--tree-width')) || 280;
          function move(e2) {
            var dx = e2.clientX - startX;
            var newW = Math.max(120, Math.min(window.innerWidth * 0.8, startW + dx));
            root.style.setProperty('--tree-width', px(newW));
          }
          function up() {
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', up);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
          }
          document.body.style.cursor = 'col-resize';
          document.body.style.userSelect = 'none';
          document.addEventListener('mousemove', move);
          document.addEventListener('mouseup', up);
        });
      }
      if (sh) {
        sh.addEventListener('mousedown', function(e) {
          e.preventDefault();
          var startY = e.clientY;
          var startH = parsePx(getComputedStyle(root).getPropertyValue('--preview-height')) || 200;
          function move(e2) {
            var dy = startY - e2.clientY;
            var newH = Math.max(60, Math.min(window.innerHeight - 100, startH + dy));
            root.style.setProperty('--preview-height', px(newH));
          }
          function up() {
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', up);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
          }
          document.body.style.cursor = 'row-resize';
          document.body.style.userSelect = 'none';
          document.addEventListener('mousemove', move);
          document.addEventListener('mouseup', up);
        });
      }
    })();
    let formXmlPath = '';
    let modulePath = '';

    function esc(s) {
      if (s == null) return '';
      var t = String(s);
      return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    var CONTAINER_TAGS = new Set(['UsualGroup','Pages','Page','Table','AutoCommandBar','Form','Group','CollapsibleGroup']);
    var FORM_ROOT_ID = '__form_root__';
    var expandedIds = new Set();
    var requisiteExpandedPaths = new Set();
    var selectedRequisiteFullPath = null;
    function isContainerTag(tag) { return tag && CONTAINER_TAGS.has(tag); }
    function isRealElement(it) { var t = it.tag; return t && t !== ':@' && !String(t).startsWith('@'); }
    function getItemTitle(item) {
      if (!item) return '';
      var props = item.properties;
      if (props && props['Title'] != null) {
        var t = extractDisplayValue(props['Title']);
        if (t && String(t).trim() !== '') return String(t).trim();
      }
      return item.name || '';
    }
    function getTreeIcon(tag) {
      if (!tag) return '';
      var icons = { Button: '\u25B6', InputField: '\u2395', SearchStringAddition: '\u2395', FormattedDocumentField: '\u2395', ValueList: '\u2395', CheckBoxField: '\u2610', Hyperlink: '\u1F517', LabelField: '\u2630', Table: '\u22EE', Page: '\u2302', Pages: '\u2302', Form: '\u2302', Group: '\u2302', UsualGroup: '\u2302', CollapsibleGroup: '\u2302', AutoCommandBar: '\u2699' };
      return icons[tag] || '\u25A0';
    }
    function getDataPathValue(item) {
      if (!item || !item.properties) return '';
      var raw = item.properties['DataPath'];
      if (raw != null) {
        var val = extractDisplayValue(raw);
        if (val !== '') return val;
      }
      for (var k in item.properties) {
        if (k === ':@' || k.startsWith('@')) continue;
        var local = k.indexOf(':') >= 0 ? k.split(':').pop() : k;
        if (local === 'DataPath') {
          var v = item.properties[k];
          return extractDisplayValue(v);
        }
      }
      return '';
    }
    function hasDataPath(item) { return getDataPathValue(item).length > 0; }
    function isDescendantOfItem(items, sourceId, targetId) {
      if (sourceId === targetId) return true;
      for (var i = 0; i < items.length; i++) {
        var id = items[i].id || items[i].name;
        if (id === targetId) {
          return (items[i].childItems || []).some(function(c) { return (c.id||c.name) === sourceId || (c.childItems && isDescendantOfItem(c.childItems, sourceId, id)); });
        }
        if (items[i].childItems && isDescendantOfItem(items[i].childItems, sourceId, targetId)) return true;
      }
      return false;
    }
    function getFlatVisibleIds(items, expandedIds, parentItem) {
      if (!items || !items.length) return [];
      var list = (parentItem && parentItem.tag === 'Table') ? items.filter(function(it) { return isRealElement(it); }) : items;
      var out = [];
      for (var i = 0; i < list.length; i++) {
        var item = list[i];
        var itemId = (item.id != null ? String(item.id) : (item.name != null ? String(item.name) : ''));
        out.push(itemId);
        var tag = item.tag || '';
        if (isContainerTag(tag) && expandedIds.has(itemId) && item.childItems && item.childItems.length)
          out = out.concat(getFlatVisibleIds(item.childItems, expandedIds, item));
      }
      return out;
    }
    function applyTreeSelection() {
      document.querySelectorAll('.tree-node').forEach(function(n) {
        var id = n.dataset.id;
        var selected = selectedIds.indexOf(id) >= 0;
        n.classList.toggle('selected', !!selected);
        n.setAttribute('aria-selected', selected ? 'true' : 'false');
      });
      var countEl = document.getElementById('tree-selection-count');
      if (countEl) {
        if (selectedIds.length > 1) {
          countEl.textContent = 'Выбрано элементов: ' + selectedIds.length;
          countEl.style.display = 'block';
        } else {
          countEl.textContent = '';
          countEl.style.display = 'none';
        }
      }
    }
    function renderTree(items, parentEl, parentItem) {
      if (!items || !items.length) return;
      var list = (parentItem && parentItem.tag === 'Table') ? items.filter(function(it) { return isRealElement(it); }) : items;
      if (!list.length) return;
      var ul = document.createElement('div');
      ul.className = 'tree-children' + (parentItem && parentItem.tag === 'Table' ? ' tree-table-columns' : '');
      list.forEach(function(item) {
        var itemId = (item.id != null ? String(item.id) : (item.name != null ? String(item.name) : ''));
        var tag = item.tag || '';
        var isContainer = isContainerTag(tag);
        var expanded = isContainer && expandedIds.has(itemId);
        var hasChildren = isContainer && item.childItems && item.childItems.length;
        var div = document.createElement('div');
        div.className = 'tree-node' + (isContainer ? ' tree-node-container' : '');
        div.setAttribute('role', 'treeitem');
        if (hasChildren) div.setAttribute('aria-expanded', expanded);
        div.setAttribute('aria-selected', 'false');
        div.draggable = true;
        div.dataset.id = itemId;
        div.dataset.tag = tag;
        var labelText = (item.name || item.tag) + ' (' + tag + ')';
        var chevronSpan = document.createElement('span');
        if (hasChildren) {
          chevronSpan.className = 'tree-chevron' + (expanded ? '' : ' collapsed');
          chevronSpan.textContent = '\u25BC';
          chevronSpan.setAttribute('aria-hidden', 'true');
          chevronSpan.addEventListener('click', function(e) {
            e.stopPropagation();
            if (expandedIds.has(itemId)) { expandedIds.delete(itemId); } else { expandedIds.add(itemId); }
            var root = document.getElementById('tree-root');
            root.innerHTML = '';
            renderTreeWithRoot(root);
            applyTreeSelection();
          });
        } else {
          chevronSpan.className = 'tree-chevron-placeholder';
        }
        var iconSpan = document.createElement('span');
        iconSpan.className = 'tree-icon';
        iconSpan.textContent = getTreeIcon(tag);
        iconSpan.setAttribute('aria-hidden', 'true');
        var labelSpan = document.createElement('span');
        labelSpan.className = 'tree-node-label';
        labelSpan.textContent = labelText;
        labelSpan.title = labelText;
        div.appendChild(chevronSpan);
        div.appendChild(iconSpan);
        if (hasDataPath(item)) {
          var dataBoundSpan = document.createElement('span');
          dataBoundSpan.className = 'tree-node-data-bound';
          dataBoundSpan.textContent = '\u25A0';
          dataBoundSpan.setAttribute('aria-hidden', 'true');
          dataBoundSpan.title = getDataPathValue(item);
          div.appendChild(dataBoundSpan);
        }
        div.appendChild(labelSpan);
        div.ondragstart = function(e) {
          if (selectedIds.length > 1) { e.preventDefault(); return; }
          e.dataTransfer.setData('text/plain', div.dataset.id);
          e.dataTransfer.effectAllowed = 'move';
        };
        div.ondragover = function(e) {
          e.preventDefault();
          if (e.dataTransfer.types.indexOf(REQUISITE_DROP_TYPE) >= 0) {
            if (isContainerTag(div.dataset.tag)) { e.dataTransfer.dropEffect = 'copy'; div.classList.add('drop-target'); }
            return;
          }
          var srcId = e.dataTransfer.getData('text/plain');
          if (!srcId || srcId === div.dataset.id) return;
          if (!isContainerTag(div.dataset.tag)) return;
          if (formModel && formModel.childItemsRoot && isDescendantOfItem(formModel.childItemsRoot, srcId, div.dataset.id)) return;
          e.dataTransfer.dropEffect = 'move';
          div.classList.add('drop-target');
        };
        div.ondragleave = function() { div.classList.remove('drop-target'); };
        div.ondrop = function(e) {
          e.preventDefault();
          div.classList.remove('drop-target');
          var requisiteName = e.dataTransfer.getData(REQUISITE_DROP_TYPE);
          if (requisiteName) {
            if (!isContainerTag(div.dataset.tag)) return;
            vscode.postMessage({ type: 'addElementFromRequisite', requisiteName: requisiteName, dataPath: requisiteName, targetId: div.dataset.id, index: 0 });
            return;
          }
          var srcId = e.dataTransfer.getData('text/plain');
          if (!srcId || srcId === div.dataset.id) return;
          if (!isContainerTag(div.dataset.tag)) return;
          if (formModel && formModel.childItemsRoot && isDescendantOfItem(formModel.childItemsRoot, srcId, div.dataset.id)) return;
          vscode.postMessage({ type: 'dragDrop', sourceId: srcId, targetId: div.dataset.id, index: 0 });
        };
        div._formItem = item;
        div.addEventListener('click', function(e) {
          if (e.target.classList.contains('tree-chevron')) return;
          e.stopPropagation();
          var id = div.dataset.id;
          var ctrl = e.ctrlKey || e.metaKey;
          var shift = e.shiftKey;
          if (shift && anchorId != null) {
            var flat = getFlatVisibleIds(formModel.childItemsRoot, expandedIds, null);
            var anchorIdx = flat.indexOf(anchorId);
            var clickIdx = flat.indexOf(id);
            if (anchorIdx >= 0 && clickIdx >= 0) {
              var lo = Math.min(anchorIdx, clickIdx);
              var hi = Math.max(anchorIdx, clickIdx);
              selectedIds = flat.slice(lo, hi + 1);
            } else {
              selectedIds = [id];
              anchorId = id;
            }
          } else if (ctrl) {
            var idx = selectedIds.indexOf(id);
            if (idx >= 0) {
              selectedIds = selectedIds.slice(0, idx).concat(selectedIds.slice(idx + 1));
              anchorId = selectedIds.length ? selectedIds[selectedIds.length - 1] : id;
            } else {
              selectedIds = selectedIds.concat([id]);
              anchorId = id;
            }
          } else {
            selectedIds = [id];
            anchorId = id;
          }
          applyTreeSelection();
          updateToolbarState();
          selectedAttributeId = null;
          selectedCommandId = null;
          updatePropsPanel();
          vscode.postMessage({ type: 'selectElement', elementId: selectedIds.length ? selectedIds[0] : undefined, selectedIds: selectedIds.slice(), ctrlKey: ctrl, shiftKey: shift });
        });
        ul.appendChild(div);
        if (hasChildren && expanded) renderTree(item.childItems, div, item);
      });
      parentEl.appendChild(ul);
    }

    /**
     * Render the full form tree with a synthetic «Форма» root node.
     * The root node has data-id=FORM_ROOT_ID and accepts drops to move elements to childItemsRoot.
     */
    function renderTreeWithRoot(treeRoot) {
      if (!formModel || !formModel.childItemsRoot) return;
      // Create synthetic root node «Форма»
      var rootDiv = document.createElement('div');
      rootDiv.className = 'tree-node tree-node-container';
      rootDiv.setAttribute('role', 'treeitem');
      rootDiv.setAttribute('aria-expanded', 'true');
      rootDiv.setAttribute('aria-selected', 'false');
      rootDiv.dataset.id = FORM_ROOT_ID;
      rootDiv.dataset.tag = 'Form';
      // Chevron placeholder (always expanded, no toggle)
      var chevronSpan = document.createElement('span');
      chevronSpan.className = 'tree-chevron-placeholder';
      rootDiv.appendChild(chevronSpan);
      // Icon
      var iconSpan = document.createElement('span');
      iconSpan.className = 'tree-icon';
      iconSpan.textContent = '\u2302';
      iconSpan.setAttribute('aria-hidden', 'true');
      rootDiv.appendChild(iconSpan);
      // Label
      var labelSpan = document.createElement('span');
      labelSpan.className = 'tree-node-label';
      var formLabel = '\u0424\u043e\u0440\u043c\u0430'; // «Форма»
      labelSpan.textContent = formLabel;
      labelSpan.title = formLabel;
      rootDiv.appendChild(labelSpan);
      // Drag-over handler
      rootDiv.ondragover = function(e) {
        e.preventDefault();
        if (e.dataTransfer.types.indexOf(REQUISITE_DROP_TYPE) >= 0) return;
        var srcId = e.dataTransfer.getData('text/plain');
        if (!srcId || srcId === FORM_ROOT_ID) return;
        e.dataTransfer.dropEffect = 'move';
        rootDiv.classList.add('drop-target');
      };
      rootDiv.ondragleave = function() { rootDiv.classList.remove('drop-target'); };
      // Drop handler
      rootDiv.ondrop = function(e) {
        e.preventDefault();
        rootDiv.classList.remove('drop-target');
        var requisiteName = e.dataTransfer.getData(REQUISITE_DROP_TYPE);
        if (requisiteName) return; // requisite drops not supported on root
        var srcId = e.dataTransfer.getData('text/plain');
        if (!srcId || srcId === FORM_ROOT_ID) return;
        vscode.postMessage({ type: 'dragDrop', sourceId: srcId, targetId: FORM_ROOT_ID, index: 0 });
      };
      treeRoot.appendChild(rootDiv);
      // Render children inside the root node
      var syntheticFormItem = { tag: 'Form', id: FORM_ROOT_ID, name: 'Form', properties: {}, childItems: formModel.childItemsRoot };
      renderTree(formModel.childItemsRoot, rootDiv, syntheticFormItem);
    }

    function createPreviewControl(item, tag) {
      var label = getItemTitle(item) || (item.name || tag) + '';
      var wrap = document.createElement('div');
      wrap.className = 'preview-control-wrap';
      if (tag === 'InputField' || tag === 'SearchStringAddition' || tag === 'FormattedDocumentField' || tag === 'ValueList') {
        wrap.className = 'preview-control-wrap preview-field-row';
        var lbl = document.createElement('span');
        lbl.className = 'preview-field-label';
        lbl.textContent = label || '\u2014';
        var inp = document.createElement('input');
        inp.type = 'text';
        inp.placeholder = '';
        inp.readOnly = true;
        inp.className = 'preview-input';
        wrap.appendChild(lbl);
        wrap.appendChild(inp);
      } else if (tag === 'CheckBoxField') {
        wrap.className = 'preview-control-wrap preview-field-row';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.disabled = true;
        var lblCb = document.createElement('span');
        lblCb.className = 'preview-field-label';
        lblCb.textContent = label || '\u2014';
        wrap.appendChild(lblCb);
        wrap.appendChild(cb);
      } else if (tag === 'Button' || tag === 'Hyperlink') {
        var btn = document.createElement(tag === 'Hyperlink' ? 'a' : 'button');
        btn.textContent = label || (item.name || tag);
        btn.disabled = true;
        btn.className = 'preview-button';
        wrap.appendChild(btn);
      } else if (tag === 'LabelField') {
        var lab = document.createElement('span');
        lab.textContent = label || '\u2014';
        lab.className = 'preview-label';
        wrap.appendChild(lab);
      } else if (tag === 'Table') {
        var tableWrap = document.createElement('div');
        tableWrap.className = 'preview-table-mock';
        var tbl = document.createElement('table');
        var thead = document.createElement('thead');
        var headTr = document.createElement('tr');
        var tableCols = (item.childItems || []).filter(function(it) { return isRealElement(it); });
        tableCols.forEach(function(colItem) {
          var th = document.createElement('th');
          th.textContent = getItemTitle(colItem) || (colItem.name || colItem.tag) || '\u2014';
          th.dataset.id = colItem.id || colItem.name || '';
          th.setAttribute('data-id', th.dataset.id);
          headTr.appendChild(th);
        });
        if (tableCols.length === 0) {
          var thEmpty = document.createElement('th');
          thEmpty.textContent = label || (item.name || 'Таблица');
          headTr.appendChild(thEmpty);
        }
        thead.appendChild(headTr);
        tbl.appendChild(thead);
        var tbody = document.createElement('tbody');
        var dataTr = document.createElement('tr');
        var td = document.createElement('td');
        td.colSpan = Math.max(1, tableCols.length);
        td.textContent = '(пусто)';
        td.style.color = 'var(--vscode-descriptionForeground)';
        dataTr.appendChild(td);
        tbody.appendChild(dataTr);
        tbl.appendChild(tbody);
        tableWrap.appendChild(tbl);
        wrap.appendChild(tableWrap);
      } else if (tag === 'Page' || tag === 'Pages') {
        var pageBlock = document.createElement('div');
        pageBlock.className = tag === 'Pages' ? 'preview-group-block' : 'preview-page-block';
        var pageTitle = document.createElement('div');
        pageTitle.className = tag === 'Page' ? 'preview-page-title' : 'preview-group-title';
        pageTitle.textContent = (tag === 'Pages' ? '' : (label || (item.name || 'Страница')));
        if (pageTitle.textContent) pageBlock.appendChild(pageTitle);
        wrap.appendChild(pageBlock);
        wrap._mockupChildContainer = pageBlock;
      } else if (isContainerTag(tag)) {
        var groupBlock = document.createElement('div');
        groupBlock.className = 'preview-group-block';
        if (label) {
          var groupTitle = document.createElement('div');
          groupTitle.className = 'preview-group-title';
          groupTitle.textContent = label;
          groupBlock.appendChild(groupTitle);
        }
        wrap.appendChild(groupBlock);
        wrap._mockupChildContainer = groupBlock;
      } else {
        var fall = document.createElement('span');
        fall.className = 'preview-fallback';
        fall.textContent = label + (tag ? ' (' + tag + ')' : '');
        wrap.appendChild(fall);
      }
      return wrap;
    }
    function renderPreview(items, parentEl) {
      parentEl.innerHTML = '';
      parentEl.classList.remove('preview-placeholder');
      if (items && items.length) parentEl.classList.add('preview-mockup-form');
      else parentEl.classList.remove('preview-mockup-form');
      if (!items || !items.length) {
        parentEl.textContent = 'Нет элементов';
        return;
      }
      items.forEach(function(item) {
        var id = (item.id != null ? String(item.id) : (item.name != null ? String(item.name) : ''));
        var tag = item.tag || '';
        var isContainer = isContainerTag(tag);
        var div = document.createElement('div');
        div.className = 'preview-item ' + (isContainer ? 'preview-container' : 'preview-control');
        div.dataset.id = id;
        div.dataset.tag = tag;
        var controlWrap = createPreviewControl(item, tag);
        div.appendChild(controlWrap);
        div.draggable = true;
        div.ondragstart = function(e) { e.dataTransfer.setData('text/plain', id); e.dataTransfer.effectAllowed = 'move'; };
        div.ondragover = function(e) {
          e.preventDefault();
          if (e.dataTransfer.types.indexOf(REQUISITE_DROP_TYPE) >= 0) {
            if (isContainer) { e.dataTransfer.dropEffect = 'copy'; div.classList.add('drop-target'); }
            return;
          }
          var srcId = e.dataTransfer.getData('text/plain');
          if (!srcId || srcId === id) return;
          if (!isContainer) return;
          if (formModel && formModel.childItemsRoot && isDescendantOfItem(formModel.childItemsRoot, srcId, id)) return;
          e.dataTransfer.dropEffect = 'move';
          div.classList.add('drop-target');
        };
        div.ondragleave = function() { div.classList.remove('drop-target'); };
        div.ondrop = function(e) {
          e.preventDefault();
          div.classList.remove('drop-target');
          var requisiteName = e.dataTransfer.getData(REQUISITE_DROP_TYPE);
          if (requisiteName) {
            if (!isContainer) return;
            var ch = div.querySelector('.preview-children');
            var kids = ch ? ch.children : [];
            var dropY = e.clientY;
            var idx = 0;
            for (var i = 0; i < kids.length; i++) {
              var r = kids[i].getBoundingClientRect();
              if (dropY > r.top + r.height / 2) idx = i + 1;
            }
            vscode.postMessage({ type: 'addElementFromRequisite', requisiteName: requisiteName, dataPath: requisiteName, targetId: id, index: idx, source: 'preview' });
            return;
          }
          var srcId = e.dataTransfer.getData('text/plain');
          if (!srcId || srcId === id) return;
          if (!isContainer) return;
          if (formModel && formModel.childItemsRoot && isDescendantOfItem(formModel.childItemsRoot, srcId, id)) return;
          var ch = div.querySelector('.preview-children');
          var kids = ch ? ch.children : [];
          var dropY = e.clientY;
          var idx = 0;
          for (var i = 0; i < kids.length; i++) {
            var r = kids[i].getBoundingClientRect();
            if (dropY > r.top + r.height / 2) idx = i + 1;
          }
          vscode.postMessage({ type: 'dragDrop', sourceId: srcId, targetId: id, index: idx, source: 'preview' });
        };
        div._formItem = item;
        div.addEventListener('click', function(e) {
          if (e.target.closest && e.target.closest('th[data-id]')) return;
          e.stopPropagation();
          document.querySelectorAll('.preview-item.selected').forEach(function(n) { n.classList.remove('selected'); });
          selectedIds = [id];
          anchorId = id;
          applyTreeSelection();
          div.classList.add('selected');
          updateToolbarState();
          selectedAttributeId = null;
          selectedCommandId = null;
          updatePropsPanel();
          vscode.postMessage({ type: 'selectElement', elementId: id, selectedIds: selectedIds.slice() });
        });
        parentEl.appendChild(div);
        if (tag === 'Table') {
          var ths = controlWrap.querySelectorAll('th[data-id]');
          for (var ti = 0; ti < ths.length; ti++) {
            (function(th) {
              var colId = th.getAttribute('data-id');
              if (!colId) return;
              th.addEventListener('click', function(ev) {
                ev.stopPropagation();
                document.querySelectorAll('.preview-item.selected').forEach(function(n) { n.classList.remove('selected'); });
                controlWrap.querySelectorAll('th.selected').forEach(function(t) { t.classList.remove('selected'); });
                selectedIds = [colId];
                anchorId = colId;
                th.classList.add('selected');
                applyTreeSelection();
                updateToolbarState();
                selectedAttributeId = null;
                selectedCommandId = null;
                updatePropsPanel();
                vscode.postMessage({ type: 'selectElement', elementId: colId, selectedIds: selectedIds.slice() });
              });
            })(ths[ti]);
          }
        } else if (isContainer && item.childItems && item.childItems.length && controlWrap._mockupChildContainer) {
          var childWrap = controlWrap._mockupChildContainer;
          childWrap.className = 'preview-children' + (tag === 'AutoCommandBar' ? ' preview-buttons-container' : '');
          renderPreview(item.childItems, childWrap);
        }
      });
    }

    function findElement(model, id) {
      if (!model || !id) return null;
      const find = (arr) => {
        for (const item of arr) {
          if ((item.id && item.id === id) || item.name === id) return item;
          if (item.childItems && item.childItems.length) {
            const f = find(item.childItems);
            if (f) return f;
          }
        }
        return null;
      };
      return find(model.childItemsRoot || []);
    }
    function findParentAndIndex(root, elementId) {
      if (!root || !elementId) return null;
      for (var i = 0; i < root.length; i++) {
        if ((root[i].id && root[i].id === elementId) || root[i].name === elementId) return { parent: root, index: i };
        if (root[i].childItems && root[i].childItems.length) {
          var found = findParentAndIndex(root[i].childItems, elementId);
          if (found) return found;
        }
      }
      return null;
    }
    function getPasteTargetId() {
      if (!formModel || !selectedIds.length) return null;
      for (var i = 0; i < selectedIds.length; i++) {
        var el = findElement(formModel, selectedIds[i]);
        if (el && isContainerTag(el.tag)) return selectedIds[i];
      }
      return null;
    }
    function updateToolbarState() {
      var addBtn = document.getElementById('tb-add');
      var delBtn = document.getElementById('tb-delete');
      var upBtn = document.getElementById('tb-up');
      var downBtn = document.getElementById('tb-down');
      var copyBtn = document.getElementById('tb-copy');
      var pasteBtn = document.getElementById('tb-paste');
      var saveBtn = document.getElementById('tb-save');
      var cancelBtn = document.getElementById('tb-cancel');
      if (!addBtn) return;
      var hasModel = formModel && formModel.childItemsRoot;
      var singleId = selectedIds.length === 1 ? selectedIds[0] : null;
      var selectedItem = hasModel && singleId ? findElement(formModel, singleId) : null;
      var isContainer = selectedItem && isContainerTag(selectedItem.tag);
      var loc = hasModel && singleId ? findParentAndIndex(formModel.childItemsRoot, singleId) : null;
      var isFirst = loc ? loc.index <= 0 : true;
      var isLast = loc ? loc.index >= loc.parent.length - 1 : true;
      var hasSelection = selectedIds.length > 0;
      var pasteTarget = getPasteTargetId();
      addBtn.disabled = !hasModel || (singleId && !isContainer);
      delBtn.disabled = !hasModel || !hasSelection;
      upBtn.disabled = !hasModel || !singleId || isFirst || selectedIds.length > 1;
      downBtn.disabled = !hasModel || !singleId || isLast || selectedIds.length > 1;
      copyBtn.disabled = !hasModel || !hasSelection;
      pasteBtn.disabled = !hasModel || !clipboardBuffer || !pasteTarget;
      saveBtn.disabled = !hasModel;
      if (cancelBtn) cancelBtn.disabled = false;
    }

    function extractDisplayValue(v) {
      if (v == null) return '';
      if (typeof v === 'string') return v.trim();
      if (Array.isArray(v)) {
        if (v.length === 0) return '';
        return extractDisplayValue(v[0]);
      }
      if (typeof v === 'object') {
        var keys = Object.keys(v);
        if (v['#text'] !== undefined && v['#text'] !== null) return String(v['#text']).trim();
        for (var i = 0; i < keys.length; i++) {
          var key = keys[i];
          if (key === ':@' || key.startsWith('@')) continue;
          var local = key.indexOf(':') >= 0 ? key.split(':').pop() : key;
          if (local === 'content') {
            var c = v[key];
            if (typeof c === 'string') return c.trim();
            if (Array.isArray(c) && c.length) return extractDisplayValue(c[0]);
            if (c && typeof c === 'object' && c['#text'] !== undefined) return String(c['#text']).trim();
            var inner = extractDisplayValue(c);
            if (inner !== '') return inner;
          }
        }
        for (var j = 0; j < keys.length; j++) {
          var key2 = keys[j];
          if (key2 === ':@' || key2.startsWith('@')) continue;
          var local2 = key2.indexOf(':') >= 0 ? key2.split(':').pop() : key2;
          if (local2 === 'item') {
            var itemVal = v[key2];
            var fromItem = extractDisplayValue(Array.isArray(itemVal) ? itemVal[0] : itemVal);
            if (fromItem !== '') return fromItem;
          }
        }
        var atObj = v[':@'];
        if (atObj && typeof atObj === 'object' && !Array.isArray(atObj)) {
          var name = atObj['@_name'];
          if (typeof name === 'string' && name.trim() !== '') return name.trim();
        }
        for (var n = 0; n < keys.length; n++) {
          if (keys[n] === ':@' || keys[n].startsWith('@')) continue;
          var res = extractDisplayValue(v[keys[n]]);
          if (res !== '') return res;
        }
      }
      return '';
    }
    function valuesEqual(a, b) {
      var sa = (typeof a === 'object' && a !== null) ? extractDisplayValue(a) : (a == null ? '' : String(a));
      var sb = (typeof b === 'object' && b !== null) ? extractDisplayValue(b) : (b == null ? '' : String(b));
      return sa === sb;
    }
    function getAttributeTypeDisplay(attr) {
      if (!attr || !attr.properties) return '';
      var v = attr.properties['Type'];
      if (v != null) return extractDisplayValue(v) || '';
      for (var k in attr.properties) {
        if (k === ':@' || k.startsWith('@')) continue;
        if (k === 'Type' || (k.indexOf('Type') >= 0 && k.length > 4)) return extractDisplayValue(attr.properties[k]) || '';
      }
      return '';
    }
    function getAttributeUsage(attr) {
      if (!attr) return '\u2014';
      if (attr.usage != null) return String(attr.usage);
      if (!attr.properties) return '\u2014';
      var v = attr.properties['Usage'] || attr.properties['Использование'];
      if (v != null) return extractDisplayValue(v) || '\u2014';
      for (var k in attr.properties) {
        if (k === ':@' || k.startsWith('@')) continue;
        if (k === 'Usage' || k.indexOf('Usage') >= 0) return extractDisplayValue(attr.properties[k]) || '\u2014';
      }
      return '\u2014';
    }
    function buildRequisiteTree(model) {
      if (!model || !model.childItemsRoot || !model.childItemsRoot.length) return [];
      var rootMap = {};
      function ensureNode(segments) {
        if (!segments || !segments.length) return null;
        var first = segments[0];
        if (!rootMap[first]) rootMap[first] = { pathSegment: first, fullPath: first, children: [], formElementIds: [] };
        if (segments.length === 1) return rootMap[first];
        var parent = rootMap[first];
        for (var i = 1; i < segments.length; i++) {
          var seg = segments[i];
          var full = segments.slice(0, i + 1).join('.');
          var child = parent.children.filter(function(c) { return c.fullPath === full; })[0];
          if (!child) {
            child = { pathSegment: seg, fullPath: full, children: [], formElementIds: [] };
            parent.children.push(child);
          }
          parent = child;
        }
        return parent;
      }
      function walk(items) {
        if (!items || !items.length) return;
        items.forEach(function(item) {
          var dataPath = getDataPathValue(item);
          if (dataPath && dataPath.trim().length > 0) {
            var segments = dataPath.split('.').map(function(s) { return s.trim(); }).filter(Boolean);
            if (segments.length) {
              var node = ensureNode(segments);
              if (node) node.formElementIds.push(String(item.id != null ? item.id : (item.name != null ? item.name : '')));
            }
          }
          if (item.childItems && item.childItems.length) walk(item.childItems);
        });
      }
      walk(model.childItemsRoot);
      return Object.keys(rootMap).sort().map(function(k) { return rootMap[k]; });
    }
    function collectRequisitesFromTree(model) {
      if (!model || !model.childItemsRoot || !model.childItemsRoot.length) return [];
      var map = {};
      function walk(items) {
        if (!items || !items.length) return;
        items.forEach(function(item) {
          var dataPath = getDataPathValue(item);
          if (dataPath && dataPath.length > 0) {
            var segment = dataPath.indexOf('.') >= 0 ? dataPath.split('.')[0].trim() : dataPath.trim();
            if (segment) {
              if (!map[segment]) map[segment] = [];
              var label = (typeof item.name === 'string' ? item.name : extractDisplayValue(item.name)) || (item.id != null ? String(item.id) : '') || dataPath;
              if (map[segment].indexOf(label) < 0) map[segment].push(label);
            }
          }
          if (item.childItems && item.childItems.length) walk(item.childItems);
        });
      }
      walk(model.childItemsRoot);
      return Object.keys(map).sort().map(function(name) {
        return { name: name, usage: map[name].join(', '), fromTree: true };
      });
    }
    function collectCommandsFromTree(model) {
      if (!model || !model.childItemsRoot || !model.childItemsRoot.length) return [];
      var set = {};
      function walk(items) {
        if (!items || !items.length) return;
        items.forEach(function(item) {
          var cmdName = (item.properties && (item.properties['CommandName'] != null || item.properties['Command'] != null)) ?
            (extractDisplayValue(item.properties['CommandName']) || extractDisplayValue(item.properties['Command']) || '') : '';
          if (cmdName && cmdName.length > 0) {
            var normalized = cmdName.replace(/^Form\\.Command\\./i, '').trim();
            if (normalized) set[normalized] = true;
          }
          if (item.childItems && item.childItems.length) walk(item.childItems);
        });
      }
      walk(model.childItemsRoot);
      return Object.keys(set).sort().map(function(name) {
        return { name: name, fromTree: true };
      });
    }
    var REQUISITE_DROP_TYPE = 'application/x-1c-form-requisite';
    function renderAttributesTable(attributes, fromTree) {
      var tbody = document.getElementById('attributes-tbody');
      if (!tbody) return;
      tbody.innerHTML = '';
      if (!attributes || !attributes.length) return;
      attributes.forEach(function(attr) {
        var tr = document.createElement('tr');
        tr.dataset.id = String(attr.id || attr.name);
        tr.dataset.name = attr.name;
        if (attr.fromTree) tr.dataset.fromTree = 'true';
        tr.draggable = !attr.fromTree;
        if (!attr.fromTree) {
          tr.ondragstart = function(e) {
            e.dataTransfer.setData(REQUISITE_DROP_TYPE, attr.name || '');
            e.dataTransfer.effectAllowed = 'copy';
          };
        }
        var nameCell = document.createElement('td');
        nameCell.textContent = attr.name || '';
        var usageCell = document.createElement('td');
        usageCell.textContent = getAttributeUsage(attr);
        var typeCell = document.createElement('td');
        typeCell.textContent = attr.fromTree ? '\u2014' : (getAttributeTypeDisplay(attr) || '\u2014');
        tr.appendChild(nameCell);
        tr.appendChild(usageCell);
        tr.appendChild(typeCell);
        tr.addEventListener('click', function() {
          selectedAttributeId = attr.name || attr.id;
          selectedCommandId = null;
          document.querySelectorAll('#attributes-tbody tr.selected').forEach(function(r) { r.classList.remove('selected'); });
          tr.classList.add('selected');
          document.querySelectorAll('#commands-tbody tr.selected').forEach(function(r) { r.classList.remove('selected'); });
          if (!attr.fromTree) {
            document.getElementById('btn-edit-attribute').disabled = false;
            document.getElementById('btn-delete-attribute').disabled = false;
          }
          updatePropsPanel();
        });
        tbody.appendChild(tr);
      });
    }
    function renderRequisiteTree(nodes, containerEl) {
      if (!containerEl) return;
      containerEl.innerHTML = '';
      if (!nodes || !nodes.length) return;
      containerEl.className = 'tree-children';
      function renderNode(node, parentEl, depth) {
        var depthPx = (depth || 0) * 16;
        var div = document.createElement('div');
        div.className = 'tree-node requisite-tree-node' + (node.children && node.children.length ? ' tree-node-container' : '');
        div.setAttribute('role', 'treeitem');
        div.dataset.fullPath = node.fullPath || '';
        div.style.paddingLeft = depthPx + 'px';
        var hasChildren = node.children && node.children.length;
        var expanded = hasChildren && requisiteExpandedPaths.has(node.fullPath);
        if (hasChildren) div.setAttribute('aria-expanded', expanded);
        var chevronSpan = document.createElement('span');
        chevronSpan.className = 'tree-chevron' + (hasChildren ? (expanded ? '' : ' collapsed') : ' tree-chevron-placeholder');
        if (hasChildren) chevronSpan.textContent = '\u25BC';
        chevronSpan.setAttribute('aria-hidden', 'true');
        var labelSpan = document.createElement('span');
        labelSpan.className = 'tree-node-label';
        labelSpan.textContent = node.pathSegment || node.fullPath || '';
        if (node.formElementIds && node.formElementIds.length > 0) {
          var badge = document.createElement('span');
          badge.className = 'fe-badge requisite-count';
          badge.textContent = node.formElementIds.length;
          badge.title = 'Элементов формы: ' + node.formElementIds.length;
          labelSpan.appendChild(badge);
        }
        div.appendChild(chevronSpan);
        div.appendChild(labelSpan);
        if (hasChildren) {
          chevronSpan.addEventListener('click', function(e) {
            e.stopPropagation();
            if (requisiteExpandedPaths.has(node.fullPath)) requisiteExpandedPaths.delete(node.fullPath);
            else requisiteExpandedPaths.add(node.fullPath);
            renderRequisiteTree(buildRequisiteTree(formModel), document.getElementById('attributes-tree-root'));
            applyRequisiteTreeSelection();
          });
        }
        if (node.formElementIds && selectedIds.length === 1 && node.formElementIds.indexOf(selectedIds[0]) >= 0) div.classList.add('selected');
        if (selectedRequisiteFullPath === node.fullPath) div.classList.add('selected');
        div.addEventListener('click', function(e) {
          if (e.target.closest && e.target.closest('.tree-chevron')) return;
          document.querySelectorAll('#attributes-tree-root .requisite-tree-node.selected').forEach(function(n) { n.classList.remove('selected'); });
          document.querySelectorAll('#attributes-tbody tr.selected').forEach(function(r) { r.classList.remove('selected'); });
          div.classList.add('selected');
          selectedRequisiteFullPath = node.fullPath;
          selectedAttributeId = null;
          selectedCommandId = null;
          if (node.formElementIds && node.formElementIds.length > 0) {
            selectedIds = [node.formElementIds[0]];
            anchorId = selectedIds[0];
            applyTreeSelection();
            updateToolbarState();
            updatePropsPanel();
            vscode.postMessage({ type: 'selectElement', elementId: selectedIds[0], selectedIds: selectedIds.slice() });
          } else {
            selectedIds = [];
            anchorId = null;
            applyTreeSelection();
            updateToolbarState();
            updatePropsPanel();
          }
        });
        parentEl.appendChild(div);
        if (hasChildren && expanded) {
          var childContainer = document.createElement('div');
          childContainer.className = 'tree-children';
          div.appendChild(childContainer);
          node.children.forEach(function(ch) { renderNode(ch, childContainer, (depth || 0) + 1); });
        }
      }
      nodes.forEach(function(n) { renderNode(n, containerEl, 0); });
    }
    function applyRequisiteTreeSelection() {
      document.querySelectorAll('#attributes-tree-root .requisite-tree-node').forEach(function(n) {
        var path = n.dataset.fullPath;
        n.classList.toggle('selected', path && selectedRequisiteFullPath === path);
      });
    }
    function renderCommandsTable(commands, fromTree) {
      var tbody = document.getElementById('commands-tbody');
      if (!tbody) return;
      tbody.innerHTML = '';
      if (!commands || !commands.length) return;
      commands.forEach(function(cmd) {
        var tr = document.createElement('tr');
        tr.dataset.id = String(cmd.id || cmd.name);
        tr.dataset.name = cmd.name;
        if (cmd.fromTree) tr.dataset.fromTree = 'true';
        var nameCell = document.createElement('td');
        nameCell.textContent = cmd.name || '';
        var titleCell = document.createElement('td');
        titleCell.textContent = (cmd.properties && cmd.properties['Title'] != null) ? extractDisplayValue(cmd.properties['Title']) : (cmd.fromTree ? '' : '');
        tr.appendChild(nameCell);
        tr.appendChild(titleCell);
        tr.addEventListener('click', function() {
          selectedCommandId = cmd.name || cmd.id;
          selectedAttributeId = null;
          document.querySelectorAll('#commands-tbody tr.selected').forEach(function(r) { r.classList.remove('selected'); });
          tr.classList.add('selected');
          document.querySelectorAll('#attributes-tbody tr.selected').forEach(function(r) { r.classList.remove('selected'); });
          if (!cmd.fromTree) document.getElementById('btn-delete-command').disabled = false;
          updatePropsPanel();
        });
        tbody.appendChild(tr);
      });
    }
    function updatePropsPanel() {
      if (selectedAttributeId && formModel && formModel.attributes) {
        var attr = formModel.attributes.find(function(a) { return a.name === selectedAttributeId || a.id === selectedAttributeId; });
        if (attr) { renderAttributeProps(attr); return; }
      }
      if (selectedAttributeId && document.querySelector('#attributes-tbody tr.selected[data-from-tree="true"]')) {
        var placeholder = document.getElementById('props-placeholder');
        var content = document.getElementById('props-content');
        var actions = document.getElementById('props-actions');
        var header = document.getElementById('props-header');
        if (placeholder && content && header) {
          header.textContent = 'Реквизит по элементам';
          content.style.display = 'none';
          content.innerHTML = '';
          placeholder.style.display = 'block';
          placeholder.textContent = 'Секция Attributes в Form.xml пуста. Реквизиты показаны по привязкам элементов (DataPath).';
          if (actions) actions.style.display = 'none';
        }
        return;
      }
      if (selectedCommandId && formModel && formModel.commands) {
        var cmd = formModel.commands.find(function(c) { return c.name === selectedCommandId || c.id === selectedCommandId; });
        if (cmd) { renderCommandProps(cmd); return; }
      }
      if (selectedCommandId && document.querySelector('#commands-tbody tr.selected[data-from-tree="true"]')) {
        var placeholder = document.getElementById('props-placeholder');
        var content = document.getElementById('props-content');
        var actions = document.getElementById('props-actions');
        var header = document.getElementById('props-header');
        if (placeholder && content && header) {
          header.textContent = 'Команда по элементам';
          content.style.display = 'none';
          content.innerHTML = '';
          placeholder.style.display = 'block';
          placeholder.textContent = 'Секция Commands в Form.xml пуста. Команды показаны по кнопкам (CommandName).';
          if (actions) actions.style.display = 'none';
        }
        return;
      }
      if (selectedRequisiteFullPath && selectedIds.length === 0) {
        var placeholder = document.getElementById('props-placeholder');
        var content = document.getElementById('props-content');
        var actions = document.getElementById('props-actions');
        var header = document.getElementById('props-header');
        if (placeholder && content && header) {
          header.textContent = 'Реквизит: ' + selectedRequisiteFullPath;
          content.style.display = 'none';
          placeholder.style.display = 'block';
          placeholder.textContent = '';
          if (actions) actions.style.display = 'none';
        }
        return;
      }
      if (selectedIds.length === 0) {
        renderProps(null);
      } else if (selectedIds.length === 1) {
        var one = findElement(formModel, selectedIds[0]);
        if (one) renderProps(one); else renderProps(null);
      } else {
        var elements = selectedIds.map(function(sid) { return findElement(formModel, sid); }).filter(Boolean);
        if (elements.length) renderPropsMultiple(elements); else renderProps(null);
      }
    }
    function renderAttributeProps(attr) {
      var placeholder = document.getElementById('props-placeholder');
      var content = document.getElementById('props-content');
      var actions = document.getElementById('props-actions');
      var propsHeader = document.getElementById('props-header');
      if (!attr) return;
      if (propsHeader) propsHeader.textContent = 'Реквизит: ' + (attr.name || '');
      placeholder.style.display = 'none';
      content.style.display = 'block';
      actions.style.display = 'block';
      var html = '<div class="props-block"><p class="props-block-title">Основные</p>';
      html += '<div class="prop-row"><label>Имя</label> <div class="prop-input-wrap"><input id="attr-prop-name" value="' + esc(attr.name) + '"></div></div>';
      html += '<div class="prop-row"><label>ID</label> <div class="prop-input-wrap"><input id="attr-prop-id" value="' + esc(attr.id) + '"></div></div></div>';
      if (attr.properties && Object.keys(attr.properties).some(function(k) { return k !== ':@' && !k.startsWith('@'); })) {
        html += '<div class="props-block"><p class="props-block-title">Свойства</p>';
        for (var k in attr.properties) {
          if (k === ':@' || k.startsWith('@')) continue;
          var v = attr.properties[k];
          var val = (typeof v === 'object' && v !== null) ? extractDisplayValue(v) : (typeof v === 'string' ? v : String(v));
          html += '<div class="prop-row"><label>' + esc(k) + '</label> <div class="prop-input-wrap"><input data-key="' + esc(k) + '" data-attr-id="' + esc(attr.name || attr.id) + '" value="' + esc(val || '') + '"></div></div>';
        }
        html += '</div>';
      }
      content.innerHTML = html;
      content.querySelectorAll('input').forEach(function(inp) {
        inp.addEventListener('change', function() {
          var elementId = attr.name || attr.id;
          if (inp.id === 'attr-prop-name') vscode.postMessage({ type: 'propertyChange', elementId: elementId, section: 'attributes', key: 'name', value: inp.value });
          else if (inp.id === 'attr-prop-id') vscode.postMessage({ type: 'propertyChange', elementId: elementId, section: 'attributes', key: 'id', value: inp.value });
          else if (inp.dataset.key) vscode.postMessage({ type: 'propertyChange', elementId: elementId, section: 'attributes', key: inp.dataset.key, value: inp.value });
        });
      });
    }
    function renderCommandProps(cmd) {
      var placeholder = document.getElementById('props-placeholder');
      var content = document.getElementById('props-content');
      var actions = document.getElementById('props-actions');
      var propsHeader = document.getElementById('props-header');
      if (!cmd) return;
      if (propsHeader) propsHeader.textContent = 'Команда: ' + (cmd.name || '');
      placeholder.style.display = 'none';
      content.style.display = 'block';
      actions.style.display = 'block';
      var html = '<div class="props-block"><p class="props-block-title">Основные</p>';
      html += '<div class="prop-row"><label>Имя</label> <div class="prop-input-wrap"><input id="cmd-prop-name" value="' + esc(cmd.name) + '"></div></div>';
      html += '<div class="prop-row"><label>ID</label> <div class="prop-input-wrap"><input id="cmd-prop-id" value="' + esc(cmd.id) + '"></div></div></div>';
      if (cmd.properties && Object.keys(cmd.properties).some(function(k) { return k !== ':@' && !k.startsWith('@'); })) {
        html += '<div class="props-block"><p class="props-block-title">Свойства</p>';
        for (var k in cmd.properties) {
          if (k === ':@' || k.startsWith('@')) continue;
          var v = cmd.properties[k];
          var val = (typeof v === 'object' && v !== null) ? extractDisplayValue(v) : (typeof v === 'string' ? v : String(v));
          html += '<div class="prop-row"><label>' + esc(k) + '</label> <div class="prop-input-wrap"><input data-key="' + esc(k) + '" value="' + esc(val || '') + '"></div></div>';
        }
        html += '</div>';
      }
      content.innerHTML = html;
      content.querySelectorAll('input').forEach(function(inp) {
        inp.addEventListener('change', function() {
          var elementId = cmd.name || cmd.id;
          if (inp.id === 'cmd-prop-name') vscode.postMessage({ type: 'propertyChange', elementId: elementId, section: 'commands', key: 'name', value: inp.value });
          else if (inp.id === 'cmd-prop-id') vscode.postMessage({ type: 'propertyChange', elementId: elementId, section: 'commands', key: 'id', value: inp.value });
          else if (inp.dataset.key) vscode.postMessage({ type: 'propertyChange', elementId: elementId, section: 'commands', key: inp.dataset.key, value: inp.value });
        });
      });
    }
    function renderProps(el) {
      const placeholder = document.getElementById('props-placeholder');
      const content = document.getElementById('props-content');
      const actions = document.getElementById('props-actions');
      const propsHeader = document.getElementById('props-header');
      if (!el) {
        if (propsHeader) propsHeader.textContent = '';
        placeholder.style.display = 'block';
        content.style.display = 'none';
        content.innerHTML = '';
        actions.style.display = 'none';
        return;
      }
      if (propsHeader) propsHeader.textContent = (el.name || '') + ' (' + (el.tag || '') + ')';
      placeholder.style.display = 'none';
      actions.style.display = 'block';
      var html = '<div class="props-block"><p class="props-block-title">Основные</p>';
      html += '<div class="prop-row"><label>Тип</label> <span class="fe-badge">' + esc(el.tag || '') + '</span></div>';
      html += '<div class="prop-row"><label>Имя</label> <div class="prop-input-wrap"><input id="prop-name" value="' + esc(el.name) + '"></div></div>';
      html += '<div class="prop-row"><label>ID</label> <div class="prop-input-wrap"><input id="prop-id" value="' + esc(el.id) + '"></div></div></div>';
      if (el.properties && typeof el.properties === 'object' && Object.keys(el.properties).some(function(k) { return k !== ':@' && !k.startsWith('@'); })) {
        html += '<div class="props-block"><p class="props-block-title">Свойства</p>';
        for (var k in el.properties) {
          if (k === ':@' || k.startsWith('@')) continue;
          var v = el.properties[k];
          var val = (typeof v === 'object' && v !== null) ? extractDisplayValue(v) : (typeof v === 'string' ? v : String(v));
          html += '<div class="prop-row"><label>' + esc(k) + '</label> <div class="prop-input-wrap"><input data-key="' + esc(k) + '" value="' + esc(val || '') + '"></div></div>';
        }
        html += '</div>';
      }
      if (el.events && typeof el.events === 'object' && Object.keys(el.events).length) {
        html += '<div class="props-block"><p class="props-block-title">События</p>';
        for (var evName in el.events) {
          var methodName = el.events[evName];
          html += '<div class="prop-row"><label>' + esc(evName) + '</label> <div class="prop-input-wrap"><input class="event-method-input" data-event="' + esc(evName) + '" value="' + esc(methodName || '') + '" placeholder="Имя процедуры"></div> <button type="button" class="btn-goto-proc" data-proc="' + esc(methodName || '') + '">Перейти</button></div>';
        }
        html += '</div>';
      }
      content.innerHTML = html;
      content.style.display = 'block';
      content.querySelectorAll('input').forEach(inp => {
        inp.addEventListener('change', () => {
          var elementId = el.id || el.name;
          if (inp.classList.contains('event-method-input') && inp.dataset.event) {
            vscode.postMessage({ type: 'propertyChange', elementId: elementId, section: 'events', key: inp.dataset.event, value: inp.value });
            return;
          }
          const key = inp.dataset.key || inp.id ? inp.id.replace('prop-', '') : null;
          if (key) vscode.postMessage({ type: 'propertyChange', elementId: elementId, key, value: inp.value });
          if (inp.id === 'prop-name') vscode.postMessage({ type: 'propertyChange', elementId: elementId, key: 'name', value: inp.value });
          if (inp.id === 'prop-id') vscode.postMessage({ type: 'propertyChange', elementId: elementId, key: 'id', value: inp.value });
        });
      });
      content.querySelectorAll('.btn-goto-proc').forEach(btn => {
        btn.addEventListener('click', function() {
          var row = this.closest('.prop-row');
          var input = row ? row.querySelector('.event-method-input') : null;
          var proc = (input && input.value && input.value.trim()) ? input.value.trim() : (this.dataset.proc || '');
          if (proc) vscode.postMessage({ type: 'openModule', procedureName: proc });
        });
      });
    }
    function renderPropsMultiple(elements) {
      const placeholder = document.getElementById('props-placeholder');
      const content = document.getElementById('props-content');
      const actions = document.getElementById('props-actions');
      const propsHeader = document.getElementById('props-header');
      if (!elements || !elements.length) {
        if (propsHeader) propsHeader.textContent = '';
        placeholder.style.display = 'block';
        content.style.display = 'none';
        content.innerHTML = '';
        actions.style.display = 'block';
        return;
      }
      var N = elements.length;
      if (propsHeader) propsHeader.textContent = 'Выбрано элементов: ' + N;
      placeholder.style.display = 'none';
      actions.style.display = 'block';
      var propKeys = {};
      elements.forEach(function(el) {
        if (el.properties && typeof el.properties === 'object') {
          for (var k in el.properties) {
            if (k === ':@' || k.startsWith('@')) continue;
            propKeys[k] = (propKeys[k] || 0) + 1;
          }
        }
      });
      var commonPropKeys = Object.keys(propKeys).filter(function(k) { return propKeys[k] === N; });
      var eventKeys = {};
      elements.forEach(function(el) {
        if (el.events && typeof el.events === 'object') {
          for (var ev in el.events) { eventKeys[ev] = (eventKeys[ev] || 0) + 1; }
        }
      });
      var commonEventKeys = Object.keys(eventKeys).filter(function(ev) { return eventKeys[ev] === N; });
      var tags = elements.map(function(el) { return el.tag || ''; });
      var sameTag = tags.every(function(t) { return t === tags[0]; });
      var html = '<div class="props-block"><p class="props-block-title">Основные</p>';
      html += '<div class="prop-row"><label>Тип</label> <span class="fe-badge">' + (sameTag ? esc(tags[0]) : 'Разные') + '</span></div>';
      html += '<div class="prop-row"><label>Имя</label> <div class="prop-input-wrap"><input id="prop-name" readonly placeholder="Разные" value=""></div></div>';
      html += '<div class="prop-row"><label>ID</label> <div class="prop-input-wrap"><input id="prop-id" readonly placeholder="Разные" value=""></div></div></div>';
      if (commonPropKeys.length) {
        html += '<div class="props-block"><p class="props-block-title">Свойства</p>';
        commonPropKeys.forEach(function(k) {
          var vals = elements.map(function(el) { var v = el.properties[k]; return (typeof v === 'object' && v !== null) ? extractDisplayValue(v) : (v == null ? '' : String(v)); });
          var same = vals.every(function(v) { return v === vals[0]; });
          var val = same ? (vals[0] || '') : '';
          var placeholderAttr = same ? '' : ' placeholder="Разные значения"';
          html += '<div class="prop-row"><label>' + esc(k) + '</label> <div class="prop-input-wrap"><input data-key="' + esc(k) + '" value="' + esc(val) + '"' + placeholderAttr + '></div></div>';
        });
        html += '</div>';
      }
      if (commonEventKeys.length) {
        html += '<div class="props-block"><p class="props-block-title">События</p>';
        commonEventKeys.forEach(function(evName) {
          var vals = elements.map(function(el) { return (el.events && el.events[evName]) ? String(el.events[evName]).trim() : ''; });
          var same = vals.every(function(v) { return v === vals[0]; });
          var val = same ? (vals[0] || '') : '';
          var placeholderAttr = same ? '' : ' placeholder="Разные значения"';
          html += '<div class="prop-row"><label>' + esc(evName) + '</label> <div class="prop-input-wrap"><input class="event-method-input" data-event="' + esc(evName) + '" value="' + esc(val) + '"' + placeholderAttr + ' placeholder="Имя процедуры"></div> <button type="button" class="btn-goto-proc" data-proc="">Перейти</button></div>';
        });
        html += '</div>';
      }
      if (!commonPropKeys.length && !commonEventKeys.length) {
        html = '<div class="placeholder">Нет общих свойств для выбранных элементов</div>';
      }
      content.innerHTML = html;
      content.style.display = 'block';
      content.querySelectorAll('input').forEach(inp => {
        if (inp.id === 'prop-name' || inp.id === 'prop-id') return;
        inp.addEventListener('change', function() {
          var key = inp.dataset.key;
          var section = inp.classList.contains('event-method-input') ? 'events' : undefined;
          var evKey = inp.dataset.event;
          var payloadKey = section === 'events' ? evKey : key;
          vscode.postMessage({ type: 'propertyChange', elementIds: selectedIds.slice(), section: section, key: payloadKey, value: inp.value });
        });
      });
      content.querySelectorAll('.btn-goto-proc').forEach(btn => {
        btn.addEventListener('click', function() {
          var row = this.closest('.prop-row');
          var input = row ? row.querySelector('.event-method-input') : null;
          var proc = (input && input.value && input.value.trim()) ? input.value.trim() : '';
          if (proc) vscode.postMessage({ type: 'openModule', procedureName: proc });
        });
      });
    }

    document.getElementById('btn-cancel').addEventListener('click', () => {
      vscode.postMessage({ type: 'cancel' });
    });
    document.getElementById('btn-save').addEventListener('click', () => {
      document.getElementById('save-status').textContent = 'Сохранение...';
      vscode.postMessage({ type: 'save', formModel: formModel });
    });
    document.getElementById('tb-cancel').addEventListener('click', () => { vscode.postMessage({ type: 'cancel' }); });
    document.getElementById('tb-save').addEventListener('click', () => {
      document.getElementById('save-status').textContent = 'Сохранение...';
      vscode.postMessage({ type: 'save', formModel: formModel });
    });
    document.getElementById('tb-add').addEventListener('click', () => {
      if (!formModel) return;
      var parentId = getPasteTargetId();
      if (!parentId && selectedIds.length === 1) parentId = findElement(formModel, selectedIds[0]) && isContainerTag(findElement(formModel, selectedIds[0]).tag) ? selectedIds[0] : undefined;
      vscode.postMessage({ type: 'addElement', parentId: parentId, tag: 'InputField', name: 'NewItem' });
    });
    document.getElementById('tb-delete').addEventListener('click', () => {
      if (!selectedIds.length) return;
      if (selectedIds.length === 1) {
        vscode.postMessage({ type: 'deleteElement', elementId: selectedIds[0] });
      } else {
        vscode.postMessage({ type: 'deleteElement', elementIds: selectedIds.slice() });
      }
    });
    document.getElementById('tb-up').addEventListener('click', () => {
      if (selectedIds.length !== 1) return;
      vscode.postMessage({ type: 'moveElementSibling', elementId: selectedIds[0], direction: 'up' });
    });
    document.getElementById('tb-down').addEventListener('click', () => {
      if (selectedIds.length !== 1) return;
      vscode.postMessage({ type: 'moveElementSibling', elementId: selectedIds[0], direction: 'down' });
    });
    document.getElementById('tb-copy').addEventListener('click', () => {
      if (!selectedIds.length || !formModel) return;
      var items = selectedIds.map(function(id) { return findElement(formModel, id); }).filter(Boolean);
      if (items.length === 1) clipboardBuffer = JSON.parse(JSON.stringify(items[0]));
      else if (items.length > 1) clipboardBuffer = items.map(function(it) { return JSON.parse(JSON.stringify(it)); });
      if (items.length) updateToolbarState();
    });
    document.getElementById('tb-paste').addEventListener('click', () => {
      var targetId = getPasteTargetId();
      if (!clipboardBuffer || !targetId) return;
      vscode.postMessage({ type: 'pasteElement', targetId: targetId, index: 0, clipboard: clipboardBuffer });
    });
    updateToolbarState();

    document.querySelectorAll('[data-left-tab]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var t = this.dataset.leftTab;
        document.querySelectorAll('[data-left-tab]').forEach(function(b) {
          b.classList.toggle('active', b.dataset.leftTab === t);
          b.setAttribute('aria-selected', b.dataset.leftTab === t ? 'true' : 'false');
        });
        document.getElementById('left-tab-elements').style.display = t === 'elements' ? 'block' : 'none';
        document.getElementById('left-command-interface').style.display = t === 'command-interface' ? 'block' : 'none';
      });
    });
    document.querySelector('[data-left-tab="elements"]').classList.add('active');

    document.querySelectorAll('[data-right-tab]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var t = this.dataset.rightTab;
        document.querySelectorAll('[data-right-tab]').forEach(function(b) {
          b.classList.toggle('active', b.dataset.rightTab === t);
          b.setAttribute('aria-selected', b.dataset.rightTab === t ? 'true' : 'false');
        });
        document.getElementById('right-tab-attributes').style.display = t === 'attributes' ? 'flex' : 'none';
        document.getElementById('right-tab-commands').style.display = t === 'commands' ? 'flex' : 'none';
        document.getElementById('right-tab-parameters').style.display = t === 'parameters' ? 'flex' : 'none';
      });
    });
    document.querySelector('[data-right-tab="attributes"]').classList.add('active');

    document.getElementById('btn-add-attribute').addEventListener('click', function() {
      vscode.postMessage({ type: 'addAttribute' });
    });
    document.getElementById('btn-delete-attribute').addEventListener('click', function() {
      if (!selectedAttributeId) return;
      vscode.postMessage({ type: 'deleteAttribute', attributeId: selectedAttributeId, attributeName: selectedAttributeId });
    });
    document.getElementById('btn-add-command').addEventListener('click', function() {
      vscode.postMessage({ type: 'addCommand' });
    });
    document.getElementById('btn-delete-command').addEventListener('click', function() {
      if (!selectedCommandId) return;
      vscode.postMessage({ type: 'deleteCommand', commandId: selectedCommandId, commandName: selectedCommandId });
    });

    document.querySelectorAll('[data-tab]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var t = this.dataset.tab;
        document.querySelectorAll('[data-tab]').forEach(function(b) {
          b.classList.toggle('active', b.dataset.tab === t);
          b.setAttribute('aria-selected', b.dataset.tab === t ? 'true' : 'false');
        });
        document.getElementById('preview-form').style.display = t === 'form' ? 'block' : 'none';
        document.getElementById('preview-module').style.display = t === 'module' ? 'block' : 'none';
      });
    });
    document.querySelector('[data-tab="form"]').classList.add('active');
    document.getElementById('btn-open-module').addEventListener('click', () => {
      vscode.postMessage({ type: 'openModule' });
    });

    function collectContainerIds(items, out) {
      if (!items) return;
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var id = it.id || it.name;
        if (id && isContainerTag(it.tag) && it.childItems && it.childItems.length) {
          out.add(id);
          collectContainerIds(it.childItems, out);
        }
      }
    }
    function getPreviewEmptyStateHtml() {
      return '<div class="preview-empty-state"><p class="preview-empty-title">Форма не содержит элементов</p><p class="preview-empty-hint">Добавьте элементы в дереве или перетащите реквизиты в превью.</p></div>';
    }
    function renderCommandInterface(model) {
      var container = document.getElementById('command-interface-content');
      if (!container) return;
      var html = '';
      html += '<div class="command-interface-section"><p class="command-interface-section-title">Команды формы</p>';
      if (model.commands && model.commands.length) {
        html += '<ul class="command-interface-list">';
        model.commands.forEach(function(cmd) {
          var title = extractDisplayValue(cmd.properties && cmd.properties['Title']);
          var label = (cmd.name || '') + (title ? ' — ' + title : '');
          html += '<li>' + esc(label || cmd.name || '') + '</li>';
        });
        html += '</ul>';
      } else {
        html += '<p class="command-interface-empty">Нет команд формы</p>';
      }
      html += '</div>';
      html += '<div class="command-interface-section"><p class="command-interface-section-title">Командная панель</p>';
      var barName = model.autoCommandBarName || model.autoCommandBarId;
      if (!barName) {
        html += '<p class="command-interface-empty">Командная панель не задана</p>';
      } else {
        html += '<p class="command-interface-list" style="list-style:none; padding:0; margin:0 0 var(--fe-spacing-sm) 0;">Командная панель: ' + esc(barName) + '</p>';
        var barNode = findElement(model, barName);
        if (!barNode) {
          html += '<p class="command-interface-empty">Узел командной панели не найден</p>';
        } else if (barNode.childItems && barNode.childItems.length) {
          html += '<ul class="command-interface-list">';
          barNode.childItems.forEach(function(child) {
            var cmdName = child.properties && (child.properties['CommandName'] != null) ? extractDisplayValue(child.properties['CommandName']) : '';
            var label = (cmdName && cmdName.trim()) ? cmdName : (child.name || child.tag || '');
            html += '<li>' + esc(label) + '</li>';
          });
          html += '</ul>';
        } else {
          html += '<p class="command-interface-empty">Панель пуста</p>';
        }
      }
      html += '</div>';
      container.innerHTML = html;
    }
    window.addEventListener('message', function(event) {
      var msg = event.data;
      if (msg.type === 'formData') {
        formModel = msg.formModel;
        formXmlPath = msg.formXmlPath || '';
        modulePath = msg.modulePath || '';
        if (formModel) {
          selectedIds = selectedIds.filter(function(id) { return findElement(formModel, id); });
          if (anchorId && !findElement(formModel, anchorId)) anchorId = selectedIds.length ? selectedIds[selectedIds.length - 1] : null;
        }
        updateToolbarState();
        var treeRoot = document.getElementById('tree-root');
        var treeError = document.getElementById('tree-error');
        treeRoot.innerHTML = '';
        treeError.style.display = 'none';
        var treeEmpty = document.getElementById('tree-empty');
        if (msg.fileMissing) {
          treeEmpty.style.display = 'block';
          document.getElementById('tree-empty-title').textContent = msg.fileMissingTitle || '';
          document.getElementById('tree-empty-hint').textContent = msg.fileMissingHint || '';
        } else {
          treeEmpty.style.display = 'none';
          expandedIds = new Set();
          if (formModel && formModel.childItemsRoot) collectContainerIds(formModel.childItemsRoot, expandedIds);
          if (formModel && formModel.childItemsRoot && formModel.childItemsRoot.length) {
            renderTreeWithRoot(treeRoot);
            applyTreeSelection();
            renderPreview(formModel.childItemsRoot, document.getElementById('preview-form'));
          } else {
            treeRoot.textContent = 'Нет элементов';
            var pf = document.getElementById('preview-form');
            pf.innerHTML = getPreviewEmptyStateHtml();
            pf.classList.remove('preview-placeholder');
          }
        }
        if (msg.fileMissing) {
          var pf = document.getElementById('preview-form');
          pf.innerHTML = '<div class="preview-empty-state"><p class="preview-empty-title">Превью недоступно</p><p class="preview-empty-hint">Файл формы не найден.</p></div>';
          pf.classList.remove('preview-placeholder');
        }
        document.getElementById('props-actions').style.display = formModel && !msg.fileMissing ? 'block' : 'none';
        if (formModel && !msg.fileMissing) {
          renderCommandInterface(formModel);
          var tableWrap = document.getElementById('attributes-table-wrap');
          var treeWrap = document.getElementById('attributes-tree-wrap');
          var treeRootEl = document.getElementById('attributes-tree-root');
          if (formModel.attributes && formModel.attributes.length > 0) {
            selectedRequisiteFullPath = null;
            if (tableWrap) tableWrap.style.display = '';
            if (treeWrap) treeWrap.style.display = 'none';
            renderAttributesTable(formModel.attributes, false);
          } else {
            if (tableWrap) tableWrap.style.display = 'none';
            if (treeWrap) treeWrap.style.display = '';
            selectedRequisiteFullPath = null;
            requisiteExpandedPaths = new Set();
            var requisiteNodes = buildRequisiteTree(formModel);
            renderRequisiteTree(requisiteNodes, treeRootEl);
          }
          var cmds = (formModel.commands && formModel.commands.length) ? formModel.commands : collectCommandsFromTree(formModel);
          renderCommandsTable(cmds, !!cmds.length && cmds[0].fromTree);
          document.getElementById('btn-edit-attribute').disabled = true;
          document.getElementById('btn-delete-attribute').disabled = true;
          document.getElementById('btn-delete-command').disabled = true;
          selectedAttributeId = null;
          selectedCommandId = null;
        }
        applyTreeSelection();
        updatePropsPanel();
      } else if (msg.type === 'error') {
        document.getElementById('tree-error').textContent = msg.message || 'Ошибка загрузки';
        document.getElementById('tree-error').style.display = 'block';
        document.getElementById('save-status').textContent = 'Ошибка: ' + msg.message;
      } else if (msg.type === 'saved') {
        document.getElementById('save-status').textContent = 'Сохранено';
      } else if (msg.type === 'procedures') {
        window.formProcedures = msg.procedures || [];
      }
    });

    vscode.postMessage({ type: 'load' });
  </script>
</body>
</html>`;
  }
}
