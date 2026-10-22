import * as vscode from 'vscode';
import { Logger } from '../utils/logger';
import { MetadataTreeLifecycle } from './metadataTreeLifecycle';

export interface MetadataWorkspaceFolderLifecycle {
  /** Marks discovery as intentional and delegates to the metadata lifecycle. */
  loadMetadataTree(): Promise<void>;
  /** Closes workspace-change ingress synchronously. */
  stopAccepting(): void;
  /** Waits for loads already admitted while keeping the workspace lifecycle available until disposal. */
  quiesce(): Promise<void>;
  /** Stops new discovery and waits for every load already admitted by this wrapper. */
  dispose(): Promise<void>;
}

/** Keep metadata roots and watcher ownership aligned with multi-root workspace changes. */
export function registerMetadataWorkspaceFolderLifecycle(
  lifecycle: Pick<MetadataTreeLifecycle, 'loadMetadataTree'>
): MetadataWorkspaceFolderLifecycle {
  let initialized = false;
  let disposed = false;
  let quiescePromise: Promise<void> | null = null;
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
  const stopAccepting = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    try {
      subscription.dispose();
    } catch (error) {
      try {
        Logger.warn('Failed to stop metadata workspace folder listener', error);
      } catch {
        // Diagnostics must not prevent shutdown from fencing new workspace events.
      }
    }
  };
  const quiesce = (): Promise<void> => {
    if (!quiescePromise) {
      quiescePromise = Promise.resolve().then(async () => {
        while (pendingLoads.size > 0) {
          await Promise.allSettled([...pendingLoads]);
        }
      });
    }
    return quiescePromise;
  };
  return {
    loadMetadataTree: async () => {
      initialized = true;
      await loadMetadataTree();
    },
    stopAccepting,
    quiesce,
    dispose: () => {
      if (disposePromise) {
        return disposePromise;
      }
      // stopAccepting closes the event source before waiting for admitted work.
      stopAccepting();
      disposePromise = quiesce();
      return disposePromise;
    },
  };
}
