import * as vscode from 'vscode';
import { QueryPackage } from './sdbl/sdblAst';
import { QueryMetadataNode } from './metadata/queryMetadataTypes';
import { QueryMetadataProvider } from './metadata/queryMetadataProvider';
import { MetadataTreeDataProvider } from '../providers/treeDataProvider';
import {
  generateBslQueryWithProcessing,
  generateBslSimpleQuery,
} from './editor/queryCodeTemplates';
import { formatSdbl } from './sdbl/sdblFormatter';
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
  statementRange?: QueryBuilderReplaceRange;
  variableName?: string;
  metadataProvider?: QueryMetadataProvider;
  treeProvider?: MetadataTreeDataProvider | null;
  onAstUpdated?: (ast: QueryPackage) => void;
  isSdblDocument?: boolean;
  initialDocumentVersion?: number;
  expectedText?: string;
  expectedStatementText?: string;
  surroundingPrefix?: string;
  surroundingSuffix?: string;
  occurrenceIndex?: number;
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
        if (context.isSdblDocument) {
          generatedCode = formatSdbl(targetAst);
        } else if (targetMode === 'withProcessing') {
          generatedCode = generateBslQueryWithProcessing(targetAst, {
            variableName: context.variableName,
          });
        } else {
          generatedCode = generateBslSimpleQuery(targetAst);
        }

        if (context.editor) {
          const isWithProcessing = targetMode === 'withProcessing' && !!context.statementRange;
          const activeRange = isWithProcessing ? context.statementRange! : context.replaceRange;
          const expectedText = isWithProcessing
            ? (context.expectedStatementText ?? context.expectedText)
            : context.expectedText;

          const startPos = new vscode.Position(
            Math.max(0, activeRange.startLine - 1),
            Math.max(0, activeRange.startColumn - 1)
          );
          const endPos = new vscode.Position(
            Math.max(0, activeRange.endLine - 1),
            Math.max(0, activeRange.endColumn - 1)
          );
          let targetVscodeRange = new vscode.Range(startPos, endPos);

          if (
            context.initialDocumentVersion !== undefined &&
            context.editor.document.version !== context.initialDocumentVersion
          ) {
            const currentText = context.editor.document.getText(targetVscodeRange);
            if (expectedText !== undefined && currentText !== expectedText) {
              const fullText = context.editor.document.getText();
              if (!expectedText) {
                void vscode.window.showErrorMessage(
                  'Документ был изменен в редакторе после открытия конструктора. Сохранение отменено.'
                );
                return;
              }

              // Find all occurrences of expectedText in fullText
              const occurrences: number[] = [];
              let searchFrom = 0;
              while (searchFrom <= fullText.length - expectedText.length) {
                const idx = fullText.indexOf(expectedText, searchFrom);
                if (idx === -1) {break;}
                occurrences.push(idx);
                searchFrom = idx + 1;
              }

              if (occurrences.length === 0) {
                void vscode.window.showErrorMessage(
                  'Документ был изменен в редакторе после открытия конструктора. Сохранение отменено.'
                );
                return;
              }

              let foundOffset = -1;
              if (occurrences.length === 1) {
                foundOffset = occurrences[0];
              } else {
                // Multiple occurrences exist! Match by surrounding prefix/suffix and original position
                const originalOffset = activeRange.startOffset;
                const prefix = context.surroundingPrefix ?? '';
                const suffix = context.surroundingSuffix ?? '';

                let bestScore = -1;
                let bestOffset = -1;
                let tieCount = 0;

                for (let i = 0; i < occurrences.length; i++) {
                  const off = occurrences[i];
                  let score = 0;
                  if (prefix.length > 0) {
                    const actualPrefix = fullText.slice(Math.max(0, off - prefix.length), off);
                    if (actualPrefix === prefix) {
                      score += 100;
                    } else if (prefix.endsWith(actualPrefix) || actualPrefix.endsWith(prefix)) {
                      score += 30;
                    }
                  }
                  if (suffix.length > 0) {
                    const actualSuffix = fullText.slice(off + expectedText.length, off + expectedText.length + suffix.length);
                    if (actualSuffix === suffix) {
                      score += 100;
                    } else if (suffix.startsWith(actualSuffix) || actualSuffix.startsWith(suffix)) {
                      score += 30;
                    }
                  }
                  if (context.occurrenceIndex !== undefined && i === context.occurrenceIndex) {
                    score += 50;
                  }

                  const distance = Math.abs(off - originalOffset);
                  score += Math.max(0, 20 - Math.floor(distance / 50));

                  if (score > bestScore) {
                    bestScore = score;
                    bestOffset = off;
                    tieCount = 1;
                  } else if (score === bestScore) {
                    tieCount++;
                  }
                }

                if (bestOffset !== -1 && tieCount === 1) {
                  foundOffset = bestOffset;
                } else {
                  void vscode.window.showErrorMessage(
                    'Документ содержит несколько похожих запросов и был изменен. Сохранение отменено во избежание неоднозначной замены.'
                  );
                  return;
                }
              }

              const newStart = context.editor.document.positionAt(foundOffset);
              const newEnd = context.editor.document.positionAt(foundOffset + expectedText.length);
              targetVscodeRange = new vscode.Range(newStart, newEnd);
            }
          }

          const success = await context.editor.edit((editBuilder) => {
            editBuilder.replace(targetVscodeRange, generatedCode);
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