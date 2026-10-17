import * as vscode from 'vscode';
import { Logger } from '../utils/logger';
import { MetadataTreeLifecycle } from './metadataTreeLifecycle';

export interface MetadataWorkspaceFolderLifecycle {
  /** Marks discovery as intentional and delegates to the metadata lifecycle. */
  loadMetadataTree(): Promise<void>;
  /** Stops new discovery and waits for every load already admitted by this wrapper. */
  dispose(): Promise<void>;
}

/** Keep metadata roots and watcher ownership aligned with multi-root workspace changes. */
export function registerMetadataWorkspaceFolderLifecycle(
  lifecycle: Pick<MetadataTreeLifecycle, 'loadMetadataTree'>
): MetadataWorkspaceFolderLifecycle {
  let initialized = false;
  let disposed = false;
  let disposePromise: Promise<void> | null = null;
  const pendingLoads = new Set<Promise<void>>();

  const loadMetadataTree = (): Promise<void> => {
    if (disposed) {
      return Promise.reject(new Error('Metadata workspace lifecycle is disposed.'));
    }

    const pending = Promise.resolve().then(() => lifecycle.loadMetadataTree());
    pendingLoads.add(pending);
    void pending.then(
      () => pendingLoads.delete(pending),
      () => pendingLoads.delete(pending),
    );
    return pending;
  };

  const subscription = vscode.workspace.onDidChangeWorkspaceFolders(() => {
    if (!initialized || disposed) {
      return;
    }
    void loadMetadataTree().catch((error) => {
      Logger.error('Metadata reload after workspace folder change failed', error);
    });
  });
  return {
    loadMetadataTree: async () => {
      initialized = true;
      await loadMetadataTree();
    },
    dispose: () => {
      if (disposePromise) {
        return disposePromise;
      }
      disposed = true;
      subscription.dispose();
      disposePromise = Promise.allSettled([...pendingLoads]).then(() => undefined);
      return disposePromise;
    },
  };
}
