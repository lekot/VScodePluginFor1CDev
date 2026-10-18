import * as path from 'path';
import * as vscode from 'vscode';
import { canonicalizePathWithMissingSuffix, isSamePath } from '../services/configurationSession/pathBoundary';

/** Finds the single live text buffer associated with an intended Module.bsl path. */
export async function findModuleTextDocument(
  intendedPath: string,
  associatedDocuments?: ReadonlyMap<string, vscode.TextDocument>,
): Promise<vscode.TextDocument | undefined> {
  const candidates = new Set<vscode.TextDocument>();
  const scannedDocuments = new Set<vscode.TextDocument>();
  const canonicalTarget = await canonicalizePathWithMissingSuffix(intendedPath);

  let scanAgain = true;
  while (scanAgain) {
    const liveDocuments = vscode.workspace.textDocuments;
    const pendingDocuments = new Set<vscode.TextDocument>(liveDocuments);
    for (const document of associatedDocuments?.values() ?? []) {
      if (liveDocuments.includes(document)) {
        pendingDocuments.add(document);
      }
    }

    const unscannedDocuments = [...pendingDocuments].filter(
      (document) => !scannedDocuments.has(document) && isSupportedModuleDocument(document),
    );
    if (unscannedDocuments.length === 0) {
      scanAgain = false;
      continue;
    }

    await Promise.all(unscannedDocuments.map(async (document) => {
      scannedDocuments.add(document);
      if (await pathsReferToSameTarget(document.uri.fsPath, intendedPath, canonicalTarget)) {
        candidates.add(document);
      }
    }));
  }

  const currentLiveDocuments = vscode.workspace.textDocuments;
  const currentCandidates = [...candidates].filter(
    (document) => currentLiveDocuments.includes(document) && isSupportedModuleDocument(document),
  );
  if (currentCandidates.length > 1) {
    throw new Error(`Несколько открытых документов соответствуют Module.bsl: ${intendedPath}`);
  }
  return currentCandidates[0];
}

/** Rebuilds an association entry from a buffer VS Code still has open. */
export async function restoreModuleDocumentAssociation(
  intendedPath: string,
  associatedDocuments: Map<string, vscode.TextDocument>,
): Promise<void> {
  const document = await findModuleTextDocument(intendedPath, associatedDocuments);
  if (document) {
    associatedDocuments.set(path.normalize(intendedPath), document);
  }
}

function isSupportedModuleDocument(document: vscode.TextDocument): boolean {
  if (document.isClosed) {
    return false;
  }
  if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') {
    return false;
  }
  return path.isAbsolute(document.uri.fsPath) || path.win32.isAbsolute(document.uri.fsPath);
}

async function pathsReferToSameTarget(
  candidatePath: string,
  intendedPath: string,
  canonicalTarget: string,
): Promise<boolean> {
  if (isSamePath(candidatePath, intendedPath)) {
    return true;
  }
  try {
    const canonicalCandidate = await canonicalizePathWithMissingSuffix(candidatePath);
    return isSamePath(canonicalCandidate, canonicalTarget);
  } catch {
    return false;
  }
}
