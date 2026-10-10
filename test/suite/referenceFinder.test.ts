import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  findReferencesToElement,
  replaceReferencesInProject,
  planIdentityTokenReplacements,
  replaceIdentityTokensInProject,
  findReferencesWithDiagnostics,
  ReferenceScanError,
} from '../../src/utils/referenceFinder';
import { MetadataType } from '../../src/models/treeNode';

suite('referenceFinder', () => {
  let tmpDir: string;

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
