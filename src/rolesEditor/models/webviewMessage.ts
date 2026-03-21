/**
 * Webview message types for communication between webview and extension
 */

import { MetadataType } from '../../models/treeNode';
import { RightType } from './roleModel';

/**
 * Command types for webview messages
 */
export type WebviewCommand = 
  | 'updateRight'
  | 'save'
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
   * User-edited restrictionTemplate XML block(s) (for save command)
   */
  restrictionTemplatesText?: string;

  /**
   * Table render progress (for tableRenderProgress command)
   */
  busy?: boolean;
  rowCount?: number;
}

/**
 * Response message sent from extension to webview
 */
export interface WebviewResponse {
  /**
   * Type of response
   */
  type: 'updateSuccess' | 'updateError' | 'validationSuccess' | 'validationError' | 'saveSuccess' | 'saveError';

  /**
   * Optional error messages
   */
  errors?: string[];

  /**
   * Optional success message
   */
  message?: string;

  /**
   * Optional data payload
   */
  data?: unknown;
}

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
