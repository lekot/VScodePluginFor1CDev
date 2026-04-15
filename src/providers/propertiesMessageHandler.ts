import * as vscode from 'vscode';
import { TreeNode, MetadataType } from '../models/treeNode';
import { Logger } from '../utils/logger';
import { TypeParser } from '../parsers/typeParser';
import { MESSAGES } from '../constants/messages';
import type { TypeDefinition, ReferenceTypeInfo } from '../types/typeDefinitions';
import { findTabularSectionInstanceForAttributeParent } from '../services/elementOperations';
import type { FormSelectionPayload } from '../formEditor/formMessageHandler';
import type { MetadataTreeDataProvider } from './treeDataProvider';
import type { TypeEditorProvider } from './typeEditorProvider';
import { validateProperties } from './propertiesValidation';
import type { WebviewMessage, ExtensionMessage } from './propertiesWebviewTypes';
import { CONTENT_EDITOR_COMMANDS } from './propertiesWebviewContent';

/**
 * Context passed to all message handlers — replaces class `this`.
 */
export interface MessageHandlerContext {
  currentNode: TreeNode | undefined;
  currentFormSelection: FormSelectionPayload | null;
  currentFormSelectionRevision: number;
  isSaving: boolean;
  treeDataProvider: MetadataTreeDataProvider;
  typeEditorProvider: TypeEditorProvider;
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
}

/**
 * Main dispatcher — routes incoming webview messages to handlers.
 */
export async function handleMessage(
  message: WebviewMessage,
  ctx: MessageHandlerContext
): Promise<void> {
  Logger.debug(`Received message from webview: ${message.type}`);

  try {
    switch (message.type) {
      case 'save':
        await handleSaveMessage(message, ctx);
        break;

      case 'cancel':
        await handleCancelMessage(ctx);
        break;

      case 'validate':
        handleValidateMessage(message, ctx);
        break;

      case 'editType':
        Logger.info('editType message received from webview');
        await handleEditTypeMessage(message, ctx);
        break;

      case 'editContent':
        Logger.info(`editContent message received from webview: nodeType=${message.nodeType}`);
        await handleEditContentMessage(message, ctx);
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

export async function handleEditFormSelectionTypeMessage(
  message: WebviewMessage,
  ctx: MessageHandlerContext
): Promise<void> {
  if (message.type !== 'editFormSelectionType' || !ctx.currentFormSelection || !ctx.onFormPropertyChanged) {
    return;
  }
  if (!isMatchingCurrentFormSelection(message, ctx)) {
    Logger.debug('Ignored stale form selection editFormSelectionType payload');
    return;
  }
  const key = message.propertyName || 'Type';
  const rawType = ctx.currentFormSelection.properties?.[key];
  if (rawType === undefined || rawType === null) {
    ctx.postMessage({
      type: 'error',
      message: 'Type property is empty',
    });
    return;
  }

  let typeXMLForEditor: string;
  if (typeof rawType === 'object' && rawType !== null && !Array.isArray(rawType)) {
    try {
      const typeDef = TypeParser.parseFromObject(rawType as Record<string, unknown>);
      const { TypeSerializer: typeSerializer } = await import('../serializers/typeSerializer');
      typeXMLForEditor = typeSerializer.serialize(typeDef);
    } catch (error) {
      Logger.error('Failed to serialize Type object for form selection', error);
      ctx.postMessage({ type: 'error', message: 'Failed to open type editor: invalid type data' });
      return;
    }
  } else if (typeof rawType === 'string' && rawType.includes('<')) {
    typeXMLForEditor = rawType;
  } else if (typeof rawType === 'string') {
    const typeDef = parseDisplayTypeString(rawType);
    if (!typeDef) {
      ctx.postMessage({
        type: 'error',
        message: 'Type cannot be edited: could not parse type',
      });
      return;
    }
    const { TypeSerializer: typeSerializer } = await import('../serializers/typeSerializer');
    typeXMLForEditor = typeSerializer.serialize(typeDef);
  } else {
    ctx.postMessage({
      type: 'error',
      message: 'Type property has unexpected format',
    });
    return;
  }

  try {
    const result = await ctx.typeEditorProvider.show(typeXMLForEditor, []);
    if (result === null) {
      return;
    }
    const { TypeSerializer: typeSerializer } = await import('../serializers/typeSerializer');
    const updatedTypeXML = typeSerializer.serialize(result);
    ctx.onFormPropertyChanged({
      docUri: message.docUri || ctx.currentFormSelection.docUri,
      entityType: (message.entityType as FormSelectionPayload['entityType']) ?? ctx.currentFormSelection.entityType,
      entityId: message.entityId || ctx.currentFormSelection.id,
      entityName: message.entityName || ctx.currentFormSelection.name,
      scope: 'property',
      key,
      value: updatedTypeXML,
    });
    ctx.currentFormSelection.properties[key] = updatedTypeXML;
    ctx.updateWebviewContent();
  } catch (error) {
    if (error instanceof Error && error.message === 'Type editor cancelled') {
      return;
    }
    Logger.error('Failed to edit form selection type', error);
    ctx.postMessage({
      type: 'error',
      message: `Failed to edit type: ${error instanceof Error ? error.message : 'Unknown error'}`,
    });
  }
}

export async function handleSaveMessage(
  message: WebviewMessage,
  ctx: MessageHandlerContext
): Promise<void> {
  if (message.type !== 'save') {
    return;
  }

  if (!ctx.currentNode) {
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
  const validationResult = validateProperties(message.properties, ctx.currentNode);
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
    await saveProperties(ctx.currentNode, message.properties, ctx);

    // Send success confirmation
    ctx.postMessage({ type: 'saved' });
    vscode.window.showInformationMessage(MESSAGES.SAVE_SUCCESS);

    Logger.info(`Properties saved successfully for node: ${ctx.currentNode.name}`);
  } catch (error) {
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

export async function handleEditTypeMessage(
  _message: WebviewMessage,
  ctx: MessageHandlerContext
): Promise<void> {
  void _message;
  if (!ctx.currentNode) {
    Logger.warn('Edit type attempted with no current node');
    ctx.postMessage({
      type: 'error',
      message: 'No element selected',
    });
    return;
  }

  // Get current Type value — may be object (from XML) or XML string. Editor expects XML.
  // Support both 'Type' and 'v8:Type' keys (XML parser / format may vary).
  const rawType = ctx.currentNode.properties['Type'] ?? ctx.currentNode.properties['v8:Type'];
  Logger.info(`handleEditTypeMessage: rawType type=${typeof rawType}, present=${rawType !== undefined && rawType !== null}`);
  if (rawType !== undefined && rawType !== null && typeof rawType === 'string') {
    Logger.info(`handleEditTypeMessage: rawType string preview=${(rawType as string).substring(0, 80)}`);
  }

  if (rawType === undefined || rawType === null) {
    Logger.warn('Edit type attempted but Type property is empty');
    ctx.postMessage({
      type: 'error',
      message: 'Type property is empty',
    });
    return;
  }

  let typeXMLForEditor: string;
  if (typeof rawType === 'object' && rawType !== null && !Array.isArray(rawType)) {
    try {
      const typeDef = TypeParser.parseFromObject(rawType as Record<string, unknown>);
      const { TypeSerializer: typeSerializer } = await import('../serializers/typeSerializer');
      typeXMLForEditor = typeSerializer.serialize(typeDef);
      Logger.info('handleEditTypeMessage: serialized Type from object');
    } catch (e) {
      Logger.error('Failed to serialize Type object for editor', e);
      ctx.postMessage({ type: 'error', message: 'Failed to open type editor: invalid type data' });
      return;
    }
  } else if (typeof rawType === 'string' && rawType.includes('<')) {
    typeXMLForEditor = rawType;
    Logger.info('handleEditTypeMessage: using Type as XML string');
  } else if (typeof rawType === 'string') {
    // Display string (e.g. "Number(15,0)") — try to parse and open editor
    const typeDef = parseDisplayTypeString(rawType as string);
    if (typeDef) {
      try {
        const { TypeSerializer: typeSerializer } = await import('../serializers/typeSerializer');
        typeXMLForEditor = typeSerializer.serialize(typeDef);
        Logger.info('handleEditTypeMessage: parsed display string to XML');
      } catch (e) {
        Logger.error('Failed to serialize parsed display type', e);
        ctx.postMessage({ type: 'error', message: 'Failed to open type editor' });
        return;
      }
    } else {
      Logger.warn('Edit type attempted but Type is display string and could not parse it');
      ctx.postMessage({
        type: 'error',
        message: 'Type cannot be edited: could not parse type. Re-open the attribute and try again.',
      });
      return;
    }
  } else {
    Logger.warn('Edit type attempted but Type has unexpected type');
    ctx.postMessage({ type: 'error', message: 'Type property has unexpected format' });
    return;
  }

  if (!typeXMLForEditor || typeXMLForEditor.trim() === '') {
    Logger.warn('Edit type attempted but Type serialized to empty');
    ctx.postMessage({ type: 'error', message: 'Type property is empty' });
    return;
  }

  try {
    const referenceableObjects = await ctx.treeDataProvider.getReferenceableObjectsForTypeEditor(ctx.currentNode);
    Logger.info('handleEditTypeMessage: calling typeEditorProvider.show()');
    const result = await ctx.typeEditorProvider.show(typeXMLForEditor, referenceableObjects);

    // If result not null, serialize TypeDefinition back to XML string
    if (result !== null) {
      const { TypeSerializer: typeSerializer } = await import('../serializers/typeSerializer');
      const updatedTypeXML = typeSerializer.serialize(result);

      // Do NOT update node.properties['Type'] here — that would make
      // saveProperties' changedKeys comparison see old == new and skip Type.
      // node.properties is updated after successful save in saveProperties.

      ctx.postMessage({
        type: 'typeUpdated',
        property: 'Type',
        value: updatedTypeXML,
      });

      Logger.info('Type updated successfully');
    } else {
      Logger.info('Type editing cancelled by user');
    }
  } catch (error) {
    // Cancel is represented as a rejected promise to support internal test expectations.
    // Treat it as a normal user flow and don't show an error to the user.
    if (error instanceof Error && error.message === 'Type editor cancelled') {
      Logger.info('Type editing cancelled by user');
      return;
    }
    Logger.error(`Failed to edit type: ${error}`);
    ctx.postMessage({
      type: 'error',
      message: `Failed to edit type: ${error instanceof Error ? error.message : 'Unknown error'}`,
    });
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

// ---------------------------------------------------------------------------
// Save helpers
// ---------------------------------------------------------------------------

/**
 * Save property changes to XML file.
 */
export async function saveProperties(
  node: TreeNode,
  properties: Record<string, unknown>,
  ctx: MessageHandlerContext
): Promise<void> {
  // Use parentFilePath for nested elements (Attributes), filePath for regular elements
  const targetFilePath = node.parentFilePath || node.filePath;

  if (!targetFilePath) {
    throw new Error('Cannot save properties: no file path associated with this element');
  }

  try {
    // Import XMLWriter dynamically to avoid circular dependencies
    const { XMLWriter: xmlWriter } = await import('../utils/XMLWriter');

    // Write properties to XML file with error handling
    try {
      ctx.setIsSaving(true);
      // For nested elements (Attributes, TabularSections, etc.), use specialized method
      if (node.parentFilePath) {
        // Track which properties actually changed by comparing with last saved state
        const changedKeys = node.properties
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

              // Special handling for Type property:
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
                  Logger.info(`  Type: skipping (old is object, new is display string)`);
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

        await xmlWriter.writeNestedElementProperties(
          targetFilePath,
          node.type,
          node.name,
          properties,
          changedKeys,
          scopedTabularSectionName ? { scopedTabularSectionName } : undefined
        );
      } else {
        // For root elements, use standard write method
        await xmlWriter.writeProperties(targetFilePath, properties);
      }
    } catch (writeError) {
      ctx.setIsSaving(false);
      // Log detailed error to extension output channel
      Logger.error(`Failed to write properties to ${targetFilePath}`, writeError);

      const { MESSAGES: msgs } = await import('../constants/messages');
      const errorMessage = writeError instanceof Error ? writeError.message : String(writeError);
      vscode.window.showErrorMessage(
        `${msgs.SAVE_FAILED_RESTORED} ${errorMessage}`,
        'Show Output'
      ).then(selection => {
        if (selection === 'Show Output') {
          Logger.show();
        }
      });
      // Rollback UI to last saved state
      if (ctx.currentNode) {
        ctx.postMessage({ type: 'update', node: ctx.currentNode });
      }
      // Re-throw to be handled by caller
      throw new Error(`Failed to write properties to file: ${targetFilePath}. ${errorMessage}`);
    }

    // Reset flag after successful write — watcher debounce (400ms) will fire after this
    // Use a small delay to ensure the watcher event is suppressed
    setTimeout(() => { ctx.setIsSaving(false); }, 600);

    // Update TreeNode.properties with new values after successful save
    node.properties = { ...properties };

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

/**
 * Parse display-only type string (e.g. "Number(15,0)", "String(50)") into TypeDefinition
 * so the type editor can open when the node only has a formatted string.
 */
export function parseDisplayTypeString(display: string): TypeDefinition | null {
  const s = display.trim();
  if (!s || s === 'Not set') {return null;}
  const numMatch = s.match(/^Number\((\d+),(\d+)\)$/);
  if (numMatch) {
    return {
      category: 'primitive',
      types: [{
        kind: 'number',
        qualifiers: { digits: parseInt(numMatch[1], 10), fractionDigits: parseInt(numMatch[2], 10), allowedSign: 'Any' },
      }],
    };
  }
  const strMatch = s.match(/^String\((\d+)\)$/);
  if (strMatch) {
    return {
      category: 'primitive',
      types: [{ kind: 'string', qualifiers: { length: parseInt(strMatch[1], 10), allowedLength: 'Variable' } }],
    };
  }
  if (/^Boolean$/i.test(s)) {
    return { category: 'primitive', types: [{ kind: 'boolean' }] };
  }
  if (/^Date$/i.test(s)) {
    return { category: 'primitive', types: [{ kind: 'date', qualifiers: { dateFractions: 'Date' } }] };
  }
  if (/^DateTime$/i.test(s)) {
    return { category: 'primitive', types: [{ kind: 'date', qualifiers: { dateFractions: 'DateTime' } }] };
  }
  if (/^Time$/i.test(s)) {
    return { category: 'primitive', types: [{ kind: 'date', qualifiers: { dateFractions: 'Time' } }] };
  }
  const refMatch = s.match(/^(CatalogRef|DocumentRef|EnumRef|ChartOfCharacteristicTypesRef|ChartOfAccountsRef|ChartOfCalculationTypesRef|DefinedType)\.(.+)$/);
  if (refMatch) {
    return {
      category: 'reference',
      types: [{
        kind: 'reference',
        referenceType: { referenceKind: refMatch[1] as ReferenceTypeInfo['referenceKind'], objectName: refMatch[2].trim() },
      }],
    };
  }
  return null;
}

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

export function isMatchingCurrentFormSelection(
  message:
    | Extract<WebviewMessage, { type: 'propertyChanged' }>
    | Extract<WebviewMessage, { type: 'editFormSelectionType' }>,
  ctx: MessageHandlerContext
): boolean {
  if (!ctx.currentFormSelection) {
    return false;
  }
  const revision = Number(message.selectionRevision ?? '');
  if (!Number.isFinite(revision) || revision !== ctx.currentFormSelectionRevision) {
    return false;
  }
  if (!message.docUri || message.docUri !== ctx.currentFormSelection.docUri) {
    return false;
  }
  if (message.entityType && message.entityType !== ctx.currentFormSelection.entityType) {
    return false;
  }
  const messageEntityId = message.entityId ?? message.entityName ?? '';
  const selectionEntityId = ctx.currentFormSelection.id ?? ctx.currentFormSelection.name ?? '';
  if (messageEntityId && selectionEntityId && messageEntityId !== selectionEntityId) {
    return false;
  }
  return true;
}

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
