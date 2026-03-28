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

/** Mutable hooks for core tests (workspace keys, dialog results, command log). */
export const vscodeTestState = {
  workspaceConfig: {} as Record<string, unknown>,
  /** When set, `showInformationMessage` returns this instead of `undefined`. */
  informationMessageResult: undefined as string | undefined,
  executedCommands: [] as unknown[][],
  /** Captured messages (Infobase Manager / dialog tests). */
  warningLog: [] as string[],
  errorLog: [] as string[],
  /** Sequential return values for `showQuickPick` (shifted each call). */
  quickPickQueue: [] as unknown[],
  /** Sequential results for `showOpenDialog` (shifted each call). */
  openDialogQueue: [] as { fsPath: string; scheme: string }[][],
  /** Sequential results for `showInputBox` (shifted each call). */
  inputBoxQueue: [] as (string | undefined)[],
  /**
   * Optional per-call return values for `showWarningMessage` (shifted each call).
   * Use `undefined` to simulate dismiss / cancel. When empty, stub keeps legacy behavior.
   */
  warningMessageReturnQueue: [] as (string | undefined)[],
  /** URIs passed to `vscode.env.openExternal` (WOW platform / web infobase tests). */
  openExternalLog: [] as string[],
  /** When false, `openExternal` resolves to false. Default true. */
  openExternalResult: true,
};

export function resetVscodeTestState(): void {
  vscodeTestState.workspaceConfig = {};
  vscodeTestState.informationMessageResult = undefined;
  vscodeTestState.executedCommands = [];
  vscodeTestState.warningLog = [];
  vscodeTestState.errorLog = [];
  vscodeTestState.quickPickQueue = [];
  vscodeTestState.openDialogQueue = [];
  vscodeTestState.inputBoxQueue = [];
  vscodeTestState.warningMessageReturnQueue = [];
  vscodeTestState.openExternalLog = [];
  vscodeTestState.openExternalResult = true;
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
    _message: string,
    ..._items: string[]
  ): Promise<string | undefined> => {
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
  showInputBox: async (_options?: unknown): Promise<string | undefined> => {
    if (vscodeTestState.inputBoxQueue.length > 0) {
      return vscodeTestState.inputBoxQueue.shift();
    }
    return undefined;
  },
  setStatusBarMessage: (): { dispose: () => void } => ({ dispose: () => undefined }),
};

const workspaceStub = {
  getConfiguration: () => ({
    get: <T>(section: string, defaultValue?: T) => {
      if (Object.prototype.hasOwnProperty.call(vscodeTestState.workspaceConfig, section)) {
        return vscodeTestState.workspaceConfig[section] as T;
      }
      return defaultValue as T;
    },
  }),
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

const vscodeStub = {
  TreeItemCollapsibleState,
  TreeItem,
  Uri,
  FileSystemError,
  ThemeIcon,
  EventEmitter: VSCodeEventEmitter,
  ExtensionMode,
  ViewColumn,
  commands: commandsStub,
  env: envStub,
  window: windowStub,
  workspace: workspaceStub,
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
