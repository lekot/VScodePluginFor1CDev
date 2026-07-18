import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ConfigurationDiscoveryError,
  FormatDetector,
  ConfigFormat,
} from '../../src/parsers/formatDetector';
import { EdtParser } from '../../src/parsers/edtParser';
import { MetadataType } from '../../src/models/treeNode';

suite('FormatDetector', () => {
  test('should detect Designer format', async () => {
    const configPath = path.join(__dirname, '../fixtures/designer-config');
    const format = await FormatDetector.detect(configPath);

    assert.strictEqual(format, ConfigFormat.Designer);
  });

  test('should return Unknown for non-existent path', async () => {
    const configPath = path.join(__dirname, '../fixtures/non-existent');
    const format = await FormatDetector.detect(configPath);

    assert.strictEqual(format, ConfigFormat.Unknown);
  });

  test('should validate configuration path', async () => {
    const configPath = path.join(__dirname, '../fixtures/designer-config');
    const isValid = await FormatDetector.isValidConfigurationPath(configPath);

    assert.strictEqual(isValid, true);
  });

  test('should return false for invalid configuration path', async () => {
    const configPath = path.join(__dirname, '../fixtures/non-existent');
    const isValid = await FormatDetector.isValidConfigurationPath(configPath);

    assert.strictEqual(isValid, false);
  });

  test('should find configuration root in workspace', async () => {
    const workspacePath = path.join(__dirname, '../fixtures');
    const configRoot = await FormatDetector.findConfigurationRoot(workspacePath);

    assert.ok(configRoot);
    assert.ok(configRoot?.includes('designer-config'));
  });

  test('should return null if configuration not found', async () => {
    const workspacePath = path.join(__dirname, '../fixtures/non-existent');
    const configRoot = await FormatDetector.findConfigurationRoot(workspacePath);

    assert.strictEqual(configRoot, null);
  });

  test('findAllConfigurationRoots returns all configs in workspace folders', async () => {
    const fixturesPath = path.join(__dirname, '../fixtures');
    const result = await FormatDetector.findAllConfigurationRoots([fixturesPath]);

    assert.ok(Array.isArray(result));
    assert.ok(result.length >= 1, 'at least designer-config');
    const designerEntry = result.find((r) => r.configPath.includes('designer-config'));
    assert.ok(designerEntry);
    assert.strictEqual(designerEntry.workspaceFolderPath, fixturesPath);
  });

  test('findAllConfigurationRoots deduplicates same config path', async () => {
    const fixturesPath = path.join(__dirname, '../fixtures');
    const result = await FormatDetector.findAllConfigurationRoots([fixturesPath, fixturesPath]);

    const configPaths = result.map((r) => r.configPath);
    const unique = new Set(configPaths);
    assert.strictEqual(unique.size, result.length, 'no duplicate config paths');
  });

  test('findAllConfigurationRoots returns empty for empty input', async () => {
    const result = await FormatDetector.findAllConfigurationRoots([]);
    assert.deepStrictEqual(result, []);
  });

  test('typed root discovery reports partial/error and legacy API never returns false empty on I/O failure', async () => {
    const workspacePath = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-fd-partial-'));
    const configPath = path.join(workspacePath, 'config');
    const missingPath = path.join(workspacePath, 'removed-workspace');

    try {
      await fs.promises.mkdir(configPath, { recursive: true });
      await fs.promises.writeFile(path.join(configPath, 'Configuration.xml'), '<Configuration/>', 'utf-8');

      const partial = await FormatDetector.discoverAllConfigurationRoots([workspacePath, missingPath]);
      assert.strictEqual(partial.status, 'partial');
      assert.ok(partial.items.some((item) => path.normalize(item.configPath) === path.normalize(configPath)));
      assert.ok(partial.issues.some((issue) => path.normalize(issue.path) === path.normalize(missingPath)));

      const failed = await FormatDetector.discoverAllConfigurationRoots([missingPath]);
      assert.strictEqual(failed.status, 'error');
      assert.deepStrictEqual(failed.items, []);
      await assert.rejects(
        FormatDetector.findAllConfigurationRoots([missingPath]),
        ConfigurationDiscoveryError
      );
    } finally {
      await fs.promises.rm(workspacePath, { recursive: true, force: true });
    }
  });

  test('typed package discovery reports partial results instead of authoritatively dropping them', async () => {
    const workspacePath = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-package-partial-'));
    const packagePath = path.join(workspacePath, 'release.cf');
    const missingPath = path.join(workspacePath, 'removed-workspace');

    try {
      await fs.promises.writeFile(packagePath, Buffer.from([0xff, 0xff, 0xff, 0x7f]));

      const result = await FormatDetector.discoverAllConfigurationPackageFiles([workspacePath, missingPath]);
      assert.strictEqual(result.status, 'partial');
      assert.ok(result.items.some((item) => path.normalize(item.filePath) === path.normalize(packagePath)));
      await assert.rejects(
        FormatDetector.findAllConfigurationPackageFiles([workspacePath, missingPath]),
        ConfigurationDiscoveryError
      );
    } finally {
      await fs.promises.rm(workspacePath, { recursive: true, force: true });
    }
  });

  test('matrix small fixture (XML-only export) is detected as Designer', async () => {
    const configPath = path.join(__dirname, '../fixtures/matrix/small');
    const format = await FormatDetector.detect(configPath);

    assert.strictEqual(format, ConfigFormat.Designer);
  });

  test('findAllConfigurationRoots discovers nested matrix fixture configs', async () => {
    const fixturesPath = path.join(__dirname, '../fixtures');
    const result = await FormatDetector.findAllConfigurationRoots([fixturesPath]);

    const smallMatrix = result.find((r) => r.configPath.endsWith(path.join('matrix', 'small')));
    assert.ok(smallMatrix, 'expected matrix/small configuration root');
    assert.strictEqual(smallMatrix?.workspaceFolderPath, fixturesPath);
  });

  test('findAllConfigurationRoots does not recurse into discovered configuration roots', async () => {
    const workspacePath = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-fd-prune-'));
    const configPath = path.join(workspacePath, 'big-config');
    const nestedConfigPath = path.join(configPath, 'Catalogs', 'NestedLikeConfig');

    await fs.promises.mkdir(nestedConfigPath, { recursive: true });
    await fs.promises.writeFile(path.join(configPath, 'Configuration.xml'), '<Configuration/>', 'utf-8');
    await fs.promises.writeFile(path.join(nestedConfigPath, 'Configuration.xml'), '<Configuration/>', 'utf-8');

    const result = await FormatDetector.findAllConfigurationRoots([workspacePath]);
    const configPaths = result.map((r) => path.normalize(r.configPath));

    assert.ok(configPaths.includes(path.normalize(configPath)), 'top-level configuration should be discovered');
    assert.ok(
      !configPaths.includes(path.normalize(nestedConfigPath)),
      'nested markers inside an already discovered configuration root must be ignored'
    );
  });

  test('cf-only directory is not treated as XML configuration root', async () => {
    const workspacePath = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-cf-only-'));
    const cfOnlyPath = path.join(workspacePath, 'cf');

    await fs.promises.mkdir(cfOnlyPath, { recursive: true });
    await fs.promises.writeFile(path.join(cfOnlyPath, '1Cv8.cf'), Buffer.from([0xff, 0xff, 0xff, 0x7f]));

    const roots = await FormatDetector.findAllConfigurationRoots([workspacePath]);
    const configPaths = roots.map((r) => path.normalize(r.configPath));

    assert.ok(!configPaths.includes(path.normalize(cfOnlyPath)), 'binary cf folder must not be parsed as config root');
    assert.strictEqual(await FormatDetector.isValidConfigurationPath(cfOnlyPath), false);
  });

  test('findAllConfigurationPackageFiles discovers cf/cfe files outside configuration roots', async () => {
    const workspacePath = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-cf-discovery-'));
    const externalDir = path.join(workspacePath, 'artifacts', 'releases');
    const configRoot = path.join(workspacePath, 'src-config');

    await fs.promises.mkdir(externalDir, { recursive: true });
    await fs.promises.mkdir(configRoot, { recursive: true });
    await fs.promises.writeFile(path.join(configRoot, 'Configuration.xml'), '<Configuration/>', 'utf-8');
    await fs.promises.writeFile(path.join(configRoot, '1Cv8.cf'), Buffer.from([1]));
    await fs.promises.writeFile(path.join(externalDir, '1Cv8.cf'), Buffer.from([2]));
    await fs.promises.writeFile(path.join(externalDir, 'Patch.cfe'), Buffer.from([3]));

    const packages = await FormatDetector.findAllConfigurationPackageFiles([workspacePath]);
    const packagePaths = packages.map((p) => path.normalize(p.filePath));

    assert.ok(packagePaths.includes(path.normalize(path.join(externalDir, '1Cv8.cf'))));
    assert.ok(packagePaths.includes(path.normalize(path.join(externalDir, 'Patch.cfe'))));
    assert.ok(
      !packagePaths.includes(path.normalize(path.join(configRoot, '1Cv8.cf'))),
      'package discovery must not recurse into discovered XML configuration roots'
    );
  });

  test('pure EDT project with a Sequence .mdo is detected, discovered and validated', async () => {
    const workspacePath = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-pure-edt-'));
    const configPath = path.join(workspacePath, 'edt-project');
    const configurationDir = path.join(configPath, 'src', 'Configuration');
    const sequenceDir = path.join(configPath, 'src', 'Sequences', 'PostingOrder');

    try {
      await fs.promises.mkdir(configurationDir, { recursive: true });
      await fs.promises.mkdir(sequenceDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(configurationDir, 'Configuration.mdo'),
        '<Configuration/>',
        'utf-8'
      );
      await fs.promises.writeFile(path.join(sequenceDir, 'Sequence.mdo'), '<Sequence/>', 'utf-8');

      assert.strictEqual(await FormatDetector.detect(configPath), ConfigFormat.EDT);
      assert.strictEqual(await FormatDetector.isValidConfigurationPath(configPath), true);

      const roots = await FormatDetector.findAllConfigurationRoots([workspacePath]);
      assert.ok(
        roots.some((item) => path.normalize(item.configPath) === path.normalize(configPath)),
        'pure EDT project must be discovered without Configuration.xml'
      );

      const tree = await EdtParser.parseStructureOnly(configPath);
      assert.strictEqual(
        path.normalize(tree.filePath ?? ''),
        path.normalize(path.join(configPath, 'src', 'Configuration', 'Configuration.mdo')),
        'EDT root must not point to a synthetic Designer Configuration.xml'
      );
      assert.strictEqual(tree.children?.find((item) => item.id === 'Sequences')?.type, MetadataType.Sequence);
    } finally {
      await fs.promises.rm(workspacePath, { recursive: true, force: true });
    }
  });

  test('EDT layout wins over Designer markers in a hybrid directory', async () => {
    const configPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-hybrid-edt-'));
    const configurationDir = path.join(configPath, 'src', 'Configuration');

    try {
      await fs.promises.mkdir(configurationDir, { recursive: true });
      await fs.promises.writeFile(path.join(configPath, 'Configuration.xml'), '<Configuration/>', 'utf-8');
      await fs.promises.writeFile(path.join(configurationDir, 'Configuration.mdo'), '<Configuration/>', 'utf-8');

      assert.strictEqual(await FormatDetector.detect(configPath), ConfigFormat.EDT);
    } finally {
      await fs.promises.rm(configPath, { recursive: true, force: true });
    }
  });

  test('Designer marker wins over an unrelated mdo under src', async () => {
    const configPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-designer-mdo-'));
    const unrelatedDir = path.join(configPath, 'src', 'Generated');

    try {
      await fs.promises.mkdir(unrelatedDir, { recursive: true });
      await fs.promises.writeFile(path.join(configPath, 'Configuration.xml'), '<Configuration/>', 'utf-8');
      await fs.promises.writeFile(path.join(unrelatedDir, 'Unrelated.mdo'), '<Generated/>', 'utf-8');

      assert.strictEqual(await FormatDetector.detect(configPath), ConfigFormat.Designer);
    } finally {
      await fs.promises.rm(configPath, { recursive: true, force: true });
    }
  });

  test('arbitrary mdo files do not identify or discover an EDT project', async () => {
    const workspacePath = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-false-edt-'));
    const configPath = path.join(workspacePath, 'not-an-edt-project');
    const unrelatedDir = path.join(configPath, 'src', 'Generated');

    try {
      await fs.promises.mkdir(unrelatedDir, { recursive: true });
      await fs.promises.writeFile(path.join(unrelatedDir, 'Unrelated.mdo'), '<Generated/>', 'utf-8');

      assert.strictEqual(await FormatDetector.detect(configPath), ConfigFormat.Unknown);
      assert.strictEqual(await FormatDetector.isValidConfigurationPath(configPath), false);
      assert.deepStrictEqual(await FormatDetector.findAllConfigurationRoots([workspacePath]), []);
    } finally {
      await fs.promises.rm(workspacePath, { recursive: true, force: true });
    }
  });
});
