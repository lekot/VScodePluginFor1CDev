import * as assert from 'assert';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { CompareSession } from '../../../src/compareMerge/domain/compareSession';
import type { CompareTreeNode } from '../../../src/compareMerge/compareTreeTypes';
import { formXmlAdapter } from '../../../src/compareMerge/adapters/formXmlAdapter';
import { metadataXmlAdapter } from '../../../src/compareMerge/adapters/xmlMetadataAdapter';
import { predefinedXmlAdapter } from '../../../src/compareMerge/adapters/predefinedXmlAdapter';
import type { AdapterCompareInput } from '../../../src/compareMerge/adapters/mergeAdapter';
import { validateSemanticXmlMerge } from '../../../src/compareMerge/adapters/semanticXml/semanticXmlValidator';
import { buildXmlSourceWitnesses } from '../../../src/compareMerge/adapters/semanticXml/semanticXmlSourceWitnesses';
import { applySelectedXmlPatches } from '../../../src/compareMerge/merge/semanticXmlMerge';
import { applyXmlPatch, applyXmlPatchBatch } from '../../../src/compareMerge/xml/xmlPatch';
import { buildXmlAddress, elementChildren, getXmlElementIdentityKey, parseXmlDocument, type XmlElement } from '../../../src/compareMerge/xml/xmlDom';

suite('Semantic XML deep merge (#335)', () => {
  test('uses scoped stable selectors for role rights and DCS structured members', () => {
    const rights = parseXmlDocument('<Rights xmlns="http://v8.1c.ru/8.2/roles"><object><name>Catalog.Products</name><right><name>Read</name></right></object><restrictionTemplate><name>Default</name></restrictionTemplate></Rights>').root;
    const rightsObject = elementChildren(rights)[0]!;
    const rightsRight = elementChildren(rightsObject).find((child) => child.localName === 'right')!;
    const restriction = elementChildren(rights).find((child) => child.localName === 'restrictionTemplate')!;
    assert.strictEqual(getXmlElementIdentityKey(rightsObject), 'rights-object=catalog.products');
    assert.strictEqual(getXmlElementIdentityKey(rightsRight), 'rights-right=read');
    assert.strictEqual(getXmlElementIdentityKey(restriction), 'rights-restrictiontemplate=default');

    const dcs = parseXmlDocument('<DataCompositionSchema xmlns="http://v8.1c.ru/8.1/data-composition-system/schema"><dataSet><name>Query</name><field><dataPath>Amount</dataPath></field></dataSet><dataSetLink><sourceDataSet>Query</sourceDataSet><destinationDataSet>Query2</destinationDataSet><sourceExpression>A</sourceExpression><destinationExpression>B</destinationExpression></dataSetLink></DataCompositionSchema>').root;
    const dataSet = elementChildren(dcs).find((child) => child.localName === 'dataSet')!;
    const dataSetField = elementChildren(dataSet).find((child) => child.localName === 'field')!;
    const link = elementChildren(dcs).find((child) => child.localName === 'dataSetLink')!;
    assert.strictEqual(getXmlElementIdentityKey(dataSet), 'dcs-dataset=query');
    assert.strictEqual(getXmlElementIdentityKey(dataSetField), 'dcs-field=amount');
    assert.strictEqual(getXmlElementIdentityKey(link), 'dcs-link=["Query","Query2","A","B",""]');
    assert.match(buildXmlAddress('Schema.xml', dataSetField).pointer, /dcs-dataset%3Dquery/u);
  });

  test('keys union members and their fields by exact DCS xsi:type and parent scope', () => {
    const schema = 'http://v8.1c.ru/8.1/data-composition-system/schema';
    const union = parseXmlDocument(`<d:DataCompositionSchema xmlns="${schema}" xmlns:d="${schema}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:alternate="${schema}">
      <d:dataSet xsi:type="alternate:DataSetUnion"><d:name>Outer</d:name><d:field><d:dataPath>Amount</d:dataPath></d:field>
        <d:item xsi:type="alternate:DataSetQuery"><d:name>QueryPart</d:name><d:field><d:dataPath>Amount</d:dataPath></d:field></d:item>
        <d:item xsi:type="d:DataSetObject"><d:name>ObjectPart</d:name><d:field><d:dataPath>Amount</d:dataPath></d:field></d:item>
        <d:item xsi:type="alternate:DataSetUnion"><d:name>Nested</d:name><d:item xsi:type="DataSetQuery"><d:name>QueryPart</d:name><d:field><d:dataPath>Amount</d:dataPath></d:field></d:item></d:item>
      </d:dataSet></d:DataCompositionSchema>`).root;
    const dataSet = elementChildren(union).find((element) => element.localName === 'dataSet')!;
    const outerField = elementChildren(dataSet).find((element) => element.localName === 'field')!;
    const items = elementChildren(dataSet).filter((element) => element.localName === 'item');
    const queryItem = items[0]!;
    const objectItem = items[1]!;
    const nestedUnion = items[2]!;
    const nestedQuery = elementChildren(nestedUnion).find((element) => element.localName === 'item')!;
    const queryField = elementChildren(queryItem).find((element) => element.localName === 'field')!;
    const objectField = elementChildren(objectItem).find((element) => element.localName === 'field')!;
    const nestedField = elementChildren(nestedQuery).find((element) => element.localName === 'field')!;

    assert.strictEqual(getXmlElementIdentityKey(queryItem), 'dcs-union-item=querypart');
    assert.strictEqual(getXmlElementIdentityKey(objectItem), 'dcs-union-item=objectpart');
    assert.strictEqual(getXmlElementIdentityKey(nestedQuery), 'dcs-union-item=querypart');
    assert.strictEqual(getXmlElementIdentityKey(outerField), 'dcs-field=amount');
    assert.strictEqual(getXmlElementIdentityKey(queryField), 'dcs-field=amount');
    assert.strictEqual(getXmlElementIdentityKey(objectField), 'dcs-field=amount');
    assert.strictEqual(getXmlElementIdentityKey(nestedField), 'dcs-field=amount');
  });

  test('validates nested role rights by their proven path scope', () => {
    const rootBooleans = '<setForNewObjects>false</setForNewObjects><setForAttributesByDefault>false</setForAttributesByDefault><independentRightsOfChildObjects>false</independentRightsOfChildObjects>';
    const object = (name: string, rights: string) => `<object><name>${name}</name>${rights}</object>`;
    const right = (name: string) => `<right><name>${name}</name><value>true</value></right>`;
    const source = `<Rights xmlns="http://v8.1c.ru/8.2/roles" version="2.20">${rootBooleans}` +
      object('DataProcessor.Load.Attribute.Code', right('Edit')) +
      object('Catalog.Products.TabularSection.Lines.Attribute.Amount', right('View') + right('Edit')) +
      object('Document.Invoice.Command.OpenCard', right('View')) +
      object('Catalog.Products.StandardAttribute.Ref', right('View') + right('Edit')) +
      object('CalculationRegister.Depreciation.Recalculation.Method', right('Read') + right('Update')) +
      object('WebService.Exchange.Operation.GetParameters', right('Use')) +
      object('ExternalDataSource.Sales.Table.Invoices', right('Read') + right('Edit')) +
      object('ExternalDataSource.Sales.Table.Invoices.Field.Total', right('View') + right('Edit')) +
      object('ExternalDataSource.Sales.Cube.Turnovers.Dimension.Period', right('View')) +
      '</Rights>';
    const valid = validateSemanticXmlMerge(source, 'roleRightsXml', {
      availableMetadataReferences: [
        'DataProcessor.Load', 'Catalog.Products', 'Document.Invoice', 'ExternalDataSource.Sales',
        'CalculationRegister.Depreciation', 'WebService.Exchange',
      ],
    });
    assert.strictEqual(valid.valid, true, JSON.stringify(valid.diagnostics));

    const invalid = validateSemanticXmlMerge(source.replace('DataProcessor.Load.Attribute.Code', 'DataProcessor.Load.Unknown.Code'), 'roleRightsXml', {
      availableMetadataReferences: ['DataProcessor.Load'],
    });
    assert.strictEqual(invalid.valid, false);
    assert.ok(invalid.diagnostics.some((item) => item.code === 'XML_RIGHTS_INAPPLICABLE_RIGHT'));
  });

  test('validates Configuration rights by the captured configuration name rather than object inventory membership', () => {
    const rootBooleans = '<setForNewObjects>false</setForNewObjects><setForAttributesByDefault>false</setForAttributesByDefault><independentRightsOfChildObjects>false</independentRightsOfChildObjects>';
    const source = `<Rights xmlns="http://v8.1c.ru/8.2/roles" version="2.20">${rootBooleans}<object><name>Configuration.Sales</name><right><name>DataAdministration</name><value>true</value></right></object></Rights>`;
    const accepted = validateSemanticXmlMerge(source, 'roleRightsXml', {
      availableMetadataReferences: ['Catalog.Products'],
      configurationName: 'Sales',
    });
    assert.strictEqual(accepted.valid, true, JSON.stringify(accepted.diagnostics));

    const wrongName = validateSemanticXmlMerge(source, 'roleRightsXml', {
      availableMetadataReferences: ['Catalog.Products'],
      configurationName: 'Accounting',
    });
    assert.ok(wrongName.diagnostics.some((item) => item.code === 'XML_TYPE_REFERENCE'));
  });

  test('resolves DCS dataset xsi:type by expanded QName, not local attribute spelling', () => {
    const schema = 'http://v8.1c.ru/8.1/data-composition-system/schema';
    const settings = 'http://v8.1c.ru/8.1/data-composition-system/settings';
    const document = (datasetType: string, declarations = '') =>
      `<d:DataCompositionSchema xmlns:d="${schema}" xmlns:set="${settings}" ${declarations}>` +
      '<d:dataSource><d:name>Source</d:name><d:dataSourceType>Local</d:dataSourceType></d:dataSource>' +
      `<d:dataSet ${datasetType}><d:name>Query</d:name><d:dataSource>Source</d:dataSource><d:query/></d:dataSet>` +
      '<d:settingsVariant><set:name>Default</set:name></d:settingsVariant></d:DataCompositionSchema>';
    const context = { ownerDescriptorVersions: { target: '2.20', incoming: '2.20' } };
    const accepted = validateSemanticXmlMerge(document('xsiAlias:type="schemaAlias:DataSetQuery"',
      `xmlns:xsiAlias="http://www.w3.org/2001/XMLSchema-instance" xmlns:schemaAlias="${schema}"`), 'dcsXml', context);
    assert.strictEqual(accepted.valid, true, JSON.stringify(accepted.diagnostics));

    for (const invalidType of [
      'foreign:type="schemaAlias:DataSetQuery"',
      'xsi:type="foreign:DataSetQuery"',
      'xsi:type="unbound:DataSetQuery"',
    ]) {
      const invalid = validateSemanticXmlMerge(document(invalidType,
        `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:foreign="urn:other"`), 'dcsXml', context);
      assert.strictEqual(invalid.valid, false, invalidType);
      assert.ok(invalid.diagnostics.some((item) => item.code === 'XML_DCS_DATASET_TYPE_MISSING'), invalidType + ': ' + JSON.stringify(invalid.diagnostics));
    }
  });

  test('projects selected registrations separately when metadata ChildObjects is missing', async () => {
    const left = '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses"><Catalog uuid="catalog-1"><InternalInfo/><Properties><Name>Products</Name></Properties><!--keep--><FutureTarget>preserve</FutureTarget></Catalog></MetaDataObject>';
    const right = '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses"><Catalog uuid="catalog-1"><InternalInfo/><Properties><Name>Products</Name></Properties><ChildObjects><Form>Main</Form><Template>Print</Template><Command>Unlinked</Command></ChildObjects></Catalog></MetaDataObject>';
    const input = makeInput(left, right);
    input.linkedDesignerContext = {
      registrations: [
        { kind: 'Form', name: 'Main', packageId: 'form-main' },
        { kind: 'Template', name: 'Print', packageId: 'template-print' },
      ],
      defaultObjectForms: [],
      formEventHandlers: [],
    };

    const result = await metadataXmlAdapter.compare(input);
    const wrapper = requireNode(result.nodes, 'Контейнер объектов');
    assert.strictEqual(wrapper.mergeable, false);
    const registrations = wrapper.children.filter((node) => node.mergeable);
    assert.deepStrictEqual(registrations.map((node) => node.rightValue?.includes('<Form') ? 'Form' : 'Template'), ['Form', 'Template']);
    assert.ok(wrapper.children.some((node) => node.label === 'Команда: Unlinked' && node.status === 'rightOnly' && !node.mergeable));
    assert.ok(!result.candidateFactories.has(wrapper.id), 'the wrapper must never bypass package selection');

    const candidates = await Promise.all(registrations.map((node) => result.candidateFactories.get(node.id)!()));
    assert.ok(candidates.every((candidate) => candidate.ok));
    const patches = candidates.map((candidate) => candidate.ok ? candidate.candidate.xmlPatch! : undefined);
    assert.ok(patches.every((patch) => patch?.createDestinationChildObjects === true));
    assert.strictEqual(patches[0]!.destinationParent?.pointer, patches[1]!.destinationParent?.pointer);
    const applied = applyXmlPatchBatch(left, [patches[1]!, patches[0]!]);
    const owner = elementChildren(parseXmlDocument(applied).root)[0]!;
    const container = findElement(owner, 'ChildObjects');
    assert.deepStrictEqual(elementChildren(container).map((element) => element.localName), ['Form', 'Template']);
    assert.match(applied, /<!--keep-->/u);
    assert.match(applied, /<FutureTarget>preserve<\/FutureTarget>/u);
    assert.doesNotMatch(applied, /Unlinked/u);
  });

  test('keeps missing-container registrations read-only without a linked package capability', async () => {
    const left = '<MetaDataObject><Catalog uuid="catalog-1"><Properties><Name>Products</Name></Properties></Catalog></MetaDataObject>';
    const right = '<MetaDataObject><Catalog uuid="catalog-1"><Properties><Name>Products</Name></Properties><ChildObjects><Form>Main</Form></ChildObjects></Catalog></MetaDataObject>';
    const result = await metadataXmlAdapter.compare(makeInput(left, right));
    const wrapper = requireNode(result.nodes, 'Контейнер объектов');
    assert.strictEqual(wrapper.mergeable, false);
    assert.strictEqual(wrapper.children.length, 1);
    assert.strictEqual(wrapper.children[0]!.mergeable, false);
    assert.strictEqual(result.candidateFactories.size, 0);
  });

  test('allows a linked registration deletion as an individual package candidate', async () => {
    const left = '<MetaDataObject><Catalog uuid="catalog-1"><Properties><Name>Products</Name></Properties><ChildObjects><Form>Main</Form></ChildObjects></Catalog></MetaDataObject>';
    const right = '<MetaDataObject><Catalog uuid="catalog-1"><Properties><Name>Products</Name></Properties></Catalog></MetaDataObject>';
    const input = makeInput(left, right);
    input.linkedDesignerContext = {
      registrations: [{ kind: 'Form', name: 'Main', packageId: 'form-main' }],
      defaultObjectForms: [],
      formEventHandlers: [],
    };

    const result = await metadataXmlAdapter.compare(input);
    const registration = collectNodes(result.nodes).find((node) =>
      node.payloadRef?.includes('/ChildObjects[0]/Form[0]') && node.label === 'Форма: Main',
    );
    assert.ok(registration, 'the existing Form registration should have its own selectable node');
    const selectedRegistration = registration!;
    assert.strictEqual(selectedRegistration.status, 'leftOnly');
    assert.strictEqual(selectedRegistration.mergeable, true);
    const candidate = await result.candidateFactories.get(selectedRegistration.id)!();
    assert.strictEqual(candidate.ok, true);
    if (!candidate.ok) {return;}
    assert.strictEqual(candidate.candidate.xmlPatch?.kind, 'deleteNode');
    assert.match(selectedRegistration.leftValue ?? '', /<Form(?:\s[^>]*)?>Main<\/Form>/u);
  });

  test('keeps mixed XML and inherited namespaces while patching one localized value', async () => {
    const left = [
      '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core">',
      '  <!-- keep root comment --><Properties><Name>Products</Name><Synonym>',
      '    <!-- keep localized comment --><v8:item><v8:lang>ru</v8:lang><v8:content><![CDATA[Old goods]]></v8:content></v8:item>',
      '    <![CDATA[tail]]></Synonym></Properties>',
      '</MetaDataObject>',
    ].join('');
    const right = left.replace('Old goods', 'New goods');
    const result = await metadataXmlAdapter.compare(makeInput(left, right));
    const content = requireNode(result.nodes, 'v8:content');
    const candidate = await result.candidateFactories.get(content.id)!();

    assert.strictEqual(candidate.ok, true);
    const applied = applyXmlPatch(left, candidate.candidate.xmlPatch!);
    assert.match(applied, /<!-- keep root comment -->/);
    assert.match(applied, /<!-- keep localized comment -->/);
    assert.match(applied, /<!\[CDATA\[tail\]\]>/);
    assert.match(applied, /<v8:content(?:\s[^>]*)?><!\[CDATA\[New goods\]\]><\/v8:content>/);
    assert.match(applied, /xmlns:v8="http:\/\/v8\.1c\.ru\/8\.1\/data\/core"/);
  });

  test('treats type members as selectable set entries and qualifiers as one atomic value', async () => {
    const left = [
      '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config">',
      '<Catalog uuid="catalog-1"><Properties><Name>Products</Name><Synonym>Products</Synonym></Properties>',
      '<ChildObjects><Attribute uuid="attribute-1"><Properties><Name>Value</Name><Type><v8:Type>xs:string</v8:Type>',
      '<v8:StringQualifiers><v8:Length>20</v8:Length><v8:AllowedLength>Variable</v8:AllowedLength></v8:StringQualifiers>',
      '</Type></Properties></Attribute></ChildObjects></Catalog></MetaDataObject>',
    ].join('');
    const right = left
      .replace('</v8:Type><v8:StringQualifiers>', '</v8:Type><v8:Type>cfg:CatalogRef.Products</v8:Type><v8:StringQualifiers>')
      .replace('<v8:Length>20</v8:Length>', '<v8:Length>40</v8:Length>');
    const result = await metadataXmlAdapter.compare(makeInput(left, right));
    const qualifier = requireNode(result.nodes, 'v8:StringQualifiers');
    const addedType = requireNode(result.nodes, 'v8:Type', (node) => node.status === 'rightOnly');

    assert.strictEqual(qualifier.kind, 'xmlProperty');
    assert.strictEqual(qualifier.mergeable, true);
    assert.strictEqual(addedType.status, 'rightOnly');
    const qualifierCandidate = await result.candidateFactories.get(qualifier.id)!();
    assert.strictEqual(qualifierCandidate.ok, true);
    assert.match(qualifierCandidate.candidate.xmlPatch?.replacementXml ?? '', /AllowedLength/);
  });

  test('uses actual form element kinds, preserves mixed child order, and blocks ID renames', async () => {
    const left = [
      '<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.20">',
      '<ChildItems><UsualGroup name="Group" id="1"><ChildItems><InputField name="CodeField" id="2"><DataPath>Code</DataPath></InputField></ChildItems></UsualGroup>',
      '<Table name="Rows" id="3"><DataPath>Rows</DataPath></Table></ChildItems><Attributes/><Commands/></Form>',
    ].join('');
    const right = left.replace(
      '<Table name="Rows" id="3">',
      '<InputField name="Added" id="4"><DataPath>Code</DataPath></InputField><Table name="Rows" id="3">'
    );
    const result = await formXmlAdapter.compare(makeInput(left, right));
    const added = requireNode(result.nodes, 'Added');
    assert.strictEqual(added.kind, 'formItem');
    const candidate = await result.candidateFactories.get(added.id)!();
    assert.strictEqual(candidate.ok, true);
    assert.strictEqual(candidate.candidate.xmlPatch?.insertBefore?.identityKey, 'id=3');
    const applied = applyXmlPatch(left, candidate.candidate.xmlPatch!);
    assert.deepStrictEqual(
      elementChildren(findElement(parseXmlDocument(applied).root, 'ChildItems')).map((element) => element.attributes.find((attr) => attr.localName === 'id')?.value),
      ['1', '4', '3']
    );

    const renamed = await formXmlAdapter.compare(
      makeInput(left, left.replace('name="CodeField"', 'name="RenamedField"'))
    );
    assert.ok(renamed.diagnostics.some((item) => item.code === 'XML_FORM_IDENTITY_MISMATCH' && item.blocking));
    assert.strictEqual(renamed.candidateFactories.size, 0);
  });

  test('matches predefined records by UUID and keeps UUID and Name protected', async () => {
    const left = [
      '<PredefinedData xmlns="http://v8.1c.ru/8.3/xcf/predef" version="2.20" xsi:type="CatalogPredefinedItems" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
      '<Item id="11111111-1111-4111-8111-111111111111"><Name>Folder</Name><IsFolder>true</IsFolder><Item id="22222222-2222-4222-8222-222222222222"><Name>Child</Name><Description>Old</Description><IsFolder>false</IsFolder></Item></Item>',
      '</PredefinedData>',
    ].join('');
    const right = left.replace('<Description>Old</Description>', '<Description>New</Description>');
    const result = await predefinedXmlAdapter.compare(makeInput(left, right));
    const description = requireNode(result.nodes, 'Description');
    assert.strictEqual(description.leftValue, 'Old');
    assert.strictEqual(description.rightValue, 'New');
    const candidate = await result.candidateFactories.get(description.id)!();
    assert.strictEqual(candidate.ok, true);
    const applied = applyXmlPatch(left, candidate.candidate.xmlPatch!);
    assert.match(applied, /id="11111111-1111-4111-8111-111111111111"/);
    assert.match(applied, /id="22222222-2222-4222-8222-222222222222"/);
    assert.match(applied, /<Name>Child<\/Name>/);

    const renamed = await predefinedXmlAdapter.compare(
      makeInput(left, left.replace('<Name>Child</Name>', '<Name>Renamed</Name>'))
    );
    assert.ok(renamed.diagnostics.some((item) => item.code === 'XML_PREDEFINED_IDENTITY_MISMATCH' && item.blocking));
    assert.strictEqual(renamed.candidateFactories.size, 0);
  });

  test('matches subsystem Content as a QName set and anchors insertion before the next target item', async () => {
    const left = [
      '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
      '<Subsystem uuid="subsystem-1"><Properties><Name>Sales</Name><Content>',
      '<xr:Item xsi:type="xr:MDObjectRef">Catalog.A</xr:Item><xr:Item xsi:type="xr:MDObjectRef">Document.C</xr:Item>',
      '</Content></Properties></Subsystem></MetaDataObject>',
    ].join('');
    const right = left.replace(
      '<xr:Item xsi:type="xr:MDObjectRef">Document.C</xr:Item>',
      '<xr:Item xsi:type="xr:MDObjectRef">Catalog.B</xr:Item><xr:Item xsi:type="xr:MDObjectRef">Document.C</xr:Item>'
    );
    const result = await metadataXmlAdapter.compare(makeInput(left, right));
    const added = requireNode(result.nodes, 'xr:Item', (node) => node.status === 'rightOnly');
    const candidate = await result.candidateFactories.get(added.id)!();

    assert.strictEqual(candidate.ok, true);
    assert.strictEqual(candidate.candidate.xmlPatch?.insertBefore?.identityKey, 'Item=Document.C');
    const applied = applyXmlPatch(left, candidate.candidate.xmlPatch!);
    assert.ok(applied.indexOf('Catalog.B') < applied.indexOf('Document.C'));
  });

  test('validates duplicate form IDs and newly broken command/data references but permits baseline issues', () => {
    const duplicate = validateSemanticXmlMerge(
      '<Form><ChildItems><InputField name="A" id="7"/><Table name="B" id="7"/></ChildItems><Attributes><Attribute name="Data" id="1"/></Attributes><Commands/></Form>',
      'formXml'
    );
    assert.strictEqual(duplicate.valid, false);
    assert.ok(duplicate.diagnostics.some((item) => item.code === 'XML_FORM_DUPLICATE_ID'));

    const baseline = '<Form><ChildItems><Button name="Open" id="1"><CommandName>Form.Command.Missing</CommandName><DataPath>Gone</DataPath></Button></ChildItems><Attributes/><Commands/></Form>';
    const invalid = validateSemanticXmlMerge(
      baseline.replace('name="Open"', 'name="OpenChanged"'),
      'formXml',
      { baselineSource: baseline, availableFormReferences: { attributes: ['Code'], commands: ['Save'], elements: [] } }
    );
    assert.strictEqual(invalid.valid, true, 'unchanged legacy references must not block an unrelated edit');

    const newlyInvalid = validateSemanticXmlMerge(
      baseline.replace('Missing', 'NewMissing').replace('Gone', 'NewGone'),
      'formXml',
      { baselineSource: baseline, availableFormReferences: { attributes: ['Code'], commands: ['Save'], elements: [] } }
    );
    assert.strictEqual(newlyInvalid.valid, false);
    assert.ok(newlyInvalid.diagnostics.some((item) => item.code === 'XML_FORM_COMMAND_REFERENCE'));
    assert.ok(newlyInvalid.diagnostics.some((item) => item.code === 'XML_FORM_ATTRIBUTE_REFERENCE'));
  });

  test('blocks subsystem references absent from target inventory and illegal type qualifiers', () => {
    const content = [
      '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
      '<Subsystem><Properties><Name>Sales</Name><Content><xr:Item xsi:type="xr:MDObjectRef">Catalog.Missing</xr:Item></Content></Properties></Subsystem></MetaDataObject>',
    ].join('');
    const invalidContent = validateSemanticXmlMerge(content, 'metadataXml', {
      availableMetadataReferences: ['Catalog.Known'],
    });
    assert.strictEqual(invalidContent.valid, false);
    assert.ok(invalidContent.diagnostics.some((item) => item.code === 'XML_CONTENT_REFERENCE'));

    const invalidType = validateSemanticXmlMerge(
      '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xs="http://www.w3.org/2001/XMLSchema"><Catalog><Properties><Name>Products</Name><Type><v8:Type>xs:decimal</v8:Type><v8:StringQualifiers><v8:Length>10</v8:Length></v8:StringQualifiers></Type></Properties></Catalog></MetaDataObject>',
      'metadataXml'
    );
    assert.strictEqual(invalidType.valid, false);
    assert.ok(invalidType.diagnostics.some((item) => item.code === 'XML_TYPE_QUALIFIER_MISMATCH'));
  });

  test('validates current-config type references by expanded namespace and supports Cyrillic names', () => {
    const missing = '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:r="http://v8.1c.ru/8.1/data/enterprise/current-config"><Catalog><Properties><Type><v8:Type>r:CatalogRef.Справочник55</v8:Type></Type></Properties></Catalog></MetaDataObject>';
    const invalid = validateSemanticXmlMerge(missing, 'metadataXml', { availableMetadataReferences: ['Catalog.Other'] });
    assert.strictEqual(invalid.valid, false);
    assert.ok(invalid.diagnostics.some((item) => item.code === 'XML_TYPE_REFERENCE'));

    const valid = validateSemanticXmlMerge(missing, 'metadataXml', { availableMetadataReferences: ['Catalog.Справочник55'] });
    assert.strictEqual(valid.valid, true);

    const foreign = missing.replace('r:CatalogRef.Справочник55', 'evil:CatalogRef.Missing').replace(
      'xmlns:r="http://v8.1c.ru/8.1/data/enterprise/current-config"',
      'xmlns:evil="urn:untrusted"'
    );
    assert.strictEqual(validateSemanticXmlMerge(foreign, 'metadataXml', { availableMetadataReferences: [] }).valid, true);
  });

  test('rejects unbound QName prefixes in Type text and xsi:type values', () => {
    const unboundTypePrefix = validateSemanticXmlMerge(
      '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core"><Catalog><Properties><Type><v8:Type>missing:CatalogRef.Known</v8:Type></Type></Properties></Catalog></MetaDataObject>',
      'metadataXml'
    );
    assert.strictEqual(unboundTypePrefix.valid, false);
    assert.ok(unboundTypePrefix.diagnostics.some((item) => item.code === 'XML_UNBOUND_QNAME_PREFIX'));

    const unboundXsiTypePrefix = validateSemanticXmlMerge(
      '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable"><Subsystem><Properties><Name>Subsystem</Name><Content><xr:Item xsi:type="missing:MDObjectRef">Catalog.Products</xr:Item></Content></Properties></Subsystem></MetaDataObject>',
      'metadataXml',
      { availableMetadataReferences: ['Catalog.Products'] }
    );
    assert.strictEqual(unboundXsiTypePrefix.valid, false);
    assert.ok(unboundXsiTypePrefix.diagnostics.some((item) => item.code === 'XML_UNBOUND_QNAME_PREFIX'));
  });

  test('validates form attribute types against registered metadata and preserves baseline-only context gaps', () => {
    const baseline = '<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config"><Attributes><Attribute name="Items" id="1"><Type><v8:Type>cfg:CatalogRef.Known</v8:Type></Type></Attribute></Attributes><Commands/><ChildItems/></Form>';
    const invalid = validateSemanticXmlMerge(baseline.replace('CatalogRef.Known', 'CatalogRef.Missing'), 'formXml', {
      availableMetadataReferences: ['Catalog.Known'],
    });
    assert.strictEqual(invalid.valid, false);
    assert.ok(invalid.diagnostics.some((item) => item.code === 'XML_TYPE_REFERENCE'));

    const valid = validateSemanticXmlMerge(baseline, 'formXml', {
      availableMetadataReferences: ['Catalog.Known'],
    });
    assert.strictEqual(valid.valid, true);

    const unrelatedEdit = validateSemanticXmlMerge(baseline.replace('</Form>', '<Comment>changed</Comment></Form>'), 'formXml', {
      baselineSource: baseline,
    });
    assert.strictEqual(unrelatedEdit.valid, true, 'pre-existing reference without captured inventory must not block an unrelated edit');

    const newlyIntroduced = validateSemanticXmlMerge(baseline.replace('CatalogRef.Known', 'CatalogRef.Missing'), 'formXml', {
      baselineSource: '<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config"><Attributes/><Commands/><ChildItems/></Form>',
    });
    assert.strictEqual(newlyIntroduced.valid, false);
    assert.ok(newlyIntroduced.diagnostics.some((item) => item.code === 'XML_TYPE_REFERENCE_CONTEXT_REQUIRED'));
  });

  test('rejects a qualifier without any type and requires XML Schema primitive QNames', () => {
    const noType = validateSemanticXmlMerge(
      '<MetaDataObject xmlns:v8="http://v8.1c.ru/8.1/data/core"><Catalog><Properties><Type><v8:StringQualifiers><v8:Length>10</v8:Length></v8:StringQualifiers></Type></Properties></Catalog></MetaDataObject>',
      'metadataXml'
    );
    assert.strictEqual(noType.valid, false);
    assert.ok(noType.diagnostics.some((item) => item.code === 'XML_TYPE_QUALIFIER_MISMATCH'));

    const foreignPrimitive = validateSemanticXmlMerge(
      '<MetaDataObject xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:evil="urn:attacker"><Catalog><Properties><Type><v8:Type>evil:string</v8:Type><v8:StringQualifiers><v8:Length>10</v8:Length></v8:StringQualifiers></Type></Properties></Catalog></MetaDataObject>',
      'metadataXml'
    );
    assert.strictEqual(foreignPrimitive.valid, false);
    assert.ok(foreignPrimitive.diagnostics.some((item) => item.code === 'XML_TYPE_QUALIFIER_MISMATCH'));
  });

  test('does not baseline-suppress hard identity errors and rejects versioned invalid predefined UUIDs or duplicate names', () => {
    const twoIds = '<Form><ChildItems><InputField name="A" id="7"/><Table name="B" id="7"/></ChildItems></Form>';
    const threeIds = twoIds.replace('</ChildItems>', '<Button name="C" id="7"/></ChildItems>');
    const thirdDuplicate = validateSemanticXmlMerge(threeIds, 'formXml', { baselineSource: twoIds });
    assert.strictEqual(thirdDuplicate.valid, false);
    assert.ok(thirdDuplicate.diagnostics.some((item) => item.code === 'XML_FORM_DUPLICATE_ID'));

    const malformedUuid = validateSemanticXmlMerge(
      '<PredefinedData version="2.20"><Item id="not-a-uuid"><Name>Item</Name></Item></PredefinedData>',
      'predefinedXml'
    );
    assert.strictEqual(malformedUuid.valid, false);
    assert.ok(malformedUuid.diagnostics.some((item) => item.code === 'XML_PREDEFINED_INVALID_UUID'));

    const duplicateNames = validateSemanticXmlMerge(
      '<PredefinedData version="2.20"><Item id="11111111-1111-4111-8111-111111111111"><Name>Same</Name></Item><Item id="22222222-2222-4222-8222-222222222222"><Name>Same</Name></Item></PredefinedData>',
      'predefinedXml'
    );
    assert.strictEqual(duplicateNames.valid, false);
    assert.ok(duplicateNames.diagnostics.some((item) => item.code === 'XML_PREDEFINED_DUPLICATE_NAME'));
  });

  test('protects lower-case form name identity and flags source order changes as read-only', async () => {
    const left = '<Form version="2.20"><ChildItems><InputField name="First" id="1"/><Table name="Second" id="2"/></ChildItems><Attributes/><Commands/></Form>';
    const renamed = await formXmlAdapter.compare(makeInput(left, left.replace('name="First"', 'name="Renamed"')));
    assert.ok(renamed.diagnostics.some((item) => item.code === 'XML_FORM_IDENTITY_MISMATCH'));
    assert.strictEqual(renamed.candidateFactories.size, 0);

    const reordered = await formXmlAdapter.compare(makeInput(
      left,
      '<Form version="2.20"><ChildItems><Table name="Second" id="2"/><InputField name="First" id="1"/></ChildItems><Attributes/><Commands/></Form>'
    ));
    const nodes = collectNodes(reordered.nodes);
    assert.ok(nodes.some((node) => node.mergeState?.state === 'readOnly' && /поряд|order/iu.test(node.mergeState.reason ?? '')));
  });

  test('keeps form ID namespaces separate while rejecting visual ID type changes', async () => {
    const left = '<Form version="2.20"><Attributes><Attribute name="Data" id="1"/></Attributes><Commands/><ChildItems/></Form>';
    const withVisual = left.replace('<ChildItems/>', '<ChildItems><InputField name="DataInput" id="1"/></ChildItems>');
    const added = await formXmlAdapter.compare(makeInput(left, withVisual));
    assert.ok(added.candidateFactories.size > 0, 'attribute and visual ID namespaces are independent');

    const visual = '<Form version="2.20"><Attributes/><Commands/><ChildItems><InputField name="Field" id="1"/></ChildItems></Form>';
    const changedKind = visual.replace('<InputField name="Field" id="1"/>', '<Table name="Field" id="1"/>');
    const mismatch = await formXmlAdapter.compare(makeInput(visual, changedKind));
    assert.ok(mismatch.diagnostics.some((item) => item.code === 'XML_FORM_IDENTITY_MISMATCH'));
    assert.strictEqual(mismatch.candidateFactories.size, 0);
  });

  test('preserves raw CRLF and BOM bytes in source witnesses', async () => {
    const left = '\uFEFF<MetaDataObject>\r\n<Catalog><Properties><Name>Products</Name><Comment>Before</Comment></Properties></Catalog>\r\n</MetaDataObject>\r\n';
    const right = left.replace('Before', 'After');
    const input = makeInput(left, right);
    input.semanticValidationContext = { availableMetadataReferences: [] };
    input.semanticContextWitnesses = [{
      sourceId: 'left-source',
      relativePath: 'Configuration.xml',
      expectedHash: 'a'.repeat(64),
      kind: 'file',
    }];
    const result = await metadataXmlAdapter.compare(input);
    const changed = requireNode(result.nodes, 'Comment');
    const candidate = await result.candidateFactories.get(changed.id)!();
    assert.strictEqual(candidate.ok, true);
    assert.match(applyXmlPatch(left, candidate.candidate.xmlPatch!), /<Comment>After<\/Comment>/);
    assert.ok(applyXmlPatch(left, candidate.candidate.xmlPatch!).includes('\r\n'));
    const witnesses = candidate.candidate.xmlPatch?.sourceWitnesses ?? [];
    assert.strictEqual(witnesses.find((item) => item.sourceId === 'right-source')?.expectedHash, createHash('sha256').update(Buffer.from(right, 'utf8')).digest('hex'));
    assert.strictEqual(witnesses.find((item) => item.sourceId === 'left-source')?.expectedHash, createHash('sha256').update(Buffer.from(left, 'utf8')).digest('hex'));
    assert.strictEqual(witnesses.find((item) => item.relativePath === 'Configuration.xml')?.expectedHash, 'a'.repeat(64));
  });

  test('rejects unbound XML prefixes and leaves bound foreign elements read-only', async () => {
    const unbound = validateSemanticXmlMerge('<Form><x:Title>abc</x:Title></Form>', 'formXml');
    assert.strictEqual(unbound.valid, false);
    assert.ok(unbound.diagnostics.some((item) => item.code === 'XML_PARSE_FAILED'));

    const left = '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:x="urn:foreign"><Catalog><Properties><Name>Products</Name><x:Title>Old</x:Title></Properties></Catalog></MetaDataObject>';
    const right = left.replace('>Old</x:Title>', '>New</x:Title>');
    const result = await metadataXmlAdapter.compare(makeInput(left, right));
    const foreign = requireNode(result.nodes, 'x:Title');
    assert.strictEqual(foreign.mergeState?.state, 'readOnly');
    assert.strictEqual(result.candidateFactories.has(foreign.id), false);

    const spoofedRoot = validateSemanticXmlMerge('<evil:Form xmlns:evil="urn:foreign"/>', 'formXml');
    assert.strictEqual(spoofedRoot.valid, false);
    assert.ok(spoofedRoot.diagnostics.some((item) => item.code === 'XML_ROOT_NAMESPACE_UNSUPPORTED'));

    const unknownV8 = '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:evil="http://v8.1c.ru/unsupported"><Catalog><Properties><Name>Products</Name><evil:Comment>Old</evil:Comment></Properties></Catalog></MetaDataObject>';
    const unknownV8Result = await metadataXmlAdapter.compare(makeInput(unknownV8, unknownV8.replace('>Old</evil:Comment>', '>New</evil:Comment>')));
    const unknownV8Comment = requireNode(unknownV8Result.nodes, 'evil:Comment');
    assert.strictEqual(unknownV8Comment.mergeState?.state, 'readOnly');
    assert.strictEqual(unknownV8Result.candidateFactories.has(unknownV8Comment.id), false);

    const unknownV8Attribute = '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:evil="http://v8.1c.ru/unsupported"><Catalog><Properties><Name>Products</Name><Comment evil:marker="old">Same</Comment></Properties></Catalog></MetaDataObject>';
    const unknownV8AttributeResult = await metadataXmlAdapter.compare(makeInput(
      unknownV8Attribute,
      unknownV8Attribute.replace('evil:marker="old"', 'evil:marker="new"')
    ));
    const unknownAttribute = requireNode(unknownV8AttributeResult.nodes, 'Comment');
    assert.strictEqual(unknownAttribute.mergeState?.state, 'readOnly');
    assert.strictEqual(unknownV8AttributeResult.candidateFactories.has(unknownAttribute.id), false);

    const combinedUnknownAttributeChange = await metadataXmlAdapter.compare(makeInput(
      unknownV8Attribute,
      unknownV8Attribute.replace('evil:marker="old"', 'evil:marker="new"').replace('>Same</Comment>', '>Changed</Comment>')
    ));
    const commentWithUnknownAttribute = requireNode(combinedUnknownAttributeChange.nodes, 'Comment');
    assert.strictEqual(commentWithUnknownAttribute.mergeState?.state, 'readOnly');
    assert.strictEqual(combinedUnknownAttributeChange.candidateFactories.has(commentWithUnknownAttribute.id), false);
  });

  test('keeps unknown descendants out of whole-subtree and atomic qualifier patches', async () => {
    const metadataLeft = '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:evil="http://v8.1c.ru/unsupported"><Catalog><Properties><Name>Products</Name></Properties><ChildObjects/></Catalog></MetaDataObject>';
    const incomingUnknown = metadataLeft.replace(
      '<ChildObjects/>',
      '<ChildObjects><Attribute uuid="attribute-1"><Properties><Name>NewAttribute</Name><evil:Comment>Hidden</evil:Comment></Properties></Attribute></ChildObjects>'
    );
    const insertResult = await metadataXmlAdapter.compare(makeInput(metadataLeft, incomingUnknown));
    assert.strictEqual(insertResult.candidateFactories.size, 0);
    assert.ok(collectNodes(insertResult.nodes).some((node) => node.status === 'rightOnly' && node.mergeState?.state === 'readOnly'));

    const deleteResult = await metadataXmlAdapter.compare(makeInput(incomingUnknown, metadataLeft));
    assert.strictEqual(deleteResult.candidateFactories.size, 0);
    assert.ok(collectNodes(deleteResult.nodes).some((node) => node.status === 'leftOnly' && node.mergeState?.state === 'readOnly'));

    const unknownComplex = metadataLeft.replace(
      '<ChildObjects/>',
      '<ChildObjects><Attribute uuid="attribute-1"><Properties><Name>NewAttribute</Name><FutureDetails><Value>opaque</Value></FutureDetails></Properties></Attribute></ChildObjects>'
    );
    const unknownComplexResult = await metadataXmlAdapter.compare(makeInput(metadataLeft, unknownComplex));
    assert.strictEqual(unknownComplexResult.candidateFactories.size, 0);
    assert.ok(collectNodes(unknownComplexResult.nodes).some((node) => node.status === 'rightOnly' && node.mergeState?.state === 'readOnly'));

    const formLeft = '<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.20"><Attributes/><Commands/><ChildItems/></Form>';
    const formWithEvent = formLeft.replace(
      '<ChildItems/>',
      '<ChildItems><InputField name="NewField" id="10"><Events><Event name="OnChange">NewFieldOnChange</Event></Events></InputField></ChildItems>'
    );
    const formResult = await formXmlAdapter.compare(makeInput(formLeft, formWithEvent));
    assert.strictEqual(formResult.candidateFactories.size, 0);
    assert.ok(collectNodes(formResult.nodes).some((node) => node.status === 'rightOnly' && node.mergeState?.state === 'readOnly'));

    const qualifierLeft = '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:evil="http://v8.1c.ru/unsupported"><Catalog><Properties><Name>Products</Name></Properties><ChildObjects><Attribute uuid="attribute-1"><Properties><Name>Value</Name><Type><v8:Type>xs:string</v8:Type><v8:StringQualifiers><v8:Length>20</v8:Length></v8:StringQualifiers></Type></Properties></Attribute></ChildObjects></Catalog></MetaDataObject>';
    const qualifierWithUnknown = qualifierLeft
      .replace('<v8:Length>20</v8:Length>', '<v8:Length>40</v8:Length><evil:ExtraQualifier>unverified</evil:ExtraQualifier>');
    const qualifierResult = await metadataXmlAdapter.compare(makeInput(qualifierLeft, qualifierWithUnknown));
    const qualifiers = requireNode(qualifierResult.nodes, 'v8:StringQualifiers');
    assert.strictEqual(qualifiers.mergeState?.state, 'readOnly');
    assert.strictEqual(qualifierResult.candidateFactories.has(qualifiers.id), false);
  });

  test('blocks inserted or deleted scalar leaves with unsupported attributes but preserves unchanged attributes', async () => {
    const base = '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:evil="http://v8.1c.ru/unsupported"><Catalog><Properties><Name>Products</Name></Properties></Catalog></MetaDataObject>';
    const withUnsupportedAttribute = base.replace(
      '<Name>Products</Name>',
      '<Name>Products</Name><Comment evil:marker="opaque">Text</Comment>'
    );
    for (const [left, right] of [[base, withUnsupportedAttribute], [withUnsupportedAttribute, base]] as const) {
      const result = await metadataXmlAdapter.compare(makeInput(left, right));
      assert.strictEqual(result.candidateFactories.size, 0);
      assert.ok(collectNodes(result.nodes).some((node) => node.label === 'Comment' && node.mergeState?.state === 'readOnly'));
    }

    const existing = base.replace('<Name>Products</Name>', '<Name>Products</Name><Comment evil:marker="opaque">Before</Comment>');
    const result = await metadataXmlAdapter.compare(makeInput(existing, existing.replace('Before', 'After')));
    const comment = requireNode(result.nodes, 'Comment');
    const candidate = await result.candidateFactories.get(comment.id)!();
    assert.strictEqual(candidate.ok, true);
    assert.match(applyXmlPatch(existing, candidate.candidate.xmlPatch!), /evil:marker="opaque"[^>]*>After/u);
  });

  test('allows a second merge of a leaf with a redundant inherited namespace declaration', async () => {
    const target = '<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.20"><WindowTitle>Before</WindowTitle><Attributes/><Commands/><ChildItems/></Form>';
    const firstSource = target.replace('Before', 'First');
    const first = await formXmlAdapter.compare(makeInput(target, firstSource));
    const firstLeaf = requireNode(first.nodes, 'WindowTitle');
    const firstCandidate = await first.candidateFactories.get(firstLeaf.id)!();
    assert.strictEqual(firstCandidate.ok, true);
    const firstApplied = applyXmlPatch(target, firstCandidate.candidate.xmlPatch!);
    assert.match(firstApplied, /<WindowTitle xmlns="http:\/\/v8\.1c\.ru\/8\.3\/xcf\/logform">First<\/WindowTitle>/u);

    const secondSource = firstSource.replace('First', 'Second');
    const second = await formXmlAdapter.compare(makeInput(firstApplied, secondSource));
    const secondLeaf = requireNode(second.nodes, 'WindowTitle');
    assert.strictEqual(secondLeaf.mergeState?.state, 'ready');
    const secondCandidate = await second.candidateFactories.get(secondLeaf.id)!();
    assert.strictEqual(secondCandidate.ok, true);
    assert.match(applyXmlPatch(firstApplied, secondCandidate.candidate.xmlPatch!), /<WindowTitle(?: xmlns="http:\/\/v8\.1c\.ru\/8\.3\/xcf\/logform")?>Second<\/WindowTitle>/u);
  });

  test('blocks namespace rebinding when an unchanged unknown attribute uses the prefix', async () => {
    const left = '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:evil="urn:before"><Catalog><Properties><Name>Products</Name><Comment evil:marker="same">Before</Comment></Properties></Catalog></MetaDataObject>';
    const right = left.replace('xmlns:evil="urn:before"', 'xmlns:evil="urn:after"').replace('>Before</Comment>', '>After</Comment>');
    const result = await metadataXmlAdapter.compare(makeInput(left, right));
    const comment = requireNode(result.nodes, 'Comment');
    assert.strictEqual(comment.mergeState?.state, 'readOnly');
    assert.strictEqual(result.candidateFactories.has(comment.id), false);
  });

  test('keeps real native Form.xml and Predefined.xml namespaces selectable', async () => {
    const fixtureRoot = path.join(process.cwd(), 'test', 'fixtures', 'compareMerge', 'extensions', 'native-2.20', 'managed-form-base');
    const nativeFormPath = path.join(fixtureRoot, 'Catalogs', 'Справочник55', 'Forms', 'Matrix_858451263b1b_a1_mo2z8b69_1b', 'Ext', 'Form.xml');
    const nativeForm = fs.readFileSync(nativeFormPath, 'utf8');
    const changedForm = nativeForm.replace('<AutoTitle>false</AutoTitle>', '<AutoTitle>true</AutoTitle>');
    const formResult = await formXmlAdapter.compare(makeInput(nativeForm, changedForm));
    const autoTitle = requireNode(formResult.nodes, 'AutoTitle');
    assert.strictEqual(autoTitle.mergeState?.state, 'ready');
    assert.strictEqual(formResult.candidateFactories.has(autoTitle.id), true);

    const nativePredefinedPath = path.join(fixtureRoot, 'Catalogs', 'Справочник55', 'Ext', 'Predefined.xml');
    const nativePredefined = fs.readFileSync(nativePredefinedPath, 'utf8');
    const changedPredefined = nativePredefined.replace('Native fixture item', 'Updated fixture item');
    const predefinedResult = await predefinedXmlAdapter.compare(makeInput(nativePredefined, changedPredefined));
    const description = requireNode(predefinedResult.nodes, 'Description');
    assert.strictEqual(description.mergeState?.state, 'ready');
    assert.strictEqual(predefinedResult.candidateFactories.has(description.id), true);
  });

  test('rejects malformed scalar qualifier bounds', () => {
    const invalid = validateSemanticXmlMerge(
      '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xs="http://www.w3.org/2001/XMLSchema"><Catalog><Properties><Type><v8:Type>xs:decimal</v8:Type><v8:NumberQualifiers><v8:Digits>4</v8:Digits><v8:FractionDigits>5</v8:FractionDigits></v8:NumberQualifiers></Type></Properties></Catalog></MetaDataObject>',
      'metadataXml'
    );
    assert.strictEqual(invalid.valid, false);
    assert.ok(invalid.diagnostics.some((item) => item.code === 'XML_TYPE_QUALIFIER_BOUNDS'));
  });

  test('keeps event handler edits read-only without the form BSL module', async () => {
    const left = '<Form version="2.20"><Attributes/><Commands/><ChildItems><InputField name="Field" id="1"><Events><Event name="OnChange">OldHandler</Event></Events></InputField></ChildItems></Form>';
    const right = left.replace('OldHandler', 'NewHandler');
    const result = await formXmlAdapter.compare(makeInput(left, right));
    const event = requireNode(result.nodes, 'Событие: OnChange');
    assert.strictEqual(event.mergeState?.state, 'readOnly');
    assert.match(event.mergeState?.reason ?? '', /BSL/iu);
  });

  test('allows deleting a form event reference without proving its BSL handler', async () => {
    const left = '<Form version="2.20"><Attributes/><Commands/><ChildItems><InputField name="Field" id="1"><Events><Event name="OnOpen">MissingHandler</Event></Events></InputField></ChildItems></Form>';
    const right = '<Form version="2.20"><Attributes/><Commands/><ChildItems><InputField name="Field" id="1"><Events/></InputField></ChildItems></Form>';
    const result = await formXmlAdapter.compare(makeInput(left, right));
    const event = requireNode(result.nodes, 'Событие: OnOpen', (node) => node.leftValue === 'MissingHandler');

    assert.strictEqual(event.mergeState?.state, 'ready');
    const candidate = await result.candidateFactories.get(event.id)!();
    assert.strictEqual(candidate.ok, true);
    if (candidate.ok) {
      assert.strictEqual(candidate.candidate.xmlPatch?.kind, 'deleteNode');
    }
  });

  test('keeps a deleted Events wrapper read-only while exposing its Event deletion without BSL proof', async () => {
    const left = '<Form version="2.20"><Attributes/><Commands/><ChildItems><InputField name="Field" id="1"><Events><Event name="OnOpen">UnusedHandler</Event></Events></InputField></ChildItems></Form>';
    const right = '<Form version="2.20"><Attributes/><Commands/><ChildItems><InputField name="Field" id="1"/></ChildItems></Form>';
    const result = await formXmlAdapter.compare(makeInput(left, right));
    const events = requireNode(result.nodes, 'Events');

    assert.strictEqual(events.mergeState?.state, 'readOnly');
    assert.strictEqual(events.mergeable, false);
    const event = collectNodes(events.children).find((node) => node.label === 'Событие: OnOpen');
    assert.ok(event, 'the Event itself must remain separately selectable');
    assert.strictEqual(event!.mergeState?.state, 'ready');
    const candidate = await result.candidateFactories.get(event!.id)!();
    assert.strictEqual(candidate.ok, true);
    if (candidate.ok) {
      assert.strictEqual(candidate.candidate.xmlPatch?.kind, 'deleteNode');
    }
  });

  test('labels distinct form event references by their event name', async () => {
    const left = '<Form version="2.20"><Attributes/><Commands/><ChildItems><InputField name="Field" id="1"><Events><Event name="OnOpen">OpenHandler</Event><Event name="BeforeClose">CloseHandler</Event></Events></InputField></ChildItems></Form>';
    const right = '<Form version="2.20"><Attributes/><Commands/><ChildItems><InputField name="Field" id="1"><Events><Event name="OnOpen">IncomingOpen</Event><Event name="BeforeClose">IncomingClose</Event></Events></InputField></ChildItems></Form>';
    const result = await formXmlAdapter.compare(makeInput(left, right));

    assert.strictEqual(requireNode(result.nodes, 'Событие: OnOpen').mergeState?.state, 'readOnly');
    assert.strictEqual(requireNode(result.nodes, 'Событие: BeforeClose').mergeState?.state, 'readOnly');
  });

  test('allows deleting a visual subtree that contains event references without proving their BSL handlers', async () => {
    const left = '<Form version="2.20"><Attributes/><Commands/><ChildItems><UsualGroup name="Group" id="10"><ChildItems><InputField name="Field" id="11"><Events><Event name="OnOpen">UnusedHandler</Event></Events></InputField></ChildItems></UsualGroup></ChildItems></Form>';
    const right = '<Form version="2.20"><Attributes/><Commands/><ChildItems/></Form>';
    const result = await formXmlAdapter.compare(makeInput(left, right));
    const group = requireNode(result.nodes, 'Group');

    assert.strictEqual(group.mergeState?.state, 'ready');
    const candidate = await result.candidateFactories.get(group.id)!();
    assert.strictEqual(candidate.ok, true);
    if (candidate.ok) {
      assert.strictEqual(candidate.candidate.xmlPatch?.kind, 'deleteNode');
    }
  });

  test('blocks form registrations and default-form references without their file-backed artifacts', async () => {
    const left = '<MetaDataObject><Catalog uuid="11111111-1111-4111-8111-111111111111"><Properties><Name>Products</Name><DefaultObjectForm>Catalog.Products.Form.Old</DefaultObjectForm></Properties><ChildObjects><Form>Old</Form></ChildObjects></Catalog></MetaDataObject>';
    const right = left.replace('Catalog.Products.Form.Old', 'Catalog.Products.Form.New').replace('<Form>Old</Form>', '<Form>New</Form>');
    const result = await metadataXmlAdapter.compare(makeInput(left, right));
    const registration = requireNode(result.nodes, 'Форма: New');
    const defaultForm = requireNode(result.nodes, 'DefaultObjectForm');
    assert.strictEqual(registration.mergeState?.state, 'readOnly');
    assert.match(registration.mergeState?.reason ?? '', /вместе с дескриптором и файлами/iu);
    assert.strictEqual(defaultForm.mergeState?.state, 'readOnly');
    assert.strictEqual(result.candidateFactories.size, 0);
  });

  test('requires the exact MDClasses namespace before a default-form capability can select a reference', async () => {
    const md = 'http://v8.1c.ru/8.3/MDClasses';
    const core = 'http://v8.1c.ru/8.2/managed-application/core';
    const left = `<MetaDataObject xmlns="${md}" xmlns:core="${core}"><Catalog uuid="catalog-1"><Properties><Name>Products</Name><DefaultListForm>Catalog.Products.Form.Old</DefaultListForm><core:DefaultListForm>foreign-old</core:DefaultListForm></Properties></Catalog></MetaDataObject>`;
    const right = left.replace('Catalog.Products.Form.Old', 'Catalog.Products.Form.Main').replace('foreign-old', 'foreign-new');
    const input = makeInput(left, right);
    input.linkedDesignerContext = {
      registrations: [],
      defaultObjectForms: [{
        propertyName: 'DefaultListForm',
        value: 'Catalog.Products.Form.Main',
        targetFormComplete: true,
        packageId: 'form-main',
      }],
      formEventHandlers: [],
    };

    const result = await metadataXmlAdapter.compare(input);
    const selectedReferences = collectNodes(result.nodes).filter((node) => node.mergeable &&
      node.rightValue === 'Catalog.Products.Form.Main');
    assert.strictEqual(selectedReferences.length, 1);
    const selected = await result.candidateFactories.get(selectedReferences[0]!.id)!();
    assert.strictEqual(selected.ok, true);
    assert.strictEqual(collectNodes(result.nodes).some((node) => node.mergeable && node.rightValue === 'foreign-new'), false);
  });

  test('allows clearing a default form reference without transferring another form', async () => {
    const left = '<MetaDataObject><Catalog uuid="11111111-1111-4111-8111-111111111111"><Properties><Name>Products</Name><DefaultObjectForm>Catalog.Products.Form.Old</DefaultObjectForm></Properties></Catalog></MetaDataObject>';
    const right = left.replace('<DefaultObjectForm>Catalog.Products.Form.Old</DefaultObjectForm>', '<DefaultObjectForm/>');
    const result = await metadataXmlAdapter.compare(makeInput(left, right));
    const defaultForm = requireNode(result.nodes, 'DefaultObjectForm');

    assert.strictEqual(defaultForm.mergeState?.state, 'ready');
    const candidate = await result.candidateFactories.get(defaultForm.id)!();
    assert.strictEqual(candidate.ok, true);
    if (candidate.ok) {
      assert.strictEqual(candidate.candidate.xmlPatch?.kind, 'replaceNode');
      assert.strictEqual(candidate.candidate.xmlPatch?.replacementXml, '<DefaultObjectForm/>');
    }
  });

  test('merges a scalar on same-name CF roots without replacing the target UUID and keeps CFE roots strict', async () => {
    const left = '<MetaDataObject><Catalog uuid="left"><Properties><Name>Products</Name><Synonym>Old</Synonym></Properties></Catalog></MetaDataObject>';
    const right = '<MetaDataObject><Catalog uuid="right"><Properties><Name>Products</Name><Synonym>New</Synonym></Properties></Catalog></MetaDataObject>';
    const result = await metadataXmlAdapter.compare(makeInput(left, right));
    const synonym = requireNode(result.nodes, 'Synonym');
    const candidate = await result.candidateFactories.get(synonym.id)!();
    assert.strictEqual(candidate.ok, true);
    const applied = applyXmlPatch(left, candidate.candidate.xmlPatch!);
    assert.match(applied, /<Catalog uuid="left">/);
    assert.match(applied, /<Synonym>New<\/Synonym>/);

    const cfeLeft = left.replace('<Properties>', '<Properties><ObjectBelonging>Adopted</ObjectBelonging><ExtendedConfigurationObject>base-id</ExtendedConfigurationObject>');
    const cfeRight = right.replace('<Properties>', '<Properties><ObjectBelonging>Adopted</ObjectBelonging><ExtendedConfigurationObject>base-id</ExtendedConfigurationObject>');
    const cfe = await metadataXmlAdapter.compare(makeInput(cfeLeft, cfeRight));
    assert.strictEqual(cfe.candidateFactories.size, 0);
    assert.ok(cfe.diagnostics.some((item) => item.code === 'XML_METADATA_IDENTITY_MISMATCH'));
  });

  test('projects EnumValue display order as selectable target-side moves and preserves target-only siblings', async () => {
    const targetA = enumValue('A', 'Target A', 'Target comment')
      .replace('</EnumValue>', '<x:FutureChild marker="target">opaque</x:FutureChild></EnumValue>');
    const target = enumDescriptor([
      targetA,
      enumValue('TargetOnly', 'TargetOnly', 'Keep this value'),
      enumValue('B', 'Target B'),
    ]);
    const source = enumDescriptor([
      enumValue('B', 'Target B'),
      enumValue('A', 'Target A', 'Target comment'),
    ]);
    const result = await metadataXmlAdapter.compare(makeEnumInput(target, source));
    const moves = collectNodes(result.nodes).filter((node) => node.kind === 'metadataOrderMove');

    assert.deepStrictEqual(moves.map((node) => node.label), ['Порядок значения: Target A']);
    const move = moves[0]!;
    assert.strictEqual(move.mergeable, true);
    assert.strictEqual(move.leftValue, 'Statuses → позиция 1');
    assert.strictEqual(move.rightValue, 'Statuses → в конец');
    const generated = await result.candidateFactories.get(move.id)!();
    assert.strictEqual(generated.ok, true);
    if (!generated.ok) {return;}
    assert.strictEqual(generated.candidate.kind, 'xmlNodeMove');
    assert.strictEqual(generated.candidate.xmlPatch?.semanticKind, 'metadataXml');
    assert.strictEqual(generated.candidate.xmlPatch?.insertPosition, 'append');
    assert.match(generated.candidate.xmlPatch?.target.pointer ?? '', /EnumValue\[uuid%3D/u);

    const applied = applyXmlPatchBatch(target, [generated.candidate.xmlPatch!]);
    const parsed = parseXmlDocument(applied).root;
    const enumNode = elementChildren(parsed).find((element) => element.localName === 'Enum')!;
    const container = elementChildren(enumNode).find((element) => element.localName === 'ChildObjects')!;
    assert.deepStrictEqual(elementChildren(container).map((element) => element.attributes.find((attribute) => attribute.localName === 'uuid')?.value ?? element.localName), [
      'c0000000-0000-4000-8000-000000000003',
      'b0000000-0000-4000-8000-000000000002',
      'a0000000-0000-4000-8000-000000000001',
    ]);
    assert.match(applied, /<Comment>Keep this value<\/Comment>/u);
    const movedA = elementChildren(container).find((element) => element.attributes.some((attribute) => attribute.value === 'a0000000-0000-4000-8000-000000000001'))!;
    assert.ok(elementChildren(movedA).some((element) => element.localName === 'FutureChild'), 'the moved target subtree keeps its unknown descendant');
    assert.match(applied, /<Comment>Target comment<\/Comment>/u);
    assert.doesNotMatch(applied, /Source A/u, 'moving an EnumValue must retain its target subtree');
  });

  test('keeps EnumValue ordering read-only when the host denies metadata order capability', async () => {
    const target = enumDescriptor([enumValue('A', 'A'), enumValue('B', 'B')]);
    const source = enumDescriptor([enumValue('B', 'B'), enumValue('A', 'A')]);
    const input = makeEnumInput(target, source);
    input.allowMetadataChildOrder = false;
    const result = await metadataXmlAdapter.compare(input);
    const order = collectNodes(result.nodes).find((node) => node.kind === 'xmlOrder');

    assert.ok(order, 'the inherited owner order remains visible as a read-only order row');
    assert.strictEqual(order.mergeable, false);
    assert.strictEqual(order.mergeState?.state, 'readOnly');
    assert.strictEqual(result.candidateFactories.size, 0);
  });

  test('applies multiple EnumValue moves independently of selected-node order and composes a value edit', async () => {
    const target = enumDescriptor([
      enumValue('A', 'A', 'Old A'),
      enumValue('B', 'B'),
      enumValue('C', 'C'),
      enumValue('D', 'D'),
    ]);
    const source = enumDescriptor([
      enumValue('C', 'C'),
      enumValue('B', 'B'),
      enumValue('A', 'A', 'New A'),
      enumValue('D', 'D'),
    ]);
    const result = await metadataXmlAdapter.compare(makeEnumInput(target, source));
    const moves = collectNodes(result.nodes).filter((node) => node.kind === 'metadataOrderMove');
    assert.deepStrictEqual(moves.map((node) => node.label), ['Порядок значения: B', 'Порядок значения: A']);
    const generated = await Promise.all(moves.map((node) => result.candidateFactories.get(node.id)!()));
    assert.ok(generated.every((candidate) => candidate.ok));
    if (generated.some((candidate) => !candidate.ok)) {return;}
    const scalar = requireNode(result.nodes, 'Comment', (node) => node.rightValue === 'New A');
    const scalarCandidate = await result.candidateFactories.get(scalar.id)!();
    assert.strictEqual(scalarCandidate.ok, true);
    if (!scalarCandidate.ok) {return;}
    const patches = [
      ...generated.map((candidate) => candidate.candidate.xmlPatch!),
      scalarCandidate.candidate.xmlPatch!,
    ];
    const applied = applyXmlPatchBatch(target, patches.reverse());
    const enumNode = elementChildren(parseXmlDocument(applied).root).find((element) => element.localName === 'Enum')!;
    const container = elementChildren(enumNode).find((element) => element.localName === 'ChildObjects')!;
    assert.deepStrictEqual(elementChildren(container).map((element) => element.attributes.find((attribute) => attribute.localName === 'uuid')?.value), [
      'c0000000-0000-4000-8000-000000000003',
      'b0000000-0000-4000-8000-000000000002',
      'a0000000-0000-4000-8000-000000000001',
      'd0000000-0000-4000-8000-000000000004',
    ]);
    assert.match(applied, /<Comment(?:\s[^>]*)?>New A<\/Comment>/u);
  });

  test('composes a selected EnumValue insertion around a moved anchor without order-sensitive placement', async () => {
    const target = enumDescriptor([enumValue('A', 'A'), enumValue('B', 'B')]);
    const source = enumDescriptor([enumValue('B', 'B'), enumValue('N', 'New'), enumValue('A', 'A')]);
    const result = await metadataXmlAdapter.compare(makeEnumInput(target, source));
    const moveNode = requireNode(result.nodes, 'Порядок значения: A');
    const insertNode = requireNode(result.nodes, 'New');
    const moveResult = await result.candidateFactories.get(moveNode.id)!();
    const insertResult = await result.candidateFactories.get(insertNode.id)!();
    assert.strictEqual(moveResult.ok, true);
    assert.strictEqual(insertResult.ok, true);
    if (!moveResult.ok || !insertResult.ok) {return;}

    const selected = [moveResult.candidate.xmlPatch!, insertResult.candidate.xmlPatch!];
    for (const patches of [selected, [...selected].reverse()]) {
      const merged = applySelectedXmlPatches(target, patches);
      assert.strictEqual(merged.ok, true, merged.ok ? '' : merged.message);
      if (!merged.ok) {return;}
      const container = findElement(findElement(parseXmlDocument(merged.source).root, 'Enum'), 'ChildObjects');
      assert.deepStrictEqual(elementChildren(container).map((element) => element.attributes.find((attribute) => attribute.localName === 'uuid')?.value), [
        'b0000000-0000-4000-8000-000000000002',
        'e0000000-0000-4000-8000-000000000005',
        'a0000000-0000-4000-8000-000000000001',
      ]);
    }

    const onlyMove = applySelectedXmlPatches(target, [moveResult.candidate.xmlPatch!]);
    assert.strictEqual(onlyMove.ok, true, onlyMove.ok ? '' : onlyMove.message);
    if (!onlyMove.ok) {return;}
    const moveOnlyContainer = findElement(findElement(parseXmlDocument(onlyMove.source).root, 'Enum'), 'ChildObjects');
    assert.deepStrictEqual(elementChildren(moveOnlyContainer).map((element) => element.attributes.find((attribute) => attribute.localName === 'uuid')?.value), [
      'b0000000-0000-4000-8000-000000000002',
      'a0000000-0000-4000-8000-000000000001',
    ]);
    assert.doesNotMatch(onlyMove.source, /<Name>New<\/Name>/u);

    const onlyInsert = applySelectedXmlPatches(target, [insertResult.candidate.xmlPatch!]);
    assert.strictEqual(onlyInsert.ok, true, onlyInsert.ok ? '' : onlyInsert.message);
    if (!onlyInsert.ok) {return;}
    const insertOnlyContainer = findElement(findElement(parseXmlDocument(onlyInsert.source).root, 'Enum'), 'ChildObjects');
    assert.deepStrictEqual(elementChildren(insertOnlyContainer).map((element) => element.attributes.find((attribute) => attribute.localName === 'uuid')?.value), [
      'e0000000-0000-4000-8000-000000000005',
      'a0000000-0000-4000-8000-000000000001',
      'b0000000-0000-4000-8000-000000000002',
    ]);

    const targetWithUnselectedSibling = enumDescriptor([
      enumValue('A', 'A'), enumValue('TargetOnly', 'Target only'), enumValue('B', 'B'),
    ]);
    const preservedResult = await metadataXmlAdapter.compare(makeEnumInput(targetWithUnselectedSibling, source));
    const preservedMoveNode = requireNode(preservedResult.nodes, 'Порядок значения: A');
    const preservedInsertNode = requireNode(preservedResult.nodes, 'New');
    const preservedMove = await preservedResult.candidateFactories.get(preservedMoveNode.id)!();
    const preservedInsert = await preservedResult.candidateFactories.get(preservedInsertNode.id)!();
    assert.strictEqual(preservedMove.ok, true);
    assert.strictEqual(preservedInsert.ok, true);
    if (!preservedMove.ok || !preservedInsert.ok) {return;}
    const preserved = applySelectedXmlPatches(targetWithUnselectedSibling, [
      preservedInsert.candidate.xmlPatch!, preservedMove.candidate.xmlPatch!,
    ]);
    assert.strictEqual(preserved.ok, true, preserved.ok ? '' : preserved.message);
    if (!preserved.ok) {return;}
    const preservedContainer = findElement(findElement(parseXmlDocument(preserved.source).root, 'Enum'), 'ChildObjects');
    assert.deepStrictEqual(elementChildren(preservedContainer).map((element) => element.attributes.find((attribute) => attribute.localName === 'uuid')?.value), [
      'c0000000-0000-4000-8000-000000000003',
      'b0000000-0000-4000-8000-000000000002',
      'e0000000-0000-4000-8000-000000000005',
      'a0000000-0000-4000-8000-000000000001',
    ]);
  });

  test('keeps EnumValue order read-only for missing UUID identities and foreign namespace impostors', async () => {
    const namespace = 'http://v8.1c.ru/8.3/MDClasses';
    const malformedLeft = `<MetaDataObject xmlns="${namespace}" version="2.20"><Enum uuid="e0000000-0000-4000-8000-000000000000"><Properties><Name>Statuses</Name></Properties><ChildObjects><EnumValue uuid="a0000000-0000-4000-8000-000000000001"><Properties><Name>A</Name></Properties></EnumValue><EnumValue><Properties><Name>B</Name></Properties></EnumValue></ChildObjects></Enum></MetaDataObject>`;
    const malformedRight = malformedLeft.replace('</ChildObjects>', '<EnumValue uuid="a0000000-0000-4000-8000-000000000001"><Properties><Name>A</Name></Properties></EnumValue></ChildObjects>');
    const malformed = await metadataXmlAdapter.compare(makeEnumInput(malformedLeft, malformedRight));
    assert.strictEqual(collectNodes(malformed.nodes).some((node) => node.kind === 'metadataOrderMove' && node.mergeable), false);

    const target = enumDescriptor([
      enumValue('A', 'A'),
      enumValue('B', 'B'),
      enumValue('Foreign', 'Foreign'),
    ], '<x:EnumValue uuid="f0000000-0000-4000-8000-000000000005"><x:Properties><x:Name>Foreign</x:Name></x:Properties></x:EnumValue>');
    const source = enumDescriptor([enumValue('B', 'B'), enumValue('A', 'A')]);
    const foreign = await metadataXmlAdapter.compare(makeEnumInput(target, source));
    const moveNodes = collectNodes(foreign.nodes).filter((node) => node.kind === 'metadataOrderMove');
    assert.ok(moveNodes.every((node) => !node.payloadRef?.includes('uuid%3Df0000000')));
    assert.ok(collectNodes(foreign.nodes).some((node) => node.mergeState?.state === 'readOnly' && /namespace|пространств/u.test(node.mergeState.reason ?? '')));
  });

  test('blocks same-name nested metadata objects with different UUIDs and validates native identities', async () => {
    for (const childType of ['Attribute', 'Dimension', 'Resource', 'TabularSection']) {
      const left = `<MetaDataObject version="2.20"><Catalog uuid="11111111-1111-4111-8111-111111111111"><Properties><Name>Products</Name></Properties><ChildObjects><${childType} uuid="22222222-2222-4222-8222-222222222222"><Properties><Name>Same</Name></Properties></${childType}></ChildObjects></Catalog></MetaDataObject>`;
      const right = left.replace('</ChildObjects>', `<${childType} uuid="33333333-3333-4333-8333-333333333333"><Properties><Name>Same</Name></Properties></${childType}></ChildObjects>`);
      const result = await metadataXmlAdapter.compare(makeInput(left, right));
      const incoming = collectNodes(result.nodes).find((node) =>
        node.mergeState?.state === 'readOnly' && /другим UUID/iu.test(node.mergeState.reason ?? '')
      );
      assert.ok(incoming, `${childType} duplicate name should remain visible but read-only`);
      assert.match(incoming.mergeState?.reason ?? '', /другим UUID/iu);
      assert.strictEqual(result.candidateFactories.size, 0);
    }

    const malformedUuid = validateSemanticXmlMerge(
      '<MetaDataObject version="2.20"><Catalog uuid="11111111-1111-4111-8111-111111111111"><Properties><Name>Products</Name></Properties><ChildObjects><Attribute uuid="bad"><Properties><Name>Value</Name></Properties></Attribute></ChildObjects></Catalog></MetaDataObject>',
      'metadataXml'
    );
    assert.ok(malformedUuid.diagnostics.some((item) => item.code === 'XML_METADATA_INVALID_UUID'));

    const duplicateName = validateSemanticXmlMerge(
      '<MetaDataObject version="2.20"><Catalog uuid="11111111-1111-4111-8111-111111111111"><Properties><Name>Products</Name></Properties><ChildObjects><Attribute uuid="22222222-2222-4222-8222-222222222222"><Properties><Name>Value</Name></Properties></Attribute><Attribute uuid="33333333-3333-4333-8333-333333333333"><Properties><Name>Value</Name></Properties></Attribute></ChildObjects></Catalog></MetaDataObject>',
      'metadataXml'
    );
    assert.ok(duplicateName.diagnostics.some((item) => item.code === 'XML_METADATA_DUPLICATE_NAME'));
  });

  test('validates cross-type register field names and nested tabular-section metadata identities', async () => {
    const root = '<MetaDataObject version="2.20"><AccountingRegister uuid="11111111-1111-4111-8111-111111111111"><Properties><Name>Turnovers</Name></Properties><ChildObjects>CONTENT</ChildObjects></AccountingRegister></MetaDataObject>';
    const registerFieldCollisions = [
      '<Dimension uuid="22222222-2222-4222-8222-222222222222"><Properties><Name>Period</Name></Properties></Dimension><Resource uuid="33333333-3333-4333-8333-333333333333"><Properties><Name>Period</Name></Properties></Resource>',
      '<Resource uuid="22222222-2222-4222-8222-222222222222"><Properties><Name>Total</Name></Properties></Resource><Dimension uuid="33333333-3333-4333-8333-333333333333"><Properties><Name>Total</Name></Properties></Dimension>',
    ];
    for (const fields of registerFieldCollisions) {
      const duplicate = validateSemanticXmlMerge(root.replace('CONTENT', fields), 'metadataXml');
      assert.ok(duplicate.diagnostics.some((item) => item.code === 'XML_METADATA_DUPLICATE_NAME'));
    }

    const left = root.replace(
      'CONTENT',
      '<Dimension uuid="22222222-2222-4222-8222-222222222222"><Properties><Name>SharedField</Name></Properties></Dimension>'
    );
    const right = left.replace(
      '</ChildObjects>',
      '<Resource uuid="33333333-3333-4333-8333-333333333333"><Properties><Name>SharedField</Name></Properties></Resource></ChildObjects>'
    );
    const projected = await metadataXmlAdapter.compare(makeInput(left, right));
    const incoming = collectNodes(projected.nodes).find((node) =>
      node.status === 'rightOnly' && node.mergeState?.state === 'readOnly' && /другим UUID/iu.test(node.mergeState.reason ?? '')
    );
    assert.ok(incoming);
    assert.strictEqual(incoming.mergeState?.state, 'readOnly');
    assert.match(incoming.mergeState?.reason ?? '', /другим UUID/iu);

    for (const childType of ['Dimension', 'Resource'] as const) {
      const malformed = validateSemanticXmlMerge(
        root.replace('CONTENT', `<${childType} uuid="invalid"><Properties><Name>BadIdentity</Name></Properties></${childType}>`),
        'metadataXml'
      );
      assert.ok(malformed.diagnostics.some((item) => item.code === 'XML_METADATA_INVALID_UUID'), childType);
    }

    const nestedDuplicate = validateSemanticXmlMerge(
      root.replace(
        'CONTENT',
        '<TabularSection uuid="22222222-2222-4222-8222-222222222222"><Properties><Name>Lines</Name></Properties><ChildObjects><Attribute uuid="33333333-3333-4333-8333-333333333333"><Properties><Name>Amount</Name></Properties></Attribute><Attribute uuid="44444444-4444-4444-8444-444444444444"><Properties><Name>Amount</Name></Properties></Attribute></ChildObjects></TabularSection>'
      ),
      'metadataXml'
    );
    assert.ok(nestedDuplicate.diagnostics.some((item) => item.code === 'XML_METADATA_DUPLICATE_NAME'));
  });

  test('isolates borrowed BaseForm snapshot IDs, validates numeric native IDs, and keeps BaseForm read-only', async () => {
    const borrowed = '<Form version="2.20"><AutoCommandBar name="OwnBar" id="-1"/><Attributes><Attribute name="OwnData" id="1"/></Attributes><Commands/><ChildItems><InputField name="OwnField" id="5"/></ChildItems><BaseForm version="2.20"><AutoCommandBar name="BaseBar" id="-1"/><Attributes><Attribute name="BaseData" id="1"/></Attributes><ChildItems><InputField name="BaseField" id="5"/></ChildItems></BaseForm></Form>';
    assert.strictEqual(validateSemanticXmlMerge(borrowed, 'formXml').valid, true);

    const duplicateOuterId = borrowed.replace(
      '<InputField name="OwnField" id="5"/>',
      '<InputField name="OwnField" id="5"/><Table name="SecondOwnField" id="5"/>'
    );
    const duplicate = validateSemanticXmlMerge(duplicateOuterId, 'formXml');
    assert.ok(duplicate.diagnostics.some((item) => item.code === 'XML_FORM_DUPLICATE_ID'));

    const invalidNumericId = validateSemanticXmlMerge(
      '<Form version="2.20"><Attributes><Attribute name="BadId" id="FieldId"/></Attributes><Commands/><ChildItems/></Form>',
      'formXml'
    );
    assert.ok(invalidNumericId.diagnostics.some((item) => item.code === 'XML_FORM_INVALID_ID'));
    assert.strictEqual(validateSemanticXmlMerge('<Form><Attributes><Attribute name="Legacy" id="field-id"/></Attributes><Commands/><ChildItems/></Form>', 'formXml').valid, true);

    const malformedShapes = [
      borrowed.replace('<BaseForm version="2.20">', '<BaseForm version="2.19">'),
      borrowed.replace('</Form>', '<ChildItems/></Form>'),
      borrowed.replace('<BaseForm version="2.20">', '<BaseForm version="2.20"><Commands/>'),
      borrowed.replace('</Form>', '<BaseForm version="2.20"/></Form>'),
    ];
    for (const malformed of malformedShapes) {
      const invalidShape = validateSemanticXmlMerge(malformed, 'formXml', { baselineSource: borrowed });
      assert.strictEqual(invalidShape.valid, false);
      assert.ok(invalidShape.diagnostics.some((item) => item.code === 'XML_FORM_BASEFORM_SHAPE'));
    }

    const source = borrowed.replace('BaseField" id="5"', 'BaseField" id="6"');
    const projected = await formXmlAdapter.compare(makeInput(borrowed, source));
    const base = requireNode(projected.nodes, 'BaseForm');
    assert.strictEqual(base.mergeState?.state, 'readOnly');
    assert.match(base.mergeState?.reason ?? '', /только для чтения/iu);
    assert.strictEqual(projected.candidateFactories.size, 0);
  });

  test('blocks semantic property transfers across supported XML format versions', async () => {
    const left = '<MetaDataObject version="2.17"><Catalog uuid="11111111-1111-4111-8111-111111111111"><Properties><Name>Products</Name><Synonym>Old</Synonym></Properties></Catalog></MetaDataObject>';
    const right = left.replace('2.17', '2.21').replace('>Old</Synonym>', '>New</Synonym>');
    const validation = validateSemanticXmlMerge(right, 'metadataXml', { baselineSource: left });
    assert.strictEqual(validation.valid, false);
    assert.ok(validation.diagnostics.some((item) => item.code === 'XML_FORMAT_VERSION_MISMATCH'));

    const projected = await metadataXmlAdapter.compare(makeInput(left, right));
    assert.strictEqual(projected.candidateFactories.size, 0);
    assert.ok(projected.diagnostics.some((item) => item.code === 'XML_FORMAT_VERSION_MISMATCH'));

    const unversionedLeft = '<MetaDataObject><Catalog><Properties><Name>Products</Name><Synonym>Old</Synonym></Properties></Catalog></MetaDataObject>';
    const unversionedRight = unversionedLeft.replace('>Old</Synonym>', '>New</Synonym>');
    assert.strictEqual(validateSemanticXmlMerge(unversionedRight, 'metadataXml', { baselineSource: unversionedLeft }).valid, true);
  });

  test('validates the three known direct metadata references and captures only referenced dependency witnesses', () => {
    const cases = [
      ['AccountingRegister', 'ChartOfAccounts', 'ChartOfAccounts.ОсновнойПлан'],
      ['CalculationRegister', 'ChartOfCalculationTypes', 'ChartOfCalculationTypes.ПланРасчета'],
      ['ChartOfAccounts', 'ExtDimensionTypes', 'ChartOfCharacteristicTypes.Субконто'],
    ] as const;
    for (const [rootType, property, reference] of cases) {
      const xml = `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses"><${rootType}><Properties><Name>Test</Name><${property}>${reference}</${property}></Properties></${rootType}></MetaDataObject>`;
      assert.strictEqual(validateSemanticXmlMerge(xml, 'metadataXml', { availableMetadataReferences: [reference] }).valid, true, reference);
      const missing = validateSemanticXmlMerge(xml, 'metadataXml', { availableMetadataReferences: [reference + 'Missing'] });
      assert.ok(missing.diagnostics.some((item) => item.code === 'XML_ROOT_PROPERTY_REFERENCE'), reference);

      const prefixed = xml
        .split('<MetaDataObject ').join('<md:MetaDataObject ')
        .replace('</MetaDataObject>', '</md:MetaDataObject>')
        .split(`<${rootType}>`).join(`<md:${rootType}>`).split(`</${rootType}>`).join(`</md:${rootType}>`)
        .split('<Properties>').join('<md:Properties>').split('</Properties>').join('</md:Properties>')
        .split(`<${property}>`).join(`<md:${property}>`).split(`</${property}>`).join(`</md:${property}>`)
        .replace('<md:MetaDataObject ', '<md:MetaDataObject xmlns:md="http://v8.1c.ru/8.3/MDClasses" ');
      assert.strictEqual(validateSemanticXmlMerge(prefixed, 'metadataXml', { availableMetadataReferences: [reference] }).valid, true, 'namespace aliases must retain the same path semantics');
    }

    const input = makeInput('<MetaDataObject/>', '<MetaDataObject/>');
    input.semanticMetadataReferenceWitnesses = [
      { qualifiedName: 'ChartOfAccounts.ОсновнойПлан', witness: { sourceId: 'base-source', relativePath: 'Catalogs/ОсновнойПлан.xml', expectedHash: 'a'.repeat(64), kind: 'file' } },
      { qualifiedName: 'ChartOfAccounts.Unused', witness: { sourceId: 'base-source', relativePath: 'Catalogs/Unused.xml', expectedHash: 'b'.repeat(64), kind: 'file' } },
    ];
    const witnesses = buildXmlSourceWitnesses(input, input.artifactPaths!, 'metadataXml', ['ChartOfAccounts.ОсновнойПлан']).sourceWitnesses;
    assert.ok(witnesses.some((item) => item.relativePath === 'Catalogs/ОсновнойПлан.xml'));
    assert.ok(!witnesses.some((item) => item.relativePath === 'Catalogs/Unused.xml'));
  });
});

function makeInput(left: string, right: string): AdapterCompareInput {
  const leftPath = path.join('left', 'Catalogs', 'Products.xml');
  const rightPath = path.join('right', 'Catalogs', 'Products.xml');
  return {
    strategy: 'full',
    leftInventory: { rootPath: 'left', objects: [], artifactsByObjectId: new Map() },
    rightInventory: { rootPath: 'right', objects: [], artifactsByObjectId: new Map() },
    match: {
      left: metadataObject('left-object', leftPath, path.join('left', 'Catalogs', 'Products')),
      right: metadataObject('right-object', rightPath, path.join('right', 'Catalogs', 'Products')),
    },
    artifactPaths: { left: leftPath, right: rightPath },
    session: makeSession(),
    snapshots: { left, right },
  };
}

function makeEnumInput(left: string, right: string): AdapterCompareInput {
  const input = makeInput(left, right);
  const leftPath = path.join('left', 'Enumerations', 'Statuses.xml');
  const rightPath = path.join('right', 'Enumerations', 'Statuses.xml');
  input.match.left = {
    ...input.match.left!,
    qualifiedName: 'Enum.Statuses',
    metadataType: 'Enum',
    uuid: 'e0000000-0000-4000-8000-000000000000',
    descriptorPath: leftPath,
    containerPath: path.join('left', 'Enumerations', 'Statuses'),
  };
  input.match.right = {
    ...input.match.right!,
    qualifiedName: 'Enum.Statuses',
    metadataType: 'Enum',
    uuid: 'e0000000-0000-4000-8000-000000000000',
    descriptorPath: rightPath,
    containerPath: path.join('right', 'Enumerations', 'Statuses'),
  };
  input.artifactPaths = { left: leftPath, right: rightPath };
  return input;
}

function enumDescriptor(values: readonly string[], extraChildren = ''): string {
  const mdClasses = 'http://v8.1c.ru/8.3/MDClasses';
  return `<MetaDataObject xmlns="${mdClasses}" xmlns:x="urn:future" version="2.20"><Enum uuid="e0000000-0000-4000-8000-000000000000"><InternalInfo/><Properties><Name>Statuses</Name></Properties><ChildObjects>${values.join('')}${extraChildren}</ChildObjects></Enum></MetaDataObject>`;
}

function enumValue(key: string, name: string, comment?: string): string {
  const uuids: Record<string, string> = {
    A: 'a0000000-0000-4000-8000-000000000001',
    B: 'b0000000-0000-4000-8000-000000000002',
    N: 'e0000000-0000-4000-8000-000000000005',
    C: 'c0000000-0000-4000-8000-000000000003',
    TargetOnly: 'c0000000-0000-4000-8000-000000000003',
    D: 'd0000000-0000-4000-8000-000000000004',
    Foreign: 'e0000000-0000-4000-8000-000000000005',
  };
  const uuid = uuids[key];
  assert.ok(uuid, `No EnumValue UUID fixture mapping for ${key}`);
  return `<EnumValue uuid="${uuid}"><Properties><Name>${name}</Name>${comment ? `<Comment>${comment}</Comment>` : ''}</Properties></EnumValue>`;
}

function metadataObject(objectId: string, descriptorPath: string, containerPath: string) {
  return {
    objectId,
    qualifiedName: 'Catalog.Products',
    metadataType: 'Catalog',
    uuid: 'catalog-products',
    descriptorPath,
    containerPath,
  };
}

function makeSession(): CompareSession {
  const session = CompareSession.create({
    sessionId: 'session-335',
    createdAt: '2026-05-30T10:00:00.000Z',
    sources: [
      { sourceId: 'left-source', side: 'left', kind: 'workspace', displayName: 'Left', rootUri: 'file:///left', writable: true },
      { sourceId: 'right-source', side: 'right', kind: 'file', displayName: 'Right', rootUri: 'file:///right', writable: false },
    ],
  });
  session.registerSnapshot(snapshot('left-source', 'left'));
  session.registerSnapshot(snapshot('right-source', 'right'));
  return session;
}

function snapshot(sourceId: string, side: 'left' | 'right') {
  return {
    snapshotId: `snapshot-${side}`,
    sourceId,
    snapshotRoot: `file:///${side}`,
    origin: `file:///${side}`,
    createdAt: '2026-05-30T10:00:00.000Z',
    retentionUntil: '2026-05-30T12:00:00.000Z',
    sourceRevision: side,
    readOnly: side === 'right',
    cleanupPolicy: 'manual' as const,
    contentHash: side,
  };
}

function requireNode(
  nodes: readonly CompareTreeNode[],
  label: string,
  predicate: (node: CompareTreeNode) => boolean = () => true
): CompareTreeNode {
  const found = collectNodes(nodes).filter((node) => node.label === label && predicate(node));
  assert.strictEqual(found.length, 1, `Expected one node with label ${label}; got ${found.length}.`);
  return found[0]!;
}

function collectNodes(nodes: readonly CompareTreeNode[]): CompareTreeNode[] {
  return nodes.flatMap((node) => [node, ...collectNodes(node.children)]);
}

function findElement(parent: XmlElement, localName: string): XmlElement {
  const found = elementChildren(parent).find((element) => element.localName === localName);
  assert.ok(found, `Expected XML element ${localName}.`);
  return found!;
}
