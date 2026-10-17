import * as vscode from 'vscode';
import { Logger } from '../../utils/logger';

export interface EditorSessionSnapshot<TTarget = unknown> {
  readonly sessionId: string;
  readonly generation: number;
  readonly target: TTarget;
}

export interface EditorSessionCoordinatorOptions<TTarget = unknown> {
  targetEquals?: (a: TTarget, b: TTarget) => boolean;
}

export interface BeginSessionOptions<TTarget = unknown> {
  panel?: vscode.WebviewPanel;
  target: TTarget;
  targetEquals?: (a: TTarget, b: TTarget) => boolean;
}

export class WebviewEditorSession<TTarget = unknown> implements vscode.Disposable {
  readonly id: string;
  readonly generation: number;
  readonly target: TTarget;
  private _panel: vscode.WebviewPanel | undefined;
  private _panelDisposable: vscode.Disposable | undefined;
  private _isDisposed = false;
  private _isSuperseded = false;
  private _saveInProgress = false;
  private readonly _disposables: vscode.Disposable[] = [];
  private readonly _cancellationSource = new vscode.CancellationTokenSource();

  constructor(
    private readonly coordinator: EditorSessionCoordinator<TTarget>,
    options: {
      id: string;
      generation: number;
      target: TTarget;
      panel?: vscode.WebviewPanel;
      targetEquals?: (a: TTarget, b: TTarget) => boolean;
    }
  ) {
    this.id = options.id;
    this.generation = options.generation;
    this.target = options.target;
    this.panel = options.panel;
  }

  get panel(): vscode.WebviewPanel | undefined {
    return this._panel;
  }

  set panel(p: vscode.WebviewPanel | undefined) {
    if (this._panel === p) {
      return;
    }
    if (this._panelDisposable) {
      this._panelDisposable.dispose();
      const idx = this._disposables.indexOf(this._panelDisposable);
      if (idx >= 0) {
        this._disposables.splice(idx, 1);
      }
      this._panelDisposable = undefined;
    }
    this._panel = p;

    if (this._panel) {
      this._panelDisposable = this._panel.onDidDispose(() => {
        this.dispose();
        if (this.coordinator.currentSession === this) {
          this.coordinator.clearActiveSession(this);
        }
      });
      this._disposables.push(this._panelDisposable);
    }
  }

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  get isSuperseded(): boolean {
    return this._isSuperseded;
  }

  get isSaveInProgress(): boolean {
    return this._saveInProgress;
  }

  get cancellationToken(): vscode.CancellationToken {
    return this._cancellationSource.token;
  }

  markSuperseded(): void {
    this._isSuperseded = true;
    try {
      this._cancellationSource.cancel();
    } catch {
      // ignore
    }
  }

  isCurrent(snapshot?: EditorSessionSnapshot<TTarget>): boolean {
    if (this._isDisposed || this._isSuperseded) {
      return false;
    }
    if (this.coordinator.currentSession !== this) {
      return false;
    }
    if (snapshot) {
      if (snapshot.generation !== this.generation || snapshot.sessionId !== this.id) {
        return false;
      }
    }
    return true;
  }

  snapshot(): EditorSessionSnapshot<TTarget> {
    return {
      sessionId: this.id,
      generation: this.generation,
      target: this.target,
    };
  }

  isCurrentMessage(message: unknown): boolean {
    if (!this.isCurrent()) {
      return false;
    }
    if (message && typeof message === 'object') {
      const msg = message as Record<string, unknown>;
      if (typeof msg['generation'] === 'number' && msg['generation'] !== this.generation) {
        return false;
      }
      if (typeof msg['sessionId'] === 'string' && msg['sessionId'] !== this.id) {
        return false;
      }
      const targetObj = typeof this.target === 'object' && this.target !== null ? this.target as Record<string, unknown> : undefined;
      if (typeof msg['filePath'] === 'string' && typeof targetObj?.filePath === 'string') {
        if (msg['filePath'] !== targetObj.filePath) {
          return false;
        }
      }
      if (typeof msg['schemaPath'] === 'string' && typeof targetObj?.schemaPath === 'string') {
        if (msg['schemaPath'] !== targetObj.schemaPath) {
          return false;
        }
      }
    }
    return true;
  }

  postMessage(message: unknown): boolean {
    if (!this.isCurrent() || !this._panel) {
      Logger.debug(`WebviewEditorSession: suppressed postMessage for stale or disposed session (gen ${this.generation}, id ${this.id})`);
      return false;
    }
    try {
      void this._panel.webview.postMessage(message);
      return true;
    } catch (err) {
      Logger.warn('WebviewEditorSession: failed to postMessage to webview', err);
      return false;
    }
  }

  beginSave(snapshot?: EditorSessionSnapshot<TTarget>): boolean {
    if (!this.isCurrent(snapshot) || this._saveInProgress) {
      return false;
    }
    this._saveInProgress = true;
    return true;
  }

  endSave(): void {
    this._saveInProgress = false;
  }

  async runGuardedSave<R>(
    snapshot: EditorSessionSnapshot<TTarget>,
    operation: (target: TTarget) => Promise<R>
  ): Promise<R | undefined> {
    if (!this.beginSave(snapshot)) {
      Logger.warn(`WebviewEditorSession: save rejected because session is not current or save is already in progress`);
      return undefined;
    }
    try {
      return await operation(snapshot.target);
    } finally {
      this.endSave();
    }
  }

  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    try {
      this._cancellationSource.cancel();
    } catch {
      // ignore
    }
    this._cancellationSource.dispose();
    for (const d of this._disposables) {
      d.dispose();
    }
    this._disposables.length = 0;
  }
}

export class EditorSessionCoordinator<TTarget = unknown> implements vscode.Disposable {
  private _currentSession: WebviewEditorSession<TTarget> | undefined;
  private _generationCounter = 0;
  private _sessionCounter = 0;
  private _disposed = false;

  constructor(private readonly options: EditorSessionCoordinatorOptions<TTarget> = {}) {}

  get currentSession(): WebviewEditorSession<TTarget> | undefined {
    return this._currentSession;
  }

  get generation(): number {
    return this._generationCounter;
  }

  begin(options: BeginSessionOptions<TTarget>): WebviewEditorSession<TTarget> {
    if (this._disposed) {
      throw new Error('Cannot begin session on disposed EditorSessionCoordinator');
    }
    if (this._currentSession) {
      this._currentSession.markSuperseded();
    }

    const generation = ++this._generationCounter;
    const sessionId = `session-${generation}-${++this._sessionCounter}-${Date.now()}`;

    const session = new WebviewEditorSession<TTarget>(this, {
      id: sessionId,
      generation,
      target: options.target,
      panel: options.panel,
      targetEquals: options.targetEquals ?? this.options.targetEquals,
    });

    this._currentSession = session;
    return session;
  }

  clearActiveSession(session: WebviewEditorSession<TTarget>): void {
    if (this._currentSession === session) {
      this._currentSession = undefined;
    }
  }

  bumpGeneration(): number {
    this._generationCounter++;
    if (this._currentSession) {
      this._currentSession.dispose();
      this._currentSession = undefined;
    }
    return this._generationCounter;
  }

  dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    this._generationCounter++;
    if (this._currentSession) {
      this._currentSession.dispose();
      this._currentSession = undefined;
    }
  }
}
