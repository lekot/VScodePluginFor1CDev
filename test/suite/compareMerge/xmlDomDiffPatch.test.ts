import * as assert from 'assert';

import {
  buildXmlAddress,
  parseXmlDocument,
  serializeXmlDocument,
  type XmlElement,
} from '../../../src/compareMerge/xml/xmlDom';
import { diffXmlDocuments } from '../../../src/compareMerge/xml/xmlDiff';
import { applyXmlPatch, hashXmlText } from '../../../src/compareMerge/xml/xmlPatch';

suite('XmlDomDiffPatch', () => {
  test('builds stable paths from local names and identity keys', () => {
    const left = parseXmlDocument(`<?xml version="1.0" encoding="UTF-8"?>
<md:MetaDataObject xmlns:md="urn:test">
  <md:Catalog uuid="catalog-products">
    <md:Properties>
      <md:Name>Products</md:Name>
    </md:Properties>
  </md:Catalog>
</md:MetaDataObject>`);
    const catalog = left.root.children.find(
      (child): child is XmlElement => child.kind === 'element' && child.localName === 'Catalog'
    );

    assert.ok(catalog);
    const address = buildXmlAddress('Products.xml', catalog);

    assert.strictEqual(
      address.pointer,
      '/MetaDataObject[0]/Catalog[uuid=catalog-products]'
    );
    assert.strictEqual(address.identityKey, 'uuid=catalog-products');
    assert.strictEqual(address.displayPath, 'MetaDataObject > Catalog catalog-products');
  });

  test('creates mergeable leaf and subtree diff objects with stable target patches', () => {
    const left = parseXmlDocument(`<Root>
  <Item uuid="same"><Name>Old</Name><Value>1</Value></Item>
  <Group><Child id="a"><Value>left</Value></Child></Group>
</Root>`);
    const right = parseXmlDocument(`<Root>
  <Item uuid="same"><Name>New</Name><Value>1</Value></Item>
  <Group><Child id="a"><Value>right</Value><Flag>true</Flag></Child></Group>
</Root>`);

    const diffs = diffXmlDocuments(left, right, { filePath: 'Object.xml' });

    assert.deepStrictEqual(
      diffs.map((diff) => [diff.kind, diff.address.pointer, diff.mergeable]),
      [
        ['replace', '/Root[0]/Item[uuid=same]/Name[0]', true],
        ['replace', '/Root[0]/Group[0]/Child[id=a]', true],
      ]
    );
    assert.ok(diffs.every((diff) => diff.patch.replacementXml));
  });

  test('applies replace insert and delete patches and preserves valid XML declaration', () => {
    const source = `<?xml version="1.0" encoding="UTF-8"?>
<Root><Item id="a">A</Item><Item id="b">B</Item></Root>`;
    const replaced = applyXmlPatch(source, {
      kind: 'replaceNode',
      target: {
        filePath: 'Object.xml',
        pointer: '/Root[0]/Item[id=a]',
        displayPath: 'Root > Item a',
        identityKey: 'id=a',
      },
      expectedOldHash: hashXmlText(source),
      newHash: 'sha256:replace',
      replacementXml: '<Item id="a">AA</Item>',
    });
    const inserted = applyXmlPatch(replaced, {
      kind: 'insertNode',
      target: {
        filePath: 'Object.xml',
        pointer: '/Root[0]/Item[id=c]',
        displayPath: 'Root > Item c',
        identityKey: 'id=c',
      },
      expectedOldHash: hashXmlText(replaced),
      newHash: 'sha256:insert',
      replacementXml: '<Item id="c"><Name>C</Name></Item>',
    });
    const deleted = applyXmlPatch(inserted, {
      kind: 'deleteNode',
      target: {
        filePath: 'Object.xml',
        pointer: '/Root[0]/Item[id=b]',
        displayPath: 'Root > Item b',
        identityKey: 'id=b',
      },
      expectedOldHash: hashXmlText(inserted),
      newHash: 'sha256:delete',
    });

    const parsed = parseXmlDocument(deleted);
    assert.strictEqual(parsed.declaration, '<?xml version="1.0" encoding="UTF-8"?>');
    assert.strictEqual(serializeXmlDocument(parsed), deleted);
    assert.match(deleted, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
    assert.match(deleted, /<Item id="a">AA<\/Item>/);
    assert.match(deleted, /<Item id="c"><Name>C<\/Name><\/Item>/);
    assert.doesNotMatch(deleted, /<Item id="b">/);
  });

  test('applies replace insert and delete attribute patches', () => {
    const source = '<Root><Item id="a" title="old">A</Item></Root>';
    const replaced = applyXmlPatch(source, {
      kind: 'replaceNode',
      target: {
        filePath: 'Object.xml',
        pointer: '/Root[0]/Item[id=a]/@title',
        displayPath: 'Root > Item a > @title',
        identityKey: 'id=a',
      },
      expectedOldHash: hashXmlText(source),
      newHash: 'sha256:replace-attribute',
      replacementXml: 'new',
    });
    const inserted = applyXmlPatch(replaced, {
      kind: 'insertNode',
      target: {
        filePath: 'Object.xml',
        pointer: '/Root[0]/Item[id=a]/@flag',
        displayPath: 'Root > Item a > @flag',
        identityKey: 'id=a',
      },
      expectedOldHash: hashXmlText(replaced),
      newHash: 'sha256:insert-attribute',
      replacementXml: 'true',
    });
    const deleted = applyXmlPatch(inserted, {
      kind: 'deleteNode',
      target: {
        filePath: 'Object.xml',
        pointer: '/Root[0]/Item[id=a]/@title',
        displayPath: 'Root > Item a > @title',
        identityKey: 'id=a',
      },
      expectedOldHash: hashXmlText(inserted),
      newHash: 'sha256:delete-attribute',
    });

    assert.match(replaced, /<Item id="a" title="new">A<\/Item>/);
    assert.match(inserted, /<Item id="a" title="new" flag="true">A<\/Item>/);
    assert.match(deleted, /<Item id="a" flag="true">A<\/Item>/);
  });
});
