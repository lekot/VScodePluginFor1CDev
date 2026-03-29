import * as assert from 'assert';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Memento, SecretStorage } from 'vscode';
import * as vscode from 'vscode';
import { DeployService } from '../../../src/bindings/deployService';
import type { ConfigurationBinding } from '../../../src/bindings/models/configurationBinding';
import { InfobaseStorageService } from '../../../src/infobases/infobaseStorageService';
import type { InfobaseEntry } from '../../../src/infobases/models/infobaseEntry';
import { getIbcmdService, resetIbcmdServiceSingletonForTests } from '../../../src/services/ibcmd/ibcmdServiceSingleton';

/**
 * Opt-in: `SMOKE_DEPLOY_BINDING=1`, workspace = корень репо (нужен `FormatSamples/empty_conf/Configuration.xml`).
 * Каталог ИБ: `SMOKE_DEPLOY_INFOBASE_PATH` или путь по умолчанию ниже.
 * `SMOKE_DEPLOY_IBCMD_YAML` — опционально явный `--config`; иначе, как в продукте, временный YAML из `filePath` записи.
 */
const CONFIG_RELATIVE = 'FormatSamples/empty_conf/Configuration.xml';

/** Default file-IB folder (Windows); override with `SMOKE_DEPLOY_INFOBASE_PATH`. */
const DEFAULT_SMOKE_INFOBASE_DIR = 'C:\\Users\\Максим\\Documents\\Infobase11';

class MapMemento implements Memento {
  private readonly map = new Map<string, unknown>();

  keys(): readonly string[] {
    return [...this.map.keys()];
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    if (this.map.has(key)) {
      return this.map.get(key) as T;
    }
    return defaultValue as T;
  }

  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) {
      this.map.delete(key);
    } else {
      this.map.set(key, value);
    }
    return Promise.resolve();
  }
}

class MapSecretStorage implements SecretStorage {
  private readonly values = new Map<string, string>();

  get onDidChange(): import('vscode').Event<{ key: string }> {
    return () => ({ dispose: () => undefined });
  }

  get(key: string): Thenable<string | undefined> {
    return Promise.resolve(this.values.get(key));
  }

  store(key: string, value: string): Thenable<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Thenable<void> {
    this.values.delete(key);
    return Promise.resolve();
  }

  keys(): Thenable<string[]> {
    return Promise.resolve([...this.values.keys()]);
  }
}

suite('Smoke: deployBinding real ibcmd (opt-in)', () => {
  test('full deploy pipeline: DeployService.deployBinding + ibcmd config import', async function () {
    if (process.env.SMOKE_DEPLOY_BINDING !== '1') {
      this.skip();
    }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      this.skip();
    }

    const workspaceFolderRoot = folders[0]!.uri.fsPath;
    const fixtureXml = path.join(workspaceFolderRoot, CONFIG_RELATIVE);
    if (!fs.existsSync(fixtureXml)) {
      this.skip();
    }

    const infobaseDirRaw = process.env.SMOKE_DEPLOY_INFOBASE_PATH?.trim() || DEFAULT_SMOKE_INFOBASE_DIR;
    const infobaseDir = path.resolve(infobaseDirRaw);
    if (!fs.existsSync(infobaseDir)) {
      this.skip();
    }

    resetIbcmdServiceSingletonForTests();
    const ibcmd = getIbcmdService();
    if (ibcmd.resolveExecutablePath().kind !== 'resolved') {
      this.skip();
    }

    this.timeout(300_000);

    const entryId = randomUUID();
    const entry: InfobaseEntry = {
      id: entryId,
      name: 'smoke-deploy-binding',
      type: 'file',
      filePath: infobaseDir,
      hasStoredPassword: false,
      createdAt: new Date().toISOString(),
    };

    const yamlOverride = process.env.SMOKE_DEPLOY_IBCMD_YAML?.trim();
    if (yamlOverride) {
      const absYaml = path.resolve(yamlOverride);
      if (fs.existsSync(absYaml)) {
        entry.ibcmdConfigYamlPath = absYaml;
      }
    }

    const memento = new MapMemento();
    const secrets = new MapSecretStorage();
    const storage = new InfobaseStorageService(memento, secrets);

    try {
      await storage.upsert(entry);
      const catalog = await storage.load();

      const binding: ConfigurationBinding = {
        workspaceFolder: folders[0]!.name,
        configRelativePath: CONFIG_RELATIVE,
        infobaseIds: [entryId],
        massDeployment: true,
      };

      const deployService = new DeployService();
      const tokenSource = new vscode.CancellationTokenSource();
      try {
        const summary = await deployService.deployBinding({
          binding,
          workspaceFolderRoot,
          storage,
          catalog,
          progress: { report: () => undefined },
          token: tokenSource.token,
        });

        assert.strictEqual(summary.errorCount, 0, JSON.stringify(summary.results, null, 2));
        assert.ok(summary.successCount >= 1, JSON.stringify(summary.results, null, 2));
        assert.strictEqual(summary.cancelledMidChain, false);

        for (const r of summary.results) {
          if (r.status === 'skipped') {
            continue;
          }
          assert.strictEqual(r.status, 'success', `${r.name}: ${r.message}`);
        }

        const ours = summary.results.filter((r) => r.infobaseId === entryId);
        assert.ok(ours.length >= 1);
        assert.ok(ours.some((r) => r.status === 'success'));
      } finally {
        tokenSource.dispose();
      }
    } finally {
      storage.dispose();
    }
  });
});
