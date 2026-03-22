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

const vscodeStub = {
  TreeItemCollapsibleState,
  TreeItem,
  Uri,
  ThemeIcon,
  EventEmitter: VSCodeEventEmitter,
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
