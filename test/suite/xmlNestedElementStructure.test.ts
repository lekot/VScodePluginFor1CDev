import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { XMLWriter } from '../../src/utils/XMLWriter';
import { createTempDir, cleanupTempDir } from '../helpers/testHelpers';

/**
 * Tests for XML structure of nested elements (Attributes, TabularSections).
 * Validates: buildMinimalNestedElement output, addNestedElement, removeNestedElement,
 * Synonym/ToolTip v8:item structure, Type v8:StringQualifiers structure.
 *
 * Would have caught:
 * - v8:item split into two separate elements (Synonym/ToolTip bug)
 * - Missing v8: prefix on Length/AllowedLength (StringQualifiers bug)
 * - ChildObjects duplication when adding second attribute (Bug 2 from FIX_PLAN.md)
 */

const SINGLE_ATTR_XML = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Document uuid="doc-1">
    <Properties>
      <Name>TestDoc</Name>
      <Synonym>
        <v8:item>
          <v8:lang>ru</v8:lang>
          <v8:content>Тест</v8:content>
        </v8:item>
      </Synonym>
    </Properties>
    <ChildObjects>
      <Attribute uuid="attr-existing">
        <Properties>
          <Name>ExistingAttr</Name>
          <Type>
            <v8:Type>xs:string</v8:Type>
            <v8:StringQualifiers>
              <v8:Length>25</v8:Length>
              <v8:AllowedLength>Variable</v8:AllowedLength>
            </v8:StringQualifiers>
          </Type>
          <PasswordMode>false</PasswordMode>
        </Properties>
      </Attribute>
    </ChildObjects>
  </Document>
</MetaDataObject>`;

const TWO_ATTR_XML = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Document uuid="doc-1">
    <Properties>
      <Name>TestDoc</Name>
    </Properties>
    <ChildObjects>
      <Attribute uuid="attr-1">
        <Properties>
          <Name>FirstAttr</Name>
          <Type>
            <v8:Type>xs:string</v8:Type>
            <v8:StringQualifiers>
              <v8:Length>10</v8:Length>
              <v8:AllowedLength>Variable</v8:AllowedLength>
            </v8:StringQualifiers>
          </Type>
          <PasswordMode>false</PasswordMode>
        </Properties>
      </Attribute>
      <Attribute uuid="attr-2">
        <Properties>
          <Name>SecondAttr</Name>
          <Type>
            <v8:Type>xs:decimal</v8:Type>
            <v8:NumberQualifiers>
              <v8:Digits>15</v8:Digits>
              <v8:FractionDigits>2</v8:FractionDigits>
              <v8:AllowedSign>Any</v8:AllowedSign>
            </v8:NumberQualifiers>
          </Type>
          <PasswordMode>false</PasswordMode>
        </Properties>
      </Attribute>
    </ChildObjects>
  </Document>
</MetaDataObject>`;

function countOccurrences(text: string, substring: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(substring, pos)) !== -1) {
    count++;
    pos += substring.length;
  }
  return count;
}

suite('XML Nested Element Structure', () => {
  let tmpDir: string;

  setup(async () => {
    tmpDir = await createTempDir('1cviewer-struct-');
  });

  teardown(async () => {
    await cleanupTempDir(tmpDir);
  });

  // --- Gap 1: buildMinimalNestedElement produces valid v8:item structure ---

  test('addNestedElement produces single v8:item with both lang and content in Synonym', async () => {
    const filePath = path.join(tmpDir, 'Doc.xml');
    fs.writeFileSync(filePath, SINGLE_ATTR_XML, 'utf-8');

    await XMLWriter.addNestedElement(filePath, 'Attribute', 'NewAttr');

    const result = fs.readFileSync(filePath, 'utf-8');

    // Synonym must have a single v8:item with both v8:lang and v8:content
    const synItemPattern = /<Synonym>\s*<v8:item>\s*<v8:lang>ru<\/v8:lang>\s*<v8:content>NewAttr<\/v8:content>\s*<\/v8:item>\s*<\/Synonym>/s;
    assert.ok(synItemPattern.test(result),
      'Synonym must have a single v8:item containing both v8:lang and v8:content');

    // Current writer keeps original + newly added attribute synonym blocks.
    assert.strictEqual(countOccurrences(result, '<Synonym>'), 2,
      'Should keep one Synonym per attribute (existing + new)');
  });

  test('addNestedElement produces single v8:item with both lang and content in ToolTip', async () => {
    const filePath = path.join(tmpDir, 'Doc.xml');
    fs.writeFileSync(filePath, SINGLE_ATTR_XML, 'utf-8');

    await XMLWriter.addNestedElement(filePath, 'Attribute', 'NewAttr');

    const result = fs.readFileSync(filePath, 'utf-8');

    // ToolTip must also have a single v8:item
    const toolTipPattern = /<ToolTip>\s*<v8:item>\s*<v8:lang>ru<\/v8:lang>\s*<v8:content\/>\s*<\/v8:item>\s*<\/ToolTip>/s;
    assert.ok(toolTipPattern.test(result),
      'ToolTip must have a single v8:item containing both v8:lang and v8:content');
  });

  // --- Gap 1b: v8:StringQualifiers must have v8: prefix on child elements ---

  test('addNestedElement produces v8:StringQualifiers with v8:Length and v8:AllowedLength', async () => {
    const filePath = path.join(tmpDir, 'Doc.xml');
    fs.writeFileSync(filePath, SINGLE_ATTR_XML, 'utf-8');

    await XMLWriter.addNestedElement(filePath, 'Attribute', 'NewAttr');

    const result = fs.readFileSync(filePath, 'utf-8');

    // Must use v8: prefix — NOT bare <Length> or <AllowedLength>
    assert.ok(result.includes('<v8:Length>50</v8:Length>'),
      'StringQualifiers must use v8:Length, not bare Length');
    assert.ok(result.includes('<v8:AllowedLength>Variable</v8:AllowedLength>'),
      'StringQualifiers must use v8:AllowedLength, not bare AllowedLength');

    // Must NOT have bare (unprefixed) tags
    assert.ok(!result.match(/<StringQualifiers>[\s\S]*?<Length>/),
      'Must not have bare <Length> inside StringQualifiers');
    assert.ok(!result.match(/<StringQualifiers>[\s\S]*?<AllowedLength>/),
      'Must not have bare <AllowedLength> inside StringQualifiers');
  });

  // --- Gap 2: Adding second attribute must NOT create duplicate ChildObjects ---

  test('addNestedElement to single-attribute XML does not create duplicate ChildObjects', async () => {
    const filePath = path.join(tmpDir, 'Doc.xml');
    fs.writeFileSync(filePath, SINGLE_ATTR_XML, 'utf-8');

    await XMLWriter.addNestedElement(filePath, 'Attribute', 'SecondAttr');

    const result = fs.readFileSync(filePath, 'utf-8');

    // Must have exactly one ChildObjects section
    assert.strictEqual(countOccurrences(result, '<ChildObjects>'), 1,
      'Must have exactly one <ChildObjects> element');
    assert.strictEqual(countOccurrences(result, '</ChildObjects>'), 1,
      'Must have exactly one closing </ChildObjects> element');

    // Both attributes must be present
    assert.ok(result.includes('<Name>ExistingAttr</Name>'), 'First attribute should remain');
    assert.ok(result.includes('<Name>SecondAttr</Name>'), 'Second attribute should be added');
  });

  test('addNestedElement to two-attribute XML does not create duplicate ChildObjects', async () => {
    const filePath = path.join(tmpDir, 'Doc.xml');
    fs.writeFileSync(filePath, TWO_ATTR_XML, 'utf-8');

    await XMLWriter.addNestedElement(filePath, 'Attribute', 'ThirdAttr');

    const result = fs.readFileSync(filePath, 'utf-8');

    assert.strictEqual(countOccurrences(result, '<ChildObjects>'), 1,
      'Must have exactly one <ChildObjects> after adding third attribute');
    assert.ok(result.includes('<Name>FirstAttr</Name>'));
    assert.ok(result.includes('<Name>SecondAttr</Name>'));
    assert.ok(result.includes('<Name>ThirdAttr</Name>'));
  });

  // --- Gap 2b: removeNestedElement correctness ---

  test('removeNestedElement removes correct attribute and does not duplicate ChildObjects', async () => {
    const filePath = path.join(tmpDir, 'Doc.xml');
    fs.writeFileSync(filePath, TWO_ATTR_XML, 'utf-8');

    await XMLWriter.removeNestedElement(filePath, 'Attribute', 'FirstAttr');

    const result = fs.readFileSync(filePath, 'utf-8');

    assert.strictEqual(countOccurrences(result, '<ChildObjects>'), 1,
      'Must have exactly one <ChildObjects> after removal');
    assert.ok(!result.includes('<Name>FirstAttr</Name>'), 'Removed attribute should be absent');
    assert.ok(result.includes('<Name>SecondAttr</Name>'), 'Second attribute should stay');
  });

  test('removeNestedElement from single-attribute XML empties ChildObjects', async () => {
    const filePath = path.join(tmpDir, 'Doc.xml');
    fs.writeFileSync(filePath, SINGLE_ATTR_XML, 'utf-8');

    await XMLWriter.removeNestedElement(filePath, 'Attribute', 'ExistingAttr');

    const result = fs.readFileSync(filePath, 'utf-8');

    assert.ok(!result.includes('<Name>ExistingAttr</Name>'), 'Attribute should be removed');
  });

  // --- Gap 4b: buildUpdatedNestedXml with changedKeys preserves Type ---

  test('buildUpdatedNestedXml with changedKeys=[PasswordMode] preserves Type structure', () => {
    const modified = XMLWriter.buildUpdatedNestedXml(
      TWO_ATTR_XML,
      'Attribute',
      'FirstAttr',
      {
        Name: 'FirstAttr',
        Type: 'string(10)',
        PasswordMode: true,
      },
      ['PasswordMode']
    );

    // Type must remain structured XML, NOT be replaced by string display value
    assert.ok(modified.includes('<v8:Type>xs:string</v8:Type>'),
      'Type structure must be preserved when PasswordMode is the only changed key');
    assert.ok(modified.includes('<v8:Length>10</v8:Length>'),
      'StringQualifiers must be preserved');
    assert.ok(modified.includes('<PasswordMode>true</PasswordMode>'),
      'Changed property PasswordMode should be updated');
    assert.ok(!modified.includes('<Type>string(10)</Type>'),
      'Type must not be written as plain text display string');
  });

  test('buildUpdatedNestedXml with changedKeys=[Type] updates Type and preserves PasswordMode', () => {
    const newTypeXml = `<Type>
\t\t\t\t\t<v8:Type>xs:decimal</v8:Type>
\t\t\t\t\t<v8:NumberQualifiers>
\t\t\t\t\t\t<v8:Digits>10</v8:Digits>
\t\t\t\t\t\t<v8:FractionDigits>2</v8:FractionDigits>
\t\t\t\t\t\t<v8:AllowedSign>Any</v8:AllowedSign>
\t\t\t\t\t</v8:NumberQualifiers>
\t\t\t\t</Type>`;

    const modified = XMLWriter.buildUpdatedNestedXml(
      TWO_ATTR_XML,
      'Attribute',
      'FirstAttr',
      {
        Name: 'FirstAttr',
        Type: newTypeXml,
        PasswordMode: false,
      },
      ['Type']
    );

    assert.ok(modified.includes('<v8:Type>xs:decimal</v8:Type>'),
      'Type should be updated to xs:decimal');
    assert.ok(modified.includes('<v8:NumberQualifiers>'),
      'NumberQualifiers should be in the output');
    assert.ok(modified.includes('<PasswordMode>false</PasswordMode>'),
      'Unchanged PasswordMode should be preserved');
  });

  // --- buildUpdatedNestedXml with changedKeys=[Synonym] updates Synonym only ---

  test('buildUpdatedNestedXml with changedKeys=[Synonym] updates Synonym and preserves Type', () => {
    const modified = XMLWriter.buildUpdatedNestedXml(
      TWO_ATTR_XML,
      'Attribute',
      'FirstAttr',
      {
        Name: 'FirstAttr',
        Synonym: 'Новое имя',
        Type: 'string(10)',
        PasswordMode: false,
      },
      ['Synonym']
    );

    assert.ok(modified.includes('Новое имя'),
      'Synonym should be updated');
    assert.ok(modified.includes('<v8:Type>xs:string</v8:Type>'),
      'Type structure should be preserved');
    assert.ok(modified.includes('<v8:Length>10</v8:Length>'),
      'StringQualifiers should be preserved');
    assert.ok(!modified.includes('<Type>string(10)</Type>'),
      'Type must not be written as plain text');
  });

  test('buildUpdatedNestedXml scoped Attribute updates column only in named TabularSection', () => {
    const xml = fs.readFileSync(
      path.join(__dirname, '../fixtures/designer-config/Catalogs/CatalogTwoTabularSameColumn.xml'),
      'utf-8'
    );
    const modified = XMLWriter.buildUpdatedNestedXml(
      xml,
      'Attribute',
      'Номенклатура',
      { Name: 'НоменклатураСкоуп' },
      ['Name'],
      { scopedTabularSectionName: 'SectionA' }
    );
    assert.ok(modified.includes('<Name>НоменклатураСкоуп</Name>'));
    assert.ok(modified.includes('<Name>Номенклатура</Name>'));
    assert.strictEqual((modified.match(/<Name>Номенклатура<\/Name>/g) || []).length, 1);
  });

  test('buildUpdatedNestedXml scoped Attribute with non-matching section name leaves columns unchanged', () => {
    const xml = fs.readFileSync(
      path.join(__dirname, '../fixtures/designer-config/Catalogs/CatalogTwoTabularSameColumn.xml'),
      'utf-8'
    );
    const modified = XMLWriter.buildUpdatedNestedXml(
      xml,
      'Attribute',
      'Номенклатура',
      { Name: 'ShouldNotApply' },
      ['Name'],
      { scopedTabularSectionName: 'NoSuchSection' }
    );
    assert.ok(!modified.includes('<Name>ShouldNotApply</Name>'));
    assert.strictEqual((modified.match(/<Name>Номенклатура<\/Name>/g) || []).length, 2);
  });
});
