/**
 * Compatibility facade for Properties Webview consumers.
 * Host rendering, domain markup, and browser assets live in the responsibility-specific modules.
 */
export { CONTENT_EDITOR_COMMANDS } from './propertiesWebview/contracts';
export type { WebviewContentOptions } from './propertiesWebview/contracts';

export {
  renderPicturePreviewCard,
  isSafeCssColor,
  isSafeFontFamily,
  renderStyleItemPreview,
  escapeHtml,
  getEditTypePencilSvg,
  getGotoArrowSvg,
  isRootElement,
  detectPropertyType,
  renderPropertyInput,
  renderPropertiesBySections,
} from './propertiesWebview/renderers';

export {
  getWebviewScript,
  getWebviewContent,
  getEmptyStateContent,
  getErrorPanelContent,
  getFormSelectionWebviewContent,
} from './propertiesWebview/host';
