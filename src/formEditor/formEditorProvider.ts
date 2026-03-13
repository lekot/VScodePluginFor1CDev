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
      if (model && msg.section !== undefined && msg.key !== undefined) {
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
    const formXmlPath = document.uri.fsPath;
    const modulePath = path.join(
      path.dirname(path.dirname(formXmlPath)),
      'Ext',
      'Form',
      'Module.bsl'
    );
    const procedureName = msg.procedureName as string | undefined;
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
    body {
      margin: 0;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      height: 100vh;
      display: grid;
      grid-template-columns: 280px 1fr;
      grid-template-rows: 1fr 200px;
      grid-template-areas: "tree props" "tree preview";
    }
    .zone-tree {
      grid-area: tree;
      border-right: 1px solid var(--vscode-panel-border);
      overflow: auto;
      padding: 8px;
    }
    .zone-props {
      grid-area: props;
      border-bottom: 1px solid var(--vscode-panel-border);
      overflow: auto;
      padding: 8px;
    }
    .zone-preview {
      grid-area: preview;
      overflow: auto;
      padding: 8px;
    }
    .zone-tree h3, .zone-props h3, .zone-preview h3 {
      margin: 0 0 8px 0;
      font-size: 0.9em;
      color: var(--vscode-descriptionForeground);
    }
    .props-selection-header {
      margin-bottom: 8px;
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
    }
    .tree-node {
      padding: 2px 4px;
      cursor: pointer;
      border-radius: 2px;
    }
    .tree-node:hover { background: var(--vscode-list-hoverBackground); }
    .tree-node.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .tree-node.drop-target { outline: 2px solid var(--vscode-focusBorder); }
    .tree-children { margin-left: 12px; }
    .placeholder { color: var(--vscode-descriptionForeground); font-style: italic; }
    .empty-state { text-align: center; padding: 16px; color: var(--vscode-descriptionForeground); }
    .empty-state h4 { margin: 0 0 8px 0; font-size: 1em; }
    .empty-state p { margin: 0; font-size: 0.9em; }
    .error { color: var(--vscode-errorForeground); padding: 8px; }
    .tabs { display: flex; gap: 8px; margin-bottom: 8px; }
    .tabs button {
      padding: 6px 14px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      cursor: pointer;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      border-radius: 2px;
    }
    .tabs button:hover { background: var(--vscode-button-hoverBackground); }
    .prop-row { margin-bottom: 6px; }
    .prop-row label { display: inline-block; width: 100px; color: var(--vscode-descriptionForeground); }
    .prop-row input {
      width: 200px;
      padding: 4px 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    .prop-row input:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    #btn-cancel, #btn-save {
      padding: 6px 14px;
      border: none;
      cursor: pointer;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      border-radius: 2px;
    }
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
      padding: 4px 8px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      cursor: pointer;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      border-radius: 2px;
    }
    .btn-goto-proc:hover { background: var(--vscode-button-secondaryHoverBackground); }
  </style>
</head>
<body>
  <div class="zone-tree">
    <h3>Элементы формы</h3>
    <div id="tree-root"></div>
    <div id="tree-empty" class="empty-state" style="display:none;">
      <h4 id="tree-empty-title"></h4>
      <p id="tree-empty-hint"></p>
    </div>
    <div id="tree-error" class="error" style="display:none;"></div>
  </div>
  <div class="zone-props">
    <h3>Свойства</h3>
    <div id="props-header" class="props-selection-header"></div>
    <div id="props-content" style="display:none;"></div>
    <div id="props-placeholder" class="placeholder">Выберите элемент</div>
    <div id="props-actions" style="margin-top:8px;display:none;">
      <button type="button" id="btn-cancel" title="Отмена">Отмена</button>
      <button type="button" id="btn-save" title="Сохранить">Сохранить</button>
      <span id="save-status" style="margin-left:8px;"></span>
    </div>
  </div>
  <div class="zone-preview">
    <h3>Превью</h3>
    <div class="tabs">
      <button type="button" data-tab="form" title="Форма">Форма</button>
      <button type="button" data-tab="module" title="Модуль">Модуль</button>
    </div>
    <div id="preview-form" class="placeholder">Превью формы</div>
    <div id="preview-module" style="display:none;">
      <button type="button" id="btn-open-module" title="Модуль формы">Модуль формы</button>
      <p class="placeholder">Открывает Ext/Form/Module.bsl в редакторе</p>
    </div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    let formModel = null;
    let formXmlPath = '';
    let modulePath = '';

    var CONTAINER_TAGS = new Set(['UsualGroup','Pages','Page','Table','AutoCommandBar','Form','Group','CollapsibleGroup']);
    function isContainerTag(tag) { return tag && CONTAINER_TAGS.has(tag); }
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
    function renderTree(items, parentEl) {
      if (!items || !items.length) return;
      const ul = document.createElement('div');
      ul.className = 'tree-children';
      items.forEach(item => {
        const div = document.createElement('div');
        div.className = 'tree-node';
        div.draggable = true;
        div.dataset.id = item.id || item.name || '';
        div.dataset.tag = item.tag || '';
        div.textContent = (item.name || item.tag) + ' (' + item.tag + ')';
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
        div.addEventListener('click', () => {
          document.querySelectorAll('.tree-node.selected').forEach(n => n.classList.remove('selected'));
          div.classList.add('selected');
          const el = findElement(formModel, div.dataset.id);
          renderProps(el);
          vscode.postMessage({ type: 'selectElement', elementId: div.dataset.id });
        });
        ul.appendChild(div);
        if (item.childItems && item.childItems.length) renderTree(item.childItems, div);
      });
      parentEl.appendChild(ul);
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
      let html = '<div class="prop-row"><label>Тип</label> ' + (el.tag || '') + '</div>';
      html += '<div class="prop-row"><label>Имя</label> <input id="prop-name" value="' + (el.name || '') + '"></div>';
      html += '<div class="prop-row"><label>ID</label> <input id="prop-id" value="' + (el.id || '') + '"></div>';
      if (el.properties && typeof el.properties === 'object') {
        for (const [k, v] of Object.entries(el.properties)) {
          if (k === ':@' || k.startsWith('@')) continue;
          const val = (typeof v === 'object' && v !== null && v['#text'] !== undefined) ? v['#text'] : (typeof v === 'string' ? v : JSON.stringify(v));
          html += '<div class="prop-row"><label>' + k + '</label> <input data-key="' + k + '" value="' + (val || '').toString().replace(/"/g, '&quot;') + '"></div>';
        }
      }
      if (el.events && typeof el.events === 'object' && Object.keys(el.events).length) {
        html += '<div class="prop-row" style="margin-top:8px;"><strong>События</strong></div>';
        for (const [evName, methodName] of Object.entries(el.events)) {
          html += '<div class="prop-row">' + evName + ' → ' + (methodName || '') + ' <button type="button" class="btn-goto-proc" data-proc="' + (methodName || '').replace(/"/g, '&quot;') + '">Перейти</button></div>';
        }
      }
      content.innerHTML = html;
      content.style.display = 'block';
      content.querySelectorAll('input').forEach(inp => {
        inp.addEventListener('change', () => {
          const key = inp.dataset.key || inp.id ? inp.id.replace('prop-', '') : null;
          if (key) vscode.postMessage({ type: 'propertyChange', elementId: el.id || el.name, key, value: inp.value });
          if (inp.id === 'prop-name') vscode.postMessage({ type: 'propertyChange', elementId: el.id || el.name, key: 'name', value: inp.value });
          if (inp.id === 'prop-id') vscode.postMessage({ type: 'propertyChange', elementId: el.id || el.name, key: 'id', value: inp.value });
        });
      });
      content.querySelectorAll('.btn-goto-proc').forEach(btn => {
        btn.addEventListener('click', function() {
          var proc = this.dataset.proc;
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

    document.querySelectorAll('[data-tab]').forEach(btn => {
      btn.addEventListener('click', function() {
        var t = this.dataset.tab;
        document.getElementById('preview-form').style.display = t === 'form' ? 'block' : 'none';
        document.getElementById('preview-module').style.display = t === 'module' ? 'block' : 'none';
      });
    });
    document.getElementById('btn-open-module').addEventListener('click', () => {
      vscode.postMessage({ type: 'openModule' });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'formData') {
        formModel = msg.formModel;
        formXmlPath = msg.formXmlPath || '';
        modulePath = msg.modulePath || '';
        const treeRoot = document.getElementById('tree-root');
        const treeError = document.getElementById('tree-error');
        treeRoot.innerHTML = '';
        treeError.style.display = 'none';
        var treeEmpty = document.getElementById('tree-empty');
        if (msg.fileMissing) {
          treeEmpty.style.display = 'block';
          document.getElementById('tree-empty-title').textContent = msg.fileMissingTitle || '';
          document.getElementById('tree-empty-hint').textContent = msg.fileMissingHint || '';
        } else {
          treeEmpty.style.display = 'none';
          if (formModel && formModel.childItemsRoot && formModel.childItemsRoot.length) {
            renderTree(formModel.childItemsRoot, treeRoot);
          } else {
            treeRoot.textContent = 'Нет элементов';
          }
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
