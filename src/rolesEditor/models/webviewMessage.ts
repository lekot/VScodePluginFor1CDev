/**
 * Webview message types for communication between webview and extension
 */

import { MetadataType } from '../../models/treeNode';
import type { MutationFailureStatus } from '../../services/configurationSession/mutationReceiptError';
import { RightType } from './roleModel';
import type { MetadataObject } from './metadataObject';

export interface UiRoleRightProjection {
  key: string;
  xmlName: string;
  label: string;
  applicableTo: readonly string[];
  dependencies: readonly string[];
  clearedBy: readonly string[];
  interactiveBase?: string;
}

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
  | 'tableRenderProgress'
  | 'loadObjectAttributes'
  | 'cancelSearch';

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
   * Host-allocated session identifier correlating webview session lifecycle.
   */
  sessionId?: string;

  /**
   * Correlates async request/response pairs (e.g. loadObjectAttributes, savePayload).
   */
  requestId?: string;

  /**
   * Monotonically increasing revision of table data rendered in webview.
   */
  dataRevision?: number;

  /**
   * Incremental search query generation.
   */
  queryId?: number;

  /**
   * Full name of the metadata object (for updateRight command)
   * Format: {MetadataType}.{ObjectName}
   */
  objectName?: string;

  /**
   * Semantic full name of target metadata object for attribute operations.
   */
  objectFullName?: string;

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
   * Table render progress (for tableRenderProgress command)
   */
  busy?: boolean;
  rowCount?: number;

  /**
   * Set by webview when first usable table render has completed.
   */
  firstTableReady?: boolean;
}

/**
 * Lifecycle phase for staged metadata loading.
 */
export type LoadPhase = 'initial' | 'index' | 'attributes' | 'complete';

/**
 * Correlated search state.
 */
export type SearchState = 'idle' | 'running' | 'complete' | 'incomplete' | 'cancelled';

/**
 * Commands the extension posts to the rights editor webview (`postMessage`).
 */
export type ExtensionToWebviewCommand =
  | 'objectsLoaded'
  | 'loadObjectAttributesResult'
  | 'searchProgress'
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
        sessionId?: string;
        dataRevision?: number;
        phase?: LoadPhase;
        isIndexComplete?: boolean;
        objects: MetadataObject[];
        uiRights?: UiRoleRightProjection[];
        error?: string;
        /** When true, metadata/config is unavailable — Save must not write (see provider). */
        saveDisabled?: boolean;
      };
    }
  | {
      command: 'loadObjectAttributesResult';
      data: {
        sessionId: string;
        requestId: string;
        objectFullName: string;
        state: 'loaded' | 'failed';
        attributes: readonly MetadataObject[];
        error?: string;
      };
    }
  | {
      command: 'searchProgress';
      data: {
        sessionId: string;
        queryId: number;
        state: SearchState;
        processed?: number;
        total?: number;
        matchingObjectNames?: readonly string[];
        error?: string;
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
  | {
      command: 'saveError';
      data: {
        message: string;
        status?: MutationFailureStatus;
        code?: string;
        effectPossible?: boolean;
      };
    }
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

const VALID_WEBVIEW_COMMANDS = new Set<WebviewCommand>([
  'updateRight',
  'save',
  'savePayload',
  'cancel',
  'toggleFilter',
  'search',
  'filterByType',
  'tableRenderProgress',
  'loadObjectAttributes',
  'cancelSearch',
]);

/**
 * Runtime validation for incoming webview messages.
 */
export function isValidWebviewMessage(msg: unknown): msg is WebviewMessage {
  if (!msg || typeof msg !== 'object') {
    return false;
  }
  const m = msg as { command?: unknown; data?: unknown };
  if (typeof m.command !== 'string') {
    return false;
  }
  if (!VALID_WEBVIEW_COMMANDS.has(m.command as WebviewCommand)) {
    return false;
  }
  if (m.data !== undefined && (typeof m.data !== 'object' || m.data === null)) {
    return false;
  }
  return true;
}

