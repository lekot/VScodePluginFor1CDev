import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { findReferencesToElement, replaceReferencesInProject } from '../../src/utils/referenceFinder';
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
});
