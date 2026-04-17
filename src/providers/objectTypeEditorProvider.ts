import * as vscode from 'vscode';
import { ObjectTypeDefinition, ObjectableGroup, ObjectTypeInfo, ObjectKind, OBJECT_KINDS_WITHOUT_NAME } from '../types/objectTypeDefinitions';
import { ObjectTypeParser } from '../parsers/objectTypeParser';
import { OBJECT_KIND_ORDER } from '../constants/metadataTypeObjectKinds';
import { Logger } from '../utils/logger';

function escapeJsonForScript(json: string): string {
  return json.replace(/<\/script>/gi, '<\\/script>');
}


const OBJECT_KIND_LABELS: Record<ObjectKind, string> = {
  CatalogObject: 'Объект: Справочники',
  DocumentObject: 'Объект: Документы',
  BusinessProcessObject: 'Объект: Бизнес-процессы',
  TaskObject: 'Объект: Задачи',
  ChartOfCharacteristicTypesObject: 'Объект: Планы видов характеристик',
  ChartOfAccountsObject: 'Объект: Планы счетов',
  ChartOfCalculationTypesObject: 'Объект: Планы видов расчёта',
  ExchangePlanObject: 'Объект: Планы обмена',
  InformationRegisterRecordSet: 'НаборЗаписей: Регистры сведений',
  AccumulationRegisterRecordSet: 'НаборЗаписей: Регистры накопления',
  AccountingRegisterRecordSet: 'НаборЗаписей: Регистры бухгалтерии',
  CalculationRegisterRecordSet: 'НаборЗаписей: Регистры расчёта',
  CatalogManager: 'Менеджер: Справочники (тип целиком)',
  DocumentManager: 'Менеджер: Документы (тип целиком)',
  BusinessProcessManager: 'Менеджер: Бизнес-процессы (тип целиком)',
  TaskManager: 'Менеджер: Задачи (тип целиком)',
  ChartOfCharacteristicTypesManager: 'Менеджер: Планы видов характеристик (тип целиком)',
  ChartOfAccountsManager: 'Менеджер: Планы счетов (тип целиком)',
  ChartOfCalculationTypesManager: 'Менеджер: Планы видов расчёта (тип целиком)',
  ExchangePlanManager: 'Менеджер: Планы обмена (тип целиком)',
  InformationRegisterManager: 'Менеджер: Регистры сведений (тип целиком)',
  AccumulationRegisterManager: 'Менеджер: Регистры накопления (тип целиком)',
  AccountingRegisterManager: 'Менеджер: Регистры бухгалтерии (тип целиком)',
  CalculationRegisterManager: 'Менеджер: Регистры расчёта (тип целиком)',
  ConstantValueManager: 'Менеджер: Константы (тип целиком)',
  DataProcessorManager: 'Менеджер: Обработки (тип целиком)',
  ReportManager: 'Менеджер: Отчёты (тип целиком)',
  DocumentJournalManager: 'Менеджер: Журналы документов (тип целиком)',
  DefinedType: 'Определяемые типы',
};

type WebviewMessage =
  | { type: 'save'; selectedIds: string[] }
  | { type: 'cancel' };

function isValidWebviewMessage(msg: unknown): msg is WebviewMessage {
  if (!msg || typeof msg !== 'object') { return false; }
  const m = msg as { type?: unknown };
  if (typeof m.type !== 'string') { return false; }
  return ['save', 'cancel'].includes(m.type);
}

export class ObjectTypeEditorProvider {
  private panel: vscode.WebviewPanel | undefined;
  private resolvePromise: ((value: ObjectTypeDefinition | null) => void) | undefined;
  private disposables: vscode.Disposable[] = [];

  constructor(private context: vscode.ExtensionContext) {
    Logger.info('ObjectTypeEditorProvider initialized');
  }

  public async show(sourceXML: string, objectableGroups: ObjectableGroup[]): Promise<ObjectTypeDefinition | null> {
    if (!this.panel) {
      this.panel = this.createPanel();
    } else {
      this.panel.reveal(vscode.ViewColumn.Beside);
    }

    let currentDef: ObjectTypeDefinition;
    try {
      currentDef = ObjectTypeParser.parse(sourceXML);
    } catch (error) {
      Logger.error('Failed to parse source XML', error);
      throw new Error(`Failed to parse current source: ${error instanceof Error ? error.message : String(error)}`);
    }

    this.panel.webview.html = this.getWebviewContent(currentDef, objectableGroups);
    Logger.debug('Object type editor panel updated');

    return new Promise<ObjectTypeDefinition | null>((resolve) => {
      this.resolvePromise = resolve;
    });
  }

  private createPanel(): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(
      '1c-metadata-tree.objectTypeEditor',
      'Редактирование Source',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.context.extensionUri],
      }
    );

    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    panel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!isValidWebviewMessage(message)) {
        Logger.warn('Received invalid message from webview', message);
        return;
      }
      await this.handleMessage(message);
    }, null, this.disposables);

    Logger.info('Object type editor panel created');
    return panel;
  }

  /** Build tree data: ordered groups from OBJECT_KIND_ORDER, plus virtual group for unknown entries. */
  private buildTreeData(
    currentDef: ObjectTypeDefinition,
    objectableGroups: ObjectableGroup[]
  ): { kind: string; label: string; children: { id: string; label: string; virtual?: boolean }[] }[] {
    const groupsByKind = new Map<string, Set<string>>();
    for (const g of objectableGroups) {
      groupsByKind.set(g.objectKind, new Set(g.objectNames));
    }

    const virtualEntries: { id: string; label: string; virtual: true }[] = [];
    for (const { objectKind, objectName } of currentDef.types) {
      const names = groupsByKind.get(objectKind);
      if (!names || !names.has(objectName)) {
        virtualEntries.push({ id: `${objectKind}:${objectName}`, label: `${objectKind}.${objectName}`, virtual: true });
      }
    }

    const result: { kind: string; label: string; children: { id: string; label: string; virtual?: boolean }[] }[] = [];

    for (const kind of OBJECT_KIND_ORDER) {
      const names = groupsByKind.get(kind);
      if (!names || names.size === 0) { continue; }

      const isManagerKind = OBJECT_KINDS_WITHOUT_NAME.has(kind);
      let children: { id: string; label: string; virtual?: boolean }[];

      if (isManagerKind) {
        // Manager kinds are "type as a whole" — show single element with the kind label as item label.
        children = [{ id: `${kind}:`, label: OBJECT_KIND_LABELS[kind] ?? kind }];
      } else {
        children = Array.from(names).sort((a, b) => a.localeCompare(b, 'ru')).map((name) => ({
          id: `${kind}:${name}`,
          label: name,
        }));
      }

      result.push({ kind, label: OBJECT_KIND_LABELS[kind] ?? kind, children });
    }

    if (virtualEntries.length > 0) {
      result.push({ kind: '__virtual__', label: 'Отсутствующие в проекте', children: virtualEntries });
    }

    return result;
  }

  private getInitialSelectedIds(currentDef: ObjectTypeDefinition): string[] {
    return currentDef.types.map(({ objectKind, objectName }) => `${objectKind}:${objectName}`);
  }

  private getWebviewContent(currentDef: ObjectTypeDefinition, objectableGroups: ObjectableGroup[]): string {
    const treeData = this.buildTreeData(currentDef, objectableGroups);
    const initialSelectedIds = this.getInitialSelectedIds(currentDef);
    const treeDataJson = escapeJsonForScript(JSON.stringify(treeData));
    const initialSelectedJson = escapeJsonForScript(JSON.stringify(initialSelectedIds));
    const hasSelection = currentDef.types.length > 0;

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>Редактирование Source</title>
        <style>
          * { box-sizing: border-box; }
          body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            margin: 0;
            padding: 16px;
            line-height: 1.5;
          }
          .container { max-width: 600px; margin: 0 auto; }
          .header {
            margin-bottom: 16px;
            border-bottom: 1px solid var(--vscode-input-border);
            padding-bottom: 12px;
          }
          .header h2 { margin: 0; font-size: 18px; font-weight: 600; }
          .section { margin-bottom: 16px; }
          .section-title { font-size: 14px; font-weight: 600; margin-bottom: 6px; display: block; }
          .search-row { margin-bottom: 10px; }
          .search-row input {
            width: 100%;
            padding: 6px 8px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 3px;
            font-size: 13px;
          }
          .search-row input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
          .tree-area {
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            padding: 8px;
            max-height: 380px;
            overflow-y: auto;
          }
          .tree-node { margin: 2px 0; }
          .tree-leaf {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 4px 6px;
            cursor: pointer;
            border-radius: 3px;
          }
          .tree-leaf:hover { background-color: var(--vscode-list-hoverBackground); }
          .tree-leaf input[type="checkbox"] { accent-color: var(--vscode-button-background); flex-shrink: 0; cursor: pointer; }
          .tree-leaf label { cursor: pointer; margin: 0; flex: 1; }
          .tree-leaf.virtual label { color: var(--vscode-descriptionForeground); font-style: italic; }
          .tree-group-label {
            font-weight: 600;
            padding: 4px 0;
            cursor: pointer;
          }
          .tree-group-label:hover { color: var(--vscode-focusBorder); }
          .tree-group-label.virtual-group { color: var(--vscode-descriptionForeground); }
          .tree-group-children { margin-left: 16px; }
          .tree-leaf.hidden, .tree-group.hidden { display: none !important; }
          .button-row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
          button {
            padding: 6px 14px;
            cursor: pointer;
            font-size: 13px;
            font-family: var(--vscode-font-family);
            border-radius: 3px;
            border: none;
          }
          #save-btn { background-color: var(--vscode-button-background); color: var(--vscode-button-foreground); }
          #save-btn:hover { background-color: var(--vscode-button-hoverBackground); }
          #save-btn:disabled { background-color: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: not-allowed; }
          #cancel-btn { background-color: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
          #cancel-btn:hover { background-color: var(--vscode-button-secondaryHoverBackground); }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h2>Редактирование Source</h2>
          </div>
          <div class="section">
            <div class="search-row">
              <input type="text" id="search-input" placeholder="Поиск" autocomplete="off" aria-label="Поиск по объектам">
            </div>
            <span class="section-title">Объекты</span>
            <div class="tree-area" id="object-tree" role="tree" aria-label="Дерево объектов"></div>
          </div>
          <div class="button-row">
            <button type="button" id="cancel-btn" title="Отмена" aria-label="Отмена">Отмена</button>
            <button type="button" id="save-btn" ${hasSelection ? '' : 'disabled'} title="Сохранить" aria-label="Сохранить">Сохранить</button>
          </div>
        </div>
        <script>
          const vscode = acquireVsCodeApi();
          const treeData = ${treeDataJson};
          let selectedIds = new Set(${initialSelectedJson});
          const saveBtn = document.getElementById('save-btn');
          const searchInput = document.getElementById('search-input');
          const treeContainer = document.getElementById('object-tree');

          function escapeAttr(s) { return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
          function escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

          function renderTree() {
            const query = searchInput.value ? searchInput.value.trim().toLowerCase() : '';
            let html = '';
            for (const group of treeData) {
              const isVirtual = group.kind === '__virtual__';
              const groupLabelMatch = !query || group.label.toLowerCase().includes(query);
              let childShowCount = 0;
              let childrenHtml = '';
              for (const c of group.children) {
                const show = !query || c.label.toLowerCase().includes(query);
                if (show) childShowCount++;
                const checked = selectedIds.has(c.id);
                const virtualClass = c.virtual ? ' virtual' : '';
                childrenHtml += '<div class="tree-node tree-leaf' + virtualClass + (show ? '' : ' hidden') + '" data-id="' + escapeAttr(c.id) + '" role="treeitem" aria-selected="' + (checked ? 'true' : 'false') + '">' +
                  '<input type="checkbox" id="cb-' + escapeAttr(c.id) + '"' + (checked ? ' checked' : '') + '><label for="cb-' + escapeAttr(c.id) + '">' + escapeHtml(c.label) + '</label></div>';
              }
              const groupVisible = groupLabelMatch || childShowCount > 0;
              html += '<div class="tree-group' + (groupVisible ? '' : ' hidden') + '">';
              html += '<div class="tree-group-label' + (isVirtual ? ' virtual-group' : '') + '">' + escapeHtml(group.label) + '</div>';
              html += '<div class="tree-group-children">' + childrenHtml + '</div></div>';
            }
            treeContainer.innerHTML = html;
            treeContainer.querySelectorAll('.tree-leaf').forEach(el => {
              const id = el.getAttribute('data-id');
              const cb = el.querySelector('input[type="checkbox"]');
              if (!id || !cb) return;
              el.addEventListener('click', (e) => { if (e.target !== cb) { cb.checked = !cb.checked; } toggleSelection(id, cb.checked); });
              cb.addEventListener('change', () => toggleSelection(id, cb.checked));
            });
          }

          function toggleSelection(id, checked) {
            if (checked) { selectedIds.add(id); } else { selectedIds.delete(id); }
            saveBtn.disabled = selectedIds.size === 0;
          }

          searchInput.addEventListener('input', () => renderTree());

          document.getElementById('cancel-btn').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
          document.getElementById('save-btn').addEventListener('click', () => {
            vscode.postMessage({ type: 'save', selectedIds: Array.from(selectedIds) });
          });

          renderTree();
          saveBtn.disabled = selectedIds.size === 0;
        </script>
      </body>
      </html>
    `;
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    Logger.debug(`Received: ${message.type}`);
    try {
      if (message.type === 'save') {
        await this.handleSaveMessage(message.selectedIds);
      } else if (message.type === 'cancel') {
        await this.handleCancelMessage();
      }
    } catch (error) {
      Logger.error('Error handling message', error);
    }
  }

  private async handleSaveMessage(selectedIds: string[]): Promise<void> {
    if (!this.resolvePromise) {
      Logger.warn('Object type editor save ignored: missing resolvePromise');
      return;
    }
    const types: ObjectTypeInfo[] = selectedIds
      .map((id) => {
        const colonIdx = id.indexOf(':');
        if (colonIdx === -1) { return null; }
        const objectKind = id.slice(0, colonIdx);
        const objectName = id.slice(colonIdx + 1);
        return { objectKind, objectName } as ObjectTypeInfo;
      })
      .filter((t): t is ObjectTypeInfo => t !== null);

    const def: ObjectTypeDefinition = { types };
    this.resolvePromise(def);
    this.resolvePromise = undefined;
    Logger.info('Object type editor: save applied, closing panel');
    if (this.panel) {
      const p = this.panel;
      this.panel = undefined;
      p.dispose();
    }
  }

  private async handleCancelMessage(): Promise<void> {
    Logger.info('Object type editor: cancel applied, closing panel');
    if (this.resolvePromise) {
      this.resolvePromise(null);
      this.resolvePromise = undefined;
    }
    if (this.panel) {
      const p = this.panel;
      this.panel = undefined;
      p.dispose();
    }
  }

  public dispose(): void {
    Logger.info('Disposing ObjectTypeEditorProvider');
    if (this.resolvePromise) { this.resolvePromise(null); this.resolvePromise = undefined; }
    if (this.panel) { this.panel.dispose(); this.panel = undefined; }
    while (this.disposables.length) { const d = this.disposables.pop(); if (d) { d.dispose(); } }
  }
}
