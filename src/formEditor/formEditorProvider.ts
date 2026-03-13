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
import type { FormModel, FormChildItem } from './formModel';
import { writeFormXml } from './formXmlWriter';
import { parseBslModuleProcedures } from './bslModuleParser';
import { getFormPaths } from './formPaths';

/** Minimal custom document for form editor. */
class FormEditorDocument implements vscode.CustomDocument {
  constructor(public readonly uri: vscode.Uri) {}
  dispose(): void {}
}

/** Tags that can contain ChildItems (valid drop targets). */
const CONTAINER_TAGS = new Set([
  'UsualGroup',
  'Pages',
  'Page',
  'Table',
  'AutoCommandBar',
  'Form',
  'Group',
  'CollapsibleGroup',
]);

function isContainer(item: FormChildItem): boolean {
  return CONTAINER_TAGS.has(item.tag);
}

/** Find element by id or name in tree (recursive). */
function findElementById(root: FormChildItem[], elementId: string): FormChildItem | undefined {
  for (const item of root) {
    if ((item.id && item.id === elementId) || item.name === elementId) return item;
    if (item.childItems?.length) {
      const found = findElementById(item.childItems, elementId);
      if (found) return found;
    }
  }
  return undefined;
}

/** Check if sourceId is the same as targetId or is a descendant of target. */
function isDescendantOf(model: FormModel, sourceId: string, targetId: string): boolean {
  if (sourceId === targetId) return true;
  const target = findElementById(model.childItemsRoot, targetId);
  if (!target?.childItems?.length) return false;
  const walk = (items: FormChildItem[]): boolean => {
    for (const item of items) {
      const id = item.id || item.name;
      if (id === sourceId) return true;
      if (item.childItems?.length && walk(item.childItems)) return true;
    }
    return false;
  };
  return walk(target.childItems);
}

/** Find parent array and index of element. */
function findParentAndIndex(
  root: FormChildItem[],
  elementId: string
): { parent: FormChildItem[]; index: number } | null {
  for (let i = 0; i < root.length; i++) {
    if ((root[i].id && root[i].id === elementId) || root[i].name === elementId) {
      return { parent: root, index: i };
    }
    if (root[i].childItems?.length) {
      const found = findParentAndIndex(root[i].childItems!, elementId);
      if (found) return found;
    }
  }
  return null;
}

/** Move node from source to target's childItems at index. */
function moveNodeInModel(
  model: FormModel,
  sourceId: string,
  targetId: string,
  index: number
): boolean {
  const sourceLoc = findParentAndIndex(model.childItemsRoot, sourceId);
  const targetEl = findElementById(model.childItemsRoot, targetId);
  if (!sourceLoc || !targetEl || !isContainer(targetEl)) return false;
  const [node] = sourceLoc.parent.splice(sourceLoc.index, 1);
  if (!node) return false;
  const targetList = targetEl.childItems ?? (targetEl.childItems = []);
  targetList.splice(Math.min(index, targetList.length), 0, node);
  return true;
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
    if (attr) attr.properties[payload.key] = payload.value;
    return;
  }
  if (payload.section === 'commands' && payload.elementId) {
    const cmd = model.commands.find(
      (c) => c.name === payload.elementId || c.id === payload.elementId
    );
    if (cmd) cmd.properties[payload.key] = payload.value;
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
        applyPropertyChange(model, {
          elementId: msg.elementId as string | undefined,
          section: msg.section as string | undefined,
          key: msg.key as string,
          value: msg.value,
        });
      }
    } else if (msg.type === 'save') {
      await this.handleSave(document, webviewPanel, msg);
    } else if (msg.type === 'cancel') {
      await this.handleCancel(document, webviewPanel);
    } else if (msg.type === 'dragDrop') {
      await this.handleDragDrop(document, webviewPanel, msg);
    } else if (msg.type === 'getProcedures') {
      await this.handleGetProcedures(document, webviewPanel);
    } else if (msg.type === 'openModule') {
      await this.handleOpenModule(document, msg);
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
    const sourceId = msg.sourceId as string | undefined;
    const targetId = msg.targetId as string | undefined;
    const index = (msg.index as number | undefined) ?? 0;
    if (!model || sourceId === undefined || targetId === undefined) {
      webviewPanel.webview.postMessage({ type: 'error', message: 'Неверные параметры dragDrop.' });
      return;
    }
    if (sourceId === targetId || isDescendantOf(model, sourceId, targetId)) {
      webviewPanel.webview.postMessage({
        type: 'error',
        message: 'Нельзя переместить элемент в себя или в своего потомка.',
      });
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
      webviewPanel.webview.postMessage({ type: 'error', message: 'Не удалось переместить элемент.' });
      return;
    }
    try {
      await writeFormXml(document.uri.fsPath, model);
      webviewPanel.webview.postMessage({
        type: 'formData',
        formModel: model,
        formXmlPath: document.uri.fsPath,
        modulePath: path.join(path.dirname(path.dirname(document.uri.fsPath)), 'Ext', 'Form', 'Module.bsl'),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      Logger.error('Form editor save after dragDrop failed', err);
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
      overflow: auto;
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
    .zone-props {
      flex: 1;
      min-width: 0;
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
      overflow: auto;
      padding: var(--fe-spacing-sm);
      flex-shrink: 0;
      align-self: stretch;
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
    .tree-node-container { font-weight: 600; }
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
    .tree-children { margin-left: var(--fe-spacing-md); }
    .tree-table-columns { margin-left: var(--fe-spacing-md); }
    .placeholder {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      padding: var(--fe-spacing-md) var(--fe-spacing-sm);
    }
    .preview-placeholder { color: var(--vscode-descriptionForeground); font-style: italic; padding: var(--fe-spacing-sm) 0; }
    .preview-item { padding: var(--fe-spacing-xs) var(--fe-spacing-sm); margin: 2px 0; cursor: pointer; border-radius: var(--fe-radius-md); border: 1px solid var(--vscode-panel-border); }
    .preview-item:hover { background: var(--vscode-list-hoverBackground); }
    .preview-item.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .preview-item.drop-target { outline: 2px solid var(--vscode-focusBorder); }
    .preview-container { background: var(--vscode-editor-inactiveSelectionBackground); min-height: 20px; }
    .preview-control { background: var(--vscode-input-background); }
    .preview-children { margin-left: var(--fe-spacing-md); }
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
  <div class="top-row">
    <div class="zone-tree">
      <h3>Элементы формы</h3>
      <div id="tree-root" role="tree" aria-label="Элементы формы"></div>
      <div id="tree-empty" class="empty-state" style="display:none;">
        <h4 id="tree-empty-title"></h4>
        <p id="tree-empty-hint"></p>
      </div>
      <div id="tree-error" class="error" style="display:none;"></div>
    </div>
    <div class="splitter-v" id="splitter-v" title="Изменить ширину панели"></div>
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
    var expandedIds = new Set();
    function isContainerTag(tag) { return tag && CONTAINER_TAGS.has(tag); }
    function isRealElement(it) { var t = it.tag; return t && t !== ':@' && !String(t).startsWith('@'); }
    function getTreeIcon(tag) {
      if (!tag) return '';
      var icons = { Button: '\u25B6', InputField: '\u2395', SearchStringAddition: '\u2395', FormattedDocumentField: '\u2395', ValueList: '\u2395', CheckBoxField: '\u2610', Hyperlink: '\u1F517', LabelField: '\u2630', Table: '\u22EE', Page: '\u2302', Pages: '\u2302', Form: '\u2302', Group: '\u2302', UsualGroup: '\u2302', CollapsibleGroup: '\u2302', AutoCommandBar: '\u2699' };
      return icons[tag] || '\u25A0';
    }
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
    function renderTree(items, parentEl, parentItem) {
      if (!items || !items.length) return;
      var list = (parentItem && parentItem.tag === 'Table') ? items.filter(function(it) { return isRealElement(it); }) : items;
      if (!list.length) return;
      var ul = document.createElement('div');
      ul.className = 'tree-children' + (parentItem && parentItem.tag === 'Table' ? ' tree-table-columns' : '');
      list.forEach(function(item) {
        var itemId = item.id || item.name || '';
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
            renderTree(formModel.childItemsRoot, root);
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
        div.appendChild(labelSpan);
        div.ondragstart = function(e) { e.dataTransfer.setData('text/plain', div.dataset.id); e.dataTransfer.effectAllowed = 'move'; };
        div.ondragover = function(e) {
          e.preventDefault();
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
          document.querySelectorAll('.tree-node.selected').forEach(function(n) { n.classList.remove('selected'); n.setAttribute('aria-selected', 'false'); });
          div.classList.add('selected');
          div.setAttribute('aria-selected', 'true');
          renderProps(item);
          vscode.postMessage({ type: 'selectElement', elementId: div.dataset.id });
        });
        ul.appendChild(div);
        if (hasChildren && expanded) renderTree(item.childItems, div, item);
      });
      parentEl.appendChild(ul);
    }

    function createPreviewControl(item, tag) {
      var label = (item.name || tag) + '';
      var wrap = document.createElement('div');
      wrap.className = 'preview-control-wrap';
      if (tag === 'InputField' || tag === 'SearchStringAddition' || tag === 'FormattedDocumentField' || tag === 'ValueList') {
        var inp = document.createElement('input');
        inp.type = 'text';
        inp.placeholder = label;
        inp.readOnly = true;
        inp.className = 'preview-input';
        wrap.appendChild(inp);
      } else if (tag === 'CheckBoxField') {
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.disabled = true;
        var lbl = document.createElement('label');
        lbl.textContent = label;
        lbl.style.marginLeft = '6px';
        wrap.appendChild(cb);
        wrap.appendChild(lbl);
      } else if (tag === 'Button' || tag === 'Hyperlink') {
        var btn = document.createElement(tag === 'Hyperlink' ? 'a' : 'button');
        btn.textContent = label;
        btn.disabled = true;
        btn.className = 'preview-button';
        wrap.appendChild(btn);
      } else if (tag === 'LabelField') {
        var lab = document.createElement('span');
        lab.textContent = label;
        lab.className = 'preview-label';
        wrap.appendChild(lab);
      } else if (tag === 'Table') {
        var tbl = document.createElement('div');
        tbl.className = 'preview-table';
        tbl.textContent = label + ' (таблица)';
        wrap.appendChild(tbl);
      } else if (tag === 'Page' || tag === 'Pages') {
        var cap = document.createElement('div');
        cap.className = 'preview-page-caption';
        cap.textContent = label;
        wrap.appendChild(cap);
      } else if (isContainerTag(tag)) {
        var cap2 = document.createElement('div');
        cap2.className = 'preview-group-caption';
        cap2.textContent = label;
        wrap.appendChild(cap2);
      } else {
        var fall = document.createElement('span');
        fall.className = 'preview-fallback';
        fall.textContent = label + ' (' + tag + ')';
        wrap.appendChild(fall);
      }
      return wrap;
    }
    function renderPreview(items, parentEl) {
      parentEl.innerHTML = '';
      parentEl.classList.remove('preview-placeholder');
      if (!items || !items.length) {
        parentEl.textContent = 'Нет элементов';
        return;
      }
      items.forEach(function(item) {
        var id = item.id || item.name || '';
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
          e.stopPropagation();
          document.querySelectorAll('.preview-item.selected').forEach(function(n) { n.classList.remove('selected'); });
          document.querySelectorAll('.tree-node.selected').forEach(function(n) { n.classList.remove('selected'); });
          div.classList.add('selected');
          document.querySelectorAll('.tree-node').forEach(function(n) {
            n.classList.toggle('selected', n._formItem === item);
          });
          renderProps(item);
          vscode.postMessage({ type: 'selectElement', elementId: id });
        });
        if (isContainer && item.childItems && item.childItems.length) {
          var childWrap = document.createElement('div');
          childWrap.className = 'preview-children' + (tag === 'Table' ? ' preview-table-columns' : '');
          parentEl.appendChild(div);
          div.appendChild(childWrap);
          if (tag === 'Table') {
            var tblRow = document.createElement('div');
            tblRow.className = 'preview-table-cols-row';
            var tableCols = item.childItems.filter(function(it) { return isRealElement(it); });
            tableCols.forEach(function(colItem) {
              var colDiv = document.createElement('div');
              colDiv.className = 'preview-item preview-control preview-table-col';
              colDiv.dataset.id = colItem.id || colItem.name || '';
              colDiv.dataset.tag = colItem.tag || '';
              colDiv._formItem = colItem;
              var colLabel = document.createElement('span');
              colLabel.className = 'preview-fallback';
              colLabel.textContent = (colItem.name || colItem.tag) + (colItem.tag ? ' (' + colItem.tag + ')' : '');
              colDiv.appendChild(colLabel);
              colDiv.draggable = false;
              colDiv.addEventListener('click', function(ev) {
                ev.stopPropagation();
                document.querySelectorAll('.preview-item.selected').forEach(function(n) { n.classList.remove('selected'); });
                document.querySelectorAll('.tree-node.selected').forEach(function(n) { n.classList.remove('selected'); });
                colDiv.classList.add('selected');
                document.querySelectorAll('.tree-node').forEach(function(n) {
                  n.classList.toggle('selected', n._formItem === colItem);
                });
                renderProps(colItem);
                vscode.postMessage({ type: 'selectElement', elementId: colDiv.dataset.id });
              });
              tblRow.appendChild(colDiv);
            });
            childWrap.appendChild(tblRow);
          } else {
            renderPreview(item.childItems, childWrap);
          }
        } else {
          parentEl.appendChild(div);
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

    document.getElementById('btn-cancel').addEventListener('click', () => {
      vscode.postMessage({ type: 'cancel' });
    });
    document.getElementById('btn-save').addEventListener('click', () => {
      document.getElementById('save-status').textContent = 'Сохранение...';
      vscode.postMessage({ type: 'save', formModel: formModel });
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
      return '<div class="preview-empty-state"><p class="preview-empty-title">Визуальное превью формы пока не реализовано</p><p class="preview-empty-hint">Структуру можно просматривать в дереве элементов и в панели свойств.</p></div>';
    }
    window.addEventListener('message', function(event) {
      var msg = event.data;
      if (msg.type === 'formData') {
        formModel = msg.formModel;
        formXmlPath = msg.formXmlPath || '';
        modulePath = msg.modulePath || '';
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
            renderTree(formModel.childItemsRoot, treeRoot);
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
