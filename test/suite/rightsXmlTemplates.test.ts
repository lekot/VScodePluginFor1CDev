import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { RightsDom } from '../../src/rolesEditor/rightsXmlEditWriter';
import {
  createMinimalRightsDom,
  ensureRightsRootAttrsFor1CXdto,
  insertRestrictionTemplatesBeforeClosingRights,
  loadRightsXml,
  mergeRightsIntoDom,
  serializeRightsDomToXml,
  stripRestrictionTemplateBlocksFromRightsXml,
} from '../../src/rolesEditor/rightsXmlEditWriter';
import { RoleXmlParser } from '../../src/rolesEditor/roleXmlParser';
import { createEmptyObjectRights } from '../../src/rolesEditor/models/roleModel';

suite('Rights.xml restrictionTemplate string helpers', () => {
  test('stripRestrictionTemplateBlocksFromRightsXml removes blocks', () => {
    const xml =
      '<?xml version="1.0"?><Rights><object><name>X</name></object><restrictionTemplate><name>T</name></restrictionTemplate></Rights>';
    const out = stripRestrictionTemplateBlocksFromRightsXml(xml);
    assert.ok(out.includes('<object>'));
    assert.ok(!out.includes('restrictionTemplate'));
  });

  test('insertRestrictionTemplatesBeforeClosingRights inserts before close', () => {
    const xml = '<?xml version="1.0"?><Rights><object><name>X</name></object></Rights>';
    const next = insertRestrictionTemplatesBeforeClosingRights(
      xml,
      '<restrictionTemplate><name>N</name></restrictionTemplate>'
    );
    assert.ok(next.includes('<restrictionTemplate>'));
    assert.ok(/<\/Rights>\s*$/i.test(next.trim()) || next.includes('</Rights>'));
  });

  test('stripRestrictionTemplateBlocksFromRightsXml removes template containing CDATA', () => {
    const xml =
      '<?xml version="1.0"?><Rights><restrictionTemplate><c><![CDATA[Special <tags> & ampersand]]></c></restrictionTemplate></Rights>';
    const out = stripRestrictionTemplateBlocksFromRightsXml(xml);
    assert.ok(!out.includes('restrictionTemplate'));
    assert.ok(out.includes('<Rights'));
  });

  test('insertRestrictionTemplatesBeforeClosingRights preserves CDATA in inserted block', () => {
    const xml = '<?xml version="1.0"?><Rights><object><name>X</name></object></Rights>';
    const tpl = '<restrictionTemplate><q><![CDATA[a < b && c > d]]></q></restrictionTemplate>';
    const out = insertRestrictionTemplatesBeforeClosingRights(xml, tpl);
    assert.ok(out.includes('CDATA'));
    assert.ok(out.includes('a < b'));
  });
});

/**
 * Regression for GitHub #18 / developer-backlog: RLS fragments must survive the same
 * load → serialize → strip → reinsert path used on save (no webview).
 */
suite('RLS restrictionTemplate round-trip (regression #18)', () => {
  test('load → serialize → strip → reinsert preserves extractRestrictionTemplatesBlocks', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1c-rights-rls-rt-'));
    const p = path.join(tmp, 'Rights.xml');
    try {
      const base = serializeRightsDomToXml(createMinimalRightsDom());
      const injection = [
        '<object>',
        '<name>Catalog.RlsRoundTrip</name>',
        '<right><name>Read</name><value>true</value></right>',
        '</object>',
        '<restrictionTemplate>',
        '<name>TemplateOne</name>',
        '<condition>true</condition>',
        '</restrictionTemplate>',
        '<v8:restrictionTemplate><v8:name>TemplateTwo</v8:name></v8:restrictionTemplate>',
      ].join('');
      const fullXml = base.replace(/<\/(?:[a-zA-Z0-9_.]+:)?Rights\s*>/i, `${injection}\n</Rights>`);
      await fs.promises.writeFile(p, fullXml, 'utf-8');

      const onDisk = await fs.promises.readFile(p, 'utf-8');
      const rls = RoleXmlParser.extractRestrictionTemplatesBlocks(onDisk);
      assert.ok(rls.includes('TemplateOne'), 'fixture must expose first template');
      assert.ok(rls.includes('v8:restrictionTemplate'), 'fixture must expose v8-prefixed template');

      const dom = await loadRightsXml(p);
      const rebuilt = insertRestrictionTemplatesBeforeClosingRights(
        stripRestrictionTemplateBlocksFromRightsXml(serializeRightsDomToXml(dom)),
        rls
      );
      const rlsAfter = RoleXmlParser.extractRestrictionTemplatesBlocks(rebuilt);
      assert.strictEqual(
        rlsAfter,
        rls,
        'RLS blocks must survive EDT Rights.xml save pipeline (strip + reinsert)'
      );
    } finally {
      await fs.promises.rm(tmp, { recursive: true, force: true });
    }
  });

  test('quoted entities in restrictionTemplate text survive round-trip', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1c-rights-rls-ent-'));
    const p = path.join(tmp, 'Rights.xml');
    try {
      const base = serializeRightsDomToXml(createMinimalRightsDom());
      const injection = [
        '<restrictionTemplate>',
        '<condition>Where Name &quot;Item&quot; = &quot;x&quot; &amp; Flag</condition>',
        '</restrictionTemplate>',
      ].join('');
      const fullXml = base.replace(/<\/(?:[a-zA-Z0-9_.]+:)?Rights\s*>/i, `${injection}\n</Rights>`);
      await fs.promises.writeFile(p, fullXml, 'utf-8');

      const onDisk = await fs.promises.readFile(p, 'utf-8');
      const rls = RoleXmlParser.extractRestrictionTemplatesBlocks(onDisk);
      assert.ok(rls.includes('"Item"'), 'entities should decode for editor/save payload');

      const dom = await loadRightsXml(p);
      const rebuilt = insertRestrictionTemplatesBeforeClosingRights(
        stripRestrictionTemplateBlocksFromRightsXml(serializeRightsDomToXml(dom)),
        rls
      );
      const rlsAfter = RoleXmlParser.extractRestrictionTemplatesBlocks(rebuilt);
      assert.strictEqual(rlsAfter, rls);
    } finally {
      await fs.promises.rm(tmp, { recursive: true, force: true });
    }
  });
});

suite('Rights.xml 1C XDTO root', () => {
  test('ensureRightsRootAttrsFor1CXdto merges missing xsi:type into existing attribute bag', () => {
    const dom: RightsDom = [
      {
        Rights: [
          { ':@': { '@_xmlns': 'http://v8.1c.ru/8.2/roles' } },
          { setForNewObjects: [{ '#text': 'false' }] }
        ]
      }
    ];
    ensureRightsRootAttrsFor1CXdto(dom);
    const out = serializeRightsDomToXml(dom);
    assert.ok(out.includes('xmlns="http://v8.1c.ru/8.2/roles"'));
    assert.ok(out.includes('xsi:type="Rights"'));
    assert.ok(out.includes('version="2.20"'));
  });

  test('loadRightsXml normalizes bare Rights file on disk', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1c-rights-xdto-'));
    const p = path.join(tmp, 'Rights.xml');
    try {
      await fs.promises.writeFile(
        p,
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<Rights>',
          '\t<setForNewObjects>false</setForNewObjects>',
          '</Rights>',
          '',
        ].join('\n'),
        'utf-8'
      );
      const dom = await loadRightsXml(p);
      const xml = serializeRightsDomToXml(dom);
      assert.ok(xml.includes('http://v8.1c.ru/8.2/roles'));
      assert.ok(xml.includes('xsi:type="Rights"'));
    } finally {
      await fs.promises.rm(tmp, { recursive: true, force: true });
    }
  });
});

suite('mergeRightsIntoDom with non-simple right', () => {
  test('compactWrite false clears read but keeps restrictionByCondition on the right', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1c-rights-merge-nonsimple-'));
    const p = path.join(tmp, 'Rights.xml');
    try {
      await fs.promises.writeFile(
        p,
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<Rights xmlns="http://v8.1c.ru/8.2/roles" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="Rights" version="2.20">',
          '\t<setForNewObjects>false</setForNewObjects>',
          '\t<setForAttributesByDefault>true</setForAttributesByDefault>',
          '\t<independentRightsOfChildObjects>false</independentRightsOfChildObjects>',
          '\t<object>',
          '\t\t<name>Catalog.Complex</name>',
          '\t\t<right>',
          '\t\t\t<name>Read</name>',
          '\t\t\t<value>true</value>',
          '\t\t\t<restrictionByCondition>Where true</restrictionByCondition>',
          '\t\t</right>',
          '\t</object>',
          '</Rights>',
          '',
        ].join('\n'),
        'utf-8'
      );
      const dom = await loadRightsXml(p);
      const or = createEmptyObjectRights();
      or.read = false;
      mergeRightsIntoDom(dom, { 'Catalog.Complex': or }, { compactWrite: true });
      const xml = serializeRightsDomToXml(dom);
      assert.ok(
        xml.includes('restrictionByCondition'),
        'restrictionByCondition must survive merge for non-simple right'
      );
      const afterObj = xml.split('<name>Catalog.Complex</name>')[1];
      assert.ok(afterObj, 'object block present');
      assert.ok(
        /<name>\s*Read\s*<\/name>[\s\S]*?<value>[\s\n\t]*false/i.test(afterObj),
        'Read right value should be false inside Catalog.Complex object'
      );
    } finally {
      await fs.promises.rm(tmp, { recursive: true, force: true });
    }
  });
});
