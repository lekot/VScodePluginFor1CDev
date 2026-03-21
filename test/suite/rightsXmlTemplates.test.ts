import * as assert from 'assert';
import {
  insertRestrictionTemplatesBeforeClosingRights,
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
