import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { RightsDom } from '../../src/rolesEditor/rightsXmlEditWriter';
import {
  ensureRightsRootAttrsFor1CXdto,
  insertRestrictionTemplatesBeforeClosingRights,
  loadRightsXml,
  mergeRightsIntoDom,
  serializeRightsDomToXml,
  stripRestrictionTemplateBlocksFromRightsXml,
} from '../../src/rolesEditor/rightsXmlEditWriter';
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
