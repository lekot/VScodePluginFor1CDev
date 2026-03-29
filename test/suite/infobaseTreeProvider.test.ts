import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  InfobaseTreeDataProvider,
  infobaseEntryDescription,
  INFOBASE_TREE_VIEW_ID,
} from '../../src/infobases/infobaseTreeProvider';
import type { InfobaseEntry, InfobaseFolder } from '../../src/infobases/models/infobaseEntry';
import type { InfobaseStorageService } from '../../src/infobases/infobaseStorageService';

function entry(overrides: Partial<InfobaseEntry> & Pick<InfobaseEntry, 'id' | 'name' | 'type'>): InfobaseEntry {
  return {
    hasStoredPassword: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

suite('infobaseEntryDescription', () => {
  test('file uses filePath or yaml path', () => {
    assert.strictEqual(
      infobaseEntryDescription(
        entry({
          id: 'a',
          name: 'N',
          type: 'file',
          filePath: 'C:\\Bases\\Demo',
        }),
      ),
      'C:\\Bases\\Demo',
    );
    assert.strictEqual(
      infobaseEntryDescription(
        entry({
          id: 'b',
          name: 'N',
          type: 'file',
          ibcmdConfigYamlPath: 'D:\\cfg\\ib.yaml',
        }),
      ),
      'D:\\cfg\\ib.yaml',
    );
  });

  test('server combines server and database', () => {
    assert.strictEqual(
      infobaseEntryDescription(
        entry({
          id: 'c',
          name: 'N',
          type: 'server',
          server: 'srv',
          database: 'ref',
        }),
      ),
      'srv:ref',
    );
  });

  test('web uses url', () => {
    assert.strictEqual(
      infobaseEntryDescription(
        entry({
          id: 'd',
          name: 'N',
          type: 'web',
          webUrl: 'https://1c.example/x',
        }),
      ),
      'https://1c.example/x',
    );
  });

  test('file prefers filePath over ibcmd yaml when both set', () => {
    assert.strictEqual(
      infobaseEntryDescription(
        entry({
          id: 'e',
          name: 'N',
          type: 'file',
          filePath: 'C:\\first',
          ibcmdConfigYamlPath: 'D:\\second.yaml',
        }),
      ),
      'C:\\first',
    );
  });

  test('file description empty when no path fields', () => {
    assert.strictEqual(
      infobaseEntryDescription(entry({ id: 'f', name: 'N', type: 'file' })),
      '',
    );
  });

  test('server uses single side when other missing', () => {
    assert.strictEqual(
      infobaseEntryDescription(entry({ id: 'g', name: 'N', type: 'server', server: 'onlySrv' })),
      'onlySrv',
    );
    assert.strictEqual(
      infobaseEntryDescription(entry({ id: 'h', name: 'N', type: 'server', database: 'onlyDb' })),
      'onlyDb',
    );
  });

  test('server description empty when server and database missing', () => {
    assert.strictEqual(
      infobaseEntryDescription(entry({ id: 'i', name: 'N', type: 'server' })),
      '',
    );
  });

  test('web description empty when url missing', () => {
    assert.strictEqual(infobaseEntryDescription(entry({ id: 'j', name: 'N', type: 'web' })), '');
  });
});

function mockStorage(
  loadEntries: InfobaseEntry[] | (() => Promise<InfobaseEntry[]>),
  loadFolders: InfobaseFolder[] | (() => Promise<InfobaseFolder[]>) = [],
): InfobaseStorageService {
  const load = typeof loadEntries === 'function' ? loadEntries : async () => loadEntries;
  const lf = typeof loadFolders === 'function' ? loadFolders : async () => loadFolders;
  return { load, loadFolders: lf } as unknown as InfobaseStorageService;
}

suite('InfobaseTreeDataProvider', () => {
  test('exposes Explorer view id from package.json', () => {
    assert.strictEqual(INFOBASE_TREE_VIEW_ID, '1c-infobase-manager');
  });

  test('root children are folders root then three type groups', async () => {
    const storage = mockStorage([]);
    const p = new InfobaseTreeDataProvider(storage);
    const root = await p.getChildren();
    assert.deepStrictEqual(
      root.map((n) => {
        if (n.kind === 'foldersRoot') {
          return 'foldersRoot';
        }
        return n.kind === 'group' ? n.group : 'x';
      }),
      ['foldersRoot', 'file', 'server', 'web'],
    );
  });

  test('group lists entries of that type only', async () => {
    const storage = mockStorage([
      entry({ id: '1', name: 'F', type: 'file', filePath: '/a' }),
      entry({ id: '2', name: 'S', type: 'server', server: 'x', database: 'y' }),
      entry({ id: '3', name: 'W', type: 'web', webUrl: 'http://z' }),
    ]);
    const p = new InfobaseTreeDataProvider(storage);
    const fileGroup = (await p.getChildren())[1];
    assert.strictEqual(fileGroup.kind, 'group');
    const fileKids = await p.getChildren(fileGroup);
    assert.strictEqual(fileKids.length, 1);
    assert.strictEqual(fileKids[0].kind, 'entry');
    if (fileKids[0].kind === 'entry') {
      assert.strictEqual(fileKids[0].entry.name, 'F');
    }
  });

  test('group children are sorted by name', async () => {
    const storage = mockStorage([
      entry({ id: 'b', name: 'Beta', type: 'file', filePath: '/b' }),
      entry({ id: 'a', name: 'Alpha', type: 'file', filePath: '/a' }),
    ]);
    const p = new InfobaseTreeDataProvider(storage);
    const fileGroup = (await p.getChildren())[1];
    const kids = await p.getChildren(fileGroup);
    assert.strictEqual(kids.length, 2);
    assert.ok(kids[0].kind === 'entry' && kids[1].kind === 'entry');
    if (kids[0].kind === 'entry' && kids[1].kind === 'entry') {
      assert.strictEqual(kids[0].entry.name, 'Alpha');
      assert.strictEqual(kids[1].entry.name, 'Beta');
    }
  });

  test('group children empty when load throws', async () => {
    const storage = mockStorage(async () => {
      throw new Error('disk');
    });
    const p = new InfobaseTreeDataProvider(storage);
    const fileGroup = (await p.getChildren())[1];
    const kids = await p.getChildren(fileGroup);
    assert.deepStrictEqual(kids, []);
  });

  test('getTreeItem sets contextValue for menus and inline actions', async () => {
    const storage = mockStorage([entry({ id: '1', name: 'F', type: 'file', filePath: '/tmp/ib' })]);
    const p = new InfobaseTreeDataProvider(storage);
    const root = await p.getChildren();
    const foldersRootItem = p.getTreeItem(root[0]);
    assert.strictEqual(foldersRootItem.contextValue, 'infobaseFoldersRoot');
    const fileGroup = root[1];
    const groupItem = p.getTreeItem(fileGroup);
    assert.ok(groupItem.contextValue?.startsWith('infobaseGroup'));
    const kids = await p.getChildren(fileGroup);
    const leaf = p.getTreeItem(kids[0]);
    assert.strictEqual(leaf.contextValue, 'infobaseFile');
  });

  test('getParent maps entry back to its type group', async () => {
    const storage = mockStorage([]);
    const p = new InfobaseTreeDataProvider(storage);
    const node = {
      kind: 'entry' as const,
      entry: entry({ id: '1', name: 'S', type: 'server', server: 'a', database: 'b' }),
    };
    const parent = p.getParent(node);
    assert.ok(parent && typeof parent === 'object' && 'kind' in parent);
    if (parent && typeof parent === 'object' && 'kind' in parent && parent.kind === 'group') {
      assert.strictEqual(parent.group, 'server');
    }
  });

  test('group tree item is expanded folder with ThemeIcon', () => {
    const storage = mockStorage([]);
    const p = new InfobaseTreeDataProvider(storage);
    const item = p.getTreeItem({ kind: 'group', group: 'file' });
    assert.strictEqual(item.collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
    assert.ok(item.iconPath instanceof vscode.ThemeIcon);
  });

  test('group labels and contextValue match type for server and web', () => {
    const storage = mockStorage([]);
    const p = new InfobaseTreeDataProvider(storage);
    const srv = p.getTreeItem({ kind: 'group', group: 'server' });
    assert.ok(String(srv.label).includes('Серверные'));
    assert.strictEqual(srv.contextValue, 'infobaseGroupServer');
    const web = p.getTreeItem({ kind: 'group', group: 'web' });
    assert.ok(String(web.label).includes('Веб'));
    assert.strictEqual(web.contextValue, 'infobaseGroupWeb');
  });

  test('entry tree items use infobaseServer and infobaseWeb contextValue', () => {
    const storage = mockStorage([]);
    const p = new InfobaseTreeDataProvider(storage);
    const sItem = p.getTreeItem({
      kind: 'entry',
      entry: entry({ id: 's', name: 'Srv', type: 'server', server: 'a', database: 'b' }),
    });
    assert.strictEqual(sItem.contextValue, 'infobaseServer');
    const wItem = p.getTreeItem({
      kind: 'entry',
      entry: entry({ id: 'w', name: 'W', type: 'web', webUrl: 'http://x' }),
    });
    assert.strictEqual(wItem.contextValue, 'infobaseWeb');
  });

  test('file entry sets resourceUri when filePath present', () => {
    const storage = mockStorage([]);
    const p = new InfobaseTreeDataProvider(storage);
    const item = p.getTreeItem({
      kind: 'entry',
      entry: entry({ id: 'f', name: 'F', type: 'file', filePath: '/tmp/ib' }),
    });
    assert.ok(item.resourceUri);
    assert.strictEqual(item.resourceUri?.fsPath.replace(/\\/g, '/'), '/tmp/ib');
  });

  test('file entry omits resourceUri without filePath', () => {
    const storage = mockStorage([]);
    const p = new InfobaseTreeDataProvider(storage);
    const item = p.getTreeItem({
      kind: 'entry',
      entry: entry({ id: 'f', name: 'F', type: 'file', ibcmdConfigYamlPath: '/x.yaml' }),
    });
    assert.strictEqual(item.resourceUri, undefined);
  });

  test('tooltip lists primary fields per entry type', () => {
    const storage = mockStorage([]);
    const p = new InfobaseTreeDataProvider(storage);
    const fileTip = p.getTreeItem({
      kind: 'entry',
      entry: entry({
        id: '1',
        name: 'MyIb',
        type: 'file',
        filePath: '/data/ib',
        ibcmdConfigYamlPath: '/cfg/y.yaml',
      }),
    }).tooltip as string;
    assert.ok(fileTip.includes('MyIb'));
    assert.ok(fileTip.includes('Путь: /data/ib'));
    assert.ok(fileTip.includes('YAML ibcmd: /cfg/y.yaml'));
    const srvTip = p.getTreeItem({
      kind: 'entry',
      entry: entry({
        id: '2',
        name: 'SrvIb',
        type: 'server',
        server: 'host',
        database: 'db',
        user: 'u1',
      }),
    }).tooltip as string;
    assert.ok(srvTip.includes('SrvIb'));
    assert.ok(srvTip.includes('Srvr="host"'));
    assert.ok(srvTip.includes('Ref="db"'));
    assert.ok(srvTip.includes('Usr="u1"'));
    const webTip = p.getTreeItem({
      kind: 'entry',
      entry: entry({ id: '3', name: 'WebIb', type: 'web', webUrl: 'https://a/b' }),
    }).tooltip as string;
    assert.ok(webTip.includes('URL: https://a/b'));
  });

  test('getChildren on entry node returns empty', async () => {
    const storage = mockStorage([]);
    const p = new InfobaseTreeDataProvider(storage);
    const leaf: { kind: 'entry'; entry: InfobaseEntry } = {
      kind: 'entry',
      entry: entry({ id: 'x', name: 'L', type: 'file', filePath: '/p' }),
    };
    assert.deepStrictEqual(await p.getChildren(leaf), []);
  });

  test('getParent returns undefined for group nodes', () => {
    const storage = mockStorage([]);
    const p = new InfobaseTreeDataProvider(storage);
    assert.strictEqual(p.getParent({ kind: 'group', group: 'file' }), undefined);
  });

  test('refresh fires onDidChangeTreeData', () => {
    const storage = mockStorage([]);
    const p = new InfobaseTreeDataProvider(storage);
    let fires = 0;
    const sub = p.onDidChangeTreeData(() => {
      fires += 1;
    });
    p.refresh();
    sub.dispose();
    assert.strictEqual(fires, 1);
  });

  test('group shows no children when storage returns empty', async () => {
    const storage = mockStorage([]);
    const p = new InfobaseTreeDataProvider(storage);
    const fileGroup = (await p.getChildren())[1];
    assert.deepStrictEqual(await p.getChildren(fileGroup), []);
  });

  test('sorting is case-insensitive by base letter', async () => {
    const storage = mockStorage([
      entry({ id: 'b', name: 'beta', type: 'file', filePath: '/b' }),
      entry({ id: 'a', name: 'Alpha', type: 'file', filePath: '/a' }),
    ]);
    const p = new InfobaseTreeDataProvider(storage);
    const fileGroup = (await p.getChildren())[1];
    const kids = await p.getChildren(fileGroup);
    assert.ok(kids[0].kind === 'entry' && kids[1].kind === 'entry');
    if (kids[0].kind === 'entry' && kids[1].kind === 'entry') {
      assert.strictEqual(kids[0].entry.name, 'Alpha');
      assert.strictEqual(kids[1].entry.name, 'beta');
    }
  });

  test('foldersRoot lists only top-level folders sorted by name', async () => {
    const folders: InfobaseFolder[] = [
      { id: 'a', name: 'Zeta' },
      { id: 'b', name: 'Alpha', parentId: 'a' },
    ];
    const storage = mockStorage([], folders);
    const p = new InfobaseTreeDataProvider(storage);
    const root = await p.getChildren();
    const fr = root[0];
    assert.strictEqual(fr.kind, 'foldersRoot');
    const kids = await p.getChildren(fr);
    assert.strictEqual(kids.length, 1);
    assert.ok(kids[0].kind === 'folder' && kids[0].folder.name === 'Zeta');
  });

  test('type group hides entries assigned to a folder', async () => {
    const storage = mockStorage(
      [
        entry({ id: '1', name: 'RootFile', type: 'file', filePath: '/r' }),
        entry({ id: '2', name: 'InFolder', type: 'file', filePath: '/f', folderId: 'fld' }),
      ],
      [{ id: 'fld', name: 'F' }],
    );
    const p = new InfobaseTreeDataProvider(storage);
    const groups = await p.getChildren();
    const fileGroup = groups[1];
    const kids = await p.getChildren(fileGroup);
    assert.strictEqual(kids.length, 1);
    assert.ok(kids[0].kind === 'entry' && kids[0].entry.name === 'RootFile');
  });

  test('folder node lists child folders then sorted entries', async () => {
    const storage = mockStorage(
      [
        entry({ id: '1', name: 'B', type: 'file', filePath: '/b', folderId: 'parent' }),
        entry({ id: '2', name: 'A', type: 'file', filePath: '/a', folderId: 'parent' }),
      ],
      [
        { id: 'parent', name: 'P' },
        { id: 'sub', name: 'S', parentId: 'parent' },
      ],
    );
    const p = new InfobaseTreeDataProvider(storage);
    const foldersRoot = (await p.getChildren())[0];
    const top = await p.getChildren(foldersRoot);
    const parentFolder = top[0];
    assert.ok(parentFolder.kind === 'folder');
    const inner = await p.getChildren(parentFolder);
    assert.strictEqual(inner.length, 3);
    assert.ok(inner[0].kind === 'folder' && inner[0].folder.name === 'S');
    assert.ok(inner[1].kind === 'entry' && inner[1].entry.name === 'A');
    assert.ok(inner[2].kind === 'entry' && inner[2].entry.name === 'B');
  });

  test('getParent maps entry with folderId to folder node', async () => {
    const storage = mockStorage(
      [entry({ id: 'e1', name: 'InF', type: 'file', filePath: '/f', folderId: 'fld' })],
      [{ id: 'fld', name: 'Box' }],
    );
    const p = new InfobaseTreeDataProvider(storage);
    const leaf = { kind: 'entry' as const, entry: (await storage.load())[0] };
    const par = await p.getParent(leaf);
    assert.ok(par && par.kind === 'folder' && par.folder.id === 'fld');
  });

  test('getParent maps nested folder to parent folder', async () => {
    const storage = mockStorage(
      [],
      [
        { id: 'root', name: 'R' },
        { id: 'child', name: 'C', parentId: 'root' },
      ],
    );
    const p = new InfobaseTreeDataProvider(storage);
    const childNode = { kind: 'folder' as const, folder: { id: 'child', name: 'C', parentId: 'root' } };
    const par = await p.getParent(childNode);
    assert.ok(par && par.kind === 'folder' && par.folder.id === 'root');
  });

  test('getParent maps top-level folder to foldersRoot', async () => {
    const storage = mockStorage([], [{ id: 'top', name: 'T' }]);
    const p = new InfobaseTreeDataProvider(storage);
    const node = { kind: 'folder' as const, folder: { id: 'top', name: 'T' } };
    const par = await p.getParent(node);
    assert.ok(par && par.kind === 'foldersRoot');
  });

  test('getParent for entry with unknown folderId resolves to undefined', async () => {
    const storage = mockStorage(
      [entry({ id: 'e1', name: 'Orphan', type: 'file', filePath: '/x', folderId: 'missing' })],
      [],
    );
    const p = new InfobaseTreeDataProvider(storage);
    const leaf = { kind: 'entry' as const, entry: (await storage.load())[0] };
    const par = await p.getParent(leaf);
    assert.strictEqual(par, undefined);
  });

  test('getParent for folder with missing parentId falls back to foldersRoot', async () => {
    const storage = mockStorage([], []);
    const p = new InfobaseTreeDataProvider(storage);
    const node = { kind: 'folder' as const, folder: { id: 'ghost', name: 'G', parentId: 'nope' } };
    const par = await p.getParent(node);
    assert.ok(par && par.kind === 'foldersRoot');
  });
});

suite('Infobase Manager package.json (Explorer view & menus)', () => {
  function readPackageJson(): { contributes: Record<string, unknown> } {
    const pkgPath = path.join(__dirname, '..', '..', '..', 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf8');
    return JSON.parse(raw) as { contributes: Record<string, unknown> };
  }

  test('registers 1c-infobase-manager view under explorer', () => {
    const { contributes } = readPackageJson();
    const views = contributes.views as { explorer?: { id: string; name: string }[] };
    const list = views.explorer ?? [];
    const v = list.find((x) => x.id === INFOBASE_TREE_VIEW_ID);
    assert.ok(v, 'explorer view id must match INFOBASE_TREE_VIEW_ID');
    assert.ok(v!.name.length > 0);
  });

  test('view/title and inline menus target 1c-infobase-manager and viewItem patterns', () => {
    const { contributes } = readPackageJson();
    const menus = contributes.menus as Record<string, { when?: string; command: string }[]>;
    const title = menus['view/title'] ?? [];
    assert.ok(
      title.some((m) => m.when === `view == ${INFOBASE_TREE_VIEW_ID}` && m.command.includes('infobases.')),
      'view/title should scope infobase commands to the tree view',
    );
    const inline = menus['view/item/context'] ?? [];
    const enterprise = inline.find((m) => m.command === '1c-metadata-tree.infobase.openEnterprise');
    assert.ok(enterprise?.when?.includes(INFOBASE_TREE_VIEW_ID));
    assert.ok(enterprise?.when?.includes('infobase(File|Server|Web)'));
  });
});
