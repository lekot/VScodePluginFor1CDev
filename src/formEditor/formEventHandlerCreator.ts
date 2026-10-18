import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getDirective, getEventParams } from './formEventCatalog';

const CRLF = '\r\n';

export async function readModuleStateForEventHandler(
  modulePath: string,
  associatedDocuments?: Map<string, vscode.TextDocument>,
): Promise<{ content: string; existed: boolean }> {
  const normalizedPath = path.normalize(modulePath);
  const openDocument = vscode.workspace.textDocuments.find(
    (document) => document.uri.scheme === 'file' && path.normalize(document.uri.fsPath) === normalizedPath
  ) ?? associatedDocuments?.get(normalizedPath);
  const existed = await fs.promises.access(modulePath).then(() => true, () => false);
  if (openDocument) {
    return { content: openDocument.getText(), existed };
  }
  const content = await fs.promises.readFile(modulePath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return '';
    }
    throw error;
  });
  return { content, existed };
}

export function buildHandlerProcedureStub(
  handlerName: string,
  eventName: string,
  isFormLevel: boolean,
  existingText = ''
): { stub: string; searchToken: string } {
  const directive = getDirective(eventName);
  const params = getEventParams(eventName, isFormLevel);
  const leadingNewline = existingText.length > 0 && !existingText.endsWith('\n') ? CRLF : '';
  const searchToken = `Процедура ${handlerName}(`;
  const stub =
    leadingNewline +
    CRLF +
    directive + CRLF +
    `${searchToken}${params})` + CRLF +
    `\t// TODO: обработчик события` + CRLF +
    `КонецПроцедуры` + CRLF;
  return { stub, searchToken };
}

/**
 * Inserts a BSL procedure stub for the given handler into the module document buffer
 * using an in-memory WorkspaceEdit without writing to disk prematurely.
 */
export async function insertHandlerStubInMemory(
  moduleUri: vscode.Uri,
  handlerName: string,
  eventName: string,
  isFormLevel: boolean,
  associatedDocuments?: Map<string, vscode.TextDocument>,
): Promise<{ line: number; document: vscode.TextDocument; originalText: string; addedText: string }> {
  const fileOnDisk = fs.existsSync(moduleUri.fsPath);
  const modulePath = path.normalize(moduleUri.fsPath);
  const openDoc = vscode.workspace.textDocuments.find(
    (d) => d.uri.scheme === 'file' && path.normalize(d.uri.fsPath) === modulePath
  );
  let doc = openDoc ?? associatedDocuments?.get(modulePath);
  let newlyAssociated = false;
  if (!doc) {
    if (fileOnDisk) {
      doc = await vscode.workspace.openTextDocument(moduleUri);
    } else {
      // Keep the buffer untitled while associating it with the eventual Module.bsl path.
      // VS Code can save this document to that path without opening a Save As picker.
      doc = await vscode.workspace.openTextDocument(moduleUri.with({ scheme: 'untitled' }));
      newlyAssociated = true;
    }
  }
  const originalText = doc.getText();
  const generationBaseText = newlyAssociated && originalText.length === 0 ? '\uFEFF' : originalText;
  const { stub, searchToken } = buildHandlerProcedureStub(
    handlerName,
    eventName,
    isFormLevel,
    generationBaseText
  );

  const lastLine = Math.max(0, doc.lineCount - 1);
  const lastLineEnd = doc.lineAt(lastLine).range.end;

  const edit = new vscode.WorkspaceEdit();
  edit.insert(doc.uri, lastLineEnd, (generationBaseText === '\uFEFF' ? '\uFEFF' : '') + stub);
  if (!(await vscode.workspace.applyEdit(edit))) {
    throw new Error(`Не удалось создать обработчик ${handlerName} в модуле формы.`);
  }
  if (newlyAssociated) {
    associatedDocuments?.set(modulePath, doc);
  }

  for (let i = 0; i < doc.lineCount; i++) {
    const lineText = doc.lineAt(i).text.trim();
    if (lineText.startsWith(searchToken)) {
      const nextText = doc.getText();
      return { line: i + 1, document: doc, originalText, addedText: nextText.slice(originalText.length) };
    }
  }

  const nextText = doc.getText();
  return { line: doc.lineCount, document: doc, originalText, addedText: nextText.slice(originalText.length) };
}

/**
 * Legacy on-disk creator maintained for backward compatibility.
 */
export async function createHandlerInModule(
  modulePath: string,
  handlerName: string,
  eventName: string,
  isFormLevel: boolean
): Promise<{ line: number }> {
  const fileExists = await fs.promises.access(modulePath).then(() => true, () => false);
  if (!fileExists) {
    const dir = path.dirname(modulePath);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(modulePath, '\uFEFF', { encoding: 'utf8' });
  }

  const content = await fs.promises.readFile(modulePath, { encoding: 'utf8' });
  const { stub, searchToken } = buildHandlerProcedureStub(
    handlerName,
    eventName,
    isFormLevel,
    content
  );
  const combined = content + stub;
  await fs.promises.writeFile(modulePath, combined, { encoding: 'utf8' });

  const lines = combined.split(/\r?\n/);
  const zeroBasedIndex = lines.findIndex((line) => line.startsWith(searchToken));
  const lineNumber = zeroBasedIndex >= 0 ? zeroBasedIndex + 1 : 1;
  return { line: lineNumber };
}
