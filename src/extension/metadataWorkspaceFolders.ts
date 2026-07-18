import * as vscode from 'vscode';
import { Logger } from '../utils/logger';
import { MetadataTreeLifecycle } from './metadataTreeLifecycle';

export interface MetadataWorkspaceFolderLifecycle extends vscode.Disposable {
  /** Marks discovery as intentional and delegates to the metadata lifecycle. */
  loadMetadataTree(): Promise<void>;
}

/** Keep metadata roots and watcher ownership aligned with multi-root workspace changes. */
export function registerMetadataWorkspaceFolderLifecycle(
  lifecycle: Pick<MetadataTreeLifecycle, 'loadMetadataTree'>
): MetadataWorkspaceFolderLifecycle {
  let initialized = false;
  const subscription = vscode.workspace.onDidChangeWorkspaceFolders(() => {
    if (!initialized) {
      return;
    }
    void lifecycle.loadMetadataTree().catch((error) => {
      Logger.error('Metadata reload after workspace folder change failed', error);
    });
  });
  return {
    loadMetadataTree: async () => {
      initialized = true;
      await lifecycle.loadMetadataTree();
    },
    dispose: () => {
      subscription.dispose();
    },
  };
}
