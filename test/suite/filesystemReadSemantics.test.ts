import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { createTempDir, cleanupTempDir } from '../helpers/testHelpers';
import { hashContent } from '../../src/services/configurationSession/atomicFileStorage';
import { listXmlSiblingNames, readMutationExpectation } from '../../src/services/filesystemReadSemantics';

suite('filesystem read semantics', () => {
  let tempRoot: string;

  setup(async () => {
    tempRoot = await createTempDir('1cviewer-filesystem-read-');
  });

  teardown(async () => {
    await cleanupTempDir(tempRoot);
  });

  test('classifies missing, file and directory paths, and fails closed for symlinks', async () => {
    const missingPath = path.join(tempRoot, 'missing.xml');
    assert.deepStrictEqual(await readMutationExpectation(missingPath), { state: 'missing' });

    const filePath = path.join(tempRoot, 'item.xml');
    const fileContent = Buffer.from('<Catalog/>');
    await fs.promises.writeFile(filePath, fileContent);
    assert.deepStrictEqual(await readMutationExpectation(filePath), {
      state: 'file',
      hash: hashContent(fileContent),
    });

    const directoryPath = path.join(tempRoot, 'Item');
    await fs.promises.mkdir(directoryPath);
    assert.deepStrictEqual(await readMutationExpectation(directoryPath), { state: 'directory' });

    const symbolicLinkPath = path.join(tempRoot, 'symbolic-link.xml');
    const originalLstat = fs.promises.lstat.bind(fs.promises);
    const patchedPromises = fs.promises as unknown as {
      lstat: (targetPath: fs.PathLike) => Promise<fs.Stats>;
    };
    const permissionDeniedPath = path.join(tempRoot, 'permission-denied.xml');
    const permissionDeniedError = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    patchedPromises.lstat = async (targetPath) => {
      if (String(targetPath) === symbolicLinkPath) {
        return { isSymbolicLink: () => true } as fs.Stats;
      }
      if (String(targetPath) === permissionDeniedPath) {
        throw permissionDeniedError;
      }
      return originalLstat(targetPath);
    };
    try {
      await assert.rejects(
        () => readMutationExpectation(symbolicLinkPath),
        /Symbolic-link metadata path is forbidden/,
      );
      await assert.rejects(
        () => readMutationExpectation(symbolicLinkPath, {
          symbolicLink: (targetPath) => new Error(`Symbolic-link XDTO target is forbidden: ${targetPath}`),
        }),
        /Symbolic-link XDTO target is forbidden/,
      );
      await assert.rejects(
        () => readMutationExpectation(permissionDeniedPath),
        /EACCES: permission denied/,
      );
    } finally {
      patchedPromises.lstat = originalLstat;
    }
  });

  test('lists only XML file siblings and treats a missing type folder as empty', async () => {
    const typeFolderPath = path.join(tempRoot, 'Catalogs');
    assert.deepStrictEqual(await listXmlSiblingNames(typeFolderPath), []);

    await fs.promises.mkdir(typeFolderPath);
    await fs.promises.writeFile(path.join(typeFolderPath, 'Alpha.xml'), '');
    await fs.promises.writeFile(path.join(typeFolderPath, 'Beta.XML'), '');
    await fs.promises.writeFile(path.join(typeFolderPath, 'ignored.txt'), '');
    await fs.promises.mkdir(path.join(typeFolderPath, 'Directory.xml'));

    assert.deepStrictEqual(
      (await listXmlSiblingNames(typeFolderPath)).sort(),
      ['Alpha', 'Beta'],
    );
  });
});
