import * as path from 'path';
import * as vscode from 'vscode';
import { Logger } from '../utils/logger';

const DEBOUNCE_MS = 500; // Increased from 400ms for better batching during git operations

export interface MetadataWatcherCallbacks {
  onTreeReload: () => void;
  onFsMutationBatch?: (meta: {
    configPath: string;
    changedFiles: number;
    changedPaths: readonly string[];
    lastPath?: string;
  }) => void;
  onFilesChanged?: (changedFilePaths: readonly string[]) => void;
  /** @deprecated Prefer onFilesChanged for lossless batches. */
  onFileChanged?: (changedFilePath: string) => void;
}

/**
 * Watches parser-relevant Designer and EDT artifacts in a configuration root and triggers tree reload (with debounce)
 * and optional properties panel refresh when the current node's file changes.
 * 
 * Debouncing prevents excessive reloads during batch operations (e.g., git checkout).
 */
export class MetadataWatcherService implements vscode.Disposable {
  private watcher: vscode.FileSystemWatcher | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private lastChangedPath: string | undefined;
  private changedPaths: Set<string> = new Set();
  private callbacks: MetadataWatcherCallbacks | undefined;
  private configRoot: string | undefined;

  /**
   * Start watching XML, MDO, BSL, form, and tabular-document artifacts under configRoot.
   * Callbacks are invoked after debounce period to batch multiple changes.
   */
  start(configRoot: string, callbacks: MetadataWatcherCallbacks): void {
    this.stop();
    this.callbacks = callbacks;
    this.configRoot = path.normalize(configRoot);

    const pattern = new vscode.RelativePattern(
      vscode.Uri.file(configRoot),
      '**/*.{xml,mdo,bsl,form,mxl}'
    );
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const scheduleReload = (uri: vscode.Uri) => {
      const fsPath = path.normalize(uri.fsPath);
      this.lastChangedPath = fsPath;
      this.changedPaths.add(fsPath);
      Logger.debug('Metadata change detected (debouncing)', { path: fsPath, totalChanges: this.changedPaths.size });

      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }
      this.debounceTimer = setTimeout(() => this.flush(), DEBOUNCE_MS);
    };

    this.watcher.onDidCreate(scheduleReload);
    this.watcher.onDidChange(scheduleReload);
    this.watcher.onDidDelete(scheduleReload);

    Logger.info('MetadataWatcherService started', configRoot);
  }

  private flush(): void {
    this.debounceTimer = undefined;
    const callbacks = this.callbacks;
    const lastPath = this.lastChangedPath;
    const changedPaths = [...this.changedPaths];
    const changeCount = changedPaths.length;
    const configPath = this.configRoot;
    
    this.lastChangedPath = undefined;
    this.changedPaths.clear();

    if (!callbacks) {
      return;
    }

    try {
      Logger.info('Reloading tree after file changes', { changedFiles: changeCount });
      if (configPath && callbacks.onFsMutationBatch) {
        callbacks.onFsMutationBatch({ configPath, changedFiles: changeCount, changedPaths, lastPath });
      }
      callbacks.onTreeReload();
      callbacks.onFilesChanged?.(changedPaths);
      if (callbacks.onFileChanged) {
        for (const changedPath of changedPaths) {
          callbacks.onFileChanged(changedPath);
        }
      }
    } catch (error) {
      Logger.error('Error in MetadataWatcherService flush', error);
    }
  }

  /**
   * Stop watching and clear debounce timer.
   */
  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    this.lastChangedPath = undefined;
    this.configRoot = undefined;
    this.changedPaths.clear();
    this.callbacks = undefined;
    if (this.watcher) {
      this.watcher.dispose();
      this.watcher = undefined;
    }
    Logger.info('MetadataWatcherService stopped');
  }

  dispose(): void {
    this.stop();
  }
}
