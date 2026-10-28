import * as assert from 'assert';

import {
  buildXmlAddress,
  captureXmlSubtree,
  getXmlElementIdentityKey,
  parseXmlDocument,
  serializeXmlDocument,
  type XmlElement,
} from '../../../src/compareMerge/xml/xmlDom';
import { parseXmlAddressPointer } from '../../../src/compareMerge/xml/xmlAddress';
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

    assert.strictEqual(address.pointer, '/MetaDataObject[0]/Catalog[metadata-root%3D%7Burn%3Atest%7DCatalog%3Bname%3Dproducts]');
    assert.strictEqual(address.identityKey, 'metadata-root={urn:test}Catalog;name=products');
    assert.strictEqual(address.displayPath, 'MetaDataObject > Catalog {urn:test}Catalog;name=products');
  });

  test('resolves semantic metadata-root selectors during a nested patch', () => {
    const source = `<MetaDataObject xmlns="urn:metadata">
<Catalog uuid="catalog-id"><Properties><Name>Products</Name></Properties><ChildObjects>
  <Attribute uuid="attribute-id"><Properties><Name>IbcmdCheck</Name></Properties><Type><Type>xs:string</Type></Type></Attribute>
</ChildObjects></Catalog>
</MetaDataObject>`;
    const document = parseXmlDocument(source);
    const catalog = document.root.children.find(
      (child): child is XmlElement => child.kind === 'element' && child.localName === 'Catalog'
    );
    assert.ok(catalog);
    const attribute = catalog.children
      .filter((child): child is XmlElement => child.kind === 'element' && child.localName === 'ChildObjects')[0]
      ?.children.filter((child): child is XmlElement => child.kind === 'element' && child.localName === 'Attribute')[0];
    assert.ok(attribute);
    const type = attribute.children
      .filter((child): child is XmlElement => child.kind === 'element' && child.localName === 'Type')[0]
      ?.children.filter((child): child is XmlElement => child.kind === 'element' && child.localName === 'Type')[0];
    assert.ok(type);
    const target = buildXmlAddress('Catalog.xml', type);
    assert.match(target.pointer, /Catalog\[metadata-root%3D%7Burn%3Ametadata%7DCatalog%3Bname%3Dproducts\]/u);

    const result = applyXmlPatch(source, {
      kind: 'replaceNode',
      target,
      expectedOldHash: hashXmlText(source),
      newHash: 'sha256:semantic-root',
      replacementXml: '<Type>cfg:CatalogRef.Products</Type>',
    });

    assert.match(result, /<Type>cfg:CatalogRef\.Products<\/Type>/u);
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
        ['replace', '/Root[0]/Item[uuid%3Dsame]/Name[0]', true],
        ['replace', '/Root[0]/Group[0]/Child[id%3Da]', true],
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

  test('encodes identity selectors and decodes each selector once', () => {
    const document = parseXmlDocument('<Root><Item id="a/b~%[]"/></Root>');
    const item = document.root.children.find(
      (child): child is XmlElement => child.kind === 'element' && child.localName === 'Item'
    );

    assert.ok(item);
    const address = buildXmlAddress('Object.xml', item);
    assert.strictEqual(address.pointer, '/Root[0]/Item[id%3Da%2Fb%7E%25%5B%5D]');
    assert.deepStrictEqual(parseXmlAddressPointer(address.pointer), [
      { localName: 'Root', selector: '0' },
      { localName: 'Item', selector: 'id=a/b~%[]' },
    ]);

    const replaced = applyXmlPatch('<Root><Item id="a/b~%[]">old</Item></Root>', {
      kind: 'replaceNode',
      target: address,
      expectedOldHash: '',
      newHash: 'sha256:replace',
      replacementXml: '<Item id="a/b~%[]">new</Item>',
    });
    assert.strictEqual(replaced, '<Root><Item id="a/b~%[]">new</Item></Root>');
  });

  test('rejects duplicate identities rather than selecting the first matching child', () => {
    assert.throws(
      () =>
        applyXmlPatch('<Root><Item id="same">one</Item><Item id="same">two</Item></Root>', {
          kind: 'deleteNode',
          target: {
            filePath: 'Object.xml',
            pointer: '/Root[0]/Item[id=same]',
            displayPath: 'Root > Item same',
            identityKey: 'id=same',
          },
          expectedOldHash: '',
          newHash: 'sha256:delete',
        }),
      /ambiguous/i
    );
  });

  test('inserts before the requested same-parent anchor across mixed child nodes', () => {
    const source = '<Root><First/><!--between--><Anchor/><Last/></Root>';
    const patch = {
      kind: 'insertNode' as const,
      target: {
        filePath: 'Object.xml',
        pointer: '/Root[0]/Inserted[id=new]',
        displayPath: 'Root > Inserted new',
        identityKey: 'id=new',
      },
      insertBefore: {
        filePath: 'Object.xml',
        pointer: '/Root[0]/Anchor[0]',
        displayPath: 'Root > Anchor',
      },
      expectedOldHash: '',
      newHash: 'sha256:insert',
      replacementXml: '<Inserted id="new"/>',
    };

    assert.strictEqual(
      applyXmlPatch(source, patch as Parameters<typeof applyXmlPatch>[1]),
      '<Root><First/><!--between--><Inserted id="new"/><Anchor/><Last/></Root>'
    );
  });

  test('rejects an insertion anchor from a different parent', () => {
    const source = '<Root><Group><Anchor/></Group><Other/></Root>';
    const patch = {
      kind: 'insertNode' as const,
      target: {
        filePath: 'Object.xml',
        pointer: '/Root[0]/Group[0]/Inserted[id=new]',
        displayPath: 'Root > Group > Inserted new',
        identityKey: 'id=new',
      },
      insertBefore: {
        filePath: 'Object.xml',
        pointer: '/Root[0]/Other[0]',
        displayPath: 'Root > Other',
      },
      expectedOldHash: '',
      newHash: 'sha256:insert',
      replacementXml: '<Inserted id="new"/>',
    };

    assert.throws(
      () => applyXmlPatch(source, patch as Parameters<typeof applyXmlPatch>[1]),
      /same parent/i
    );
  });

  test('appends a repeated element after all heterogeneous child nodes when requested', () => {
    const source = '<Root><Item id="first"/><Other/><!--tail--></Root>';
    const appended = applyXmlPatch(source, {
      kind: 'insertNode',
      target: {
        filePath: 'Object.xml',
        pointer: '/Root[0]/Item[id%3Dsecond]',
        displayPath: 'Root > Item second',
        identityKey: 'id=second',
      },
      insertPosition: 'append',
      expectedOldHash: '',
      newHash: 'sha256:append',
      replacementXml: '<Item id="second"/>',
    });

    assert.strictEqual(
      appended,
      '<Root><Item id="first"/><Other/><!--tail--><Item id="second"/></Root>'
    );
  });

  test('rejects conflicting insertBefore and append positioning fields', () => {
    const source = '<Root><Anchor/></Root>';
    const patch = {
      kind: 'insertNode' as const,
      target: {
        filePath: 'Object.xml',
        pointer: '/Root[0]/Inserted[id%3Dnew]',
        displayPath: 'Root > Inserted new',
        identityKey: 'id=new',
      },
      insertBefore: {
        filePath: 'Object.xml',
        pointer: '/Root[0]/Anchor[0]',
        displayPath: 'Root > Anchor',
      },
      insertPosition: 'append' as const,
      expectedOldHash: '',
      newHash: 'sha256:insert',
      replacementXml: '<Inserted id="new"/>',
    };

    assert.throws(
      () => applyXmlPatch(source, patch as Parameters<typeof applyXmlPatch>[1]),
      /cannot be used together/i
    );
  });

  test('rejects malformed documents instead of accepting a partial root', () => {
    for (const source of [
      '<Root/><Other/>',
      '<Root></Root></Stray>',
      '<Root id="one" id="two"/>',
      '<Root broken=value/>',
      '<!DOCTYPE Root [<!ENTITY x "value">]><Root>&x;</Root>',
    ]) {
      assert.throws(
        () => parseXmlDocument(source),
        `expected malformed XML to be rejected: ${source}`
      );
    }
  });

  test('rejects undeclared entity references without rescanning escaped literal text', () => {
    assert.throws(() => parseXmlDocument('<Root>&unknown;</Root>'), /entity reference/i);
    assert.strictEqual(
      serializeXmlDocument(parseXmlDocument('<Root>&amp;unknown;</Root>')),
      '<Root>&amp;unknown;</Root>'
    );
  });

  test('rejects unbound namespace prefixes on elements and attributes', () => {
    assert.throws(
      () => parseXmlDocument('<Root><x:Title>value</x:Title></Root>'),
      /namespace prefix/i
    );
    assert.throws(() => parseXmlDocument('<Root x:flag="true"/>'), /namespace prefix/i);
  });

  test('preserves top-level comments, processing instructions, BOM, declaration, and CRLF', () => {
    const source =
      '\uFEFF<?xml version="1.0" encoding="UTF-8"?>\r\n' +
      '<!--before root-->\r\n<?vendor mode="keep"?>\r\n' +
      '<Root/>\r\n<!--after root--><?post done?>\r\n';

    assert.strictEqual(serializeXmlDocument(parseXmlDocument(source)), source);
  });

  test('preserves single-quoted attributes and escapes their quote character', () => {
    const source = '<Root label=\'a "double" &apos;single&apos; quote\'/>';

    assert.strictEqual(serializeXmlDocument(parseXmlDocument(source)), source);
  });

  test('captures in-scope namespaces while preserving subtree mixed content', () => {
    const document = parseXmlDocument(
      '<Root xmlns:xsi="urn:xsi" xmlns:t="urn:types"><Item xsi:type="t:Thing">t:Value<!--kept--><![CDATA[&raw]]></Item></Root>'
    );
    const item = document.root.children.find(
      (child): child is XmlElement => child.kind === 'element' && child.localName === 'Item'
    );

    assert.ok(item);
    assert.strictEqual(
      captureXmlSubtree(item),
      '<Item xsi:type="t:Thing" xmlns:xsi="urn:xsi" xmlns:t="urn:types">t:Value<!--kept--><![CDATA[&raw]]></Item>'
    );
  });

  test('uses expanded QName and content value identities for semantic collection entries', () => {
    const document = parseXmlDocument(
      '<Root xmlns:v8="urn:types"><Type><v8:Type>v8:String</v8:Type></Type><Content><Item>Catalog.Products</Item></Content></Root>'
    );
    const typeCollection = document.root.children.find(
      (child): child is XmlElement => child.kind === 'element' && child.localName === 'Type'
    );
    const content = document.root.children.find(
      (child): child is XmlElement => child.kind === 'element' && child.localName === 'Content'
    );
    assert.ok(typeCollection);
    assert.ok(content);
    const typeEntry = typeCollection.children.find(
      (child): child is XmlElement => child.kind === 'element' && child.localName === 'Type'
    );
    const item = content.children.find(
      (child): child is XmlElement => child.kind === 'element' && child.localName === 'Item'
    );

    assert.ok(typeEntry);
    assert.ok(item);
    assert.strictEqual(getXmlElementIdentityKey(typeEntry), 'Type={urn:types}String');
    assert.strictEqual(getXmlElementIdentityKey(item), 'Item=Catalog.Products');
  });

  test('resolves lowercase name attributes, language items, and Unicode QName selectors', () => {
    const source =
      '<Root xmlns:cfg="urn:catalog"><Entry name="lowercase-only"/><item><lang>ru</lang></item><Type><cfg:Type>cfg:CatalogRef.Справочник55</cfg:Type></Type></Root>';
    const document = parseXmlDocument(source);
    const entry = document.root.children.find(
      (child): child is XmlElement => child.kind === 'element' && child.localName === 'Entry'
    );
    const languageItem = document.root.children.find(
      (child): child is XmlElement => child.kind === 'element' && child.localName === 'item'
    );
    const typeCollection = document.root.children.find(
      (child): child is XmlElement => child.kind === 'element' && child.localName === 'Type'
    );
    assert.ok(entry);
    assert.ok(languageItem);
    assert.ok(typeCollection);
    const typeEntry = typeCollection.children.find(
      (child): child is XmlElement => child.kind === 'element' && child.localName === 'Type'
    );
    assert.ok(typeEntry);

    assert.strictEqual(getXmlElementIdentityKey(entry), 'name=lowercase-only');
    assert.strictEqual(getXmlElementIdentityKey(languageItem), 'lang=ru');
    assert.strictEqual(
      getXmlElementIdentityKey(typeEntry),
      'Type={urn:catalog}CatalogRef.Справочник55'
    );
    assert.strictEqual(
      buildXmlAddress('Object.xml', entry).pointer,
      '/Root[0]/Entry[name%3Dlowercase-only]'
    );
    assert.strictEqual(
      buildXmlAddress('Object.xml', languageItem).pointer,
      '/Root[0]/item[lang%3Dru]'
    );

    const deletedEntry = applyXmlPatch(source, {
      kind: 'deleteNode',
      target: buildXmlAddress('Object.xml', entry),
      expectedOldHash: '',
      newHash: 'sha256:delete-entry',
    });
    assert.doesNotMatch(deletedEntry, /<Entry /);
    const deletedLanguageItem = applyXmlPatch(source, {
      kind: 'deleteNode',
      target: buildXmlAddress('Object.xml', languageItem),
      expectedOldHash: '',
      newHash: 'sha256:delete-language-item',
    });
    assert.doesNotMatch(deletedLanguageItem, /<item>/);
  });

  test('round-trips decimal, hexadecimal, Cyrillic, and supplementary XML character references', () => {
    const source = '<Root value="&#13;&#xA;&#x410;&#x1F642;">&#13;&#xA;&#x410;&#x1F642;</Root>';
    const serialized = serializeXmlDocument(parseXmlDocument(source));

    assert.strictEqual(serialized, '<Root value="&#13;&#10;А🙂">&#13;\nА🙂</Root>');
    const roundTripped = parseXmlDocument(serialized);
    assert.strictEqual(roundTripped.root.attributes[0].value, '\r\nА🙂');
    assert.strictEqual(
      roundTripped.root.children
        .filter((child) => child.kind === 'text')
        .map((child) => child.text)
        .join(''),
      '\r\nА🙂'
    );
  });

  test('rejects numeric references to characters outside the XML character range', () => {
    assert.throws(() => parseXmlDocument('<Root>&#xD800;</Root>'), /invalid XML character/i);
  });
});
