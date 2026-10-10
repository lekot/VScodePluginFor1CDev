import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import { MetadataType, TreeNode } from '../../src/models/treeNode';
import {
  getWebviewContent,
  getFormSelectionWebviewContent,
} from '../../src/providers/propertiesWebviewContent';
import {
  buildWebviewCsp,
  createNonce,
  applyNonceToHtml,
} from '../../src/utils/webviewSecurity';
import { QueryBuilderProvider } from '../../src/queryBuilder/queryBuilderProvider';
import type { FormSelectionPayload } from '../../src/formEditor/formMessageHandler';

suite('Webview CSP security policy', () => {
  const repoRoot = path.resolve(__dirname, '../../..');
  const srcDir = path.join(repoRoot, 'src');

  test('no production source or template files permit script-src unsafe-inline', () => {
    const offenders: string[] = [];

    function scanDir(dir: string): void {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.html')) {
          const content = fs.readFileSync(fullPath, 'utf8');
          if (/script-src[^;"'>]*'unsafe-inline'/i.test(content)) {
            const relPath = path.relative(repoRoot, fullPath);
            offenders.push(relPath);
          }
        }
      }
    }

    scanDir(srcDir);
    assert.deepStrictEqual(
      offenders,
      [],
      `Found script-src 'unsafe-inline' in production files:\n${offenders.join('\n')}`
    );
  });

  test('properties webview content uses strict nonce CSP and does not permit script-src unsafe-inline', () => {
    const node: TreeNode = {
      id: 'test-node',
      name: 'TestElement',
      type: MetadataType.Catalog,
      properties: { Comment: 'Test' },
      filePath: '/test/path.xml',
    };

    const html = getWebviewContent(node, { sessionToken: 'abc' });

    // Must not allow unsafe-inline for scripts
    assert.doesNotMatch(html, /script-src[^;"'>]*'unsafe-inline'/i);

    // Must have default-src 'none'
    assert.match(html, /default-src\s+'none'/i);

    // Must have a script-src with nonce
    const cspMatch = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/i);
    assert.ok(cspMatch, 'CSP meta tag must be present');
    const csp = cspMatch[1];

    const scriptNonceMatch = csp.match(/script-src[^;]*'nonce-([A-Za-z0-9_-]+)'/i);
    assert.ok(scriptNonceMatch, 'CSP must contain script-src nonce directive');
    const nonceInCsp = scriptNonceMatch[1];
    assert.ok(nonceInCsp.length >= 16, 'Nonce must have sufficient entropy');

    // All script tags must have matching nonce
    const scriptTags = Array.from(html.matchAll(/<script\b([^>]*)>/gi));
    assert.ok(scriptTags.length > 0, 'Should contain at least one script tag');
    for (const tag of scriptTags) {
      const nonceAttr = tag[1].match(/nonce="([^"]+)"/i);
      assert.ok(nonceAttr, `Script tag must declare nonce attribute: ${tag[0]}`);
      assert.strictEqual(nonceAttr[1], nonceInCsp, 'Script tag nonce must match CSP nonce');
    }

    // Must not allow wide https: or 'self' image schemes
    assert.doesNotMatch(csp, /img-src[^;]*https:/i, 'Must not allow unrestricted https: images');
    assert.doesNotMatch(csp, /img-src[^;]*'self'/i, 'Must not allow unrestricted self images');
  });

  test('form selection webview content uses strict nonce CSP and does not permit script-src unsafe-inline', () => {
    const payload: FormSelectionPayload = {
      source: 'form-editor',
      docUri: 'file:///test/Form.xml',
      selectedIds: ['id-1'],
      id: 'id-1',
      name: 'FormItem1',
      tag: 'InputField',
      entityType: 'element',
      properties: { Visible: 'true' },
      events: {},
    };

    const html = getFormSelectionWebviewContent(payload, 1);

    // Must not allow unsafe-inline for scripts
    assert.doesNotMatch(html, /script-src[^;"'>]*'unsafe-inline'/i);

    // Must have default-src 'none'
    assert.match(html, /default-src\s+'none'/i);

    const cspMatch = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/i);
    assert.ok(cspMatch, 'CSP meta tag must be present');
    const csp = cspMatch[1];

    const scriptNonceMatch = csp.match(/script-src[^;]*'nonce-([A-Za-z0-9_-]+)'/i);
    assert.ok(scriptNonceMatch, 'CSP must contain script-src nonce directive');
    const nonceInCsp = scriptNonceMatch[1];

    // All script tags must have matching nonce
    const scriptTags = Array.from(html.matchAll(/<script\b([^>]*)>/gi));
    assert.ok(scriptTags.length > 0, 'Should contain at least one script tag');
    for (const tag of scriptTags) {
      const nonceAttr = tag[1].match(/nonce="([^"]+)"/i);
      assert.ok(nonceAttr, `Script tag must declare nonce attribute: ${tag[0]}`);
      assert.strictEqual(nonceAttr[1], nonceInCsp, 'Script tag nonce must match CSP nonce');
    }
  });

  test('static webview HTML templates use nonce placeholders and do not contain hardcoded script-src unsafe-inline', () => {
    const templates = [
      'src/compositionEditor/compositionWebview.html',
      'src/rolesEditor/rolesEditorWebview.html',
      'src/subsystemCommandInterfaceEditor/subsystemCommandInterfaceWebview.html',
      'src/queryBuilder/ui/queryBuilderWebview.html',
    ];

    for (const relPath of templates) {
      const content = fs.readFileSync(path.join(repoRoot, relPath), 'utf8');

      assert.doesNotMatch(
        content,
        /script-src[^;"'>]*'unsafe-inline'/i,
        `${relPath} must not allow script-src 'unsafe-inline'`
      );

      assert.match(
        content,
        /script-src[^;"']*'nonce-\$\{nonce\}'/i,
        `${relPath} CSP must declare script-src 'nonce-\${nonce}' placeholder`
      );

      const scriptTags = Array.from(content.matchAll(/<script\b([^>]*)>/gi));
      assert.ok(scriptTags.length > 0, `${relPath} must have script tags`);
      for (const tag of scriptTags) {
        assert.match(
          tag[1],
          /nonce="\$\{nonce\}"/i,
          `Script tag in ${relPath} must contain nonce="\${nonce}": ${tag[0]}`
        );
      }
    }
  });

  test('buildWebviewCsp constructs valid CSP with strict defaults', () => {
    const csp = buildWebviewCsp({
      nonce: 'abc123xyz',
      allowUnsafeInlineStyles: true,
      imgSources: ['data:'],
    });

    assert.ok(csp.includes("default-src 'none'"));
    assert.ok(csp.includes("script-src 'nonce-abc123xyz'"));
    assert.ok(csp.includes("style-src 'unsafe-inline'"));
    assert.ok(csp.includes("img-src data:"));
    assert.ok(csp.includes("base-uri 'none'"));
    assert.ok(csp.includes("form-action 'none'"));
    assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
  });

  test('createNonce produces high-entropy nonces and applyNonceToHtml substitutes placeholders', () => {
    const n1 = createNonce();
    const n2 = createNonce();
    assert.notStrictEqual(n1, n2);
    assert.ok(n1.length >= 24);

    const template = '<script nonce="${nonce}">alert(1)</script>';
    const result = applyNonceToHtml(template, n1);
    assert.strictEqual(result.html, `<script nonce="${n1}">alert(1)</script>`);
    assert.strictEqual(result.nonce, n1);
  });

  test('QueryBuilderProvider getHtmlContent renders matching nonce', () => {
    const fakeContext = { subscriptions: [] } as unknown as import('vscode').ExtensionContext;
    const fakeState = {} as unknown as import('../../src/state/extensionState').ExtensionState;
    const provider = new QueryBuilderProvider(fakeContext, fakeState);
    const html = provider['getHtmlContent']();

    assert.ok(html.includes('Content-Security-Policy'));
    assert.doesNotMatch(html, /script-src[^;"'>]*'unsafe-inline'/i);

    const cspNonceMatch = html.match(/script-src[^;]*'nonce-([A-Za-z0-9_-]+)'/i);
    assert.ok(cspNonceMatch, 'CSP must declare script-src with nonce');

    const scriptNonceMatch = html.match(/<script\b[^>]*nonce="([^"]+)"/i);
    assert.ok(scriptNonceMatch, 'Script tag must declare nonce');
    assert.strictEqual(scriptNonceMatch[1], cspNonceMatch[1]);
  });

  test('properties webview safely escapes hostile HTML/script payloads', () => {
    const hostile = 'evil</script><script>alert("pwn")</script>';
    const node: TreeNode = {
      id: 'test-node',
      name: hostile,
      type: MetadataType.Catalog,
      properties: { Comment: hostile },
      filePath: '/test/path.xml',
    };

    const html = getWebviewContent(node, { sessionToken: 'abc' });
    assert.ok(!html.includes('</script><script>alert'));
    assert.ok(html.includes('&lt;/script&gt;&lt;script&gt;alert'));
  });
});

