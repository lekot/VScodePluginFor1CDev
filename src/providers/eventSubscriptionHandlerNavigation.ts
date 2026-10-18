import * as vscode from 'vscode';
import * as path from 'path';
import { MetadataType } from '../models/treeNode';
import { Logger } from '../utils/logger';
import { getStandardModuleFileName, type StandardModuleKind } from '../constants/metadataModuleDescriptors';
import { MetadataTypeMapper } from '../utils/metadataTypeMapper';
import type { MessageHandlerContext } from './propertiesMessageHandler';
import type { WebviewMessage } from './propertiesWebviewTypes';

/**
 * Module name aliases for EventSubscription Handler paths.
 * Maps the module name segment used in Handler to the actual BSL file name.
 */
const HANDLER_MODULE_FILE_MAP: Record<string, string> = {
  // Event handlers can refer to the legacy alias even though it is not a standard module kind.
  ObjectManagerModule: 'ObjectManagerModule.bsl',
};

/**
 * Object type prefixes that indicate modules living under <ObjectFolder>/Ext/<ModuleName>.bsl.
 */
const OBJECT_TYPE_PREFIXES = new Set([
  'Catalogs', 'Documents', 'ChartsOfCharacteristicTypes', 'ChartsOfAccounts',
  'ChartsOfCalculationTypes', 'BusinessProcesses', 'Tasks', 'ExchangePlans',
  'InformationRegisters', 'AccumulationRegisters', 'AccountingRegisters',
  'CalculationRegisters', 'Reports', 'DataProcessors', 'Enums',
]);

/**
 * Parse an EventSubscription Handler string into its components.
 * Returns null if the string is not a valid handler reference.
 *
 * Formats:
 *   CommonModule.<ModuleName>.<ProcedureName>
 *   <ObjectType>.<ObjectName>.<ModuleName>.<ProcedureName>
 */
export interface HandlerParts {
  /** 'CommonModule' or one of OBJECT_TYPE_PREFIXES */
  objectType: string;
  /** Name of the metadata object */
  objectName: string;
  /** Module name segment (e.g. ObjectModule, ObjectManagerModule) — empty for CommonModule */
  moduleName: string;
  /** Procedure name to navigate to */
  procedureName: string;
}

export function parseHandlerString(handler: string): HandlerParts | null {
  if (!handler || typeof handler !== 'string') {
    return null;
  }
  const parts = handler.split('.');
  if (parts.length < 3) {
    return null;
  }
  const objectType = parts[0];
  if (objectType === 'CommonModule' || objectType === 'ОбщийМодуль') {
    // CommonModule.<ModuleName>.<Procedure> (Procedure may contain dots)
    const objectName = parts[1];
    const procedureName = parts.slice(2).join('.');
    return { objectType: 'CommonModule', objectName, moduleName: '', procedureName };
  }
  if (OBJECT_TYPE_PREFIXES.has(objectType)) {
    // <Type>.<ObjectName>.<ModuleName>.<Procedure...>
    if (parts.length < 4) {
      return null;
    }
    const objectName = parts[1];
    const moduleName = parts[2];
    const procedureName = parts.slice(3).join('.');
    return { objectType, objectName, moduleName, procedureName };
  }
  return null;
}

/**
 * Open a BSL module file in the editor and navigate to the specified procedure.
 * This is a lightweight version of openModuleInEditor from formFileIo that accepts
 * a direct file path instead of computing it from form XML path.
 */
async function openBslModuleAtProcedure(moduleFsPath: string, procedureName: string): Promise<void> {
  const { parseBslModuleProcedures } = await import('../formEditor/bslModuleParser');
  const uri = vscode.Uri.file(moduleFsPath);
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc, {
    viewColumn: vscode.ViewColumn.One,
    preview: false,
  });
  if (procedureName) {
    const procedures = await parseBslModuleProcedures(moduleFsPath);
    const proc = procedures.find((p) => p.name === procedureName);
    if (proc && proc.line) {
      const line = Math.max(0, proc.line - 1);
      const range = new vscode.Range(line, 0, line, 0);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      editor.selection = new vscode.Selection(line, 0, line, 0);
    }
  }
}

/**
 * Handle 'gotoHandler' message from webview: open the BSL module for an EventSubscription handler.
 */
export async function handleGotoHandlerMessage(
  message: WebviewMessage,
  ctx: MessageHandlerContext
): Promise<void> {
  if (message.type !== 'gotoHandler') {
    return;
  }
  const handlerStr = message.handler;
  const parts = parseHandlerString(handlerStr);
  if (!parts) {
    vscode.window.showWarningMessage(`Не удалось разобрать обработчик: ${handlerStr}`);
    return;
  }

  // Find the metadata object node in the tree by name (case-insensitive search)
  const nodes = ctx.treeDataProvider.findNodesByName(parts.objectName, ctx.currentNode);
  // Filter by type: for CommonModule look for CommonModule nodes; for others match objectType prefix
  const matchingNode = nodes.find((n) => {
    if (parts.objectType === 'CommonModule') {
      return n.type === 'CommonModule';
    }
    // e.g. objectType='Catalogs' → node.type='Catalog'
    const singularType = parts.objectType.replace(/s$/, '');
    return n.type === singularType || n.type === parts.objectType;
  });

  if (!matchingNode || !matchingNode.filePath) {
    vscode.window.showWarningMessage(`Не удалось найти объект "${parts.objectName}" для обработчика: ${handlerStr}`);
    return;
  }

  // Build path to BSL module file
  const objectFolder = path.dirname(matchingNode.filePath);

  let moduleBslPath: string;
  if (parts.objectType === 'CommonModule') {
    const commonModuleFile = getStandardModuleFileName(
      MetadataType.CommonModule,
      'CommonModule'
    );
    if (!commonModuleFile) {
      vscode.window.showWarningMessage('Стандартный модуль общего модуля не найден в реестре.');
      return;
    }
    moduleBslPath = path.join(objectFolder, 'Ext', commonModuleFile);
  } else {
    const metadataType = MetadataTypeMapper.map(parts.objectType);
    const standardModuleFile = getStandardModuleFileName(
      metadataType,
      parts.moduleName as StandardModuleKind
    );
    const legacyModuleFile = HANDLER_MODULE_FILE_MAP[parts.moduleName];
    const legacyAliasAllowed =
      legacyModuleFile !== undefined &&
      getStandardModuleFileName(metadataType, 'ObjectModule') !== undefined;
    const moduleBslFile = standardModuleFile ?? (legacyAliasAllowed ? legacyModuleFile : undefined);
    if (!moduleBslFile) {
      vscode.window.showWarningMessage(
        `Модуль "${parts.moduleName}" не поддерживается для типа "${parts.objectType}".`
      );
      return;
    }
    moduleBslPath = path.join(objectFolder, 'Ext', moduleBslFile);
  }

  try {
    await openBslModuleAtProcedure(moduleBslPath, parts.procedureName);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    Logger.error('handleGotoHandlerMessage: failed to open module', err);
    vscode.window.showWarningMessage(
      errMsg.includes('ENOENT') || errMsg.includes('not found')
        ? `Файл модуля не найден: ${moduleBslPath}`
        : `Не удалось открыть модуль для обработчика: ${errMsg}`
    );
  }
}
