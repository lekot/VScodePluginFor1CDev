import * as assert from 'assert';
import * as path from 'path';
import { tmpdir } from 'os';
import * as vscode from 'vscode';
import { parseBindingsFileJson, serializeBindingsFileJson } from '../../src/bindings/bindingFileCodec';
import { INFOBASE_BINDINGS_FILE_NAME } from '../../src/bindings/bindingConstants';
import {
  bindingsFileUri,
  readBindingsForFolder,
  writeBindingsForFolder,
} from '../../src/bindings/bindingStorage';
import type { ConfigurationBinding } from '../../src/bindings/models/configurationBinding';

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
    async createDirectory(): Promise<void> {},
  } as unknown as vscode.FileSystem;
}

suite('bindingFileCodec', () => {
  test('round-trip', () => {
    const root = {
      schemaVersion: 1 as const,
      bindings: [
        {
          workspaceFolder: 'proj',
          configRelativePath: 'src/Configuration.xml',
          infobaseIds: ['a', 'b'],
          massDeployment: true,
        },
      ],
    };
    const text = serializeBindingsFileJson(root);
    const back = parseBindingsFileJson(text);
    assert.deepStrictEqual(back, root);
  });

  test('drops invalid entries and keeps valid', () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      bindings: [
        { workspaceFolder: '', configRelativePath: 'x', infobaseIds: [], massDeployment: false },
        { workspaceFolder: 'ok', configRelativePath: 'c.xml', infobaseIds: ['id1'], massDeployment: false },
        'broken',
      ],
    });
    const parsed = parseBindingsFileJson(text);
    assert.strictEqual(parsed.bindings.length, 1);
    assert.strictEqual(parsed.bindings[0].workspaceFolder, 'ok');
  });

  test('invalid json returns empty', () => {
    const parsed = parseBindingsFileJson('{');
    assert.strictEqual(parsed.bindings.length, 0);
    assert.strictEqual(parsed.schemaVersion, 1);
  });

  test('unsupported schemaVersion yields empty bindings', () => {
    const parsed = parseBindingsFileJson(
      JSON.stringify({
        schemaVersion: 2,
        bindings: [{ workspaceFolder: 'x', configRelativePath: 'c.xml', infobaseIds: [], massDeployment: false }],
      }),
    );
    assert.strictEqual(parsed.schemaVersion, 1);
    assert.deepStrictEqual(parsed.bindings, []);
  });

  test('missing bindings property yields empty list', () => {
    const parsed = parseBindingsFileJson(JSON.stringify({ schemaVersion: 1 }));
    assert.deepStrictEqual(parsed.bindings, []);
  });

  test('non-array bindings yields empty list', () => {
    const parsed = parseBindingsFileJson(JSON.stringify({ schemaVersion: 1, bindings: {} }));
    assert.deepStrictEqual(parsed.bindings, []);
  });

  test('skips non-string infobaseIds entries', () => {
    const parsed = parseBindingsFileJson(
      JSON.stringify({
        schemaVersion: 1,
        bindings: [
          {
            workspaceFolder: 'p',
            configRelativePath: 'c.xml',
            infobaseIds: ['ok', 1, null, '', 'z'],
            massDeployment: false,
          },
        ],
      }),
    );
    assert.deepStrictEqual(parsed.bindings[0].infobaseIds, ['ok', 'z']);
  });
});

suite('bindingStorage read/write', () => {
  test('bindingsFileUri points under .vscode with expected file name', () => {
    const folder: vscode.WorkspaceFolder = {
      name: 'proj',
      index: 0,
      uri: vscode.Uri.file(path.join('C:', 'workspace', 'my-proj')),
    };
    const u = bindingsFileUri(folder);
    const norm = u.fsPath.replace(/\\/g, '/');
    assert.ok(norm.includes('/.vscode/'));
    assert.ok(norm.endsWith(`/.vscode/${INFOBASE_BINDINGS_FILE_NAME}`));
  });

  test('readBindingsForFolder returns empty when file is missing', async () => {
    const fs = createMemoryFs();
    const folder: vscode.WorkspaceFolder = {
      name: 'ws',
      index: 0,
      uri: vscode.Uri.file(path.join(tmpdir(), `binding-read-miss-${Date.now()}`)),
    };
    const list = await readBindingsForFolder(fs, folder);
    assert.deepStrictEqual(list, []);
  });

  test('readBindingsForFolder returns empty on non-FileSystemError read failure', async () => {
    const fs = {
      async readFile(): Promise<Uint8Array> {
        throw new Error('simulated read failure');
      },
      async writeFile(): Promise<void> {},
      async createDirectory(): Promise<void> {},
    } as unknown as vscode.FileSystem;
    const folder: vscode.WorkspaceFolder = {
      name: 'ws',
      index: 0,
      uri: vscode.Uri.file(path.join(tmpdir(), 'binding-read-err')),
    };
    const list = await readBindingsForFolder(fs, folder);
    assert.deepStrictEqual(list, []);
  });

  test('writeBindingsForFolder then readBindingsForFolder round-trip', async () => {
    const fs = createMemoryFs();
    const folder: vscode.WorkspaceFolder = {
      name: 'ws',
      index: 0,
      uri: vscode.Uri.file(path.join(tmpdir(), `binding-rt-${Date.now()}`)),
    };
    const bindings: ConfigurationBinding[] = [
      {
        workspaceFolder: 'ws',
        configRelativePath: 'src/Configuration.xml',
        infobaseIds: ['ib-1'],
        massDeployment: true,
      },
    ];
    await writeBindingsForFolder(fs, folder, bindings);
    const back = await readBindingsForFolder(fs, folder);
    assert.deepStrictEqual(back, bindings);
  });
});
