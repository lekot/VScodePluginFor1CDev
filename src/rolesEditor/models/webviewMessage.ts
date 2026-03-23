/**
 * Webview message types for communication between webview and extension
 */

import { MetadataType } from '../../models/treeNode';
import { RightType } from './roleModel';
import type { MetadataObject } from './metadataObject';

/**
 * Command types for webview messages
 */
export type WebviewCommand =
  | 'updateRight'
  | 'save'
  | 'savePayload'
  | 'cancel'
  | 'toggleFilter'
  | 'search'
  | 'filterByType'
  | 'tableRenderProgress';

/**
 * Message sent from webview to extension
 */
export interface WebviewMessage {
  /**
   * Command to execute
   */
  command: WebviewCommand;

  /**
   * Optional data payload specific to the command
   */
  data?: WebviewMessageData;
}

/**
 * Data payload for webview messages
 */
export interface WebviewMessageData {
  /**
   * Full name of the metadata object (for updateRight command)
   * Format: {MetadataType}.{ObjectName}
   */
  objectName?: string;

  /**
   * Type of right to update (for updateRight command)
   */
  rightType?: RightType;

  /**
   * New value for the right (for updateRight command)
   */
  value?: boolean;

  /**
   * Show all objects flag (for toggleFilter command)
   */
  showAll?: boolean;

  /**
   * Search query string (for search command)
   */
  query?: string;

  /**
   * Array of metadata types to filter by (for filterByType command)
   */
  types?: MetadataType[];

  /**
   * Single metadata type from the webview type filter (for filterByType command)
   */
  type?: string;

  /**
   * For command **`save`**: textarea RLS snapshot from the webview (usual Save / Ctrl+S from the panel).
   * For command **`savePayload`**: same field, but sent only in reply to extension
   * **`requestSavePayload`** (correlated by `requestId`) when the host runs an external save
   * (e.g. command palette) and must flush RLS without rebuilding HTML.
   */
  restrictionTemplatesText?: string;

  /**
   * Correlates extension `requestSavePayload` with webview `savePayload` (external save / flush RLS).
   */
  requestId?: string;

  /**
   * Table render progress (for tableRenderProgress command)
   */
  busy?: boolean;
  rowCount?: number;
}

/**
 * Commands the extension posts to the rights editor webview (`postMessage`).
 */
export type ExtensionToWebviewCommand =
  | 'objectsLoaded'
  | 'requestSavePayload'
  | 'updateSuccess'
  | 'updateError'
  | 'validationError'
  | 'validationCancelled'
  | 'saveError'
  | 'error';

/**
 * Typed messages from extension host → webview (matches `rolesRightsEditorProvider` `postMessage` usage).
 */
export type ExtensionToWebviewMessage =
  | {
      command: 'objectsLoaded';
      data: {
        objects: MetadataObject[];
        error?: string;
        /** When true, metadata/config is unavailable — Save must not write (see provider). */
        saveDisabled?: boolean;
      };
    }
  | { command: 'requestSavePayload'; data: { requestId: string } }
  | { command: 'updateSuccess'; data?: Record<string, never> }
  | {
      command: 'updateError';
      data: { errors?: string[]; message?: string };
    }
  | { command: 'validationError'; data: { errors: string[] } }
  | { command: 'validationCancelled'; data?: { message?: string } }
  | { command: 'saveError'; data: { message: string } }
  | { command: 'error'; data: { message: string } };

/**
 * Validation result for rights updates
 */
export interface ValidationResult {
  /**
   * Whether validation passed
   */
  isValid: boolean;

  /**
   * Array of validation error messages
   */
  errors: string[];
}
