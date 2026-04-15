/**
 * Tests for exchangePlanContentFileUpdater — ExchangePlan Ext/Content.xml read/write.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readExchangePlanContent,
  applyExchangePlanContentUpdate,
} from '../../src/services/exchangePlanContentFileUpdater';
import { cleanupTempDir, createTempDir } from '../helpers/testHelpers';

const EXCHANGE_PLAN_CONTENT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ExchangePlanContent xmlns="http://v8.1c.ru/8.3/xcf/extrnprops" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="2.20">
	<Item>
		<Metadata>Catalog.Контрагенты</Metadata>
		<AutoRecord>Allow</AutoRecord>
	</Item>
	<Item>
		<Metadata>Document.Заказ</Metadata>
		<AutoRecord>Deny</AutoRecord>
	</Item>
</ExchangePlanContent>`;

suite('exchangePlanContentFileUpdater', () => {
  let tmpDir: string;

  setup(async () => {
    tmpDir = await createTempDir('1cviewer-exchangeplan-');
  });

  teardown(async () => {
    await cleanupTempDir(tmpDir);
  });

  test('readExchangePlanContent — reads refs and AutoRecord settings', async () => {
    const fp = path.join(tmpDir, 'Content.xml');
    await fs.promises.writeFile(fp, EXCHANGE_PLAN_CONTENT_XML, 'utf-8');

    const result = await readExchangePlanContent(fp);

    assert.deepStrictEqual(result.refs, ['Catalog.Контрагенты', 'Document.Заказ']);
    assert.deepStrictEqual(result.itemSettings.get('Catalog.Контрагенты'), { AutoRecord: 'Allow' });
    assert.deepStrictEqual(result.itemSettings.get('Document.Заказ'), { AutoRecord: 'Deny' });
  });

  test('readExchangePlanContent — returns empty for non-existent file', async () => {
    const fp = path.join(tmpDir, 'nonexistent', 'Content.xml');

    const result = await readExchangePlanContent(fp);

    assert.deepStrictEqual(result.refs, []);
    assert.strictEqual(result.itemSettings.size, 0);
  });

  test('applyExchangePlanContentUpdate — adds new ref with default AutoRecord', async () => {
    const fp = path.join(tmpDir, 'Content.xml');
    await fs.promises.writeFile(fp, EXCHANGE_PLAN_CONTENT_XML, 'utf-8');

    const { rejected } = await applyExchangePlanContentUpdate(fp, {
      add: ['Catalog.Товары'],
      remove: [],
      settingsChanged: new Map(),
    });

    assert.strictEqual(rejected.length, 0);
    const result = await readExchangePlanContent(fp);
    assert.ok(result.refs.includes('Catalog.Товары'));
    assert.deepStrictEqual(result.itemSettings.get('Catalog.Товары'), { AutoRecord: 'Allow' });
  });

  test('applyExchangePlanContentUpdate — removes ref', async () => {
    const fp = path.join(tmpDir, 'Content.xml');
    await fs.promises.writeFile(fp, EXCHANGE_PLAN_CONTENT_XML, 'utf-8');

    await applyExchangePlanContentUpdate(fp, {
      add: [],
      remove: ['Document.Заказ'],
      settingsChanged: new Map(),
    });

    const result = await readExchangePlanContent(fp);
    assert.ok(!result.refs.includes('Document.Заказ'));
    assert.ok(result.refs.includes('Catalog.Контрагенты'));
  });

  test('applyExchangePlanContentUpdate — changes AutoRecord setting', async () => {
    const fp = path.join(tmpDir, 'Content.xml');
    await fs.promises.writeFile(fp, EXCHANGE_PLAN_CONTENT_XML, 'utf-8');

    await applyExchangePlanContentUpdate(fp, {
      add: [],
      remove: [],
      settingsChanged: new Map([['Catalog.Контрагенты', { AutoRecord: 'Deny' }]]),
    });

    const result = await readExchangePlanContent(fp);
    assert.deepStrictEqual(result.itemSettings.get('Catalog.Контрагенты'), { AutoRecord: 'Deny' });
  });

  test('applyExchangePlanContentUpdate — rejects invalid ref', async () => {
    const fp = path.join(tmpDir, 'Content.xml');
    await fs.promises.writeFile(fp, EXCHANGE_PLAN_CONTENT_XML, 'utf-8');

    const { rejected } = await applyExchangePlanContentUpdate(fp, {
      add: ['bad-ref-without-dot'],
      remove: [],
      settingsChanged: new Map(),
    });

    assert.strictEqual(rejected.length, 1);
    assert.strictEqual(rejected[0].ref, 'bad-ref-without-dot');

    const result = await readExchangePlanContent(fp);
    assert.ok(!result.refs.includes('bad-ref-without-dot'));
  });

  test('applyExchangePlanContentUpdate — creates dir and file if not exists', async () => {
    const fp = path.join(tmpDir, 'ExchangePlan', 'Ext', 'Content.xml');

    const { rejected } = await applyExchangePlanContentUpdate(fp, {
      add: ['Catalog.New'],
      remove: [],
      settingsChanged: new Map(),
    });

    assert.strictEqual(rejected.length, 0);
    const exists = await fs.promises.access(fp).then(() => true).catch(() => false);
    assert.ok(exists, 'file should be created');
    const result = await readExchangePlanContent(fp);
    assert.deepStrictEqual(result.refs, ['Catalog.New']);
  });
});
