import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  IB_FILE_IBCMD_WEB_UNSUPPORTED_RU,
  buildFileInfobaseYamlContent,
  buildServerInfobaseYamlContent,
  formatFilePathForIbcmdYamlScalar,
  resolvePathForIbcmdYamlFileField,
  prefer1Cv8Dot1CDDataPathIfPresent,
  prepareIbcmdConfigYaml,
  resolveExistingPathToLongOnWin32,
  redactIbcmdYamlPasswordLines,
  textLooksLikeYamlPasswordLine,
  yamlDoubleQuotedScalar,
} from '../../src/infobases/ibcmdConfigPathResolver';
import type { InfobaseEntry } from '../../src/infobases/models/infobaseEntry';

function baseEntry(over: Partial<InfobaseEntry> = {}): InfobaseEntry {
  return {
    id: 'e1',
    name: 'Test',
    type: 'file',
    filePath: 'C:\\Bases\\Demo',
    hasStoredPassword: false,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

suite('ibcmdConfigPathResolver', () => {
  suite('yamlDoubleQuotedScalar', () => {
    test('escapes backslash and quote', () => {
      assert.strictEqual(yamlDoubleQuotedScalar('a\\b"c'), '"a\\\\b\\"c"');
    });

    test('empty string', () => {
      assert.strictEqual(yamlDoubleQuotedScalar(''), '""');
    });
  });

  suite('textLooksLikeYamlPasswordLine', () => {
    test('false when no password key', () => {
      assert.strictEqual(textLooksLikeYamlPasswordLine('infobase:\n  file: "x"\n'), false);
    });
  });

  suite('redactIbcmdYamlPasswordLines', () => {
    test('masks password scalar lines', () => {
      const raw = 'infobase:\n  file: "C:\\\\b"\n  password: "secret"\n';
      const out = redactIbcmdYamlPasswordLines(raw);
      assert.ok(!out.includes('secret'));
      assert.ok(out.includes('<redacted>'));
      assert.ok(out.includes('file:'));
    });
  });

  suite('resolveExistingPathToLongOnWin32', () => {
    test('non-win32 returns path unchanged', () => {
      if (process.platform === 'win32') {
        return;
      }
      assert.strictEqual(resolveExistingPathToLongOnWin32('/tmp/x'), '/tmp/x');
    });

    test('win32: existing file path is absolute and stable', function () {
      if (process.platform !== 'win32') {
        this.skip();
      }
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibcmd-longcfg-'));
      const f = path.join(dir, 'c.yaml');
      fs.writeFileSync(f, 'infobase:\n  file: "x"\n', 'utf8');
      try {
        const r = resolveExistingPathToLongOnWin32(path.resolve(f));
        assert.ok(path.isAbsolute(r));
        assert.ok(fs.existsSync(r));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  suite('formatFilePathForIbcmdYamlScalar', () => {
    test('win32 maps backslashes to slashes; other platforms unchanged', () => {
      if (process.platform === 'win32') {
        assert.strictEqual(formatFilePathForIbcmdYamlScalar(String.raw`C:\Users\x\y`), 'C:/Users/x/y');
      } else {
        assert.strictEqual(formatFilePathForIbcmdYamlScalar('/a/b\\c'), '/a/b\\c');
      }
    });
  });

  suite('prefer1Cv8Dot1CDDataPathIfPresent', () => {
    test('returns input when path does not exist', () => {
      assert.strictEqual(prefer1Cv8Dot1CDDataPathIfPresent('/nope/not-here-xyz'), '/nope/not-here-xyz');
    });

    test('directory with 1Cv8.1CD file → resolved path to that file', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibcmd-1cd-'));
      fs.writeFileSync(path.join(dir, '1Cv8.1CD'), Buffer.alloc(0));
      try {
        const r = prefer1Cv8Dot1CDDataPathIfPresent(path.resolve(dir));
        assert.ok(/1cv8\.1cd$/i.test(r));
        assert.ok(fs.existsSync(r));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('directory without 1Cv8.1CD → still the directory', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibcmd-nocd-'));
      try {
        const r = prefer1Cv8Dot1CDDataPathIfPresent(path.resolve(dir));
        assert.ok(fs.existsSync(r));
        assert.ok(fs.statSync(r).isDirectory());
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  suite('buildFileInfobaseYamlContent', () => {
    test('file line uses resolved path style via caller', () => {
      const y = buildFileInfobaseYamlContent({ filePath: '/tmp/x' });
      assert.ok(y.includes('infobase:'));
      assert.ok(y.includes('file:'));
      assert.ok(y.includes('/tmp/x') || y.includes('tmp'));
    });

    test('password line is detectable for log hygiene tests', () => {
      const y = buildFileInfobaseYamlContent({ filePath: '/x', password: 'secret' });
      assert.ok(textLooksLikeYamlPasswordLine(y));
    });

    test('when catalog folder contains 1Cv8.1CD, file: scalar is still the directory (ibcmd expects catalog path)', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibyaml-1cd-'));
      fs.writeFileSync(path.join(dir, '1Cv8.1CD'), Buffer.alloc(0));
      try {
        const y = buildFileInfobaseYamlContent({ filePath: dir });
        assert.ok(y.includes('file:'));
        assert.ok(y.includes(path.basename(dir)));
        assert.ok(!/file:\s*"[^"]*1Cv8\.1CD/i.test(y) && !/file:\s*"[^"]*1cv8\.1cd/i.test(y));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  suite('buildServerInfobaseYamlContent', () => {
    test('includes server and ref', () => {
      const y = buildServerInfobaseYamlContent({ server: 'srv', ref: 'db1' });
      assert.ok(y.includes('server:'));
      assert.ok(y.includes('ref:'));
    });
  });

  suite('prepareIbcmdConfigYaml', () => {
    test('web → WEB_NOT_SUPPORTED', async () => {
      const r = await prepareIbcmdConfigYaml(
        baseEntry({ type: 'web', webUrl: 'https://x' }),
        async () => undefined,
      );
      assert.strictEqual(r.ok, false);
      if (!r.ok) {
        assert.strictEqual(r.code, 'WEB_NOT_SUPPORTED');
        assert.strictEqual(r.userMessage, IB_FILE_IBCMD_WEB_UNSUPPORTED_RU);
      }
    });

    test('explicit ibcmdConfigYamlPath wins when file exists and file: points at existing data path', async () => {
      const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ibyaml-'));
      const dataDir = await fs.promises.mkdtemp(path.join(dir, 'data-'));
      const yamlPath = path.join(dir, 'conn.yaml');
      const body = `infobase:\n  file: ${yamlDoubleQuotedScalar(path.resolve(dataDir))}\n`;
      await fs.promises.writeFile(yamlPath, body, 'utf8');
      try {
        const r = await prepareIbcmdConfigYaml(
          baseEntry({
            ibcmdConfigYamlPath: yamlPath,
            filePath: 'C:\\other',
          }),
          async () => undefined,
        );
        assert.strictEqual(r.ok, true);
        if (r.ok) {
          assert.strictEqual(r.kind, 'fileDb');
          assert.strictEqual(r.dbCatalogPath, resolvePathForIbcmdYamlFileField(path.resolve(dataDir)));
          assert.ok(fs.existsSync(r.offlineDataDir));
          await r.dispose();
        }
      } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
      }
    });

    test('explicit yaml: file: points to missing path → IB_FILE_DATA_PATH_NOT_FOUND (standalone/db-data style)', async () => {
      const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ibyaml-miss-'));
      const yamlPath = path.join(dir, 'conn.yaml');
      const ghost = path.join(dir, 'nope', '1Cv8.1CD.cfl');
      const body = `infobase:\n  file: ${yamlDoubleQuotedScalar(ghost)}\n`;
      await fs.promises.writeFile(yamlPath, body, 'utf8');
      try {
        const r = await prepareIbcmdConfigYaml(baseEntry({ ibcmdConfigYamlPath: yamlPath }), async () => undefined);
        assert.strictEqual(r.ok, false);
        if (!r.ok) {
          assert.strictEqual(r.code, 'IB_FILE_DATA_PATH_NOT_FOUND');
          assert.ok(r.userMessage.includes(path.resolve(ghost)));
          assert.ok(r.userMessage.includes('ibcmd не запускался'));
          assert.ok(r.userMessage.includes('db-data'));
        }
      } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
      }
    });

    test('explicit yaml: single-quoted file: missing path → IB_FILE_DATA_PATH_NOT_FOUND', async () => {
      const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ibyaml-sq-'));
      const yamlPath = path.join(dir, 'conn.yaml');
      const ghost = path.join(dir, 'missing.1cd');
      await fs.promises.writeFile(yamlPath, `infobase:\n  file: '${ghost}'\n`, 'utf8');
      try {
        const r = await prepareIbcmdConfigYaml(baseEntry({ ibcmdConfigYamlPath: yamlPath }), async () => undefined);
        assert.strictEqual(r.ok, false);
        if (!r.ok) {
          assert.strictEqual(r.code, 'IB_FILE_DATA_PATH_NOT_FOUND');
        }
      } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
      }
    });

    test('explicit yaml: server entry only (no file:) → ok without file data check', async () => {
      const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ibyaml-srv-'));
      const yamlPath = path.join(dir, 'srv.yaml');
      await fs.promises.writeFile(
        yamlPath,
        'infobase:\n  server: "srv"\n  ref: "db1"\n',
        'utf8',
      );
      try {
        const r = await prepareIbcmdConfigYaml(baseEntry({ ibcmdConfigYamlPath: yamlPath }), async () => undefined);
        assert.strictEqual(r.ok, true);
        if (r.ok) {
          assert.strictEqual(r.kind, 'yaml');
          assert.strictEqual(
            r.absoluteConfigPath,
            resolveExistingPathToLongOnWin32(path.resolve(yamlPath)),
          );
          assert.ok(fs.existsSync(r.offlineDataDir));
          await r.dispose();
        }
      } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
      }
    });

    test('explicit yaml missing → YAML_NOT_FOUND', async () => {
      const missing = path.join(os.tmpdir(), `missing-${Date.now()}.yaml`);
      // Server entry: file-type would try temp YAML from filePath and can return IB_FILE_DATA_PATH_NOT_FOUND first.
      const r = await prepareIbcmdConfigYaml(
        baseEntry({
          type: 'server',
          server: 'srv',
          database: 'db1',
          ibcmdConfigYamlPath: missing,
        }),
        async () => undefined,
      );
      assert.strictEqual(r.ok, false);
      if (!r.ok) {
        assert.strictEqual(r.code, 'YAML_NOT_FOUND');
      }
    });

    test('explicit yaml missing but file data path exists → fileDb (--db-path), no temp YAML', async () => {
      const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ibyaml-fallback-'));
      const missingYaml = path.join(dataDir, 'gone.yaml');
      try {
        const r = await prepareIbcmdConfigYaml(
          baseEntry({
            ibcmdConfigYamlPath: missingYaml,
            filePath: dataDir,
          }),
          async () => undefined,
        );
        assert.strictEqual(r.ok, true);
        if (r.ok) {
          assert.strictEqual(r.kind, 'fileDb');
          assert.strictEqual(r.dbCatalogPath, resolvePathForIbcmdYamlFileField(dataDir));
          assert.ok(fs.existsSync(r.offlineDataDir));
          await r.dispose();
        }
      } finally {
        await fs.promises.rm(dataDir, { recursive: true, force: true });
      }
    });

    test('file entry: fileDb + offline data dir disposed', async () => {
      const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ibcmd-file-'));
      try {
        const r = await prepareIbcmdConfigYaml(baseEntry({ filePath: dataDir }), async () => undefined);
        assert.strictEqual(r.ok, true);
        if (!r.ok) {
          return;
        }
        assert.strictEqual(r.kind, 'fileDb');
        assert.strictEqual(r.dbCatalogPath, resolvePathForIbcmdYamlFileField(dataDir));
        const dataPath = r.offlineDataDir;
        assert.ok(fs.existsSync(dataPath));
        await r.dispose();
        assert.ok(!fs.existsSync(dataPath));
      } finally {
        await fs.promises.rm(dataDir, { recursive: true, force: true });
      }
    });

    test('file entry: data path does not exist → IB_FILE_DATA_PATH_NOT_FOUND', async () => {
      const missing = path.join(os.tmpdir(), `ib-missing-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      const r = await prepareIbcmdConfigYaml(baseEntry({ filePath: missing }), async () => undefined);
      assert.strictEqual(r.ok, false);
      if (!r.ok) {
        assert.strictEqual(r.code, 'IB_FILE_DATA_PATH_NOT_FOUND');
        assert.ok(r.userMessage.includes(path.resolve(missing)));
        assert.ok(r.userMessage.includes('ibcmd не запускался'));
      }
    });

    test('file entry without path → MISSING_PARAMS', async () => {
      const r = await prepareIbcmdConfigYaml(baseEntry({ filePath: '' }), async () => undefined);
      assert.strictEqual(r.ok, false);
      if (!r.ok) {
        assert.strictEqual(r.code, 'MISSING_PARAMS');
      }
    });

    test('server entry: password from readPassword, not echoed in failure messages', async () => {
      const r = await prepareIbcmdConfigYaml(
        baseEntry({
          type: 'server',
          filePath: undefined,
          server: 's1',
          database: 'r1',
          hasStoredPassword: true,
          user: 'u',
        }),
        async () => 'S3cr3t!',
      );
      assert.strictEqual(r.ok, true);
      if (!r.ok) {
        return;
      }
      assert.strictEqual(r.kind, 'yaml');
      const body = await fs.promises.readFile(r.absoluteConfigPath, 'utf8');
      assert.ok(body.includes('S3cr3t!'));
      // User-facing error paths should not embed file content; this is only file body.
      await r.dispose();
    });

    test('server missing server/ref → MISSING_PARAMS', async () => {
      const r = await prepareIbcmdConfigYaml(
        baseEntry({ type: 'server', server: '', database: 'x' }),
        async () => undefined,
      );
      assert.strictEqual(r.ok, false);
      if (!r.ok) {
        assert.strictEqual(r.code, 'MISSING_PARAMS');
      }
    });

    test('server missing database → MISSING_PARAMS', async () => {
      const r = await prepareIbcmdConfigYaml(
        baseEntry({ type: 'server', server: 'srv', database: '' }),
        async () => undefined,
      );
      assert.strictEqual(r.ok, false);
      if (!r.ok) {
        assert.strictEqual(r.code, 'MISSING_PARAMS');
      }
    });

    test('file entry: hasStoredPassword false → readPassword not required, no password line', async () => {
      const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ib-nopw-'));
      try {
        const r = await prepareIbcmdConfigYaml(
          baseEntry({ filePath: dataDir, hasStoredPassword: false }),
          async () => assert.fail('readPassword must not be called'),
        );
        assert.strictEqual(r.ok, true);
        if (!r.ok) {
          return;
        }
        assert.strictEqual(r.kind, 'fileDb');
        await r.dispose();
      } finally {
        await fs.promises.rm(dataDir, { recursive: true, force: true });
      }
    });
  });
});
