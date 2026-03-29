import * as assert from 'assert';
import * as path from 'path';
import { tmpdir } from 'os';
import * as vscode from 'vscode';
import { BindingManager } from '../../src/bindings/bindingManager';
import type { ConfigurationBinding } from '../../src/bindings/models/configurationBinding';

/** Минимальная реализация для `BindingManager`: нужны только read/write/createDirectory. */
function createMemoryFs(): vscode.FileSystem {
  const map = new Map<string, Uint8Array>();
  return {
    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
      const v = map.get(uri.fsPath);
      if (!v) {
        throw vscode.FileSystemError.FileNotFound(uri);
      }
      return v;
    },
    async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
      map.set(uri.fsPath, Buffer.from(content));
    },
    async createDirectory(): Promise<void> {
      /* bindingStorage вызывает перед записью; каталоги в памяти не моделируем */
    },
  } as unknown as vscode.FileSystem;
}

suite('BindingManager', () => {
  const root = path.join(tmpdir(), '1cviewer-binding-manager-core');
  const folder: vscode.WorkspaceFolder = {
    name: 'bind-ws',
    index: 0,
    uri: vscode.Uri.file(root),
  };

  function makeManager(fs: vscode.FileSystem): BindingManager {
    return new BindingManager({
      fileSystem: fs,
      getWorkspaceFolders: () => [folder],
    });
  }

  test('upsert, get, delete', async () => {
    const fs = createMemoryFs();
    const m = makeManager(fs);
    const b: ConfigurationBinding = {
      workspaceFolder: folder.name,
      configRelativePath: 'src/Configuration.xml',
      infobaseIds: ['a', 'b'],
      massDeployment: true,
    };
    await m.upsert(b);
    const got = await m.get(folder.name, 'src/Configuration.xml');
    assert.ok(got);
    assert.deepStrictEqual(got!.infobaseIds, ['a', 'b']);
    assert.strictEqual(await m.delete(folder.name, 'src/Configuration.xml'), true);
    assert.strictEqual(await m.get(folder.name, 'src/Configuration.xml'), undefined);
  });

  test('upsert deduplicates infobaseIds preserving order', async () => {
    const fs = createMemoryFs();
    const m = makeManager(fs);
    await m.upsert({
      workspaceFolder: folder.name,
      configRelativePath: 'cfg/Configuration.xml',
      infobaseIds: ['x', 'x', 'y', 'x'],
      massDeployment: false,
    });
    const got = await m.get(folder.name, 'cfg/Configuration.xml');
    assert.deepStrictEqual(got!.infobaseIds, ['x', 'y']);
  });

  test('removeInfobaseFromAllBindings updates every binding that referenced the id', async () => {
    const fs = createMemoryFs();
    const m = makeManager(fs);
    await m.upsert({
      workspaceFolder: folder.name,
      configRelativePath: 'c1.xml',
      infobaseIds: ['x', 'y', 'z'],
      massDeployment: false,
    });
    await m.upsert({
      workspaceFolder: folder.name,
      configRelativePath: 'c2.xml',
      infobaseIds: ['y'],
      massDeployment: false,
    });
    const n = await m.removeInfobaseFromAllBindings('y');
    assert.strictEqual(n, 2);
    const all = await m.listAll();
    const c1 = all.find((x) => x.configRelativePath === 'c1.xml');
    const c2 = all.find((x) => x.configRelativePath === 'c2.xml');
    assert.deepStrictEqual(c1?.infobaseIds, ['x', 'z']);
    assert.deepStrictEqual(c2?.infobaseIds, []);
  });

  test('removeInfobaseFromAllBindings returns 0 for blank id', async () => {
    const m = makeManager(createMemoryFs());
    assert.strictEqual(await m.removeInfobaseFromAllBindings(''), 0);
    assert.strictEqual(await m.removeInfobaseFromAllBindings('   '), 0);
  });

  test('removeInfobaseFromAllBindings trims infobase id', async () => {
    const fs = createMemoryFs();
    const m = makeManager(fs);
    await m.upsert({
      workspaceFolder: folder.name,
      configRelativePath: 'c.xml',
      infobaseIds: ['trim-id'],
      massDeployment: false,
    });
    assert.strictEqual(await m.removeInfobaseFromAllBindings('  trim-id  '), 1);
    const got = await m.get(folder.name, 'c.xml');
    assert.deepStrictEqual(got!.infobaseIds, []);
  });

  test('listAll merges bindings from all workspace folders', async () => {
    const fs = createMemoryFs();
    const root1 = path.join(tmpdir(), `bm-m1-${Date.now()}`);
    const root2 = path.join(tmpdir(), `bm-m2-${Date.now()}`);
    const f1: vscode.WorkspaceFolder = { name: 'root-a', index: 0, uri: vscode.Uri.file(root1) };
    const f2: vscode.WorkspaceFolder = { name: 'root-b', index: 1, uri: vscode.Uri.file(root2) };
    const m = new BindingManager({
      fileSystem: fs,
      getWorkspaceFolders: () => [f1, f2],
    });
    await m.upsert({
      workspaceFolder: 'root-a',
      configRelativePath: 'a.xml',
      infobaseIds: [],
      massDeployment: false,
    });
    await m.upsert({
      workspaceFolder: 'root-b',
      configRelativePath: 'b.xml',
      infobaseIds: [],
      massDeployment: false,
    });
    const all = await m.listAll();
    assert.strictEqual(all.length, 2);
    assert.ok(all.some((x) => x.workspaceFolder === 'root-a' && x.configRelativePath === 'a.xml'));
    assert.ok(all.some((x) => x.workspaceFolder === 'root-b' && x.configRelativePath === 'b.xml'));
  });

  test('get returns undefined when workspace folder is unknown', async () => {
    const m = makeManager(createMemoryFs());
    assert.strictEqual(await m.get('no-such-folder', 'c.xml'), undefined);
  });

  test('get finds binding using normalized config path', async () => {
    const m = makeManager(createMemoryFs());
    await m.upsert({
      workspaceFolder: folder.name,
      configRelativePath: 'src/Configuration.xml',
      infobaseIds: ['q'],
      massDeployment: false,
    });
    const got = await m.get(folder.name, '.\\src\\Configuration.xml');
    assert.ok(got);
    assert.strictEqual(got!.configRelativePath, 'src/Configuration.xml');
    assert.deepStrictEqual(got!.infobaseIds, ['q']);
  });

  test('upsert throws when workspace folder is not in workspace', async () => {
    const m = makeManager(createMemoryFs());
    await assert.rejects(
      async () =>
        m.upsert({
          workspaceFolder: 'ghost',
          configRelativePath: 'c.xml',
          infobaseIds: [],
          massDeployment: false,
        }),
      (e: Error) => /Workspace folder not found/.test(e.message),
    );
  });

  test('upsert throws when workspaceFolder is blank', async () => {
    const m = makeManager(createMemoryFs());
    await assert.rejects(
      async () =>
        m.upsert({
          workspaceFolder: '   ',
          configRelativePath: 'c.xml',
          infobaseIds: [],
          massDeployment: false,
        }),
      (e: Error) => e.message.includes('workspaceFolder is required'),
    );
  });

  test('upsert throws when configRelativePath is blank', async () => {
    const m = makeManager(createMemoryFs());
    await assert.rejects(
      async () =>
        m.upsert({
          workspaceFolder: folder.name,
          configRelativePath: ' ',
          infobaseIds: [],
          massDeployment: false,
        }),
      (e: Error) => e.message.includes('configRelativePath is required'),
    );
  });

  test('delete returns false when binding is missing', async () => {
    const m = makeManager(createMemoryFs());
    assert.strictEqual(await m.delete(folder.name, 'missing.xml'), false);
  });

  test('delete returns false when workspace folder is unknown', async () => {
    const m = makeManager(createMemoryFs());
    assert.strictEqual(await m.delete('unknown-ws', 'c.xml'), false);
  });
});
