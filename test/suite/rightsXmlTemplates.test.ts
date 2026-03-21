import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { RightsDom } from '../../src/rolesEditor/rightsXmlEditWriter';
import {
  ensureRightsRootAttrsFor1CXdto,
  insertRestrictionTemplatesBeforeClosingRights,
  loadRightsXml,
  serializeRightsDomToXml,
  stripRestrictionTemplateBlocksFromRightsXml,
} from '../../src/rolesEditor/rightsXmlEditWriter';

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
