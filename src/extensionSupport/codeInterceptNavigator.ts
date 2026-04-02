import * as fs from 'fs';
import * as vscode from 'vscode';
import { TreeNode } from '../models/treeNode';
import { ExtensionState } from '../state/extensionState';
import { InterceptEntry } from './extensionTypes';

/** Regex matching BSL extension decorator annotations */
const INTERCEPT_REGEX = /&(Перед|После|Вместо|ИзменениеИКонтроль)\("([^"]+)"\)/g;

/**
 * Parse BSL content and return all intercept decorator entries with line numbers.
 */
export function findInterceptDecorators(bslContent: string): InterceptEntry[] {
  const entries: InterceptEntry[] = [];
  const lines = bslContent.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match: RegExpExecArray | null;
    INTERCEPT_REGEX.lastIndex = 0;
    while ((match = INTERCEPT_REGEX.exec(line)) !== null) {
      const decorator = match[1] as InterceptEntry['decorator'];
      const targetProcedure = match[2];
      entries.push({
        decorator,
        targetProcedure,
        line: i + 1, // 1-based
      });
    }
  }

  return entries;
}

/**
 * Try to resolve the target procedure name to a TreeNode in main config.
 * The targetProcedure format is typically "ObjectName.ProcedureName" or just "ProcedureName".
 */
function resolveInterceptTarget(
  targetProcedure: string,
  state: ExtensionState
): { node: TreeNode | undefined; label: string } {
  const provider = state.treeDataProvider;
  if (!provider) {
    return { node: undefined, label: targetProcedure };
  }

  // Try to match by searching for the procedure name
  const nodes = provider.searchByName(targetProcedure);
  if (nodes.length > 0) {
    return { node: nodes[0], label: targetProcedure };
  }

  // If format is "Object.Method", try to find the object
  const dotIdx = targetProcedure.lastIndexOf('.');
  if (dotIdx > 0) {
    const objectPart = targetProcedure.substring(0, dotIdx);
    const objectNodes = provider.searchByName(objectPart);
    if (objectNodes.length > 0) {
      return { node: objectNodes[0], label: targetProcedure };
    }
  }

  return { node: undefined, label: targetProcedure };
}

/**
 * Show QuickPick with intercept decorators found in the BSL file, and navigate to the target.
 */
export async function showInterceptors(bslFilePath: string, state: ExtensionState): Promise<void> {
  const { treeView } = state;

  // Read the BSL file
  let bslContent: string;
  try {
    bslContent = await fs.promises.readFile(bslFilePath, 'utf-8');
  } catch (err) {
    vscode.window.showErrorMessage(
      `Не удалось прочитать файл модуля: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  const entries = findInterceptDecorators(bslContent);

  if (entries.length === 0) {
    vscode.window.showInformationMessage('В файле не найдено декораторов перехвата (&Перед, &После, &Вместо, &ИзменениеИКонтроль).');
    return;
  }

  const decoratorIcons: Record<InterceptEntry['decorator'], string> = {
    'Перед': '$(debug-step-back)',
    'После': '$(debug-step-over)',
    'Вместо': '$(replace)',
    'ИзменениеИКонтроль': '$(edit)',
  };

  const items = entries.map((entry) => ({
    label: `${decoratorIcons[entry.decorator]} &${entry.decorator}("${entry.targetProcedure}")`,
    description: `строка ${entry.line}`,
    detail: entry.targetProcedure,
    entry,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Декораторы перехвата — выберите для навигации к оригиналу',
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (!picked) {
    return;
  }

  // Open the BSL file at the decorator line first
  try {
    const uri = vscode.Uri.file(bslFilePath);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc);
    const lineIndex = picked.entry.line - 1;
    const range = new vscode.Range(lineIndex, 0, lineIndex, 0);
    editor.selection = new vscode.Selection(lineIndex, 0, lineIndex, 0);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  } catch (err) {
    vscode.window.showErrorMessage(
      `Не удалось открыть файл модуля: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  // Attempt to navigate to the target in the tree
  if (!treeView || !state.treeDataProvider) {
    return;
  }

  const { node: targetNode } = resolveInterceptTarget(picked.entry.targetProcedure, state);
  if (targetNode) {
    try {
      await treeView.reveal(targetNode, { select: true, focus: false, expand: true });
    } catch {
      // Non-critical: BSL navigation succeeded, tree reveal is best-effort
    }
  }
}
