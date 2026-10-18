import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getDirective, getEventParams } from './formEventCatalog';

const CRLF = '\r\n';

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
  isFormLevel: boolean
): Promise<{ line: number }> {
  const fileOnDisk = fs.existsSync(moduleUri.fsPath);
  const openDoc = vscode.workspace.textDocuments.find(
    (d) => path.normalize(d.uri.fsPath) === path.normalize(moduleUri.fsPath)
  );

  if (!fileOnDisk && !openDoc) {
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(moduleUri, { ignoreIfExists: true, contents: Buffer.from('\uFEFF', 'utf8') });
    await vscode.workspace.applyEdit(edit);
  }

  const doc = await vscode.workspace.openTextDocument(moduleUri);
  const { stub, searchToken } = buildHandlerProcedureStub(
    handlerName,
    eventName,
    isFormLevel,
    doc.getText()
  );

  const lastLine = Math.max(0, doc.lineCount - 1);
  const lastLineEnd = doc.lineAt(lastLine).range.end;

  const edit = new vscode.WorkspaceEdit();
  edit.insert(moduleUri, lastLineEnd, stub);
  await vscode.workspace.applyEdit(edit);

  for (let i = 0; i < doc.lineCount; i++) {
    const lineText = doc.lineAt(i).text.trim();
    if (lineText.startsWith(searchToken)) {
      return { line: i + 1 };
    }
  }

  return { line: doc.lineCount };
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
