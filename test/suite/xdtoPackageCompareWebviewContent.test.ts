import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

function readWebviewHtml(): string {
  return fs.readFileSync(
    path.join(process.cwd(), 'src', 'xdtoPackageCompare', 'xdtoPackageCompareWebview.html'),
    'utf8'
  );
}

suite('xdtoPackageCompareWebview content', () => {
  test('renders a generic compare tree with filters, checkboxes, and merge action', () => {
    const html = readWebviewHtml();

    assert.ok(html.includes('compare-tree'), 'compare view must render a tree surface');
    assert.ok(html.includes('show-different-only'), 'compare view must have a differing-only filter');
    assert.ok(html.includes('data-merge-checkbox'), 'mergeable nodes must render checkboxes');
    assert.ok(html.includes('selectedIds'), 'webview must post selected node ids');
    assert.ok(html.includes('merge-selected'), 'compare view must expose merge selected action');
    assert.ok(html.includes('leftValue'), 'compare rows must include left values');
    assert.ok(html.includes('rightValue'), 'compare rows must include right values');
    assert.ok(html.includes('renderNode'), 'view must render arbitrary nested compare nodes');
  });
});
