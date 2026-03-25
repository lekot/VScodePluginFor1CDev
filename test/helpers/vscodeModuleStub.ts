/**
 * Minimal `vscode` API surface for Node `runCore` when suites load `MetadataTreeDataProvider`
 * (matrix e2e and any future core test that imports `src/providers/treeDataProvider`).
 */
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

const Uri = {
  file: (fsPath: string) => ({ fsPath, scheme: 'file' as const }),
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

const windowStub = {
  createWebviewPanel: (): never => {
    throw new Error('vscode.window.createWebviewPanel: override in test');
  },
  showErrorMessage: async (): Promise<undefined> => undefined,
  showInformationMessage: async (): Promise<undefined> => undefined,
  showWarningMessage: async (
    _message: string,
    _options?: unknown,
    ...items: string[]
  ): Promise<string | undefined> => Promise.resolve(items[0]),
  setStatusBarMessage: (): { dispose: () => void } => ({ dispose: () => undefined }),
};

const workspaceStub = {
  getConfiguration: () => ({
    get: <T>(_section: string, defaultValue?: T) => defaultValue as T,
  }),
};

const vscodeStub = {
  TreeItemCollapsibleState,
  TreeItem,
  Uri,
  ThemeIcon,
  EventEmitter: VSCodeEventEmitter,
  ExtensionMode,
  ViewColumn,
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
