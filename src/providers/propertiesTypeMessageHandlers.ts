import { Logger } from '../utils/logger';
import { TypeParser } from '../parsers/typeParser';
import type { TypeDefinition, ReferenceTypeInfo } from '../types/typeDefinitions';
import type { FormSelectionPayload } from '../formEditor/formMessageHandler';
import type { WebviewMessage } from './propertiesWebviewTypes';
import type { MessageHandlerContext } from './propertiesMessageHandler';

function isContextCurrent(ctx: MessageHandlerContext): boolean {
  return ctx.isCurrentSession?.() ?? true;
}
export async function handleEditFormSelectionTypeMessage(
  message: WebviewMessage,
  ctx: MessageHandlerContext
): Promise<void> {
  if (message.type !== 'editFormSelectionType' || !ctx.currentFormSelection || !ctx.onFormPropertyChanged || !isContextCurrent(ctx)) {
    return;
  }
  if (!isMatchingCurrentFormSelection(message, ctx)) {
    Logger.debug('Ignored stale form selection editFormSelectionType payload');
    return;
  }
  const targetFormSelection = ctx.currentFormSelection;
  const targetRevision = ctx.currentFormSelectionRevision;
  const key = message.propertyName || 'Type';
  const rawType = targetFormSelection.properties?.[key];
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
      if (!isContextCurrent(ctx)) {
        return;
      }
      typeXMLForEditor = typeSerializer.serialize(typeDef);
    } catch (error) {
      if (!isContextCurrent(ctx)) {
        return;
      }
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
    if (!isContextCurrent(ctx)) {
      return;
    }
    typeXMLForEditor = typeSerializer.serialize(typeDef);
  } else {
    ctx.postMessage({
      type: 'error',
      message: 'Type property has unexpected format',
    });
    return;
  }

  try {
    if (!isContextCurrent(ctx)) {
      return;
    }
    const result = await ctx.typeEditorProvider.show(typeXMLForEditor, []);
    if (!isContextCurrent(ctx) || result === null) {
      return;
    }
    if (
      ctx.currentFormSelection !== targetFormSelection ||
      ctx.currentFormSelectionRevision !== targetRevision
    ) {
      Logger.warn(
        'handleEditFormSelectionTypeMessage: form selection changed while editing type; discarding result'
      );
      return;
    }
    const { TypeSerializer: typeSerializer } = await import('../serializers/typeSerializer');
    if (!isContextCurrent(ctx) ||
        ctx.currentFormSelection !== targetFormSelection ||
        ctx.currentFormSelectionRevision !== targetRevision) {
      return;
    }
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
    if (!isContextCurrent(ctx)) {
      return;
    }
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


export async function handleEditTypeMessage(
  message: WebviewMessage,
  ctx: MessageHandlerContext
): Promise<void> {
  const targetNode = ctx.currentNode;
  if (!targetNode) {
    Logger.warn('Edit type attempted with no current node');
    ctx.postMessage({
      type: 'error',
      message: 'No element selected',
    });
    return;
  }
  const targetNodeId = message.nodeId || targetNode.id;
  const targetSessionToken = message.sessionToken || ctx.currentSessionToken;
  const isCurrentTarget = (): boolean =>
    isContextCurrent(ctx) &&
    ctx.currentNode === targetNode &&
    ctx.currentNode?.id === targetNodeId &&
    !(ctx.currentSessionToken && targetSessionToken && ctx.currentSessionToken !== targetSessionToken);
  if (!isCurrentTarget()) {
    return;
  }

  // Get current Type value — may be object (from XML) or XML string. Editor expects XML.
  // Support both 'Type' and 'v8:Type' keys (XML parser / format may vary).
  const rawType = targetNode.properties['Type'] ?? targetNode.properties['v8:Type'];
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
      if (!isCurrentTarget()) {
        return;
      }
      typeXMLForEditor = typeSerializer.serialize(typeDef);
      Logger.info('handleEditTypeMessage: serialized Type from object');
    } catch (e) {
      if (!isCurrentTarget()) {
        return;
      }
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
        if (!isCurrentTarget()) {
          return;
        }
        typeXMLForEditor = typeSerializer.serialize(typeDef);
        Logger.info('handleEditTypeMessage: parsed display string to XML');
      } catch (e) {
        if (!isCurrentTarget()) {
          return;
        }
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
    const referenceableObjects = await ctx.treeDataProvider.getReferenceableObjectsForTypeEditor(targetNode);

    if (!isCurrentTarget()) {
      Logger.warn(
        `handleEditTypeMessage: target node changed before opening type editor (${targetNodeId} -> ${ctx.currentNode?.id}); aborting`
      );
      return;
    }

    Logger.info('handleEditTypeMessage: calling typeEditorProvider.show()');
    const result = await ctx.typeEditorProvider.show(typeXMLForEditor, referenceableObjects);

    if (!isCurrentTarget()) {
      Logger.warn(
        `handleEditTypeMessage: target node changed while editing type (${targetNodeId} -> ${ctx.currentNode?.id}); discarding result`
      );
      return;
    }

    // If result not null, serialize TypeDefinition back to XML string
    if (result !== null) {
      const { TypeSerializer: typeSerializer } = await import('../serializers/typeSerializer');
      if (!isCurrentTarget()) {
        return;
      }
      const updatedTypeXML = typeSerializer.serialize(result);

      // Do NOT update node.properties here — that would make
      // saveProperties' changedKeys comparison see old == new and skip the property.
      // node.properties is updated after successful save in saveProperties.

      ctx.postMessage({
        type: 'typeUpdated',
        property: 'Type',
        value: updatedTypeXML,
        nodeId: targetNodeId,
        sessionToken: targetSessionToken,
      });

      Logger.info('Type updated successfully');
    } else {
      Logger.info('Type editing cancelled by user');
    }
  } catch (error) {
    if (!isCurrentTarget()) {
      return;
    }
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

export async function handleEditSourceMessage(
  message: WebviewMessage,
  ctx: MessageHandlerContext
): Promise<void> {
  const targetNode = ctx.currentNode;
  if (!targetNode) {
    Logger.warn('Edit source attempted with no current node');
    ctx.postMessage({ type: 'error', message: 'No element selected' });
    return;
  }

  const targetNodeId = message.nodeId || targetNode.id;
  const targetSessionToken = message.sessionToken || ctx.currentSessionToken;
  const isCurrentTarget = (): boolean =>
    isContextCurrent(ctx) &&
    ctx.currentNode === targetNode &&
    ctx.currentNode?.id === targetNodeId &&
    !(ctx.currentSessionToken && targetSessionToken && ctx.currentSessionToken !== targetSessionToken);
  if (!isCurrentTarget()) {
    return;
  }

  const rawSource = targetNode.properties['Source'];

  let sourceXML: string;
  if (typeof rawSource === 'object' && rawSource !== null && !Array.isArray(rawSource)) {
    try {
      const { ObjectTypeParser } = await import('../parsers/objectTypeParser');
      const { ObjectTypeSerializer } = await import('../serializers/objectTypeSerializer');
      if (!isCurrentTarget()) {
        return;
      }
      const def = ObjectTypeParser.parseFromObject(rawSource as Record<string, unknown>);
      sourceXML = ObjectTypeSerializer.serialize(def);
    } catch (e) {
      if (!isCurrentTarget()) {
        return;
      }
      Logger.error('Failed to serialize Source object for editor', e);
      ctx.postMessage({ type: 'error', message: 'Failed to open source editor: invalid source data' });
      return;
    }
  } else if (typeof rawSource === 'string' && rawSource.includes('<')) {
    sourceXML = rawSource;
  } else {
    sourceXML = '';
  }

  try {
    const objectableGroups = await ctx.treeDataProvider.getObjectableObjectsForEditor(targetNode);

    if (!isCurrentTarget()) {
      Logger.warn(
        `handleEditSourceMessage: target node changed before opening source editor (${targetNodeId} -> ${ctx.currentNode?.id}); aborting`
      );
      return;
    }

    const result = await ctx.objectTypeEditorProvider.show(sourceXML, objectableGroups);

    if (!isCurrentTarget()) {
      Logger.warn(
        `handleEditSourceMessage: target node changed while editing source (${targetNodeId} -> ${ctx.currentNode?.id}); discarding result`
      );
      return;
    }

    if (result !== null) {
      const { ObjectTypeSerializer } = await import('../serializers/objectTypeSerializer');
      if (!isCurrentTarget()) {
        return;
      }
      const updatedSourceXML = ObjectTypeSerializer.serialize(result);
      ctx.postMessage({
        type: 'sourceUpdated',
        property: 'Source',
        value: updatedSourceXML,
        nodeId: targetNodeId,
        sessionToken: targetSessionToken,
      });
      Logger.info('Source updated successfully');
    } else {
      Logger.info('Source editing cancelled by user');
    }
  } catch (error) {
    if (!isCurrentTarget()) {
      return;
    }
    Logger.error(`Failed to edit source: ${error}`);
    ctx.postMessage({
      type: 'error',
      message: `Failed to edit source: ${error instanceof Error ? error.message : 'Unknown error'}`,
    });
  }
}


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
        qualifiers: { digits: Number.parseInt(numMatch[1], 10), fractionDigits: Number.parseInt(numMatch[2], 10), allowedSign: 'Any' },
      }],
    };
  }
  const strMatch = s.match(/^String\((\d+)\)$/);
  if (strMatch) {
    return {
      category: 'primitive',
      types: [{ kind: 'string', qualifiers: { length: Number.parseInt(strMatch[1], 10), allowedLength: 'Variable' } }],
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
