import * as assert from 'assert';

import {
  isObjectTypeEditorWebviewMessage,
  ObjectTypeEditorProvider,
} from '../../src/providers/objectTypeEditorProvider';
import {
  isTypeEditorWebviewMessage,
  TypeEditorProvider,
} from '../../src/providers/typeEditorProvider';
import { escapeJsonForScript } from '../../src/utils/escapeJsonForScript';
import { createFakeExtensionContext } from '../helpers/rightsEditorTestHarness';

suite('Type editor webview security', () => {
  test('uses one matching nonce for CSP, style, and script without unsafe-inline', () => {
    const provider = new TypeEditorProvider(createFakeExtensionContext());
    const html = provider['getWebviewContent']({ category: 'primitive', types: [] }, []);

    assertNonceBoundary(html);
    assert.doesNotMatch(html, /\sstyle\s*=/i);
    provider.dispose();
  });

  test('neutralizes closing-script variants and Unicode JavaScript separators', () => {
    const hostile = `evil</script ><script>one()</script></ScRiPt\t><script>two()</script>\u2028\u2029`;
    const provider = new TypeEditorProvider(createFakeExtensionContext());
    const html = provider['getWebviewContent'](
      { category: 'primitive', types: [] },
      [{ referenceKind: 'CatalogRef', objectNames: [hostile] }],
    );

    assertHostilePayloadEscaped(html, hostile);
    provider.dispose();
  });

  test('accepts only discriminated message payload shapes', () => {
    const allowedReferenceTypeKeys = new Set(['CatalogRef:Items']);
    assert.strictEqual(isTypeEditorWebviewMessage({ type: 'cancel' }, allowedReferenceTypeKeys), true);
    assert.strictEqual(isTypeEditorWebviewMessage({
      type: 'save',
      typeDefinition: {
        category: 'composite',
        types: [
          { kind: 'string', qualifiers: { length: 10, allowedLength: 'Variable' } },
          { kind: 'reference', referenceType: { referenceKind: 'CatalogRef', objectName: 'Items' } },
        ],
      },
    }, allowedReferenceTypeKeys), true);
    assert.strictEqual(isTypeEditorWebviewMessage({
      type: 'validate',
      typeDefinition: { category: 'primitive', types: [{ kind: 'boolean', qualifiers: undefined }] },
    }, allowedReferenceTypeKeys), true);

    const invalidMessages: unknown[] = [
      null,
      { type: 'save' },
      { type: 'cancel', typeDefinition: { category: 'primitive', types: [] } },
      { type: 'save', typeDefinition: { category: 'unknown', types: [] } },
      { type: 'save', typeDefinition: { category: 'primitive', types: 'not-an-array' } },
      { type: 'save', typeDefinition: { category: 'primitive', types: [{ kind: 'script' }] } },
      {
        type: 'save',
        typeDefinition: {
          category: 'reference',
          types: [{ kind: 'reference', referenceType: { referenceKind: 'UnknownRef', objectName: 'X' } }],
        },
      },
      {
        type: 'save',
        typeDefinition: {
          category: 'primitive',
          types: [{ kind: 'number', qualifiers: { digits: 10, fractionDigits: '2', allowedSign: 'Any' } }],
        },
      },
      {
        type: 'save',
        typeDefinition: {
          category: 'primitive',
          types: [{ kind: 'string', qualifiers: { length: -1, allowedLength: 'Variable' } }],
        },
      },
      {
        type: 'save',
        typeDefinition: {
          category: 'primitive',
          types: [{ kind: 'number', qualifiers: { digits: 1, fractionDigits: 2, allowedSign: 'Any' } }],
        },
      },
      {
        type: 'save',
        typeDefinition: {
          category: 'reference',
          types: [{ kind: 'reference', referenceType: { referenceKind: 'CatalogRef', objectName: '' } }],
        },
      },
      {
        type: 'save',
        typeDefinition: {
          category: 'reference',
          types: [{ kind: 'reference', referenceType: { referenceKind: 'CatalogRef', objectName: 'UnknownButValid' } }],
        },
      },
      {
        type: 'save',
        typeDefinition: {
          category: 'primitive',
          types: [{ kind: 'reference', referenceType: { referenceKind: 'CatalogRef', objectName: 'Items' } }],
        },
      },
      {
        type: 'save',
        typeDefinition: {
          category: 'composite',
          types: [{ kind: 'boolean' }, { kind: 'boolean' }],
        },
      },
    ];
    for (const message of invalidMessages) {
      assert.strictEqual(
        isTypeEditorWebviewMessage(message, allowedReferenceTypeKeys),
        false,
        JSON.stringify(message),
      );
    }
  });

  test('unions catalog groups with a current virtual DefinedType and clears the allowlist on dispose', () => {
    const currentReference = {
      category: 'reference' as const,
      types: [{
        kind: 'reference' as const,
        referenceType: { referenceKind: 'DefinedType' as const, objectName: 'LegacyCurrentType' },
      }],
    };
    const provider = new TypeEditorProvider(createFakeExtensionContext());
    provider['getWebviewContent'](currentReference, [
      { referenceKind: 'CatalogRef', objectNames: ['Items'] },
    ]);
    const allowedReferenceTypeKeys = provider['allowedReferenceTypeKeys'];

    assert.ok(allowedReferenceTypeKeys.has('DefinedType:LegacyCurrentType'));
    assert.ok(allowedReferenceTypeKeys.has('CatalogRef:Items'));
    assert.strictEqual(isTypeEditorWebviewMessage({
      type: 'save',
      typeDefinition: currentReference,
    }, allowedReferenceTypeKeys), true);
    assert.strictEqual(isTypeEditorWebviewMessage({
      type: 'save',
      typeDefinition: {
        category: 'reference',
        types: [{
          kind: 'reference',
          referenceType: { referenceKind: 'CatalogRef', objectName: 'UnknownButValid' },
        }],
      },
    }, allowedReferenceTypeKeys), false);

    provider.dispose();
    assert.strictEqual(allowedReferenceTypeKeys.size, 0);
  });

  test('rejects an oversized type array before traversing its elements', () => {
    const allowedReferenceTypeKeys = new Set(['CatalogRef:Items']);
    const oversizedTypes = new Array<unknown>(6);
    Object.defineProperty(oversizedTypes, 0, {
      get(): never { throw new Error('type entry must not be read'); },
    });

    assert.strictEqual(isTypeEditorWebviewMessage({
      type: 'save',
      typeDefinition: { category: 'primitive', types: oversizedTypes },
    }, allowedReferenceTypeKeys), false);
  });
});

suite('Object type editor webview security', () => {
  test('uses one matching nonce for CSP, style, and script without unsafe-inline', () => {
    const provider = new ObjectTypeEditorProvider(createFakeExtensionContext());
    const html = provider['getWebviewContent']({ types: [] }, []);

    assertNonceBoundary(html);
    provider.dispose();
  });

  test('neutralizes hostile object names in embedded tree state', () => {
    const hostile = `</SCRIPT ><script>one()</script>\u2028\u2029`;
    const provider = new ObjectTypeEditorProvider(createFakeExtensionContext());
    const html = provider['getWebviewContent'](
      { types: [] },
      [{ objectKind: 'CatalogObject', objectNames: [hostile] }],
    );

    assertHostilePayloadEscaped(html, hostile);
    provider.dispose();
  });

  test('accepts only valid save/cancel discriminated shapes', () => {
    const allowedIds = new Set(['CatalogObject:Items', 'DocumentManager:']);
    assert.strictEqual(isObjectTypeEditorWebviewMessage({ type: 'cancel' }, allowedIds), true);
    assert.strictEqual(isObjectTypeEditorWebviewMessage({
      type: 'save',
      selectedIds: ['CatalogObject:Items', 'DocumentManager:'],
    }, allowedIds), true);

    const invalidMessages: unknown[] = [
      null,
      { type: 'cancel', selectedIds: [] },
      { type: 'save' },
      { type: 'save', selectedIds: [] },
      { type: 'save', selectedIds: 'CatalogObject:Items' },
      { type: 'save', selectedIds: [1] },
      { type: 'save', selectedIds: ['missing-colon'] },
      { type: 'save', selectedIds: ['UnknownKind:Items'] },
      { type: 'save', selectedIds: ['DocumentManager:Named'] },
      { type: 'save', selectedIds: ['CatalogObject:'], extra: true },
      { type: 'save', selectedIds: ['CatalogObject:UnknownButValid'] },
      { type: 'save', selectedIds: ['CatalogObject:</v8:Type><x>'] },
      { type: 'save', selectedIds: ['CatalogObject:Items', 'CatalogObject:Items'] },
    ];
    for (const message of invalidMessages) {
      assert.strictEqual(isObjectTypeEditorWebviewMessage(message, allowedIds), false, JSON.stringify(message));
    }
  });

  test('rejects an oversized selection before traversing its elements', () => {
    const allowedIds = new Set(['CatalogObject:Items']);
    const oversizedSelection = new Array<unknown>(2);
    Object.defineProperty(oversizedSelection, 0, {
      get(): never { throw new Error('selection entry must not be read'); },
    });

    assert.strictEqual(isObjectTypeEditorWebviewMessage({
      type: 'save',
      selectedIds: oversizedSelection,
    }, allowedIds), false);
  });
});

suite('Shared script-data encoder', () => {
  test('escapes every HTML boundary character and both JavaScript line separators', () => {
    const hostile = `</script ></ScRiPt\t><script>boom()</script>&>\u2028\u2029`;
    const escaped = escapeJsonForScript(JSON.stringify({ hostile }));

    assert.doesNotMatch(escaped, /[<>&\u2028\u2029]/u);
    assert.ok(escaped.includes('\\u003c/script'));
    assert.ok(escaped.includes('\\u003e'));
    assert.ok(escaped.includes('\\u0026'));
    assert.ok(escaped.includes('\\u2028'));
    assert.ok(escaped.includes('\\u2029'));
    assert.deepStrictEqual(JSON.parse(escaped), { hostile });
  });
});

function assertNonceBoundary(html: string): void {
  const styleNonce = requireMatch(html, /<style nonce="([^"]+)">/)[1];
  const scriptNonce = requireMatch(html, /<script nonce="([^"]+)">/)[1];
  const csp = requireMatch(
    html,
    /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/,
  )[1];

  assert.strictEqual(scriptNonce, styleNonce);
  assert.ok(csp.includes("default-src 'none'"));
  assert.ok(csp.includes(`script-src 'nonce-${scriptNonce}'`));
  assert.ok(csp.includes(`style-src 'nonce-${styleNonce}'`));
  assert.doesNotMatch(csp, /unsafe-inline/);
  assert.strictEqual((html.match(/<style\b/g) ?? []).length, 1);
  assert.strictEqual((html.match(/<script\b/g) ?? []).length, 1);
}

function assertHostilePayloadEscaped(html: string, hostile: string): void {
  assert.ok(!html.includes(hostile));
  assert.doesNotMatch(html, /<\/script\s[^>]*>/i);
  assert.doesNotMatch(html, /\u2028|\u2029/u);
  assert.ok(html.includes('\\u003c'));
  assert.ok(html.includes('\\u2028'));
  assert.ok(html.includes('\\u2029'));
}

function requireMatch(value: string, pattern: RegExp): RegExpMatchArray {
  const match = value.match(pattern);
  assert.ok(match, `Expected pattern ${pattern} in generated HTML`);
  return match;
}
