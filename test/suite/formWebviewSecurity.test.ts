import * as assert from 'assert';
import * as vscode from 'vscode';

import { FormEditorProvider } from '../../src/formEditor/formEditorProvider';
import {
  escapeWebviewAttribute,
  escapeWebviewText,
  getWebviewHtml,
} from '../../src/formEditor/formWebviewHtml';
import { createFormWebviewRuntimeFixture } from '../helpers/formWebviewRuntime';

suite('Form editor webview security', () => {
  test('uses a unique matching nonce for CSP, style, and script on every render', () => {
    const first = getWebviewHtml({} as vscode.Webview);
    const second = getWebviewHtml({} as vscode.Webview);
    const firstNonce = requireMatch(first, /<style nonce="([^"]+)">/)[1];
    const secondNonce = requireMatch(second, /<style nonce="([^"]+)">/)[1];
    const csp = requireMatch(
      first,
      /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/
    )[1];

    assert.notStrictEqual(firstNonce, secondNonce);
    assert.strictEqual(requireMatch(first, /<script nonce="([^"]+)">/)[1], firstNonce);
    assert.match(csp, /default-src 'none'/);
    assert.ok(csp.includes(`script-src 'nonce-${firstNonce}'`));
    assert.ok(csp.includes(`style-src 'nonce-${firstNonce}'`));
    assert.doesNotMatch(csp, /unsafe-inline/);
    assert.strictEqual((first.match(/<style\b/g) ?? []).length, 1);
    assert.strictEqual((first.match(/<script\b/g) ?? []).length, 1);
    assert.doesNotMatch(first, /\sstyle\s*=/i);
  });

  test('renders hostile model values as text without serializing host functions into the webview', () => {
    const fixture = createFormWebviewRuntimeFixture();
    try {
      const hostile = `"><img src=x onerror='boom'>&<svg>`;
      fixture.send({
        type: 'formData',
        formModel: {
          childItemsRoot: [{ tag: 'InputField', id: 'hostile', name: hostile, properties: { Title: hostile }, childItems: [] }],
          attributes: [],
          commands: [],
          formEvents: [],
        },
      });
      const document = fixture.dom.window.document;

      assert.strictEqual(document.querySelector('#tree-root img'), null);
      assert.strictEqual(document.querySelector('#preview-form img'), null);
      assert.strictEqual(document.querySelector('#props-content img'), null);
      assert.strictEqual(
        document.querySelector('#tree-root .tree-node[data-id="hostile"] .tree-node-label')?.textContent,
        `${hostile} (InputField)`,
      );
      assert.strictEqual(escapeWebviewText(hostile).includes('<img'), false);
      assert.strictEqual(escapeWebviewAttribute(hostile).includes('"'), false);
      assert.deepStrictEqual(fixture.runtimeErrors, []);
    } finally {
      fixture.close();
    }
  });

  test('shows the requisite tree when form data has no attributes', () => {
    const fixture = createFormWebviewRuntimeFixture();
    try {
      fixture.send({
        type: 'formData',
        formModel: {
          childItemsRoot: [{ tag: 'InputField', id: 'field', name: 'Field', properties: {}, childItems: [] }],
          attributes: [],
          commands: [],
          formEvents: [],
        },
      });

      assert.strictEqual(fixture.dom.window.document.getElementById('attributes-tree-wrap')?.style.display, 'block');
      assert.strictEqual(fixture.dom.window.document.getElementById('attributes-table-wrap')?.style.display, 'none');
      assert.deepStrictEqual(fixture.runtimeErrors, []);
    } finally {
      fixture.close();
    }
  });

  test('neutralizes hostile text and double-quoted attribute payloads', () => {
    const payload = `"><img src=x onerror='boom'>&quot;&#34;&apos;&#39;&<svg>`;
    const text = escapeWebviewText(payload);
    const attribute = escapeWebviewAttribute(payload);

    assert.doesNotMatch(text, /<(?:img|svg)\b/i);
    assert.ok(text.includes('&amp;quot;'));
    assert.ok(text.includes('&amp;#34;'));
    assert.doesNotMatch(attribute, /["'<>]/);
    assert.doesNotMatch(attribute, /<(?:img|svg)\b/i);
    assert.ok(attribute.includes('&quot;'));
    assert.ok(attribute.includes('&#39;'));
    assert.ok(attribute.includes('&amp;quot;'));
    assert.ok(attribute.includes('&amp;#34;'));
    assert.ok(attribute.includes('&amp;apos;'));
    assert.ok(attribute.includes('&amp;#39;'));
  });

  test('provider disables all local resource roots', async () => {
    const provider = new FormEditorProvider();
    const document = await provider.openCustomDocument(
      vscode.Uri.parse('file:///tmp/form/Ext/Form.xml')
    );
    const webview = {
      options: {},
      html: '',
      postMessage: async () => true,
      onDidReceiveMessage: () => ({ dispose: () => undefined }),
    };
    const panel = {
      webview,
      active: false,
      onDidChangeViewState: () => ({ dispose: () => undefined }),
      onDidDispose: () => ({ dispose: () => undefined }),
    };

    await provider.resolveCustomEditor(document, panel as unknown as vscode.WebviewPanel);

    assert.deepStrictEqual(webview.options, {
      enableScripts: true,
      localResourceRoots: [],
    });
  });
});

function requireMatch(value: string, pattern: RegExp): RegExpMatchArray {
  const match = value.match(pattern);
  assert.ok(match, `Expected pattern ${pattern} in generated HTML`);
  return match;
}
