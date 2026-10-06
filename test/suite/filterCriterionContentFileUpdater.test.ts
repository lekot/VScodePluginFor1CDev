/**
 * Tests for filterCriterionContentFileUpdater — FilterCriterion Content read/write.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  readFilterCriterionContent,
  applyFilterCriterionContentUpdate,
} from '../../src/services/filterCriterionContentFileUpdater';
import { cleanupTempDir, createTempDir } from '../helpers/testHelpers';

const FILTER_CRITERION_XML = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="2.20">
	<FilterCriterion uuid="test-uuid">
		<Properties>
			<Name>TestCriterion</Name>
			<Content>
				<xr:Item xsi:type="xr:MDObjectRef">Catalog.Customers.Attribute.Code</xr:Item>
				<xr:Item xsi:type="xr:MDObjectRef">Document.Invoice.Attribute.BuyerCode</xr:Item>
			</Content>
		</Properties>
	</FilterCriterion>
</MetaDataObject>`;

const FILTER_CRITERION_EMPTY_CONTENT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="2.20">
	<FilterCriterion uuid="test-uuid">
		<Properties>
			<Name>EmptyCriterion</Name>
			<Content/>
		</Properties>
	</FilterCriterion>
</MetaDataObject>`;

suite('filterCriterionContentFileUpdater', () => {
  let tmpDir: string;

  setup(async () => {
    tmpDir = await createTempDir('1cviewer-filtercrit-');
  });

  teardown(async () => {
    await cleanupTempDir(tmpDir);
  });

  test('readFilterCriterionContent — reads refs', async () => {
    const fp = path.join(tmpDir, 'TestCriterion.xml');
    await fs.promises.writeFile(fp, FILTER_CRITERION_XML, 'utf-8');

    const result = await readFilterCriterionContent(fp);

    assert.deepStrictEqual(result.refs, [
      'Catalog.Customers.Attribute.Code',
      'Document.Invoice.Attribute.BuyerCode',
    ]);
    assert.strictEqual(result.itemSettings.size, 0);
  });

  test('readFilterCriterionContent — handles empty Content', async () => {
    const fp = path.join(tmpDir, 'EmptyCriterion.xml');
    await fs.promises.writeFile(fp, FILTER_CRITERION_EMPTY_CONTENT_XML, 'utf-8');

    const result = await readFilterCriterionContent(fp);

    assert.deepStrictEqual(result.refs, []);
  });

  test('applyFilterCriterionContentUpdate — adds new ref with xsi:type xr:MDObjectRef', async () => {
    const fp = path.join(tmpDir, 'TestCriterion.xml');
    await fs.promises.writeFile(fp, FILTER_CRITERION_XML, 'utf-8');

    const { rejected } = await applyFilterCriterionContentUpdate(fp, {
      add: ['Catalog.Products.Attribute.SKU'],
      remove: [],
      settingsChanged: new Map(),
    });

    assert.strictEqual(rejected.length, 0);
    const result = await readFilterCriterionContent(fp);
    assert.ok(result.refs.includes('Catalog.Products.Attribute.SKU'));
    assert.ok(result.refs.includes('Catalog.Customers.Attribute.Code'));

    const raw = await fs.promises.readFile(fp, 'utf-8');
    assert.ok(raw.includes('xr:MDObjectRef'), 'Must format items with xr:MDObjectRef xsi:type');
  });

  test('applyFilterCriterionContentUpdate — removes ref', async () => {
    const fp = path.join(tmpDir, 'TestCriterion.xml');
    await fs.promises.writeFile(fp, FILTER_CRITERION_XML, 'utf-8');

    await applyFilterCriterionContentUpdate(fp, {
      add: [],
      remove: ['Catalog.Customers.Attribute.Code'],
      settingsChanged: new Map(),
    });

    const result = await readFilterCriterionContent(fp);
    assert.ok(!result.refs.includes('Catalog.Customers.Attribute.Code'));
    assert.ok(result.refs.includes('Document.Invoice.Attribute.BuyerCode'));
  });

  test('applyFilterCriterionContentUpdate — rejects empty ref', async () => {
    const fp = path.join(tmpDir, 'TestCriterion.xml');
    await fs.promises.writeFile(fp, FILTER_CRITERION_XML, 'utf-8');

    const { rejected } = await applyFilterCriterionContentUpdate(fp, {
      add: ['   '],
      remove: [],
      settingsChanged: new Map(),
    });

    assert.strictEqual(rejected.length, 1);
    assert.ok(rejected[0].reason.toLowerCase().includes('empty'));
  });
});
