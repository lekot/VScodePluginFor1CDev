/**
 * Tests for commonAttributeContentFileUpdater — CommonAttribute Content read/write.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readCommonAttributeContent,
  applyCommonAttributeContentUpdate,
} from '../../src/services/commonAttributeContentFileUpdater';
import { cleanupTempDir, createTempDir } from '../helpers/testHelpers';

const COMMON_ATTRIBUTE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="2.20">
	<CommonAttribute uuid="test-uuid">
		<Properties>
			<Name>TestAttr</Name>
			<Content>
				<xr:Item>
					<xr:Metadata>Catalog.Test</xr:Metadata>
					<xr:Use>Use</xr:Use>
					<xr:ConditionalSeparation/>
				</xr:Item>
				<xr:Item>
					<xr:Metadata>Document.Order</xr:Metadata>
					<xr:Use>DontUse</xr:Use>
					<xr:ConditionalSeparation>Separate</xr:ConditionalSeparation>
				</xr:Item>
			</Content>
		</Properties>
	</CommonAttribute>
</MetaDataObject>`;

suite('commonAttributeContentFileUpdater', () => {
  let tmpDir: string;

  setup(async () => {
    tmpDir = await createTempDir('1cviewer-commonattr-');
  });

  teardown(async () => {
    await cleanupTempDir(tmpDir);
  });

  test('readCommonAttributeContent — reads refs and Use settings', async () => {
    const fp = path.join(tmpDir, 'TestAttr.xml');
    await fs.promises.writeFile(fp, COMMON_ATTRIBUTE_XML, 'utf-8');

    const result = await readCommonAttributeContent(fp);

    assert.deepStrictEqual(result.refs, ['Catalog.Test', 'Document.Order']);
    assert.strictEqual(result.itemSettings.get('Catalog.Test')?.['Use'], 'Use');
    assert.strictEqual(result.itemSettings.get('Document.Order')?.['Use'], 'DontUse');
  });

  test('applyCommonAttributeContentUpdate — adds new ref with default Use', async () => {
    const fp = path.join(tmpDir, 'TestAttr.xml');
    await fs.promises.writeFile(fp, COMMON_ATTRIBUTE_XML, 'utf-8');

    const { rejected } = await applyCommonAttributeContentUpdate(fp, {
      add: ['Catalog.NewOne'],
      remove: [],
      settingsChanged: new Map(),
    });

    assert.strictEqual(rejected.length, 0);
    const result = await readCommonAttributeContent(fp);
    assert.ok(result.refs.includes('Catalog.NewOne'));
    assert.strictEqual(result.itemSettings.get('Catalog.NewOne')?.['Use'], 'Use');
  });

  test('applyCommonAttributeContentUpdate — removes ref', async () => {
    const fp = path.join(tmpDir, 'TestAttr.xml');
    await fs.promises.writeFile(fp, COMMON_ATTRIBUTE_XML, 'utf-8');

    await applyCommonAttributeContentUpdate(fp, {
      add: [],
      remove: ['Document.Order'],
      settingsChanged: new Map(),
    });

    const result = await readCommonAttributeContent(fp);
    assert.ok(!result.refs.includes('Document.Order'));
    assert.ok(result.refs.includes('Catalog.Test'));
  });

  test('applyCommonAttributeContentUpdate — changes Use setting', async () => {
    const fp = path.join(tmpDir, 'TestAttr.xml');
    await fs.promises.writeFile(fp, COMMON_ATTRIBUTE_XML, 'utf-8');

    await applyCommonAttributeContentUpdate(fp, {
      add: [],
      remove: [],
      settingsChanged: new Map([['Catalog.Test', { Use: 'DontUse' }]]),
    });

    const result = await readCommonAttributeContent(fp);
    assert.strictEqual(result.itemSettings.get('Catalog.Test')?.['Use'], 'DontUse');
  });

  test('applyCommonAttributeContentUpdate — preserves ConditionalSeparation on round-trip', async () => {
    const fp = path.join(tmpDir, 'TestAttr.xml');
    await fs.promises.writeFile(fp, COMMON_ATTRIBUTE_XML, 'utf-8');

    // Change Use for Document.Order but don't touch ConditionalSeparation
    await applyCommonAttributeContentUpdate(fp, {
      add: [],
      remove: [],
      settingsChanged: new Map([['Document.Order', { Use: 'Use' }]]),
    });

    const result = await readCommonAttributeContent(fp);
    assert.strictEqual(result.itemSettings.get('Document.Order')?.['Use'], 'Use');
    assert.strictEqual(result.itemSettings.get('Document.Order')?.['ConditionalSeparation'], 'Separate');
  });

  test('applyCommonAttributeContentUpdate — rejects invalid ref', async () => {
    const fp = path.join(tmpDir, 'TestAttr.xml');
    await fs.promises.writeFile(fp, COMMON_ATTRIBUTE_XML, 'utf-8');

    const { rejected } = await applyCommonAttributeContentUpdate(fp, {
      add: ['bad'],
      remove: [],
      settingsChanged: new Map(),
    });

    assert.strictEqual(rejected.length, 1);
    assert.strictEqual(rejected[0].ref, 'bad');
    const result = await readCommonAttributeContent(fp);
    assert.ok(!result.refs.includes('bad'));
  });
});
