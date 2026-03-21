import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { MetadataWatcherService } from '../../src/services/metadataWatcherService';

suite('MetadataWatcherService', () => {
  let service: MetadataWatcherService;

  class FakeWatcher implements vscode.FileSystemWatcher {
    public ignoreCreateEvents = false;
    public ignoreChangeEvents = false;
    public ignoreDeleteEvents = false;
    private createHandlers: Array<(uri: vscode.Uri) => void> = [];
    private changeHandlers: Array<(uri: vscode.Uri) => void> = [];
    private deleteHandlers: Array<(uri: vscode.Uri) => void> = [];
    private disposed = false;

    public onDidCreate(listener: (e: vscode.Uri) => unknown): vscode.Disposable {
      this.createHandlers.push(listener);
      return { dispose: () => {} };
    }

    public onDidChange(listener: (e: vscode.Uri) => unknown): vscode.Disposable {
      this.changeHandlers.push(listener);
      return { dispose: () => {} };
    }

    public onDidDelete(listener: (e: vscode.Uri) => unknown): vscode.Disposable {
      this.deleteHandlers.push(listener);
      return { dispose: () => {} };
    }

    public emitCreate(uri: vscode.Uri): void {
      this.createHandlers.forEach((h) => h(uri));
    }

    public emitChange(uri: vscode.Uri): void {
      this.changeHandlers.forEach((h) => h(uri));
    }

    public emitDelete(uri: vscode.Uri): void {
      this.deleteHandlers.forEach((h) => h(uri));
    }

    public dispose(): void {
      this.disposed = true;
    }

    public isDisposed(): boolean {
      return this.disposed;
    }
  }

  const sleep = async (ms: number): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  };

  const normalizePathForCompare = (p: string): string => {
    const normalized = path.normalize(p).replace(/\\/g, '/');
    return normalized.replace(/^([A-Za-z]):\//, (_, drive: string) => `${drive.toLowerCase()}:/`);
  };

  setup(() => {
    service = new MetadataWatcherService();
  });

  teardown(() => {
    service.dispose();
  });

  test('start then stop does not throw', () => {
    const configRoot = path.join(os.tmpdir(), '1cviewer-watcher-test');
    let onTreeReloadCalls = 0;
    service.start(configRoot, {
      onTreeReload: () => {
        onTreeReloadCalls += 1;
      },
    });
    service.stop();
    assert.strictEqual(onTreeReloadCalls, 0);
  });

  test('dispose cleans up', () => {
    const configRoot = path.join(os.tmpdir(), '1cviewer-watcher-test');
    service.start(configRoot, { onTreeReload: () => {} });
    service.dispose();
    // Second dispose is no-op
    service.dispose();
  });

  test('debounce batches burst change events into single reload', async () => {
    const configRoot = path.join(os.tmpdir(), '1cviewer-watcher-burst');
    const originalCreate = vscode.workspace.createFileSystemWatcher;
    const fakeWatcher = new FakeWatcher();
    (vscode.workspace as any).createFileSystemWatcher = () => fakeWatcher;

    try {
      let reloads = 0;
      let changedPath = '';
      service.start(configRoot, {
        onTreeReload: () => {
          reloads += 1;
        },
        onFileChanged: (p) => {
          changedPath = p;
        },
      });

      fakeWatcher.emitChange(vscode.Uri.file(path.join(configRoot, 'Catalogs', 'A.xml')));
      fakeWatcher.emitCreate(vscode.Uri.file(path.join(configRoot, 'Catalogs', 'B.xml')));
      fakeWatcher.emitDelete(vscode.Uri.file(path.join(configRoot, 'Catalogs', 'C.xml')));

      await sleep(650);

      assert.strictEqual(reloads, 1, 'Burst events should produce one tree reload');
      assert.strictEqual(
        normalizePathForCompare(changedPath),
        normalizePathForCompare(path.join(configRoot, 'Catalogs', 'C.xml')),
        'onFileChanged should receive last changed path from burst'
      );
    } finally {
      (vscode.workspace as any).createFileSystemWatcher = originalCreate;
    }
  });

  test('conflicting external changes flush separately outside debounce window', async () => {
    const configRoot = path.join(os.tmpdir(), '1cviewer-watcher-conflict');
    const originalCreate = vscode.workspace.createFileSystemWatcher;
    const fakeWatcher = new FakeWatcher();
    (vscode.workspace as any).createFileSystemWatcher = () => fakeWatcher;

    try {
      let reloads = 0;
      const changedPaths: string[] = [];
      service.start(configRoot, {
        onTreeReload: () => {
          reloads += 1;
        },
        onFileChanged: (p) => {
          changedPaths.push(normalizePathForCompare(p));
        },
      });

      const first = path.join(configRoot, 'Catalogs', 'ConflictA.xml');
      const second = path.join(configRoot, 'Catalogs', 'ConflictB.xml');

      fakeWatcher.emitChange(vscode.Uri.file(first));
      await sleep(650);
      fakeWatcher.emitChange(vscode.Uri.file(second));
      await sleep(650);

      assert.strictEqual(reloads, 2, 'Separated external changes should trigger two reloads');
      assert.deepStrictEqual(changedPaths, [
        normalizePathForCompare(first),
        normalizePathForCompare(second),
      ]);
    } finally {
      (vscode.workspace as any).createFileSystemWatcher = originalCreate;
    }
  });

  test('stop prevents pending debounced reload from firing', async () => {
    const configRoot = path.join(os.tmpdir(), '1cviewer-watcher-stop');
    const originalCreate = vscode.workspace.createFileSystemWatcher;
    const fakeWatcher = new FakeWatcher();
    (vscode.workspace as any).createFileSystemWatcher = () => fakeWatcher;

    try {
      let reloads = 0;
      service.start(configRoot, {
        onTreeReload: () => {
          reloads += 1;
        },
      });

      fakeWatcher.emitChange(vscode.Uri.file(path.join(configRoot, 'Catalogs', 'A.xml')));
      service.stop();
      await sleep(650);

      assert.strictEqual(reloads, 0, 'Pending reload must be cancelled on stop');
      assert.strictEqual(fakeWatcher.isDisposed(), true, 'Watcher should be disposed on stop');
    } finally {
      (vscode.workspace as any).createFileSystemWatcher = originalCreate;
    }
  });
});
