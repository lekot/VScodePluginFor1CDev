/**
 * Utility functions for FormModel: ID generation, cloning, type helpers.
 * No vscode dependency — safe to import in console tests.
 */

import type { FormModel, FormChildItem, FormAttribute } from './formModel';

export type ContainerOrientation = 'horizontal' | 'vertical';

/** 1C: HorizontalSpacing / VerticalSpacing — Single | Half | Double */
export type LayoutSpacingKind = 'single' | 'half' | 'double' | '';

/** 1C: ChildItemsWidth — LeftWidest | RightWidest | Equal */
export type ChildItemsWidthKind = 'leftwidest' | 'rightwidest' | 'equal' | '';

/** 1C: ThroughAlign — Use | DontUse */
export type ThroughAlignKind = 'use' | 'dontuse' | '';

export interface ContainerLayoutPreviewMeta {
  /** Element tag from Form.xml (e.g. UsualGroup, Pages). */
  tag: string;
  orientation: ContainerOrientation;
  shouldIndentChildren: boolean;
  containerClassHints: string[];
  horizontalSpacing: LayoutSpacingKind;
  verticalSpacing: LayoutSpacingKind;
  childItemsWidth: ChildItemsWidthKind;
  throughAlign: ThroughAlignKind;
  /** When set, map to CSS `justify-content` for the preview flex container. */
  flexJustifyContent: string;
  /** When set, map to CSS `align-items` for the preview flex container. */
  flexAlignItems: string;
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function toScalarString(value: unknown): string {
  if (value == null) {return '';}
  if (typeof value === 'string') {return value.trim();}
  if (typeof value === 'number' || typeof value === 'boolean') {return String(value).trim();}
  if (typeof value !== 'object') {return '';}
  const rec = value as Record<string, unknown>;
  for (const k of ['#text', '_', 'value', 'Value', 'name', 'Name']) {
    if (rec[k] != null) {
      const nested = toScalarString(rec[k]);
      if (nested) {return nested;}
    }
  }
  return '';
}

function getPropertyValueByAliases(
  properties: Record<string, unknown> | undefined,
  aliases: readonly string[],
): string {
  if (!properties) {return '';}
  const directKeyMap = new Map<string, string>();
  for (const key of Object.keys(properties)) {
    if (key === ':@' || key.startsWith('@')) {continue;}
    directKeyMap.set(normalizeKey(key.includes(':') ? key.split(':').pop() ?? key : key), key);
  }
  for (const alias of aliases) {
    const lookup = directKeyMap.get(normalizeKey(alias));
    if (!lookup) {continue;}
    const val = toScalarString(properties[lookup]);
    if (val) {return val;}
  }
  return '';
}

function normalizeOrientation(rawValue: string): ContainerOrientation | null {
  const v = rawValue.toLowerCase().replace(/[\s_-]+/g, '');
  if (!v) {return null;}
  if (v.includes('horizontal') || v.includes('horiz') || v === 'row' || v.includes('leftright') || v.includes('слеванаправо')) {
    return 'horizontal';
  }
  if (v.includes('vertical') || v.includes('vert') || v === 'column' || v.includes('topbottom') || v.includes('сверхувниз')) {
    return 'vertical';
  }
  if (v.includes('по горизонтали') || v.includes('горизонт')) {return 'horizontal';}
  if (v.includes('по вертикали') || v.includes('вертикал')) {return 'vertical';}
  return null;
}

function normalizeSpacingKind(rawValue: string): LayoutSpacingKind {
  const v = rawValue.toLowerCase().replace(/[\s_-]+/g, '');
  if (!v) {return '';}
  if (v.includes('double') || v.includes('двойн')) {return 'double';}
  if (v.includes('half') || v.includes('половин')) {return 'half';}
  return 'single';
}

function normalizeChildItemsWidth(rawValue: string): ChildItemsWidthKind {
  const v = rawValue.toLowerCase().replace(/[\s_-]+/g, '');
  if (!v) {return '';}
  if (v === 'equal' || v.includes('равн')) {return 'equal';}
  if (v.includes('left') && v.includes('wide')) {return 'leftwidest';}
  if (v.includes('right') && v.includes('wide')) {return 'rightwidest';}
  if (v === 'leftwidest') {return 'leftwidest';}
  if (v === 'rightwidest') {return 'rightwidest';}
  return '';
}

function normalizeThroughAlign(rawValue: string): ThroughAlignKind {
  const v = rawValue.toLowerCase().replace(/[\s_-]+/g, '');
  if (!v) {return '';}
  if (v.includes('dont') || v.includes('неиспользов') || v === 'no') {return 'dontuse';}
  if (v.includes('use') || v === 'yes' || v === 'да') {return 'use';}
  return '';
}

function groupHToFlex(raw: string): string {
  const v = raw.toLowerCase();
  if (!raw.trim()) {return '';}
  if (v.includes('center') || v.includes('центр')) {return 'center';}
  if (v.includes('right') || v.includes('конец') || v.includes('прав')) {return 'flex-end';}
  if (v.includes('left') || v.includes('начал') || v.includes('лев')) {return 'flex-start';}
  return '';
}

function groupVToFlex(raw: string): string {
  const v = raw.toLowerCase();
  if (!raw.trim()) {return '';}
  if (v.includes('center') || v.includes('центр')) {return 'center';}
  if (v.includes('bottom') || v.includes('низ')) {return 'flex-end';}
  if (v.includes('top') || v.includes('верх')) {return 'flex-start';}
  return '';
}

/** Map group align + orientation to the same `justify-content` / `align-items` choices as the webview. */
export function layoutPreviewFlexBox(
  orientation: ContainerOrientation,
  groupHorizontalRaw: string,
  groupVerticalRaw: string,
  throughAlign: ThroughAlignKind,
): { flexJustifyContent: string; flexAlignItems: string } {
  const h = groupHToFlex(groupHorizontalRaw);
  const v = groupVToFlex(groupVerticalRaw);
  let flexJustifyContent = '';
  let flexAlignItems = '';
  if (orientation === 'horizontal') {
    flexJustifyContent = h;
    flexAlignItems = v;
  } else {
    flexJustifyContent = v;
    flexAlignItems = h;
  }
  if (throughAlign === 'use') {
    flexAlignItems = 'stretch';
  }
  return { flexJustifyContent, flexAlignItems };
}

/** Pixel gap for preview: Single 8 / Half 4 / Double 16; empty → no override. */
export function layoutSpacingToPx(kind: LayoutSpacingKind): number | null {
  if (!kind) {return null;}
  if (kind === 'half') {return 4;}
  if (kind === 'double') {return 16;}
  return 8;
}

/** Compact, safe layout metadata for preview rendering of container child items. */
export function getContainerLayoutPreviewMeta(item: FormChildItem | undefined): ContainerLayoutPreviewMeta {
  const tag = String(item?.tag || '');
  const properties = item?.properties as Record<string, unknown> | undefined;
  /** `Pages` is tabs + panel, not a horizontal flex of its XML children; ignore Group orientation on the root. */
  const isPagesRoot = tag === 'Pages';
  const rawOrientation = isPagesRoot
    ? ''
    : getPropertyValueByAliases(properties, [
      'Group',
      'groups',
      'GroupOrientation',
      'Orientation',
      'Layout',
      'LayoutOrientation',
      'ChildrenLayout',
      'ChildItemsLayout',
      'Расположение',
      'Ориентация',
      'Группировка',
    ]);
  const orientation = isPagesRoot ? 'vertical' : (normalizeOrientation(rawOrientation) ?? 'vertical');
  const rawIndent = getPropertyValueByAliases(properties, [
    'IndentChildren',
    'ShouldIndentChildren',
    'ChildIndent',
    'Вложенность',
    'ОтступДетей',
  ]).toLowerCase();
  const explicitIndent = rawIndent === 'true' || rawIndent === '1' || rawIndent === 'yes' || rawIndent === 'да'
    ? true
    : rawIndent === 'false' || rawIndent === '0' || rawIndent === 'no' || rawIndent === 'нет'
      ? false
      : undefined;
  const baseIndentByTag = tag === 'Page' || tag === 'Group' || tag === 'UsualGroup' || tag === 'CollapsibleGroup';
  const shouldIndentChildren = explicitIndent ?? baseIndentByTag;
  const hints = new Set<string>(['container', `container-${orientation}`]);
  if (shouldIndentChildren) {hints.add('container-indent');}
  if (tag) {hints.add(`container-${tag.toLowerCase()}`);}
  if (tag === 'AutoCommandBar') {hints.add('container-buttons');}
  if (tag === 'Page' || tag === 'Pages') {hints.add('container-page');}
  if (isPagesRoot) {hints.add('container-pages-root');}

  /** Pages = tab shell, not a horizontal/vertical group: ignore group layout props on the root node. */
  let horizontalSpacing: LayoutSpacingKind = '';
  let verticalSpacing: LayoutSpacingKind = '';
  let childItemsWidth: ChildItemsWidthKind = '';
  let throughAlign: ThroughAlignKind = '';
  let flexJustifyContent = '';
  let flexAlignItems = '';

  if (!isPagesRoot) {
    horizontalSpacing = normalizeSpacingKind(
      getPropertyValueByAliases(properties, ['HorizontalSpacing', 'horizontalSpacing', 'ГоризонтальныйИнтервал', 'ИнтервалГоризонтальный']),
    );
    verticalSpacing = normalizeSpacingKind(
      getPropertyValueByAliases(properties, ['VerticalSpacing', 'verticalSpacing', 'ВертикальныйИнтервал', 'ИнтервалВертикальный']),
    );
    childItemsWidth = normalizeChildItemsWidth(
      getPropertyValueByAliases(properties, ['ChildItemsWidth', 'childItemsWidth', 'ШиринаДочернихЭлементов']),
    );
    throughAlign = normalizeThroughAlign(
      getPropertyValueByAliases(properties, ['ThroughAlign', 'throughAlign', 'СквозноеВыравнивание']),
    );
    if (childItemsWidth === 'equal') {hints.add('ciwidth-equal');}
    else if (childItemsWidth === 'leftwidest') {hints.add('ciwidth-leftwidest');}
    else if (childItemsWidth === 'rightwidest') {hints.add('ciwidth-rightwidest');}
    if (throughAlign === 'use') {hints.add('throughalign-use');}

    const gh = getPropertyValueByAliases(properties, [
      'GroupHorizontalAlign',
      'groupHorizontalAlign',
      'HorizontalAlign',
      'horizontalAlign',
      'ГоризонтальноеВыравниваниеГруппы',
      'ГоризонтальноеВыравнивание',
    ]);
    const gv = getPropertyValueByAliases(properties, [
      'GroupVerticalAlign',
      'groupVerticalAlign',
      'VerticalAlign',
      'verticalAlign',
      'ВертикальноеВыравниваниеГруппы',
      'ВертикальноеВыравнивание',
    ]);
    const flexBox = layoutPreviewFlexBox(orientation, gh, gv, throughAlign);
    flexJustifyContent = flexBox.flexJustifyContent;
    flexAlignItems = flexBox.flexAlignItems;
  }

  return {
    tag,
    orientation,
    shouldIndentChildren,
    containerClassHints: [...hints],
    horizontalSpacing,
    verticalSpacing,
    childItemsWidth,
    throughAlign,
    flexJustifyContent,
    flexAlignItems,
  };
}

/** Resolve attribute type string from FormAttribute.properties (Type or v8:Type etc.). */
export function getAttributeTypeString(attr: FormAttribute): string {
  if (!attr?.properties) {return '';}
  const v = attr.properties['Type'];
  if (v != null) {
    if (typeof v === 'string') {return v.trim();}
    if (typeof v === 'object' && v !== null && '#text' in (v as object)) {return String((v as { '#text'?: unknown })['#text'] ?? '').trim();}
  }
  for (const k of Object.keys(attr.properties)) {
    if (k === ':@' || k.startsWith('@')) {continue;}
    const local = k.includes(':') ? k.split(':').pop()! : k;
    if (local === 'Type') {
      const val = attr.properties[k];
      if (typeof val === 'string') {return val.trim();}
      if (typeof val === 'object' && val !== null && '#text' in (val as object)) {return String((val as { '#text'?: unknown })['#text'] ?? '').trim();}
    }
  }
  return '';
}

/** Map form attribute type to form element tag: boolean → CheckBoxField, else InputField. */
export function requisiteTypeToTag(attr: FormAttribute | undefined): string {
  if (!attr) {return 'InputField';}
  const typeStr = getAttributeTypeString(attr).toLowerCase();
  if (typeStr === 'xs:boolean' || typeStr === 'boolean' || typeStr.includes('boolean')) {return 'CheckBoxField';}
  return 'InputField';
}

/** Collect all id values from tree (numeric ones for max). */
function collectIds(items: FormChildItem[], out: Set<string>): void {
  for (const item of items) {
    if (item.id != null) {out.add(String(item.id));}
    if (item.childItems?.length) {collectIds(item.childItems, out);}
  }
}

/** Generate next free id (max numeric + 1). */
export function generateNextId(model: FormModel): string {
  const ids = new Set<string>();
  collectIds(model.childItemsRoot, ids);
  let max = 0;
  for (const id of ids) {
    const n = parseInt(id, 10);
    if (!Number.isNaN(n) && n > max) {max = n;}
  }
  return String(max + 1);
}

/** Next numeric id for attributes (max of attribute ids + 1). */
export function generateNextAttributeId(model: FormModel): string {
  let max = 0;
  for (const a of model.attributes || []) {
    if (a.id) {
      const n = parseInt(a.id, 10);
      if (!Number.isNaN(n) && n > max) {max = n;}
    }
  }
  return String(max + 1);
}

/** Next numeric id for commands (max of command ids + 1). */
export function generateNextCommandId(model: FormModel): string {
  let max = 0;
  for (const c of model.commands || []) {
    if (c.id) {
      const n = parseInt(c.id, 10);
      if (!Number.isNaN(n) && n > max) {max = n;}
    }
  }
  return String(max + 1);
}

/** Deep clone FormChildItem and assign new ids via nextId(). */
export function cloneWithNewIds(item: FormChildItem, nextId: () => string): FormChildItem {
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
export function createIdGenerator(model: FormModel): () => string {
  let next = 0;
  const initial = generateNextId(model);
  next = parseInt(initial, 10);
  if (Number.isNaN(next)) {next = 1;}
  return () => String(next++);
}

/** Return ids sorted so that descendants appear before their ancestors (deepest first). */
export function orderIdsForDeletion(model: FormModel, ids: string[]): string[] {
  const depthMap = new Map<string, number>();
  const walk = (items: FormChildItem[], d: number) => {
    for (const item of items) {
      const id = item.id || item.name;
      if (id) {depthMap.set(id, d);}
      if (item.childItems?.length) {walk(item.childItems, d + 1);}
    }
  };
  walk(model.childItemsRoot, 0);
  return ids.slice().sort((a, b) => (depthMap.get(b) ?? 0) - (depthMap.get(a) ?? 0));
}
