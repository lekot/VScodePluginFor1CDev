import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

import { trimTrailingPathSeparators } from './normalizedFilePath';
import * as vscode from 'vscode';

import type { BslModuleComparisonResolution } from './bsl/bslModuleComparison';

export interface BslModuleDiffWorkspaceLike {
  readonly payload: {
    readonly locked: boolean;
    readonly bslModuleDiffNodeIds?: readonly string[];
  };
  resolveBslModuleComparison?: (nodeId: string) => Promise<BslModuleComparisonResolution>;
}

export interface BslModuleDiffOpenState {
  busy: boolean;
}

export interface BslModuleDiffOpenInput {
  readonly webview: Pick<vscode.Webview, 'postMessage'>;
  readonly workspace: BslModuleDiffWorkspaceLike;
  readonly title: string;
  readonly state: BslModuleDiffOpenState;
  readonly nodeId: string;
  readonly isDisposed: () => boolean;
  readonly postState: () => Promise<void>;
  readonly postError: (message: string) => Promise<void>;
}

export interface BslModuleDiffController extends vscode.Disposable {
  readonly contentProvider: BslModuleSnapshotContentProvider;
  open(input: BslModuleDiffOpenInput): Promise<void>;
}

export function createBslModuleDiffController(hasResolver: boolean): BslModuleDiffController {
  const scheme = `onec-config-compare-bsl-${randomUUID()}`;
  const contentProvider = new BslModuleSnapshotContentProvider();
  const registration = hasResolver
    ? vscode.workspace.registerTextDocumentContentProvider(scheme, contentProvider)
    : undefined;
  let disposed = false;

  return {
    contentProvider,
    async open(input): Promise<void> {
      const reportError = async (message: string, releaseBusy = true): Promise<void> => {
        if (releaseBusy) {input.state.busy = false;}
        if (disposed || input.isDisposed()) {return;}
        await input.postError(message);
        await input.postState();
      };

      if (input.state.busy) {
        await reportError('Операция сравнения уже выполняется. Дождитесь её завершения.', false);
        return;
      }
      if (
        !input.workspace.resolveBslModuleComparison ||
        !input.workspace.payload.bslModuleDiffNodeIds?.includes(input.nodeId)
      ) {
        await reportError('Ручное сравнение этого BSL-модуля недоступно. Обновите сравнение.');
        return;
      }

      input.state.busy = true;
      await input.postState();
      let resolution: BslModuleComparisonResolution;
      try {
        resolution = await input.workspace.resolveBslModuleComparison(input.nodeId);
      } catch {
        await reportError('Не удалось проверить снимок BSL-модуля. Обновите сравнение и попробуйте снова.');
        return;
      }
      if (disposed || input.isDisposed()) {return;}
      if (!resolution.ok) {
        await reportError(resolution.message);
        return;
      }

      if (await hasDirtyTargetDocument(resolution.snapshot.targetFilePath)) {
        await reportError('В приёмнике есть несохранённая правка. Сохраните файл, обновите сравнение и откройте diff снова.');
        return;
      }

      const sourceUri = vscode.Uri.parse(`${scheme}:/${randomUUID()}.bsl`);
      const targetUri = vscode.Uri.file(resolution.snapshot.targetFilePath);
      contentProvider.addSnapshot(sourceUri, resolution.snapshot.sourceSnapshotText);
      try {
        if (disposed || input.isDisposed()) {return;}
        await vscode.commands.executeCommand(
          'vscode.diff',
          sourceUri,
          targetUri,
          `Сравнение BSL: Источник → Приёмник — ${resolution.snapshot.label}`
        );
        if (disposed || input.isDisposed()) {return;}
        input.state.busy = false;
        await vscode.window.showInformationMessage('После ручной правки приёмника обновите сравнение.');
        await input.postState();
      } catch {
        await reportError('Не удалось открыть сравнение BSL-модуля. Обновите сравнение и попробуйте снова.');
      }
    },
    dispose(): void {
      if (disposed) {return;}
      disposed = true;
      contentProvider.dispose();
      registration?.dispose();
    },
  };
}

export class BslModuleSnapshotContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly snapshots = new Map<string, string>();

  get snapshotCount(): number {
    return this.snapshots.size;
  }

  addSnapshot(uri: vscode.Uri, text: string): void {
    this.snapshots.set(uri.toString(), text);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.snapshots.get(uri.toString()) ?? '';
  }

  dispose(): void {
    this.snapshots.clear();
  }
}

function sameNormalizedFilePath(left: string | undefined, right: string): boolean {
  if (!left) {return false;}
  const normalizedLeft = trimTrailingPathSeparators(path.resolve(left));
  const normalizedRight = trimTrailingPathSeparators(path.resolve(right));
  return process.platform === 'win32'
    ? normalizedLeft.toLocaleLowerCase('en-US') === normalizedRight.toLocaleLowerCase('en-US')
    : normalizedLeft === normalizedRight;
}

async function hasDirtyTargetDocument(targetFilePath: string): Promise<boolean> {
  const targetPath = await canonicalizeFilePath(targetFilePath);
  const dirtyFileDocuments = vscode.workspace.textDocuments.filter((document) =>
    document.isDirty && document.uri.scheme === 'file' && Boolean(document.uri.fsPath)
  );
  for (const document of dirtyFileDocuments) {
    const documentPath = await canonicalizeFilePath(document.uri.fsPath);
    if (sameNormalizedFilePath(documentPath, targetPath)) {return true;}
  }
  return false;
}

async function canonicalizeFilePath(filePath: string): Promise<string> {
  const resolvedPath = path.resolve(filePath);
  try {
    return await fs.realpath(resolvedPath);
  } catch {
    return resolvedPath;
  }
}
