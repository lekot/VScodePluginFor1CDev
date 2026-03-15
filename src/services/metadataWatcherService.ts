import * as path from 'path';
import * as vscode from 'vscode';
import { Logger } from '../utils/logger';

const DEBOUNCE_MS = 500; // Increased from 400ms for better batching during git operations

export interface MetadataWatcherCallbacks {
  onTreeReload: () => void;
  onFileChanged?: (changedFilePath: string) => void;
}

/**
 * Watches XML files in configuration root and triggers tree reload (with debounce)
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

  /**
   * Start watching XML files under configRoot (pattern: all .xml in subdirs).
   * Callbacks are invoked after debounce period to batch multiple changes.
   */
  start(configRoot: string, callbacks: MetadataWatcherCallbacks): void {
    this.stop();
    this.callbacks = callbacks;

    const pattern = new vscode.RelativePattern(vscode.Uri.file(configRoot), '**/*.xml');
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const scheduleReload = (uri: vscode.Uri) => {
      const fsPath = path.normalize(uri.fsPath);
      this.lastChangedPath = fsPath;
      this.changedPaths.add(fsPath);
      Logger.debug('XML change detected (debouncing)', { path: fsPath, totalChanges: this.changedPaths.size });

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
    const changeCount = this.changedPaths.size;
    
    this.lastChangedPath = undefined;
    this.changedPaths.clear();

    if (!callbacks) {
      return;
    }

    try {
      Logger.info('Reloading tree after file changes', { changedFiles: changeCount });
      callbacks.onTreeReload();
      if (lastPath && callbacks.onFileChanged) {
        callbacks.onFileChanged(lastPath);
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
