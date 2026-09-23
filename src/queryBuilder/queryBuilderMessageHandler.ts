import * as vscode from 'vscode';
import { QueryPackage } from './sdbl/sdblAst';
import { QueryMetadataNode } from './metadata/queryMetadataTypes';
import { QueryMetadataProvider } from './metadata/queryMetadataProvider';
import { MetadataTreeDataProvider } from '../providers/treeDataProvider';
import { TreeNode } from '../models/treeNode';
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
  targetRoot?: TreeNode | null;
  onAstUpdated?: (ast: QueryPackage) => void;
  isSdblDocument?: boolean;
  initialDocumentVersion?: number;
  expectedText?: string;
  expectedStatementText?: string;
  surroundingPrefix?: string;
  surroundingSuffix?: string;
  occurrenceIndex?: number;
  initialOccurrenceCount?: number;
  enclosingScope?: string;
  isNewQuery?: boolean;
}

/**
 * Detects the enclosing BSL procedure or function name for a given offset in documentText.
 * Returns the procedure/function name if offset is inside a procedure/function, or undefined if at module level.
 */
export function getEnclosingScope(documentText: string, offset: number): string | undefined {
  const textBefore = documentText.slice(0, offset);
  const procRegex = /(?:^|\r?\n)[ \t]*(?:Процедура|Функция|Procedure|Function)\s+([A-Za-zА-Яа-я0-9_]+)/gi;
  let lastMatch: RegExpExecArray | null = null;
  let m: RegExpExecArray | null = null;
  while ((m = procRegex.exec(textBefore)) !== null) {
    lastMatch = m;
  }
  if (!lastMatch) {
    return undefined;
  }
  const scopeName = lastMatch[1];
  const afterHeader = textBefore.slice(lastMatch.index + lastMatch[0].length);
  const endRegex = /(?:^|\r?\n)[ \t]*(?:КонецПроцедуры|КонецФункции|EndProcedure|EndFunction)/i;
  if (endRegex.test(afterHeader)) {
    return undefined;
  }
  return scopeName;
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

        // Finding 1: If withProcessing mode is requested on an existing query without statementRange,
        // it cannot safely replace the statement (e.g. inside Возврат, concatenation, compound property, or chained calls).
        // Abort save to prevent BSL code corruption!
        // NOTE (Finding 2): For pure SDBL documents, statementRange is not expected and formatSdbl is used.
        const isExistingQuery = context.replaceRange.startOffset !== context.replaceRange.endOffset;
        if (!context.isSdblDocument && targetMode === 'withProcessing' && isExistingQuery && !context.statementRange) {
          void vscode.window.showErrorMessage(
            'Невозможно сгенерировать обработку результата запроса: исходный запрос находится внутри сложного выражения или оператора Возврат. Сохранение отменено.'
          );
          return;
        }

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
          const isWithProcessing = !context.isSdblDocument && targetMode === 'withProcessing' && !!context.statementRange;
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

          const getImmediatePrefixLine = (text: string): string => {
            const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
            return lines.length > 0 ? lines[lines.length - 1].trim() : '';
          };

          if (
            context.initialDocumentVersion !== undefined &&
            context.editor.document.version !== context.initialDocumentVersion
          ) {
            const fullText = context.editor.document.getText();
            const currentText = context.editor.document.getText(targetVscodeRange);
            const currentOffset = context.editor.document.offsetAt(startPos);
            const prefix = context.surroundingPrefix ?? '';
            const expectedPrefixLine = getImmediatePrefixLine(prefix);
            const currentPrefix = fullText.slice(
              Math.max(0, currentOffset - prefix.length),
              currentOffset
            );
            const currentPrefixLine = getImmediatePrefixLine(currentPrefix);

            const currentScope = getEnclosingScope(fullText, currentOffset);
            const isScopeValid = context.enclosingScope === undefined || currentScope === context.enclosingScope;

            // Only allow the fast in-place check if there was at most ONE occurrence in the document originally.
            // When multiple identical queries existed, a shifted or different occurrence could occupy this range.
            const canUseFastPath =
              (context.initialOccurrenceCount === undefined || context.initialOccurrenceCount <= 1) &&
              isScopeValid &&
              currentText === expectedText &&
              (expectedPrefixLine.length === 0 ||
                currentPrefixLine === expectedPrefixLine ||
                currentPrefixLine.endsWith(expectedPrefixLine) ||
                expectedPrefixLine.endsWith(currentPrefixLine));

            if (!canUseFastPath) {
              if (!expectedText) {
                let relocatedOffset = -1;
                if (expectedPrefixLine.length > 0) {
                  let searchIdx = -1;
                  const matchingIndices: number[] = [];
                  while ((searchIdx = fullText.indexOf(expectedPrefixLine, searchIdx + 1)) !== -1) {
                    const scope = getEnclosingScope(fullText, searchIdx);
                    if (context.enclosingScope && scope !== context.enclosingScope) {
                      continue;
                    }
                    let insertPos = searchIdx + expectedPrefixLine.length;
                    while (insertPos < fullText.length && (fullText[insertPos] === ' ' || fullText[insertPos] === '\t')) {
                      insertPos++;
                    }
                    matchingIndices.push(insertPos);
                  }
                  if (matchingIndices.length === 1) {
                    relocatedOffset = matchingIndices[0];
                  } else if (matchingIndices.length > 1) {
                    matchingIndices.sort((a, b) => Math.abs(a - currentOffset) - Math.abs(b - currentOffset));
                    relocatedOffset = matchingIndices[0];
                  }
                }

                if (relocatedOffset !== -1) {
                  const newPos = context.editor.document.positionAt(relocatedOffset);
                  targetVscodeRange = new vscode.Range(newPos, newPos);
                } else {
                  void vscode.window.showErrorMessage(
                    'Документ был изменен в редакторе после открытия конструктора. Сохранение отменено.'
                  );
                  return;
                }
              } else {

              // Find all occurrences of expectedText in fullText
              const occurrences: number[] = [];
              let searchFrom = 0;
              while (searchFrom <= fullText.length - expectedText.length) {
                const idx = fullText.indexOf(expectedText, searchFrom);
                if (idx === -1) {
                  break;
                }
                occurrences.push(idx);
                searchFrom = idx + 1;
              }

              if (occurrences.length === 0) {
                void vscode.window.showErrorMessage(
                  'Документ был изменен в редакторе после открытия конструктора. Сохранение отменено.'
                );
                return;
              }

              // If multiple identical queries existed when builder was opened, and the count of occurrences changed,
              // at least one identical query was added or deleted. It is impossible to reliably determine whether
              // the selected query was deleted or survived. Abort save to prevent overwriting another query!
              if (
                context.initialOccurrenceCount !== undefined &&
                context.initialOccurrenceCount > 1 &&
                occurrences.length !== context.initialOccurrenceCount
              ) {
                void vscode.window.showErrorMessage(
                  occurrences.length > 1
                    ? 'Документ содержит несколько похожих запросов и был изменен. Сохранение отменено во избежание неоднозначной замены.'
                    : 'Документ был изменен в редакторе после открытия конструктора. Сохранение отменено.'
                );
                return;
              }

              // If our occurrence was not the first (occurrenceIndex > 0), but the document now has fewer occurrences:
              if (
                context.occurrenceIndex !== undefined &&
                context.occurrenceIndex > 0 &&
                occurrences.length <= context.occurrenceIndex
              ) {
                void vscode.window.showErrorMessage(
                  occurrences.length > 1
                    ? 'Документ содержит несколько похожих запросов и был изменен. Сохранение отменено во избежание неоднозначной замены.'
                    : 'Документ был изменен в редакторе после открытия конструктора. Сохранение отменено.'
                );
                return;
              }

              // Evaluate candidate occurrences against context prefix/suffix, enclosing scope, and original position
              const suffix = context.surroundingSuffix ?? '';
              const originalOffset = activeRange.startOffset;

              let bestScore = -1;
              let bestOffset = -1;
              let tieCount = 0;

              for (let i = 0; i < occurrences.length; i++) {
                const off = occurrences[i];

                // 1. When multiple identical queries exist, only the candidate matching the exact occurrence index can be our query:
                if (
                  context.initialOccurrenceCount !== undefined &&
                  context.initialOccurrenceCount > 1 &&
                  context.occurrenceIndex !== undefined &&
                  i !== context.occurrenceIndex
                ) {
                  continue;
                }

                // 2. Enclosing scope validation:
                // If the target query was inside a procedure or function, any candidate
                // in a different procedure or function must be disqualified immediately.
                if (context.enclosingScope !== undefined) {
                  const candidateScope = getEnclosingScope(fullText, off);
                  if (candidateScope !== context.enclosingScope) {
                    continue;
                  }
                }

                let score = 0;
                let contextMatched = false;

                if (prefix.length > 0) {
                  const actualPrefix = fullText.slice(Math.max(0, off - prefix.length), off);
                  const actualPrefixLine = getImmediatePrefixLine(actualPrefix);
                  if (actualPrefix === prefix) {
                    score += 100;
                    contextMatched = true;
                  } else if (prefix.endsWith(actualPrefix) || actualPrefix.endsWith(prefix)) {
                    score += 50;
                    contextMatched = true;
                  } else if (
                    expectedPrefixLine.length > 0 &&
                    (actualPrefixLine === expectedPrefixLine ||
                      actualPrefixLine.endsWith(expectedPrefixLine) ||
                      expectedPrefixLine.endsWith(actualPrefixLine))
                  ) {
                    score += 20;
                    contextMatched = true;
                  }

                  // If expectedPrefixLine is non-empty and actualPrefixLine contradicts it completely,
                  // this occurrence cannot be our query:
                  if (
                    expectedPrefixLine.length > 0 &&
                    actualPrefixLine.length > 0 &&
                    actualPrefixLine !== expectedPrefixLine &&
                    !actualPrefixLine.endsWith(expectedPrefixLine) &&
                    !expectedPrefixLine.endsWith(actualPrefixLine)
                  ) {
                    continue;
                  }
                }

                if (suffix.length > 0) {
                  const actualSuffix = fullText.slice(
                    off + expectedText.length,
                    off + expectedText.length + suffix.length
                  );
                  if (actualSuffix === suffix) {
                    score += 100;
                  } else if (suffix.startsWith(actualSuffix) || actualSuffix.startsWith(suffix)) {
                    score += 30;
                  }
                }

                if (context.occurrenceIndex !== undefined && i === context.occurrenceIndex) {
                  score += 50;
                }

                // If multiple occurrences initially existed, do not accept unprovable matches:
                if (
                  context.initialOccurrenceCount !== undefined &&
                  context.initialOccurrenceCount > 1 &&
                  !contextMatched
                ) {
                  continue;
                }

                // If occurrence was explicitly not the first, but only 1 occurrence remains and context didn't match:
                if (
                  context.occurrenceIndex !== undefined &&
                  context.occurrenceIndex > 0 &&
                  !contextMatched
                ) {
                  continue;
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

              let foundOffset = -1;
              if (bestOffset !== -1 && tieCount === 1) {
                foundOffset = bestOffset;
              } else {
                void vscode.window.showErrorMessage(
                  occurrences.length > 1
                    ? 'Документ содержит несколько похожих запросов и был изменен. Сохранение отменено во избежание неоднозначной замены.'
                    : 'Документ был изменен в редакторе после открытия конструктора. Сохранение отменено.'
                );
                return;
              }

              const newStart = context.editor.document.positionAt(foundOffset);
              const newEnd = context.editor.document.positionAt(foundOffset + expectedText.length);
              targetVscodeRange = new vscode.Range(newStart, newEnd);
            }
          }
        }

          // Trailing semicolon check: if inserting right after an unclosed assignment (e.g. `Запрос.Текст = `),
          // ensure the statement is closed with `;` to form valid BSL code.
          if (
            targetMode !== 'withProcessing' &&
            !context.isSdblDocument &&
            typeof context.editor.document.getText === 'function' &&
            typeof context.editor.document.offsetAt === 'function'
          ) {
            try {
              const docFullText = context.editor.document.getText();
              const targetStartOffset = context.editor.document.offsetAt(targetVscodeRange.start);
              const targetEndOffset = context.editor.document.offsetAt(targetVscodeRange.end);
              const textBeforeInsertion = docFullText.slice(0, targetStartOffset).trimEnd();
              const textAfterInsertion = docFullText.slice(targetEndOffset).trimStart();
              if (
                textBeforeInsertion.endsWith('=') &&
                !textAfterInsertion.startsWith(';') &&
                !generatedCode.trimEnd().endsWith(';')
              ) {
                generatedCode += ';';
              }
            } catch {
              // Ignore offset inspection error
            }
          }

          if (context.isNewQuery && !context.isSdblDocument) {
            const documentText = context.editor.document.getText();
            const insertionOffset = context.editor.document.offsetAt(targetVscodeRange.start);
            const lineStart = documentText.slice(0, insertionOffset).lastIndexOf('\n') + 1;
            const insertionIndent =
              documentText.slice(lineStart, insertionOffset).match(/^[\t ]*/)?.[0] ?? '';
            const endOfLineApi = (vscode as unknown as { EndOfLine?: { CRLF?: number } }).EndOfLine;
            const newline =
              endOfLineApi?.CRLF !== undefined
                ? (context.editor.document.eol === endOfLineApi.CRLF ? '\r\n' : '\n')
                : (documentText.includes('\r\n') ? '\r\n' : '\n');
            const lines = generatedCode.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
            generatedCode = lines
              .map((line, index) => (index === 0 ? line : `${insertionIndent}${line}`))
              .join(newline);
          }

          let success = false;

          // 1. Try context.editor.edit first (standard editor edit)
          if (typeof context.editor.edit === 'function') {
            try {
              success = await context.editor.edit((editBuilder) => {
                editBuilder.replace(targetVscodeRange, generatedCode);
              });
            } catch (err) {
              Logger.warn('context.editor.edit failed in query builder, will try workspace.applyEdit fallback', err);
            }
          }

          // 2. If editor.edit returned false (e.g. editor tab is hidden/inactive behind Webview), fallback to workspace.applyEdit!
          if (!success) {
            try {
              if (
                vscode.workspace &&
                typeof vscode.workspace.applyEdit === 'function' &&
                context.editor.document &&
                context.editor.document.uri
              ) {
                const workspaceEdit = new vscode.WorkspaceEdit();
                workspaceEdit.replace(context.editor.document.uri, targetVscodeRange, generatedCode);
                success = await vscode.workspace.applyEdit(workspaceEdit);
              }
            } catch (err) {
              Logger.warn('vscode.workspace.applyEdit failed in query builder', err);
            }
          }

          if (success) {
            vscode.window.setStatusBarMessage('Запрос 1С сохранен.', 3000);
            context.panel.dispose();
            try {
              if (vscode.window && typeof vscode.window.showTextDocument === 'function') {
                await vscode.window.showTextDocument(context.editor.document, {
                  preserveFocus: false,
                  preview: false,
                });
              }
            } catch {
              // Ignore focus error
            }
          } else {
            void vscode.window.showErrorMessage(
              'Не удалось сохранить запрос в активный документ. Проверьте права на запись файла или закройте блокирующие диалоги.'
            );
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
            context.treeProvider,
            context.targetRoot
          );
          context.metadata = updated;
          await context.panel.webview.postMessage({
            command: 'updateMetadata',
            metadata: updated,
          });
        }
        break;
      }

      case 'loadTableAttributes': {
        const tableId = msg.tableId as string | undefined;
        if (!tableId || !context.metadataProvider || !context.treeProvider) {
          break;
        }
        try {
          const attributes = await context.metadataProvider.loadTableAttributes(
            context.treeProvider,
            context.targetRoot ?? null,
            tableId
          );
          await context.panel.webview.postMessage({
            command: 'tableAttributesLoaded',
            tableId,
            children: attributes,
          });
        } catch (err) {
          Logger.warn('Failed to load table attributes on-demand', err);
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

  public updateMetadata(metadata: QueryMetadataNode[]): void {
    this.context.metadata = metadata;
  }

  public async handleMessage(message: unknown): Promise<void> {
    await handleQueryBuilderMessage(message, this.context);
  }
}
