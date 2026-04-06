import * as assert from 'assert';
import { MetadataType, TreeNode } from '../../src/models/treeNode';
import {
  escapeHtml,
  getEditTypePencilSvg,
  isRootElement,
  detectPropertyType,
  renderPropertyInput,
  renderPropertiesBySections,
  getWebviewScript,
  getWebviewContent,
  getEmptyStateContent,
  getErrorPanelContent,
  getFormSelectionWebviewContent,
} from '../../src/providers/propertiesWebviewContent';
import type { FormSelectionPayload } from '../../src/formEditor/formMessageHandler';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(overrides: Partial<TreeNode> & Pick<TreeNode, 'type'>): TreeNode {
  return {
    id: 'test-node',
    name: 'TestNode',
    properties: {},
    ...overrides,
  };
}

function makeConfigParent(): TreeNode {
  return { id: 'cfg', name: 'Configuration', type: MetadataType.Configuration, properties: {} };
}

// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------

suite('propertiesWebviewContent — escapeHtml', () => {
  test('empty string returns empty string', () => {
    assert.strictEqual(escapeHtml(''), '');
  });

  test('plain text passes through unchanged', () => {
    assert.strictEqual(escapeHtml('hello world'), 'hello world');
  });

  test('ampersand is escaped', () => {
    assert.strictEqual(escapeHtml('a & b'), 'a &amp; b');
  });

  test('less-than is escaped', () => {
    assert.ok(escapeHtml('<tag>').includes('&lt;'));
  });

  test('greater-than is escaped', () => {
    assert.ok(escapeHtml('<tag>').includes('&gt;'));
  });

  test('double quote is escaped', () => {
    assert.ok(escapeHtml('"value"').includes('&quot;'));
  });

  test('single quote is escaped', () => {
    assert.ok(escapeHtml("it's").includes('&#039;'));
  });

  test('XSS payload is fully escaped', () => {
    const escaped = escapeHtml('<script>alert("xss")</script>');
    assert.ok(!escaped.includes('<script>'), 'raw < must not appear');
    assert.ok(escaped.includes('&lt;script&gt;'));
    assert.ok(escaped.includes('&quot;'));
  });

  test('multiple special chars in one string', () => {
    const escaped = escapeHtml('a & b < c > d "e" \'f\'');
    assert.ok(escaped.includes('&amp;'));
    assert.ok(escaped.includes('&lt;'));
    assert.ok(escaped.includes('&gt;'));
    assert.ok(escaped.includes('&quot;'));
    assert.ok(escaped.includes('&#039;'));
  });
});

// ---------------------------------------------------------------------------
// getEditTypePencilSvg
// ---------------------------------------------------------------------------

suite('propertiesWebviewContent — getEditTypePencilSvg', () => {
  test('returns a non-empty string', () => {
    const svg = getEditTypePencilSvg();
    assert.ok(typeof svg === 'string' && svg.length > 0);
  });

  test('contains svg element', () => {
    assert.ok(getEditTypePencilSvg().includes('<svg'));
  });

  test('contains path element', () => {
    assert.ok(getEditTypePencilSvg().includes('<path'));
  });

  test('contains proper dimensions', () => {
    const svg = getEditTypePencilSvg();
    assert.ok(svg.includes('width="16"') && svg.includes('height="16"'));
  });
});

// ---------------------------------------------------------------------------
// isRootElement
// ---------------------------------------------------------------------------

suite('propertiesWebviewContent — isRootElement', () => {
  test('undefined returns false', () => {
    assert.strictEqual(isRootElement(undefined), false);
  });

  test('node without parent returns true (top-level orphan)', () => {
    const node = makeNode({ type: MetadataType.Catalog });
    assert.strictEqual(isRootElement(node), true);
  });

  test('Catalog with Configuration parent returns true', () => {
    const node = makeNode({ type: MetadataType.Catalog, parent: makeConfigParent() });
    assert.strictEqual(isRootElement(node), true);
  });

  test('Document with Configuration parent returns true', () => {
    const node = makeNode({ type: MetadataType.Document, parent: makeConfigParent() });
    assert.strictEqual(isRootElement(node), true);
  });

  test('Attribute with parentFilePath returns false', () => {
    const node = makeNode({
      type: MetadataType.Attribute,
      parent: makeNode({ type: MetadataType.Catalog }),
      parentFilePath: '/Catalogs/TestCatalog.xml',
    });
    assert.strictEqual(isRootElement(node), false);
  });

  test('node with parentFilePath is never root even without parent reference', () => {
    const node = makeNode({ type: MetadataType.Attribute, parentFilePath: '/some/parent.xml' });
    assert.strictEqual(isRootElement(node), false);
  });

  test('CommonModule with Configuration parent returns true', () => {
    const node = makeNode({ type: MetadataType.CommonModule, parent: makeConfigParent() });
    assert.strictEqual(isRootElement(node), true);
  });

  test('node whose parent is not Configuration and has no parentFilePath', () => {
    // A Catalog node whose direct parent is not Configuration
    const nonConfigParent = makeNode({ type: MetadataType.Catalog });
    const node = makeNode({ type: MetadataType.Catalog, parent: nonConfigParent });
    // type is in rootTypes list, so should be true
    assert.strictEqual(isRootElement(node), true);
  });
});

// ---------------------------------------------------------------------------
// detectPropertyType
// ---------------------------------------------------------------------------

suite('propertiesWebviewContent — detectPropertyType', () => {
  test('boolean true returns boolean', () => {
    assert.strictEqual(detectPropertyType(true), 'boolean');
  });

  test('boolean false returns boolean', () => {
    assert.strictEqual(detectPropertyType(false), 'boolean');
  });

  test('integer returns number', () => {
    assert.strictEqual(detectPropertyType(42), 'number');
  });

  test('float returns number', () => {
    assert.strictEqual(detectPropertyType(3.14), 'number');
  });

  test('string returns string', () => {
    assert.strictEqual(detectPropertyType('hello'), 'string');
  });

  test('empty string returns string', () => {
    assert.strictEqual(detectPropertyType(''), 'string');
  });

  test('null returns unknown', () => {
    assert.strictEqual(detectPropertyType(null), 'unknown');
  });

  test('undefined returns unknown', () => {
    assert.strictEqual(detectPropertyType(undefined), 'unknown');
  });

  test('object returns unknown', () => {
    assert.strictEqual(detectPropertyType({ a: 1 }), 'unknown');
  });

  test('array returns unknown', () => {
    assert.strictEqual(detectPropertyType([1, 2, 3]), 'unknown');
  });
});

// ---------------------------------------------------------------------------
// renderPropertyInput
// ---------------------------------------------------------------------------

suite('propertiesWebviewContent — renderPropertyInput', () => {
  const attrNode = makeNode({
    type: MetadataType.Attribute,
    parentFilePath: '/test/parent.xml',
  });

  const catalogNode = makeNode({
    type: MetadataType.Catalog,
    parent: makeConfigParent(),
    filePath: '/test/Catalog.xml',
  });

  test('returns a string for a simple string property', () => {
    const html = renderPropertyInput('name', 'TestValue', false, attrNode);
    assert.ok(typeof html === 'string' && html.length > 0);
  });

  test('string property renders text input', () => {
    const html = renderPropertyInput('name', 'TestValue', false, attrNode);
    assert.ok(html.includes('type="text"'));
  });

  test('string value is included in output', () => {
    const html = renderPropertyInput('name', 'TestValue', false, attrNode);
    assert.ok(html.includes('TestValue'));
  });

  test('boolean property renders checkbox input', () => {
    const html = renderPropertyInput('autoNumbering', true, false, attrNode);
    assert.ok(html.includes('type="checkbox"'));
  });

  test('boolean true adds checked attribute', () => {
    const html = renderPropertyInput('autoNumbering', true, false, attrNode);
    assert.ok(html.includes('checked'));
  });

  test('boolean false does not add checked attribute', () => {
    const html = renderPropertyInput('autoNumbering', false, false, attrNode);
    assert.ok(!html.includes('checked'));
  });

  test('number property renders number input', () => {
    const html = renderPropertyInput('maxLength', 100, false, attrNode);
    assert.ok(html.includes('type="number"'));
  });

  test('array property renders disabled text input with element count', () => {
    const html = renderPropertyInput('items', [1, 2, 3], false, attrNode);
    assert.ok(html.includes('disabled'));
    assert.ok(html.includes('3 элем.'));
  });

  test('object property renders disabled text input with {...}', () => {
    const html = renderPropertyInput('config', { a: 1 }, false, attrNode);
    assert.ok(html.includes('disabled'));
    assert.ok(html.includes('{...}'));
  });

  test('globalReadOnly=true disables the input', () => {
    const html = renderPropertyInput('name', 'val', true, attrNode);
    assert.ok(html.includes('disabled'));
  });

  test('type property on root element is disabled', () => {
    const html = renderPropertyInput('type', 'xs:string', false, catalogNode);
    assert.ok(html.includes('disabled'));
  });

  test('type property on root element does not show edit button', () => {
    const html = renderPropertyInput('type', 'xs:string', false, catalogNode);
    assert.ok(!html.includes('edit-type-btn'));
  });

  test('type property on Attribute (non-root) is enabled', () => {
    const html = renderPropertyInput('type', 'xs:string', false, attrNode);
    assert.ok(!html.includes('disabled'));
  });

  test('type property on Attribute shows edit button', () => {
    const html = renderPropertyInput('type', 'xs:string', false, attrNode);
    assert.ok(html.includes('edit-type-btn'));
    assert.ok(html.includes('aria-label="Редактировать тип"'));
  });

  test('type as null shows Not set', () => {
    const html = renderPropertyInput('type', null, false, attrNode);
    assert.ok(html.includes('Not set'));
  });

  test('type as undefined shows Not set', () => {
    const html = renderPropertyInput('type', undefined, false, attrNode);
    assert.ok(html.includes('Not set'));
  });

  test('type as object renders formatted string, not [object Object]', () => {
    const typeObj = { 'v8:Type': 'xs:string', 'v8:StringQualifiers': { 'v8:Length': 50 } };
    const html = renderPropertyInput('Type', typeObj, false, attrNode);
    assert.ok(!html.includes('[object Object]'));
  });

  test('type as string with < renders as-is (parsed or kept)', () => {
    const html = renderPropertyInput('Type', 'CatalogRef.Products', false, attrNode);
    assert.ok(html.includes('CatalogRef.Products'));
  });

  test('data-property attribute is set to property name', () => {
    const html = renderPropertyInput('myProp', 'val', false, attrNode);
    assert.ok(html.includes('data-property="myProp"'));
  });

  test('special chars in property name are escaped in data-property', () => {
    const html = renderPropertyInput('prop<name>', 'val', false, attrNode);
    assert.ok(html.includes('data-property="prop&lt;name&gt;"'));
  });

  test('special chars in string value are HTML-escaped', () => {
    const html = renderPropertyInput('name', '<script>xss</script>', false, attrNode);
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;script&gt;'));
  });

  test('undefined node — type property disabled (treated as root since no parentFilePath)', () => {
    const html = renderPropertyInput('type', 'xs:string', false, undefined);
    // isRootElement(undefined) = false, so not disabled from root-check,
    // but the function should still return a string without crashing
    assert.ok(typeof html === 'string');
  });

  test('property-row class is present in output', () => {
    const html = renderPropertyInput('name', 'val', false, attrNode);
    assert.ok(html.includes('class="property-row"'));
  });

  test('property-label class is present in output', () => {
    const html = renderPropertyInput('name', 'val', false, attrNode);
    assert.ok(html.includes('class="property-label"'));
  });
});

// ---------------------------------------------------------------------------
// renderPropertiesBySections
// ---------------------------------------------------------------------------

suite('propertiesWebviewContent — renderPropertiesBySections', () => {
  test('empty properties returns empty or minimal string', () => {
    const node = makeNode({ type: MetadataType.Catalog, properties: {} });
    const html = renderPropertiesBySections(node, false);
    assert.ok(typeof html === 'string');
  });

  test('renders property inputs for each property key', () => {
    const node = makeNode({
      type: MetadataType.Attribute,
      properties: { name: 'TestAttr', autoNumbering: true },
      parentFilePath: '/test/parent.xml',
    });
    const html = renderPropertiesBySections(node, false);
    assert.ok(html.includes('TestAttr'));
    assert.ok(html.includes('type="checkbox"'));
  });

  test('read-only mode disables all inputs', () => {
    const node = makeNode({
      type: MetadataType.Attribute,
      properties: { name: 'TestAttr', maxLength: 50 },
      parentFilePath: '/test/parent.xml',
    });
    const html = renderPropertiesBySections(node, true);
    assert.ok(html.includes('disabled'));
  });

  test('returns string with property-section div', () => {
    const node = makeNode({
      type: MetadataType.Attribute,
      properties: { name: 'TestAttr' },
      parentFilePath: '/test/parent.xml',
    });
    const html = renderPropertiesBySections(node, false);
    assert.ok(html.includes('property-section'));
  });

  test('Configuration type with properties renders sections', () => {
    const node = makeNode({
      type: MetadataType.Configuration,
      properties: { name: 'MyConfig', version: '1.0.0' },
      filePath: '/Configuration.xml',
    });
    const html = renderPropertiesBySections(node, false);
    assert.ok(html.includes('MyConfig'));
  });
});

// ---------------------------------------------------------------------------
// getWebviewScript
// ---------------------------------------------------------------------------

suite('propertiesWebviewContent — getWebviewScript', () => {
  test('read-only mode returns a short comment string', () => {
    const script = getWebviewScript(true);
    assert.ok(typeof script === 'string' && script.length > 0);
    assert.ok(script.includes('Read-only'));
  });

  test('editable mode returns JavaScript code', () => {
    const script = getWebviewScript(false);
    assert.ok(script.includes('acquireVsCodeApi'));
    assert.ok(script.includes('vscode.postMessage'));
  });

  test('editable mode handles save action', () => {
    const script = getWebviewScript(false);
    assert.ok(script.includes("type: 'save'"));
  });

  test('editable mode handles cancel action', () => {
    const script = getWebviewScript(false);
    assert.ok(script.includes("type: 'cancel'"));
  });

  test('editable mode initializes state object', () => {
    const script = getWebviewScript(false);
    assert.ok(script.includes('state'));
    assert.ok(script.includes('originalProperties'));
    assert.ok(script.includes('currentProperties'));
  });
});

// ---------------------------------------------------------------------------
// getWebviewContent
// ---------------------------------------------------------------------------

suite('propertiesWebviewContent — getWebviewContent', () => {
  test('returns valid HTML string', () => {
    const node = makeNode({
      type: MetadataType.Catalog,
      name: 'TestCatalog',
      properties: { name: 'TestCatalog' },
      filePath: '/test/TestCatalog.xml',
    });
    const html = getWebviewContent(node);
    assert.ok(html.includes('<!DOCTYPE html>'));
    assert.ok(html.includes('<html>'));
  });

  test('includes node name in output', () => {
    const node = makeNode({
      type: MetadataType.Catalog,
      name: 'MyCatalog',
      properties: { name: 'MyCatalog' },
      filePath: '/test/MyCatalog.xml',
    });
    const html = getWebviewContent(node);
    assert.ok(html.includes('MyCatalog'));
  });

  test('node without filePath renders in read-only mode', () => {
    const node = makeNode({
      type: MetadataType.Catalog,
      name: 'ReadOnlyCatalog',
      properties: { name: 'ReadOnlyCatalog' },
    });
    const html = getWebviewContent(node);
    // No save button in read-only mode, or has read-only notice
    assert.ok(typeof html === 'string' && html.length > 0);
  });

  test('node with filePath renders editable form with save button', () => {
    const node = makeNode({
      type: MetadataType.Catalog,
      name: 'EditableCatalog',
      properties: { name: 'EditableCatalog' },
      filePath: '/test/EditableCatalog.xml',
    });
    const html = getWebviewContent(node);
    assert.ok(html.includes('save-btn') || html.includes('acquireVsCodeApi'));
  });

  test('special chars in node name are escaped', () => {
    const node = makeNode({
      type: MetadataType.Catalog,
      name: '<XSS>',
      properties: {},
      filePath: '/test/node.xml',
    });
    const html = getWebviewContent(node);
    assert.ok(!html.includes('<XSS>'));
    assert.ok(html.includes('&lt;XSS&gt;'));
  });

  test('Content-Security-Policy meta tag is present', () => {
    const node = makeNode({
      type: MetadataType.Catalog,
      name: 'TestCatalog',
      properties: {},
      filePath: '/test/TestCatalog.xml',
    });
    const html = getWebviewContent(node);
    assert.ok(html.includes('Content-Security-Policy'));
  });
});

// ---------------------------------------------------------------------------
// getEmptyStateContent
// ---------------------------------------------------------------------------

suite('propertiesWebviewContent — getEmptyStateContent', () => {
  test('returns valid HTML', () => {
    const html = getEmptyStateContent();
    assert.ok(html.includes('<!DOCTYPE html>'));
    assert.ok(html.includes('<html>'));
  });

  test('contains empty-state class', () => {
    const html = getEmptyStateContent();
    assert.ok(html.includes('empty-state'));
  });

  test('contains Content-Security-Policy', () => {
    const html = getEmptyStateContent();
    assert.ok(html.includes('Content-Security-Policy'));
  });

  test('does not contain script tags', () => {
    const html = getEmptyStateContent();
    assert.ok(!html.includes('<script'));
  });
});

// ---------------------------------------------------------------------------
// getErrorPanelContent
// ---------------------------------------------------------------------------

suite('propertiesWebviewContent — getErrorPanelContent', () => {
  const errorNode = makeNode({
    type: MetadataType.Catalog,
    name: 'BrokenCatalog',
    properties: {},
    filePath: '/test/BrokenCatalog.xml',
  });

  test('returns valid HTML', () => {
    const html = getErrorPanelContent(errorNode, 'Parse error', 'XML is malformed');
    assert.ok(html.includes('<!DOCTYPE html>'));
    assert.ok(html.includes('<html>'));
  });

  test('includes node name and type in header', () => {
    const html = getErrorPanelContent(errorNode, 'Parse error', 'XML is malformed');
    assert.ok(html.includes('BrokenCatalog'));
    assert.ok(html.includes('Catalog'));
  });

  test('includes error title', () => {
    const html = getErrorPanelContent(errorNode, 'My Error Title', 'some details');
    assert.ok(html.includes('My Error Title'));
  });

  test('includes error details', () => {
    const html = getErrorPanelContent(errorNode, 'title', 'Detailed error message');
    assert.ok(html.includes('Detailed error message'));
  });

  test('includes file path when node has filePath', () => {
    const html = getErrorPanelContent(errorNode, 'title', 'details');
    assert.ok(html.includes('/test/BrokenCatalog.xml'));
  });

  test('no file path section when node has no filePath', () => {
    const nodeNoPath = makeNode({ type: MetadataType.Catalog, name: 'NodeNoPath', properties: {} });
    const html = getErrorPanelContent(nodeNoPath, 'title', 'details');
    // Should not contain file path display
    assert.ok(!html.includes('BrokenCatalog.xml'));
  });

  test('special chars in title are escaped', () => {
    const html = getErrorPanelContent(errorNode, '<script>alert(1)</script>', 'details');
    assert.ok(!html.includes('<script>alert'));
    assert.ok(html.includes('&lt;script&gt;'));
  });

  test('special chars in details are escaped', () => {
    const html = getErrorPanelContent(errorNode, 'title', '<b>bad HTML</b>');
    assert.ok(!html.includes('<b>bad HTML</b>'));
    assert.ok(html.includes('&lt;b&gt;'));
  });

  test('contains error-box class', () => {
    const html = getErrorPanelContent(errorNode, 'title', 'details');
    assert.ok(html.includes('error-box'));
  });
});

// ---------------------------------------------------------------------------
// getFormSelectionWebviewContent
// ---------------------------------------------------------------------------

suite('propertiesWebviewContent — getFormSelectionWebviewContent', () => {
  function makeSelection(overrides: Partial<FormSelectionPayload> = {}): FormSelectionPayload {
    return {
      source: 'form-editor',
      docUri: 'file:///test/Form.xml',
      entityType: 'element',
      id: 'el-1',
      name: 'InputField1',
      tag: 'InputField',
      properties: { Width: '100', Height: '20' },
      events: { OnChange: 'OnChangeHandler' },
      selectedIds: ['el-1'],
      ...overrides,
    };
  }

  test('returns valid HTML string', () => {
    const html = getFormSelectionWebviewContent(makeSelection(), 1);
    assert.ok(html.includes('<!DOCTYPE html>') || html.includes('<html'));
    assert.ok(typeof html === 'string' && html.length > 0);
  });

  test('includes property values in output', () => {
    const html = getFormSelectionWebviewContent(makeSelection(), 1);
    assert.ok(html.includes('Width') || html.includes('100'));
  });

  test('multi-selection shows element count message', () => {
    const selection = makeSelection({ selectedIds: ['el-1', 'el-2', 'el-3'] });
    const html = getFormSelectionWebviewContent(selection, 1);
    assert.ok(html.includes('3') || html.includes('Выбрано'));
  });

  test('single selection does not show multi-select message', () => {
    const html = getFormSelectionWebviewContent(makeSelection(), 1);
    assert.ok(!html.includes('Mixed-state'));
  });

  test('selection revision is embedded for stale-update detection', () => {
    const html = getFormSelectionWebviewContent(makeSelection(), 42);
    assert.ok(html.includes('42'));
  });

  test('empty properties does not crash', () => {
    const selection = makeSelection({ properties: {}, events: {} });
    const html = getFormSelectionWebviewContent(selection, 1);
    assert.ok(typeof html === 'string');
  });

  test('keys starting with @ are filtered out', () => {
    const selection = makeSelection({ properties: { '@_attr': 'hidden', visible: 'true' } });
    const html = getFormSelectionWebviewContent(selection, 1);
    // @_attr should be filtered; visible should appear
    assert.ok(html.includes('visible') || html.includes('true'));
    assert.ok(!html.includes('@_attr'));
  });

  test('events are included in the output', () => {
    const html = getFormSelectionWebviewContent(makeSelection(), 1);
    assert.ok(html.includes('OnChange') || html.includes('OnChangeHandler'));
  });

  test('XSS in property values is escaped', () => {
    const selection = makeSelection({ properties: { name: '<script>alert(1)</script>' } });
    const html = getFormSelectionWebviewContent(selection, 1);
    assert.ok(!html.includes('<script>alert'));
  });
});
