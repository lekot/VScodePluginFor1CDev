import type { FormAttribute, FormChildItem, FormModel } from '../formModel';
import type {
  AddElementWizardConfig,
  FormAttributeView,
  FormBrowserState,
  FormCommandView,
  RequisiteTreeNode,
} from './contracts';
import { isRecord } from './contracts';

const CONTAINER_TAGS = new Set([
  'UsualGroup', 'Pages', 'Page', 'Table', 'AutoCommandBar', 'CommandBar', 'Form', 'Group', 'CollapsibleGroup',
]);

export function isContainerTag(tag: string | undefined): boolean {
  return typeof tag === 'string' && CONTAINER_TAGS.has(tag);
}

export function isRealElement(item: FormChildItem): boolean {
  const tag = item.tag;
  return Boolean(tag && tag !== ':@' && !String(tag).startsWith('@'));
}

export function isFormChildItem(value: unknown): value is FormChildItem {
  if (!isRecord(value)) { return false; }
  return typeof value.tag === 'string'
    && typeof value.name === 'string'
    && isRecord(value.properties)
    && Array.isArray(value.childItems)
    && value.childItems.every(isFormChildItem);
}

function isFormAttribute(value: unknown): value is FormAttribute {
  return isRecord(value) && typeof value.name === 'string' && isRecord(value.properties);
}

export function isFormModel(value: unknown): value is FormModel {
  if (!isRecord(value)) { return false; }
  return Array.isArray(value.childItemsRoot)
    && value.childItemsRoot.every(isFormChildItem)
    && Array.isArray(value.attributes)
    && value.attributes.every(isFormAttribute)
    && Array.isArray(value.commands)
    && value.commands.every(isFormAttribute)
    && Array.isArray(value.formEvents);
}

export function normalizeWizardConfig(value: unknown): AddElementWizardConfig {
  if (!isRecord(value) || !Array.isArray(value.options)) { return { options: [] }; }
  const options = value.options.filter(isRecord).filter((option) => typeof option.tag === 'string').map((option) => ({
    tag: option.tag as string,
    defaultName: typeof option.defaultName === 'string' ? option.defaultName : undefined,
    hint: typeof option.hint === 'string' ? option.hint : undefined,
  }));
  return { options };
}

export function getDisplayItems(state: FormBrowserState): FormChildItem[] {
  const model = state.formModel;
  if (!model) { return []; }
  const items = model.childItemsRoot || [];
  return model.autoCommandBar ? [model.autoCommandBar].concat(items) : items;
}

export function findElement(model: FormModel | null, id: string | null | undefined): FormChildItem | null {
  if (!model || !id) { return null; }
  const find = (items: FormChildItem[]): FormChildItem | null => {
    for (const item of items) {
      if ((item.id && item.id === id) || item.name === id) { return item; }
      if (item.childItems.length) {
        const found = find(item.childItems);
        if (found) { return found; }
      }
    }
    return null;
  };
  const found = find(model.childItemsRoot || []);
  if (found) { return found; }
  return model.autoCommandBar ? find([model.autoCommandBar]) : null;
}

export interface ParentLocation {
  parent: FormChildItem[];
  index: number;
}

export function findParentAndIndex(root: FormChildItem[], elementId: string): ParentLocation | null {
  if (!root || !elementId) { return null; }
  for (let index = 0; index < root.length; index += 1) {
    const item = root[index];
    if ((item.id && item.id === elementId) || item.name === elementId) { return { parent: root, index }; }
    if (item.childItems.length) {
      const found = findParentAndIndex(item.childItems, elementId);
      if (found) { return found; }
    }
  }
  return null;
}

export function getPasteTargetId(state: FormBrowserState, find: typeof findElement): string | null {
  if (!state.formModel || !state.selectedIds.length) { return null; }
  for (const selectedId of state.selectedIds) {
    const item = find(state.formModel, selectedId);
    if (item && isContainerTag(item.tag)) { return selectedId; }
  }
  return null;
}

export function extractDisplayValue(value: unknown): string {
  if (value == null) { return ''; }
  if (typeof value === 'string') { return value.trim(); }
  if (Array.isArray(value)) { return value.length ? extractDisplayValue(value[0]) : ''; }
  if (typeof value !== 'object') { return ''; }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (record['#text'] !== undefined && record['#text'] !== null) { return String(record['#text']).trim(); }
  for (const key of keys) {
    if (key === ':@' || key.startsWith('@')) { continue; }
    const local = key.includes(':') ? key.split(':').pop() : key;
    if (local !== 'content') { continue; }
    const content = record[key];
    if (typeof content === 'string') { return content.trim(); }
    if (Array.isArray(content) && content.length) { return extractDisplayValue(content[0]); }
    if (isRecord(content) && content['#text'] !== undefined) { return String(content['#text']).trim(); }
    const inner = extractDisplayValue(content);
    if (inner !== '') { return inner; }
  }
  for (const key of keys) {
    if (key === ':@' || key.startsWith('@')) { continue; }
    const local = key.includes(':') ? key.split(':').pop() : key;
    if (local === 'item') {
      const itemValue = record[key];
      const fromItem = extractDisplayValue(Array.isArray(itemValue) ? itemValue[0] : itemValue);
      if (fromItem !== '') { return fromItem; }
    }
  }
  const attributes = record[':@'];
  if (isRecord(attributes)) {
    const name = attributes['@_name'];
    if (typeof name === 'string' && name.trim() !== '') { return name.trim(); }
  }
  for (const key of keys) {
    if (key === ':@' || key.startsWith('@')) { continue; }
    const nested = extractDisplayValue(record[key]);
    if (nested !== '') { return nested; }
  }
  return '';
}

function normalizeLangCode(language: unknown): string {
  if (language == null) { return ''; }
  return String(language).trim().toLowerCase().replace('_', '-');
}

function pickLocalizedContent(itemNodes: unknown[], localeHint?: string): string {
  if (!Array.isArray(itemNodes) || itemNodes.length === 0) { return ''; }
  const requested = normalizeLangCode(localeHint || navigator.language || '');
  const requestedBase = requested ? requested.split('-')[0] : '';
  let firstNonEmpty = '';
  for (const node of itemNodes) {
    if (!isRecord(node)) { continue; }
    let language = '';
    let content = '';
    Object.keys(node).forEach((key) => {
      if (key === ':@' || key.startsWith('@')) { return; }
      const local = key.includes(':') ? key.split(':').pop() : key;
      if (local === 'lang') { language = extractDisplayValue(node[key]); }
      if (local === 'content') { content = extractDisplayValue(node[key]); }
    });
    content = String(content || '').trim();
    if (!content) { continue; }
    if (!firstNonEmpty) { firstNonEmpty = content; }
    const normalizedLanguage = normalizeLangCode(language);
    if (!requested) { continue; }
    if (normalizedLanguage === requested) { return content; }
    if (requestedBase && normalizedLanguage === requestedBase) { return content; }
    if (requestedBase && normalizedLanguage && normalizedLanguage.split('-')[0] === requestedBase) { return content; }
  }
  return firstNonEmpty;
}

export function extractTitleValue(value: unknown, localeHint?: string): string {
  if (value == null) { return ''; }
  if (typeof value === 'string') { return value.trim(); }
  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = extractTitleValue(item, localeHint);
      if (candidate) { return candidate; }
    }
    return '';
  }
  if (!isRecord(value)) { return ''; }
  for (const key of Object.keys(value)) {
    if (key === ':@' || key.startsWith('@')) { continue; }
    const local = key.includes(':') ? key.split(':').pop() : key;
    if (local !== 'item') { continue; }
    const node = value[key];
    const items = Array.isArray(node) ? node : [node];
    const localized = pickLocalizedContent(items, localeHint);
    if (localized) { return localized; }
  }
  return extractDisplayValue(value);
}

export function resolvePreviewTitle(item: FormChildItem, localeHint?: string): string {
  const properties = item.properties;
  let rawTitle = properties['Title'];
  if (rawTitle == null) {
    for (const key of Object.keys(properties)) {
      if (key === ':@' || key.startsWith('@')) { continue; }
      const local = key.includes(':') ? key.split(':').pop() : key;
      if (local === 'Title') { rawTitle = properties[key]; break; }
    }
  }
  const title = extractTitleValue(rawTitle, localeHint);
  if (title && title.trim() !== '') { return title.trim(); }
  return String(item.name || '').trim();
}

export function getDataPathValue(item: FormChildItem): string {
  const properties = item.properties;
  const raw = properties['DataPath'];
  if (raw != null) {
    const value = extractDisplayValue(raw);
    if (value !== '') { return value; }
  }
  for (const key of Object.keys(properties)) {
    if (key === ':@' || key.startsWith('@')) { continue; }
    const local = key.includes(':') ? key.split(':').pop() : key;
    if (local === 'DataPath') { return extractDisplayValue(properties[key]); }
  }
  return '';
}

export function getFormItemKey(item: FormChildItem): string {
  return item.id != null ? String(item.id) : String(item.name || '');
}

export function hasDataPath(item: FormChildItem): boolean {
  return getDataPathValue(item).length > 0;
}

export function isDescendantOfItem(items: FormChildItem[], sourceId: string, targetId: string): boolean {
  if (sourceId === targetId) { return true; }
  for (const item of items) {
    const id = item.id || item.name;
    if (id === targetId) {
      return item.childItems.some((child) => (child.id || child.name) === sourceId
        || (child.childItems.length > 0 && isDescendantOfItem(child.childItems, sourceId, id)));
    }
    if (item.childItems.length && isDescendantOfItem(item.childItems, sourceId, targetId)) { return true; }
  }
  return false;
}

export function getFlatVisibleIds(
  items: FormChildItem[],
  expandedIds: ReadonlySet<string>,
  parentItem: FormChildItem | null,
): string[] {
  if (!items.length) { return []; }
  const visibleItems = parentItem?.tag === 'Table' ? items.filter(isRealElement) : items;
  const result: string[] = [];
  for (const item of visibleItems) {
    const id = item.id != null ? String(item.id) : String(item.name || '');
    result.push(id);
    if (isContainerTag(item.tag) && expandedIds.has(id) && item.childItems.length) {
      result.push(...getFlatVisibleIds(item.childItems, expandedIds, item));
    }
  }
  return result;
}

export function getAttributeTypeDisplay(attribute: FormAttributeView): string {
  const properties = attribute.properties;
  const value = properties['Type'];
  if (value != null) { return extractDisplayValue(value) || ''; }
  for (const key of Object.keys(properties)) {
    if (key === ':@' || key.startsWith('@')) { continue; }
    if (key === 'Type' || (key.includes('Type') && key.length > 4)) { return extractDisplayValue(properties[key]) || ''; }
  }
  return '';
}

export function getAttributeUsage(attribute: FormAttributeView): string {
  if (attribute.usage != null) { return String(attribute.usage); }
  const properties = attribute.properties;
  const value = properties['Usage'] || properties['Использование'];
  if (value != null) { return extractDisplayValue(value) || '—'; }
  for (const key of Object.keys(properties)) {
    if (key === ':@' || key.startsWith('@')) { continue; }
    if (key === 'Usage' || key.includes('Usage')) { return extractDisplayValue(properties[key]) || '—'; }
  }
  return '—';
}

export function buildRequisiteTree(model: FormModel | null): RequisiteTreeNode[] {
  if (!model || !model.childItemsRoot.length) { return []; }
  const root = new Map<string, RequisiteTreeNode>();
  const ensureNode = (segments: string[]): RequisiteTreeNode | null => {
    if (!segments.length) { return null; }
    const first = segments[0];
    let node = root.get(first);
    if (!node) {
      node = { pathSegment: first, fullPath: first, children: [], formElementIds: [] };
      root.set(first, node);
    }
    let parent = node;
    for (let index = 1; index < segments.length; index += 1) {
      const segment = segments[index];
      const fullPath = segments.slice(0, index + 1).join('.');
      let child = parent.children.find((candidate) => candidate.fullPath === fullPath);
      if (!child) {
        child = { pathSegment: segment, fullPath, children: [], formElementIds: [] };
        parent.children.push(child);
      }
      parent = child;
    }
    return parent;
  };
  const visit = (items: FormChildItem[]): void => {
    for (const item of items) {
      const dataPath = getDataPathValue(item);
      if (dataPath && dataPath.trim()) {
        const segments = dataPath.split('.').map((segment) => segment.trim()).filter(Boolean);
        const node = ensureNode(segments);
        if (node) { node.formElementIds.push(String(item.id != null ? item.id : (item.name || ''))); }
      }
      if (item.childItems.length) { visit(item.childItems); }
    }
  };
  visit(model.childItemsRoot);
  return [...root.keys()].sort().map((key) => root.get(key)!);
}

export function collectRequisitesFromTree(model: FormModel | null): FormAttributeView[] {
  if (!model || !model.childItemsRoot.length) { return []; }
  const usageByName = new Map<string, string[]>();
  const visit = (items: FormChildItem[]): void => {
    for (const item of items) {
      const dataPath = getDataPathValue(item);
      if (dataPath) {
        const name = dataPath.includes('.') ? dataPath.split('.')[0].trim() : dataPath.trim();
        if (name) {
          const labels = usageByName.get(name) || [];
          const label = (typeof item.name === 'string' ? item.name : extractDisplayValue(item.name))
            || (item.id != null ? String(item.id) : '') || dataPath;
          if (!labels.includes(label)) { labels.push(label); }
          usageByName.set(name, labels);
        }
      }
      if (item.childItems.length) { visit(item.childItems); }
    }
  };
  visit(model.childItemsRoot);
  return [...usageByName.keys()].sort().map((name) => ({
    name,
    properties: {},
    usage: usageByName.get(name)!.join(', '),
    fromTree: true,
  }));
}

export function collectCommandsFromTree(model: FormModel | null): FormCommandView[] {
  if (!model || !model.childItemsRoot.length) { return []; }
  const names = new Set<string>();
  const visit = (items: FormChildItem[]): void => {
    for (const item of items) {
      const properties = item.properties;
      const raw = properties['CommandName'] != null || properties['Command'] != null
        ? extractDisplayValue(properties['CommandName']) || extractDisplayValue(properties['Command']) || ''
        : '';
      if (raw) {
        const name = raw.replace(/^Form\.Command\./i, '').trim();
        if (name) { names.add(name); }
      }
      if (item.childItems.length) { visit(item.childItems); }
    }
  };
  visit(model.childItemsRoot);
  return [...names].sort().map((name) => ({ name, properties: {}, fromTree: true }));
}

export function valuesEqual(left: unknown, right: unknown): boolean {
  const normalize = (value: unknown): string => typeof value === 'object' && value !== null
    ? extractDisplayValue(value)
    : value == null ? '' : String(value);
  return normalize(left) === normalize(right);
}

export function getRareTagFallbacks(): ReadonlySet<string> {
  return new Set([
    'TrackBarField', 'ProgressBarField', 'TextDocumentField', 'SpreadSheetDocumentField',
    'HTMLDocumentField', 'ChartField', 'GanttChartField', 'PlannerField', 'GraphicalSchemaField',
    'FormattedDocumentField',
  ]);
}

export function getTreeIcon(tag: string | undefined): string {
  if (!tag) { return ''; }
  const icons: Record<string, string> = {
    Button: '▶', InputField: '⌕', SearchStringAddition: '⌕', FormattedDocumentField: '⌕',
    ValueList: '⌕', CheckBoxField: '☐', Hyperlink: '\u1F517', LabelField: '☰', Table: '⋮',
    Page: '⌂', Pages: '⌂', Form: '⌂', Group: '⌂', UsualGroup: '⌂',
    CollapsibleGroup: '⌂', AutoCommandBar: '⚙',
  };
  return icons[tag] || '■';
}
