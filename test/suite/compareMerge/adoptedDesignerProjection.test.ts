import * as assert from 'assert';
import { createHash } from 'crypto';
import { elementChildren, parseXmlDocument } from '../../../src/compareMerge/xml/xmlDom';
import { direct, stableElement } from '../../../src/compareMerge/extensions/adoptedDesignerXml';

import {
  adoptedChildUuidMapKey,
  collectAdoptedDesignerChildUuidRequirements,
  materializeAdoptedDesignerTarget,
  projectAdoptedDesignerPair,
  type AdoptedDesignerIdentity,
  type AdoptedDesignerProjectionInput,
} from '../../../src/compareMerge/extensions/adoptedDesignerProjection';
import type { AdoptedDesignerTypeIdReferenceDescriptor } from '../../../src/compareMerge/extensions/adoptedDesignerTypeId';

const BASE_UUID = '11111111-1111-4111-8111-111111111111';
const CFE_UUID = '22222222-2222-4222-8222-222222222222';
const SOURCE_CFE_UUID = '99999999-9999-4999-8999-999999999999';
const CHILD_UUID = '33333333-3333-4333-8333-333333333333';
const CHILD_LOCAL_UUID = '44444444-4444-4444-8444-444444444444';
const NEW_CHILD_LOCAL_UUID = '55555555-5555-4555-8555-555555555555';
const NESTED_CHILD_UUID = '66666666-6666-4666-8666-666666666666';
const NESTED_CHILD_LOCAL_UUID = '77777777-7777-4777-8777-777777777777';
const NESTED_OWN_CHILD_UUID = '88888888-8888-4888-8888-888888888888';

suite('Adopted Designer descriptor projection (#335)', () => {
  test('projects both adopted descriptors independently and materializes into target ownership', () => {
    const baseXml = descriptor({ uuid: BASE_UUID, comment: 'Base comment' });
    const targetXml = Buffer.from(descriptor({
      uuid: CFE_UUID,
      adopted: true,
      comment: 'Target overlay',
      extraProperties: '<ExtensionOnly>Target-only change</ExtensionOnly>',
    }).toString('utf8').replace('name="CatalogRef"', 'name="TargetCatalogRef"'));
    const sourceXml = Buffer.from(descriptor({
      uuid: SOURCE_CFE_UUID,
      adopted: true,
      comment: 'Source overlay',
      extraProperties: '<ExtensionOnly>Source-only change</ExtensionOnly>',
    }).toString('utf8').replace('name="CatalogRef"', 'name="SourceCatalogRef"'));
    const input = makeInput({ direction: 'adopted-to-adopted', baseXml, targetXml, sourceXml });

    const projection = projectAdoptedDesignerPair(input);

    assert.strictEqual(projection.ok, true, projection.ok ? undefined : projection.reason);
    if (!projection.ok) { return; }
    assert.match(projection.targetXml.toString('utf8'), new RegExp(`<Catalog uuid="${BASE_UUID}"`));
    assert.match(projection.sourceXml.toString('utf8'), new RegExp(`<Catalog uuid="${BASE_UUID}"`));
    assert.match(projection.targetXml.toString('utf8'), /<Comment(?:\s[^>]*)?>Target overlay<\/Comment>/u);
    assert.match(projection.sourceXml.toString('utf8'), /<Comment(?:\s[^>]*)?>Source overlay<\/Comment>/u);

    const mergedLogicalTarget = Buffer.from(projection.targetXml.toString('utf8').replace('Target overlay', 'Selected target value'));
    const materialized = materializeAdoptedDesignerTarget({ ...input, mergedLogicalTarget });

    assert.strictEqual(materialized.ok, true, materialized.ok ? undefined : materialized.reason);
    if (!materialized.ok) { return; }
    const xml = materialized.content.toString('utf8');
    assert.match(xml, new RegExp(`<Catalog uuid="${CFE_UUID}"`));
    assert.match(xml, new RegExp(`<ExtendedConfigurationObject>${BASE_UUID}<\/ExtendedConfigurationObject>`));
    assert.match(xml, /<Comment(?:\s[^>]*)?>Selected target value<\/Comment>/u);
    assert.match(xml, /<ExtensionOnly(?:\s[^>]*)?>Target-only change<\/ExtensionOnly>/u);
    assert.doesNotMatch(xml, /Source-only change/u);
    assert.match(xml, /<xr:GeneratedType name="TargetCatalogRef" uuid="11111111-1111-4111-8111-111111111111"\/>/u);
  });

  test('rejects adopted-to-adopted inputs unless both sides share the exact base anchor', () => {
    const input = makeInput({ direction: 'adopted-to-adopted' });
    const wrongSourceAnchor = projectAdoptedDesignerPair({
      ...input,
      sourceIdentity: { ...input.sourceIdentity, sourceUuid: SOURCE_CFE_UUID },
    });
    assert.strictEqual(wrongSourceAnchor.ok, false);
    if (!wrongSourceAnchor.ok) { assert.match(wrongSourceAnchor.reason, /base anchor|anchor/u); }

    const ownSource = projectAdoptedDesignerPair({
      ...input,
      sourceXml: descriptor({ uuid: BASE_UUID }),
      sourceIdentity: { ...input.baseIdentity },
    });
    assert.strictEqual(ownSource.ok, false);
    if (!ownSource.ok) { assert.match(ownSource.reason, /ownership|ObjectBelonging|Направление/u); }
  });

  test('rejects an unknown runtime direction instead of treating it as adopted-to-adopted', () => {
    const input = makeInput({ direction: 'adopted-to-adopted' });
    const direction = 'unknown-direction' as unknown as AdoptedDesignerProjectionInput['direction'];

    const result = projectAdoptedDesignerPair({ ...input, direction });

    assert.strictEqual(result.ok, false);
    if (!result.ok) { assert.match(result.reason, /направлени/iu); }
  });

  test('collects and uses target child UUID allocations for adopted-to-adopted materialization', () => {
    const sourceOverlay = adoptedChild({ comment: 'Selected borrowed child' });
    const baseXml = descriptor({ uuid: BASE_UUID, childObjects: [baseChild('Base child')] });
    const input = makeInput({
      direction: 'adopted-to-adopted',
      baseXml,
      targetXml: descriptor({ uuid: CFE_UUID, adopted: true, childObjects: [] }),
      sourceXml: descriptor({ uuid: SOURCE_CFE_UUID, adopted: true, childObjects: [sourceOverlay] }),
    });
    const requirements = collectAdoptedDesignerChildUuidRequirements(input);

    assert.strictEqual(requirements.ok, true, requirements.ok ? undefined : requirements.reason);
    if (!requirements.ok) { return; }
    assert.strictEqual(requirements.requirements.length, 1);
    assert.strictEqual(requirements.requirements[0]?.anchorUuid, CHILD_UUID);
    const allocations = new Map([[requirements.requirements[0]!.mapKey, NEW_CHILD_LOCAL_UUID]]);
    const projection = projectAdoptedDesignerPair({ ...input, adoptedChildUuidByAnchor: allocations });
    assert.strictEqual(projection.ok, true, projection.ok ? undefined : projection.reason);
    if (!projection.ok) { return; }

    const materialized = materializeAdoptedDesignerTarget({
      ...input,
      adoptedChildUuidByAnchor: allocations,
      mergedLogicalTarget: projection.sourceXml,
    });

    assert.strictEqual(materialized.ok, true, materialized.ok ? undefined : materialized.reason);
    if (!materialized.ok) { return; }
    const xml = materialized.content.toString('utf8');
    assert.match(xml, new RegExp(`<Dimension uuid="${NEW_CHILD_LOCAL_UUID}"`));
    assert.match(xml, new RegExp(`<ExtendedConfigurationObject>${CHILD_UUID}<\/ExtendedConfigurationObject>`));
    assert.match(xml, new RegExp(`<Catalog uuid="${CFE_UUID}"`));
    assert.match(xml, /Selected borrowed child/u);
  });

  test('compares expanded XML names and typed QName values without normalizing arbitrary text', () => {
    const rebound = parseXmlDocument('<root xmlns:p="urn:base"><p:Node p:flag="yes"><p:Type>p:Thing</p:Type><Comment>p:Thing</Comment></p:Node></root>');
    const foreign = parseXmlDocument('<root xmlns:p="urn:base"><p:Node xmlns:p="urn:evil" p:flag="yes"><p:Type>p:Thing</p:Type><Comment>p:Thing</Comment></p:Node></root>');
    assert.notStrictEqual(stableElement(rebound.root.children[0] as import('../../../src/compareMerge/xml/xmlDom').XmlElement), stableElement(foreign.root.children[0] as import('../../../src/compareMerge/xml/xmlDom').XmlElement), 'a prefix rebound to another namespace changes expanded element and attribute names');

    const xsiBase = parseXmlDocument('<root xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xs="http://www.w3.org/2001/XMLSchema"><Node xsi:type="xs:string"/></root>');
    const xsiRebound = parseXmlDocument('<root xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xs="http://www.w3.org/2001/XMLSchema"><Node xmlns:xs="urn:vendor" xsi:type="xs:string"/></root>');
    assert.notStrictEqual(stableElement(xsiBase.root.children[0] as import('../../../src/compareMerge/xml/xmlDom').XmlElement), stableElement(xsiRebound.root.children[0] as import('../../../src/compareMerge/xml/xmlDom').XmlElement), 'a rebound QName value in xsi:type changes its expanded value');

    const aliasA = parseXmlDocument('<root xmlns:a="http://v8.1c.ru/8.1/data/core" xmlns:x="http://www.w3.org/2001/XMLSchema" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><a:Type i:type="a:TypeDescription"><a:Type>x:Thing</a:Type><a:Comment>x:Thing</a:Comment></a:Type></root>');
    const aliasB = parseXmlDocument('<root xmlns:b="http://v8.1c.ru/8.1/data/core" xmlns:y="http://www.w3.org/2001/XMLSchema" xmlns:j="http://www.w3.org/2001/XMLSchema-instance"><b:Type j:type="b:TypeDescription"><b:Type>y:Thing</b:Type><b:Comment>y:Thing</b:Comment></b:Type></root>');
    assert.notStrictEqual(stableElement(aliasA.root.children[0] as import('../../../src/compareMerge/xml/xmlDom').XmlElement), stableElement(aliasB.root.children[0] as import('../../../src/compareMerge/xml/xmlDom').XmlElement), 'only xsi:type and typed Type member QName values are canonicalized; arbitrary Comment text remains lexical');

    const sameAliasA = parseXmlDocument('<root xmlns:a="http://v8.1c.ru/8.1/data/core" xmlns:x="http://www.w3.org/2001/XMLSchema" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><a:Type i:type="a:TypeDescription"><a:Type>x:Thing</a:Type></a:Type></root>');
    const sameAliasB = parseXmlDocument('<root xmlns:b="http://v8.1c.ru/8.1/data/core" xmlns:y="http://www.w3.org/2001/XMLSchema" xmlns:j="http://www.w3.org/2001/XMLSchema-instance"><b:Type j:type="b:TypeDescription"><b:Type>y:Thing</b:Type></b:Type></root>');
    assert.strictEqual(stableElement(sameAliasA.root.children[0] as import('../../../src/compareMerge/xml/xmlDom').XmlElement), stableElement(sameAliasB.root.children[0] as import('../../../src/compareMerge/xml/xmlDom').XmlElement), 'equivalent expanded names and typed QName values compare equal across prefixes');
  });

  test('preserves whitespace-only leaf text in logical equality', () => {
    const whitespace = parseXmlDocument('<root><Comment> </Comment></root>');
    const empty = parseXmlDocument('<root><Comment></Comment></root>');
    assert.notStrictEqual(stableElement(whitespace.root), stableElement(empty.root), 'space is a property value, not ignorable indentation');
  });

  test('keeps changed foreign same-local opaque properties out of the logical projection', () => {
    const baseXml = descriptor({ uuid: BASE_UUID, extraProperties: '<Opaque marker="base">Base value</Opaque>' });
    const result = projectAdoptedDesignerPair(makeInput({
      direction: 'adopted-to-cf',
      targetXml: baseXml,
      baseXml,
      sourceXml: descriptor({ uuid: CFE_UUID, adopted: true, extraProperties: '<vendor:Opaque marker="changed">Changed value</vendor:Opaque>' }),
    }));

    assert.strictEqual(result.ok, true);
    if (!result.ok) { return; }
    assert.match(result.sourceXml.toString('utf8'), /<Opaque marker="base">Base value<\/Opaque>/u);
    assert.doesNotMatch(result.sourceXml.toString('utf8'), /Changed value/u);
    assert.ok(result.issues.some((issue) => issue.propertyName === 'Opaque' && /namespace/u.test(issue.reason)));
  });

  test('projects inline adopted children by exact type and anchor, preserving base UUID and GeneratedType', () => {
    const input = makeInput({
      direction: 'adopted-to-cf',
      sourceXml: descriptor({
        uuid: CFE_UUID,
        adopted: true,
        comment: 'Extension root',
        propertyState: 'Notify',
        childObjects: [adoptedChild({ comment: 'Extension child' })],
      }),
    });

    const result = projectAdoptedDesignerPair(input);

    assert.strictEqual(result.ok, true, result.ok ? undefined : result.reason);
    if (!result.ok) { return; }
    assert.match(result.sourceXml.toString('utf8'), new RegExp(`<Catalog uuid="${BASE_UUID}"`));
    assert.match(result.sourceXml.toString('utf8'), /<Comment(?:\s[^>]*)?>Extension root<\/Comment>/u);
    assert.match(result.sourceXml.toString('utf8'), new RegExp(`<Dimension uuid="${CHILD_UUID}"`));
    assert.match(result.sourceXml.toString('utf8'), /<Comment(?:\s[^>]*)?>Extension child<\/Comment>/u);
    assert.match(result.sourceXml.toString('utf8'), /<xr:GeneratedType name="DimensionRef" uuid="dimension-generated"\/>/u);
    assert.doesNotMatch(result.sourceXml.toString('utf8'), /ObjectBelonging|ExtendedConfigurationObject|PropertyState/u);
    assert.deepStrictEqual(result.issues, []);
  });

  test('keeps a same-name child with the wrong anchor unchanged and reports only that child', () => {
    const input = makeInput({
      direction: 'adopted-to-cf',
      sourceXml: descriptor({
        uuid: CFE_UUID,
        adopted: true,
        childObjects: [adoptedChild({ anchorUuid: '99999999-9999-4999-8999-999999999999', comment: 'Must not map by name' })],
      }),
    });

    const result = projectAdoptedDesignerPair(input);

    assert.strictEqual(result.ok, true);
    if (!result.ok) { return; }
    assert.match(result.sourceXml.toString('utf8'), /<Comment>Base child<\/Comment>/u);
    assert.doesNotMatch(result.sourceXml.toString('utf8'), /Must not map by name/u);
    assert.strictEqual(result.issues.length, 1);
    assert.strictEqual(result.issues[0]?.identityKey, `uuid=${'99999999-9999-4999-8999-999999999999'}`);
  });

  test('does not consume foreign-namespace Properties, markers, or ChildObjects lookalikes', () => {
    let sourceXml = descriptor({
      uuid: CFE_UUID,
      adopted: true,
      extraProperties: '<vendor:Comment>spoof value</vendor:Comment><vendor:ObjectBelonging>Own</vendor:ObjectBelonging>',
    }).toString('utf8');
    sourceXml = sourceXml.replace('</Properties>', '</Properties><vendor:Properties><vendor:Comment>second spoof</vendor:Comment></vendor:Properties>');
    sourceXml = sourceXml.replace('</Catalog>', '<vendor:ChildObjects><vendor:Dimension uuid="spoof-child"/></vendor:ChildObjects></Catalog>');
    const result = projectAdoptedDesignerPair(makeInput({ direction: 'adopted-to-cf', sourceXml: Buffer.from(sourceXml) }));

    assert.strictEqual(result.ok, true);
    if (!result.ok) { return; }
    assert.match(result.sourceXml.toString('utf8'), /<Comment(?:\s[^>]*)?>Base comment<\/Comment>/u);
    assert.doesNotMatch(result.sourceXml.toString('utf8'), /spoof value|second spoof|spoof-child/u);
    assert.ok(result.issues.some((issue) => issue.propertyName === 'Comment'));
    assert.ok(result.issues.some((issue) => /postоронний|посторонний/u.test(issue.reason)));
  });

  test('preserves registered Form references inside ChildObjects without treating them as inline metadata children', () => {
    const formRegistration = '<Form>ManagedForm</Form>';
    const baseXml = descriptor({ uuid: BASE_UUID, childObjects: [formRegistration] });
    const input = makeInput({
      direction: 'cf-to-adopted',
      baseXml,
      targetXml: descriptor({ uuid: CFE_UUID, adopted: true, childObjects: [formRegistration] }),
      sourceXml: baseXml,
    });

    const projection = projectAdoptedDesignerPair(input);

    assert.strictEqual(projection.ok, true, projection.ok ? undefined : projection.reason);
    if (!projection.ok) { return; }
    assert.deepStrictEqual(projection.issues, []);
    assert.match(projection.targetXml.toString('utf8'), /<Form>ManagedForm<\/Form>/u);

    const materialized = materializeAdoptedDesignerTarget({ ...input, mergedLogicalTarget: projection.targetXml });
    assert.strictEqual(materialized.ok, true, materialized.ok ? undefined : materialized.reason);
    if (!materialized.ok) { return; }
    assert.match(materialized.content.toString('utf8'), /<Form>ManagedForm<\/Form>/u);
  });

  test('rejects namespace-spoofed descriptor roots and ownership identities', () => {
    const foreignRoot = Buffer.from(descriptor({ uuid: CFE_UUID, adopted: true }).toString('utf8')
      .replace('<MetaDataObject ', '<vendor:MetaDataObject ')
      .replace('</MetaDataObject>', '</vendor:MetaDataObject>'));
    const rootResult = projectAdoptedDesignerPair(makeInput({ direction: 'adopted-to-cf', sourceXml: foreignRoot }));
    assert.strictEqual(rootResult.ok, false);
    if (!rootResult.ok) { assert.match(rootResult.reason, /MetaDataObject/u); }

    const spoofedMarker = Buffer.from(descriptor({ uuid: CFE_UUID, adopted: true }).toString('utf8')
      .replace('<ObjectBelonging>Adopted</ObjectBelonging>', '<vendor:ObjectBelonging>Adopted</vendor:ObjectBelonging>'));
    const markerResult = projectAdoptedDesignerPair(makeInput({ direction: 'adopted-to-cf', sourceXml: spoofedMarker }));
    assert.strictEqual(markerResult.ok, false);
    if (!markerResult.ok) { assert.match(markerResult.reason, /ObjectBelonging/u); }

    const spoofedUuid = Buffer.from(descriptor({ uuid: CFE_UUID, adopted: true }).toString('utf8')
      .replace(`uuid="${CFE_UUID}"`, `vendor:uuid="${CFE_UUID}"`));
    const uuidResult = projectAdoptedDesignerPair(makeInput({ direction: 'adopted-to-cf', sourceXml: spoofedUuid }));
    assert.strictEqual(uuidResult.ok, false);
    if (!uuidResult.ok) { assert.match(uuidResult.reason, /Identity descriptor/u); }
  });

  test('materializes only selected CF-to-CFE property changes and preserves target identity and unknown overlay data', () => {
    const input = makeInput({
      direction: 'cf-to-adopted',
      targetXml: descriptor({
        uuid: CFE_UUID,
        adopted: true,
        comment: 'Target overlay',
        propertyState: 'Notify',
        extraProperties: '<ExtensionOnly>keep me</ExtensionOnly><VendorExtension marker="keep"/>',
      }),
      sourceXml: descriptor({ uuid: BASE_UUID, comment: 'Source value' }),
    });
    const projection = projectAdoptedDesignerPair(input);
    assert.strictEqual(projection.ok, true, projection.ok ? undefined : projection.reason);
    if (!projection.ok) { return; }
    const mergedLogicalTarget = Buffer.from(replaceComment(projection.targetXml.toString('utf8'), 'Target overlay', 'Selected value'));

    const materialized = materializeAdoptedDesignerTarget({ ...input, mergedLogicalTarget });

    assert.strictEqual(materialized.ok, true);
    if (!materialized.ok) { return; }
    const xml = materialized.content.toString('utf8');
    assert.match(xml, new RegExp(`<Catalog uuid="${CFE_UUID}"`));
    assert.match(xml, /<Comment(?:\s[^>]*)?>Selected value<\/Comment>/u);
    assert.match(xml, /<ExtensionOnly>keep me<\/ExtensionOnly>/u);
    assert.match(xml, /<VendorExtension marker="keep"\/>/u);
    assert.match(xml, /<xr:State>Notify<\/xr:State>/u);
    assert.match(xml, new RegExp(`<xr:GeneratedType name="CatalogRef" uuid="${BASE_UUID}"\/>`));
  });

  test('updates an adopted child only through its existing local identity and preserves same-name foreign XML', () => {
    const targetXml = descriptor({
      uuid: CFE_UUID,
      adopted: true,
      childObjects: [adoptedChild({ comment: 'Target child' })],
      extraProperties: '<vendor:Comment>vendor keep</vendor:Comment>',
    });
    const sourceXml = descriptor({ uuid: BASE_UUID, childObjects: [baseChild('Source child')] });
    const input = makeInput({ direction: 'cf-to-adopted', targetXml, sourceXml });
    const projection = projectAdoptedDesignerPair(input);
    assert.strictEqual(projection.ok, true);
    if (!projection.ok) { return; }
    const logical = projection.targetXml.toString('utf8').replace('Base comment', 'Selected root comment').replace('Target child', 'Selected child');
    assert.match(logical, /<Comment(?:\s[^>]*)?>Selected child<\/Comment>/u);

    const result = materializeAdoptedDesignerTarget({ ...input, mergedLogicalTarget: Buffer.from(logical) });

    assert.strictEqual(result.ok, true, result.ok ? undefined : result.reason);
    if (!result.ok) { return; }
    const xml = result.content.toString('utf8');
    assert.match(xml, new RegExp(`<Dimension uuid="${CHILD_LOCAL_UUID}"`));
    assert.match(xml, new RegExp(`<ExtendedConfigurationObject>${CHILD_UUID}</ExtendedConfigurationObject>`));
    assert.match(xml, /<Comment(?:\s[^>]*)?>Selected child<\/Comment>/u);
    assert.match(xml, /<xr:State>Notify<\/xr:State>/u);
    assert.match(xml, /<vendor:Comment>vendor keep<\/vendor:Comment>/u);
    assert.ok(projection.issues.some((issue) => issue.propertyName === 'Comment'));
  });

  test('blocks creating a new adopted child overlay without a captured target-local UUID', () => {
    const targetXml = descriptor({ uuid: CFE_UUID, adopted: true, childObjects: [] });
    const sourceXml = descriptor({ uuid: BASE_UUID, childObjects: [baseChild('Selected child')] });
    const input = makeInput({ direction: 'cf-to-adopted', targetXml, sourceXml });
    const projection = projectAdoptedDesignerPair(input);
    assert.strictEqual(projection.ok, true);
    if (!projection.ok) { return; }

    const result = materializeAdoptedDesignerTarget({ ...input, mergedLogicalTarget: projection.sourceXml });

    assert.strictEqual(result.ok, false);
    if (!result.ok) { assert.match(result.reason, /локальн[а-яё]+ UUID child/iu); }
  });

  test('collects stable root and nested UUID requirements for absent adopted child overlays', () => {
    const nested = nestedBaseChild('Base nested child');
    const input = makeInput({
      direction: 'cf-to-adopted',
      targetXml: descriptor({ uuid: CFE_UUID, adopted: true, childObjects: [] }),
      sourceXml: descriptor({ uuid: BASE_UUID, childObjects: [nested] }),
      baseXml: descriptor({ uuid: BASE_UUID, childObjects: [nested] }),
    });

    const result = collectAdoptedDesignerChildUuidRequirements(input);

    assert.strictEqual(result.ok, true);
    if (!result.ok) { return; }
    assert.deepStrictEqual(result.requirements, [
      {
        mapKey: adoptedChildUuidMapKey('root=Catalog.Products', 'TabularSection', CHILD_UUID),
        parentScope: 'root=Catalog.Products',
        type: 'TabularSection',
        anchorUuid: CHILD_UUID,
      },
      {
        mapKey: adoptedChildUuidMapKey(`uuid=${CHILD_UUID.toLowerCase()}`, 'Attribute', NESTED_CHILD_UUID),
        parentScope: `uuid=${CHILD_UUID.toLowerCase()}`,
        type: 'Attribute',
        anchorUuid: NESTED_CHILD_UUID,
      },
    ]);
  });

  test('materializes newly adopted children with preallocated UUIDs and preserves inherited GeneratedType identity', () => {
    const input = makeInput({
      direction: 'cf-to-adopted',
      targetXml: descriptor({ uuid: CFE_UUID, adopted: true, childObjects: [] }),
      sourceXml: descriptor({ uuid: BASE_UUID, childObjects: [baseChild('Selected child')] }),
    });
    const requirement = collectAdoptedDesignerChildUuidRequirements(input);
    assert.strictEqual(requirement.ok, true);
    if (!requirement.ok) { return; }
    const allocated = new Map([[requirement.requirements[0]!.mapKey, NEW_CHILD_LOCAL_UUID]]);
    const projection = projectAdoptedDesignerPair({ ...input, adoptedChildUuidByAnchor: allocated });
    assert.strictEqual(projection.ok, true);
    if (!projection.ok) { return; }
    const materializationInput = { ...input, adoptedChildUuidByAnchor: allocated, mergedLogicalTarget: projection.sourceXml };

    const first = materializeAdoptedDesignerTarget(materializationInput);
    const second = materializeAdoptedDesignerTarget(materializationInput);

    assert.strictEqual(first.ok, true, first.ok ? undefined : first.reason);
    assert.strictEqual(second.ok, true, second.ok ? undefined : second.reason);
    if (!first.ok || !second.ok) { return; }
    assert.deepStrictEqual(second.content, first.content, 'same captured allocation produces stable repeated output');
    const xml = first.content.toString('utf8');
    assert.match(xml, new RegExp(`<Dimension uuid="${NEW_CHILD_LOCAL_UUID}"`));
    assert.match(xml, new RegExp(`<ExtendedConfigurationObject>${CHILD_UUID}</ExtendedConfigurationObject>`));
    assert.match(xml, /<ObjectBelonging>Adopted<\/ObjectBelonging>/u);
    assert.match(xml, /<Comment(?:\s[^>]*)?>Selected child<\/Comment>/u);
    assert.match(xml, /<xr:State>Notify<\/xr:State>/u);
    const catalog = direct(parseXmlDocument(xml).root, 'Catalog')[0];
    const childObjects = catalog ? direct(catalog, 'ChildObjects')[0] : undefined;
    const overlay = childObjects && elementChildren(childObjects)
      .find((node) => node.localName === 'Dimension' && node.attributes.some((attribute) => attribute.name === 'uuid' && attribute.value === NEW_CHILD_LOCAL_UUID));
    assert.ok(overlay, 'new adopted child shell is present');
    const overlayChildren = elementChildren(overlay!);
    assert.deepStrictEqual(overlayChildren.slice(0, 2).map((node) => node.localName), ['InternalInfo', 'Properties'], 'native CFE child descriptor order places InternalInfo before Properties');
    assert.match(xml.slice(xml.indexOf(`<Dimension uuid="${NEW_CHILD_LOCAL_UUID}"`)), /<xr:GeneratedType name="DimensionRef" uuid="dimension-generated"\/>/u);
  });

  test('emits new adopted Attribute shells in native InternalInfo-before-Properties order', () => {
    const sourceAttribute = baseAttribute('Source value');
    const input = makeInput({
      direction: 'cf-to-adopted',
      targetXml: descriptor({ uuid: CFE_UUID, adopted: true, childObjects: [] }),
      sourceXml: descriptor({ uuid: BASE_UUID, childObjects: [sourceAttribute] }),
      baseXml: descriptor({ uuid: BASE_UUID, childObjects: [baseAttribute('Base value')] }),
    });
    const requirements = collectAdoptedDesignerChildUuidRequirements(input);
    assert.strictEqual(requirements.ok, true, requirements.ok ? undefined : requirements.reason);
    if (!requirements.ok) { return; }
    const allocations = new Map([[requirements.requirements[0]!.mapKey, NEW_CHILD_LOCAL_UUID]]);
    const projection = projectAdoptedDesignerPair({ ...input, adoptedChildUuidByAnchor: allocations });
    assert.strictEqual(projection.ok, true, projection.ok ? undefined : projection.reason);
    if (!projection.ok) { return; }

    const materialized = materializeAdoptedDesignerTarget({ ...input, adoptedChildUuidByAnchor: allocations, mergedLogicalTarget: projection.sourceXml });

    assert.strictEqual(materialized.ok, true, materialized.ok ? undefined : materialized.reason);
    if (!materialized.ok) { return; }
    assert.match(materialized.content.toString('utf8'), new RegExp(`<Attribute uuid="${NEW_CHILD_LOCAL_UUID}"[^>]*>\\s*<InternalInfo>[\\s\\S]*?<\\/InternalInfo>\\s*<Properties>`));
  });

  test('materializes selected nested adopted children with scope-specific stable UUIDs', () => {
    const base = nestedBaseChild('Base nested child');
    const source = nestedBaseChild('Selected nested child');
    const input = makeInput({
      direction: 'cf-to-adopted',
      targetXml: descriptor({ uuid: CFE_UUID, adopted: true, childObjects: [] }),
      sourceXml: descriptor({ uuid: BASE_UUID, childObjects: [source] }),
      baseXml: descriptor({ uuid: BASE_UUID, childObjects: [base] }),
    });
    const requirements = collectAdoptedDesignerChildUuidRequirements(input);
    assert.strictEqual(requirements.ok, true);
    if (!requirements.ok) { return; }
    const allocations = new Map(requirements.requirements.map((item) => [
      item.mapKey,
      item.type === 'TabularSection' ? NEW_CHILD_LOCAL_UUID : NESTED_CHILD_LOCAL_UUID,
    ]));
    const projection = projectAdoptedDesignerPair({ ...input, adoptedChildUuidByAnchor: allocations });
    assert.strictEqual(projection.ok, true);
    if (!projection.ok) { return; }
    const selected = Buffer.from(projection.targetXml.toString('utf8').replace('Base nested child', 'Selected nested child'));

    const result = materializeAdoptedDesignerTarget({ ...input, adoptedChildUuidByAnchor: allocations, mergedLogicalTarget: selected });

    assert.strictEqual(result.ok, true, result.ok ? undefined : result.reason);
    if (!result.ok) { return; }
    const xml = result.content.toString('utf8');
    assert.match(xml, new RegExp(`<TabularSection uuid="${NEW_CHILD_LOCAL_UUID}"`));
    assert.match(xml, new RegExp(`<Attribute uuid="${NESTED_CHILD_LOCAL_UUID}"`));
    assert.match(xml, new RegExp(`<ExtendedConfigurationObject>${CHILD_UUID}</ExtendedConfigurationObject>`));
    assert.match(xml, new RegExp(`<ExtendedConfigurationObject>${NESTED_CHILD_UUID}</ExtendedConfigurationObject>`));
    assert.match(xml, /<Comment(?:\s[^>]*)?>Selected nested child<\/Comment>/u);
    const nestedOverlay = xml.slice(xml.indexOf(`<Attribute uuid="${NESTED_CHILD_LOCAL_UUID}"`));
    assert.match(nestedOverlay, /<xr:GeneratedType name="ItemRef" uuid="item-generated"\/>/u,
      'nested borrowed shells must preserve their inherited GeneratedType identity');

    const duplicateAllocation = new Map(requirements.requirements.map((item) => [item.mapKey, NEW_CHILD_LOCAL_UUID]));
    const collision = materializeAdoptedDesignerTarget({ ...input, adoptedChildUuidByAnchor: duplicateAllocation, mergedLogicalTarget: selected });
    assert.strictEqual(collision.ok, false, 'distinct required anchors cannot share one local UUID');
  });

  test('adds a new own nested Attribute under an adopted TabularSection without base or overlay ChildObjects', () => {
    const baseTable = bareTabularSection();
    const selectedTable = bareTabularSection(`<ChildObjects>${ownNestedAttribute()}</ChildObjects>`);
    const input = makeInput({
      direction: 'cf-to-adopted',
      targetXml: descriptor({ uuid: CFE_UUID, adopted: true, childObjects: [] }),
      baseXml: descriptor({ uuid: BASE_UUID, childObjects: [baseTable] }),
      sourceXml: descriptor({ uuid: BASE_UUID, childObjects: [selectedTable] }),
    });
    const requirements = collectAdoptedDesignerChildUuidRequirements(input);
    assert.strictEqual(requirements.ok, true, requirements.ok ? undefined : requirements.reason);
    if (!requirements.ok) { return; }
    assert.strictEqual(requirements.requirements.length, 1, 'only the borrowed TabularSection needs a host local UUID');
    const allocations = new Map([[requirements.requirements[0]!.mapKey, NEW_CHILD_LOCAL_UUID]]);
    const projection = projectAdoptedDesignerPair({ ...input, adoptedChildUuidByAnchor: allocations });
    assert.strictEqual(projection.ok, true, projection.ok ? undefined : projection.reason);
    if (!projection.ok) { return; }

    const result = materializeAdoptedDesignerTarget({
      ...input,
      adoptedChildUuidByAnchor: allocations,
      mergedLogicalTarget: projection.sourceXml,
    });

    assert.strictEqual(result.ok, true, result.ok ? undefined : result.reason);
    if (!result.ok) { return; }
    const xml = result.content.toString('utf8');
    assert.match(xml, new RegExp(`<TabularSection uuid="${NEW_CHILD_LOCAL_UUID}"`));
    assert.match(xml, new RegExp(`<ExtendedConfigurationObject>${CHILD_UUID}</ExtendedConfigurationObject>`));
    assert.match(xml, new RegExp(`<Attribute uuid="${NESTED_OWN_CHILD_UUID}"`));
    assert.match(xml, /<Name>N335_NewLineField<\/Name>/u);
    assert.match(xml, /<Comment>Selected nested own field<\/Comment>/u);
    assert.doesNotMatch(xml.slice(xml.indexOf(`<Attribute uuid="${NESTED_OWN_CHILD_UUID}"`)), /ObjectBelonging|ExtendedConfigurationObject/u,
      'the new nested field is a local child, not an adopted child overlay');
    assert.match(xml, /<ChildObjects>[\s\S]*<Attribute uuid="88888888-8888-4888-8888-888888888888"/u,
      'the selected own child is encoded inside a synthesized nested ChildObjects container');
  });

  test('blocks preallocated child UUIDs that are malformed, equal to the anchor, or collide with target identities', () => {
    const input = makeInput({
      direction: 'cf-to-adopted',
      targetXml: descriptor({ uuid: CFE_UUID, adopted: true, childObjects: [] }),
      sourceXml: descriptor({ uuid: BASE_UUID, childObjects: [baseChild('Selected child')] }),
    });
    const requirements = collectAdoptedDesignerChildUuidRequirements(input);
    assert.strictEqual(requirements.ok, true);
    if (!requirements.ok) { return; }
    const mapKey = requirements.requirements[0]!.mapKey;
    const projection = projectAdoptedDesignerPair(input);
    assert.strictEqual(projection.ok, true);
    if (!projection.ok) { return; }
    const mergedLogicalTarget = projection.sourceXml;
    for (const uuid of ['not-a-uuid', CHILD_UUID, CFE_UUID]) {
      const result = materializeAdoptedDesignerTarget({
        ...input,
        adoptedChildUuidByAnchor: new Map([[mapKey, uuid]]),
        mergedLogicalTarget,
      });
      assert.strictEqual(result.ok, false, `allocation ${uuid} must be blocked`);
    }
  });

  test('preserves an adopted child shell and unselected Type wrapper when reverting the last selected property', () => {
    const baseType = '<Type><v8:Type>xs:string</v8:Type><v8:StringQualifiers><v8:Length>10</v8:Length><v8:AllowedLength>Fixed</v8:AllowedLength></v8:StringQualifiers></Type>';
    const extensionType = '<Type xsi:type="xr:ExtendedProperty" vendor:keep="yes"><xr:ExtendValue xsi:type="v8:TypeDescription"><v8:Type>xs:string</v8:Type><v8:StringQualifiers><v8:Length>20</v8:Length><v8:AllowedLength>Variable</v8:AllowedLength></v8:StringQualifiers></xr:ExtendValue></Type>';
    const input = makeInput({
      direction: 'cf-to-adopted',
      targetXml: descriptor({
        uuid: CFE_UUID,
        adopted: true,
        childObjects: [`<Dimension uuid="${CHILD_LOCAL_UUID}"><Properties><Name>Size</Name><Comment>Target child</Comment>${extensionType}<ObjectBelonging>Adopted</ObjectBelonging><ExtendedConfigurationObject>${CHILD_UUID}</ExtendedConfigurationObject><vendor:Unknown marker="keep"/></Properties><InternalInfo><xr:PropertyState><xr:Property>Comment</xr:Property><xr:State>Notify</xr:State></xr:PropertyState><xr:PropertyState><xr:Property>Type</xr:Property><xr:State>MultiState</xr:State></xr:PropertyState><xr:PropertyState><xr:Property>Other</xr:Property><xr:State>Notify</xr:State></xr:PropertyState></InternalInfo></Dimension>`],
      }),
      baseXml: descriptor({ uuid: BASE_UUID, childObjects: [baseChild('Base child').replace('</Properties>', `${baseType}</Properties>`)] }),
    });
    const projected = projectAdoptedDesignerPair(input);
    assert.strictEqual(projected.ok, true);
    if (!projected.ok) { return; }
    const logical = projected.targetXml.toString('utf8').replace('Target child', 'Base child');
    const result = materializeAdoptedDesignerTarget({ ...input, mergedLogicalTarget: Buffer.from(logical) });

    assert.strictEqual(result.ok, true, result.ok ? undefined : result.reason);
    if (!result.ok) { return; }
    const xml = result.content.toString('utf8');
    assert.match(xml, new RegExp(`<Dimension uuid="${CHILD_LOCAL_UUID}"`));
    assert.match(xml, new RegExp(`<ExtendedConfigurationObject>${CHILD_UUID}</ExtendedConfigurationObject>`));
    assert.match(xml, /<vendor:Unknown marker="keep"\/>/u);
    assert.match(xml, /<xr:Property>Type<\/xr:Property><xr:State>MultiState<\/xr:State>/u);
    assert.match(xml, /<xr:Property>Other<\/xr:Property><xr:State>Notify<\/xr:State>/u);
    assert.match(xml, /<Type xsi:type="xr:ExtendedProperty" vendor:keep="yes">/u);
  });

  test('reverting the final selected child property keeps the borrowed shell and opaque unselected payload', () => {
    const physicalChild = adoptedChild({ comment: 'Target child' })
      .replace(`<Dimension uuid="${CHILD_LOCAL_UUID}">`, `<Dimension uuid="${CHILD_LOCAL_UUID}" vendor:identity="keep">`)
      .replace('</Properties>', '<vendor:Opaque marker="keep"/></Properties>');
    const input = makeInput({
      direction: 'cf-to-adopted',
      targetXml: descriptor({ uuid: CFE_UUID, adopted: true, childObjects: [physicalChild] }),
    });
    const projection = projectAdoptedDesignerPair(input);
    assert.strictEqual(projection.ok, true);
    if (!projection.ok) { return; }
    const selected = Buffer.from(projection.targetXml.toString('utf8').replace('Target child', 'Base child'));

    const result = materializeAdoptedDesignerTarget({ ...input, mergedLogicalTarget: selected });

    assert.strictEqual(result.ok, true, result.ok ? undefined : result.reason);
    if (!result.ok) { return; }
    const xml = result.content.toString('utf8');
    assert.match(xml, new RegExp(`<Dimension uuid="${CHILD_LOCAL_UUID}" vendor:identity="keep"[^>]*>`));
    assert.match(xml, new RegExp(`<ExtendedConfigurationObject>${CHILD_UUID}</ExtendedConfigurationObject>`));
    assert.match(xml, /<vendor:Opaque marker="keep"\/>/u);
    assert.doesNotMatch(xml, /<Comment>Target child<\/Comment>/u);
    assert.doesNotMatch(xml, /<xr:Property>Comment<\/xr:Property>/u);
  });

  test('rejects inherited child deletion instead of treating it as an overlay revert', () => {
    const input = makeInput({
      direction: 'cf-to-adopted',
      targetXml: descriptor({ uuid: CFE_UUID, adopted: true, childObjects: [adoptedChild({ comment: 'Target child' })] }),
      sourceXml: descriptor({ uuid: BASE_UUID, childObjects: [] }),
    });
    const projection = projectAdoptedDesignerPair(input);
    assert.strictEqual(projection.ok, true);
    if (!projection.ok) { return; }
    const result = materializeAdoptedDesignerTarget({ ...input, mergedLogicalTarget: projection.sourceXml });
    assert.strictEqual(result.ok, false);
    if (!result.ok) { assert.match(result.reason, /Удаление унаследованного child/u); }
  });

  test('removes a selected override and only its PropertyState when it again equals base', () => {
    const input = makeInput({
      direction: 'cf-to-adopted',
      targetXml: descriptor({ uuid: CFE_UUID, adopted: true, comment: 'Target override', propertyState: 'Notify', extraProperties: '<VendorExtension>keep</VendorExtension>' }),
    });
    const projection = projectAdoptedDesignerPair(input);
    assert.strictEqual(projection.ok, true, projection.ok ? undefined : projection.reason);
    if (!projection.ok) { return; }
    const mergedLogicalTarget = Buffer.from(replaceComment(projection.targetXml.toString('utf8'), 'Target override', 'Base comment'));

    const result = materializeAdoptedDesignerTarget({ ...input, mergedLogicalTarget });

    assert.strictEqual(result.ok, true, result.ok ? undefined : result.reason);
    if (!result.ok) { return; }
    const xml = result.content.toString('utf8');
    assert.doesNotMatch(xml, /<Comment>Target override<\/Comment>/u);
    assert.doesNotMatch(xml, /<xr:Property>Comment<\/xr:Property>/u);
    assert.match(xml, /<VendorExtension>keep<\/VendorExtension>/u);
  });

  test('uses PropertyState MultiState to flatten ExtendedProperty with capacity-based Number union', () => {
    const baseType = '<Type><v8:Type>xs:decimal</v8:Type><v8:NumberQualifiers><v8:Digits>12</v8:Digits><v8:FractionDigits>2</v8:FractionDigits><v8:AllowedSign>Nonnegative</v8:AllowedSign></v8:NumberQualifiers></Type>';
    const extensionType = '<Type xsi:type="xr:ExtendedProperty"><xr:ExtendValue xsi:type="v8:TypeDescription"><v8:Type>xs:string</v8:Type><v8:NumberQualifiers><v8:Digits>15</v8:Digits><v8:FractionDigits>4</v8:FractionDigits><v8:AllowedSign>Any</v8:AllowedSign></v8:NumberQualifiers></xr:ExtendValue></Type>';
    const input = makeInput({
      direction: 'adopted-to-cf',
      baseXml: descriptor({ uuid: BASE_UUID, type: baseType }),
      targetXml: descriptor({ uuid: BASE_UUID, type: baseType }),
      sourceXml: descriptor({ uuid: CFE_UUID, adopted: true, type: extensionType, propertyState: 'MultiState' }),
    });

    const result = projectAdoptedDesignerPair(input);

    assert.strictEqual(result.ok, true);
    if (!result.ok) { return; }
    assert.match(result.sourceXml.toString('utf8'), /<v8:Type(?:\s[^>]*)?>xs:decimal<\/v8:Type>[\s\S]*?<v8:Type(?:\s[^>]*)?>xs:string<\/v8:Type>/u);
    assert.match(result.sourceXml.toString('utf8'), /<v8:Digits(?:\s[^>]*)?>15<\/v8:Digits>/u, 'integer capacity 10 vs 11 and fraction 4 yields 15 digits');
    assert.match(result.sourceXml.toString('utf8'), /<v8:FractionDigits(?:\s[^>]*)?>4<\/v8:FractionDigits>/u);
    assert.match(result.sourceXml.toString('utf8'), /<v8:AllowedSign(?:\s[^>]*)?>Any<\/v8:AllowedSign>/u);
  });

  test('resolves native TypeId members through captured GeneratedType descriptors and reports witnesses', () => {
    const baseType = '<Type><v8:Type xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config">cfg:DocumentRef.ДокументТестРаботает</v8:Type></Type>';
    const extensionType = '<Type xsi:type="xr:ExtendedProperty"><xr:ExtendValue xsi:type="v8:TypeDescription"><v8:TypeId>88888888-8888-4888-8888-888888888888</v8:TypeId><v8:TypeId>99999999-9999-4999-8999-999999999999</v8:TypeId></xr:ExtendValue></Type>';
    const documentRef = generatedTypeReference({
      type: 'Document', name: 'ДокументТестРаботает', uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      generatedName: 'DocumentRef.ДокументТестРаботает', category: 'Ref', typeId: '88888888-8888-4888-8888-888888888888',
      relativePath: 'Documents/ДокументТестРаботает.xml',
    });
    const definedType = generatedTypeReference({
      type: 'DefinedType', name: 'MyLink', uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      generatedName: 'DefinedType.MyLink', category: 'DefinedType', typeId: '99999999-9999-4999-8999-999999999999',
      relativePath: 'DefinedTypes/MyLink.xml',
    });
    const input = withTypeIdReferences(makeInput({
      direction: 'adopted-to-cf',
      baseXml: descriptor({ uuid: BASE_UUID, type: baseType }),
      targetXml: descriptor({ uuid: BASE_UUID, type: baseType }),
      sourceXml: descriptor({ uuid: CFE_UUID, adopted: true, type: extensionType, propertyState: 'MultiState' }),
    }), [documentRef, definedType]);

    const result = projectAdoptedDesignerPair(input);

    assert.strictEqual(result.ok, true);
    if (!result.ok) { return; }
    assert.deepStrictEqual(result.issues, []);
    const catalog = elementChildren(parseXmlDocument(result.sourceXml.toString('utf8')).root)[0]!;
    const flattened = direct(catalog, 'Properties')[0]!;
    const type = direct(flattened, 'Type')[0]!;
    const members = elementChildren(type).filter((element) => element.localName === 'Type');
    assert.deepStrictEqual(members.map((member) => member.children.filter((child) => child.kind === 'text').map((child) => child.text).join('')),
      ['cfg:DocumentRef.ДокументТестРаботает', 'cfg:DefinedType.MyLink'],
      'the actual native TypeId representation resolves by exact explicit GeneratedType profiles, including a non-Ref profile');
    assert.strictEqual(result.usedDescriptorWitnesses.length, 2);
    assert.deepStrictEqual(result.usedDescriptorWitnesses.map(({ relativePath }) => relativePath).sort(), [
      'DefinedTypes/MyLink.xml', 'Documents/ДокументТестРаботает.xml',
    ]);
    assert.doesNotMatch(result.sourceXml.toString('utf8'), /<v8:TypeId>/u);
  });

  test('resolves exact own CFE GeneratedType witnesses with ObjectBelonging=Own and rejects other ownership markers', () => {
    const baseType = '<Type><v8:Type>xs:string</v8:Type></Type>';
    const extensionType = '<Type xsi:type="xr:ExtendedProperty"><xr:ExtendValue xsi:type="v8:TypeDescription"><v8:TypeId>88888888-8888-4888-8888-888888888888</v8:TypeId></xr:ExtendValue></Type>';
    const baseInput = makeInput({
      direction: 'adopted-to-cf',
      baseXml: descriptor({ uuid: BASE_UUID, type: baseType }),
      targetXml: descriptor({ uuid: BASE_UUID, type: baseType }),
      sourceXml: descriptor({ uuid: CFE_UUID, adopted: true, type: extensionType, propertyState: 'MultiState' }),
    });
    const reference = generatedTypeReference({
      type: 'Document', name: 'ДокументТестРаботает', uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      generatedName: 'DocumentRef.ДокументТестРаботает', category: 'Ref', typeId: '88888888-8888-4888-8888-888888888888',
      relativePath: 'Documents/ДокументТестРаботает.xml',
    });
    const withOwnership = (marker: string) => {
      const descriptorXml = Buffer.from(reference.descriptorXml.toString('utf8').replace('</Name>', `</Name>${marker}`));
      return { ...reference, descriptorXml, expectedHash: createHash('sha256').update(descriptorXml).digest('hex'), provenance: 'own' as const };
    };

    const valid = projectAdoptedDesignerPair(withTypeIdReferences(baseInput, [withOwnership('<ObjectBelonging>Own</ObjectBelonging>')]));

    assert.strictEqual(valid.ok, true);
    if (!valid.ok) { return; }
    assert.deepStrictEqual(valid.issues, [], 'a captured own CFE object with the explicit Own marker resolves its GeneratedType');
    assert.match(valid.sourceXml.toString('utf8'), /cfg:DocumentRef\.ДокументТестРаботает/u);
    assert.deepStrictEqual(valid.usedDescriptorWitnesses.map(({ relativePath }) => relativePath), ['Documents/ДокументТестРаботает.xml']);

    const invalidDescriptors = [
      withOwnership(`<ObjectBelonging>Adopted</ObjectBelonging><ExtendedConfigurationObject>${BASE_UUID}</ExtendedConfigurationObject>`),
      withOwnership('<ObjectBelonging>Own</ObjectBelonging><ObjectBelonging>Own</ObjectBelonging>'),
      withOwnership('<vendor:ObjectBelonging xmlns:vendor="urn:vendor">Own</vendor:ObjectBelonging>'),
    ];
    for (const invalid of invalidDescriptors) {
      const result = projectAdoptedDesignerPair(withTypeIdReferences(baseInput, [invalid]));
      assert.strictEqual(result.ok, true);
      if (!result.ok) { continue; }
      assert.strictEqual(result.issues.length, 1);
      assert.strictEqual(result.issues[0]?.propertyName, 'Type');
      assert.match(result.issues[0]?.reason ?? '', /собственн|ObjectBelonging|ExtendedConfigurationObject|namespace|marker/iu);
    }
  });

  test('deduplicates a TypeId against an equivalent aliased current-configuration QName', () => {
    const baseType = '<Type><v8:Type xmlns:own="http://v8.1c.ru/8.1/data/enterprise/current-config">own:DocumentRef.ДокументТестРаботает</v8:Type></Type>';
    const extensionType = '<Type xsi:type="xr:ExtendedProperty"><xr:ExtendValue xsi:type="v8:TypeDescription"><v8:TypeId>88888888-8888-4888-8888-888888888888</v8:TypeId></xr:ExtendValue></Type>';
    const reference = generatedTypeReference({
      type: 'Document', name: 'ДокументТестРаботает', uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      generatedName: 'DocumentRef.ДокументТестРаботает', category: 'Ref', typeId: '88888888-8888-4888-8888-888888888888',
      relativePath: 'Documents/ДокументТестРаботает.xml',
    });
    const input = withTypeIdReferences(makeInput({
      direction: 'adopted-to-cf',
      baseXml: descriptor({ uuid: BASE_UUID, type: baseType }),
      targetXml: descriptor({ uuid: BASE_UUID, type: baseType }),
      sourceXml: descriptor({ uuid: CFE_UUID, adopted: true, type: extensionType, propertyState: 'MultiState' }),
    }), [reference]);

    const result = projectAdoptedDesignerPair(input);

    assert.strictEqual(result.ok, true);
    if (!result.ok) { return; }
    assert.deepStrictEqual(result.issues, []);
    const catalog = elementChildren(parseXmlDocument(result.sourceXml.toString('utf8')).root)[0]!;
    const properties = direct(catalog, 'Properties')[0]!;
    const type = direct(properties, 'Type')[0]!;
    assert.strictEqual(elementChildren(type).filter((element) => element.localName === 'Type').length, 1);
    assert.strictEqual(result.usedDescriptorWitnesses.length, 1);
  });

  test('reports only the affected Type for duplicate, stale, or foreign GeneratedType witnesses', () => {
    const baseType = '<Type><v8:Type>xs:string</v8:Type></Type>';
    const extensionType = '<Type xsi:type="xr:ExtendedProperty"><xr:ExtendValue xsi:type="v8:TypeDescription"><v8:TypeId>88888888-8888-4888-8888-888888888888</v8:TypeId></xr:ExtendValue></Type>';
    const first = generatedTypeReference({
      type: 'Document', name: 'ДокументТестРаботает', uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      generatedName: 'DocumentRef.ДокументТестРаботает', category: 'Ref', typeId: '88888888-8888-4888-8888-888888888888',
      relativePath: 'Documents/ДокументТестРаботает.xml',
    });
    const duplicate = generatedTypeReference({
      type: 'Document', name: 'ДругойДокумент', uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      generatedName: 'DocumentRef.ДругойДокумент', category: 'Ref', typeId: '88888888-8888-4888-8888-888888888888',
      relativePath: 'Documents/ДругойДокумент.xml',
    });
    const baseInput = makeInput({
      direction: 'adopted-to-cf',
      baseXml: descriptor({ uuid: BASE_UUID, type: baseType }),
      targetXml: descriptor({ uuid: BASE_UUID, type: baseType }),
      sourceXml: descriptor({ uuid: CFE_UUID, adopted: true, type: extensionType, propertyState: 'MultiState' }),
    });
    const cases = [
      { references: [first, duplicate], expected: /ambiguous|duplicate|несколько|неоднозначен/iu, label: 'duplicate TypeId' },
      { references: [{ ...first, expectedHash: '0'.repeat(64) }], expected: /hash|SHA|witness/iu, label: 'stale descriptor hash' },
      { references: [{ ...first, descriptorXml: Buffer.from(first.descriptorXml.toString('utf8').replace('<xr:GeneratedType ', '<vendor:GeneratedType ')) }], expected: /не найден|GeneratedType|TypeId/iu, label: 'foreign-namespace GeneratedType' },
    ];
    for (const testCase of cases) {
      const result = projectAdoptedDesignerPair(withTypeIdReferences(baseInput, testCase.references));
      assert.strictEqual(result.ok, true, testCase.label);
      if (!result.ok) { continue; }
      assert.strictEqual(result.issues.length, 1, testCase.label);
      assert.strictEqual(result.issues[0]?.propertyName, 'Type', testCase.label);
      assert.match(result.issues[0]?.reason ?? '', testCase.expected, testCase.label);
      assert.match(result.sourceXml.toString('utf8'), /<v8:Type(?:\s[^>]*)?>xs:string<\/v8:Type>/u, `${testCase.label} must preserve the base type`);
      assert.deepStrictEqual(result.usedDescriptorWitnesses, [], `${testCase.label} must not expose invalid witnesses`);
    }
  });

  test('does not validate unused stale TypeId context for an unrelated selected property', () => {
    const reference = generatedTypeReference({
      type: 'Document', name: 'ДокументТестРаботает', uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      generatedName: 'DocumentRef.ДокументТестРаботает', category: 'Ref', typeId: '88888888-8888-4888-8888-888888888888',
      relativePath: 'Documents/ДокументТестРаботает.xml',
    });
    const type = '<Type><v8:Type>xs:string</v8:Type></Type>';
    const input = withTypeIdReferences(makeInput({
      direction: 'adopted-to-cf',
      baseXml: descriptor({ uuid: BASE_UUID, type }),
      targetXml: descriptor({ uuid: BASE_UUID, type }),
      sourceXml: descriptor({ uuid: CFE_UUID, adopted: true, type, comment: 'Selected unrelated comment' }),
    }), [{ ...reference, expectedHash: '0'.repeat(64) }]);

    const result = projectAdoptedDesignerPair(input);

    assert.strictEqual(result.ok, true);
    if (!result.ok) { return; }
    assert.deepStrictEqual(result.issues, []);
    assert.deepStrictEqual(result.usedDescriptorWitnesses, []);
    assert.match(result.sourceXml.toString('utf8'), /Selected unrelated comment/u);
  });

  test('does not treat ExtendedProperty as a Notify replacement or accept malformed PropertyState', () => {
    const baseType = '<Type><v8:Type>xs:decimal</v8:Type></Type>';
    const extended = '<Type xsi:type="xr:ExtendedProperty"><xr:ExtendValue xsi:type="v8:TypeDescription"><v8:Type>xs:string</v8:Type></xr:ExtendValue></Type>';
    const notify = projectAdoptedDesignerPair(makeInput({
      direction: 'adopted-to-cf',
      baseXml: descriptor({ uuid: BASE_UUID, type: baseType }),
      targetXml: descriptor({ uuid: BASE_UUID, type: baseType }),
      sourceXml: descriptor({ uuid: CFE_UUID, adopted: true, type: extended, propertyState: 'Notify' }),
    }));
    assert.strictEqual(notify.ok, true);
    if (notify.ok) {
      assert.strictEqual(notify.issues.length, 1);
      assert.match(notify.sourceXml.toString('utf8'), /<v8:Type(?:\s[^>]*)?>xs:decimal<\/v8:Type>/u);
      assert.doesNotMatch(notify.sourceXml.toString('utf8'), /ExtendedProperty/u);
    }

    const duplicateState = descriptor({ uuid: CFE_UUID, adopted: true, comment: 'Changed', propertyState: 'Notify' })
      .toString('utf8').replace('</InternalInfo>', '<xr:PropertyState><xr:Property>Comment</xr:Property><xr:State>MultiState</xr:State></xr:PropertyState></InternalInfo>');
    const malformed = projectAdoptedDesignerPair(makeInput({ direction: 'adopted-to-cf', sourceXml: Buffer.from(duplicateState) }));
    assert.strictEqual(malformed.ok, true);
    if (malformed.ok) {
      assert.ok(malformed.issues.some((issue) => issue.propertyName === 'Comment' && /PropertyState/u.test(issue.reason)));
      assert.match(malformed.sourceXml.toString('utf8'), /Base comment/u);
      assert.doesNotMatch(malformed.sourceXml.toString('utf8'), /Changed/u);
    }
  });

  test('unions Date and Time qualifiers to DateTime for supported Designer formats', () => {
    const baseType = '<Type><v8:Type>xs:dateTime</v8:Type><v8:DateQualifiers><v8:DateFractions>Date</v8:DateFractions></v8:DateQualifiers></Type>';
    const extensionType = '<Type xsi:type="xr:ExtendedProperty"><xr:ExtendValue xsi:type="v8:TypeDescription"><v8:Type>xs:dateTime</v8:Type><v8:DateQualifiers><v8:DateFractions>Time</v8:DateFractions></v8:DateQualifiers></xr:ExtendValue></Type>';
    const input = makeInput({
      direction: 'adopted-to-cf',
      baseXml: descriptor({ uuid: BASE_UUID, type: baseType }),
      targetXml: descriptor({ uuid: BASE_UUID, type: baseType }),
      sourceXml: descriptor({ uuid: CFE_UUID, adopted: true, type: extensionType, propertyState: 'MultiState' }),
    });

    const result = projectAdoptedDesignerPair(input);

    assert.strictEqual(result.ok, true);
    if (!result.ok) { return; }
    assert.match(result.sourceXml.toString('utf8'), /<v8:DateFractions(?:\s[^>]*)?>DateTime<\/v8:DateFractions>/u);
  });

  test('rejects namespace-spoofed ExtendedProperty members and a rebound xsi:type prefix', () => {
    const baseType = '<Type><v8:Type>xs:decimal</v8:Type><v8:NumberQualifiers><v8:Digits>12</v8:Digits><v8:FractionDigits>2</v8:FractionDigits><v8:AllowedSign>Nonnegative</v8:AllowedSign></v8:NumberQualifiers></Type>';
    const spoofedMembers = '<Type xsi:type="xr:ExtendedProperty"><xr:ExtendValue xsi:type="v8:TypeDescription"><vendor:Type>xs:string</vendor:Type></xr:ExtendValue></Type>';
    const reboundXsi = '<Type xmlns:xsi="urn:spoofed-xsi" xsi:type="xr:ExtendedProperty"><xr:ExtendValue xsi:type="v8:TypeDescription"><v8:Type>xs:string</v8:Type></xr:ExtendValue></Type>';
    const input = makeInput({
      direction: 'adopted-to-cf',
      baseXml: descriptor({ uuid: BASE_UUID, type: baseType }),
      targetXml: descriptor({ uuid: BASE_UUID, type: baseType }),
      sourceXml: descriptor({
        uuid: CFE_UUID,
        adopted: true,
        type: spoofedMembers,
        propertyState: 'MultiState',
        extraProperties: '',
      }),
    });

    const result = projectAdoptedDesignerPair(input);

    assert.strictEqual(result.ok, true);
    if (!result.ok) { return; }
    assert.strictEqual(result.issues.length, 1);
    assert.match(result.sourceXml.toString('utf8'), /<v8:Digits(?:\s[^>]*)?>12<\/v8:Digits>/u);
    assert.doesNotMatch(result.sourceXml.toString('utf8'), /vendor:Type|vendor:NumberQualifiers/u);

    const rebound = projectAdoptedDesignerPair({ ...input, sourceXml: descriptor({ uuid: CFE_UUID, adopted: true, type: reboundXsi, propertyState: 'MultiState' }) });
    assert.strictEqual(rebound.ok, true);
    if (rebound.ok) {
      assert.strictEqual(rebound.issues.length, 1);
      assert.match(rebound.sourceXml.toString('utf8'), /<v8:Digits(?:\s[^>]*)?>12<\/v8:Digits>/u);
    }
  });

  test('rejects malformed Number qualifier inputs even when the union would otherwise fit platform bounds', () => {
    const baseType = '<Type><v8:Type>xs:decimal</v8:Type><v8:NumberQualifiers><v8:Digits>12</v8:Digits><v8:FractionDigits>2</v8:FractionDigits><v8:AllowedSign>Nonnegative</v8:AllowedSign></v8:NumberQualifiers></Type>';
    const malformed = '<Type xsi:type="xr:ExtendedProperty"><xr:ExtendValue xsi:type="v8:TypeDescription"><v8:Type>xs:string</v8:Type><v8:NumberQualifiers><v8:Digits>10</v8:Digits><v8:FractionDigits>12</v8:FractionDigits><v8:AllowedSign>Any</v8:AllowedSign></v8:NumberQualifiers></xr:ExtendValue></Type>';
    const input = makeInput({
      direction: 'adopted-to-cf',
      baseXml: descriptor({ uuid: BASE_UUID, type: baseType }),
      targetXml: descriptor({ uuid: BASE_UUID, type: baseType }),
      sourceXml: descriptor({ uuid: CFE_UUID, adopted: true, type: malformed, propertyState: 'MultiState' }),
    });

    const result = projectAdoptedDesignerPair(input);

    assert.strictEqual(result.ok, true);
    if (!result.ok) { return; }
    assert.strictEqual(result.issues.length, 1);
    assert.match(result.sourceXml.toString('utf8'), /<v8:Digits(?:\s[^>]*)?>12<\/v8:Digits>/u);
    assert.doesNotMatch(result.sourceXml.toString('utf8'), /<v8:FractionDigits>12<\/v8:FractionDigits>/u);
  });
});

interface DescriptorOptions {
  readonly uuid: string;
  readonly adopted?: boolean;
  readonly comment?: string;
  readonly propertyState?: 'Notify' | 'MultiState';
  readonly extraProperties?: string;
  readonly childObjects?: readonly string[];
  readonly type?: string;
}

type TestAdoptedDirection = AdoptedDesignerProjectionInput['direction'] | 'adopted-to-adopted';

function makeInput(overrides: Omit<Partial<AdoptedDesignerProjectionInput>, 'direction'> & { readonly direction?: TestAdoptedDirection } = {}): AdoptedDesignerProjectionInput {
  const direction = overrides.direction ?? 'adopted-to-cf';
  const baseIdentity: AdoptedDesignerIdentity = { ownership: 'own', type: 'Catalog', name: 'Products', uuid: BASE_UUID };
  const targetIdentity: AdoptedDesignerIdentity = direction === 'adopted-to-cf'
    ? baseIdentity
    : { ownership: 'adopted', type: 'Catalog', name: 'Products', uuid: CFE_UUID, sourceUuid: BASE_UUID };
  const sourceIdentity: AdoptedDesignerIdentity = direction !== 'cf-to-adopted'
    ? { ownership: 'adopted', type: 'Catalog', name: 'Products', uuid: direction === 'adopted-to-adopted' ? SOURCE_CFE_UUID : CFE_UUID, sourceUuid: BASE_UUID }
    : baseIdentity;
  return {
    direction: direction as AdoptedDesignerProjectionInput['direction'],
    targetXml: overrides.targetXml ?? (direction !== 'adopted-to-cf' ? descriptor({ uuid: CFE_UUID, adopted: true }) : descriptor({ uuid: BASE_UUID })),
    sourceXml: overrides.sourceXml ?? (direction !== 'cf-to-adopted' ? descriptor({ uuid: direction === 'adopted-to-adopted' ? SOURCE_CFE_UUID : CFE_UUID, adopted: true }) : descriptor({ uuid: BASE_UUID })),
    baseXml: overrides.baseXml ?? descriptor({ uuid: BASE_UUID }),
    targetIdentity,
    sourceIdentity,
    baseIdentity,
    formatVersion: '2.20',
    ...(overrides.adoptedChildUuidByAnchor ? { adoptedChildUuidByAnchor: overrides.adoptedChildUuidByAnchor } : {}),
    ...(overrides.typeIdReferenceDescriptors ? { typeIdReferenceDescriptors: overrides.typeIdReferenceDescriptors } : {}),
  };
}

function withTypeIdReferences(
  input: AdoptedDesignerProjectionInput,
  typeIdReferenceDescriptors: readonly AdoptedDesignerTypeIdReferenceDescriptor[],
): AdoptedDesignerProjectionInput {
  return { ...input, typeIdReferenceDescriptors };
}

function generatedTypeReference(options: {
  readonly type: string;
  readonly name: string;
  readonly uuid: string;
  readonly generatedName: string;
  readonly category: string;
  readonly typeId: string;
  readonly relativePath: string;
}): AdoptedDesignerTypeIdReferenceDescriptor {
  const descriptorXml = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" version="2.20"><${options.type} uuid="${options.uuid}"><Properties><Name>${options.name}</Name></Properties><InternalInfo><xr:GeneratedType name="${options.generatedName}" category="${options.category}"><xr:TypeId>${options.typeId}</xr:TypeId><xr:ValueId>cccccccc-cccc-4ccc-8ccc-cccccccccccc</xr:ValueId></xr:GeneratedType></InternalInfo></${options.type}></MetaDataObject>`, 'utf8');
  return {
    descriptorXml,
    identity: { ownership: 'own', type: options.type, name: options.name, uuid: options.uuid },
    provenance: 'proven-base',
    sourceId: 'base-configuration',
    relativePath: options.relativePath,
    expectedHash: createHash('sha256').update(descriptorXml).digest('hex'),
  };
}

function descriptor(options: DescriptorOptions): Buffer {
  const identity = options.adopted
    ? `<ObjectBelonging>Adopted</ObjectBelonging><ExtendedConfigurationObject>${BASE_UUID}</ExtendedConfigurationObject>`
    : '';
  const comment = options.comment === undefined ? '<Comment>Base comment</Comment>' : `<Comment>${options.comment}</Comment>`;
  const type = options.type ?? '<Type><v8:Type>xs:string</v8:Type></Type>';
  const internalInfo = options.propertyState
    ? `<InternalInfo><xr:GeneratedType name="CatalogRef" uuid="${BASE_UUID}"/><xr:PropertyState><xr:Property>${options.type ? 'Type' : 'Comment'}</xr:Property><xr:State>${options.propertyState}</xr:State></xr:PropertyState></InternalInfo>`
    : `<InternalInfo><xr:GeneratedType name="CatalogRef" uuid="${BASE_UUID}"/></InternalInfo>`;
  const children = options.childObjects?.join('') ?? (options.adopted ? '' : `<Dimension uuid="${CHILD_UUID}"><Properties><Name>Size</Name><Comment>Base child</Comment></Properties><InternalInfo><xr:GeneratedType name="DimensionRef" uuid="dimension-generated"/></InternalInfo></Dimension>`);
  const properties = `<Properties><Name>Products</Name>${comment}${type}${identity}${options.extraProperties ?? ''}</Properties>`;
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:vendor="urn:vendor" version="2.20"><Catalog uuid="${options.uuid}">${properties}${internalInfo}<ChildObjects>${children}</ChildObjects></Catalog></MetaDataObject>`, 'utf8');
}

function replaceComment(xml: string, before: string, after: string): string {
  return xml.replace(new RegExp(`(<Comment(?:\\s[^>]*)?>)${before}(</Comment>)`, 'u'), `$1${after}$2`);
}

function adoptedChild(options: { readonly anchorUuid?: string; readonly comment: string }): string {
  const anchor = options.anchorUuid ?? CHILD_UUID;
  return `<Dimension uuid="${CHILD_LOCAL_UUID}"><Properties><Name>Size</Name><Comment>${options.comment}</Comment><ObjectBelonging>Adopted</ObjectBelonging><ExtendedConfigurationObject>${anchor}</ExtendedConfigurationObject></Properties><InternalInfo><xr:PropertyState><xr:Property>Comment</xr:Property><xr:State>Notify</xr:State></xr:PropertyState></InternalInfo></Dimension>`;
}

function baseChild(comment: string): string {
  return `<Dimension uuid="${CHILD_UUID}"><Properties><Name>Size</Name><Comment>${comment}</Comment></Properties><InternalInfo><xr:GeneratedType name="DimensionRef" uuid="dimension-generated"/></InternalInfo></Dimension>`;
}

function baseAttribute(comment: string): string {
  return `<Attribute uuid="${CHILD_UUID}"><Properties><Name>Field</Name><Comment>${comment}</Comment><Type><v8:Type>xs:string</v8:Type></Type></Properties><InternalInfo><xr:GeneratedType name="CatalogAttribute.Field" category="Object"/></InternalInfo></Attribute>`;
}

function nestedBaseChild(comment: string): string {
  return `<TabularSection uuid="${CHILD_UUID}"><Properties><Name>Lines</Name><Comment>Base table</Comment></Properties><InternalInfo><xr:GeneratedType name="TabularSectionRef" uuid="table-generated"/></InternalInfo><ChildObjects><Attribute uuid="${NESTED_CHILD_UUID}"><Properties><Name>Item</Name><Comment>${comment}</Comment></Properties><InternalInfo><xr:GeneratedType name="ItemRef" uuid="item-generated"/></InternalInfo></Attribute></ChildObjects></TabularSection>`;
}

function bareTabularSection(nestedChildren = ''): string {
  return `<TabularSection uuid="${CHILD_UUID}"><Properties><Name>Lines</Name><Comment>Base table</Comment></Properties><InternalInfo><xr:GeneratedType name="TabularSectionRef" uuid="table-generated"/></InternalInfo>${nestedChildren}</TabularSection>`;
}

function ownNestedAttribute(): string {
  return `<Attribute uuid="${NESTED_OWN_CHILD_UUID}"><Properties><Name>N335_NewLineField</Name><Comment>Selected nested own field</Comment><Type><v8:Type>xs:string</v8:Type></Type></Properties></Attribute>`;
}
