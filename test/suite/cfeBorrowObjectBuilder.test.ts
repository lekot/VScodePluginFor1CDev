import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  getMetadataTypeDescriptorByRootTag,
  METADATA_TYPE_DESCRIPTORS,
  type MetadataTypeDescriptor,
} from '../../src/constants/metadataTypeDescriptors';
import {
  buildBorrowedObjectShellFromSource,
  BORROWED_OBJECT_SOURCE_PROPERTY_POLICY,
  validateBorrowedObjectSource,
} from '../../src/extensionSupport/cfeProject/borrowObjectBuilder';
import { parseXmlDocument, elementChildren, textContent } from '../../src/compareMerge/xml/xmlDom';
import {
  getExplicitGeneratedTypeSpecs,
  ROOT_TAGS_WITHOUT_INTERNALINFO,
} from '../../src/utils/xml/metadataGeneratedTypeSchema';

const NAME = 'ProjectionFixture';
const SOURCE_UUID = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
const INPUT_UUID = SOURCE_UUID.toLocaleUpperCase();
const LOCAL_UUID = '11111111-2222-4333-8444-555555555555';
const VERSION = '2.20';
const NAMESPACE = 'http://v8.1c.ru/8.3/MDClasses';
const READABLE_NAMESPACE = 'http://v8.3/xcf/readable';

interface NativeRootGeneratedTypeFixture {
  readonly formatVersion: string;
  readonly roots: readonly {
    readonly rootType: string;
    readonly generatedTypes: readonly { readonly namePrefix: string; readonly category: string }[];
  }[];
}

const nativeRootGeneratedTypes = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '../../../test/fixtures/cfe-ownership/native-root-generated-types.json'),
  'utf8',
)) as NativeRootGeneratedTypeFixture;

suite('source-derived borrowed object shell builder', () => {
  test('matches the independent anonymized native GeneratedType shape oracle', () => {
    assert.strictEqual(nativeRootGeneratedTypes.formatVersion, '2.20');
    assert.strictEqual(nativeRootGeneratedTypes.roots.length, 44);
    const mismatches: Array<{
      readonly rootType: string;
      readonly expected: readonly string[];
      readonly actual: readonly string[];
    }> = [];
    for (const sourceRoot of nativeRootGeneratedTypes.roots) {
      assert.ok(getMetadataTypeDescriptorByRootTag(sourceRoot.rootType), `${sourceRoot.rootType} must be in the registry`);
      const schema = getExplicitGeneratedTypeSpecs(sourceRoot.rootType) ?? [];
      const sort = (types: readonly { readonly namePrefix: string; readonly category: string }[]) =>
        types.map(({ namePrefix, category }) => `${namePrefix}\0${category}`).sort();
      const actual = sort(schema);
      const expected = sort(sourceRoot.generatedTypes);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        mismatches.push({ rootType: sourceRoot.rootType, expected, actual });
      }
    }
    assert.deepStrictEqual(mismatches, [], 'Explicit GeneratedType schemas must match the independent native source shapes');
  });

  test('projects all registry roots from their canonical source descriptors', () => {
    assert.strictEqual(METADATA_TYPE_DESCRIPTORS.length, 46);
    for (const descriptor of METADATA_TYPE_DESCRIPTORS) {
      const source = buildSourceXml(descriptor);
      const sourceValidation = validateBorrowedObjectSource({
        sourceXml: source,
        identity: { type: descriptor.designerRootTag, name: NAME, uuid: INPUT_UUID },
        formatVersion: VERSION,
      });
      assert.strictEqual(sourceValidation.ok, true, `${descriptor.designerRootTag}: ${sourceValidation.ok ? '' : sourceValidation.reason}`);
      const result = buildBorrowedObjectShellFromSource({
        sourceXml: source,
        identity: { type: descriptor.designerRootTag, name: NAME, uuid: INPUT_UUID },
        formatVersion: VERSION,
        localUuid: LOCAL_UUID,
      });
      assert.strictEqual(result.ok, true, `${descriptor.designerRootTag}: ${result.ok ? '' : result.reason}`);
      if (!result.ok) {
        continue;
      }

      const output = parseXmlDocument(result.xml);
      const metadataObject = output.root;
      const metadataRoot = elementChildren(metadataObject)[0]!;
      assert.strictEqual(metadataObject.localName, 'MetaDataObject');
      assert.strictEqual(metadataRoot.localName, descriptor.designerRootTag);
      assert.strictEqual(metadataRoot.attributes.find((attribute) => attribute.localName === 'uuid')?.value, LOCAL_UUID);
      const properties = elementChildren(metadataRoot).find((child) => child.localName === 'Properties')!;
      const propertyNames = elementChildren(properties).map((child) => child.localName);
      assert.deepStrictEqual(propertyNames.slice(0, 4), [
        'ObjectBelonging', 'Name', 'Comment', 'ExtendedConfigurationObject',
      ]);
      assert.strictEqual(scalar(properties, 'ObjectBelonging'), 'Adopted');
      assert.strictEqual(scalar(properties, 'Name'), NAME);
      assert.strictEqual(scalar(properties, 'ExtendedConfigurationObject'), SOURCE_UUID);

      const rootChildren = elementChildren(metadataRoot);
      assert.deepStrictEqual(
        rootChildren.map((child) => child.localName),
        [
          ...(ROOT_TAGS_WITHOUT_INTERNALINFO.has(descriptor.designerRootTag) ? [] : ['InternalInfo']),
          'Properties',
          ...(descriptor.structure.hasChildObjects ? ['ChildObjects'] : []),
        ],
        `${descriptor.designerRootTag} should contain only projected shell sections`,
      );
      if (descriptor.structure.hasChildObjects) {
        const childObjects = rootChildren.find((child) => child.localName === 'ChildObjects')!;
        assert.deepStrictEqual(elementChildren(childObjects), [], `${descriptor.designerRootTag} ChildObjects must be empty`);
      }
      assert.doesNotMatch(result.xml, /BaseOnlyModule|InheritedChild|UnknownRequiredCandidate/u);

      const sourceInternalInfo = source.match(/<InternalInfo>[\s\S]*?<\/InternalInfo>/u)?.[0];
      const projectedInternalInfo = result.xml.match(/<InternalInfo>[\s\S]*?<\/InternalInfo>/u)?.[0];
      if (sourceInternalInfo) {
        assert.ok(projectedInternalInfo, `${descriptor.designerRootTag} InternalInfo should be retained`);
        assert.deepStrictEqual(generatedTypeIds(projectedInternalInfo), generatedTypeIds(sourceInternalInfo));
      }
    }
  });

  test('copies typed source properties as XML and preserves namespace aliases and source UUID casing', () => {
    const source = buildSourceXml(
      getMetadataTypeDescriptorByRootTag('Catalog')!,
      {
        readablePrefix: true,
        properties: '<Synonym><v8:item><v8:content>must not be copied</v8:content></v8:item></Synonym>',
      },
    );
    const result = project(source, { type: 'Catalog', name: NAME, uuid: INPUT_UUID });
    assert.strictEqual(result.ok, true, result.ok ? '' : result.reason);
    if (!result.ok) {
      return;
    }
    assert.match(result.xml, /xmlns:readable="http:\/\/v8\.3\/xcf\/readable"/u);
    assert.match(result.xml, /<readable:GeneratedType\b/u);
    assert.match(result.xml, /<readable:TypeId>/u);
    assert.match(result.xml, /xmlns:xs="http:\/\/www\.w3\.org\/2001\/XMLSchema"/u);
    assert.match(result.xml, /xmlns:xsi="http:\/\/www\.w3\.org\/2001\/XMLSchema-instance"/u);
    assert.match(result.xml, new RegExp(`<ExtendedConfigurationObject>${SOURCE_UUID}<`, 'u'));
    assert.doesNotMatch(result.xml, /must not be copied/u);
  });

  test('copies the approved per-type properties without inventing absent values', () => {
    const cases = [
      {
        type: 'CommonModule',
        sourceProperties: '<Global>true</Global><ClientManagedApplication>false</ClientManagedApplication><Server>true</Server><ExternalConnection>false</ExternalConnection><ClientOrdinaryApplication>true</ClientOrdinaryApplication><ServerCall>true</ServerCall>',
        copied: ['Global', 'ClientManagedApplication', 'Server', 'ExternalConnection', 'ClientOrdinaryApplication', 'ServerCall'],
        omitted: ['UnknownRequiredCandidate'],
      },
      { type: 'Language', sourceProperties: '<LanguageCode>ru &amp; en</LanguageCode>', copied: ['LanguageCode'], omitted: [] },
      { type: 'InformationRegister', sourceProperties: '<InformationRegisterPeriodicity>Year</InformationRegisterPeriodicity><WriteMode>Independent</WriteMode>', copied: ['InformationRegisterPeriodicity', 'WriteMode'], omitted: [] },
      { type: 'Constant', sourceProperties: '<Type><v8:Type>Number</v8:Type><v8:NumberQualifiers><v8:Digits>9</v8:Digits></v8:NumberQualifiers></Type>', copied: ['Type'], omitted: [] },
      { type: 'CommonForm', sourceProperties: '<FormType>Managed</FormType>', copied: ['FormType'], omitted: [] },
    ];

    for (const testCase of cases) {
      assert.ok(BORROWED_OBJECT_SOURCE_PROPERTY_POLICY[testCase.type]);
      const descriptor = getMetadataTypeDescriptorByRootTag(testCase.type)!;
      const source = buildSourceXml(descriptor, { properties: testCase.sourceProperties });
      const result = project(source, { type: testCase.type, name: NAME, uuid: SOURCE_UUID });
      assert.strictEqual(result.ok, true, result.ok ? '' : result.reason);
      if (!result.ok) {
        continue;
      }
      for (const property of testCase.copied) {
        assert.match(result.xml, new RegExp(`<${property}(?:\\s|>)`, 'u'));
      }
      for (const property of testCase.omitted) {
        assert.doesNotMatch(result.xml, new RegExp(`<${property}(?:\\s|>)`, 'u'));
      }
      assert.doesNotMatch(result.xml, /InheritedChild|BaseOnlyModule/u);
    }

    const escapedLanguage = project(
      buildSourceXml(getMetadataTypeDescriptorByRootTag('Language')!, { properties: '<LanguageCode>ru &amp; en</LanguageCode>' }),
      { type: 'Language', name: NAME, uuid: SOURCE_UUID },
    );
    assert.strictEqual(escapedLanguage.ok, true);
    if (escapedLanguage.ok) {
      assert.match(escapedLanguage.xml, /<LanguageCode>ru &amp; en<\/LanguageCode>/u);
    }
  });

  test('normalizes registry aliases while matching source root identity', () => {
    const source = buildSourceXml(getMetadataTypeDescriptorByRootTag('FilterCriterion')!);
    const result = project(source, { type: 'FilterCriteria', name: NAME, uuid: SOURCE_UUID });
    assert.strictEqual(result.ok, true, result.ok ? '' : result.reason);
    if (result.ok) {
      assert.match(result.xml, /<FilterCriterion\b/u);
      assert.doesNotMatch(result.xml, /<FilterCriteria\b/u);
    }
  });

  test('rejects stale identity and format, malformed GeneratedType data, and invalid UUIDs', () => {
    const catalog = getMetadataTypeDescriptorByRootTag('Catalog')!;
    const validSource = buildSourceXml(catalog);
    const brokenId = '00000000-0000-0000-0000-000000000000';
    const validGeneratedTypes = generatedTypes(catalog);

    const cases: Array<{ label: string; source: string; identity?: { type: string; name: string; uuid: string }; format?: string }> = [
      { label: 'stale name', source: validSource, identity: { type: 'Catalog', name: 'OtherName', uuid: SOURCE_UUID } },
      { label: 'stale UUID', source: validSource, identity: { type: 'Catalog', name: NAME, uuid: LOCAL_UUID } },
      { label: 'stale source version', source: validSource.replace('version="2.20"', 'version="2.19"') },
      { label: 'unknown target version', source: validSource, format: '2.22' },
      { label: 'missing required InternalInfo', source: validSource.replace(/<InternalInfo>[\s\S]*?<\/InternalInfo>/u, '') },
      { label: 'missing ValueId', source: validSource.replace(/<xr:ValueId>[\s\S]*?<\/xr:ValueId>/u, '') },
      { label: 'duplicate ChildObjects', source: validSource.replace('</Catalog>', '<ChildObjects/><ChildObjects/></Catalog>') },
      { label: 'duplicate direct Comment', source: validSource.replace('</Properties>', '<Comment>second comment</Comment></Properties>') },
      { label: 'zero GeneratedType UUID', source: validSource.replace(validGeneratedTypes[0]!.typeId, brokenId) },
      {
        label: 'duplicate GeneratedType UUID',
        source: validSource.replace(validGeneratedTypes[1]!.typeId, validGeneratedTypes[0]!.typeId),
      },
      { label: 'duplicate InternalInfo', source: validSource.replace('</Catalog>', `${validSource.match(/<InternalInfo>[\s\S]*?<\/InternalInfo>/u)?.[0]}</Catalog>`) },
    ];

    for (const testCase of cases) {
      const result = buildBorrowedObjectShellFromSource({
        sourceXml: testCase.source,
        identity: testCase.identity ?? { type: 'Catalog', name: NAME, uuid: SOURCE_UUID },
        formatVersion: testCase.format ?? VERSION,
        localUuid: LOCAL_UUID,
      });
      assert.strictEqual(result.ok, false, `${testCase.label} should fail closed`);
      const validation = validateBorrowedObjectSource({
        sourceXml: testCase.source,
        identity: testCase.identity ?? { type: 'Catalog', name: NAME, uuid: SOURCE_UUID },
        formatVersion: testCase.format ?? VERSION,
      });
      assert.strictEqual(validation.ok, false, `${testCase.label} should fail source validation`);
    }

    const zeroLocalUuid = project(validSource, { type: 'Catalog', name: NAME, uuid: SOURCE_UUID }, brokenId);
    assert.strictEqual(zeroLocalUuid.ok, false);
  });
});

interface SourceOptions {
  readonly properties?: string;
  readonly readablePrefix?: boolean;
}

function buildSourceXml(descriptor: MetadataTypeDescriptor, options: SourceOptions = {}): string {
  const generated = ROOT_TAGS_WITHOUT_INTERNALINFO.has(descriptor.designerRootTag)
    ? ''
    : `<InternalInfo>${generatedTypes(descriptor, options.readablePrefix).map((item) => item.xml).join('')}</InternalInfo>`;
  const properties = [
    `<Name>${NAME}</Name>`,
    '<Comment>source &amp; comment &lt;kept&gt;</Comment>',
    options.properties ?? '',
    '<UnknownRequiredCandidate>not copied</UnknownRequiredCandidate>',
  ].join('');
  const childObjects = descriptor.structure.hasChildObjects
    ? '<ChildObjects><Attribute><Name>InheritedChild</Name></Attribute></ChildObjects>'
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?><MetaDataObject xmlns="${NAMESPACE}" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xr="http://v8.3/xcf/readable"${options.readablePrefix ? ` xmlns:readable="${READABLE_NAMESPACE}"` : ''} version="${VERSION}"><${descriptor.designerRootTag} uuid="${SOURCE_UUID}">${generated}<Properties>${properties}</Properties>${childObjects}<ObjectModule>BaseOnlyModule</ObjectModule></${descriptor.designerRootTag}></MetaDataObject>`;
}

function generatedTypes(descriptor: MetadataTypeDescriptor, readablePrefix = false): Array<{ xml: string; typeId: string; valueId: string }> {
  const specs = getExplicitGeneratedTypeSpecs(descriptor.designerRootTag);
  assert.ok(specs, `${descriptor.designerRootTag} must have an explicit GeneratedType schema`);
  const entries = specs.map((spec, index) => {
    const prefix = readablePrefix ? 'readable' : 'xr';
    const typeId = testUuid(index * 2 + 1);
    const valueId = testUuid(index * 2 + 2);
    return {
      typeId,
      valueId,
      xml: `<${prefix}:GeneratedType name="${spec.namePrefix}.${NAME}" category="${spec.category}"><${prefix}:TypeId>${typeId}</${prefix}:TypeId><${prefix}:ValueId>${valueId}</${prefix}:ValueId></${prefix}:GeneratedType>`,
    };
  });
  return descriptor.designerRootTag === 'Catalog' ? entries.reverse() : entries;
}

function generatedTypeIds(xml: string): string[] {
  return Array.from(xml.matchAll(/<(?:[\w.-]+:)?(?:TypeId|ValueId)>([^<]+)</gu), (match) => match[1]!);
}

function testUuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function scalar(parent: ReturnType<typeof parseXmlDocument>['root'], localName: string): string | undefined {
  const property = elementChildren(parent).find((child) => child.localName === localName);
  return property ? textContent(property).trim() : undefined;
}

function project(
  sourceXml: string,
  identity: { readonly type: string; readonly name: string; readonly uuid: string },
  localUuid = LOCAL_UUID,
) {
  return buildBorrowedObjectShellFromSource({ sourceXml, identity, formatVersion: VERSION, localUuid });
}
