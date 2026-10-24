import type { FormChildItem } from '../formModel';

export type LayoutOrientation = 'horizontal' | 'vertical';
export type SpacingKind = '' | 'single' | 'half' | 'double';
export type ChildItemsWidth = '' | 'equal' | 'leftwidest' | 'rightwidest';
export type ThroughAlign = '' | 'use' | 'dontuse';

export interface PreviewContainerLayout {
  tag: string;
  orientation: LayoutOrientation;
  shouldIndentChildren: boolean;
  containerClassHints: string[];
  horizontalSpacing: SpacingKind;
  verticalSpacing: SpacingKind;
  childItemsWidth: ChildItemsWidth;
  throughAlign: ThroughAlign;
  flexJustifyContent: string;
  flexAlignItems: string;
}

function normalizeLayoutKey(key: unknown): string {
  return String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function toScalarLayoutValue(value: unknown): string {
  if (Array.isArray(value)) { return toScalarLayoutValue(value[0]); }
  if (value == null) { return ''; }
  if (typeof value === 'string') { return value.trim(); }
  if (typeof value === 'number' || typeof value === 'boolean') { return String(value).trim(); }
  if (typeof value !== 'object') { return ''; }
  const record = value as Record<string, unknown>;
  const keys = ['#text', '_', 'value', 'Value', 'name', 'Name'];
  for (const key of keys) {
    const nested = toScalarLayoutValue(record[key]);
    if (nested) { return nested; }
  }
  return '';
}

export function getLayoutPropertyValueByAliases(
  properties: Record<string, unknown> | null | undefined,
  aliases: readonly string[],
): string {
  if (!properties) { return ''; }
  const normalizedToReal = new Map<string, string>();
  Object.keys(properties).forEach((key) => {
    if (key === ':@' || key.startsWith('@')) { return; }
    const local = key.includes(':') ? (key.split(':').pop() || key) : key;
    normalizedToReal.set(normalizeLayoutKey(local), key);
  });
  for (const alias of aliases) {
    const realKey = normalizedToReal.get(normalizeLayoutKey(alias));
    if (!realKey) { continue; }
    const value = toScalarLayoutValue(properties[realKey]);
    if (value) { return value; }
  }
  return '';
}

function normalizeContainerOrientation(rawValue: string): LayoutOrientation | null {
  const value = String(rawValue || '').toLowerCase().replace(/[\s_-]+/g, '');
  if (!value) { return null; }
  if (value.includes('horizontal') || value.includes('horiz') || value === 'row'
    || value.includes('leftright') || value.includes('горизонт') || value.includes('слеванаправо')) {
    return 'horizontal';
  }
  if (value.includes('vertical') || value.includes('vert') || value === 'column'
    || value.includes('topbottom') || value.includes('вертикал') || value.includes('сверхувниз')) {
    return 'vertical';
  }
  return null;
}

function normalizeSpacingKind(raw: string): SpacingKind {
  const value = String(raw || '').toLowerCase().replace(/[\s_-]+/g, '');
  if (!value) { return ''; }
  if (value.includes('double') || value.includes('двойн')) { return 'double'; }
  if (value.includes('half') || value.includes('половин')) { return 'half'; }
  return 'single';
}

function normalizeChildItemsWidth(raw: string): ChildItemsWidth {
  const value = String(raw || '').toLowerCase().replace(/[\s_-]+/g, '');
  if (!value) { return ''; }
  if (value === 'equal' || value.includes('равн')) { return 'equal'; }
  if (value.includes('left') && value.includes('wide')) { return 'leftwidest'; }
  if (value.includes('right') && value.includes('wide')) { return 'rightwidest'; }
  if (value === 'leftwidest') { return 'leftwidest'; }
  if (value === 'rightwidest') { return 'rightwidest'; }
  return '';
}

function normalizeThroughAlign(raw: string): ThroughAlign {
  const value = String(raw || '').toLowerCase().replace(/[\s_-]+/g, '');
  if (!value) { return ''; }
  if (value.includes('dont') || value.includes('неиспользов') || value === 'no') { return 'dontuse'; }
  if (value.includes('use') || value === 'yes' || value === 'да') { return 'use'; }
  return '';
}

function groupHorizontalToFlex(raw: string): string {
  const original = String(raw || '');
  const value = original.toLowerCase();
  if (!original.trim()) { return ''; }
  if (value.includes('center') || value.includes('центр')) { return 'center'; }
  if (value.includes('right') || value.includes('конец') || value.includes('прав')) { return 'flex-end'; }
  if (value.includes('left') || value.includes('начал') || value.includes('лев')) { return 'flex-start'; }
  return '';
}

function groupVerticalToFlex(raw: string): string {
  const original = String(raw || '');
  const value = original.toLowerCase();
  if (!original.trim()) { return ''; }
  if (value.includes('center') || value.includes('центр')) { return 'center'; }
  if (value.includes('bottom') || value.includes('низ')) { return 'flex-end'; }
  if (value.includes('top') || value.includes('верх')) { return 'flex-start'; }
  return '';
}

function layoutPreviewFlexBox(
  orientation: LayoutOrientation,
  horizontalAlignment: string,
  verticalAlignment: string,
  throughAlign: ThroughAlign,
): { flexJustifyContent: string; flexAlignItems: string } {
  const horizontal = groupHorizontalToFlex(horizontalAlignment);
  const vertical = groupVerticalToFlex(verticalAlignment);
  const flexJustifyContent = orientation === 'horizontal' ? horizontal : vertical;
  let flexAlignItems = orientation === 'horizontal' ? vertical : horizontal;
  if (throughAlign === 'use') { flexAlignItems = 'stretch'; }
  return { flexJustifyContent, flexAlignItems };
}

export function spacingKindToPx(kind: SpacingKind, orientation: LayoutOrientation): number | null {
  if (!kind) { return null; }
  if (kind === 'half') { return 5; }
  if (kind === 'double') { return orientation === 'horizontal' ? 20 : 18; }
  return orientation === 'horizontal' ? 10 : 9;
}

export function applyPreviewContainerLayout(element: HTMLElement, meta: PreviewContainerLayout): void {
  const rowGap = spacingKindToPx(meta.verticalSpacing, 'vertical');
  const columnGap = spacingKindToPx(meta.horizontalSpacing, 'horizontal');
  element.style.rowGap = rowGap == null ? '' : `${rowGap}px`;
  element.style.columnGap = columnGap == null ? '' : `${columnGap}px`;
  element.style.justifyContent = meta.flexJustifyContent || '';
  element.style.alignItems = meta.flexAlignItems || '';
}

export function getContainerLayoutMeta(item: FormChildItem): PreviewContainerLayout {
  const tag = String(item.tag || '');
  const properties = item.properties;
  const isPagesRoot = tag === 'Pages';
  const rawOrientation = isPagesRoot ? '' : getLayoutPropertyValueByAliases(properties, [
    'Group', 'groups', 'GroupOrientation', 'Orientation', 'Layout', 'LayoutOrientation',
    'ChildrenLayout', 'ChildItemsLayout', 'Расположение', 'Ориентация', 'Группировка',
  ]);
  const isCommandBar = tag === 'AutoCommandBar' || tag === 'CommandBar';
  const orientation: LayoutOrientation = isPagesRoot ? 'vertical'
    : isCommandBar ? 'horizontal' : normalizeContainerOrientation(rawOrientation) || 'vertical';
  const rawIndent = getLayoutPropertyValueByAliases(properties, [
    'IndentChildren', 'ShouldIndentChildren', 'ChildIndent', 'Вложенность', 'ОтступДетей',
  ]).toLowerCase();
  const explicitIndent = rawIndent === 'true' || rawIndent === '1' || rawIndent === 'yes' || rawIndent === 'да'
    ? true
    : rawIndent === 'false' || rawIndent === '0' || rawIndent === 'no' || rawIndent === 'нет'
      ? false
      : null;
  const shouldIndentChildren = explicitIndent != null
    ? explicitIndent
    : tag === 'Page' || tag === 'Group' || tag === 'UsualGroup' || tag === 'CollapsibleGroup';
  const hints = ['container', `container-${orientation}`];
  if (shouldIndentChildren) { hints.push('container-indent'); }
  if (tag) { hints.push(`container-${tag.toLowerCase()}`); }
  if (tag === 'AutoCommandBar') { hints.push('container-buttons'); }
  if (tag === 'Page' || tag === 'Pages') { hints.push('container-page'); }
  if (isPagesRoot) { hints.push('container-pages-root'); }

  let horizontalSpacing: SpacingKind = '';
  let verticalSpacing: SpacingKind = '';
  let childItemsWidth: ChildItemsWidth = '';
  let throughAlign: ThroughAlign = '';
  let flexJustifyContent = '';
  let flexAlignItems = '';
  if (!isPagesRoot) {
    horizontalSpacing = normalizeSpacingKind(getLayoutPropertyValueByAliases(properties, [
      'HorizontalSpacing', 'horizontalSpacing', 'ГоризонтальныйИнтервал', 'ИнтервалГоризонтальный',
    ]));
    verticalSpacing = normalizeSpacingKind(getLayoutPropertyValueByAliases(properties, [
      'VerticalSpacing', 'verticalSpacing', 'ВертикальныйИнтервал', 'ИнтервалВертикальный',
    ]));
    childItemsWidth = normalizeChildItemsWidth(getLayoutPropertyValueByAliases(properties, [
      'ChildItemsWidth', 'childItemsWidth', 'ШиринаДочернихЭлементов',
    ]));
    throughAlign = normalizeThroughAlign(getLayoutPropertyValueByAliases(properties, [
      'ThroughAlign', 'throughAlign', 'СквозноеВыравнивание',
    ]));
    if (childItemsWidth === 'equal') { hints.push('ciwidth-equal'); }
    else if (childItemsWidth === 'leftwidest') { hints.push('ciwidth-leftwidest'); }
    else if (childItemsWidth === 'rightwidest') { hints.push('ciwidth-rightwidest'); }
    if (throughAlign === 'use') { hints.push('throughalign-use'); }
    const horizontalAlignment = getLayoutPropertyValueByAliases(properties, [
      'GroupHorizontalAlign', 'groupHorizontalAlign', 'HorizontalAlign', 'horizontalAlign',
      'ГоризонтальноеВыравниваниеГруппы', 'ГоризонтальноеВыравнивание',
    ]);
    const verticalAlignment = getLayoutPropertyValueByAliases(properties, [
      'GroupVerticalAlign', 'groupVerticalAlign', 'VerticalAlign', 'verticalAlign',
      'ВертикальноеВыравниваниеГруппы', 'ВертикальноеВыравнивание',
    ]);
    const flexBox = layoutPreviewFlexBox(orientation, horizontalAlignment, verticalAlignment, throughAlign);
    flexJustifyContent = flexBox.flexJustifyContent;
    flexAlignItems = flexBox.flexAlignItems;
  }
  return {
    tag, orientation, shouldIndentChildren: Boolean(shouldIndentChildren), containerClassHints: hints,
    horizontalSpacing, verticalSpacing, childItemsWidth, throughAlign, flexJustifyContent, flexAlignItems,
  };
}

export function layoutContainerStyle(
  meta: PreviewContainerLayout,
  opts: { skipPreviewChildren?: boolean; previewChildrenAlias?: string } = {},
): string {
  const classes: string[] = [];
  if (opts.previewChildrenAlias) { classes.push(opts.previewChildrenAlias); }
  else if (!opts.skipPreviewChildren) { classes.push('preview-children'); }
  classes.push(`preview-children-${meta.orientation}`);
  if (meta.shouldIndentChildren) { classes.push('preview-children-indented'); }
  if (meta.tag === 'AutoCommandBar') { classes.push('preview-buttons-container'); }
  for (const hint of meta.containerClassHints) { classes.push(`preview-${hint.replace(/[^a-z0-9_-]/gi, '-')}`); }
  return classes.join(' ');
}

export function getPreviewDropIndex(
  children: ArrayLike<Element>,
  event: DragEvent,
  orientation: LayoutOrientation,
): number {
  const horizontal = orientation === 'horizontal';
  let index = 0;
  const point = horizontal ? event.clientX : event.clientY;
  for (let childIndex = 0; childIndex < children.length; childIndex += 1) {
    const bounds = children[childIndex].getBoundingClientRect();
    const middle = horizontal ? bounds.left + bounds.width / 2 : bounds.top + bounds.height / 2;
    if (point > middle) { index = childIndex + 1; }
  }
  return index;
}

export function normalizeTitleLocation(raw: unknown): 'left' | 'right' | 'top' | 'bottom' | 'none' {
  const value = String(raw || '').toLowerCase().replace(/[ _-]+/g, '');
  if (!value) { return 'left'; }
  if (value === 'none' || value.includes('нет')) { return 'none'; }
  if (value === 'right' || value.includes('прав')) { return 'right'; }
  if (value === 'top' || value.includes('верх')) { return 'top'; }
  if (value === 'bottom' || value.includes('низ')) { return 'bottom'; }
  return 'left';
}

export function resolveTitleLocation(item: FormChildItem): 'left' | 'right' | 'top' | 'bottom' | 'none' {
  return normalizeTitleLocation(getLayoutPropertyValueByAliases(item.properties, ['TitleLocation']));
}

export function getPagesRepresentationClass(item: FormChildItem): 'TabsOnTop' | 'TabsOnBottom' {
  const raw = getLayoutPropertyValueByAliases(item.properties, [
    'PagesRepresentation', 'pagesRepresentation', 'ПредставлениеСтраниц',
  ]);
  const value = String(raw || '').toLowerCase().replace(/[\s_-]+/g, '');
  return value.includes('bottom') || value.includes('низ') || value.includes('внизу') ? 'TabsOnBottom' : 'TabsOnTop';
}
