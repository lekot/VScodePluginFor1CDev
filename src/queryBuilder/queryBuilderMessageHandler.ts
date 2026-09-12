import * as vscode from 'vscode';
import { QueryPackage } from './sdbl/sdblAst';
import { QueryMetadataNode } from './metadata/queryMetadataTypes';
import { QueryMetadataProvider } from './metadata/queryMetadataProvider';
import { MetadataTreeDataProvider } from '../providers/treeDataProvider';
import {
  generateBslQueryWithProcessing,
  generateBslSimpleQuery,
} from './editor/queryCodeTemplates';
import { Logger } from '../utils/logger';

export interface QueryBuilderReplaceRange {
  startOffset: number;
  endOffset: number;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface QueryBuilderMessageContext {
  panel: vscode.WebviewPanel;
  editor?: vscode.TextEditor;
  ast: QueryPackage;
  metadata: QueryMetadataNode[];
  mode: 'simple' | 'withProcessing';
  replaceRange: QueryBuilderReplaceRange;
  variableName?: string;
  metadataProvider?: QueryMetadataProvider;
  treeProvider?: MetadataTreeDataProvider | null;
  onAstUpdated?: (ast: QueryPackage) => void;
}

export interface QueryBuilderInboundMessage {
  command: string;
  ast?: QueryPackage;
  mode?: 'simple' | 'withProcessing';
  [key: string]: unknown;
}

export async function handleQueryBuilderMessage(
  message: unknown,
  context: QueryBuilderMessageContext
): Promise<void> {
  if (!message || typeof message !== 'object') {
    return;
  }

  const msg = message as QueryBuilderInboundMessage;
  if (typeof msg.command !== 'string') {
    return;
  }

  try {
    switch (msg.command) {
      case 'ready': {
        await context.panel.webview.postMessage({
          command: 'init',
          ast: context.ast,
          metadata: context.metadata,
          mode: context.mode,
        });
        break;
      }

      case 'updateAst': {
        if (msg.ast && typeof msg.ast === 'object') {
          context.ast = msg.ast;
          context.onAstUpdated?.(msg.ast);
        }
        break;
      }

      case 'save': {
        const targetAst = (msg.ast && typeof msg.ast === 'object') ? msg.ast : context.ast;
        const targetMode = msg.mode || context.mode;

        let generatedCode: string;
        if (targetMode === 'withProcessing') {
          generatedCode = generateBslQueryWithProcessing(targetAst, {
            variableName: context.variableName,
          });
        } else {
          generatedCode = generateBslSimpleQuery(targetAst);
        }

        if (context.editor) {
          const startPos = new vscode.Position(
            Math.max(0, context.replaceRange.startLine - 1),
            Math.max(0, context.replaceRange.startColumn - 1)
          );
          const endPos = new vscode.Position(
            Math.max(0, context.replaceRange.endLine - 1),
            Math.max(0, context.replaceRange.endColumn - 1)
          );
          const range = new vscode.Range(startPos, endPos);

          const success = await context.editor.edit((editBuilder) => {
            editBuilder.replace(range, generatedCode);
          });

          if (success) {
            vscode.window.setStatusBarMessage('Запрос 1С сохранен.', 3000);
            context.panel.dispose();
          }
        } else {
          context.panel.dispose();
        }
        break;
      }

      case 'cancel': {
        context.panel.dispose();
        break;
      }

      case 'requestMetadata': {
        if (context.metadataProvider) {
          const updated = await context.metadataProvider.buildTreeFromProvider(
            context.treeProvider
          );
          context.metadata = updated;
          await context.panel.webview.postMessage({
            command: 'updateMetadata',
            metadata: updated,
          });
        }
        break;
      }

      default:
        Logger.warn(`[QueryBuilderMessageHandler] Unknown message command: ${msg.command}`);
        break;
    }
  } catch (err) {
    Logger.error('[QueryBuilderMessageHandler] Error handling message', err);
  }
}

export class QueryBuilderMessageHandler {
  constructor(public readonly context: QueryBuilderMessageContext) {}

  public async handleMessage(message: unknown): Promise<void> {
    await handleQueryBuilderMessage(message, this.context);
  }
}