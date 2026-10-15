import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as vscode from 'vscode';
import {
  detectChangedConfigFiles,
  findDeepestContainingRepository,
  type GitRepository,
  type IncrementalChangeDetectorDeps,
} from '../../src/services/ibcmd/incrementalChangeDetector';
import {
  buildInfobaseConfigImportFilesArgs,
  type IbcmdOfflineConnection,
} from '../../src/services/ibcmd/ibcmdInfobaseConfigArgs';
import {
  assertDeployFilePathWithinBase,
  validateDeployRelativeFiles,
} from '../../src/services/ibcmd/deployPathValidator';
import { DeployService } from '../../src/bindings/deployService';
import type { ConfigurationBinding } from '../../src/bindings/models/configurationBinding';
import type { InfobaseEntry } from '../../src/infobases/models/infobaseEntry';

const FILE_CONN: IbcmdOfflineConnection = {
  kind: 'fileDb',
  dbCatalogPath: 'C:/test/db',
  offlineDataDir: 'C:/test/data',
};

function makeRepo(
  rootUriPath: string,
  workingTreePaths: string[] = [],
  indexPaths: string[] = [],
): GitRepository {
  return {
    rootUri: { fsPath: rootUriPath },
    state: {
      workingTreeChanges: workingTreePaths.map((p) => ({ uri: { fsPath: p } })),
      indexChanges: indexPaths.map((p) => ({ uri: { fsPath: p } })),
      mergeChanges: [],
    },
  };
}

suite('deployPathContainment #248', () => {
  // ─── 1. detectChangedConfigFiles ───────────────────────────────────────────

  test('detectChangedConfigFiles: POSIX case mismatch between configRoot and change is skipped', async () => {
    const configRoot = '/workspace/Config';
    const wrongCaseChange = '/workspace/config/Catalogs/Foo.xml';
    const correctCaseChange = '/workspace/Config/Catalogs/Bar.xml';

    const repo = makeRepo('/workspace', [wrongCaseChange, correctCaseChange]);
    const deps: IncrementalChangeDetectorDeps = { getGitRepository: () => repo };

    // With platform: 'linux', /workspace/config must NOT match /workspace/Config
    const result = await detectChangedConfigFiles(configRoot, deps, {
      platform: 'linux' as NodeJS.Platform,
    } as any);

    assert.ok(!('error' in result), 'Expected result, got error');
    if ('error' in result) return;

    assert.strictEqual(result.relativePaths.length, 1);
    assert.strictEqual(result.relativePaths[0], 'Catalogs/Bar.xml');
    assert.ok(!result.relativePaths.some((p) => p.includes('..')));
    assert.strictEqual(result.skippedCount, 1);
  });

  test('detectChangedConfigFiles: sibling prefix directory is not treated as contained', async () => {
    const configRoot = '/workspace/app';
    const siblingChange = '/workspace/application/Catalogs/Foo.xml';
    const appChange = '/workspace/app/Catalogs/Bar.xml';

    const repo = makeRepo('/workspace', [siblingChange, appChange]);
    const deps: IncrementalChangeDetectorDeps = { getGitRepository: () => repo };

    const result = await detectChangedConfigFiles(configRoot, deps, {
      platform: 'linux' as NodeJS.Platform,
    } as any);

    assert.ok(!('error' in result), 'Expected result, got error');
    if ('error' in result) return;

    assert.strictEqual(result.relativePaths.length, 1);
    assert.strictEqual(result.relativePaths[0], 'Catalogs/Bar.xml');
    assert.strictEqual(result.skippedCount, 1);
  });

  // ─── 2. findDeepestContainingRepository ────────────────────────────────────

  test('findDeepestContainingRepository: selects deepest nested repo regardless of order', () => {
    const outerRepo = makeRepo('/workspace');
    const innerRepo = makeRepo('/workspace/packages/submodule');
    const target = '/workspace/packages/submodule/src/Configuration';

    // Order 1: [outer, inner]
    const chosen1 = findDeepestContainingRepository([outerRepo, innerRepo], target, 'linux');
    assert.strictEqual(chosen1, innerRepo, 'Should choose innerRepo when outer is first');

    // Order 2: [inner, outer]
    const chosen2 = findDeepestContainingRepository([innerRepo, outerRepo], target, 'linux');
    assert.strictEqual(chosen2, innerRepo, 'Should choose innerRepo when inner is first');
  });

  test('findDeepestContainingRepository: avoids sibling prefix collision', () => {
    const appRepo = makeRepo('/workspace/app');
    const applicationRepo = makeRepo('/workspace/application');
    const target = '/workspace/application/src/Configuration';

    const chosen = findDeepestContainingRepository([appRepo, applicationRepo], target, 'linux');
    assert.strictEqual(chosen, applicationRepo, 'Must not match /workspace/app for /workspace/application');
  });

  test('findDeepestContainingRepository: returns undefined when no repo contains target (no repos[0] fallback)', () => {
    const unrelatedRepo = makeRepo('/workspace/other');
    const target = '/workspace/config';

    const chosen = findDeepestContainingRepository([unrelatedRepo], target, 'linux');
    assert.strictEqual(chosen, undefined, 'Must return undefined without fallback to repos[0]');
  });

  test('findDeepestContainingRepository: respects platform case sensitivity', () => {
    const repo = makeRepo('/workspace/config');
    const target = '/workspace/Config/Configuration.xml';

    const chosenLinux = findDeepestContainingRepository([repo], target, 'linux');
    assert.strictEqual(chosenLinux, undefined, 'Must not match case-mismatched repo on Linux');

    const chosenWin = findDeepestContainingRepository([repo], target, 'win32');
    assert.strictEqual(chosenWin, repo, 'Should match case-insensitively on Windows');
  });

  // ─── 3. assertDeployFilePathWithinBase & validateDeployRelativeFiles ─────────

  test('validateDeployRelativeFiles: rejects traversal, absolute paths, empty, and null bytes', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdt-containment-'));
    try {
      const validRel = 'Catalogs/Foo.xml';
      const fullValid = path.join(tempDir, validRel);
      fs.mkdirSync(path.dirname(fullValid), { recursive: true });
      fs.writeFileSync(fullValid, '<xml/>', 'utf8');

      // Valid path passes
      const validRes = await validateDeployRelativeFiles(tempDir, [validRel]);
      assert.strictEqual(validRes.ok, true);

      // Traversal with ..
      const traversalRes = await validateDeployRelativeFiles(tempDir, ['../other.xml']);
      assert.strictEqual(traversalRes.ok, false);
      assert.ok(/родительский каталог|traversal|outside/i.test(traversalRes.error ?? ''));

      // Infix traversal
      const infixRes = await validateDeployRelativeFiles(tempDir, ['Catalogs/../../escape.xml']);
      assert.strictEqual(infixRes.ok, false);

      // Absolute POSIX
      const absPosixRes = await validateDeployRelativeFiles(tempDir, ['/etc/passwd']);
      assert.strictEqual(absPosixRes.ok, false);

      // Absolute Windows
      const absWinRes = await validateDeployRelativeFiles(tempDir, ['C:/Windows/calc.exe']);
      assert.strictEqual(absWinRes.ok, false);

      // Empty string
      const emptyRes = await validateDeployRelativeFiles(tempDir, ['']);
      assert.strictEqual(emptyRes.ok, false);

      // Null byte
      const nullRes = await validateDeployRelativeFiles(tempDir, ['foo\0bar.xml']);
      assert.strictEqual(nullRes.ok, false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('validateDeployRelativeFiles: rejects symlink target that escapes configuration root', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdt-root-'));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdt-outside-'));
    try {
      const outsideFile = path.join(outsideDir, 'secret.xml');
      fs.writeFileSync(outsideFile, '<secret/>', 'utf8');

      const symlinkPath = path.join(rootDir, 'Symlink.xml');
      let symlinkCreated = false;
      try {
        fs.symlinkSync(outsideFile, symlinkPath);
        symlinkCreated = true;
      } catch {
        // Symlink creation might require elevated permissions on Windows
      }

      if (symlinkCreated) {
        const res = await validateDeployRelativeFiles(rootDir, ['Symlink.xml']);
        assert.strictEqual(res.ok, false, 'Symlink pointing outside root must be rejected');
        assert.ok(/символическ|ссылке|outside/i.test(res.error ?? ''));
      }
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  // ─── 4. buildInfobaseConfigImportFilesArgs ─────────────────────────────────

  test('buildInfobaseConfigImportFilesArgs: throws when relative file contains .. traversal', () => {
    const baseDir = 'C:/project/config';
    const traversalFiles = ['../config/Catalogs/Foo.xml'];

    assert.throws(
      () => buildInfobaseConfigImportFilesArgs(FILE_CONN, traversalFiles, baseDir),
      (err: any) => {
        return err && (err.name === 'PathBoundaryError' || /родительский каталог|traversal|outside/i.test(err.message));
      },
      'Expected buildInfobaseConfigImportFilesArgs to reject traversal .. path',
    );
  });

  test('buildInfobaseConfigImportFilesArgs: throws when file is absolute path', () => {
    const baseDir = 'C:/project/config';
    const absoluteFiles = ['C:/other/Catalogs/Foo.xml'];

    assert.throws(
      () => buildInfobaseConfigImportFilesArgs(FILE_CONN, absoluteFiles, baseDir),
      (err: any) => {
        return err && (err.name === 'PathBoundaryError' || /абсолютный|absolute|outside/i.test(err.message));
      },
      'Expected buildInfobaseConfigImportFilesArgs to reject absolute path',
    );
  });

  // ─── 5. DeployService boundary integration ─────────────────────────────────

  test('DeployService.deployChangedFiles: rejects traversal path before ibcmd execution', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdt-deploy-service-'));
    try {
      const configDir = path.join(tempDir, 'src', 'Configuration');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, 'Configuration.xml'), '<Configuration/>', 'utf8');

      const binding: ConfigurationBinding = {
        workspaceFolder: 'test',
        configRelativePath: 'src/Configuration/Configuration.xml',
        infobaseIds: ['ib-1'],
        massDeployment: false,
      };

      const entry: InfobaseEntry = {
        id: 'ib-1',
        name: 'TestIB',
        type: 'file',
        filePath: path.join(tempDir, 'ib'),
        hasStoredPassword: false,
        createdAt: new Date().toISOString(),
      };

      const mockStorage: any = {
        load: async () => [entry],
        readPasswordSecret: async () => undefined,
      };

      const service = new DeployService();
      const summary = await service.deployChangedFiles({
        binding,
        workspaceFolderRoot: tempDir,
        storage: mockStorage,
        catalog: [entry],
        relativeFiles: ['../outside/Infiltrate.xml'],
        progress: { report: () => {} },
        token: new vscode.CancellationTokenSource().token,
      });

      assert.strictEqual(summary.errorCount, 1, 'Should fail with error due to containment violation');
      assert.ok(
        summary.results.some((r) => /родительский каталог|границы|traversal|outside/i.test(r.message)),
        `Expected containment error message, got: ${JSON.stringify(summary.results)}`,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ─── 6. CDT does not rely on external ibcmd for path containment ──────────

  test('CDT preflight containment barrier operates deterministically without ibcmd invocation', async () => {
    // Proves that when a path traversal is supplied, CDT rejects it at the validator/args/service level
    // without ever delegating safety to ibcmd.
    const baseDir = '/workspace/Config';
    const evilPaths = [
      '../sibling.xml',
      'sub/../../outside.xml',
      '/absolute/escape.xml',
    ];

    for (const evil of evilPaths) {
      assert.throws(
        () => assertDeployFilePathWithinBase(evil, baseDir, 'linux'),
        (err: any) => err && (err.name === 'PathBoundaryError' || /родительский|outside|абсолютный/i.test(err.message)),
        `assertDeployFilePathWithinBase must block "${evil}" before ibcmd`,
      );

      assert.throws(
        () => buildInfobaseConfigImportFilesArgs(FILE_CONN, [evil], baseDir),
        (err: any) => err && (err.name === 'PathBoundaryError' || /родительский|outside|абсолютный/i.test(err.message)),
        `buildInfobaseConfigImportFilesArgs must block "${evil}" before ibcmd`,
      );
    }
  });
});
