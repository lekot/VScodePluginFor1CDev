/**
 * Bug Condition Exploration Tests for form-drag-clears-xml
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.4**
 *
 * CRITICAL: These tests MUST FAIL on unfixed code — failure confirms the bug exists.
 * DO NOT fix the code when these tests fail.
 *
 * Bug: Drag-and-drop of a direct child of childItemsRoot empties the root,
 * causing XMLBuilder to silently generate <Form></Form> which gets written to disk.
 */

import * as assert from 'assert';
import * as path from 'path';
import { XMLBuilder } from 'fast-xml-parser';
import { parseFormXml } from '../../src/formEditor/formXmlParser';
import { buildFormContent, injectXmlnsIntoFormTag } from '../../src/formEditor/formXmlWriter';
import { moveNodeInModel } from '../../src/formEditor/formTreeOperations';
import { isFormParseError, isFormParseFileMissing } from '../../src/formEditor/formModel';
import type { FormModel, FormChildItem } from '../../src/formEditor/formModel';

/** Path to the real Form.xml fixture used in tests 3 and 4. */
const REAL_FORM_XML = path.resolve(
  __dirname,
  '../../../FormatSamples/extensions_samples/Catalogs/ТелеграмНаборУсловий/Forms/ФормаЭлемента/Ext/Form.xml'
);

const BUILDER_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  preserveOrder: true,
  ignoreNameSpace: true,
  format: true,
  indentBy: '\t',
};

function buildXmlString(model: FormModel): string {
  const root = [{ Form: buildFormContent(model) }];
  const builder = new XMLBuilder(BUILDER_OPTIONS);
  let xml = builder.build(root) as string;
  if (model.xmlnsDeclarations && Object.keys(model.xmlnsDeclarations).length) {
    xml = injectXmlnsIntoFormTag(xml, model.xmlnsDeclarations);
  }
  return xml;
}

suite('Bug Condition Exploration: form-drag-clears-xml', () => {

  /**
   * Test 1 — Root child drag
   *
   * Creates a FormModel with childItemsRoot = [Pages(id="1", children=[Page(id="3")])]
   * Calls moveNodeInModel(model, "1", "3", 0) — moves the root-level Pages into its own child Page.
   * On UNFIXED code: childItemsRoot becomes empty (bug confirmed).
   * On FIXED code: operation is rejected (returns false) and childItemsRoot stays non-empty.
   *
   * EXPECTED ON UNFIXED CODE: FAIL — childItemsRoot.length === 0 (bug confirmed)
   */
  test('Test 1 — Root child drag empties childItemsRoot (bug condition)', () => {
    const page: FormChildItem = {
      tag: 'Page',
      id: '3',
      name: 'СтраницаОсновная',
      properties: {},
      childItems: [],
    };
    const pages: FormChildItem = {
      tag: 'Pages',
      id: '1',
      name: 'Страницы',
      properties: {},
      childItems: [page],
    };
    const model: FormModel = {
      childItemsRoot: [pages],
      attributes: [],
      commands: [],
      formEvents: [],
    };

    // Move root-level Pages(id=1) into its child Page(id=3)
    moveNodeInModel(model, '1', '3', 0);

    // FIX: after the fix, moveNodeInModel rejects the operation (returns false)
    // and childItemsRoot stays non-empty (length === 1)
    assert.strictEqual(
      model.childItemsRoot.length,
      1,
      'FIX VERIFIED: childItemsRoot was NOT emptied — moveNodeInModel correctly rejected the operation'
    );
  });

  /**
   * Test 2 — XML generation after empty root
   *
   * After emptying the root (as in Test 1), buildFormContent + XMLBuilder
   * silently generates <Form></Form> without throwing an error.
   *
   * EXPECTED ON UNFIXED CODE: FAIL — XML contains <Form></Form> or <Form/>
   */
  test('Test 2 — XML generation after empty root produces <Form></Form> (bug condition)', () => {
    const page: FormChildItem = {
      tag: 'Page',
      id: '3',
      name: 'СтраницаОсновная',
      properties: {},
      childItems: [],
    };
    const pages: FormChildItem = {
      tag: 'Pages',
      id: '1',
      name: 'Страницы',
      properties: {},
      childItems: [page],
    };
    const model: FormModel = {
      childItemsRoot: [pages],
      attributes: [],
      commands: [],
      formEvents: [],
    };

    // Attempt the buggy operation: try to empty the root
    moveNodeInModel(model, '1', '3', 0);

    // Now build XML from the model (operation was rejected, model is intact)
    const xmlString = buildXmlString(model);

    // FIX: after the fix, the XML is NOT empty — it contains ChildItems
    const isEmpty = /<Form\s*\/>|<Form>\s*<\/Form>/.test(xmlString);
    assert.ok(
      !isEmpty,
      `FIX VERIFIED: XMLBuilder generated valid non-empty Form XML.\nGenerated XML:\n${xmlString}`
    );
  });

  /**
   * Test 3 — xmlns preservation
   *
   * Parses the real Form.xml (which has 16 xmlns declarations).
   * Calls buildFormContent and builds XML.
   * FIX: all xmlns declarations are preserved in the output.
   */
  test('Test 3 — xmlns declarations are lost after buildFormContent (bug condition)', async () => {
    const result = await parseFormXml(REAL_FORM_XML);
    assert.ok(!isFormParseError(result), `Parse error: ${(result as { error?: string }).error ?? ''}`);
    assert.ok(!isFormParseFileMissing(result));
    const model = result.model;

    const xmlString = buildXmlString(model);

    // Count xmlns declarations in the output
    const xmlnsMatches = xmlString.match(/xmlns(?::\w+)?=/g) ?? [];
    const xmlnsCount = xmlnsMatches.length;

    // FIX VERIFIED: all xmlns declarations are preserved
    assert.ok(
      xmlnsCount >= 16,
      `FIX VERIFIED: xmlns declarations preserved — found ${xmlnsCount}, expected >= 16.\nxmlns found: ${xmlnsMatches.join(', ')}`
    );
  });

  /**
   * Test 4 — Top-level fields preservation
   *
   * Parses the real Form.xml (which contains <WindowOpeningMode>LockOwnerWindow</WindowOpeningMode>).
   * FIX: <WindowOpeningMode> is present in the output.
   */
  test('Test 4 — Top-level fields (WindowOpeningMode) are lost after buildFormContent (bug condition)', async () => {
    const result = await parseFormXml(REAL_FORM_XML);
    assert.ok(!isFormParseError(result), `Parse error: ${(result as { error?: string }).error ?? ''}`);
    assert.ok(!isFormParseFileMissing(result));
    const model = result.model;

    const xmlString = buildXmlString(model);

    // FIX VERIFIED: <WindowOpeningMode> is present in the output
    assert.ok(
      xmlString.includes('<WindowOpeningMode>'),
      `FIX VERIFIED: <WindowOpeningMode> is present in the generated XML.\nGenerated XML (first 500 chars):\n${xmlString.slice(0, 500)}`
    );
  });

});
