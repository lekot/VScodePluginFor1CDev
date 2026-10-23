import * as path from 'path';
import { TreeNode, MetadataType } from '../../models/treeNode';
import type { ResolvedPicture } from '../../services/picture/commonPictureResolver';
import { TypeParser } from '../../parsers/typeParser';
import { TypeFormatter } from '../../utils/typeFormatter';
import { getPropertyLabel } from '../../constants/propertyLabels';
import {
  getPropertySectionsForType,
  getKnownPropertyNamesForType,
  OTHER_SECTION_TITLE,
  DEFAULT_SECTION_TITLE,
} from '../../constants/propertySections';
import { getPropertyEnumValues } from '../../constants/propertyEnumValues';
import { Logger } from '../../utils/logger';
import { isIdentitySensitiveMetadataProperty } from '../../domain/metadataPropertyClassifier';
import { CONTENT_EDITOR_COMMANDS } from './contracts';

export function renderPicturePreviewCard(picture: ResolvedPicture): string {
  if (!picture.success) {
    return `
      <div class="picture-preview-card picture-preview-error">
        <div class="picture-card-header">
          <span class="picture-badge badge-error">Изображение</span>
        </div>
        <div class="picture-preview-empty">
          <p>${escapeHtml(picture.error || 'Файл изображения не найден')}</p>
        </div>
      </div>
    `;
  }

  const fileName = picture.resolvedFilePath ? path.basename(picture.resolvedFilePath) : 'Picture';
  const badgeText = picture.isZip ? `${picture.format || 'IMG'} (ZIP архив)` : (picture.format || 'IMG');
  const entryInfo = picture.entryName ? `<span class="picture-entry-name">Вариант: ${escapeHtml(picture.entryName)}</span>` : '';

  return `
    <div class="picture-preview-card">
      <div class="picture-card-header">
        <span class="picture-badge badge-format">${escapeHtml(badgeText)}</span>
        <span class="picture-filename">${escapeHtml(fileName)}</span>
        ${entryInfo}
        ${picture.resolvedFilePath ? `
          <button class="open-pic-btn" data-file-path="${escapeHtml(picture.resolvedFilePath)}" title="Открыть файл изображения">
            Открыть файл
          </button>
        ` : ''}
      </div>
      <div class="picture-preview-container">
        <div class="picture-checkerboard">
          <img src="${picture.dataUri}" alt="${escapeHtml(fileName)}" class="picture-preview-img" />
        </div>
      </div>
    </div>
  `;
}

/**
 * Validate that a color string is safe to use in inline CSS style attributes.
 * Allows hex colors (#rgb, #rrggbb, #rrggbbaa), safe named CSS colors, and rgb/rgba functions.
 * Strictly prevents quotes, semicolons, injection of url(), expression(), or scripts.
 */
export function isSafeCssColor(color: string): boolean {
  if (!color || typeof color !== 'string') {
    return false;
  }
  const trimmed = color.trim();
  // Hex color (#fff, #ffffff, #ffffffff)
  if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(trimmed)) {
    return true;
  }
  // Named CSS color (ASCII letters only, excluding dangerous words)
  if (/^[a-zA-Z]+$/.test(trimmed)) {
    const lower = trimmed.toLowerCase();
    if (lower === 'javascript' || lower === 'expression' || lower === 'url') {
      return false;
    }
    return true;
  }
  // rgb/rgba functions with safe numbers
  if (/^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$/i.test(trimmed)) {
    return true;
  }
  return false;
}

/**
 * Validate that a font family name contains only safe characters (no quotes, semicolons, etc.).
 */
export function isSafeFontFamily(face: string): boolean {
  if (!face || typeof face !== 'string') {
    return false;
  }
  return /^[a-zA-Z0-9\s\-_]+$/.test(face.trim());
}

interface ExtractedStyleColor {
  displayVal: string;
  cssBg: string;
}

function extractStyleColor(rawValue: unknown): ExtractedStyleColor {
  let valStr = '';
  if (typeof rawValue === 'string') {
    valStr = rawValue.trim();
  } else if (rawValue && typeof rawValue === 'object') {
    const obj = rawValue as Record<string, unknown>;
    if (typeof obj['#text'] === 'string') {
      valStr = obj['#text'].trim();
    } else if (obj['#text'] !== undefined && obj['#text'] !== null) {
      valStr = String(obj['#text']).trim();
    }
  }

  let cssBg = 'var(--vscode-editor-foreground)';
  let displayVal = valStr;

  const hexMatch = /^#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})$/.exec(valStr.trim());
  if (hexMatch && isSafeCssColor(hexMatch[0])) {
    cssBg = hexMatch[0];
    displayVal = hexMatch[0];
  } else if (valStr.startsWith('web:')) {
    const colorName = valStr.slice(4).trim();
    if (isSafeCssColor(colorName)) {
      cssBg = colorName;
    } else {
      cssBg = 'var(--vscode-editor-foreground)';
    }
    displayVal = valStr;
  } else if (valStr.startsWith('style:')) {
    displayVal = valStr;
    cssBg = 'var(--vscode-editor-foreground)';
  } else if (valStr.startsWith('win:')) {
    displayVal = valStr;
    cssBg = 'var(--vscode-button-background)';
  } else {
    const rgbMatch = /(?:d\d+p\d+:)?RGB\s*\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)/i.exec(valStr);
    if (rgbMatch) {
      const rgbColor = `rgb(${rgbMatch[1]}, ${rgbMatch[2]}, ${rgbMatch[3]})`;
      if (isSafeCssColor(rgbColor)) {
        cssBg = rgbColor;
        displayVal = valStr;
      }
    } else if (isSafeCssColor(valStr)) {
      cssBg = valStr;
      displayVal = valStr;
    }
  }

  return { displayVal, cssBg };
}

interface ExtractedStyleFont {
  displayStr: string;
  fontFamily: string;
  isBold: boolean;
  isItalic: boolean;
  isUnderline: boolean;
  isStrikeout: boolean;
}

function extractStyleFont(rawValue: unknown): ExtractedStyleFont {
  let isBold = false;
  let isItalic = false;
  let isUnderline = false;
  let isStrikeout = false;
  let faceName = '';
  let ref = '';
  let height: string | undefined;

  if (rawValue && typeof rawValue === 'object') {
    const obj = rawValue as Record<string, unknown>;
    const fontObj = (
      obj['v8:Font'] && typeof obj['v8:Font'] === 'object'
        ? obj['v8:Font']
        : obj['Font'] && typeof obj['Font'] === 'object'
          ? obj['Font']
          : obj
    ) as Record<string, unknown>;

    const getAttr = (key: string): unknown =>
      fontObj[`@_${key}`] ?? fontObj[key] ?? obj[`@_${key}`] ?? obj[key];

    const parseBool = (v: unknown): boolean =>
      v === true || v === 'true' || v === 1 || v === '1';

    isBold = parseBool(getAttr('bold'));
    isItalic = parseBool(getAttr('italic'));
    isUnderline = parseBool(getAttr('underline'));
    isStrikeout = parseBool(getAttr('strikeout'));

    const rawFace = getAttr('faceName') ?? getAttr('face');
    if (typeof rawFace === 'string') {
      faceName = rawFace.trim();
    }
    const rawRef = getAttr('ref');
    if (typeof rawRef === 'string') {
      ref = rawRef.trim();
    }
    const rawHeight = getAttr('height');
    if (rawHeight !== undefined && rawHeight !== null) {
      height = String(rawHeight).trim();
    }
  } else {
    const valStr = typeof rawValue === 'string' ? rawValue : JSON.stringify(rawValue || '');
    isBold = /bold\s*=\s*["']?true["']?|bold\s*:\s*true/i.test(valStr);
    isItalic = /italic\s*=\s*["']?true["']?|italic\s*:\s*true/i.test(valStr);
    isUnderline = /underline\s*=\s*["']?true["']?|underline\s*:\s*true/i.test(valStr);
    isStrikeout = /strikeout\s*=\s*["']?true["']?|strikeout\s*:\s*true/i.test(valStr);

    const faceMatch = /(?:@_)?faceName\s*[:=]\s*["']([^"']+)["']/i.exec(valStr);
    if (faceMatch) {
      faceName = faceMatch[1].trim();
    }
    const refMatch = /(?:@_)?ref\s*[:=]\s*["']([^"']+)["']/i.exec(valStr);
    if (refMatch) {
      ref = refMatch[1].trim();
    }
    const heightMatch = /(?:@_)?height\s*[:=]\s*["']?(\d+)["']?/i.exec(valStr);
    if (heightMatch) {
      height = heightMatch[1];
    }
  }

  const fontFamily = isSafeFontFamily(faceName) ? faceName : 'inherit';

  let displayStr = '';
  if (ref) {
    displayStr = ref;
  } else if (faceName) {
    displayStr = `${faceName}${height ? `, ${height}pt` : ''}`;
  } else if (typeof rawValue === 'string' && rawValue) {
    displayStr = rawValue;
  } else {
    displayStr = 'Стандартный шрифт';
  }

  const flags: string[] = [];
  if (isBold) { flags.push('жирный'); }
  if (isItalic) { flags.push('курсив'); }
  if (isUnderline) { flags.push('подчёркнутый'); }
  if (isStrikeout) { flags.push('зачёркнутый'); }
  if (flags.length > 0 && !displayStr.includes('(')) {
    displayStr += ` (${flags.join(', ')})`;
  }

  return { displayStr, fontFamily, isBold, isItalic, isUnderline, isStrikeout };
}

/**
 * Render visual swatch / font typography sample for StyleItem elements.
 */
export function renderStyleItemPreview(node: TreeNode): string {
  if (node.type !== MetadataType.StyleItem) {
    return '';
  }
  const props = (node.properties || {}) as Record<string, unknown>;
  const typeVal = String(props.Type || props['type'] || '').trim();
  const rawValue = props.Value !== undefined ? props.Value : props['value'];

  if (typeVal.toLowerCase() === 'color') {
    const { displayVal, cssBg } = extractStyleColor(rawValue);

    return `
      <div class="style-item-preview">
        <div class="style-preview-swatch" style="background-color: ${escapeHtml(cssBg)};"></div>
        <div class="style-preview-details">
          <span class="style-preview-title">Цвет стиля</span>
          <span class="style-preview-value">${escapeHtml(displayVal)}</span>
        </div>
      </div>
    `;
  }

  if (typeVal.toLowerCase() === 'font') {
    const font = extractStyleFont(rawValue);

    const styleParts: string[] = [
      `font-family: ${font.fontFamily}`,
      font.isBold ? 'font-weight: bold' : 'font-weight: normal',
      font.isItalic ? 'font-style: italic' : 'font-style: normal',
      font.isUnderline ? 'text-decoration: underline' : '',
    ].filter(Boolean);

    return `
      <div class="style-item-preview">
        <div class="style-font-sample" style="${escapeHtml(styleParts.join('; '))}">
          Пример текста / Sample Text 123
        </div>
        <div class="style-preview-details">
          <span class="style-preview-title">Шрифт стиля</span>
          <span class="style-preview-value">${escapeHtml(font.displayStr)}</span>
        </div>
      </div>
    `;
  }

  if (typeVal.toLowerCase() === 'border') {
    const valStr = typeof rawValue === 'string' ? rawValue : JSON.stringify(rawValue || '');
    return `
      <div class="style-item-preview">
        <div class="style-border-sample" style="border: 2px solid var(--vscode-editor-foreground); width: 60px; height: 30px;"></div>
        <div class="style-preview-details">
          <span class="style-preview-title">Рамка стиля</span>
          <span class="style-preview-value">${escapeHtml(valStr)}</span>
        </div>
      </div>
    `;
  }

  return '';
}

/**
 * Escape HTML to prevent XSS
 */
export function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return text.replace(/[&<>"']/g, (m) => map[m]);
}

/**
 * Inline SVG for pencil (edit) icon — used in webview; no external font required.
 * Matches VSCode codicon-edit style; aria-hidden on parent span.
 */
export function getEditTypePencilSvg(): string {
  return `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M13.23 1h-1.46L3.52 9.85l-.16.22L1 13.11 2.41 14.5l3.04-2.35.22-.16L15 4.23V2.77L13.23 1zM2.41 11.59l.59-.59.59.59-.59.59-.59-.59zm1.83-1.83l.59-.59 3.54 3.54-.59.59-3.54-3.54zM11.77 2L14 4.23l-1.17 1.17L10.6 3.17 11.77 2z"/></svg>`;
}

/**
 * Inline SVG for goto-arrow (→) icon — used for "Перейти в модуль" button.
 */
export function getGotoArrowSvg(): string {
  return `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M8.5 3.5l5 4.5-5 4.5V9H2V7h6.5V3.5z"/></svg>`;
}

/**
 * Check if node is a root metadata element (Catalog, Document, etc.)
 * Note: Attribute is NOT in this list because it's a nested element
 * and should have an editable type property
 */
export function isRootElement(node: TreeNode | undefined): boolean {
  if (!node) {
    return false;
  }

  // Nested elements (Attributes, TabularSections, etc.) have parentFilePath
  // They are NOT root elements even if they don't have parent reference
  if (node.parentFilePath) {
    return false;
  }

  // Root elements are direct children of Configuration or have no parent
  // or their parent type is 'Configuration'
  if (!node.parent) {
    return true;
  }

  // Check if parent is Configuration
  if (node.parent.type === 'Configuration') {
    return true;
  }

  // Root metadata types (elements that have their own XML file)
  const rootTypes = [
    'Catalog', 'Document', 'Register', 'InformationRegister',
    'AccumulationRegister', 'ChartOfCharacteristicTypes',
    'ChartOfAccounts', 'ChartOfCalculationTypes', 'BusinessProcess',
    'Task', 'ExchangePlan', 'Enum', 'Report', 'DataProcessor',
    'CommonModule', 'Role', 'CommonAttribute', 'CommonCommand',
    'CommandGroup', 'FunctionalOption', 'FunctionalOptionsParameter',
    'DefinedType', 'SettingsStorage', 'CommonForm', 'CommonTemplate',
    'CommonPicture', 'XDTOPackage', 'WebService', 'HTTPService',
    'WSReference', 'Style', 'Language', 'Subsystem', 'StyleItem',
    'Interface', 'SessionParameter',
  ];

  return rootTypes.includes(node.type);
}

/**
 * Detect property type from value
 */
export function detectPropertyType(value: unknown): 'string' | 'boolean' | 'number' | 'unknown' {
  if (typeof value === 'boolean') {
    return 'boolean';
  }
  if (typeof value === 'number') {
    return 'number';
  }
  if (typeof value === 'string') {
    return 'string';
  }
  return 'unknown';
}

/**
 * Render a single property input field.
 * @param currentNode — needed to determine if Type field should be read-only
 */
export function renderPropertyInput(
  name: string,
  value: unknown,
  globalReadOnly: boolean,
  currentNode: TreeNode | undefined
): string {
  // Format Type property if it's an object (defensive fallback)
  let displayValue = value;
  const isTypeProperty = name.toLowerCase() === 'type';
  const isIdentityProperty = isIdentitySensitiveMetadataProperty(name);

  if (isTypeProperty && (value === null || value === undefined)) {
    displayValue = 'Not set';
  } else if (isTypeProperty && typeof value === 'object' && value !== null) {
    try {
      const typeDef = TypeParser.parseFromObject(value as Record<string, unknown>);
      displayValue = TypeFormatter.formatTypeDisplay(typeDef);
    } catch (error) {
      Logger.error('Failed to format Type in renderPropertyInput', error);
      displayValue = '[Invalid Type]';
    }
  } else if (isTypeProperty && typeof value === 'string' && value.includes('<')) {
    try {
      const typeDef = TypeParser.parse(value);
      displayValue = TypeFormatter.formatTypeDisplay(typeDef);
    } catch (error) {
      Logger.error('Failed to parse Type XML in renderPropertyInput', error);
      displayValue = '[Invalid Type]';
    }
  }

  if (isIdentityProperty) {
    const displayName = 'Имя';
    const renameElementButton = currentNode && !globalReadOnly
      && currentNode.type !== MetadataType.Configuration
      ? `<button type="button" class="rename-element-btn" data-action="renameElement" aria-label="Переименовать элемент" title="Переименовать элемент">Переименовать</button>`
      : '';
    return `
      <div class="property-row">
        <label class="property-label">${escapeHtml(displayName)}</label>
        <input type="text" class="property-input" data-property="${escapeHtml(name)}" value="${escapeHtml(String(displayValue ?? ''))}" disabled />
        ${renameElementButton}
      </div>
    `;
  }

  // Source property on EventSubscription — render with edit button
  const isSourceProperty = name.toLowerCase() === 'source' && currentNode?.type === 'EventSubscription';
  if (isSourceProperty) {
    const displayName = getPropertyLabel(name);
    let sourceSummary: string;
    if (Array.isArray(value)) {
      sourceSummary = `[${value.length} типов]`;
    } else if (typeof value === 'object' && value !== null) {
      const obj = value as Record<string, unknown>;
      const typeArr = obj['v8:Type'];
      if (Array.isArray(typeArr)) {
        sourceSummary = `[${typeArr.length} типов]`;
      } else if (typeArr !== undefined) {
        sourceSummary = '[1 тип]';
      } else {
        sourceSummary = '[пусто]';
      }
    } else if (typeof value === 'string' && value.trim().startsWith('<')) {
      const matches = (value.match(/<v8:Type>/g) || []).length;
      sourceSummary = matches > 0 ? `[${matches} типов]` : '[пусто]';
    } else {
      sourceSummary = '[пусто]';
    }
    return `
      <div class="property-row">
        <label class="property-label">${escapeHtml(displayName)}</label>
        <input type="text" class="property-input" data-property="${escapeHtml(name)}" value="${escapeHtml(sourceSummary)}" disabled />
        <button type="button" class="edit-source-btn" data-action="editSource" data-property="${escapeHtml(name)}" aria-label="Редактировать источник" title="Редактировать источник"><span class="edit-type-icon" aria-hidden="true">${getEditTypePencilSvg()}</span></button>
      </div>
    `;
  }

  // Handler property on EventSubscription — render with goto-module button
  const isHandlerProperty = name === 'Handler' && currentNode?.type === 'EventSubscription';
  if (isHandlerProperty) {
    const displayName = getPropertyLabel(name);
    const handlerValue = typeof value === 'string' ? value : '';
    const gotoButton = handlerValue.trim()
      ? `<button type="button" class="goto-handler-btn" data-property="Handler" data-handler="${escapeHtml(handlerValue)}" aria-label="Перейти в модуль" title="Перейти в модуль"><span class="edit-type-icon" aria-hidden="true">${getGotoArrowSvg()}</span></button>`
      : '';
    return `
      <div class="property-row">
        <label class="property-label">${escapeHtml(displayName)}</label>
        <input type="text" class="property-input" data-property="${escapeHtml(name)}" value="${escapeHtml(handlerValue)}" ${globalReadOnly ? 'disabled' : ''} />
        ${gotoButton}
      </div>
    `;
  }

  // Content property — always show edit button for types with composition editors (even when empty/string)
  const isContentProperty = name.toLowerCase() === 'content';
  const nodeTypeStr = currentNode?.type ?? '';
  const contentEditorCommand = isContentProperty ? CONTENT_EDITOR_COMMANDS.get(nodeTypeStr) : undefined;

  // Complex objects/arrays (except Type which is handled above) — render as read-only summary
  if (!isTypeProperty && (Array.isArray(displayValue) || (typeof displayValue === 'object' && displayValue !== null))) {
    const displayName = getPropertyLabel(name);
    const summary = Array.isArray(displayValue)
      ? `[${displayValue.length} элем.]`
      : '{...}';
    const editContentButton = contentEditorCommand
      ? `<button type="button" class="edit-content-btn" data-node-type="${escapeHtml(nodeTypeStr)}" aria-label="Редактировать состав" title="Редактировать состав"><span class="edit-type-icon" aria-hidden="true">${getEditTypePencilSvg()}</span></button>`
      : '';
    return `
      <div class="property-row">
        <label class="property-label">${escapeHtml(displayName)}</label>
        <input type="text" class="property-input" data-property="${escapeHtml(name)}" value="${escapeHtml(summary)}" disabled />
        ${editContentButton}
      </div>
    `;
  }

  // Empty Content (string value) — show edit button anyway for types with composition editors
  if (contentEditorCommand) {
    const displayName = getPropertyLabel(name);
    const summary = '[пусто]';
    return `
      <div class="property-row">
        <label class="property-label">${escapeHtml(displayName)}</label>
        <input type="text" class="property-input" data-property="${escapeHtml(name)}" value="${escapeHtml(summary)}" disabled />
        <button type="button" class="edit-content-btn" data-node-type="${escapeHtml(nodeTypeStr)}" aria-label="Редактировать состав" title="Редактировать состав"><span class="edit-type-icon" aria-hidden="true">${getEditTypePencilSvg()}</span></button>
      </div>
    `;
  }

  const propertyType = detectPropertyType(displayValue);
  // Determine if this specific property should be read-only
  const nodeIsRoot = isRootElement(currentNode);
  const typeEditableRootTypes = ['DefinedType', 'ChartOfCharacteristicTypes', 'SessionParameter', 'FilterCriterion', 'CommonAttribute'];
  const propertyReadOnly = globalReadOnly || (nodeIsRoot && isTypeProperty && !typeEditableRootTypes.includes(currentNode?.type ?? ''));
  const disabled = propertyReadOnly ? 'disabled' : '';

  // Get Russian label for property name
  const displayName = getPropertyLabel(name);

  const editTypeButton = isTypeProperty && !propertyReadOnly ? `
    <button type="button" class="edit-type-btn" data-property="${escapeHtml(name)}" aria-label="Редактировать тип" title="Редактировать тип">
      <span class="edit-type-icon" aria-hidden="true">${getEditTypePencilSvg()}</span>
    </button>
  ` : '';

  // Render <select> for enum properties
  const enumValues = getPropertyEnumValues(name);
  if (enumValues && !isTypeProperty && !propertyReadOnly) {
    const currentValue = String(displayValue ?? '');
    const options = enumValues.map(v =>
      `<option value="${escapeHtml(v)}"${v === currentValue ? ' selected' : ''}>${escapeHtml(v)}</option>`
    ).join('');
    // Add current value as option if not in the list (unknown/legacy value)
    const unknownOption = currentValue && !enumValues.includes(currentValue)
      ? `<option value="${escapeHtml(currentValue)}" selected>${escapeHtml(currentValue)}</option>`
      : '';
    return `
      <div class="property-row">
        <label class="property-label">${escapeHtml(displayName)}</label>
        <select class="property-input" data-property="${escapeHtml(name)}" ${disabled}>
          ${unknownOption}${options}
        </select>
      </div>
    `;
  }

  const inputType = propertyType === 'boolean' ? 'checkbox' : propertyType === 'number' ? 'number' : 'text';
  const checked = propertyType === 'boolean' && displayValue ? 'checked' : '';
  const inputValue = propertyType === 'boolean' ? '' : escapeHtml(String(displayValue ?? ''));

  return `
    <div class="property-row">
      <label class="property-label">${escapeHtml(displayName)}</label>
      <input
        type="${inputType}"
        class="property-input"
        data-property="${escapeHtml(name)}"
        value="${inputValue}"
        ${checked}
        ${disabled}
      />
      ${editTypeButton}
    </div>
  `;
}

/**
 * Render properties grouped by type-specific sections.
 * Uses getPropertySectionsForType(node.type); properties not in any section go to "Прочее".
 */
export function renderPropertiesBySections(node: TreeNode, readOnly: boolean): string {
  let properties = (node.properties || {}) as Record<string, unknown>;
  if (node.type === 'DefinedType' && !('Type' in properties) && !('type' in properties)) {
    properties = { ...properties, Type: null };
  }
  const sections = getPropertySectionsForType(node.type);
  const knownNames = getKnownPropertyNamesForType(node.type);
  const allKeys = Object.keys(properties);
  const otherKeys = allKeys.filter((k) => !knownNames.has(k));

  let html = '';

  // Type-specific sections with defined propertyNames
  for (const section of sections) {
    const namesInSection =
      section.propertyNames.length > 0
        ? section.propertyNames.filter((name) => name in properties)
        : allKeys;
    if (namesInSection.length === 0 && section.title !== DEFAULT_SECTION_TITLE) {
      continue;
    }
    if (section.propertyNames.length === 0 && section.title === DEFAULT_SECTION_TITLE) {
      // Default: single block with all properties
      html += `<div class="property-section"><div class="property-section-title">${escapeHtml(section.title)}</div>`;
      for (const key of allKeys) {
        html += renderPropertyInput(key, properties[key], readOnly, node);
      }
      html += '</div>';
      break;
    }
    html += `<div class="property-section"><div class="property-section-title">${escapeHtml(section.title)}</div>`;
    for (const name of namesInSection) {
      if (name in properties) {
        html += renderPropertyInput(name, properties[name], readOnly, node);
      }
    }
    html += '</div>';
  }

  // "Прочее" only when we have type-specific sections (knownNames non-empty)
  if (knownNames.size > 0 && otherKeys.length > 0) {
    html += `<div class="property-section"><div class="property-section-title">${escapeHtml(OTHER_SECTION_TITLE)}</div>`;
    for (const key of otherKeys) {
      html += renderPropertyInput(key, properties[key], readOnly, node);
    }
    html += '</div>';
  }

  return html;
}

/**
 * Generate webview JavaScript for client-side interaction
 */
