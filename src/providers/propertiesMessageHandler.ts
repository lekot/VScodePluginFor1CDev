import * as vscode from 'vscode';
import { TreeNode, MetadataType } from '../models/treeNode';
import { Logger } from '../utils/logger';
import { MESSAGES } from '../constants/messages';
import { findTabularSectionInstanceForAttributeParent } from '../services/elementOperations';
import type { FormSelectionPayload } from '../formEditor/formMessageHandler';
import type { MetadataTreeDataProvider } from './treeDataProvider';
import type { TypeEditorProvider } from './typeEditorProvider';
import type { ObjectTypeEditorProvider } from './objectTypeEditorProvider';
import { validateProperties } from './propertiesValidation';
import type { WebviewMessage, ExtensionMessage } from './propertiesWebviewTypes';
import { CONTENT_EDITOR_COMMANDS } from './propertiesWebviewContent';
import { runConfigurationMutation } from '../services/configurationSession/configurationMutationGateway';
import { assertCfeGenericMutationAllowed } from '../extensionSupport/cfeProject/mutationPolicy';
import { isContainerNode } from '../utils/treeNormalization';
import {
  getIdentitySensitiveMetadataPropertyNames,
  IDENTITY_PROPERTY_EDIT_ERROR,
} from '../domain/metadataPropertyClassifier';
import { handleGotoHandlerMessage } from './eventSubscriptionHandlerNavigation';
import {
  handleEditFormSelectionTypeMessage,
  handleEditSourceMessage,
  handleEditTypeMessage,
  isMatchingCurrentFormSelection,
  parseDisplayTypeString,
} from './propertiesTypeMessageHandlers';
export {
  handleEditFormSelectionTypeMessage,
  handleEditSourceMessage,
  handleEditTypeMessage,
  isMatchingCurrentFormSelection,
  parseDisplayTypeString,
};

/**
 * Context passed to all message handlers — replaces class `this`.
 */
export interface MessageHandlerContext {
  currentNode: TreeNode | undefined;
  currentFormSelection: FormSelectionPayload | null;
  currentFormSelectionRevision: number;
  currentSessionToken?: string;
  isCurrentSession?: () => boolean;
  isSaving: boolean;
  treeDataProvider: MetadataTreeDataProvider;
  typeEditorProvider: TypeEditorProvider;
  objectTypeEditorProvider: ObjectTypeEditorProvider;
  onFormPropertyChanged?: (payload: {
    docUri: string;
    entityType: FormSelectionPayload['entityType'];
    entityId?: string;
    entityName?: string;
    scope: 'property' | 'event';
    key: string;
    value: unknown;
  }) => void;
  onGotoEventHandler?: (payload: { docUri: string; handlerName: string }) => void;
  onCreateEventHandler?: (payload: {
    docUri: string;
    elementId: string;
    elementName: string;
    elementTag: string;
    eventName: string;
  }) => void;
  postMessage: (message: ExtensionMessage) => void;
  updateWebviewContent: () => void;
  setIsSaving: (value: boolean) => void;
  beginSave?: () => number | undefined;
  endSave?: (generation: number, delayMs?: number) => void;
  setIsDirty?: (
    isDirty: boolean,
    properties?: Record<string, unknown>,
    token?: { nodeId?: string; sessionToken?: string }
  ) => void;
}

function isContextCurrent(ctx: MessageHandlerContext): boolean {
  return ctx.isCurrentSession?.() ?? true;
}

/**
 * Main dispatcher — routes incoming webview messages to handlers.
 */
export async function handleMessage(
  message: WebviewMessage,
  ctx: MessageHandlerContext
): Promise<void> {
  Logger.debug(`Received message from webview: ${message.type}`);

  if (message.nodeId && ctx.currentNode && message.nodeId !== ctx.currentNode.id) {
    Logger.warn(
      `Ignoring message ${message.type} from outdated node ${message.nodeId} (current: ${ctx.currentNode.id})`
    );
    return;
  }

  try {
    switch (message.type) {
      case 'save':
        await handleSaveMessage(message, ctx);
        break;

      case 'cancel':
        await handleCancelMessage(ctx);
        break;

      case 'dirtyChange':
        ctx.setIsDirty?.(message.isDirty, message.properties, {
          nodeId: message.nodeId,
          sessionToken: message.sessionToken,
        });
        break;

      case 'validate':
        handleValidateMessage(message, ctx);
        break;

      case 'editType':
        Logger.info('editType message received from webview');
        await handleEditTypeMessage(message, ctx);
        break;

      case 'editSource':
        Logger.info('editSource message received from webview');
        await handleEditSourceMessage(message, ctx);
        break;

      case 'editContent':
        Logger.info(`editContent message received from webview: nodeType=${message.nodeType}`);
        await handleEditContentMessage(message, ctx);
        break;

      case 'renameElement':
        await handleRenameElementMessage(ctx);
        break;

      case 'propertyChanged':
        handleFormSelectionPropertyChanged(message, ctx);
        break;

      case 'editFormSelectionType':
        await handleEditFormSelectionTypeMessage(message, ctx);
        break;

      case 'gotoEventHandler':
        handleGotoEventHandler(message, ctx);
        break;

      case 'createEventHandler':
        handleCreateEventHandler(message, ctx);
        break;

      case 'gotoHandler':
        await handleGotoHandlerMessage(message, ctx);
        break;

      case 'openPictureFile':
        if (typeof message.filePath === 'string' && message.filePath) {
          await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(message.filePath));
        }
        break;

      default:
        Logger.warn(`Unknown message type: ${message && typeof message === 'object' && 'type' in message ? String((message as WebviewMessage).type) : 'unknown'}`);
    }
  } catch (error) {
    Logger.error(`Error handling message: ${error}`);
    ctx.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : 'Unknown error occurred',
    });
  }
}

// ---------------------------------------------------------------------------
// Individual handlers
// ---------------------------------------------------------------------------

export function handleFormSelectionPropertyChanged(
  message: WebviewMessage,
  ctx: MessageHandlerContext
): void {
  if (message.type !== 'propertyChanged' || !ctx.currentFormSelection) {
    return;
  }
  if (!isMatchingCurrentFormSelection(message, ctx)) {
    Logger.debug('Ignored stale form selection propertyChanged payload');
    return;
  }
  const key = message.propertyName;
  const scope = message.scope === 'event' ? 'event' : 'property';
  if (!key || !ctx.onFormPropertyChanged) {
    return;
  }
  ctx.onFormPropertyChanged({
    docUri: message.docUri || ctx.currentFormSelection.docUri,
    entityType: (message.entityType as FormSelectionPayload['entityType']) ?? ctx.currentFormSelection.entityType,
    entityId: message.entityId || ctx.currentFormSelection.id,
    entityName: message.entityName || ctx.currentFormSelection.name,
    scope,
    key,
    value: message.value,
  });
}

export async function handleSaveMessage(
  message: WebviewMessage,
  ctx: MessageHandlerContext
): Promise<void> {
  if (message.type !== 'save') {
    return;
  }

  const targetNode = ctx.currentNode;
  if (!targetNode) {
    Logger.warn('Save attempted with no current node');
    ctx.postMessage({
      type: 'error',
      message: 'No element selected',
    });
    return;
  }

  if (!message.properties) {
    Logger.warn('Save attempted with no properties');
    ctx.postMessage({
      type: 'error',
      message: 'No properties to save',
    });
    return;
  }

  // Validate properties
  const validationResult = validateProperties(message.properties, targetNode);
  if (!validationResult.valid) {
    Logger.info('Validation failed', validationResult.errors);
    ctx.postMessage({
      type: 'validationError',
      errors: validationResult.errors,
    });
    vscode.window.showWarningMessage(MESSAGES.VALIDATION_ERROR_CHECK_PANEL);
    return;
  }

  // Save properties
  try {
    await saveProperties(targetNode, message.properties, ctx);

    if (!isContextCurrent(ctx)) {
      return;
    }

    ctx.setIsDirty?.(false);

    // Send success confirmation
    ctx.postMessage({ type: 'saved' });
    if (isContextCurrent(ctx)) {
      vscode.window.showInformationMessage(MESSAGES.SAVE_SUCCESS);
    }

    Logger.info(`Properties saved successfully for node: ${targetNode.name}`);
  } catch (error) {
    if (!isContextCurrent(ctx)) {
      return;
    }
    Logger.error(`Failed to save properties: ${error}`);
    const errorMessage = error instanceof Error ? error.message : String(error);
    // Write errors are already handled in saveProperties (notification + UI rollback); avoid duplicate alert in webview
    const isWriteError = /Failed to write|Unable to write/i.test(errorMessage);
    if (!isWriteError) {
      ctx.postMessage({
        type: 'error',
        message: `Failed to save properties: ${errorMessage}`,
      });
    }
  }
}

export async function handleCancelMessage(ctx: MessageHandlerContext): Promise<void> {
  if (!ctx.currentNode) {
    Logger.warn('Cancel attempted with no current node');
    return;
  }

  ctx.setIsDirty?.(false);

  // Reload original properties by sending update message
  ctx.postMessage({
    type: 'update',
    node: ctx.currentNode,
  });

  Logger.info(`Properties reset to original for node: ${ctx.currentNode.name}`);
}

export function handleValidateMessage(
  message: WebviewMessage,
  ctx: MessageHandlerContext
): void {
  if (message.type === 'validate') {
    if (!message.properties) {
      return;
    }

    const validationResult = validateProperties(message.properties, ctx.currentNode);
    if (!validationResult.valid) {
      ctx.postMessage({
        type: 'validationError',
        errors: validationResult.errors,
      });
    }
  }
}

export async function handleEditContentMessage(
  message: WebviewMessage,
  ctx: MessageHandlerContext
): Promise<void> {
  if (message.type !== 'editContent') {
    return;
  }
  const command = CONTENT_EDITOR_COMMANDS.get(message.nodeType);
  if (!command) {
    Logger.warn(`handleEditContentMessage: no command mapped for nodeType="${message.nodeType}"`);
    return;
  }
  await vscode.commands.executeCommand(command, ctx.currentNode);
}

/** Delegate identity changes to the already registered element rename command. */
export async function handleRenameElementMessage(ctx: MessageHandlerContext): Promise<void> {
  if (!ctx.currentNode
    || ctx.currentNode.type === MetadataType.Configuration
    || isContainerNode(ctx.currentNode)
    || !(ctx.currentNode.parentFilePath || ctx.currentNode.filePath)) {
    return;
  }
  await vscode.commands.executeCommand('1c-metadata-tree.renameElement', ctx.currentNode);
}

// ---------------------------------------------------------------------------
// Save helpers
// ---------------------------------------------------------------------------

let localPropertiesSaveGen = 0;

/**
 * Save property changes to XML file.
 */
export async function saveProperties(
  node: TreeNode,
  properties: Record<string, unknown>,
  ctx: MessageHandlerContext
): Promise<void> {
  const isCurrentSession = (): boolean => isContextCurrent(ctx);
  if (getIdentitySensitiveMetadataPropertyNames(properties).length > 0) {
    throw new Error(IDENTITY_PROPERTY_EDIT_ERROR);
  }

  // Use parentFilePath for nested elements (Attributes), filePath for regular elements
  const targetFilePath = node.parentFilePath || node.filePath;

  if (!targetFilePath) {
    throw new Error('Cannot save properties: no file path associated with this element');
  }
  await assertCfeGenericMutationAllowed(targetFilePath, 'update');

  try {
    // Import XMLWriter dynamically to avoid circular dependencies
    const { XMLWriter: xmlWriter } = await import('../utils/XMLWriter');

    // Write properties to XML file with error handling
    let changedKeys: string[] | undefined;
    const saveGen = ctx.beginSave ? ctx.beginSave() : ++localPropertiesSaveGen;
    try {
      if (!ctx.beginSave) {
        ctx.setIsSaving(true);
      }
      // For nested elements (Attributes, TabularSections, etc.), use specialized method
      if (node.parentFilePath) {
        // Track which properties actually changed by comparing with last saved state
        changedKeys = node.properties
          ? Object.keys(properties).filter(key => {
              const newValue = properties[key];
              const oldValue = (node.properties as Record<string, unknown>)?.[key];

              // Debug: log comparison for each property
              const newType = typeof newValue;
              const oldType = typeof oldValue;
              const isEqual = newValue === oldValue;

              if (!isEqual) {
                Logger.info(`  Property "${key}" changed: old=${JSON.stringify(oldValue)} (${oldType}), new=${JSON.stringify(newValue)} (${newType})`);
              }

              // Special handling for Source property (EventSubscription):
              // If new value is an XML string (starts with '<'), it was explicitly changed via source editor
              if (key === 'Source') {
                if (typeof newValue === 'string' && newValue.trim().startsWith('<')) {
                  return true;
                }
                if (typeof oldValue === 'object' && oldValue !== null && typeof newValue === 'string' && !newValue.trim().startsWith('<')) {
                  Logger.info(`  ${key}: skipping (old is object, new is display string)`);
                  return false;
                }
              }

              // Special handling for Type property (TypeDescription):
              // If old value is an object (structured XML) and new value is a string (display representation),
              // they are considered equal (not changed) - don't include Type in changedKeys
              if (key === 'Type') {
                // If new is XML string (starts with '<'), it was explicitly changed via type editor
                if (typeof newValue === 'string' && newValue.trim().startsWith('<')) {
                  return true;
                }
                // If both are strings, compare directly
                if (typeof newValue === 'string' && typeof oldValue === 'string') {
                  return newValue !== oldValue;
                }
                // If old is object and new is a plain string (not XML), it's a display representation
                if (typeof oldValue === 'object' && oldValue !== null && typeof newValue === 'string') {
                  Logger.info(`  ${key}: skipping (old is object, new is display string)`);
                  return false;
                }
              }

              // Special handling for xsi:nil properties (empty values with xsi:nil="true" attribute)
              // These should not be considered changed unless explicitly modified
              if (isXsiNilValue(oldValue) && isXsiNilValue(newValue)) {
                Logger.info(`  Property "${key}": both are xsi:nil, skipping (old=${JSON.stringify(oldValue)}, new=${JSON.stringify(newValue)})`);
                return false; // Not changed
              }

              // Deep comparison for objects (e.g., other complex structures)
              if (typeof newValue === 'object' && newValue !== null &&
                  typeof oldValue === 'object' && oldValue !== null) {
                const oldJson = JSON.stringify(oldValue);
                const newJson = JSON.stringify(newValue);
                const isDifferent = oldJson !== newJson;
                if (isDifferent) {
                  Logger.info(`  Property "${key}": objects differ (old=${oldJson}, new=${newJson})`);
                }
                return isDifferent;
              }

              return newValue !== oldValue;
            })
          : undefined; // If no previous state, pass undefined (write all properties)

        // Debug logging
        Logger.info(`Saving properties for ${node.name}:`);
        Logger.info(`  Properties keys: ${Object.keys(properties).join(', ')}`);
        Logger.info(`  Changed keys: ${changedKeys ? changedKeys.join(', ') : 'undefined (all)'}`);

        const scopedTabularSectionName =
          node.type === MetadataType.Attribute && node.parent
            ? findTabularSectionInstanceForAttributeParent(node.parent)?.name
            : undefined;
        const nestedWriteOptions = node.nestedPath || scopedTabularSectionName
          ? {
              ...(node.nestedPath ? { nestedPath: node.nestedPath } : {}),
              ...(scopedTabularSectionName ? { scopedTabularSectionName } : {}),
            }
          : undefined;

        await runConfigurationMutation(targetFilePath, 'ui.properties.saveNested', () =>
          xmlWriter.writeNestedElementProperties(
            targetFilePath,
            node.type,
            node.name,
            properties,
            changedKeys,
            nestedWriteOptions
          ));
      } else {
        // For root elements, use standard write method
        await runConfigurationMutation(targetFilePath, 'ui.properties.save', () =>
          xmlWriter.writeProperties(targetFilePath, properties));
      }
    } catch (writeError) {
      if (saveGen !== undefined && ctx.endSave) {
        ctx.endSave(saveGen, 0);
      } else if (saveGen !== undefined && !ctx.beginSave && localPropertiesSaveGen === saveGen) {
        ctx.setIsSaving(false);
      }
      // Log detailed error to extension output channel
      Logger.error(`Failed to write properties to ${targetFilePath}`, writeError);

      const errorMessage = writeError instanceof Error ? writeError.message : String(writeError);
      if (isCurrentSession()) {
        const { MESSAGES: msgs } = await import('../constants/messages');
        if (isCurrentSession()) {
          vscode.window.showErrorMessage(
            `${msgs.SAVE_FAILED_RESTORED} ${errorMessage}`,
            'Show Output'
          ).then(selection => {
            if (selection === 'Show Output' && isCurrentSession()) {
              Logger.show();
            }
          });
        }
      }
      // Rollback UI to last saved state
      if (isCurrentSession() && ctx.currentNode) {
        ctx.postMessage({ type: 'update', node: ctx.currentNode });
      }
      // Re-throw to be handled by caller
      throw new Error(`Failed to write properties to file: ${targetFilePath}. ${errorMessage}`);
    }

    // Reset flag after successful write — watcher debounce (400ms) will fire after this
    // Use a small delay to ensure the watcher event is suppressed
    if (saveGen !== undefined && ctx.endSave) {
      ctx.endSave(saveGen, 600);
    } else if (saveGen !== undefined && !ctx.beginSave) {
      setTimeout(() => {
        if (localPropertiesSaveGen === saveGen) {
          ctx.setIsSaving(false);
        }
      }, 600);
    }

    // Update TreeNode.properties with new values after successful save.
    // Preserve structured Type/Source objects when webview passes unchanged display strings.
    const updatedProperties: Record<string, unknown> = { ...(node.properties ?? {}) };
    if (changedKeys) {
      for (const key of changedKeys) {
        updatedProperties[key] = properties[key];
      }
    } else {
      for (const [key, val] of Object.entries(properties)) {
        const oldValue = updatedProperties[key];
        if (
          (key === 'Type' || key === 'Source') &&
          typeof oldValue === 'object' &&
          oldValue !== null &&
          typeof val === 'string' &&
          !val.trim().startsWith('<')
        ) {
          continue;
        }
        updatedProperties[key] = val;
      }
    }
    node.properties = updatedProperties;

    // Refresh tree view to reflect changes
    ctx.treeDataProvider.refresh();

    Logger.info(`Properties saved successfully to: ${targetFilePath}`);
  } catch (error) {
    // Log detailed error to extension output channel
    Logger.error(`Failed to save properties to ${targetFilePath}`, error);
    throw error; // Re-throw to be handled by caller
  }
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

export function handleGotoEventHandler(
  message: WebviewMessage,
  ctx: MessageHandlerContext
): void {
  if (message.type !== 'gotoEventHandler') {
    return;
  }
  if (!ctx.onGotoEventHandler) {
    Logger.warn('gotoEventHandler: no callback registered');
    return;
  }
  ctx.onGotoEventHandler({ docUri: message.docUri, handlerName: message.handlerName });
}

export function handleCreateEventHandler(
  message: WebviewMessage,
  ctx: MessageHandlerContext
): void {
  if (message.type !== 'createEventHandler') {
    return;
  }
  if (!ctx.onCreateEventHandler) {
    Logger.warn('createEventHandler: no callback registered');
    return;
  }
  ctx.onCreateEventHandler({
    docUri: message.docUri,
    elementId: message.elementId,
    elementName: message.elementName,
    elementTag: message.elementTag,
    eventName: message.eventName,
  });
}

// ---------------------------------------------------------------------------
// Handler navigation
// ---------------------------------------------------------------------------

export {
  handleGotoHandlerMessage,
  parseHandlerString,
  type HandlerParts,
} from './eventSubscriptionHandlerNavigation';

/**
 * Check if a value represents an xsi:nil="true" empty element
 * These are parsed as arrays with a single object containing @_xsi:nil attribute
 */
export function isXsiNilValue(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 1) {
    return false;
  }

  const item = value[0];
  if (!item || typeof item !== 'object') {
    return false;
  }

  const obj = item as Record<string, unknown>;
  // Check if it has xsi:nil="true" attribute and no other meaningful content
  return '@_xsi:nil' in obj && obj['@_xsi:nil'] === 'true' && !('#text' in obj);
}
