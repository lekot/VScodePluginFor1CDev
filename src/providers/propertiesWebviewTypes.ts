import type { FormSelectionPayload } from '../formEditor/formMessageHandler';

/**
 * Message types sent from webview to extension (discriminated union for type safety)
 */
export type WebviewMessage =
  | { type: 'save'; properties: Record<string, unknown> }
  | { type: 'cancel' }
  | { type: 'validate'; properties: Record<string, unknown> }
  | {
      type: 'propertyChanged';
      propertyName: string;
      value: unknown;
      scope?: 'property' | 'event';
      selectionRevision?: string;
      docUri?: string;
      entityType?: FormSelectionPayload['entityType'];
      entityId?: string;
      entityName?: string;
    }
  | {
      type: 'editFormSelectionType';
      propertyName: string;
      selectionRevision?: string;
      docUri?: string;
      entityType?: FormSelectionPayload['entityType'];
      entityId?: string;
      entityName?: string;
    }
  | { type: 'editType'; propertyName: string }
  | { type: 'editContent'; nodeType: string }
  | {
      type: 'gotoEventHandler';
      handlerName: string;
      docUri: string;
    }
  | {
      type: 'createEventHandler';
      eventName: string;
      elementId: string;
      elementName: string;
      elementTag: string;
      docUri: string;
    };

/**
 * Message types sent from extension to webview (discriminated union for type safety)
 */
export type ExtensionMessage =
  | { type: 'update'; node: import('../models/treeNode').TreeNode }
  | { type: 'saved' }
  | { type: 'error'; message: string }
  | { type: 'validationError'; errors: Record<string, string> }
  | { type: 'typeUpdated'; property: string; value: string };

/**
 * Validation result
 */
export interface ValidationResult {
  valid: boolean;
  errors: Record<string, string>;
}

/**
 * Type guard for webview messages
 */
export function isValidWebviewMessage(msg: unknown): msg is WebviewMessage {
  if (!msg || typeof msg !== 'object') {return false;}
  const m = msg as { type?: unknown };
  if (typeof m.type !== 'string') {return false;}

  const validTypes = ['save', 'cancel', 'validate', 'propertyChanged', 'editType', 'editContent', 'editFormSelectionType', 'gotoEventHandler', 'createEventHandler'];
  return validTypes.includes(m.type);
}
