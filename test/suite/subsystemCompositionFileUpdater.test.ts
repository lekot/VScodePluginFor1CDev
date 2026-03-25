/**
 * B.3 — persist subsystem `Properties.Content` via Designer XML file read/write.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { extractSubsystemCompositionRefs } from '../../src/parsers/xmlChildObjects';
import { XmlParser } from '../../src/parsers/xmlParser';
import {
  applySubsystemCompositionFileUpdate,
  getSubsystemPropertiesFromParsed,
  readSubsystemCompositionRefsFromFile,
} from '../../src/services/subsystemCompositionFileUpdater';
import { cleanupTempDir, createTempDir } from '../helpers/testHelpers';

/** Copied to `out/test/fixtures` by the test script (see package.json `test`). */
const DESIGNER_SUBSYSTEM_FIXTURE = path.join(__dirname, '../fixtures/designer/SubsystemEmptyContent.xml');

suite('subsystemCompositionFileUpdater (B.3 file slice)', () => {
  let tmpDir: string;

  setup(async () => {
    tmpDir = await createTempDir('1cviewer-subcomp-');
  });

  teardown(async () => {
    await cleanupTempDir(tmpDir);
  });

  test('applySubsystemCompositionFileUpdate merges validated refs and round-trips Content', async () => {
    const fp = path.join(tmpDir, 'TestSubsystem.xml');
    await fs.promises.copyFile(DESIGNER_SUBSYSTEM_FIXTURE, fp);
    const { refs, rejected } = await applySubsystemCompositionFileUpdate(fp, {
      add: ['Document.Order', 'bad', 'Catalog.Items'],
      remove: [],
    });
    assert.strictEqual(rejected.length, 1);
    assert.strictEqual(rejected[0].ref, 'bad');
    assert.deepStrictEqual(refs, ['Document.Order', 'Catalog.Items']);

    const parsed = await XmlParser.parseFileAsync(fp);
    const props = getSubsystemPropertiesFromParsed(parsed);
    assert.ok(props, 'expected Subsystem Properties');
    assert.deepStrictEqual(extractSubsystemCompositionRefs(props!.Content), refs);
    const raw = await fs.promises.readFile(fp, 'utf-8');
    assert.ok(raw.includes('<Name>{Name}</Name>'), 'other Properties should survive round-trip');
    assert.ok(raw.includes('Document.Order'), 'Content should list added refs in XML');
  });

  test('applySubsystemCompositionFileUpdate remove and empty Content', async () => {
    const fp = path.join(tmpDir, 'Sub2.xml');
    await fs.promises.copyFile(DESIGNER_SUBSYSTEM_FIXTURE, fp);
    await applySubsystemCompositionFileUpdate(fp, { add: ['Catalog.Keep', 'Catalog.Drop'], remove: [] });
    await applySubsystemCompositionFileUpdate(fp, { add: [], remove: ['Catalog.Drop', 'Missing'] });
    const parsed = await XmlParser.parseFileAsync(fp);
    const props = getSubsystemPropertiesFromParsed(parsed);
    assert.deepStrictEqual(extractSubsystemCompositionRefs(props!.Content), ['Catalog.Keep']);
    await applySubsystemCompositionFileUpdate(fp, { add: [], remove: ['Catalog.Keep'] });
    const parsed2 = await XmlParser.parseFileAsync(fp);
    const props2 = getSubsystemPropertiesFromParsed(parsed2);
    assert.deepStrictEqual(extractSubsystemCompositionRefs(props2!.Content), []);
  });

  test('readSubsystemCompositionRefsFromFile matches extract after write', async () => {
    const fp = path.join(tmpDir, 'ReadBack.xml');
    await fs.promises.copyFile(DESIGNER_SUBSYSTEM_FIXTURE, fp);
    await applySubsystemCompositionFileUpdate(fp, { add: ['Document.A', 'Catalog.B'], remove: [] });
    const fromReader = await readSubsystemCompositionRefsFromFile(fp);
    const parsed = await XmlParser.parseFileAsync(fp);
    const props = getSubsystemPropertiesFromParsed(parsed);
    assert.deepStrictEqual(fromReader, extractSubsystemCompositionRefs(props!.Content));
  });

  test('applySubsystemCompositionFileUpdate throws for non-subsystem root', async () => {
    const fp = path.join(tmpDir, 'Configuration.xml');
    await fs.promises.writeFile(
      fp,
      `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses">
  <Configuration uuid="u">
    <Properties><Name>X</Name></Properties>
    <ChildObjects/>
  </Configuration>
</MetaDataObject>`,
      'utf-8'
    );
    await assert.rejects(
      () => applySubsystemCompositionFileUpdate(fp, { add: ['Catalog.A'], remove: [] }),
      /Not a subsystem metadata file/
    );
  });

  test('readSubsystemCompositionRefsFromFile returns [] for non-subsystem XML', async () => {
    const fp = path.join(tmpDir, 'Configuration.xml');
    await fs.promises.writeFile(
      fp,
      `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses">
  <Configuration uuid="u">
    <Properties><Name>X</Name></Properties>
    <ChildObjects/>
  </Configuration>
</MetaDataObject>`,
      'utf-8'
    );
    const refs = await readSubsystemCompositionRefsFromFile(fp);
    assert.deepStrictEqual(refs, []);
  });
});

suite('getSubsystemPropertiesFromParsed (B.3 navigation)', () => {
  test('returns null when MetaDataObject is missing', () => {
    assert.strictEqual(getSubsystemPropertiesFromParsed({ ChildObjects: [] } as Record<string, unknown>), null);
  });

  test('returns null when Subsystem branch is missing', () => {
    const parsed = {
      MetaDataObject: {
        Configuration: { Properties: { Name: 'X' } },
      },
    } as Record<string, unknown>;
    assert.strictEqual(getSubsystemPropertiesFromParsed(parsed), null);
  });

  test('returns Properties object for plain nested shape', () => {
    const props = { Content: {}, Name: 'N' };
    const parsed = {
      MetaDataObject: {
        Subsystem: {
          Properties: props,
        },
      },
    } as Record<string, unknown>;
    assert.strictEqual(getSubsystemPropertiesFromParsed(parsed), props);
  });

  test('unwraps array-wrapped MetaDataObject and Subsystem', () => {
    const props = { Content: [] };
    const parsed = {
      MetaDataObject: [{ Subsystem: [{ Properties: props }] }],
    } as Record<string, unknown>;
    assert.strictEqual(getSubsystemPropertiesFromParsed(parsed), props);
  });

  test('returns null when Properties is an array', () => {
    const parsed = {
      MetaDataObject: {
        Subsystem: {
          Properties: [],
        },
      },
    } as Record<string, unknown>;
    assert.strictEqual(getSubsystemPropertiesFromParsed(parsed), null);
  });

  test('returns null when Subsystem is not an object', () => {
    const parsed = {
      MetaDataObject: {
        Subsystem: 'broken',
      },
    } as unknown as Record<string, unknown>;
    assert.strictEqual(getSubsystemPropertiesFromParsed(parsed), null);
  });

  test('returns null when MetaDataObject is null', () => {
    const parsed = { MetaDataObject: null } as unknown as Record<string, unknown>;
    assert.strictEqual(getSubsystemPropertiesFromParsed(parsed), null);
  });
});
