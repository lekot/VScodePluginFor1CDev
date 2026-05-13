import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

function readWebviewHtml(): string {
  return fs.readFileSync(
    path.join(process.cwd(), 'src', 'xdtoPackageEditor', 'xdtoPackageWebview.html'),
    'utf8'
  );
}

suite('xdtoPackageWebview content', () => {
  test('renders type fields with an explicit picker instead of datalist-only inputs', () => {
    const html = readWebviewHtml();

    assert.ok(html.includes('type-picker'), 'type fields must render a picker container');
    assert.ok(html.includes('type-picker-button'), 'type fields must render a dropdown button');
    assert.ok(html.includes('type-picker-list'), 'type fields must render an option list');
    assert.ok(html.includes('toggleTypePicker'), 'dropdown button must open and close the list');
    assert.ok(html.includes('selectTypeOption'), 'option click must apply the selected type');
    assert.ok(html.includes('data-type-picker-field'), 'picker must know the target field');
    assert.ok(html.includes('typePicker: true'), 'baseType/type fields must opt into the picker');
    assert.ok(!html.includes("list: 'type-options'"), 'type fields must not rely on datalist');
    assert.ok(!html.includes('<datalist id="type-options">'), 'webview must not use datalist UI');
  });

  test('keeps collapsed state and renders expandable tree groups accessibly', () => {
    const html = readWebviewHtml();

    assert.ok(html.includes('collapsedGroups'), 'tree must keep collapsed group state');
    assert.ok(html.includes('toggleGroup'), 'group clicks must toggle collapsed state');
    assert.ok(html.includes('groupKey'), 'object group state must be scoped by object index');
    assert.ok(html.includes('isGroupCollapsed'), 'rendering must check collapsed state');
    assert.ok(html.includes('aria-expanded'), 'group buttons must expose expanded state');
    assert.ok(html.includes('hidden'), 'collapsed groups must hide child lists');
    assert.ok(html.includes("'▸'"), 'collapsed groups must render a right chevron');
    assert.ok(html.includes("'▾'"), 'expanded groups must render a down chevron');
  });
});
