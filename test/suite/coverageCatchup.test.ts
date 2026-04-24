import * as assert from 'assert';
import * as path from 'path';

import { installVscodeModuleStubForCoreTests } from '../helpers/vscodeModuleStub';
import { MetadataType } from '../../src/models/treeNode';
import {
  getKnownPropertyNamesForType,
  getPropertySectionsForType,
  DEFAULT_SECTION_TITLE,
} from '../../src/constants/propertySections';
import { isValidWebviewMessage } from '../../src/providers/propertiesWebviewTypes';
import {
  buildInfobaseConfigApplyArgs,
  buildInfobaseConfigExportStatusArgs,
  buildInfobaseConfigImportFilesArgs,
} from '../../src/services/ibcmd/ibcmdInfobaseConfigArgs';
import { randomIbcmdTempSuffix } from '../../src/services/ibcmd/ibcmdOfflineDataDir';
import {
  detectChangedConfigFiles,
  type GitRepository,
} from '../../src/services/ibcmd/incrementalChangeDetector';
import type { InfobaseEntry } from '../../src/infobases/models/infobaseEntry';

installVscodeModuleStubForCoreTests();
const {
  isTreeEntryArg,
  isTreeFolderArg,
  touchLastUsed,
} = require('../../src/infobases/infobaseCommandsShared') as typeof import('../../src/infobases/infobaseCommandsShared');

const DATA = path.resolve('/tmp/ibcmd-data');

suite('coverage catch-up for pure helpers', () => {
  test('property sections return configured and fallback sections', () => {
    const catalogSections = getPropertySectionsForType(MetadataType.Catalog);
    assert.ok(catalogSections.some((s) => s.title === 'Основные'));

    const fallback = getPropertySectionsForType(MetadataType.CommonModule);
    assert.deepStrictEqual(fallback, [{ title: DEFAULT_SECTION_TITLE, propertyNames: [] }]);
  });

  test('known property names are collected per metadata type', () => {
    const catalogNames = getKnownPropertyNamesForType(MetadataType.Catalog);
    assert.ok(catalogNames.has('Name'));
    assert.ok(catalogNames.has('CodeLength'));

    const unknownNames = getKnownPropertyNamesForType(MetadataType.CommonModule);
    assert.strictEqual(unknownNames.size, 0);
  });

  test('properties webview message guard accepts known message types only', () => {
    assert.strictEqual(isValidWebviewMessage({ type: 'save', properties: {} }), true);
    assert.strictEqual(isValidWebviewMessage({ type: 'gotoEventHandler', handlerName: 'X', docUri: 'file:///x' }), true);
    assert.strictEqual(isValidWebviewMessage({ type: 'unknown' }), false);
    assert.strictEqual(isValidWebviewMessage(null), false);
    assert.strictEqual(isValidWebviewMessage({}), false);
  });

  test('ibcmd apply args include non-interactive safety flags', () => {
    const args = buildInfobaseConfigApplyArgs(
      { kind: 'yaml', absoluteConfigPath: '/cfg/ib.yaml', offlineDataDir: DATA },
      { extension: 'Ext1', credentials: { user: 'Admin', password: 'secret' } },
    );

    assert.deepStrictEqual(args, [
      'infobase',
      'config',
      'apply',
      '--config=/cfg/ib.yaml',
      '--user=Admin',
      '--password=secret',
      `--data=${DATA}`,
      '--extension=Ext1',
      '--force',
      '--session-terminate=force',
    ]);
  });

  test('ibcmd import files args keep file list before base dir', () => {
    const args = buildInfobaseConfigImportFilesArgs(
      { kind: 'fileDb', dbCatalogPath: '/ib', offlineDataDir: DATA },
      ['Catalogs/A.xml', 'Catalogs/A/Ext/ObjectModule.bsl'],
      '/dump',
      { noCheck: true },
    );

    assert.deepStrictEqual(args, [
      'infobase',
      'config',
      'import',
      'files',
      '--db-path=/ib',
      `--data=${DATA}`,
      '--no-check',
      'Catalogs/A.xml',
      'Catalogs/A/Ext/ObjectModule.bsl',
      '--base-dir=/dump',
    ]);
  });

  test('ibcmd export status args include base and short flags', () => {
    const args = buildInfobaseConfigExportStatusArgs(
      { kind: 'yaml', absoluteConfigPath: '/cfg/ib.yaml', offlineDataDir: DATA },
      '/dump/ConfigDumpInfo.xml',
      { extension: 'Ext1', short: true },
    );

    assert.ok(args.includes('--config=/cfg/ib.yaml'));
    assert.ok(args.includes(`--data=${DATA}`));
    assert.ok(args.includes('--extension=Ext1'));
    assert.ok(args.includes('--base=/dump/ConfigDumpInfo.xml'));
    assert.ok(args.includes('--short'));
  });

  test('ibcmd temp suffix is hex and changes between calls', () => {
    const first = randomIbcmdTempSuffix();
    const second = randomIbcmdTempSuffix();

    assert.match(first, /^[0-9a-f]{16}$/);
    assert.match(second, /^[0-9a-f]{16}$/);
    assert.notStrictEqual(first, second);
  });

  test('tree argument guards distinguish folder and entry payloads', () => {
    assert.strictEqual(isTreeFolderArg({ kind: 'folder', folder: { id: 'f1', name: 'Folder' } }), true);
    assert.strictEqual(isTreeFolderArg({ kind: 'folder', folder: {} }), false);
    assert.strictEqual(isTreeEntryArg({ kind: 'entry', entry: { id: 'e1' } }), true);
    assert.strictEqual(isTreeEntryArg({ kind: 'entry' }), false);
  });

  test('touchLastUsed upserts entry with updated timestamp', async () => {
    const entry: InfobaseEntry = {
      id: 'e1',
      name: 'Demo',
      type: 'file',
      filePath: '/ib',
      ibcmdConfigYamlPath: '/ib/ib.yaml',
      hasStoredPassword: false,
      createdAt: '2020-01-01T00:00:00.000Z',
    };
    let saved: InfobaseEntry | undefined;
    const storage = {
      async upsert(next: InfobaseEntry): Promise<void> {
        saved = next;
      },
    };

    await touchLastUsed(storage as never, entry);

    assert.strictEqual(saved?.id, entry.id);
    assert.ok(saved?.lastUsedAt);
    assert.notStrictEqual(saved?.lastUsedAt, entry.lastUsedAt);
  });

  test('detectChangedConfigFiles filters by root, extension and scope', async () => {
    const root = path.resolve('/repo/conf');
    const repo: GitRepository = {
      rootUri: { fsPath: path.resolve('/repo') },
      state: {
        workingTreeChanges: [
          { uri: { fsPath: path.join(root, 'Catalogs', 'A.xml') } },
          { uri: { fsPath: path.join(root, 'Catalogs', 'A', 'Ext', 'ObjectModule.bsl') } },
          { uri: { fsPath: path.resolve('/repo/readme.md') } },
        ],
        indexChanges: [
          { uri: { fsPath: path.join(root, 'CommonModules', 'M.os') } },
        ],
        mergeChanges: [
          { uri: { fsPath: path.resolve('/outside/Other.xml') } },
        ],
      },
    };

    const working = await detectChangedConfigFiles(root, { getGitRepository: () => repo });
    assert.ok(!('error' in working));
    if (!('error' in working)) {
      assert.deepStrictEqual(working.relativePaths, [
        'Catalogs/A.xml',
        'Catalogs/A/Ext/ObjectModule.bsl',
      ]);
      assert.strictEqual(working.skippedCount, 2);
    }

    const staged = await detectChangedConfigFiles(root, { getGitRepository: () => repo }, { scope: 'staged' });
    assert.ok(!('error' in staged));
    if (!('error' in staged)) {
      assert.deepStrictEqual(staged.relativePaths, ['CommonModules/M.os']);
      assert.strictEqual(staged.source, 'git-staged');
    }
  });
});
