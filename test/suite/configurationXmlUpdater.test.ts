import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  addRootObjectToConfiguration,
  removeRootObjectFromConfiguration,
} from '../../src/services/configurationXmlUpdater';
import { createTempDir, cleanupTempDir } from '../helpers/testHelpers';

/**
 * Tests for configurationXmlUpdater module.
 * Validates: addRootObjectToConfiguration, removeRootObjectFromConfiguration.
 *
 * Would have caught:
 * - Configuration.xml not updated after createElement/deleteElement
 * - Wrong rootTag, duplicate entries, missing entries
 */

const MINIMAL_CONFIG_XML = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core">
  <Configuration uuid="4b623a8e-ac76-4c84-97d7-795de87f4d82">
    <Properties>
      <Name>ТестКонфигурация</Name>
    </Properties>
    <ChildObjects>
      <Language>Русский</Language>
      <Catalog>Справочник1</Catalog>
    </ChildObjects>
  </Configuration>
</MetaDataObject>`;

const CONFIG_NO_CHILDOBJECTS = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core">
  <Configuration uuid="4b623a8e-ac76-4c84-97d7-795de87f4d82">
    <Properties>
      <Name>ТестКонфигурация</Name>
    </Properties>
  </Configuration>
</MetaDataObject>`;

function readConfigXml(dir: string): string {
  return fs.readFileSync(path.join(dir, 'Configuration.xml'), 'utf-8');
}

suite('configurationXmlUpdater', () => {
  let tmpDir: string;

  setup(async () => {
    tmpDir = await createTempDir('1cviewer-config-');
  });

  teardown(async () => {
    await cleanupTempDir(tmpDir);
  });

  // --- addRootObjectToConfiguration ---

  test('adds a Catalog entry to existing ChildObjects', async () => {
    fs.writeFileSync(path.join(tmpDir, 'Configuration.xml'), MINIMAL_CONFIG_XML, 'utf-8');

    await addRootObjectToConfiguration(tmpDir, 'Catalog', 'Справочник2');

    const xml = readConfigXml(tmpDir);
    assert.ok(xml.includes('<Catalog>Справочник2</Catalog>'), 'New catalog entry should be added');
    assert.ok(xml.includes('<Catalog>Справочник1</Catalog>'), 'Existing catalog entry should remain');
  });

  test('adds a Document entry to existing ChildObjects', async () => {
    fs.writeFileSync(path.join(tmpDir, 'Configuration.xml'), MINIMAL_CONFIG_XML, 'utf-8');

    await addRootObjectToConfiguration(tmpDir, 'Document', 'Документ1');

    const xml = readConfigXml(tmpDir);
    assert.ok(xml.includes('<Document>Документ1</Document>'));
    assert.ok(xml.includes('<Language>Русский</Language>'), 'Existing entries should remain');
  });

  test('creates ChildObjects section when missing', async () => {
    fs.writeFileSync(path.join(tmpDir, 'Configuration.xml'), CONFIG_NO_CHILDOBJECTS, 'utf-8');

    await addRootObjectToConfiguration(tmpDir, 'Catalog', 'ПервыйСправочник');

    const xml = readConfigXml(tmpDir);
    assert.ok(xml.includes('<ChildObjects>'), 'ChildObjects section should be created');
    assert.ok(xml.includes('<Catalog>ПервыйСправочник</Catalog>'));
  });

  test('throws for non-existent Configuration.xml', async () => {
    await assert.rejects(
      () => addRootObjectToConfiguration(tmpDir, 'Catalog', 'Test'),
      /Configuration\.xml not found or unreadable/
    );
  });

  // --- removeRootObjectFromConfiguration ---

  test('removes a Catalog entry from ChildObjects', async () => {
    fs.writeFileSync(path.join(tmpDir, 'Configuration.xml'), MINIMAL_CONFIG_XML, 'utf-8');

    await removeRootObjectFromConfiguration(tmpDir, 'Catalog', 'Справочник1');

    const xml = readConfigXml(tmpDir);
    assert.ok(!xml.includes('<Catalog>Справочник1</Catalog>'), 'Catalog entry should be removed');
    assert.ok(xml.includes('<Language>Русский</Language>'), 'Language entry should remain');
  });

  test('removes only the matching entry when multiple of same type exist', async () => {
    const multiDocConfig = MINIMAL_CONFIG_XML.replace(
      '</ChildObjects>',
      '<Document>Документ1</Document><Document>Документ2</Document></ChildObjects>'
    );
    fs.writeFileSync(path.join(tmpDir, 'Configuration.xml'), multiDocConfig, 'utf-8');

    await removeRootObjectFromConfiguration(tmpDir, 'Document', 'Документ1');

    const xml = readConfigXml(tmpDir);
    assert.ok(!xml.includes('<Document>Документ1</Document>'), 'Removed document should be gone');
    assert.ok(xml.includes('<Document>Документ2</Document>'), 'Other document should remain');
    assert.ok(xml.includes('<Catalog>Справочник1</Catalog>'), 'Catalog should remain');
  });

  test('does nothing when entry not found', async () => {
    const original = MINIMAL_CONFIG_XML;
    fs.writeFileSync(path.join(tmpDir, 'Configuration.xml'), original, 'utf-8');

    await removeRootObjectFromConfiguration(tmpDir, 'Document', 'НесуществующийДокумент');

    const xml = readConfigXml(tmpDir);
    assert.ok(xml.includes('<Catalog>Справочник1</Catalog>'), 'Existing entries should remain');
    assert.ok(xml.includes('<Language>Русский</Language>'), 'Language should remain');
  });

  test('removes ChildObjects node when last entry is removed', async () => {
    // Config with only one child object
    const singleChildConfig = MINIMAL_CONFIG_XML.replace(
      '<Catalog>Справочник1</Catalog>\n    ',
      ''
    );
    fs.writeFileSync(path.join(tmpDir, 'Configuration.xml'), singleChildConfig, 'utf-8');

    await removeRootObjectFromConfiguration(tmpDir, 'Language', 'Русский');

    const xml = readConfigXml(tmpDir);
    assert.ok(!xml.includes('<ChildObjects>'), 'Empty ChildObjects should be removed');
    assert.ok(!xml.includes('<Language>Русский</Language>'), 'Language entry should be gone');
  });

  test('throws for non-existent Configuration.xml', async () => {
    await assert.rejects(
      () => removeRootObjectFromConfiguration(tmpDir, 'Catalog', 'Test'),
      /Configuration\.xml not found or unreadable/
    );
  });
});
