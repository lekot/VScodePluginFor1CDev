import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { XMLValidator } from 'fast-xml-parser';
import {
  findReferencesToElement,
  replaceReferencesInProject,
  planIdentityTokenReplacements,
  replaceIdentityTokensInProject,
  findReferencesWithDiagnostics,
  ReferenceScanError,
} from '../../src/utils/referenceFinder';
import { MetadataType } from '../../src/models/treeNode';
import {
  configureConfigurationMutationGateway,
} from '../../src/services/configurationSession/configurationMutationGateway';
import {
  MutationPlanExecutor,
  MutationPlanError,
  type MutationPlan,
} from '../../src/services/configurationSession/mutationPlan';
import { hashContent } from '../../src/services/configurationSession/atomicFileStorage';
import { MutationReceiptError } from '../../src/services/configurationSession/mutationReceiptError';
import { installDirectConfigurationMutationEngineForTests } from '../helpers/directConfigurationMutationEngine';

function isExistingPlanFailure(error: unknown): boolean {
  return (error instanceof MutationPlanError
      && ['PLAN_CONFLICT', 'PLAN_FAILED', 'RECOVERY_REQUIRED'].includes(error.code))
    || (error instanceof MutationReceiptError
      && ['conflict', 'rolledBack', 'recoveryRequired'].includes(error.status));
}

suite('referenceFinder', () => {
  let tmpDir: string;
  let restoreTestEngine: (() => void) | undefined;
  let disposePlanGateway: (() => void) | undefined;

  suiteSetup(() => {
    restoreTestEngine = installDirectConfigurationMutationEngineForTests();
    disposePlanGateway = configureConfigurationMutationGateway(
      async <T>(_resourcePath: string, _kind: string, operation: () => Promise<T>): Promise<T> => operation(),
      async <T>(resourcePath: string, plan: MutationPlan<T>): Promise<T> =>
        new MutationPlanExecutor(resourcePath).execute(plan),
    ).dispose;
  });

  suiteTeardown(() => {
    disposePlanGateway?.();
    restoreTestEngine?.();
  });

  setup(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-ref-'));
  });

  teardown(async () => {
    try {
      await fs.promises.rm(tmpDir, { recursive: true });
    } catch {
      // ignore
    }
  });

  test('findReferencesToElement returns empty for type without Ref', async () => {
    const result = await findReferencesToElement(tmpDir, 'Any', MetadataType.Configuration);
    assert.strictEqual(result.length, 0);
  });

  test('findReferencesToElement finds CatalogRef in XML file', async () => {
    const sub = path.join(tmpDir, 'Catalogs');
    await fs.promises.mkdir(sub, { recursive: true });
    const filePath = path.join(sub, 'MyCatalog.xml');
    await fs.promises.writeFile(
      filePath,
      '<root><Type>CatalogRef.MyCatalog</Type><Other>CatalogRef.MyCatalog</Other></root>',
      'utf-8'
    );
    const result = await findReferencesToElement(tmpDir, 'MyCatalog', MetadataType.Catalog);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].filePath, filePath);
    assert.ok(result[0].snippet.includes('CatalogRef.MyCatalog'));
  });

  test('findReferencesToElement returns empty when no match', async () => {
    const sub = path.join(tmpDir, 'Catalogs');
    await fs.promises.mkdir(sub, { recursive: true });
    await fs.promises.writeFile(
      path.join(sub, 'Other.xml'),
      '<root><Type>CatalogRef.OtherCatalog</Type></root>',
      'utf-8'
    );
    const result = await findReferencesToElement(tmpDir, 'MyCatalog', MetadataType.Catalog);
    assert.strictEqual(result.length, 0);
  });

  test('replaceReferencesInProject replaces CatalogRef and returns count', async () => {
    const sub = path.join(tmpDir, 'Data');
    await fs.promises.mkdir(sub, { recursive: true });
    const filePath = path.join(sub, 'file.xml');
    await fs.promises.writeFile(
      filePath,
      '<root><Ref>CatalogRef.OldName</Ref><Ref>CatalogRef.OldName</Ref></root>',
      'utf-8'
    );
    const results = await replaceReferencesInProject(tmpDir, 'OldName', 'NewName', MetadataType.Catalog);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].filePath, filePath);
    assert.strictEqual(results[0].replaceCount, 2);
    const content = await fs.promises.readFile(filePath, 'utf-8');
    assert.ok(content.includes('CatalogRef.NewName'));
    assert.ok(!content.includes('CatalogRef.OldName'));
  });

  test('replaceIdentityTokensInProject leaves matching-type XML unchanged when no token matches', async () => {
    const filePath = path.join(tmpDir, 'NoMatchingIdentity.xml');
    const originalContent = '<root><Ref>CatalogRef.AnotherCatalog</Ref><Comment>keep this</Comment></root>';
    await fs.promises.writeFile(filePath, originalContent, 'utf8');

    const result = await replaceIdentityTokensInProject(
      tmpDir,
      new Map([['CatalogRef.OldName', 'CatalogRef.NewName']]),
    );

    assert.deepStrictEqual(result, [], 'the public API returns no writes when planning finds no matching token');
    assert.strictEqual(await fs.promises.readFile(filePath, 'utf8'), originalContent,
      'a no-match scan must not publish or reformat the XML file');
  });

  test('identity replacement executes one exact-snapshot plan and protects a foreign writer during rollback', async () => {
    const firstPath = path.join(tmpDir, '01-first.xml');
    const secondPath = path.join(tmpDir, '02-second.xml');
    const firstOriginal = `<?xml version="1.0" encoding="UTF-8"?>
<root><Type>CatalogRef.OldName</Type><Nested><Type>CatalogRef.OldName</Type></Nested>
<Adjacent>CatalogRef.OldNameExtra</Adjacent><Escaped>Keep &amp; CatalogRef.OldName</Escaped></root>`;
    const secondOriginal = `<root><Wrapper><Ref>CatalogRef.OldName</Ref></Wrapper><Sibling>DocumentRef.OldName</Sibling></root>`;
    const foreignFirst = '<Foreign>external &amp; newer bytes</Foreign>';
    await fs.promises.writeFile(firstPath, firstOriginal, 'utf8');
    await fs.promises.writeFile(secondPath, secondOriginal, 'utf8');
    const replacements = new Map([
      ['CatalogRef.OldName', 'CatalogRef.NewName'],
      ['DocumentRef.OldName', 'DocumentRef.NewName'],
    ]);

    const purePlan = await planIdentityTokenReplacements(tmpDir, replacements, { validateXml: true });
    assert.strictEqual(purePlan.length, 2, 'the pure planner discovers all matching XML targets');
    assert.strictEqual(await fs.promises.readFile(firstPath, 'utf8'), firstOriginal,
      'planning is side-effect free before the public compatibility adapter executes');
    assert.strictEqual(await fs.promises.readFile(secondPath, 'utf8'), secondOriginal);
    assert.strictEqual(XMLValidator.validate(purePlan.find((item) => item.filePath === firstPath)?.updatedContent ?? ''), true);
    assert.ok(purePlan.find((item) => item.filePath === firstPath)?.updatedContent.includes('CatalogRef.OldNameExtra'),
      'the adjacent identity remains distinct');
    assert.ok(purePlan.find((item) => item.filePath === firstPath)?.updatedContent.includes('Keep &amp; CatalogRef.NewName'),
      'escaped surrounding XML text remains intact');

    let planCount = 0;
    let firstTarget: string | undefined;
    let secondTarget: string | undefined;
    let foreignWriterRan = false;
    let secondPublicationFailed = false;
    const xmlRenameTargets: string[] = [];
    let planSteps: MutationPlan<unknown>['steps'] = [];
    const mutable = fs.promises as unknown as { rename: typeof fs.promises.rename };
    const originalRename = mutable.rename;
    const gateway = configureConfigurationMutationGateway(
      async <T>(_resourcePath: string, _kind: string, operation: () => Promise<T>): Promise<T> => operation(),
      async <T>(resourcePath: string, plan: MutationPlan<T>): Promise<T> => {
        planCount++;
        planSteps = plan.steps;
        const writes = plan.steps.filter((step) => step.type === 'writeFile');
        assert.strictEqual(writes.length, 2, 'all changed files are part of the same batch');
        const expectedByTarget = new Map([
          [path.resolve(firstPath), hashContent(firstOriginal)],
          [path.resolve(secondPath), hashContent(secondOriginal)],
        ]);
        for (const step of writes) {
          if (step.type !== 'writeFile') { continue; }
          if (step.expected.state !== 'file') {
            throw new Error('Replacement targets must capture an existing file snapshot.');
          }
          assert.strictEqual(step.expected.hash, expectedByTarget.get(path.resolve(step.targetPath)),
            'each write compares against the exact source snapshot used by the pure planner');
        }
        firstTarget = await fs.promises.realpath(writes[0]!.targetPath);
        secondTarget = await fs.promises.realpath(writes[1]!.targetPath);
        mutable.rename = async (oldPath, newPath) => {
          const target = await fs.promises.realpath(String(newPath)).catch(() => path.resolve(String(newPath)));
          if (target.toLocaleLowerCase().endsWith('.xml')) {
            xmlRenameTargets.push(target);
          }
          if (!foreignWriterRan && target.toLocaleLowerCase() === firstTarget!.toLocaleLowerCase()) {
            await originalRename(oldPath, newPath);
            foreignWriterRan = true;
            await fs.promises.writeFile(target, foreignFirst, 'utf8');
            return;
          }
          if (foreignWriterRan && !secondPublicationFailed && target.toLocaleLowerCase() === secondTarget!.toLocaleLowerCase()) {
            secondPublicationFailed = true;
            throw Object.assign(new Error('ENOSPC after first target publication'), { code: 'ENOSPC' });
          }
          await originalRename(oldPath, newPath);
        };
        try {
          return await new MutationPlanExecutor(resourcePath).execute(plan);
        } finally {
          mutable.rename = originalRename;
        }
      },
    );

    try {
      let failure: unknown;
      try {
        await replaceIdentityTokensInProject(tmpDir, replacements);
      } catch (error) {
        failure = error;
      }
      assert.deepStrictEqual(
        {
          planCount,
          foreignWriterRan,
          secondPublicationFailed,
          existingPlanFailure: failure !== undefined && isExistingPlanFailure(failure),
        },
        { planCount: 1, foreignWriterRan: true, secondPublicationFailed: true, existingPlanFailure: true },
        `the legacy API must enter one batch plan before the injected rollback race can run; failure=${failure instanceof Error ? `${failure.name}: ${failure.message}` : String(failure)}; XML publication targets=${xmlRenameTargets.join(' | ')}`,
      );
      assert.strictEqual(planCount, 1, 'the legacy API submits one configuration plan');
      assert.strictEqual(planSteps.filter((step) => step.type === 'writeFile').length, 2);
      assert.strictEqual(foreignWriterRan, true, 'the first planned target reached its publication point');
      assert.strictEqual(secondPublicationFailed, true, 'the second target fails after the first target publication');
      assert.strictEqual(await fs.promises.readFile(firstTarget!, 'utf8'), foreignFirst,
        'rollback must not overwrite bytes written by another process after the first target committed');
      assert.strictEqual(await fs.promises.readFile(secondTarget!, 'utf8'), secondTarget === await fs.promises.realpath(firstPath) ? firstOriginal : secondOriginal,
        'the not-yet-published sibling retains its prior content');
    } finally {
      gateway.dispose();
      mutable.rename = originalRename;
    }
  });

  test('replaceReferencesInProject returns empty for type without Ref', async () => {
    const results = await replaceReferencesInProject(tmpDir, 'A', 'B', MetadataType.Configuration);
    assert.strictEqual(results.length, 0);
  });

  test('planIdentityTokenReplacements throws ReferenceScanError when readdir fails (#203)', async () => {
    const brokenDir = path.join(tmpDir, 'UnreadableSubdir');
    await fs.promises.mkdir(brokenDir);
    const origReaddir = fs.promises.readdir;
    const patchedReaddir = fs.promises as unknown as { readdir: typeof fs.promises.readdir };
    patchedReaddir.readdir = (async (dirPath: Parameters<typeof fs.promises.readdir>[0], opts?: Parameters<typeof fs.promises.readdir>[1]) => {
      if (String(dirPath).includes('UnreadableSubdir')) {
        const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        throw err;
      }
      return origReaddir.apply(fs.promises, [dirPath, opts as never]);
    }) as typeof fs.promises.readdir;

    try {
      await assert.rejects(
        async () => {
          await planIdentityTokenReplacements(
            tmpDir,
            new Map([['CatalogRef.OldName', 'CatalogRef.NewName']])
          );
        },
        (err: unknown) => {
          assert.ok(err instanceof ReferenceScanError);
          const scanErr = err as ReferenceScanError;
          assert.strictEqual(scanErr.details?.reason, 'readdir_failed');
          assert.ok(scanErr.details?.path.includes('UnreadableSubdir'));
          return true;
        }
      );
    } finally {
      fs.promises.readdir = origReaddir;
    }
  });

  test('planIdentityTokenReplacements throws ReferenceScanError when readFile fails on XML (#203)', async () => {
    const brokenFile = path.join(tmpDir, 'Corrupt.xml');
    await fs.promises.writeFile(brokenFile, '<root/>', 'utf-8');
    const origReadFile = fs.promises.readFile;
    const patchedReadFile = fs.promises as unknown as { readFile: typeof fs.promises.readFile };
    patchedReadFile.readFile = (async (
      filePath: Parameters<typeof fs.promises.readFile>[0],
      ...args: [Parameters<typeof fs.promises.readFile>[1]]
    ) => {
      if (String(filePath).includes('Corrupt.xml')) {
        const err = Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
        throw err;
      }
      return origReadFile.apply(fs.promises, [filePath, ...args]);
    }) as typeof fs.promises.readFile;

    try {
      await assert.rejects(
        async () => {
          await planIdentityTokenReplacements(
            tmpDir,
            new Map([['CatalogRef.OldName', 'CatalogRef.NewName']])
          );
        },
        (err: unknown) => {
          assert.ok(err instanceof ReferenceScanError);
          const scanErr = err as ReferenceScanError;
          assert.strictEqual(scanErr.details?.reason, 'read_file_failed');
          assert.ok(scanErr.details?.path.includes('Corrupt.xml'));
          return true;
        }
      );
    } finally {
      fs.promises.readFile = origReadFile;
    }
  });

  test('malformed XML validation is opt-in and leaves the existing scanner contract unchanged', async () => {
    const malformedFile = path.join(tmpDir, 'Malformed.xml');
    const content = '<root><Type>CatalogRef.OldName</broken></root>';
    await fs.promises.writeFile(malformedFile, content, 'utf-8');
    const replacements = new Map([['CatalogRef.OldName', 'CatalogRef.NewName']]);

    const legacyPlan = await planIdentityTokenReplacements(tmpDir, replacements);
    assert.strictEqual(legacyPlan.length, 1);
    assert.strictEqual(legacyPlan[0].updatedContent, '<root><Type>CatalogRef.NewName</broken></root>');

    await assert.rejects(
      () => planIdentityTokenReplacements(tmpDir, replacements, { validateXml: true }),
      (error: unknown) => error instanceof ReferenceScanError
        && error.details?.reason === 'malformed_xml'
        && error.details.path === malformedFile,
    );
    assert.strictEqual(await fs.promises.readFile(malformedFile, 'utf-8'), content);
  });

  test('planIdentityTokenReplacements throws ReferenceScanError when MAX_SCAN_DEPTH exceeded (#203)', async () => {
    // Create nested directories > 20 deep
    let current = tmpDir;
    for (let i = 0; i < 22; i++) {
      current = path.join(current, `d${i}`);
      await fs.promises.mkdir(current);
    }
    await fs.promises.writeFile(path.join(current, 'deep.xml'), '<root/>', 'utf-8');

    await assert.rejects(
      async () => {
        await planIdentityTokenReplacements(
          tmpDir,
          new Map([['CatalogRef.Old', 'CatalogRef.New']])
        );
      },
      (err: unknown) => {
        assert.ok(err instanceof ReferenceScanError);
        const scanErr = err as ReferenceScanError;
        assert.strictEqual(scanErr.details?.reason, 'max_depth_exceeded');
        return true;
      }
    );
  });

  test('replaceIdentityTokensInProject leaves all files untouched when scan fails closed (#203)', async () => {
    const validFile = path.join(tmpDir, 'Valid.xml');
    const initialContent = '<root><Type>CatalogRef.OldName</Type></root>';
    await fs.promises.writeFile(validFile, initialContent, 'utf-8');

    const brokenDir = path.join(tmpDir, 'Locked');
    await fs.promises.mkdir(brokenDir);
    const origReaddir = fs.promises.readdir;
    const patchedReaddir = fs.promises as unknown as { readdir: typeof fs.promises.readdir };
    patchedReaddir.readdir = (async (dirPath: Parameters<typeof fs.promises.readdir>[0], opts?: Parameters<typeof fs.promises.readdir>[1]) => {
      if (String(dirPath).includes('Locked')) {
        throw new Error('EPERM');
      }
      return origReaddir.apply(fs.promises, [dirPath, opts as never]);
    }) as typeof fs.promises.readdir;

    try {
      await assert.rejects(
        async () => {
          await replaceIdentityTokensInProject(
            tmpDir,
            new Map([['CatalogRef.OldName', 'CatalogRef.NewName']])
          );
        },
        ReferenceScanError
      );

      // Verify valid file was NOT modified
      const currentContent = await fs.promises.readFile(validFile, 'utf-8');
      assert.strictEqual(currentContent, initialContent, 'Valid file must remain unmodified on fail-closed scan');
    } finally {
      fs.promises.readdir = origReaddir;
    }
  });

  test('findReferencesWithDiagnostics reports authoritative=false and diagnostics on error (#203)', async () => {
    const brokenFile = path.join(tmpDir, 'Unreadable.xml');
    await fs.promises.writeFile(brokenFile, '<root/>', 'utf-8');
    const origReadFile = fs.promises.readFile;
    const patchedReadFile = fs.promises as unknown as { readFile: typeof fs.promises.readFile };
    patchedReadFile.readFile = (async (
      filePath: Parameters<typeof fs.promises.readFile>[0],
      ...args: [Parameters<typeof fs.promises.readFile>[1]]
    ) => {
      if (String(filePath).includes('Unreadable.xml')) {
        throw new Error('EACCES');
      }
      return origReadFile.apply(fs.promises, [filePath, ...args]);
    }) as typeof fs.promises.readFile;

    try {
      const result = await findReferencesWithDiagnostics(tmpDir, 'MyCatalog', MetadataType.Catalog);
      assert.strictEqual(result.authoritative, false, 'Scan must be marked not authoritative');
      assert.ok(result.diagnostics.length > 0, 'Must contain scan diagnostics');
      assert.strictEqual(result.diagnostics[0].reason, 'read_file_failed');
      assert.ok(result.diagnostics[0].path.includes('Unreadable.xml'));
    } finally {
      fs.promises.readFile = origReadFile;
    }
  });

  test('findReferencesWithDiagnostics records diagnostic on readdir failure (#203)', async () => {
    const brokenDir = path.join(tmpDir, 'ReaddirFail');
    await fs.promises.mkdir(brokenDir);
    const origReaddir = fs.promises.readdir;
    const patchedReaddir = fs.promises as unknown as { readdir: typeof fs.promises.readdir };
    patchedReaddir.readdir = (async (dirPath: Parameters<typeof fs.promises.readdir>[0], opts?: Parameters<typeof fs.promises.readdir>[1]) => {
      if (String(dirPath).includes('ReaddirFail')) {
        throw new Error('EPERM: cannot read directory');
      }
      return origReaddir.apply(fs.promises, [dirPath, opts as never]);
    }) as typeof fs.promises.readdir;

    try {
      const result = await findReferencesWithDiagnostics(tmpDir, 'MyCatalog', MetadataType.Catalog);
      assert.strictEqual(result.authoritative, false);
      const diag = result.diagnostics.find((d) => d.reason === 'readdir_failed');
      assert.ok(diag);
      assert.ok(diag?.path.includes('ReaddirFail'));
    } finally {
      fs.promises.readdir = origReaddir;
    }
  });

  test('findReferencesWithDiagnostics records diagnostic when max depth is exceeded (#203)', async () => {
    let deepDir = tmpDir;
    for (let i = 0; i <= 21; i++) {
      deepDir = path.join(deepDir, `level${i}`);
    }
    await fs.promises.mkdir(deepDir, { recursive: true });

    const result = await findReferencesWithDiagnostics(tmpDir, 'MyCatalog', MetadataType.Catalog);
    assert.strictEqual(result.authoritative, false);
    const diag = result.diagnostics.find((d) => d.reason === 'max_depth_exceeded');
    assert.ok(diag);
  });
});
