/**
 * Unit tests for rightsXmlEditWriter.ts
 * Covers all 9 exports: ensureRightsRootAttrsFor1CXdto, listRightsXmlCandidatePaths,
 * getRightsPath, createMinimalRightsDom, loadRightsXml, mergeRightsIntoDom,
 * stripRestrictionTemplateBlocksFromRightsXml, insertRestrictionTemplatesBeforeClosingRights,
 * serializeRightsDomToXml
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  ensureRightsRootAttrsFor1CXdto,
  listRightsXmlCandidatePaths,
  getRightsPath,
  createMinimalRightsDom,
  loadRightsXml,
  mergeRightsIntoDom,
  stripRestrictionTemplateBlocksFromRightsXml,
  insertRestrictionTemplatesBeforeClosingRights,
  serializeRightsDomToXml,
  type RightsDom,
} from '../../src/rolesEditor/rightsXmlEditWriter';
import { createEmptyObjectRights } from '../../src/rolesEditor/models/roleModel';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid Rights.xml string for use in tests. */
const MINIMAL_RIGHTS_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<Rights xmlns="http://v8.1c.ru/8.2/roles" xmlns:xs="http://www.w3.org/2001/XMLSchema"',
  ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="Rights" version="2.20">',
  '  <setForNewObjects>false</setForNewObjects>',
  '  <setForAttributesByDefault>true</setForAttributesByDefault>',
  '  <independentRightsOfChildObjects>false</independentRightsOfChildObjects>',
  '</Rights>',
  '',
].join('\n');

/** Minimal Rights.xml with one object entry. */
const RIGHTS_XML_WITH_OBJECT = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<Rights xmlns="http://v8.1c.ru/8.2/roles" xmlns:xs="http://www.w3.org/2001/XMLSchema"',
  ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="Rights" version="2.20">',
  '  <object>',
  '    <name>Catalog.Products</name>',
  '    <right><name>Read</name><value>true</value></right>',
  '  </object>',
  '</Rights>',
  '',
].join('\n');

/** Rights.xml with a restrictionTemplate block. */
const RIGHTS_XML_WITH_TEMPLATE = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<Rights xmlns="http://v8.1c.ru/8.2/roles" xmlns:xs="http://www.w3.org/2001/XMLSchema"',
  ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="Rights" version="2.20">',
  '  <object>',
  '    <name>Catalog.Products</name>',
  '    <right><name>Read</name><value>true</value></right>',
  '  </object>',
  '  <restrictionTemplate>',
  '    <name>Tmpl1</name>',
  '    <condition>true</condition>',
  '  </restrictionTemplate>',
  '</Rights>',
  '',
].join('\n');

async function writeTempFile(dir: string, relPath: string, content: string): Promise<string> {
  const fullPath = path.join(dir, relPath);
  await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.promises.writeFile(fullPath, content, 'utf-8');
  return fullPath;
}

// ---------------------------------------------------------------------------
// Suite: ensureRightsRootAttrsFor1CXdto
// ---------------------------------------------------------------------------

suite('ensureRightsRootAttrsFor1CXdto', () => {
  test('adds full attribute bag when Rights content has no leading :@ node', () => {
    const dom: RightsDom = [
      {
        Rights: [
          { setForNewObjects: [{ '#text': 'false' }] },
        ]
      }
    ];

    ensureRightsRootAttrsFor1CXdto(dom);

    const content = (dom[0] as Record<string, unknown>)['Rights'] as unknown[];
    const first = content[0] as Record<string, unknown>;
    assert.ok(':@' in first, 'first item should be attribute bag after ensure');
    const bag = first[':@'] as Record<string, string>;
    assert.strictEqual(bag['@_xmlns'], 'http://v8.1c.ru/8.2/roles');
    assert.strictEqual(bag['@_xsi:type'], 'Rights');
    assert.strictEqual(bag['@_version'], '2.20');
  });

  test('fills missing attrs when partial :@ bag already present', () => {
    const dom: RightsDom = [
      {
        Rights: [
          { ':@': { '@_xmlns': 'http://v8.1c.ru/8.2/roles' } },
          { setForNewObjects: [{ '#text': 'false' }] },
        ]
      }
    ];

    ensureRightsRootAttrsFor1CXdto(dom);

    const content = (dom[0] as Record<string, unknown>)['Rights'] as unknown[];
    const bag = (content[0] as Record<string, unknown>)[':@'] as Record<string, string>;
    assert.strictEqual(bag['@_xsi:type'], 'Rights', 'missing xsi:type must be filled in');
    assert.strictEqual(bag['@_version'], '2.20', 'missing version must be filled in');
    // pre-existing value must not be overwritten
    assert.strictEqual(bag['@_xmlns'], 'http://v8.1c.ru/8.2/roles');
  });

  test('does not overwrite existing valid attrs', () => {
    const dom: RightsDom = [
      {
        Rights: [
          {
            ':@': {
              '@_xmlns': 'http://v8.1c.ru/8.2/roles',
              '@_xmlns:xs': 'http://www.w3.org/2001/XMLSchema',
              '@_xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
              '@_xsi:type': 'Rights',
              '@_version': '2.20'
            }
          },
          { setForNewObjects: [{ '#text': 'false' }] },
        ]
      }
    ];

    ensureRightsRootAttrsFor1CXdto(dom);

    const content = (dom[0] as Record<string, unknown>)['Rights'] as unknown[];
    // Should still be exactly 2 items — no extra :@ was prepended
    assert.strictEqual(content.length, 2);
    const bag = (content[0] as Record<string, unknown>)[':@'] as Record<string, string>;
    assert.strictEqual(bag['@_version'], '2.20');
  });

  test('no-ops on empty dom', () => {
    const dom: RightsDom = [];
    assert.doesNotThrow(() => ensureRightsRootAttrsFor1CXdto(dom));
  });

  test('no-ops when root has no Rights key', () => {
    const dom: RightsDom = [{ SomethingElse: [] }];
    assert.doesNotThrow(() => ensureRightsRootAttrsFor1CXdto(dom));
    // Unchanged
    assert.ok(!('Rights' in (dom[0] as Record<string, unknown>)));
  });
});

// ---------------------------------------------------------------------------
// Suite: listRightsXmlCandidatePaths
// ---------------------------------------------------------------------------

suite('listRightsXmlCandidatePaths', () => {
  test('EDT role file (not Role.xml) returns two candidates', () => {
    const roleFile = '/project/src/Roles/MyRole.xml';
    const candidates = listRightsXmlCandidatePaths(roleFile);
    assert.strictEqual(candidates.length, 2);
    assert.ok(candidates[0].endsWith(path.join('MyRole', 'Ext', 'Rights.xml')));
    assert.ok(candidates[1].endsWith(path.join('Ext', 'Rights.xml')));
  });

  test('Designer role file (Role.xml) returns one candidate', () => {
    const roleFile = '/project/src/Roles/MyRole/Role.xml';
    const candidates = listRightsXmlCandidatePaths(roleFile);
    assert.strictEqual(candidates.length, 1);
    assert.ok(candidates[0].endsWith(path.join('Ext', 'Rights.xml')));
    // Should be relative to the Role.xml directory, i.e., Roles/MyRole/Ext/Rights.xml
    assert.ok(candidates[0].includes(path.join('MyRole', 'Ext', 'Rights.xml')));
  });

  test('paths are absolute when input is absolute', () => {
    const roleFile = path.join(os.tmpdir(), 'Roles', 'SomeRole.xml');
    const candidates = listRightsXmlCandidatePaths(roleFile);
    for (const c of candidates) {
      assert.ok(path.isAbsolute(c), `Expected absolute path, got: ${c}`);
    }
  });

  test('case-insensitive basename matching for Role.xml', () => {
    // role.xml (lower-case) should also be treated as Designer layout
    const roleFile = '/project/Roles/TestRole/role.xml';
    const candidates = listRightsXmlCandidatePaths(roleFile);
    assert.strictEqual(candidates.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Suite: getRightsPath
// ---------------------------------------------------------------------------

suite('getRightsPath', () => {
  test('returns first candidate (EDT path) for EDT role file', () => {
    const roleFile = '/project/Roles/MyRole.xml';
    const result = getRightsPath(roleFile);
    const expected = listRightsXmlCandidatePaths(roleFile)[0];
    assert.strictEqual(result, expected);
  });

  test('returns Ext/Rights.xml adjacent to Role.xml for Designer layout', () => {
    const roleFile = '/project/Roles/MyRole/Role.xml';
    const result = getRightsPath(roleFile);
    assert.ok(result.endsWith(path.join('MyRole', 'Ext', 'Rights.xml')));
  });
});

// ---------------------------------------------------------------------------
// Suite: createMinimalRightsDom
// ---------------------------------------------------------------------------

suite('createMinimalRightsDom', () => {
  test('returns array with single Rights root', () => {
    const dom = createMinimalRightsDom();
    assert.ok(Array.isArray(dom));
    assert.strictEqual(dom.length, 1);
    const root = dom[0] as Record<string, unknown>;
    assert.ok('Rights' in root, 'root item should have Rights key');
  });

  test('Rights content contains required child elements', () => {
    const dom = createMinimalRightsDom();
    const content = (dom[0] as Record<string, unknown>)['Rights'] as unknown[];
    const tags = content
      .filter((item) => typeof item === 'object' && item !== null && !(':@' in (item as object)))
      .map((item) => Object.keys(item as object)[0]);

    assert.ok(tags.includes('setForNewObjects'), 'missing setForNewObjects');
    assert.ok(tags.includes('setForAttributesByDefault'), 'missing setForAttributesByDefault');
    assert.ok(tags.includes('independentRightsOfChildObjects'), 'missing independentRightsOfChildObjects');
  });

  test('first content item is attribute bag with xmlns attrs', () => {
    const dom = createMinimalRightsDom();
    const content = (dom[0] as Record<string, unknown>)['Rights'] as unknown[];
    const first = content[0] as Record<string, unknown>;
    assert.ok(':@' in first, 'first item must be attribute bag');
    const bag = first[':@'] as Record<string, string>;
    assert.strictEqual(bag['@_xmlns'], 'http://v8.1c.ru/8.2/roles');
    assert.strictEqual(bag['@_xsi:type'], 'Rights');
  });

  test('serializes to valid XML without throwing', () => {
    const dom = createMinimalRightsDom();
    const xml = serializeRightsDomToXml(dom);
    assert.ok(xml.startsWith('<?xml'));
    assert.ok(xml.includes('<Rights'));
    assert.ok(xml.includes('</Rights>'));
  });
});

// ---------------------------------------------------------------------------
// Suite: loadRightsXml
// ---------------------------------------------------------------------------

suite('loadRightsXml', () => {
  let tmpDir: string;

  setup(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-rew-test-'));
  });

  teardown(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  test('returns minimal dom for nonexistent file (ENOENT)', async () => {
    const missing = path.join(tmpDir, 'Missing', 'Rights.xml');
    const dom = await loadRightsXml(missing);
    assert.ok(Array.isArray(dom) && dom.length > 0, 'should return minimal dom');
    const root = dom[0] as Record<string, unknown>;
    assert.ok('Rights' in root);
  });

  test('returns minimal dom for empty file', async () => {
    const emptyPath = await writeTempFile(tmpDir, 'Rights.xml', '');
    const dom = await loadRightsXml(emptyPath);
    assert.ok(Array.isArray(dom) && dom.length > 0);
    const root = dom[0] as Record<string, unknown>;
    assert.ok('Rights' in root);
  });

  test('returns minimal dom for whitespace-only file', async () => {
    const wsPath = await writeTempFile(tmpDir, 'ws/Rights.xml', '   \n\t  ');
    const dom = await loadRightsXml(wsPath);
    assert.ok(Array.isArray(dom) && dom.length > 0);
  });

  test('parses valid minimal Rights.xml', async () => {
    const xmlPath = await writeTempFile(tmpDir, 'valid/Rights.xml', MINIMAL_RIGHTS_XML);
    const dom = await loadRightsXml(xmlPath);
    assert.ok(Array.isArray(dom) && dom.length > 0);
    // preserveOrder: dom[0] may be ?xml declaration, Rights element may be at dom[0] or dom[1]
    const hasRights = dom.some((item) => {
      if (typeof item !== 'object' || item === null) { return false; }
      const keys = Object.keys(item as object);
      return keys.some((k) => k === 'Rights' || (k.includes(':') && k.split(':').pop() === 'Rights'));
    });
    assert.ok(hasRights, 'dom must contain a Rights element');
  });

  test('parses Rights.xml with an object entry', async () => {
    const xmlPath = await writeTempFile(tmpDir, 'obj/Rights.xml', RIGHTS_XML_WITH_OBJECT);
    const dom = await loadRightsXml(xmlPath);
    const xml = serializeRightsDomToXml(dom);
    assert.ok(xml.includes('Catalog.Products'), 'loaded dom should contain object name');
  });

  test('throws on malformed XML (invalid attribute syntax)', async () => {
    // fast-xml-parser throws on attributes with unquoted values containing >
    const bad = '<Rights attr="val>broken</Rights>';
    const badPath = await writeTempFile(tmpDir, 'bad/Rights.xml', bad);
    await assert.rejects(
      () => loadRightsXml(badPath),
      (err: unknown) => err instanceof Error && err.message.includes('Rights.xml')
    );
  });

  test('calls ensureRightsRootAttrsFor1CXdto — serialized output has 1C xmlns attrs after load of bare XML', async () => {
    // Rights.xml without xmlns attrs on the root element
    const bareXml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Rights>',
      '  <setForNewObjects>false</setForNewObjects>',
      '</Rights>',
      '',
    ].join('\n');
    const xmlPath = await writeTempFile(tmpDir, 'bare/Rights.xml', bareXml);
    const dom = await loadRightsXml(xmlPath);
    // After loadRightsXml, ensureRightsRootAttrsFor1CXdto must have run.
    // The effect is visible via serializeRightsDomToXml which applies the root open tag.
    const xml = serializeRightsDomToXml(dom);
    assert.ok(xml.includes('http://v8.1c.ru/8.2/roles'), 'xmlns must be present in serialized output');
    assert.ok(xml.includes('xsi:type="Rights"'), 'xsi:type must be in output');
  });
});

// ---------------------------------------------------------------------------
// Suite: mergeRightsIntoDom
// ---------------------------------------------------------------------------

suite('mergeRightsIntoDom', () => {
  test('adds new object when it does not exist in dom', () => {
    const dom = createMinimalRightsDom();
    const rights = {
      'Catalog.Products': { ...createEmptyObjectRights(), read: true, insert: true }
    };

    mergeRightsIntoDom(dom, rights);

    const xml = serializeRightsDomToXml(dom);
    assert.ok(xml.includes('Catalog.Products'), 'object must appear in serialized XML');
    assert.ok(xml.includes('Read'), 'Read right must be present');
  });

  test('compactWrite=true omits false rights for new object', () => {
    const dom = createMinimalRightsDom();
    const rights = {
      'Catalog.OnlyRead': { ...createEmptyObjectRights(), read: true }
    };

    mergeRightsIntoDom(dom, rights, { compactWrite: true });

    const xml = serializeRightsDomToXml(dom);
    assert.ok(xml.includes('Read'), 'true right must appear');
    assert.ok(!xml.includes('Insert'), 'false right Insert must not appear in compact mode');
  });

  test('compactWrite=false writes all rights for new object', () => {
    const dom = createMinimalRightsDom();
    const rights = {
      'Catalog.FullWrite': { ...createEmptyObjectRights(), read: true }
    };

    mergeRightsIntoDom(dom, rights, { compactWrite: false });

    const xml = serializeRightsDomToXml(dom);
    assert.ok(xml.includes('Insert'), 'Insert must appear with compactWrite=false even if false');
  });

  test('updates existing object rights (set value)', () => {
    // Start with dom that already has Catalog.Products with Read=true
    const initialRights = {
      'Catalog.Products': { ...createEmptyObjectRights(), read: true }
    };
    const dom = createMinimalRightsDom();
    mergeRightsIntoDom(dom, initialRights, { compactWrite: false });

    // Now update: set read=false, update=true
    const updatedRights = {
      'Catalog.Products': { ...createEmptyObjectRights(), update: true }
    };
    mergeRightsIntoDom(dom, updatedRights, { compactWrite: false });

    const xml = serializeRightsDomToXml(dom);
    // Read should now be false, Update true
    // Since compactWrite=false both should appear
    assert.ok(xml.includes('Catalog.Products'));
    assert.ok(xml.includes('Update'));
  });

  test('compactWrite removes simple <right> when value is false', () => {
    // Build dom with a simple Read=true right, then merge Read=false
    const dom = createMinimalRightsDom();
    mergeRightsIntoDom(dom, { 'Catalog.X': { ...createEmptyObjectRights(), read: true } }, { compactWrite: true });

    // Verify Read is present
    let xml = serializeRightsDomToXml(dom);
    assert.ok(xml.includes('Read'), 'Read must appear before update');

    // Now merge Read=false — compact should strip it
    mergeRightsIntoDom(dom, { 'Catalog.X': { ...createEmptyObjectRights(), read: false } }, { compactWrite: true });

    xml = serializeRightsDomToXml(dom);
    // In compact mode, false simple right must be removed
    assert.ok(!xml.includes('<name>Read</name>'), 'Read right should be stripped when false in compact mode');
  });

  test('handles multiple objects in single merge', () => {
    const dom = createMinimalRightsDom();
    const rights = {
      'Catalog.A': { ...createEmptyObjectRights(), read: true },
      'Document.B': { ...createEmptyObjectRights(), insert: true },
    };

    mergeRightsIntoDom(dom, rights);

    const xml = serializeRightsDomToXml(dom);
    assert.ok(xml.includes('Catalog.A'));
    assert.ok(xml.includes('Document.B'));
  });

  test('does not add rights for empty rights map', () => {
    const dom = createMinimalRightsDom();
    mergeRightsIntoDom(dom, {});
    const xml = serializeRightsDomToXml(dom);
    assert.ok(!xml.includes('<object>'), 'no object elements should appear for empty rights map');
  });

  test('preserves restrictionTemplate blocks already in dom', () => {
    // Load dom that has a template block
    const dom = createMinimalRightsDom();
    // Manually inject a restrictionTemplate into Rights content
    const content = (dom[0] as Record<string, unknown>)['Rights'] as unknown[];
    content.push({ restrictionTemplate: [{ name: [{ '#text': 'T1' }] }] });

    mergeRightsIntoDom(dom, { 'Catalog.Z': { ...createEmptyObjectRights(), read: true } });

    const xml = serializeRightsDomToXml(dom);
    assert.ok(xml.includes('T1'), 'restrictionTemplate must be preserved after merge');
    assert.ok(xml.includes('Catalog.Z'), 'new object must be inserted before template');
  });

  test('new objects are inserted before existing restrictionTemplate blocks', () => {
    const dom = createMinimalRightsDom();
    const content = (dom[0] as Record<string, unknown>)['Rights'] as unknown[];
    content.push({ restrictionTemplate: [{ name: [{ '#text': 'Tmpl' }] }] });

    mergeRightsIntoDom(dom, { 'Catalog.Before': { ...createEmptyObjectRights(), read: true } });

    const xml = serializeRightsDomToXml(dom);
    const objectPos = xml.indexOf('Catalog.Before');
    const templatePos = xml.indexOf('Tmpl');
    assert.ok(objectPos < templatePos, 'new object must appear before restrictionTemplate');
  });
});

// ---------------------------------------------------------------------------
// Suite: stripRestrictionTemplateBlocksFromRightsXml
// ---------------------------------------------------------------------------

suite('stripRestrictionTemplateBlocksFromRightsXml', () => {
  test('removes a single restrictionTemplate block', () => {
    const result = stripRestrictionTemplateBlocksFromRightsXml(RIGHTS_XML_WITH_TEMPLATE);
    assert.ok(!result.includes('<restrictionTemplate>'), 'block must be stripped');
    assert.ok(result.includes('Catalog.Products'), 'object element must survive');
  });

  test('removes multiple restrictionTemplate blocks', () => {
    const xml = [
      '<Rights>',
      '  <object><name>A</name></object>',
      '  <restrictionTemplate><name>T1</name></restrictionTemplate>',
      '  <restrictionTemplate><name>T2</name></restrictionTemplate>',
      '</Rights>'
    ].join('\n');

    const result = stripRestrictionTemplateBlocksFromRightsXml(xml);
    assert.ok(!result.includes('T1'));
    assert.ok(!result.includes('T2'));
    assert.ok(result.includes('<object>'));
  });

  test('handles namespaced restrictionTemplate (v8:restrictionTemplate)', () => {
    const xml = [
      '<Rights>',
      '  <v8:restrictionTemplate><v8:name>NsT</v8:name></v8:restrictionTemplate>',
      '</Rights>'
    ].join('\n');

    const result = stripRestrictionTemplateBlocksFromRightsXml(xml);
    assert.ok(!result.includes('NsT'), 'namespaced template must be stripped');
  });

  test('no-op when no restrictionTemplate blocks present', () => {
    const xml = '<Rights><object><name>X</name></object></Rights>';
    const result = stripRestrictionTemplateBlocksFromRightsXml(xml);
    assert.strictEqual(result, xml);
  });

  test('no-op on empty string', () => {
    assert.strictEqual(stripRestrictionTemplateBlocksFromRightsXml(''), '');
  });
});

// ---------------------------------------------------------------------------
// Suite: insertRestrictionTemplatesBeforeClosingRights
// ---------------------------------------------------------------------------

suite('insertRestrictionTemplatesBeforeClosingRights', () => {
  test('inserts template before </Rights>', () => {
    const xml = '<Rights xmlns="http://v8.1c.ru/8.2/roles"><object><name>A</name></object></Rights>';
    const tmpl = '<restrictionTemplate><name>T</name></restrictionTemplate>';

    const result = insertRestrictionTemplatesBeforeClosingRights(xml, tmpl);
    const tmplPos = result.indexOf('T');
    const closingPos = result.indexOf('</Rights>');
    assert.ok(tmplPos !== -1 && closingPos !== -1);
    assert.ok(tmplPos < closingPos, 'template must appear before </Rights>');
  });

  test('empty template string strips existing blocks and returns xml unchanged otherwise', () => {
    const result = insertRestrictionTemplatesBeforeClosingRights(RIGHTS_XML_WITH_TEMPLATE, '');
    assert.ok(!result.includes('<restrictionTemplate>'), 'existing blocks must be stripped');
    assert.ok(result.includes('Catalog.Products'), 'object must survive');
  });

  test('replaces existing restrictionTemplate blocks with new ones', () => {
    const xml = RIGHTS_XML_WITH_TEMPLATE;
    const newTmpl = '<restrictionTemplate><name>NEW</name></restrictionTemplate>';

    const result = insertRestrictionTemplatesBeforeClosingRights(xml, newTmpl);
    assert.ok(result.includes('NEW'), 'new template must be present');
    assert.ok(!result.includes('Tmpl1'), 'old template must be replaced');
  });

  test('fallback: appends template when </Rights> closing tag is missing', () => {
    const malformed = '<Rights>content';
    const tmpl = '<restrictionTemplate>APPENDED</restrictionTemplate>';

    const result = insertRestrictionTemplatesBeforeClosingRights(malformed, tmpl);
    assert.ok(result.includes('APPENDED'), 'template must be appended to malformed XML');
  });

  test('whitespace-only template is treated as empty (strips, no insert)', () => {
    const result = insertRestrictionTemplatesBeforeClosingRights(RIGHTS_XML_WITH_TEMPLATE, '   \n  ');
    assert.ok(!result.includes('<restrictionTemplate>'), 'existing blocks stripped by whitespace-only template');
  });
});

// ---------------------------------------------------------------------------
// Suite: serializeRightsDomToXml
// ---------------------------------------------------------------------------

suite('serializeRightsDomToXml', () => {
  test('output starts with XML declaration', () => {
    const dom = createMinimalRightsDom();
    const xml = serializeRightsDomToXml(dom);
    assert.ok(xml.startsWith('<?xml version="1.0"'), `Expected XML declaration, got: ${xml.slice(0, 40)}`);
  });

  test('output ends with newline', () => {
    const dom = createMinimalRightsDom();
    const xml = serializeRightsDomToXml(dom);
    assert.ok(xml.endsWith('\n'), 'output must end with newline');
  });

  test('output contains full Rights open tag with xmlns attrs', () => {
    const dom = createMinimalRightsDom();
    const xml = serializeRightsDomToXml(dom);
    assert.ok(xml.includes('http://v8.1c.ru/8.2/roles'), 'must contain xmlns');
    assert.ok(xml.includes('xsi:type="Rights"'), 'must contain xsi:type');
    assert.ok(xml.includes('version="2.20"'), 'must contain version');
  });

  test('output contains </Rights> closing tag', () => {
    const dom = createMinimalRightsDom();
    const xml = serializeRightsDomToXml(dom);
    assert.ok(xml.includes('</Rights>'), 'must contain closing Rights tag');
  });

  test('serialized object rights survive roundtrip parse by XMLParser', () => {
    const { XMLParser } = require('fast-xml-parser');
    const dom = createMinimalRightsDom();
    mergeRightsIntoDom(dom, {
      'Catalog.RoundTrip': { ...createEmptyObjectRights(), read: true, insert: true }
    });
    const xml = serializeRightsDomToXml(dom);
    // Should be parseable
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    assert.doesNotThrow(() => parser.parse(xml), 'serialized XML must be parseable');
    assert.ok(xml.includes('Catalog.RoundTrip'));
    assert.ok(xml.includes('Read'));
  });

  test('unescapes &quot; in condition text', () => {
    // Build a dom with a right that has restrictionByCondition containing a quote
    // We simulate this by building xml with &quot; and then checking it gets unescaped
    // The builder would produce &quot; from quotes in text nodes; serializeRightsDomToXml unescapes them
    const dom = createMinimalRightsDom();
    const content = (dom[0] as Record<string, unknown>)['Rights'] as unknown[];
    // Inject a node that will cause the builder to produce &quot;
    content.push({
      restrictionTemplate: [
        { name: [{ '#text': 'T1' }] },
        { condition: [{ '#text': 'field = "value"' }] }
      ]
    });
    const xml = serializeRightsDomToXml(dom);
    // fast-xml-parser builder escapes " in text content to &quot;
    // serializeRightsDomToXml must unescape them back to "
    // The condition text should contain literal " not &quot;
    assert.ok(!xml.includes('&quot;'), `Output must not contain &quot; — got: ${xml.slice(xml.indexOf('condition') - 5, xml.indexOf('condition') + 60)}`);
    assert.ok(xml.includes('"value"'), 'Literal quotes must be present in output');
  });

  test('calls ensureRightsRootAttrsFor1CXdto before building', () => {
    // Dom without attribute bag — serialize should add attrs
    const dom: RightsDom = [
      {
        Rights: [
          { setForNewObjects: [{ '#text': 'false' }] }
        ]
      }
    ];
    const xml = serializeRightsDomToXml(dom);
    assert.ok(xml.includes('http://v8.1c.ru/8.2/roles'), 'xmlns must be injected by serialize');
    assert.ok(xml.includes('xsi:type="Rights"'));
  });

  test('roundtrip: createMinimal -> serialize -> loadRightsXml -> serialize produces same structure', async () => {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-serial-rt-'));
    try {
      const dom1 = createMinimalRightsDom();
      const xml1 = serializeRightsDomToXml(dom1);
      const xmlPath = path.join(tmpDir, 'Rights.xml');
      await fs.promises.writeFile(xmlPath, xml1, 'utf-8');

      const dom2 = await loadRightsXml(xmlPath);
      const xml2 = serializeRightsDomToXml(dom2);

      // Both outputs must contain the same structural markers
      assert.ok(xml2.includes('<?xml'));
      assert.ok(xml2.includes('http://v8.1c.ru/8.2/roles'));
      assert.ok(xml2.includes('</Rights>'));
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
