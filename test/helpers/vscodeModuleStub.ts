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

class Position {
  constructor(
    public readonly line: number,
    public readonly character: number,
  ) {}
}

class Range {
  public readonly start: Position;
  public readonly end: Position;
  constructor(startOrLine: Position | number, startCharOrEnd?: Position | number, endLine?: number, endCharacter?: number) {
    if (startOrLine instanceof Position) {
      this.start = startOrLine;
      this.end = startCharOrEnd instanceof Position ? startCharOrEnd : startOrLine;
    } else {
      this.start = new Position(startOrLine as number, startCharOrEnd as number);
      this.end = new Position(endLine ?? startOrLine as number, endCharacter ?? startCharOrEnd as number);
    }
  }
}

class Location {
  public readonly range: Range;
  constructor(
    public readonly uri: { fsPath: string; scheme: string },
    rangeOrPosition: Range | Position,
  ) {
    if (rangeOrPosition instanceof Position) {
      this.range = new Range(rangeOrPosition, rangeOrPosition);
    } else {
      this.range = rangeOrPosition;
    }
  }
}

class Breakpoint {
  public id: string = '';
  public verified: boolean = false;
  constructor(
    public readonly enabled: boolean = true,
    public readonly condition?: string,
    public readonly hitCondition?: string,
    public readonly logMessage?: string,
  ) {}
}

class SourceBreakpoint extends Breakpoint {
  constructor(
    public readonly location: Location,
    enabled?: boolean,
    condition?: string,
    hitCondition?: string,
    logMessage?: string,
  ) {
    super(enabled ?? true, condition, hitCondition, logMessage);
  }
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

// ─── vscode.debug stub ───────────────────────────────────────────────────────

/** Mutable state for vscode.debug stub — reset in teardown. */
export const debugTestState = {
  startDebuggingResult: true,
  startDebuggingCalled: false,
  startDebuggingArgs: undefined as unknown[] | undefined,
  stopDebuggingCalled: false,
  stopDebuggingSession: undefined as unknown,
  onDidStartDebugSessionListeners: [] as Array<(s: unknown) => void>,
  onDidTerminateDebugSessionListeners: [] as Array<(s: unknown) => void>,
  registeredTrackerFactories: [] as Array<{ type: string; factory: unknown }>,
  // Breakpoints state
  breakpoints: [] as any[],
  bpIdCounter: 0,
  bpListeners: [] as Array<(e: { added: any[]; removed: any[]; changed: any[] }) => void>,
  // Session mock for customRequest
  mockSession: null as {
    customRequest: (command: string, args?: unknown) => Promise<unknown>;
  } | null,
};

export function resetDebugTestState(): void {
  debugTestState.startDebuggingResult = true;
  debugTestState.startDebuggingCalled = false;
  debugTestState.startDebuggingArgs = undefined;
  debugTestState.stopDebuggingCalled = false;
  debugTestState.stopDebuggingSession = undefined;
  debugTestState.onDidStartDebugSessionListeners = [];
  debugTestState.onDidTerminateDebugSessionListeners = [];
  debugTestState.registeredTrackerFactories = [];
  debugTestState.breakpoints = [];
  debugTestState.bpIdCounter = 0;
  debugTestState.bpListeners = [];
  debugTestState.mockSession = null;
}

/** Fire onDidStartDebugSession event for all listeners. */
export function fireDidStartDebugSession(session: unknown): void {
  for (const l of [...debugTestState.onDidStartDebugSessionListeners]) {
    l(session);
  }
}

/** Fire onDidTerminateDebugSession event for all listeners. */
export function fireDidTerminateDebugSession(session: unknown): void {
  for (const l of [...debugTestState.onDidTerminateDebugSessionListeners]) {
    l(session);
  }
}

/**
 * Fires onDidChangeBreakpoints with changed event to simulate verified status update.
 * Sets bp.verified and fires changed event.
 */
export function fireBreakpointVerified(bp: any, verified: boolean): void {
  bp.verified = verified;
  const event = { added: [], removed: [], changed: [bp] };
  for (const l of [...debugTestState.bpListeners]) {
    l(event);
  }
}

/**
 * Creates a mock session with configurable customRequest behavior.
 * Use setNextCustomRequestResponse() or setCustomRequestHandler() to control responses.
 */
let _nextCustomRequestResponse: unknown = undefined;
let _nextCustomRequestIsError = false;
let _customRequestHandler: ((command: string, args?: unknown) => Promise<unknown>) | null = null;

export function setNextCustomRequestResponse(response: unknown, isError = false): void {
  _nextCustomRequestResponse = response;
  _nextCustomRequestIsError = isError;
  _customRequestHandler = null;
}

export function setCustomRequestHandler(fn: (command: string, args?: unknown) => Promise<unknown>): void {
  _customRequestHandler = fn;
  _nextCustomRequestResponse = undefined;
  _nextCustomRequestIsError = false;
}

export function resetCustomRequestState(): void {
  _nextCustomRequestResponse = undefined;
  _nextCustomRequestIsError = false;
  _customRequestHandler = null;
}

/** Creates a mock DebugSession with controllable customRequest. */
export function makeMockSession(id: string, type = 'bsl'): {
  id: string;
  type: string;
  name: string;
  workspaceFolder: undefined;
  configuration: Record<string, unknown>;
  customRequest: (command: string, args?: unknown) => Promise<unknown>;
  lastCustomRequest: { command: string; args: unknown } | null;
} {
  const session = {
    id,
    type,
    name: `mock-session-${id}`,
    workspaceFolder: undefined as undefined,
    configuration: {} as Record<string, unknown>,
    lastCustomRequest: null as { command: string; args: unknown } | null,
    customRequest: async (command: string, args?: unknown): Promise<unknown> => {
      session.lastCustomRequest = { command, args: args ?? null };
      if (_customRequestHandler) {
        return _customRequestHandler(command, args);
      }
      if (_nextCustomRequestIsError) {
        const err = new Error(String(_nextCustomRequestResponse));
        _nextCustomRequestResponse = undefined;
        _nextCustomRequestIsError = false;
        throw err;
      }
      if (_nextCustomRequestResponse !== undefined) {
        const resp = _nextCustomRequestResponse;
        _nextCustomRequestResponse = undefined;
        return resp;
      }
      throw new Error(`customRequest '${command}' not configured in test`);
    },
  };
  return session;
}

const debugStub = {
  startDebugging: async (_folder: unknown, _config: unknown): Promise<boolean> => {
    debugTestState.startDebuggingCalled = true;
    debugTestState.startDebuggingArgs = [_folder, _config];
    return debugTestState.startDebuggingResult;
  },
  stopDebugging: async (session: unknown): Promise<void> => {
    debugTestState.stopDebuggingCalled = true;
    debugTestState.stopDebuggingSession = session;
  },
  onDidStartDebugSession: (listener: (s: unknown) => void): { dispose: () => void } => {
    debugTestState.onDidStartDebugSessionListeners.push(listener);
    return {
      dispose: () => {
        const i = debugTestState.onDidStartDebugSessionListeners.indexOf(listener);
        if (i >= 0) { debugTestState.onDidStartDebugSessionListeners.splice(i, 1); }
      },
    };
  },
  onDidTerminateDebugSession: (listener: (s: unknown) => void): { dispose: () => void } => {
    debugTestState.onDidTerminateDebugSessionListeners.push(listener);
    return {
      dispose: () => {
        const i = debugTestState.onDidTerminateDebugSessionListeners.indexOf(listener);
        if (i >= 0) { debugTestState.onDidTerminateDebugSessionListeners.splice(i, 1); }
      },
    };
  },
  registerDebugAdapterTrackerFactory: (type: string, factory: unknown): { dispose: () => void } => {
    debugTestState.registeredTrackerFactories.push({ type, factory });
    return { dispose: () => undefined };
  },
  addBreakpoints: (bps: any[]): void => {
    const added: any[] = [];
    for (const bp of bps) {
      if (!bp.id) {
        bp.id = String(++debugTestState.bpIdCounter);
      }
      debugTestState.breakpoints.push(bp);
      added.push(bp);
    }
    const event = { added, removed: [], changed: [] };
    for (const l of [...debugTestState.bpListeners]) {
      l(event);
    }
  },
  removeBreakpoints: (bps: any[]): void => {
    const removed: any[] = [];
    for (const bp of bps) {
      const i = debugTestState.breakpoints.indexOf(bp);
      if (i >= 0) {
        debugTestState.breakpoints.splice(i, 1);
        removed.push(bp);
      }
    }
    if (removed.length > 0) {
      const event = { added: [], removed, changed: [] };
      for (const l of [...debugTestState.bpListeners]) {
        l(event);
      }
    }
  },
  get breakpoints(): any[] {
    return [...debugTestState.breakpoints];
  },
  onDidChangeBreakpoints: (cb: (e: { added: any[]; removed: any[]; changed: any[] }) => void): { dispose: () => void } => {
    debugTestState.bpListeners.push(cb);
    return {
      dispose: () => {
        const i = debugTestState.bpListeners.indexOf(cb);
        if (i >= 0) { debugTestState.bpListeners.splice(i, 1); }
      },
    };
  },
};

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
  Position,
  Range,
  Location,
  Breakpoint,
  SourceBreakpoint,
  commands: commandsStub,
  env: envStub,
  Disposable,
  window: windowStub,
  workspace: workspaceStub,
  debug: debugStub,
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
