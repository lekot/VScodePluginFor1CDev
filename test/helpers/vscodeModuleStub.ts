/**
 * Minimal `vscode` API surface for Node `runCore` when suites load `MetadataTreeDataProvider`
 * (matrix e2e and any future core test that imports `src/providers/treeDataProvider`).
 */
import * as path from 'path';
import Module = require('module');

const TreeItemCollapsibleState = {
  None: 0,
  Collapsed: 1,
  Expanded: 2,
} as const;

class TreeItem {
  label: string;
  collapsibleState: number;
  resourceUri?: { fsPath: string; scheme: string };
  constructor(label: string, collapsibleState: number) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

/** Достаточно для `instanceof` в `bindingStorage` и in-memory FS в тестах привязок. */
class FileSystemError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'FileSystemError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  static FileNotFound(messageOrUri?: string | { fsPath: string }): FileSystemError {
    let text = 'File not found';
    if (typeof messageOrUri === 'string') {
      text = messageOrUri;
    } else if (messageOrUri && typeof messageOrUri.fsPath === 'string') {
      text = messageOrUri.fsPath;
    }
    return new FileSystemError(text, 'FileNotFound');
  }
}

const Uri = {
  file: (fsPath: string) => ({ fsPath, scheme: 'file' as const }),
  joinPath: (base: { fsPath: string; scheme: string }, ...pathSegments: string[]) => {
    const joined = path.join(base.fsPath, ...pathSegments);
    return {
      fsPath: joined,
      scheme: base.scheme,
      toString: () => `file:///${joined.replace(/\\/g, '/')}`,
    };
  },
  // Minimal subset used by core tests:
  // - parse('file:///tmp/x') for equality checks via `toString()`
  // - `fsPath` extraction is best-effort and only for `file://` URIs.
  parse: (uri: string) => {
    const m = uri.match(/^file:\/\/\/(.*)$/);
    const fsPath = m ? `/${m[1]}` : uri;
    return {
      fsPath,
      scheme: 'file' as const,
      toString: () => uri,
    };
  },
};

class ThemeIcon {
  constructor(public readonly id: string) {}
}

class VSCodeEventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];
  readonly event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const i = this.listeners.indexOf(listener);
        if (i >= 0) {
          this.listeners.splice(i, 1);
        }
      },
    };
  };
  fire(data: T): void {
    for (const l of [...this.listeners]) {
      l(data);
    }
  }

  dispose(): void {
    this.listeners = [];
  }
}

/** Enough for `RolesRightsEditorProvider` and rights editor integration tests under runCore. */
const ExtensionMode = {
  Production: 1,
  Development: 2,
  Test: 3,
} as const;

const ViewColumn = {
  Active: -1,
  Beside: 2,
  One: 1,
  Two: 2,
  Three: 3,
  Four: 4,
  Five: 5,
  Six: 6,
  Seven: 7,
  Eight: 8,
  Nine: 9,
} as const;

/** Matches vscode.ColorThemeKind numeric values — used by formWebviewHtml under runCore. */
const ColorThemeKind = {
  Light: 1,
  Dark: 2,
  HighContrast: 3,
  HighContrastLight: 4,
} as const;

/** Минимальный enum для `withProgress` / WOW §2D раскатка. */
const ProgressLocation = {
  SourceControl: 1,
  Window: 10,
  Notification: 15,
} as const;

/** Mutable hooks for core tests (workspace keys, dialog results, command log). */
export const vscodeTestState = {
  workspaceConfig: {} as Record<string, unknown>,
  /** When set, `showInformationMessage` returns this instead of `undefined`. */
  informationMessageResult: undefined as string | undefined,
  executedCommands: [] as unknown[][],
  /** Captured messages (Infobase Manager / dialog tests). */
  warningLog: [] as string[],
  errorLog: [] as string[],
  /** Captured `showInformationMessage` primary text (core tests). */
  informationLog: [] as string[],
  /** Sequential return values for `showQuickPick` (shifted each call). */
  quickPickQueue: [] as unknown[],
  /** Sequential results for `showOpenDialog` (shifted each call). */
  openDialogQueue: [] as { fsPath: string; scheme: string }[][],
  /** Sequential results for `showInputBox` (shifted each call). */
  inputBoxQueue: [] as (string | undefined)[],
  /**
   * When `showInputBox` is called with `validateInput`, invalid queued values are skipped
   * (next queue value is tried), and each failure is recorded here — Infobase URL validation (WOW §3C).
   */
  inputBoxValidationFailures: [] as { attempted: string; message: string }[],
  /**
   * Optional per-call return values for `showWarningMessage` (shifted each call).
   * Use `undefined` to simulate dismiss / cancel. When empty, stub keeps legacy behavior.
   */
  warningMessageReturnQueue: [] as (string | undefined)[],
  /** URIs passed to `vscode.env.openExternal` (WOW platform / web infobase tests). */
  openExternalLog: [] as string[],
  /** When false, `openExternal` resolves to false. Default true. */
  openExternalResult: true,
  /**
   * Имитирует `vscode.workspace.getWorkspaceFolder` / multi-root (WOW §2C, tree binding lookup).
   * Пустой массив → папка не найдена, но вызов не падает.
   */
  mockWorkspaceFolders: [] as Array<{ name: string; index: number; uri: { fsPath: string; scheme: string } }>,
  onDidSaveDocumentListeners: [] as Array<(e: { uri: { fsPath: string } }) => void>,
  onDidChangeWorkspaceFoldersListeners: [] as Array<(e: unknown) => void>,
  /** Собранные строки `OutputChannel.appendLine` (ibcmd / раскатка). */
  outputChannelLines: [] as string[],
  /** Собранные фрагменты `OutputChannel.append`. */
  outputChannelChunks: [] as string[],
  /**
   * Подмена `vscode.version` (WOW deploy §2E: `vscodeSupportsDeployReadonlyLock`).
   * `undefined` → пустая строка в геттере (как отсутствие semver в стабе).
   */
  vscodeVersion: undefined as string | undefined,
  /**
   * Когда true, `workspace.getConfiguration(...).update('readonlyInclude', …)` бросает
   * (имитация отказа настроек workspace folder — WOW §2E block).
   */
  filesReadonlyIncludeUpdateThrows: false,
};

/** Для тестов синхронизации привязок (сохранение `.vscode/infobase-bindings.json`). */
export function fireWorkspaceDidSaveDocument(fsPath: string): void {
  const doc = { uri: Uri.file(fsPath) };
  for (const l of [...vscodeTestState.onDidSaveDocumentListeners]) {
    l(doc);
  }
}

export function fireWorkspaceFoldersChanged(): void {
  for (const l of [...vscodeTestState.onDidChangeWorkspaceFoldersListeners]) {
    l({});
  }
}

const windowStub = {
  createWebviewPanel: (): never => {
    throw new Error('vscode.window.createWebviewPanel: override in test');
  },
  showErrorMessage: async (message: string): Promise<undefined> => {
    vscodeTestState.errorLog.push(message);
    return undefined;
  },
  showInformationMessage: async (
    message: string,
    ..._items: string[]
  ): Promise<string | undefined> => {
    vscodeTestState.informationLog.push(message);
    if (vscodeTestState.informationMessageResult !== undefined) {
      return vscodeTestState.informationMessageResult;
    }
    return undefined;
  },
  /**
   * Matches VS Code overloads: (msg, ...items) or (msg, options, ...items).
   * Uses `informationMessageResult`: when set to a string, that button is chosen; when `undefined`, simulates dismiss.
   */
  showWarningMessage: async (
    message: string,
    arg2?: unknown,
    ...rest: string[]
  ): Promise<string | undefined> => {
    vscodeTestState.warningLog.push(message);
    if (vscodeTestState.warningMessageReturnQueue.length > 0) {
      return vscodeTestState.warningMessageReturnQueue.shift();
    }
    if (vscodeTestState.informationMessageResult !== undefined) {
      return vscodeTestState.informationMessageResult;
    }
    if (typeof arg2 === 'string') {
      return undefined;
    }
    return Promise.resolve(rest[0]);
  },
  showQuickPick: async (_items: unknown, _options?: unknown): Promise<unknown> => {
    if (vscodeTestState.quickPickQueue.length > 0) {
      return vscodeTestState.quickPickQueue.shift();
    }
    return undefined;
  },
  showOpenDialog: async (_options?: unknown): Promise<{ fsPath: string; scheme: string }[] | undefined> => {
    if (vscodeTestState.openDialogQueue.length > 0) {
      return vscodeTestState.openDialogQueue.shift();
    }
    return undefined;
  },
  showInputBox: async (options?: { validateInput?: (v: string) => string | null | undefined }): Promise<
    string | undefined
  > => {
    const validate = options?.validateInput;
    while (vscodeTestState.inputBoxQueue.length > 0) {
      const v = vscodeTestState.inputBoxQueue.shift();
      if (v === undefined) {
        return undefined;
      }
      if (validate) {
        const err = validate(v);
        if (err) {
          vscodeTestState.inputBoxValidationFailures.push({ attempted: v, message: err });
          continue;
        }
      }
      return v;
    }
    return undefined;
  },
  withProgress: async <R>(
    _options: { location?: unknown; title?: string; cancellable?: boolean },
    task: (
      progress: { report: (value: { message?: string; increment?: number }) => void },
      token: { isCancellationRequested: boolean; onCancellationRequested: () => { dispose: () => void } },
    ) => Thenable<R>,
  ): Promise<R> => {
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose: () => undefined }),
    };
    return await task({ report: () => undefined }, token);
  },
  setStatusBarMessage: (): { dispose: () => void } => ({ dispose: () => undefined }),
  createOutputChannel: (_name: string) => ({
    appendLine: (s: string) => {
      vscodeTestState.outputChannelLines.push(s);
    },
    append: (s: string) => {
      vscodeTestState.outputChannelChunks.push(s);
    },
    show: (_preserveFocus?: boolean) => undefined,
    dispose: () => undefined,
  }),
};

const workspaceStub = {
  getConfiguration: (_section?: string, _scope?: unknown) => ({
    get: <T>(section: string, defaultValue?: T) => {
      if (Object.prototype.hasOwnProperty.call(vscodeTestState.workspaceConfig, section)) {
        return vscodeTestState.workspaceConfig[section] as T;
      }
      return defaultValue as T;
    },
    update: async (key: string, value: unknown, _target?: unknown): Promise<void> => {
      if (key === 'readonlyInclude' && vscodeTestState.filesReadonlyIncludeUpdateThrows) {
        throw new Error('readonlyInclude update denied (test stub)');
      }
      if (value === undefined) {
        Reflect.deleteProperty(vscodeTestState.workspaceConfig, key);
      } else {
        vscodeTestState.workspaceConfig[key] = value;
      }
    },
  }),
  get workspaceFolders(): typeof vscodeTestState.mockWorkspaceFolders {
    return vscodeTestState.mockWorkspaceFolders;
  },
  getWorkspaceFolders: () => vscodeTestState.mockWorkspaceFolders,
  getWorkspaceFolder: (uri: { fsPath: string }) => {
    const u = path.normalize(uri.fsPath);
    for (const f of vscodeTestState.mockWorkspaceFolders) {
      const w = path.normalize(f.uri.fsPath);
      if (u === w || u.startsWith(w + path.sep)) {
        return f;
      }
    }
    return undefined;
  },
  onDidSaveTextDocument: (listener: (e: { uri: { fsPath: string } }) => void) => {
    vscodeTestState.onDidSaveDocumentListeners.push(listener);
    return {
      dispose: () => {
        const i = vscodeTestState.onDidSaveDocumentListeners.indexOf(listener);
        if (i >= 0) {
          vscodeTestState.onDidSaveDocumentListeners.splice(i, 1);
        }
      },
    };
  },
  onDidChangeWorkspaceFolders: (listener: (e: unknown) => void) => {
    vscodeTestState.onDidChangeWorkspaceFoldersListeners.push(listener);
    return {
      dispose: () => {
        const i = vscodeTestState.onDidChangeWorkspaceFoldersListeners.indexOf(listener);
        if (i >= 0) {
          vscodeTestState.onDidChangeWorkspaceFoldersListeners.splice(i, 1);
        }
      },
    };
  },
};

/**
 * `bindingDialog` tests replace `workspaceFolders` via `Object.defineProperty`, which hides
 * the stub getter tied to `vscodeTestState.mockWorkspaceFolders`. Restore it on each reset.
 */
/** Сброс подмены `workspaceFolders` (см. bindingDialog tests / `defineProperty`). */
export function restoreVscodeWorkspaceFoldersGetter(): void {
  Reflect.deleteProperty(workspaceStub, 'workspaceFolders');
  Object.defineProperty(workspaceStub, 'workspaceFolders', {
    configurable: true,
    enumerable: true,
    get(): typeof vscodeTestState.mockWorkspaceFolders {
      return vscodeTestState.mockWorkspaceFolders;
    },
  });
}

export function resetVscodeTestState(): void {
  vscodeExtensionsTestState.getExtensionImpl = null;
  vscodeTestState.workspaceConfig = {};
  vscodeTestState.vscodeVersion = undefined;
  vscodeTestState.filesReadonlyIncludeUpdateThrows = false;
  vscodeTestState.informationMessageResult = undefined;
  vscodeTestState.executedCommands = [];
  vscodeTestState.warningLog = [];
  vscodeTestState.errorLog = [];
  vscodeTestState.informationLog = [];
  vscodeTestState.quickPickQueue = [];
  vscodeTestState.openDialogQueue = [];
  vscodeTestState.inputBoxQueue = [];
  vscodeTestState.inputBoxValidationFailures = [];
  vscodeTestState.warningMessageReturnQueue = [];
  vscodeTestState.openExternalLog = [];
  vscodeTestState.openExternalResult = true;
  vscodeTestState.mockWorkspaceFolders = [];
  vscodeTestState.onDidSaveDocumentListeners = [];
  vscodeTestState.onDidChangeWorkspaceFoldersListeners = [];
  vscodeTestState.outputChannelLines = [];
  vscodeTestState.outputChannelChunks = [];
  restoreVscodeWorkspaceFoldersGetter();
}

/** Shared by core tests; `import * as vscode` binds getters to these objects. */
const commandsStub = {
  registerCommand: (_id: string, _callback?: unknown): { dispose: () => void } => ({
    dispose: () => undefined,
  }),
  executeCommand: async (...args: unknown[]): Promise<unknown> => {
    vscodeTestState.executedCommands.push(args);
    return undefined;
  },
};

const envStub = {
  openExternal: async (target: { toString(): string }): Promise<boolean> => {
    vscodeTestState.openExternalLog.push(target.toString());
    return Boolean(vscodeTestState.openExternalResult);
  },
};

/** Минимальная реализация для `BindingDialogPanel.dispose` и др. */
const Disposable = {
  from: (...disposables: Array<{ dispose: () => void } | undefined>): { dispose: () => void } => ({
    dispose: () => {
      for (const d of disposables) {
        d?.dispose();
      }
    },
  }),
};

const ConfigurationTarget = {
  Global: 1,
  Workspace: 2,
  WorkspaceFolder: 3,
} as const;

/** Optional override for suites that exercise `vscode.extensions.getExtension` (e.g. git integration). */
export const vscodeExtensionsTestState: {
  getExtensionImpl: ((_id: string) => { activate(): Promise<unknown> } | undefined) | null;
} = {
  getExtensionImpl: null,
};

const vscodeStub = {
  TreeItemCollapsibleState,
  TreeItem,
  Uri,
  ColorThemeKind,
  ConfigurationTarget,
  get version(): string {
    return vscodeTestState.vscodeVersion ?? '';
  },
  FileSystemError,
  ThemeIcon,
  EventEmitter: VSCodeEventEmitter,
  ExtensionMode,
  ViewColumn,
  ProgressLocation,
  commands: commandsStub,
  env: envStub,
  Disposable,
  window: windowStub,
  workspace: workspaceStub,
  extensions: {
    getExtension: <T>(id: string): { activate(): Promise<unknown>; exports: T } | undefined => {
      const impl = vscodeExtensionsTestState.getExtensionImpl;
      if (impl) {
        return impl(id) as { activate(): Promise<unknown>; exports: T } | undefined;
      }
      return undefined;
    },
  },
};

let installed = false;

export function installVscodeModuleStubForCoreTests(): void {
  if (installed) {
    return;
  }
  installed = true;
  const orig = Module.prototype.require;
  Module.prototype.require = function (this: NodeModule, id: string) {
    if (id === 'vscode') {
      return vscodeStub;
    }
    return orig.apply(this, [id]) as object;
  };
}
