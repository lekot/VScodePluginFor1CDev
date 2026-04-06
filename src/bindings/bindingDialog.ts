/**
 * WOW Phase 2B — webview диалог привязки информационных баз к выгрузке конфигурации (plan §2B #31–35).
 */

import * as vscode from 'vscode';
import type { ConfigurationBinding } from './models/configurationBinding';
import {
  detectIbcmdExtensionNameFromConfigRelativePath,
  normalizeConfigRelativePath,
} from './bindingPathUtils';
import type { ExtensionState } from '../state/extensionState';
import type { MetadataTreeDataProvider } from '../providers/treeDataProvider';
import { Logger } from '../utils/logger';
import {
  openBindingDialogForConfigurationFromTree,
  runDeployForConfigurationFromTree,
  runDeploySelectedObjectsFromTree,
  runDeployChangedFilesFromTree,
  runConfigExportStatusFromTree,
} from './bindingCommands';

const VIEW_TYPE = '1c-binding-dialog';

function escapeJsonForScript(json: string): string {
  return json.replace(/<\/script>/gi, '<\\/script>');
}

function defaultBinding(
  workspaceFolder: string,
  configRelativePath: string,
  ibcmdExtensionName?: string,
): ConfigurationBinding {
  return {
    workspaceFolder,
    configRelativePath,
    infobaseIds: [],
    massDeployment: true,
    ibcmdExtensionName: ibcmdExtensionName?.trim() || undefined,
  };
}

type BindingRowView = { id: string; label: string };

type ExtensionToWebviewMessage =
  | { type: 'applyState'; rows: BindingRowView[]; massDeployment: boolean }
  | { type: 'updateLabels'; labels: Record<string, string> };

type WebviewToExtensionMessage =
  | { type: 'ready' }
  | { type: 'cancel' }
  | {
      type: 'save';
      infobaseIds: string[];
      massDeployment: boolean;
    }
  | { type: 'addFromList'; excludeIds: string[]; massDeployment: boolean }
  | { type: 'addCreate' }
  | { type: 'addExisting' };

function isWebviewMessage(msg: unknown): msg is WebviewToExtensionMessage {
  if (!msg || typeof msg !== 'object') {
    return false;
  }
  const t = (msg as { type?: unknown }).type;
  if (t === 'ready' || t === 'cancel' || t === 'addCreate' || t === 'addExisting') {
    return true;
  }
  if (t === 'addFromList') {
    const m = msg as { excludeIds?: unknown; massDeployment?: unknown };
    const ex = m.excludeIds;
    return Array.isArray(ex) && ex.every((x) => typeof x === 'string') && typeof m.massDeployment === 'boolean';
  }
  if (t === 'save') {
    const m = msg as { infobaseIds?: unknown; massDeployment?: unknown };
    return Array.isArray(m.infobaseIds) && m.infobaseIds.every((x) => typeof x === 'string') && typeof m.massDeployment === 'boolean';
  }
  return false;
}

function buildLabelMap(entries: { id: string; name: string }[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (const e of entries) {
    o[e.id] = e.name;
  }
  return o;
}

function rowsFromBinding(ids: string[], labelMap: Record<string, string>): BindingRowView[] {
  return ids.map((id) => ({
    id,
    label: labelMap[id] ?? `${id} (нет в каталоге)`,
  }));
}

export function getBindingDialogHtml(
  webview: vscode.Webview,
  initial: {
    workspaceFolder: string;
    configRelativePath: string;
    rows: BindingRowView[];
    massDeployment: boolean;
    ibcmdExtensionName?: string;
  },
): string {
  const initialJson = escapeJsonForScript(JSON.stringify(initial));
  const csp = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    `font-src ${webview.cspSource}`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>Привязка баз</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 12px 14px 16px;
      font-family: var(--vscode-font-family);
      font-size: 13px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    h1 {
      margin: 0 0 4px;
      font-size: 14px;
      font-weight: 600;
    }
    .sub {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      margin-bottom: 14px;
      word-break: break-all;
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 12px;
    }
    button {
      font-family: var(--vscode-font-family);
      font-size: 12px;
      padding: 5px 10px;
      border: 1px solid var(--vscode-button-border, var(--vscode-contrastBorder, transparent));
      background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
      color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
      cursor: pointer;
      border-radius: 2px;
    }
    button:hover {
      background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground));
    }
    button.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    button.primary:hover {
      background: var(--vscode-button-hoverBackground);
    }
    button.icon {
      min-width: 28px;
      padding: 4px 6px;
    }
    .list {
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-radius: 4px;
      overflow: hidden;
      margin-bottom: 14px;
    }
    .row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      background: var(--vscode-editor-background);
    }
    .row:last-child { border-bottom: none; }
    .row:nth-child(even) {
      background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-list-hoverBackground) 8%);
    }
    .row.row-dimmed {
      opacity: 0.48;
    }
    .row.row-active {
      box-shadow: inset 3px 0 0 var(--vscode-focusBorder);
    }
    .row-label {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .empty {
      padding: 16px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
    }
    .mass-wrap {
      padding: 10px 12px;
      border-radius: 4px;
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      margin-bottom: 14px;
      transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
    }
    .mass-wrap.on {
      border-color: var(--vscode-focusBorder);
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--vscode-focusBorder) 35%, transparent);
      background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-focusBorder) 12%);
    }
    .mass-wrap label {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      cursor: pointer;
    }
    .mass-wrap input { margin-top: 2px; }
    .mass-hint {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin: 6px 0 0 24px;
    }
    .deploy-hint {
      font-size: 12px;
      margin: 0 0 14px;
      padding: 8px 10px;
      border-radius: 4px;
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
    }
    .deploy-hint.info {
      color: var(--vscode-descriptionForeground);
      background: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-textLink-foreground) 10%);
    }
    .deploy-hint.warn {
      color: var(--vscode-foreground);
      border-color: color-mix(in srgb, var(--vscode-inputValidation-warningBorder) 70%, var(--vscode-widget-border) 30%);
      background: color-mix(in srgb, var(--vscode-editor-background) 82%, var(--vscode-inputValidation-warningBackground) 18%);
    }
    .deploy-hint:empty { display: none; }
    .actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
    }
  </style>
</head>
<body>
  <h1>Привязка информационных баз</h1>
  <div class="sub" id="ctx"></div>
  <div class="toolbar">
    <button type="button" id="btnAddList">Добавить из списка</button>
    <button type="button" id="btnCreate">Создать базу</button>
    <button type="button" id="btnAddExisting">Добавить существующую</button>
  </div>
  <div class="list" id="list"></div>
  <div class="mass-wrap" id="massWrap">
    <label>
      <input type="checkbox" id="massChk" />
      <span>Массовая раскатка во все привязанные базы</span>
    </label>
    <div class="mass-hint">При включении команды раскатки смогут обрабатывать сразу несколько баз по порядку списка.</div>
  </div>
  <div class="deploy-hint" id="deployHint" role="status"></div>
  <div class="actions">
    <button type="button" id="btnCancel">Закрыть</button>
    <button type="button" class="primary" id="btnSave">Сохранить</button>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    let state = ${initialJson};
    let massPrev = state.massDeployment;

    const ctxEl = document.getElementById('ctx');
    const listEl = document.getElementById('list');
    const massChk = document.getElementById('massChk');
    const massWrap = document.getElementById('massWrap');

    function renderContext() {
      let t = state.workspaceFolder + ' · ' + state.configRelativePath;
      if (state.ibcmdExtensionName) {
        t += ' · расширение: ' + state.ibcmdExtensionName;
      }
      ctxEl.textContent = t;
    }

    function setMassVisual(on) {
      massWrap.classList.toggle('on', on);
    }

    function updateDeployHint() {
      const el = document.getElementById('deployHint');
      const n = state.rows.length;
      const mass = massChk.checked;
      el.textContent = '';
      el.className = 'deploy-hint';
      if (n === 0) {
        return;
      }
      if (mass) {
        el.classList.add('info');
        el.textContent =
          n === 1
            ? 'Раскатка будет выполнена в выбранную базу.'
            : 'Раскатка будет выполнена на ' + n + ' баз последовательно.';
      } else {
        el.classList.add('warn');
        el.textContent = 'Раскатка будет выполнена только в базу: ' + state.rows[0].label;
      }
    }

    function renderList() {
      listEl.innerHTML = '';
      if (!state.rows.length) {
        const d = document.createElement('div');
        d.className = 'empty';
        d.textContent = 'Нет привязанных баз. Добавьте из каталога или создайте новую.';
        listEl.appendChild(d);
        updateDeployHint();
        return;
      }
      const mass = massChk.checked;
      state.rows.forEach((row, index) => {
        const r = document.createElement('div');
        r.className = 'row';
        if (!mass && state.rows.length > 0) {
          if (index === 0) {
            r.classList.add('row-active');
          } else {
            r.classList.add('row-dimmed');
          }
        }
        const label = document.createElement('div');
        label.className = 'row-label';
        label.textContent = row.label;
        label.title = row.id;
        const up = document.createElement('button');
        up.type = 'button';
        up.className = 'icon';
        up.textContent = '↑';
        up.setAttribute('aria-label', 'Вверх');
        up.disabled = index === 0;
        up.onclick = () => move(index, -1);
        const down = document.createElement('button');
        down.type = 'button';
        down.className = 'icon';
        down.textContent = '↓';
        down.setAttribute('aria-label', 'Вниз');
        down.disabled = index === state.rows.length - 1;
        down.onclick = () => move(index, 1);
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'icon';
        rm.textContent = '✕';
        rm.setAttribute('aria-label', 'Удалить из привязки');
        rm.onclick = () => removeAt(index);
        r.appendChild(label);
        r.appendChild(up);
        r.appendChild(down);
        r.appendChild(rm);
        listEl.appendChild(r);
      });
      updateDeployHint();
    }

    function move(i, delta) {
      const j = i + delta;
      if (j < 0 || j >= state.rows.length) return;
      const t = state.rows[i];
      state.rows[i] = state.rows[j];
      state.rows[j] = t;
      renderList();
    }

    function removeAt(i) {
      state.rows.splice(i, 1);
      renderList();
    }

    function applyServerState(rows, mass) {
      state.rows = rows;
      massPrev = mass;
      state.massDeployment = mass;
      massChk.checked = mass;
      setMassVisual(mass);
      renderList();
    }

    function applyLabels(labels) {
      state.rows = state.rows.map((r) => ({
        id: r.id,
        label: labels[r.id] != null ? labels[r.id] : r.label,
      }));
      renderList();
    }

    massChk.addEventListener('change', () => {
      const want = massChk.checked;
      if (!want && massPrev) {
        const ok = confirm(
          'Отключить массовую раскатку?\\n\\n' +
          'Список баз останется, но раскатка будет выполняться только в первую базу в списке. Остальные строки будут затенены. Продолжить?'
        );
        if (!ok) {
          massChk.checked = true;
          return;
        }
      }
      massPrev = want;
      state.massDeployment = want;
      setMassVisual(want);
      renderList();
    });

    document.getElementById('btnAddList').onclick = () => {
      vscode.postMessage({
        type: 'addFromList',
        excludeIds: state.rows.map((r) => r.id),
        massDeployment: massChk.checked,
      });
    };
    document.getElementById('btnCreate').onclick = () => vscode.postMessage({ type: 'addCreate' });
    document.getElementById('btnAddExisting').onclick = () => vscode.postMessage({ type: 'addExisting' });
    document.getElementById('btnSave').onclick = () => {
      vscode.postMessage({
        type: 'save',
        infobaseIds: state.rows.map((r) => r.id),
        massDeployment: massChk.checked,
      });
    };
    document.getElementById('btnCancel').onclick = () => vscode.postMessage({ type: 'cancel' });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'applyState') {
        applyServerState(msg.rows, msg.massDeployment);
      } else if (msg.type === 'updateLabels') {
        applyLabels(msg.labels || {});
      }
    });

    massChk.checked = state.massDeployment;
    setMassVisual(state.massDeployment);
    renderContext();
    renderList();
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

/**
 * Панель webview (WOW §2B): порядок баз (↑↓✕), добавление, флаг массовой раскатки,
 * confirm при снятии флага, визуальный режим «только первая база» (design §12.3–12.4).
 */
export class BindingDialogPanel {
  private panel: vscode.WebviewPanel | undefined;
  /** Подписки, привязанные к текущей панели (очищаются при dispose панели). */
  private panelDisposables: vscode.Disposable[] = [];
  private catalogDisposable: vscode.Disposable | undefined;
  private workspaceFolderName = '';
  private configRelativePath = '';
  /** WOW Phase 4 #64 — имя расширения для ibcmd и ключа привязки. */
  private ibcmdExtensionName = '';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly state: ExtensionState,
  ) {}

  dispose(): void {
    this.catalogDisposable?.dispose();
    this.catalogDisposable = undefined;
    vscode.Disposable.from(...this.panelDisposables).dispose();
    this.panelDisposables = [];
    this.panel?.dispose();
    this.panel = undefined;
  }

  private assertDeps(): { bindingManager: NonNullable<ExtensionState['bindingManager']>; storage: NonNullable<ExtensionState['infobaseStorage']> } | undefined {
    const bindingManager = this.state.bindingManager;
    const storage = this.state.infobaseStorage;
    if (!bindingManager || !storage) {
      return undefined;
    }
    return { bindingManager, storage };
  }

  async show(
    workspaceFolderName: string,
    configRelativePath: string,
    ibcmdExtensionName?: string,
  ): Promise<void> {
    const deps = this.assertDeps();
    if (!deps) {
      void vscode.window.showErrorMessage('Привязки недоступны: хранилище не инициализировано.');
      return;
    }

    this.workspaceFolderName = workspaceFolderName;
    this.configRelativePath = configRelativePath;
    this.ibcmdExtensionName = (ibcmdExtensionName ?? '').trim();

    if (!this.panel) {
      this.panelDisposables = [];
      this.panel = vscode.window.createWebviewPanel(
        VIEW_TYPE,
        'Привязка баз',
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [this.context.extensionUri],
        },
      );
      this.panel.onDidDispose(() => this.onPanelDispose(), null, this.panelDisposables);
      this.panel.webview.onDidReceiveMessage((msg: unknown) => void this.onMessage(msg), null, this.panelDisposables);
    } else {
      this.panel.title = 'Привязка баз';
      this.panel.reveal(vscode.ViewColumn.One);
    }

    this.attachCatalogListener(deps.storage);
    await this.reloadWebview(deps.bindingManager, deps.storage);
  }

  private onPanelDispose(): void {
    this.catalogDisposable?.dispose();
    this.catalogDisposable = undefined;
    vscode.Disposable.from(...this.panelDisposables).dispose();
    this.panelDisposables = [];
    this.panel = undefined;
  }

  private attachCatalogListener(storage: NonNullable<ExtensionState['infobaseStorage']>): void {
    this.catalogDisposable?.dispose();
    this.catalogDisposable = storage.onDidChangeCatalog(() => {
      void this.pushLabelUpdate(storage);
    });
  }

  private async pushLabelUpdate(storage: NonNullable<ExtensionState['infobaseStorage']>): Promise<void> {
    if (!this.panel) {
      return;
    }
    const entries = await storage.load();
    const labels = buildLabelMap(entries.map((e) => ({ id: e.id, name: e.name })));
    void this.panel.webview.postMessage({ type: 'updateLabels', labels } satisfies ExtensionToWebviewMessage);
  }

  private async reloadWebview(
    bindingManager: NonNullable<ExtensionState['bindingManager']>,
    storage: NonNullable<ExtensionState['infobaseStorage']>,
  ): Promise<void> {
    if (!this.panel) {
      return;
    }
    const ext = this.ibcmdExtensionName.trim() || undefined;
    const binding =
      (await bindingManager.get(this.workspaceFolderName, this.configRelativePath, ext)) ??
      defaultBinding(this.workspaceFolderName, this.configRelativePath, ext);
    const entries = await storage.load();
    const labelMap = buildLabelMap(entries.map((e) => ({ id: e.id, name: e.name })));
    const rows = rowsFromBinding(binding.infobaseIds, labelMap);
    this.panel.webview.html = getBindingDialogHtml(this.panel.webview, {
      workspaceFolder: binding.workspaceFolder,
      configRelativePath: binding.configRelativePath,
      rows,
      massDeployment: binding.massDeployment,
      ibcmdExtensionName: binding.ibcmdExtensionName ?? ext,
    });
  }

  private async onMessage(msg: unknown): Promise<void> {
    if (!isWebviewMessage(msg)) {
      Logger.warn('bindingDialog: invalid message', msg);
      return;
    }
    const deps = this.assertDeps();
    if (!deps || !this.panel) {
      return;
    }

    switch (msg.type) {
      case 'ready':
        return;
      case 'cancel':
        this.panel.dispose();
        return;
      case 'save': {
        const next: ConfigurationBinding = {
          workspaceFolder: this.workspaceFolderName,
          configRelativePath: this.configRelativePath,
          infobaseIds: msg.infobaseIds,
          massDeployment: msg.massDeployment,
          ibcmdExtensionName: this.ibcmdExtensionName.trim() || undefined,
        };
        try {
          await deps.bindingManager.upsert(next);
          void vscode.window.showInformationMessage('Привязка сохранена в .vscode/infobase-bindings.json.');
          void this.state.refreshBindingTreeDecorations?.();
        } catch (e) {
          Logger.error('bindingDialog: save failed', e);
          void vscode.window.showErrorMessage(`Не удалось сохранить привязку: ${e instanceof Error ? e.message : String(e)}`);
        }
        return;
      }
      case 'addFromList': {
        const entries = await deps.storage.load();
        const exclude = new Set(msg.excludeIds);
        const choices = entries.filter((e) => !exclude.has(e.id));
        if (choices.length === 0) {
          void vscode.window.showInformationMessage('Все базы из каталога уже в списке или каталог пуст.');
          return;
        }
        type PickItem = vscode.QuickPickItem & { id: string };
        const picked = await vscode.window.showQuickPick<PickItem>(
          choices.map((e) => ({ label: e.name, description: e.type, id: e.id })),
          { placeHolder: 'Выберите базу для привязки', matchOnDescription: true },
        );
        if (!picked) {
          return;
        }
        const labelMap = buildLabelMap(entries.map((e) => ({ id: e.id, name: e.name })));
        const merged = [...msg.excludeIds];
        if (!merged.includes(picked.id)) {
          merged.push(picked.id);
        }
        void this.panel.webview.postMessage({
          type: 'applyState',
          rows: rowsFromBinding(merged, labelMap),
          massDeployment: msg.massDeployment,
        } satisfies ExtensionToWebviewMessage);
        return;
      }
      case 'addCreate':
        await vscode.commands.executeCommand('1c-metadata-tree.infobases.create');
        return;
      case 'addExisting':
        await vscode.commands.executeCommand('1c-metadata-tree.infobases.add');
        return;
      default:
        return;
    }
  }
}

export async function runOpenBindingDialog(state: ExtensionState, panel: BindingDialogPanel): Promise<void> {
  if (!state.bindingManager || !state.infobaseStorage) {
    void vscode.window.showErrorMessage('Привязки недоступны: хранилище не инициализировано.');
    return;
  }
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    void vscode.window.showErrorMessage('Откройте папку workspace, чтобы настроить привязки.');
    return;
  }
  let folder = folders[0];
  if (folders.length > 1) {
    type FolderPick = vscode.QuickPickItem & { folder: vscode.WorkspaceFolder };
    const picked = await vscode.window.showQuickPick<FolderPick>(
      folders.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f })),
      { placeHolder: 'Выберите корневую папку workspace' },
    );
    if (!picked) {
      return;
    }
    folder = picked.folder;
  }
  const configPath = await vscode.window.showInputBox({
    title: 'Относительный путь к Configuration.xml',
    value: 'Configuration.xml',
    validateInput: (v) => (v.trim() ? undefined : 'Укажите путь'),
  });
  if (configPath === undefined) {
    return;
  }
  const norm = normalizeConfigRelativePath(configPath);
  const ext = detectIbcmdExtensionNameFromConfigRelativePath(norm);
  await panel.show(folder.name, norm, ext);
}

export function registerBindingDialogCommands(
  context: vscode.ExtensionContext,
  state: ExtensionState,
  treeDataProvider?: MetadataTreeDataProvider | null,
): vscode.Disposable[] {
  const dialog = new BindingDialogPanel(context, state);
  const out: vscode.Disposable[] = [
    vscode.commands.registerCommand('1c-metadata-tree.bindings.openDialog', async () => {
      await runOpenBindingDialog(state, dialog);
    }),
  ];
  if (treeDataProvider) {
    out.push(
      vscode.commands.registerCommand('1c-metadata-tree.bindings.openDialogForConfiguration', async (arg: unknown) => {
        await openBindingDialogForConfigurationFromTree(arg, state, dialog, treeDataProvider);
      }),
      vscode.commands.registerCommand('1c-metadata-tree.config.deploy', async (arg: unknown) => {
        await runDeployForConfigurationFromTree(arg, state, treeDataProvider);
      }),
      vscode.commands.registerCommand('1c-metadata-tree.config.deployMultiple', async (arg: unknown) => {
        await runDeployForConfigurationFromTree(arg, state, treeDataProvider);
      }),
      vscode.commands.registerCommand('1c-metadata-tree.config.deploySelectedObjects', async (arg: unknown) => {
        await runDeploySelectedObjectsFromTree(arg, state.treeView?.selection ?? [], state, treeDataProvider);
      }),
      vscode.commands.registerCommand('1c-metadata-tree.config.deployChangedFiles', async (arg: unknown) => {
        await runDeployChangedFilesFromTree(arg, state, treeDataProvider);
      }),
      vscode.commands.registerCommand('1c-metadata-tree.config.configExportStatus', async (arg: unknown) => {
        await runConfigExportStatusFromTree(arg, state, treeDataProvider);
      }),
    );
  }
  out.push({ dispose: () => dialog.dispose() });
  return out;
}
