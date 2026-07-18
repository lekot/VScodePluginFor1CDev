import * as vscode from 'vscode';
import { TypeDefinition, ReferenceableGroup, StringQualifiers, NumberQualifiers, DateQualifiers } from '../types/typeDefinitions';
import { TypeParser } from '../parsers/typeParser';
import { Logger } from '../utils/logger';
import { escapeJsonForScript } from '../utils/escapeJsonForScript';
import { randomBytes } from 'crypto';
import { validateElementName } from '../utils/elementNameValidator';

type WebviewMessage =
  | { type: 'save'; typeDefinition: TypeDefinition }
  | { type: 'cancel' }
  | { type: 'validate'; typeDefinition: TypeDefinition };

const TYPE_CATEGORIES = new Set<TypeDefinition['category']>(['primitive', 'reference', 'composite']);
const REFERENCE_KINDS = new Set([
  'CatalogRef',
  'DocumentRef',
  'EnumRef',
  'ChartOfCharacteristicTypesRef',
  'ChartOfAccountsRef',
  'ChartOfCalculationTypesRef',
  'DefinedType',
]);
const PRIMITIVE_TYPE_ENTRY_LIMIT = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isStringQualifiers(value: unknown): value is StringQualifiers {
  return isRecord(value)
    && hasOnlyKeys(value, ['length', 'allowedLength'])
    && typeof value['length'] === 'number'
    && Number.isInteger(value['length'])
    && value['length'] >= 1
    && value['length'] <= 1024
    && (value['allowedLength'] === 'Fixed' || value['allowedLength'] === 'Variable');
}

function isNumberQualifiers(value: unknown): value is NumberQualifiers {
  return isRecord(value)
    && hasOnlyKeys(value, ['digits', 'fractionDigits', 'allowedSign'])
    && typeof value['digits'] === 'number'
    && Number.isInteger(value['digits'])
    && value['digits'] >= 1
    && value['digits'] <= 38
    && typeof value['fractionDigits'] === 'number'
    && Number.isInteger(value['fractionDigits'])
    && value['fractionDigits'] >= 0
    && value['fractionDigits'] <= value['digits']
    && (value['allowedSign'] === 'Any' || value['allowedSign'] === 'Nonnegative');
}

function isDateQualifiers(value: unknown): value is DateQualifiers {
  return isRecord(value)
    && hasOnlyKeys(value, ['dateFractions'])
    && (value['dateFractions'] === 'Date'
      || value['dateFractions'] === 'DateTime'
      || value['dateFractions'] === 'Time');
}

function hasOptionalQualifiers(
  value: Record<string, unknown>,
  validator: (qualifiers: unknown) => boolean,
): boolean {
  return value['qualifiers'] === undefined || validator(value['qualifiers']);
}

function isValidReferenceObjectName(value: string): boolean {
  return value === value.trim() && validateElementName(value, []) === null;
}

function isTypeEntry(value: unknown): boolean {
  if (!isRecord(value) || typeof value['kind'] !== 'string') { return false; }
  switch (value['kind']) {
    case 'string':
      return hasOnlyKeys(value, ['kind', 'qualifiers']) && hasOptionalQualifiers(value, isStringQualifiers);
    case 'number':
      return hasOnlyKeys(value, ['kind', 'qualifiers']) && hasOptionalQualifiers(value, isNumberQualifiers);
    case 'boolean':
      return hasOnlyKeys(value, ['kind', 'qualifiers']) && value['qualifiers'] === undefined;
    case 'date':
      return hasOnlyKeys(value, ['kind', 'qualifiers']) && hasOptionalQualifiers(value, isDateQualifiers);
    case 'reference': {
      const referenceType = value['referenceType'];
      return hasOnlyKeys(value, ['kind', 'referenceType'])
        && isRecord(referenceType)
        && hasOnlyKeys(referenceType, ['referenceKind', 'objectName'])
        && typeof referenceType['referenceKind'] === 'string'
        && REFERENCE_KINDS.has(referenceType['referenceKind'])
        && typeof referenceType['objectName'] === 'string'
        && isValidReferenceObjectName(referenceType['objectName']);
    }
    default:
      return false;
  }
}

function typeEntryKey(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value['kind'] !== 'string') { return undefined; }
  if (value['kind'] !== 'reference') { return value['kind']; }
  const referenceType = value['referenceType'];
  if (!isRecord(referenceType)) { return undefined; }
  return `${String(referenceType['referenceKind'])}:${String(referenceType['objectName'])}`;
}

function expectedCategory(types: unknown[]): TypeDefinition['category'] {
  if (types.length > 1) { return 'composite'; }
  return types.length === 1 && isRecord(types[0]) && types[0]['kind'] === 'reference'
    ? 'reference'
    : 'primitive';
}

function isTypeDefinition(value: unknown, maxTypeEntries: number): value is TypeDefinition {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['category', 'types'])
    || typeof value['category'] !== 'string'
    || !TYPE_CATEGORIES.has(value['category'] as TypeDefinition['category'])
    || !Array.isArray(value['types'])
    || value['types'].length > maxTypeEntries
    || !value['types'].every(isTypeEntry)
    || value['category'] !== expectedCategory(value['types'])) {
    return false;
  }
  const keys = value['types'].map(typeEntryKey);
  return keys.every((key): key is string => key !== undefined)
    && new Set(keys).size === keys.length;
}

function hasOnlyAllowedReferences(
  typeDefinition: TypeDefinition,
  allowedReferenceTypeKeys: ReadonlySet<string>,
): boolean {
  return typeDefinition.types.every((entry) => {
    if (entry.kind !== 'reference') { return true; }
    const key = typeEntryKey(entry);
    return key !== undefined && allowedReferenceTypeKeys.has(key);
  });
}

/**
 * Type guard for webview messages
 */
export function isTypeEditorWebviewMessage(
  msg: unknown,
  allowedReferenceTypeKeys: ReadonlySet<string>,
): msg is WebviewMessage {
  if (!isRecord(msg)) { return false; }
  if (msg['type'] === 'cancel') {
    return hasOnlyKeys(msg, ['type']);
  }
  if (msg['type'] === 'save' || msg['type'] === 'validate') {
    return hasOnlyKeys(msg, ['type', 'typeDefinition'])
      && isTypeDefinition(
        msg['typeDefinition'],
        allowedReferenceTypeKeys.size + PRIMITIVE_TYPE_ENTRY_LIMIT,
      )
      && hasOnlyAllowedReferences(msg['typeDefinition'], allowedReferenceTypeKeys)
      && (msg['type'] === 'validate' || msg['typeDefinition'].types.length > 0);
  }
  return false;
}

export class TypeEditorProvider {
  private panel: vscode.WebviewPanel | undefined;
  private resolvePromise: ((value: TypeDefinition | null) => void) | undefined;
  private rejectPromise: ((reason: Error) => void) | undefined;
  private disposables: vscode.Disposable[] = [];
  private allowedReferenceTypeKeys = new Set<string>();

  constructor(private context: vscode.ExtensionContext) {
    Logger.info('TypeEditorProvider initialized');
  }

  public async show(typeXML: string, referenceableObjects?: ReferenceableGroup[]): Promise<TypeDefinition | null> {
    if (!this.panel) {
      this.panel = this.createPanel();
    } else {
      this.panel.reveal(vscode.ViewColumn.Beside);
    }

    let typeDefinition: TypeDefinition;
    try {
      typeDefinition = TypeParser.parse(typeXML);
    } catch (error) {
      Logger.error('Failed to parse type XML', error);
      throw new Error(`Failed to parse current type: ${error instanceof Error ? error.message : String(error)}`);
    }

    const refObjs = referenceableObjects ?? [];
    this.updateWebviewContent(typeDefinition, refObjs);

    return new Promise<TypeDefinition | null>((resolve, reject) => {
      this.resolvePromise = resolve;
      this.rejectPromise = reject;
    });
  }

  private createPanel(): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(
      '1c-metadata-type-editor',
      'Редактирование типа данных',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.context.extensionUri],
      }
    );

    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    panel.webview.onDidReceiveMessage(async (message: unknown) => {
      // Runtime validation of incoming messages
      if (!isTypeEditorWebviewMessage(message, this.allowedReferenceTypeKeys)) {
        Logger.warn('Received invalid message from webview', message);
        return;
      }
      await this.handleMessage(message);
    }, null, this.disposables);

    Logger.info('Type editor panel created');
    return panel;
  }

  private updateWebviewContent(typeDefinition: TypeDefinition, referenceableObjects: ReferenceableGroup[]): void {
    if (!this.panel) {return;}
    this.panel.webview.html = this.getWebviewContent(typeDefinition, referenceableObjects);
    Logger.debug('Type editor panel updated');
  }

  private getInitialSelectedNodeIds(typeDefinition: TypeDefinition, referenceableObjects: ReferenceableGroup[]): string[] {
    const ids: string[] = [];
    const refNamesByKind = new Map<string, Set<string>>();
    for (const g of referenceableObjects) {
      refNamesByKind.set(g.referenceKind, new Set(g.objectNames));
    }
    for (const entry of typeDefinition.types) {
      if (entry.kind === 'reference' && entry.referenceType) {
        const { referenceKind, objectName } = entry.referenceType;
        ids.push('ref:' + referenceKind + ':' + objectName);
        continue;
      }
      if (entry.kind === 'string' || entry.kind === 'number' || entry.kind === 'boolean' || entry.kind === 'date') {
        ids.push('primitive:' + entry.kind);
      }
    }
    return ids;
  }

  private getInitialQualifierState(typeDefinition: TypeDefinition): Record<string, unknown> {
    const state: Record<string, unknown> = {};
    const primitives = ['string', 'number', 'boolean', 'date'] as const;
    for (const kind of primitives) {
      const entry = typeDefinition.types.find((t) => t.kind === kind);
      if (entry && entry.qualifiers) {
        state[kind] = entry.qualifiers;
      }
    }
    return state;
  }

  /** Build tree nodes for webview: primitives + reference groups (with virtual children for current type refs not in list). */
  private buildTreeData(
    typeDefinition: TypeDefinition,
    referenceableObjects: ReferenceableGroup[]
  ): { id: string; label: string; children?: { id: string; label: string }[] }[] {
    const primitives: { id: string; label: string }[] = [
      { id: 'primitive:string', label: 'String' },
      { id: 'primitive:number', label: 'Number' },
      { id: 'primitive:boolean', label: 'Boolean' },
      { id: 'primitive:date', label: 'Date' },
    ];
    const refEntries = typeDefinition.types.filter((t) => t.kind === 'reference' && t.referenceType) as { kind: 'reference'; referenceType: { referenceKind: string; objectName: string } }[];
    const virtualRefs = new Map<string, Set<string>>(); // refKind -> Set of objectNames not in refGroups
    for (const entry of refEntries) {
      const kind = entry.referenceType.referenceKind;
      const name = entry.referenceType.objectName;
      if (!name) {continue;}
      const group = referenceableObjects.find((g) => g.referenceKind === kind);
      const inList = group && group.objectNames.includes(name);
      if (!inList) {
        if (!virtualRefs.has(kind)) {virtualRefs.set(kind, new Set());}
        virtualRefs.get(kind)!.add(name);
      }
    }
    const REFERENCE_KINDS_ORDER = [
      'CatalogRef',
      'DocumentRef',
      'EnumRef',
      'ChartOfCharacteristicTypesRef',
      'ChartOfAccountsRef',
      'ChartOfCalculationTypesRef',
    ];
    const refGroups: { id: string; label: string; children: { id: string; label: string }[] }[] = [];
    const groupsByKind = new Map(
      referenceableObjects.map((group) => [group.referenceKind, group] as const),
    );
    const kindsToIterate = referenceableObjects.length > 0
      ? referenceableObjects.map((group) => group.referenceKind)
      : [...REFERENCE_KINDS_ORDER];
    for (const virtualKind of virtualRefs.keys()) {
      if (!kindsToIterate.includes(virtualKind)) {
        kindsToIterate.push(virtualKind);
      }
    }
    const groupsToIterate = kindsToIterate.map((referenceKind) => (
      groupsByKind.get(referenceKind) ?? { referenceKind, objectNames: [] }
    ));
    for (const g of groupsToIterate) {
      const children = g.objectNames.map((name) => ({ id: 'ref:' + g.referenceKind + ':' + name, label: name }));
      const virtual = virtualRefs.get(g.referenceKind);
      if (virtual) {
        virtual.forEach((name) => children.push({ id: 'ref:' + g.referenceKind + ':' + name, label: name }));
      }
      refGroups.push({
        id: 'group:' + g.referenceKind,
        label: g.referenceKind,
        children,
      });
    }
    return [{ id: 'primitives', label: '', children: primitives }, ...refGroups];
  }

  private getWebviewContent(
    typeDefinition: TypeDefinition,
    referenceableObjects: ReferenceableGroup[] = []
  ): string {
    const nonce = randomBytes(24).toString('base64url');
    const currentTypeDisplay = this.formatTypeDisplay(typeDefinition);
    const refGroupsJson = escapeJsonForScript(JSON.stringify(referenceableObjects));
    const initialComposite = typeDefinition.types.length > 1;
    const initialSelectedIds = this.getInitialSelectedNodeIds(typeDefinition, referenceableObjects);
    const initialQualifierState = this.getInitialQualifierState(typeDefinition);
    const treeData = this.buildTreeData(typeDefinition, referenceableObjects);
    this.allowedReferenceTypeKeys = new Set(
      treeData
        .flatMap((group) => group.children ?? [])
        .map((child) => child.id)
        .filter((id) => id.startsWith('ref:'))
        .map((id) => id.slice('ref:'.length)),
    );
    const treeDataJson = escapeJsonForScript(JSON.stringify(treeData));
    const initialSelectedJson = escapeJsonForScript(JSON.stringify(initialSelectedIds));
    const initialQualifierStateJson = escapeJsonForScript(JSON.stringify(initialQualifierState));

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}';">
        <title>Редактирование типа данных</title>
        <style nonce="${nonce}">
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
          .composite-row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
          .composite-row input[type="checkbox"] { accent-color: var(--vscode-button-background); width: 16px; height: 16px; cursor: pointer; }
          .composite-row label { cursor: pointer; margin: 0; }
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
            max-height: 220px;
            overflow-y: auto;
          }
          .tree-node { margin: 2px 0; }
          .tree-node-children { margin-left: 16px; }
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
          .tree-group-label { font-weight: 600; padding: 4px 0; cursor: pointer; }
          .tree-group-label:hover { color: var(--vscode-focusBorder); }
          .tree-group-children { margin-left: 16px; }
          .tree-leaf.hidden, .tree-group.hidden { display: none !important; }
          .hidden { display: none !important; }
          .qualifier-section {
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            padding: 12px;
            margin-bottom: 12px;
          }
          .qualifier-section.empty { color: var(--vscode-descriptionForeground); }
          .empty-state {
            text-align: center;
            padding: 16px;
            color: var(--vscode-descriptionForeground);
          }
          .empty-state h3, .empty-state h4 { margin: 0 0 8px 0; }
          .empty-state p { margin: 0; }
          .form-group { margin-bottom: 10px; }
          .form-group label { display: block; font-size: 12px; margin-bottom: 4px; color: var(--vscode-descriptionForeground); }
          .form-group input, .form-group select {
            width: 100%;
            padding: 6px 8px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 3px;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
          }
          .form-group input:focus, .form-group select:focus {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: -1px;
          }
          .form-row { display: flex; gap: 12px; }
          .form-row .form-group { flex: 1; }
          .qualifier-group { display: none; }
          .qualifier-group.active { display: block; }
          .preview-section {
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            padding: 12px;
            min-height: 44px;
          }
          .preview-value { font-family: Consolas, monospace; font-size: 13px; word-break: break-all; }
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
            <h2>Редактирование типа данных</h2>
          </div>
          <div class="section">
            <div class="composite-row">
              <input type="checkbox" id="composite-cb" ${initialComposite ? 'checked' : ''}>
              <label for="composite-cb">Составной тип данных</label>
            </div>
            <div class="search-row">
              <input type="text" id="search-input" placeholder="Поиск (Ctrl+Alt+M)" autocomplete="off" aria-label="Поиск по дереву типов">
            </div>
            <div class="section-title">Тип</div>
            <div class="tree-area" id="type-tree" role="tree" aria-label="Дерево типов данных"></div>
          </div>
          <div class="section">
            <span class="section-title">Квалификаторы</span>
            <div id="qualifier-section" class="qualifier-section">
              <div id="qualifier-empty" class="empty-state">Выберите примитивный тип в дереве</div>
              <div id="qualifier-fields" class="hidden">
                <div id="string-qualifiers" class="qualifier-group">
                  <div class="form-row">
                    <div class="form-group"><label for="string-length">Length</label><input type="number" id="string-length" min="1" max="1024"></div>
                    <div class="form-group"><label for="string-allowed-length">Allowed Length</label><select id="string-allowed-length"><option value="Fixed">Fixed</option><option value="Variable">Variable</option></select></div>
                  </div>
                </div>
                <div id="number-qualifiers" class="qualifier-group">
                  <div class="form-row">
                    <div class="form-group"><label for="number-digits">Digits</label><input type="number" id="number-digits" min="1" max="38"></div>
                    <div class="form-group"><label for="number-fraction-digits">Fraction Digits</label><input type="number" id="number-fraction-digits" min="0" max="38"></div>
                  </div>
                  <div class="form-group"><label for="number-allowed-sign">Allowed Sign</label><select id="number-allowed-sign"><option value="Any">Any</option><option value="Nonnegative">Nonnegative</option></select></div>
                </div>
                <div id="date-qualifiers" class="qualifier-group">
                  <div class="form-group"><label for="date-fractions">Date Fractions</label><select id="date-fractions"><option value="Date">Date</option><option value="DateTime">DateTime</option><option value="Time">Time</option></select></div>
                </div>
              </div>
            </div>
          </div>
          <div class="section">
            <span class="section-title">Type Preview</span>
            <div class="preview-section"><div id="preview-value" class="preview-value">${this.escapeHtml(currentTypeDisplay)}</div></div>
          </div>
          <div class="button-row">
            <button type="button" id="cancel-btn" title="Отмена" aria-label="Отмена">Отмена</button>
            <button type="button" id="save-btn" ${typeDefinition.types.length === 0 ? 'disabled' : ''} title="Сохранить" aria-label="Сохранить">Сохранить</button>
          </div>
        </div>
        <script nonce="${nonce}">
          const vscode = acquireVsCodeApi();
          const refGroups = ${refGroupsJson};
          const treeData = ${treeDataJson};
          let selectedIds = new Set(${initialSelectedJson});
          let composite = ${JSON.stringify(initialComposite)};
          let qualifierState = ${initialQualifierStateJson};
          const saveBtn = document.getElementById('save-btn');
          const previewValue = document.getElementById('preview-value');
          const searchInput = document.getElementById('search-input');
          const compositeCb = document.getElementById('composite-cb');
          const treeContainer = document.getElementById('type-tree');
          const qualifierEmpty = document.getElementById('qualifier-empty');
          const qualifierFields = document.getElementById('qualifier-fields');
          const qualifierGroups = { string: document.getElementById('string-qualifiers'), number: document.getElementById('number-qualifiers'), date: document.getElementById('date-qualifiers') };

          function renderTree() {
            const query = (searchInput && searchInput.value) ? searchInput.value.trim().toLowerCase() : '';
            let html = '';
            for (const group of treeData) {
              if (group.id === 'primitives' && group.children) {
                for (const c of group.children) {
                  const label = c.label;
                  const show = !query || label.toLowerCase().includes(query);
                  const checked = selectedIds.has(c.id);
                  html += '<div class="tree-node tree-leaf' + (show ? '' : ' hidden') + '" data-id="' + escapeAttr(c.id) + '" role="treeitem" aria-selected="' + (checked ? 'true' : 'false') + '">' +
                    '<input type="checkbox" id="cb-' + escapeAttr(c.id) + '"' + (checked ? ' checked' : '') + '><label for="cb-' + escapeAttr(c.id) + '">' + escapeHtml(label) + '</label></div>';
                }
              } else if (group.children) {
                const groupShow = !query || group.label.toLowerCase().includes(query);
                let childShowCount = 0;
                let childrenHtml = '';
                for (const c of group.children) {
                  const show = !query || c.label.toLowerCase().includes(query);
                  if (show) childShowCount++;
                  const checked = selectedIds.has(c.id);
                  childrenHtml += '<div class="tree-node tree-leaf' + (show ? '' : ' hidden') + '" data-id="' + escapeAttr(c.id) + '" role="treeitem" aria-selected="' + (checked ? 'true' : 'false') + '">' +
                    '<input type="checkbox" id="cb-' + escapeAttr(c.id) + '"' + (checked ? ' checked' : '') + '><label for="cb-' + escapeAttr(c.id) + '">' + escapeHtml(c.label) + '</label></div>';
                }
                const groupVisible = groupShow || childShowCount > 0;
                html += '<div class="tree-group' + (groupVisible ? '' : ' hidden') + '">';
                html += '<div class="tree-group-label" data-group-id="' + escapeAttr(group.id) + '">' + escapeHtml(group.label) + '</div>';
                html += '<div class="tree-group-children">' + childrenHtml + '</div></div>';
              }
            }
            treeContainer.innerHTML = html;
            treeContainer.querySelectorAll('.tree-leaf').forEach(el => {
              const id = el.getAttribute('data-id');
              const cb = el.querySelector('input[type="checkbox"]');
              if (!id || !cb) return;
              el.addEventListener('click', (e) => { if (e.target !== cb) cb.checked = !cb.checked; toggleSelection(id, cb.checked); });
              cb.addEventListener('change', () => toggleSelection(id, cb.checked));
            });
          }

          function escapeAttr(s) { return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
          function escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

          function toggleSelection(id, checked) {
            if (!composite && checked) {
              selectedIds.clear();
              selectedIds.add(id);
              renderTree();
            } else {
              if (checked) selectedIds.add(id); else selectedIds.delete(id);
            }
            updateQualifierPanel();
            updatePreview();
            saveBtn.disabled = selectedIds.size === 0;
          }

          function updateQualifierPanel() {
            let focusedKey = null;
            const arr = Array.from(selectedIds);
            for (let i = arr.length - 1; i >= 0; i--) {
              const id = arr[i];
              if (id.startsWith('primitive:')) { focusedKey = id.replace('primitive:', ''); break; }
            }
            if (!focusedKey) {
              qualifierEmpty.classList.remove('hidden');
              qualifierFields.classList.add('hidden');
              return;
            }
            qualifierEmpty.classList.add('hidden');
            qualifierFields.classList.remove('hidden');
            for (const k of Object.keys(qualifierGroups)) {
              const g = qualifierGroups[k];
              if (g) g.classList.toggle('active', k === focusedKey);
            }
            const q = qualifierState[focusedKey];
            if (focusedKey === 'string') {
              const lenEl = document.getElementById('string-length');
              const allowedEl = document.getElementById('string-allowed-length');
              if (lenEl) lenEl.value = (q && q.length) != null ? q.length : '';
              if (allowedEl) allowedEl.value = (q && q.allowedLength) || 'Variable';
            } else if (focusedKey === 'number') {
              const d = document.getElementById('number-digits');
              const f = document.getElementById('number-fraction-digits');
              const s = document.getElementById('number-allowed-sign');
              if (d) d.value = (q && q.digits) != null ? q.digits : '';
              if (f) f.value = (q && q.fractionDigits) != null ? q.fractionDigits : '';
              if (s) s.value = (q && q.allowedSign) || 'Any';
            } else if (focusedKey === 'date') {
              const df = document.getElementById('date-fractions');
              if (df) df.value = (q && q.dateFractions) || 'Date';
            }
          }

          function collectQualifiersFromInputs() {
            const key = document.querySelector('.qualifier-group.active');
            if (!key) return;
            let k = null;
            if (qualifierGroups.string && qualifierGroups.string.classList.contains('active')) k = 'string';
            else if (qualifierGroups.number && qualifierGroups.number.classList.contains('active')) k = 'number';
            else if (qualifierGroups.date && qualifierGroups.date.classList.contains('active')) k = 'date';
            if (!k) return;
            if (k === 'string') {
              const lenEl = document.getElementById('string-length');
              const allowedEl = document.getElementById('string-allowed-length');
              const len = lenEl && lenEl.value !== '' ? parseInt(lenEl.value, 10) : undefined;
              qualifierState.string = len !== undefined ? { length: len, allowedLength: (allowedEl && allowedEl.value) || 'Variable' } : undefined;
            } else if (k === 'number') {
              const d = document.getElementById('number-digits');
              const f = document.getElementById('number-fraction-digits');
              const s = document.getElementById('number-allowed-sign');
              const digits = d && d.value !== '' ? parseInt(d.value, 10) : undefined;
              const fractionDigits = f && f.value !== '' ? parseInt(f.value, 10) : undefined;
              qualifierState.number = (digits !== undefined && fractionDigits !== undefined) ? { digits, fractionDigits, allowedSign: (s && s.value) || 'Any' } : undefined;
            } else if (k === 'date') {
              const df = document.getElementById('date-fractions');
              qualifierState.date = df && df.value ? { dateFractions: df.value } : undefined;
            }
          }

          function buildTypesFromSelection() {
            const types = [];
            const order = [];
            for (const group of treeData) {
              if (group.id === 'primitives' && group.children) { for (const c of group.children) order.push(c.id); }
              else if (group.children) { for (const c of group.children) order.push(c.id); }
            }
            for (const id of order) {
              if (!selectedIds.has(id)) continue;
              if (id.startsWith('primitive:')) {
                const kind = id.replace('primitive:', '');
                const q = qualifierState[kind];
                types.push({ kind: kind, qualifiers: q || undefined });
              } else if (id.startsWith('ref:')) {
                const parts = id.split(':');
                const referenceKind = parts[1] || 'CatalogRef';
                const objectName = parts.slice(2).join(':') || '';
                types.push({ kind: 'reference', referenceType: { referenceKind, objectName } });
              }
            }
            return types;
          }

          function updatePreview() {
            const types = buildTypesFromSelection();
            const display = types.length === 0 ? 'Not set' : types.map(entry => {
              if (entry.kind === 'string') { const q = entry.qualifiers; return q ? 'String(' + q.length + ')' : 'String'; }
              if (entry.kind === 'number') { const q = entry.qualifiers; return q ? 'Number(' + q.digits + ',' + q.fractionDigits + ')' : 'Number'; }
              if (entry.kind === 'boolean') return 'Boolean';
              if (entry.kind === 'date') { const q = entry.qualifiers; return q ? q.dateFractions : 'Date'; }
              if (entry.kind === 'reference' && entry.referenceType) return entry.referenceType.referenceKind + '.' + (entry.referenceType.objectName || '');
              return 'Unknown';
            }).join(' | ');
            previewValue.textContent = display;
          }

          compositeCb.addEventListener('change', () => {
            composite = compositeCb.checked;
            if (!composite && selectedIds.size > 1) {
              const first = Array.from(selectedIds)[0];
              selectedIds = new Set([first]);
              renderTree();
            }
            updateQualifierPanel();
            updatePreview();
            saveBtn.disabled = selectedIds.size === 0;
          });

          searchInput.addEventListener('input', () => renderTree());
          searchInput.addEventListener('keydown', (e) => { if (e.ctrlKey && e.altKey && e.key === 'm') { e.preventDefault(); searchInput.focus(); } });
          document.addEventListener('keydown', (e) => { if (e.ctrlKey && e.altKey && e.key === 'm') { e.preventDefault(); searchInput.focus(); } });

          document.getElementById('cancel-btn').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
          document.getElementById('save-btn').addEventListener('click', () => {
            collectQualifiersFromInputs();
            const types = buildTypesFromSelection();
            const category = types.length > 1 ? 'composite' : (types.length === 1 && types[0].kind === 'reference' ? 'reference' : 'primitive');
            vscode.postMessage({ type: 'save', typeDefinition: { category, types } });
          });

          function syncQualifiersOnBlur() { collectQualifiersFromInputs(); updatePreview(); }
          const stringLengthEl = document.getElementById('string-length');
          const stringAllowedEl = document.getElementById('string-allowed-length');
          const numberDigitsEl = document.getElementById('number-digits');
          const numberFracEl = document.getElementById('number-fraction-digits');
          const numberSignEl = document.getElementById('number-allowed-sign');
          const dateFracEl = document.getElementById('date-fractions');
          if (stringLengthEl) { stringLengthEl.addEventListener('input', syncQualifiersOnBlur); stringLengthEl.addEventListener('blur', syncQualifiersOnBlur); }
          if (stringAllowedEl) { stringAllowedEl.addEventListener('change', syncQualifiersOnBlur); stringAllowedEl.addEventListener('blur', syncQualifiersOnBlur); }
          if (numberDigitsEl) { numberDigitsEl.addEventListener('input', syncQualifiersOnBlur); numberDigitsEl.addEventListener('blur', syncQualifiersOnBlur); }
          if (numberFracEl) { numberFracEl.addEventListener('input', syncQualifiersOnBlur); numberFracEl.addEventListener('blur', syncQualifiersOnBlur); }
          if (numberSignEl) { numberSignEl.addEventListener('change', syncQualifiersOnBlur); numberSignEl.addEventListener('blur', syncQualifiersOnBlur); }
          if (dateFracEl) { dateFracEl.addEventListener('change', syncQualifiersOnBlur); dateFracEl.addEventListener('blur', syncQualifiersOnBlur); }

          renderTree();
          updateQualifierPanel();
          updatePreview();
          saveBtn.disabled = selectedIds.size === 0;
        </script>
      </body>
      </html>
    `;
  }

  private formatTypeDisplay(typeDefinition: TypeDefinition): string {
    if (typeDefinition.types.length === 0) {return 'Not set';}
    return typeDefinition.types.map(entry => {
      switch (entry.kind) {
        case 'string': return entry.qualifiers ? `String(${(entry.qualifiers as StringQualifiers).length})` : 'String';
        case 'number': return entry.qualifiers ? `Number(${(entry.qualifiers as NumberQualifiers).digits},${(entry.qualifiers as NumberQualifiers).fractionDigits})` : 'Number';
        case 'boolean': return 'Boolean';
        case 'date': return entry.qualifiers ? (entry.qualifiers as DateQualifiers).dateFractions : 'Date';
        case 'reference': return entry.referenceType ? `${entry.referenceType.referenceKind}.${entry.referenceType.objectName}` : 'Reference';
        default: return 'Unknown';
      }
    }).join(' | ');
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    Logger.debug(`Received: ${message.type}`);
    if (message.type === 'save' || message.type === 'cancel') {
      Logger.info(`Type editor: ${message.type} received from webview`);
    }
    try {
      switch (message.type) {
        case 'save': await this.handleSaveMessage(message); break;
        case 'cancel': await this.handleCancelMessage(); break;
        case 'validate': await this.handleValidateMessage(message); break;
      }
    } catch (error) {
      Logger.error('Error handling message', error);
      if (this.panel) {
        const message = error instanceof Error ? error.message : String(error);
        this.panel.webview.postMessage({ type: 'error', message });
      }
    }
  }

  /** Validation and validationResult messaging are reserved for future use (pre-save validation in UI). */
  private async handleValidateMessage(message: WebviewMessage): Promise<void> {
    if (!this.panel) {return;}
    
    // Type narrowing - TypeScript needs explicit check
    if (message.type === 'validate') {
      const errors = this.validateTypeDefinition(message.typeDefinition);
      this.panel.webview.postMessage({ type: 'validationResult', errors });
    }
  }

  private validateTypeDefinition(typeDefinition?: TypeDefinition): string[] {
    const errors: string[] = [];
    
    if (!typeDefinition || typeDefinition.types.length === 0) {
      errors.push('Type definition is required');
      return errors;
    }

    if (typeDefinition.category !== expectedCategory(typeDefinition.types)) {
      errors.push('Type category does not match the selected types');
    }

    const seenTypes = new Set<string>();
    
    for (const entry of typeDefinition.types) {
      const key = typeEntryKey(entry);
      if (key && seenTypes.has(key)) {
        errors.push(`Duplicate type is not allowed: ${key}`);
      } else if (key) {
        seenTypes.add(key);
      }
      switch (entry.kind) {
        case 'string':
          if (entry.qualifiers) {
            const q = entry.qualifiers as StringQualifiers;
            if (!Number.isInteger(q.length) || q.length < 1 || q.length > 1024) {
              errors.push(`String length must be between 1 and 1024, got ${q.length}`);
            }
          }
          break;

        case 'number':
          if (entry.qualifiers) {
            const q = entry.qualifiers as NumberQualifiers;
            if (!Number.isInteger(q.digits) || q.digits < 1 || q.digits > 38) {
              errors.push(`Number digits must be between 1 and 38, got ${q.digits}`);
            }
            if (!Number.isInteger(q.fractionDigits) || q.fractionDigits < 0 || q.fractionDigits > q.digits) {
              errors.push(`Number fraction digits must be between 0 and ${q.digits}, got ${q.fractionDigits}`);
            }
          }
          break;
          
        case 'reference':
          if (!entry.referenceType || !isValidReferenceObjectName(entry.referenceType.objectName)) {
            errors.push('Reference type must have referenceKind and objectName');
          }
          break;
      }
    }
    
    return errors;
  }

  private async handleSaveMessage(message: WebviewMessage): Promise<void> {
    // Type narrowing - TypeScript needs explicit check
    if (message.type === 'save') {
      if (!message.typeDefinition || !this.resolvePromise) {
        Logger.warn('Type editor save ignored: missing typeDefinition or resolvePromise');
        return;
      }
      const def = message.typeDefinition;
      if (!Array.isArray(def.types) || def.types.length === 0) {
        Logger.warn('Type editor save ignored: types empty or not array');
        return;
      }
      const validationErrors = this.validateTypeDefinition(def);
      if (validationErrors.length > 0) {
        Logger.warn('Type editor save ignored: invalid type definition', validationErrors);
        this.panel?.webview.postMessage({ type: 'validationResult', errors: validationErrors });
        return;
      }
      const typeDefinition: TypeDefinition = {
        category: def.category === 'reference' || def.category === 'composite' ? def.category : 'primitive',
        types: def.types,
      };
      this.resolvePromise(typeDefinition);
      this.resolvePromise = undefined;
      // Ensure panel disposal doesn't attempt to resolve/reject a settled promise.
      this.rejectPromise = undefined;
      Logger.info('Type editor: save applied, closing panel');
      if (this.panel) {
        const p = this.panel;
        this.panel = undefined;
        p.dispose();
      }
    }
  }

  private async handleCancelMessage(): Promise<void> {
    Logger.info('Type editor: cancel applied, closing panel');
    // Cancellation should close the editor without treating it as a successful save.
    if (this.rejectPromise) {
      this.rejectPromise(new Error('Type editor cancelled'));
      this.rejectPromise = undefined;
      this.resolvePromise = undefined;
    } else if (this.resolvePromise) {
      this.resolvePromise(null);
      this.resolvePromise = undefined;
    }
    if (this.panel) {
      const p = this.panel;
      this.panel = undefined;
      p.dispose();
    }
  }

  private escapeHtml(text: string): string {
    const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return text.replace(/[&<>"']/g, m => map[m]);
  }

  public dispose(): void {
    Logger.info('Disposing TypeEditorProvider');
    if (this.rejectPromise) { this.rejectPromise(new Error('Type editor closed')); this.rejectPromise = undefined; }
    else if (this.resolvePromise) { this.resolvePromise(null); this.resolvePromise = undefined; }
    if (this.panel) { this.panel.dispose(); this.panel = undefined; }
    this.allowedReferenceTypeKeys.clear();
    while (this.disposables.length) { const d = this.disposables.pop(); if (d) {d.dispose();} }
  }
}
