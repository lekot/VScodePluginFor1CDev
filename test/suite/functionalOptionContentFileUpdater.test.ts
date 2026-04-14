/**
 * Tests for functionalOptionContentFileUpdater — FunctionalOption Content read/write.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readFunctionalOptionContent,
  applyFunctionalOptionContentUpdate,
} from '../../src/services/functionalOptionContentFileUpdater';
import { cleanupTempDir, createTempDir } from '../helpers/testHelpers';

const FUNCTIONAL_OPTION_XML = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="2.20">
	<FunctionalOption uuid="test-uuid">
		<Properties>
			<Name>TestOption</Name>
			<Content>
				<xr:Object>Subsystem.TestSub</xr:Object>
				<xr:Object>DataProcessor.Test.Command.Run</xr:Object>
			</Content>
		</Properties>
	</FunctionalOption>
</MetaDataObject>`;

const FUNCTIONAL_OPTION_EMPTY_CONTENT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="2.20">
	<FunctionalOption uuid="test-uuid">
		<Properties>
			<Name>EmptyOption</Name>
			<Content/>
		</Properties>
	</FunctionalOption>
</MetaDataObject>`;

suite('functionalOptionContentFileUpdater', () => {
  let tmpDir: string;

  setup(async () => {
    tmpDir = await createTempDir('1cviewer-funcoption-');
  });

  teardown(async () => {
    await cleanupTempDir(tmpDir);
  });

  test('readFunctionalOptionContent — reads refs', async () => {
    const fp = path.join(tmpDir, 'TestOption.xml');
    await fs.promises.writeFile(fp, FUNCTIONAL_OPTION_XML, 'utf-8');

    const result = await readFunctionalOptionContent(fp);

    assert.deepStrictEqual(result.refs, ['Subsystem.TestSub', 'DataProcessor.Test.Command.Run']);
    assert.strictEqual(result.itemSettings.size, 0);
  });

  test('readFunctionalOptionContent — handles empty Content', async () => {
    const fp = path.join(tmpDir, 'EmptyOption.xml');
    await fs.promises.writeFile(fp, FUNCTIONAL_OPTION_EMPTY_CONTENT_XML, 'utf-8');

    const result = await readFunctionalOptionContent(fp);

    assert.deepStrictEqual(result.refs, []);
  });

  test('applyFunctionalOptionContentUpdate — adds new ref', async () => {
    const fp = path.join(tmpDir, 'TestOption.xml');
    await fs.promises.writeFile(fp, FUNCTIONAL_OPTION_XML, 'utf-8');

    const { rejected } = await applyFunctionalOptionContentUpdate(fp, {
      add: ['Catalog.Products'],
      remove: [],
      settingsChanged: new Map(),
    });

    assert.strictEqual(rejected.length, 0);
    const result = await readFunctionalOptionContent(fp);
    assert.ok(result.refs.includes('Catalog.Products'));
    assert.ok(result.refs.includes('Subsystem.TestSub'));
  });

  test('applyFunctionalOptionContentUpdate — removes ref', async () => {
    const fp = path.join(tmpDir, 'TestOption.xml');
    await fs.promises.writeFile(fp, FUNCTIONAL_OPTION_XML, 'utf-8');

    await applyFunctionalOptionContentUpdate(fp, {
      add: [],
      remove: ['Subsystem.TestSub'],
      settingsChanged: new Map(),
    });

    const result = await readFunctionalOptionContent(fp);
    assert.ok(!result.refs.includes('Subsystem.TestSub'));
    assert.ok(result.refs.includes('DataProcessor.Test.Command.Run'));
  });

  test('applyFunctionalOptionContentUpdate — handles multi-dot refs (DataProcessor.Name.Command.Name)', async () => {
    const fp = path.join(tmpDir, 'TestOption.xml');
    await fs.promises.writeFile(fp, FUNCTIONAL_OPTION_XML, 'utf-8');

    const { rejected } = await applyFunctionalOptionContentUpdate(fp, {
      add: ['DataProcessor.Sales.Command.CreateOrder'],
      remove: [],
      settingsChanged: new Map(),
    });

    assert.strictEqual(rejected.length, 0);
    const result = await readFunctionalOptionContent(fp);
    assert.ok(result.refs.includes('DataProcessor.Sales.Command.CreateOrder'));
  });

  test('applyFunctionalOptionContentUpdate — rejects empty ref', async () => {
    const fp = path.join(tmpDir, 'TestOption.xml');
    await fs.promises.writeFile(fp, FUNCTIONAL_OPTION_XML, 'utf-8');

    const { rejected } = await applyFunctionalOptionContentUpdate(fp, {
      add: [''],
      remove: [],
      settingsChanged: new Map(),
    });

    assert.strictEqual(rejected.length, 1);
    assert.ok(rejected[0].reason.toLowerCase().includes('empty'));
  });
});
