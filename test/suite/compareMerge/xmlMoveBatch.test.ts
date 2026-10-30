import * as assert from 'assert';

import { applySelectedXmlPatches } from '../../../src/compareMerge/merge/semanticXmlMerge';
import { buildXmlAddress, elementChildren, parseXmlDocument, serializeXmlDocument, type XmlElement } from '../../../src/compareMerge/xml/xmlDom';
import { applyXmlPatch, applyXmlPatchBatch, hashXmlText } from '../../../src/compareMerge/xml/xmlPatch';

suite('XML move patch batches', () => {
  test('moves the existing target subtree between ChildItems and keeps inherited namespaces and unknown target XML', () => {
    const source = [
      '<Form>',
      '  <ChildItems>',
      '    <UsualGroup id="source">',
      '      <ChildItems xmlns:vendor="urn:vendor">',
      '        <InputField id="field" vendor:flag="target-value">',
      '          <Title>Target title</Title>',
      '          <FutureSetting><![CDATA[raw & value]]></FutureSetting>',
      '          <!--target comment-->',
      '        </InputField>',
      '      </ChildItems>',
      '    </UsualGroup>',
      '    <UsualGroup id="destination">',
      '      <ChildItems>',
      '        <Button id="anchor"/>',
      '        <LabelField id="target-only"/>',
      '      </ChildItems>',
      '    </UsualGroup>',
      '  </ChildItems>',
      '</Form>',
    ].join('\n');
    const document = parseXmlDocument(source);
    const target = findById(document.root, 'field');
    const destination = findChild(findById(document.root, 'destination'), 'ChildItems');
    const anchor = findById(document.root, 'anchor');
    const patch = asPatch({
      kind: 'moveNode',
      target: buildXmlAddress('Form.xml', target),
      destinationParent: buildXmlAddress('Form.xml', destination),
      insertBefore: buildXmlAddress('Form.xml', anchor),
      expectedOldHash: hashXmlText(source),
      newHash: '',
      semanticKind: 'formXml',
    });

    const moved = applyXmlPatch(source, patch);
    const result = parseXmlDocument(moved);
    const movedField = findById(result.root, 'field');
    const destinationItems = findChild(findById(result.root, 'destination'), 'ChildItems');

    assert.deepStrictEqual(elementChildren(destinationItems).map((item) => item.attributes.find((attribute) => attribute.localName === 'id')?.value), [
      'field', 'anchor', 'target-only',
    ]);
    assert.strictEqual(movedField.attributes.find((attribute) => attribute.name === 'vendor:flag')?.value, 'target-value');
    assert.ok(movedField.attributes.some((attribute) => attribute.name === 'xmlns:vendor' && attribute.value === 'urn:vendor'));
    assert.match(serializeXmlDocument(result), /<Title>Target title<\/Title>/u);
    assert.match(serializeXmlDocument(result), /<FutureSetting><!\[CDATA\[raw & value\]\]><\/FutureSetting>/u);
    assert.match(serializeXmlDocument(result), /<!--target comment-->/u);
  });

  test('applies multiple moves independently of selection order and preserves target-only siblings', () => {
    const source = '<Form><ChildItems><InputField id="a"/><Local id="local"/><Button id="b"/><LabelField id="c"/><UsualGroup id="destination"><ChildItems><LabelField id="anchor"/><Local id="inside"/></ChildItems></UsualGroup></ChildItems></Form>';
    const document = parseXmlDocument(source);
    const destination = findChild(findById(document.root, 'destination'), 'ChildItems');
    const anchor = findById(document.root, 'anchor');
    const moveA = asPatch({
      kind: 'moveNode',
      target: buildXmlAddress('Form.xml', findById(document.root, 'a')),
      destinationParent: buildXmlAddress('Form.xml', destination),
      insertBefore: buildXmlAddress('Form.xml', anchor),
      insertOrder: 10,
      expectedOldHash: hashXmlText(source),
      newHash: '',
      semanticKind: 'formXml',
    });
    const moveB = asPatch({
      kind: 'moveNode',
      target: buildXmlAddress('Form.xml', findById(document.root, 'b')),
      destinationParent: buildXmlAddress('Form.xml', destination),
      insertBefore: buildXmlAddress('Form.xml', anchor),
      insertOrder: 20,
      expectedOldHash: hashXmlText(source),
      newHash: '',
      semanticKind: 'formXml',
    });

    for (const patches of [[moveA, moveB], [moveB, moveA]]) {
      const result = applySelectedXmlPatches(source, patches);
      assert.strictEqual(result.ok, true, result.ok ? undefined : result.message);
      if (!result.ok) {return;}

      const merged = parseXmlDocument(result.source);
      const destinationItems = findChild(findById(merged.root, 'destination'), 'ChildItems');
      assert.deepStrictEqual(elementChildren(destinationItems).map((item) => item.attributes.find((attribute) => attribute.localName === 'id')?.value), [
        'a', 'b', 'anchor', 'inside',
      ]);
      assert.strictEqual(findById(merged.root, 'local').parent?.localName, 'ChildItems');
    }
  });

  test('places multiple inserted nodes before one fixed anchor in source order', () => {
    const source = '<Form><ChildItems><Button id="anchor"/></ChildItems></Form>';
    const document = parseXmlDocument(source);
    const anchor = findById(document.root, 'anchor');
    const parent = anchor.parent!;
    const parentAddress = buildXmlAddress('Form.xml', parent);
    const insertA = asPatch({
      kind: 'insertNode',
      target: { ...parentAddress, pointer: `${parentAddress.pointer}/LabelField[0]`, identityKey: undefined },
      replacementXml: '<LabelField id="a"/>',
      insertBefore: buildXmlAddress('Form.xml', anchor),
      insertOrder: 0,
      expectedOldHash: hashXmlText(source),
      newHash: '',
      semanticKind: 'formXml',
    });
    const insertB = asPatch({
      ...insertA,
      target: { ...parentAddress, pointer: `${parentAddress.pointer}/LabelField[1]`, identityKey: undefined },
      replacementXml: '<LabelField id="b"/>',
      insertOrder: 1,
    });

    for (const patches of [[insertA, insertB], [insertB, insertA]]) {
      const merged = applyXmlPatchBatch(source, patches);
      const mergedParent = findChild(parseXmlDocument(merged).root, 'ChildItems');
      assert.deepStrictEqual(elementChildren(mergedParent).map((element) =>
        element.attributes.find((attribute) => attribute.localName === 'id')?.value), ['a', 'b', 'anchor']);
    }
  });

  test('does not hide a stale original hash when batching moves', () => {
    const source = '<Form><ChildItems><InputField id="a"/><UsualGroup id="destination"><ChildItems/></UsualGroup></ChildItems></Form>';
    const document = parseXmlDocument(source);
    const target = findById(document.root, 'a');
    const destination = findChild(findById(document.root, 'destination'), 'ChildItems');
    const patch = asPatch({
      kind: 'moveNode',
      target: buildXmlAddress('Form.xml', target),
      destinationParent: buildXmlAddress('Form.xml', destination),
      insertPosition: 'append',
      expectedOldHash: 'stale-hash',
      newHash: '',
      semanticKind: 'formXml',
    });

    const result = applySelectedXmlPatches(source, [patch]);
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.strictEqual(result.code, 'MERGE_STALE_TARGET_HASH');
    }
    assert.throws(() => applyXmlPatch(source, asPatch({
      ...patch,
      expectedOldHash: '',
    })), /XML move hash guard failed/i);
  });

  test('rejects self, cycle, invalid-container, and BaseForm boundary moves', () => {
    const source = '<Form><ChildItems><UsualGroup id="owner"><ChildItems><InputField id="inside"/></ChildItems></UsualGroup><InputField id="outside"/><BaseForm><ChildItems><InputField id="base"/></ChildItems></BaseForm></ChildItems></Form>';
    const document = parseXmlDocument(source);
    const outside = findById(document.root, 'outside');
    const ownerChildItems = findChild(findById(document.root, 'owner'), 'ChildItems');
    const baseChildItems = findChild(findById(document.root, 'base').parent!.parent!, 'ChildItems');
    const root = document.root;

    assert.throws(() => applyXmlPatch(source, asPatch({
      kind: 'moveNode', target: buildXmlAddress('Form.xml', outside),
      destinationParent: buildXmlAddress('Form.xml', findChild(root, 'ChildItems')),
      insertBefore: buildXmlAddress('Form.xml', outside), expectedOldHash: hashXmlText(source), newHash: '', semanticKind: 'formXml',
    })), /self|anchor/i);
    assert.throws(() => applyXmlPatch(source, asPatch({
      kind: 'moveNode', target: buildXmlAddress('Form.xml', findById(root, 'owner')),
      destinationParent: buildXmlAddress('Form.xml', ownerChildItems), insertPosition: 'append',
      expectedOldHash: hashXmlText(source), newHash: '', semanticKind: 'formXml',
    })), /cycle|descendant/i);
    assert.throws(() => applyXmlPatch(source, asPatch({
      kind: 'moveNode', target: buildXmlAddress('Form.xml', outside),
      destinationParent: buildXmlAddress('Form.xml', root), insertPosition: 'append',
      expectedOldHash: hashXmlText(source), newHash: '', semanticKind: 'formXml',
    })), /ChildItems|container/i);
    assert.throws(() => applyXmlPatch(source, asPatch({
      kind: 'moveNode', target: buildXmlAddress('Form.xml', findById(root, 'base')),
      destinationParent: buildXmlAddress('Form.xml', baseChildItems), insertPosition: 'append',
      expectedOldHash: hashXmlText(source), newHash: '', semanticKind: 'formXml',
    })), /BaseForm/i);
  });

  test('rejects spoofed visual elements and ChildItems containers from another namespace', () => {
    const namespace = 'http://v8.1c.ru/8.3/xcf/logform';
    const targetSource = `<Form xmlns="${namespace}" xmlns:vendor="urn:vendor" version="2.20"><ChildItems><vendor:InputField id="2"/><UsualGroup id="3"><ChildItems/></UsualGroup></ChildItems></Form>`;
    const targetDocument = parseXmlDocument(targetSource);
    assert.throws(() => applyXmlPatch(targetSource, asPatch({
      kind: 'moveNode', target: buildXmlAddress('Form.xml', findById(targetDocument.root, '2')),
      destinationParent: buildXmlAddress('Form.xml', findChild(findById(targetDocument.root, '3'), 'ChildItems')),
      insertPosition: 'append', expectedOldHash: hashXmlText(targetSource), newHash: '', semanticKind: 'formXml',
    })), /supported logform visual element/i);

    const sourceContainerXml = `<Form xmlns="${namespace}" xmlns:vendor="urn:vendor" version="2.20"><ChildItems><UsualGroup id="1"><vendor:ChildItems><InputField id="2"/></vendor:ChildItems></UsualGroup><UsualGroup id="3"><ChildItems/></UsualGroup></ChildItems></Form>`;
    const sourceContainerDocument = parseXmlDocument(sourceContainerXml);
    assert.throws(() => applyXmlPatch(sourceContainerXml, asPatch({
      kind: 'moveNode', target: buildXmlAddress('Form.xml', findById(sourceContainerDocument.root, '2')),
      destinationParent: buildXmlAddress('Form.xml', findChild(findById(sourceContainerDocument.root, '3'), 'ChildItems')),
      insertPosition: 'append', expectedOldHash: hashXmlText(sourceContainerXml), newHash: '', semanticKind: 'formXml',
    })), /source must be a ChildItems container/i);

    const destinationContainerXml = `<Form xmlns="${namespace}" xmlns:vendor="urn:vendor" version="2.20"><ChildItems><InputField id="2"/><vendor:UsualGroup id="3"><ChildItems/></vendor:UsualGroup></ChildItems></Form>`;
    const destinationDocument = parseXmlDocument(destinationContainerXml);
    assert.throws(() => applyXmlPatch(destinationContainerXml, asPatch({
      kind: 'moveNode', target: buildXmlAddress('Form.xml', findById(destinationDocument.root, '2')),
      destinationParent: buildXmlAddress('Form.xml', findChild(findById(destinationDocument.root, '3'), 'ChildItems')),
      insertPosition: 'append', expectedOldHash: hashXmlText(destinationContainerXml), newHash: '', semanticKind: 'formXml',
    })), /destination must be a ChildItems container/i);
  });

  test('allows a unique EnumValue to move only within its existing Enum ChildObjects', () => {
    const namespace = 'http://v8.1c.ru/8.3/MDClasses';
    const source = `<MetaDataObject xmlns="${namespace}" version="2.20"><Enum uuid="e0000000-0000-4000-8000-000000000000"><Properties><Name>States</Name></Properties><ChildObjects><EnumValue uuid="a0000000-0000-4000-8000-000000000001"><Properties><Name>A</Name><Comment>Target A</Comment></Properties></EnumValue><!--keep--><FutureSetting>target only</FutureSetting><EnumValue uuid="b0000000-0000-4000-8000-000000000002"><Properties><Name>B</Name></Properties></EnumValue></ChildObjects></Enum></MetaDataObject>`;
    const document = parseXmlDocument(source);
    const valueA = findByUuid(document.root, 'a0000000-0000-4000-8000-000000000001');
    const valueB = findByUuid(document.root, 'b0000000-0000-4000-8000-000000000002');
    const childObjects = findChild(findChild(document.root, 'Enum'), 'ChildObjects');
    const move = asPatch({
      kind: 'moveNode',
      target: buildXmlAddress('Enum.xml', valueB),
      destinationParent: buildXmlAddress('Enum.xml', childObjects),
      insertBefore: buildXmlAddress('Enum.xml', valueA),
      expectedOldHash: hashXmlText(source),
      newHash: '',
      semanticKind: 'metadataXml',
    });

    const moved = applyXmlPatch(source, move);
    const result = parseXmlDocument(moved);
    const resultChildren = findChild(findChild(result.root, 'Enum'), 'ChildObjects');
    assert.deepStrictEqual(elementChildren(resultChildren).map((element) => element.localName === 'EnumValue'
      ? element.attributes.find((attribute) => attribute.localName === 'uuid')?.value
      : element.localName), [
      'b0000000-0000-4000-8000-000000000002',
      'a0000000-0000-4000-8000-000000000001', 'FutureSetting',
    ]);
    assert.match(moved, /<Comment>Target A<\/Comment>/u);
    assert.match(moved, /<!--keep-->/u);
    assert.match(moved, /<FutureSetting>target only<\/FutureSetting>/u);
    assert.strictEqual(findByUuid(result.root, 'b0000000-0000-4000-8000-000000000002').attributes.some((attribute) => attribute.name === 'xmlns'), false);
  });

  test('applies an insertion before a reparented visual anchor after the move batch', () => {
    const namespace = 'http://v8.1c.ru/8.3/xcf/logform';
    const source = `<Form xmlns="${namespace}" version="2.20"><ChildItems><UsualGroup name="Source" id="10"><ChildItems><Button name="Moving" id="11"><Title>Target subtree</Title></Button></ChildItems></UsualGroup><UsualGroup name="Destination" id="20"><ChildItems><Button name="Anchor" id="21"/></ChildItems></UsualGroup></ChildItems><Attributes/><Commands/></Form>`;
    const document = parseXmlDocument(source);
    const moving = findById(document.root, '11');
    const anchor = findById(document.root, '21');
    const destinationItems = findChild(findById(document.root, '20'), 'ChildItems');
    const destinationAddress = buildXmlAddress('Form.xml', destinationItems);
    const insertionTarget = {
      ...destinationAddress,
      pointer: `${destinationAddress.pointer}/LabelField[0]`,
      displayPath: `${destinationAddress.displayPath}/LabelField[0]`,
      identityKey: undefined,
    };
    const move = asPatch({
      kind: 'moveNode',
      target: buildXmlAddress('Form.xml', moving),
      destinationParent: destinationAddress,
      insertBefore: buildXmlAddress('Form.xml', anchor),
      insertOrder: 1,
      expectedOldHash: hashXmlText(source),
      newHash: '',
      semanticKind: 'formXml',
    });
    const insert = asPatch({
      kind: 'insertNode',
      target: insertionTarget,
      replacementXml: '<LabelField name="Inserted" id="31"/>',
      insertBefore: buildXmlAddress('Form.xml', moving),
      insertOrder: 0,
      expectedOldHash: hashXmlText(source),
      newHash: '',
      semanticKind: 'formXml',
    });

    for (const patches of [[insert, move], [move, insert]]) {
      const merged = applySelectedXmlPatches(source, patches);
      assert.strictEqual(merged.ok, true, merged.ok ? '' : merged.message);
      if (!merged.ok) {return;}
      const mergedDocument = parseXmlDocument(merged.source);
      const destination = findChild(findById(mergedDocument.root, '20'), 'ChildItems');
      assert.deepStrictEqual(elementChildren(destination).map((element) => element.attributes.find((attribute) => attribute.localName === 'id')?.value), [
        '31', '11', '21',
      ]);
      assert.strictEqual(elementChildren(findChild(findById(mergedDocument.root, '10'), 'ChildItems')).length, 0);
      assert.match(merged.source, /<Title>Target subtree<\/Title>/u);
    }
  });

  test('rejects an insert whose moving anchor ends in a different parent', () => {
    const namespace = 'http://v8.1c.ru/8.3/xcf/logform';
    const source = `<Form xmlns="${namespace}" version="2.20"><ChildItems><UsualGroup name="Source" id="10"><ChildItems><Button name="Moving" id="11"/></ChildItems></UsualGroup><UsualGroup name="Destination" id="20"><ChildItems><Button name="Anchor" id="21"/></ChildItems></UsualGroup></ChildItems><Attributes/><Commands/></Form>`;
    const document = parseXmlDocument(source);
    const moving = findById(document.root, '11');
    const anchor = findById(document.root, '21');
    const sourceItems = findChild(findById(document.root, '10'), 'ChildItems');
    const destinationItems = findChild(findById(document.root, '20'), 'ChildItems');
    const sourceAddress = buildXmlAddress('Form.xml', sourceItems);
    const move = asPatch({
      kind: 'moveNode',
      target: buildXmlAddress('Form.xml', moving),
      destinationParent: buildXmlAddress('Form.xml', destinationItems),
      insertBefore: buildXmlAddress('Form.xml', anchor),
      insertOrder: 0,
      expectedOldHash: hashXmlText(source),
      newHash: '',
      semanticKind: 'formXml',
    });
    const insert = asPatch({
      kind: 'insertNode',
      target: {
        ...sourceAddress,
        pointer: `${sourceAddress.pointer}/LabelField[0]`,
        displayPath: `${sourceAddress.displayPath}/LabelField[0]`,
        identityKey: undefined,
      },
      replacementXml: '<LabelField name="WrongOwner" id="31"/>',
      insertBefore: buildXmlAddress('Form.xml', moving),
      insertOrder: 0,
      expectedOldHash: hashXmlText(source),
      newHash: '',
      semanticKind: 'formXml',
    });

    assert.throws(
      () => applyXmlPatchBatch(source, [insert, move]),
      /final parent|same destination parent|insert.*anchor.*moved/i,
    );
  });

  test('rejects EnumValue moves across Enum owners or with ambiguous UUID identity', () => {
    const namespace = 'http://v8.1c.ru/8.3/MDClasses';
    const source = `<MetaDataObject xmlns="${namespace}" version="2.20"><Enum uuid="e0000000-0000-4000-8000-000000000000"><Properties><Name>One</Name></Properties><ChildObjects><EnumValue uuid="a0000000-0000-4000-8000-000000000001"><Properties><Name>A</Name></Properties></EnumValue></ChildObjects></Enum><Enum uuid="e0000000-0000-4000-8000-000000000003"><Properties><Name>Two</Name></Properties><ChildObjects><EnumValue uuid="b0000000-0000-4000-8000-000000000002"><Properties><Name>B</Name></Properties></EnumValue></ChildObjects></Enum></MetaDataObject>`;
    const document = parseXmlDocument(source);
    const target = findByUuid(document.root, 'a0000000-0000-4000-8000-000000000001');
    const anchor = findByUuid(document.root, 'b0000000-0000-4000-8000-000000000002');
    const destination = anchor.parent!;
    const crossOwner = asPatch({
      kind: 'moveNode', target: buildXmlAddress('Enum.xml', target),
      destinationParent: buildXmlAddress('Enum.xml', destination), insertBefore: buildXmlAddress('Enum.xml', anchor),
      expectedOldHash: hashXmlText(source), newHash: '', semanticKind: 'metadataXml',
    });
    assert.throws(() => applyXmlPatch(source, crossOwner), /same direct Enum ChildObjects|same Enum ChildObjects|same parent|unique metadata object owner/i);

    const duplicateSource = `<MetaDataObject xmlns="${namespace}" version="2.20"><Enum uuid="e0000000-0000-4000-8000-000000000000"><Properties><Name>One</Name></Properties><ChildObjects><EnumValue uuid="a0000000-0000-4000-8000-000000000001"><Properties><Name>A</Name></Properties></EnumValue><EnumValue uuid="a0000000-0000-4000-8000-000000000001"><Properties><Name>Duplicate</Name></Properties></EnumValue></ChildObjects></Enum></MetaDataObject>`;
    const duplicateDocument = parseXmlDocument(duplicateSource);
    const duplicateTarget = findByUuid(duplicateDocument.root, 'a0000000-0000-4000-8000-000000000001');
    const duplicateContainer = duplicateTarget.parent!;
    const duplicateMove = asPatch({
      kind: 'moveNode', target: buildXmlAddress('Enum.xml', duplicateTarget),
      destinationParent: buildXmlAddress('Enum.xml', duplicateContainer), insertPosition: 'append',
      expectedOldHash: hashXmlText(duplicateSource), newHash: '', semanticKind: 'metadataXml',
    });
    assert.throws(() => applyXmlPatch(duplicateSource, duplicateMove), /duplicate|unique|ambiguous/i);
  });

  test('rejects cycles in the final parent graph before detaching move targets', () => {
    const source = '<Form><ChildItems><UsualGroup id="a"><ChildItems><InputField id="a-child"/></ChildItems></UsualGroup><UsualGroup id="b"><ChildItems/></UsualGroup><UsualGroup id="c"><ChildItems/></UsualGroup></ChildItems></Form>';
    const document = parseXmlDocument(source);
    const a = findById(document.root, 'a');
    const b = findById(document.root, 'b');
    const c = findById(document.root, 'c');
    const childItems = (owner: XmlElement): XmlElement => findChild(owner, 'ChildItems');
    const move = (target: XmlElement, destination: XmlElement, order: number) => asPatch({
      kind: 'moveNode',
      target: buildXmlAddress('Form.xml', target),
      destinationParent: buildXmlAddress('Form.xml', destination),
      insertPosition: 'append',
      insertOrder: order,
      expectedOldHash: hashXmlText(source),
      newHash: '',
      semanticKind: 'formXml',
    });

    assert.throws(() => applyXmlPatchBatch(source, [
      move(a, childItems(b), 0),
      move(b, childItems(a), 1),
    ]), /parent graph|cycle/i);
    assert.throws(() => applyXmlPatchBatch(source, [
      move(a, childItems(b), 0),
      move(b, childItems(c), 1),
      move(c, childItems(a), 2),
    ]), /parent graph|cycle/i);
  });

  test('creates a missing root ChildItems at the Designer schema position', () => {
    const source = '<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.20"><AutoCommandBar name="Bar" id="-1"><ChildItems><Button name="Move" id="2"/></ChildItems></AutoCommandBar><Attributes/><Commands/><BaseForm/></Form>';
    const document = parseXmlDocument(source);
    const owner = document.root;
    const target = findById(document.root, '2');
    const ownerAddress = buildXmlAddress('Form.xml', owner);
    const patch = asPatch({
      kind: 'moveNode',
      target: buildXmlAddress('Form.xml', target),
      destinationParent: {
        ...ownerAddress,
        pointer: ownerAddress.pointer + '/ChildItems[0]',
        displayPath: ownerAddress.displayPath + '/ChildItems[0]',
        identityKey: undefined,
      },
      createDestinationChildItems: true,
      insertPosition: 'append',
      expectedOldHash: hashXmlText(source),
      newHash: '',
      semanticKind: 'formXml',
    });

    const merged = parseXmlDocument(applyXmlPatch(source, patch));
    assert.deepStrictEqual(elementChildren(merged.root).map((element) => element.localName), [
      'AutoCommandBar', 'ChildItems', 'Attributes', 'Commands', 'BaseForm',
    ]);
    const destination = findChild(merged.root, 'ChildItems');
    assert.strictEqual(findById(merged.root, '2').parent, destination);
    assert.strictEqual(destination.attributes.find((attribute) => attribute.name === 'xmlns')?.value, undefined);
  });

  test('creates ChildItems at the end of a supported nested visual owner and rejects invalid synthesis', () => {
    const source = '<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.20"><ChildItems><UsualGroup name="Source" id="1"><ChildItems><InputField name="Move" id="2"/></ChildItems></UsualGroup><UsualGroup name="Destination" id="3"><Title>Keep me</Title></UsualGroup></ChildItems><Attributes/><Commands/></Form>';
    const document = parseXmlDocument(source);
    const target = findById(document.root, '2');
    const owner = findById(document.root, '3');
    const ownerAddress = buildXmlAddress('Form.xml', owner);
    const patch = asPatch({
      kind: 'moveNode',
      target: buildXmlAddress('Form.xml', target),
      destinationParent: {
        ...ownerAddress,
        pointer: ownerAddress.pointer + '/ChildItems[0]',
        displayPath: ownerAddress.displayPath + '/ChildItems[0]',
        identityKey: undefined,
      },
      createDestinationChildItems: true,
      insertPosition: 'append',
      expectedOldHash: hashXmlText(source),
      newHash: '',
      semanticKind: 'formXml',
    });

    const merged = parseXmlDocument(applyXmlPatch(source, patch));
    const destinationOwner = findById(merged.root, '3');
    assert.deepStrictEqual(elementChildren(destinationOwner).map((element) => element.localName), ['Title', 'ChildItems']);
    assert.strictEqual(findById(merged.root, '2').parent, findChild(destinationOwner, 'ChildItems'));

    assert.throws(() => applyXmlPatch(source, asPatch({
      ...patch,
      destinationParent: buildXmlAddress('Form.xml', findChild(destinationOwner, 'Title')),
    })), /ChildItems|owner|container/i);
  });

  test('rejects stale, duplicated, or inherited BaseForm owners for ChildItems synthesis', () => {
    const namespace = 'http://v8.1c.ru/8.3/xcf/logform';
    const makeSyntheticMove = (source: string, targetId: string, ownerId: string) => {
      const document = parseXmlDocument(source);
      const ownerAddress = buildXmlAddress('Form.xml', findById(document.root, ownerId));
      return asPatch({
        kind: 'moveNode',
        target: buildXmlAddress('Form.xml', findById(document.root, targetId)),
        destinationParent: {
          ...ownerAddress,
          pointer: ownerAddress.pointer + '/ChildItems[0]',
          displayPath: ownerAddress.displayPath + '/ChildItems[0]',
          identityKey: undefined,
        },
        createDestinationChildItems: true,
        insertPosition: 'append',
        expectedOldHash: hashXmlText(source),
        newHash: '',
        semanticKind: 'formXml',
      });
    };

    const base = `<Form xmlns="${namespace}" version="2.20"><ChildItems><UsualGroup id="1"><ChildItems><InputField id="2"/></ChildItems></UsualGroup><UsualGroup id="3"><Title>Keep</Title></UsualGroup></ChildItems></Form>`;
    const staleOwnerDocument = parseXmlDocument(base);
    const staleOwnerMove = makeSyntheticMove(base, '2', '3');
    const removeOwner = asPatch({
      kind: 'deleteNode', target: buildXmlAddress('Form.xml', findById(staleOwnerDocument.root, '3')),
      expectedOldHash: hashXmlText(base), newHash: '', semanticKind: 'formXml',
    });
    assert.throws(() => applyXmlPatchBatch(base, [staleOwnerMove, removeOwner]), /destination owner.*removed/i);

    const duplicate = `<Form xmlns="${namespace}" version="2.20"><ChildItems><UsualGroup id="1"><ChildItems><InputField id="2"/></ChildItems></UsualGroup><UsualGroup id="3"><ChildItems/><ChildItems/></UsualGroup></ChildItems></Form>`;
    assert.throws(() => applyXmlPatch(duplicate, makeSyntheticMove(duplicate, '2', '3')), /already has a ChildItems/i);

    const baseFormOwner = `<Form xmlns="${namespace}" version="2.20"><ChildItems><InputField id="2"/></ChildItems><BaseForm><UsualGroup id="3"><Title>Inherited</Title></UsualGroup></BaseForm></Form>`;
    assert.throws(() => applyXmlPatch(baseFormOwner, makeSyntheticMove(baseFormOwner, '2', '3')), /BaseForm/i);
  });

  test('rejects an explicit ChildItems insert that overlaps a synthesized move destination', () => {
    const namespace = 'http://v8.1c.ru/8.3/xcf/logform';
    const source = '<Form xmlns="' + namespace + '" version="2.20"><ChildItems><UsualGroup id="1"><ChildItems><InputField id="2"/></ChildItems></UsualGroup><UsualGroup id="3"><Title>Keep</Title></UsualGroup></ChildItems></Form>';
    const document = parseXmlDocument(source);
    const ownerAddress = buildXmlAddress('Form.xml', findById(document.root, '3'));
    const destinationParent = {
      ...ownerAddress,
      pointer: ownerAddress.pointer + '/ChildItems[0]',
      displayPath: ownerAddress.displayPath + '/ChildItems[0]',
      identityKey: undefined,
    };
    const move = asPatch({
      kind: 'moveNode',
      target: buildXmlAddress('Form.xml', findById(document.root, '2')),
      destinationParent,
      createDestinationChildItems: true,
      insertPosition: 'append',
      expectedOldHash: hashXmlText(source),
      newHash: '',
      semanticKind: 'formXml',
    });
    const explicitContainerInsert = asPatch({
      kind: 'insertNode',
      target: destinationParent,
      replacementXml: '<ChildItems/>',
      expectedOldHash: hashXmlText(source),
      newHash: '',
      semanticKind: 'formXml',
    });

    assert.throws(
      () => applyXmlPatchBatch(source, [move, explicitContainerInsert]),
      /explicit insert.*synthesized ChildItems destination/i,
    );
  });
});

function asPatch(value: Record<string, unknown>): Parameters<typeof applyXmlPatch>[1] {
  return value as unknown as Parameters<typeof applyXmlPatch>[1];
}

function findById(root: XmlElement, id: string): XmlElement {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.attributes.some((attribute) => attribute.localName === 'id' && attribute.value === id)) {
      return current;
    }
    pending.push(...elementChildren(current));
  }
  throw new Error(`Element with id ${id} was not found.`);
}

function findByUuid(root: XmlElement, uuid: string): XmlElement {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.attributes.some((attribute) => attribute.localName === 'uuid' && attribute.value === uuid)) {
      return current;
    }
    pending.push(...elementChildren(current));
  }
  throw new Error(`Expected XML uuid ${uuid}`);
}

function findChild(parent: XmlElement, localName: string): XmlElement {
  const child = elementChildren(parent).find((element) => element.localName === localName);
  if (!child) {
    throw new Error(`Child ${localName} was not found.`);
  }
  return child;
}
