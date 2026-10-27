import * as assert from 'assert';

import { METADATA_TYPE_DESCRIPTORS } from '../../../src/constants/metadataTypeDescriptors';
import { scanExtensionXmlDependencies } from '../../../src/compareMerge/extensions/extensionDependencyScanner';
import { getExplicitGeneratedTypeSpecs } from '../../../src/utils/xml/metadataGeneratedTypeSchema';

suite('Extension dependency scanner (#336)', () => {
  test('resolves every canonical root tag, registry alias, and reference kind to one root identity', () => {
    const cases = METADATA_TYPE_DESCRIPTORS.flatMap((descriptor) => [
      { token: descriptor.designerRootTag, root: descriptor.designerRootTag },
      ...(descriptor.designerRootTagAliases ?? []).map((token) => ({ token, root: descriptor.designerRootTag })),
      ...(descriptor.referenceKind ? [{ token: descriptor.referenceKind, root: descriptor.designerRootTag }] : []),
    ]);
    const artifacts = cases.map((item, index) => ({
      relativePath: `Catalogs/Holder/Ext/Root${index}.xml`,
      content: Buffer.from(`<Metadata><Type>cfg:${item.token}.Probe</Type></Metadata>`),
    }));

    const result = scanExtensionXmlDependencies(artifacts);

    assert.deepStrictEqual(result.errors, []);
    assert.strictEqual(result.references.length, cases.length);
    for (const [index, item] of cases.entries()) {
      assert.deepStrictEqual(result.references[index], {
        artifactPath: `Catalogs/Holder/Ext/Root${index}.xml`,
        qualifiedName: `${item.root}.Probe`,
        metadataType: item.root,
        objectName: 'Probe',
      });
    }
  });

  test('resolves every exact generated-type prefix emitted for a registry root to its canonical type', () => {
    const cases = METADATA_TYPE_DESCRIPTORS.flatMap((descriptor) => {
      const root = descriptor.designerRootTag;
      const prefixes = (getExplicitGeneratedTypeSpecs(root) ?? []).map(({ namePrefix }) => namePrefix);
      return prefixes.map((token) => ({ token, root }));
    });
    assert.ok(cases.length > 0, 'test data should include generated types from internalInfoGenerator');
    const artifacts = cases.map((item, index) => ({
      relativePath: `Catalogs/Holder/Ext/Generated${index}.xml`,
      content: Buffer.from(`<Metadata><Type>cfg:${item.token}.Probe</Type></Metadata>`),
    }));

    const result = scanExtensionXmlDependencies(artifacts);

    assert.deepStrictEqual(result.errors, []);
    assert.strictEqual(result.references.length, cases.length);
    for (const [index, item] of cases.entries()) {
      assert.strictEqual(result.references[index]?.metadataType, item.root, `${item.token} should identify ${item.root}`);
      assert.strictEqual(result.references[index]?.qualifiedName, `${item.root}.Probe`, item.token);
    }
  });

  test('fails closed for unknown cfg prefixes and known roots without generated types', () => {
    const artifacts = [
      {
        relativePath: 'Catalogs/Holder/Ext/Unknown.xml',
        content: Buffer.from('<Metadata><Type>cfg:UnknownGeneratedType.Missing</Type></Metadata>'),
      },
      {
        relativePath: 'Catalogs/Holder/Ext/UnsupportedKnown.xml',
        content: Buffer.from('<Metadata><Type>cfg:RoleManager.Missing</Type></Metadata>'),
      },
      {
        relativePath: 'Catalogs/Holder/Ext/UnsupportedConfiguration.xml',
        content: Buffer.from('<Metadata><Type>cfg:Configuration.Missing</Type></Metadata>'),
      },
    ];

    const result = scanExtensionXmlDependencies(artifacts);

    assert.deepStrictEqual(result.references, []);
    assert.strictEqual(result.errors.length, 3);
    assert.ok(result.errors.some((error) => error.artifactPath === artifacts[0]!.relativePath
      && error.message === 'XML metadata reference type or name is unsupported: cfg:UnknownGeneratedType.Missing.'));
    assert.ok(result.errors.some((error) => error.artifactPath === artifacts[1]!.relativePath
      && error.message === 'XML metadata reference type or name is unsupported: cfg:RoleManager.Missing.'));
    assert.ok(result.errors.some((error) => error.artifactPath === artifacts[2]!.relativePath
      && error.message === 'XML metadata reference type or name is unsupported: cfg:Configuration.Missing.'));
  });

  test('reads untyped dependencies only from direct Rights/Object/Name elements in Role Rights.xml', () => {
    const artifacts = [
      {
        relativePath: 'Roles/Ext_Role/Ext/Rights.xml',
        content: Buffer.from('<rights><object><name>Catalog.Missing.Child</name><synonym><name>Catalog.NestedNoise</name></synonym></object><!-- Catalog.CommentNoise --></rights>'),
      },
      {
        relativePath: 'Roles/Ext_Role/Ext/Other.xml',
        content: Buffer.from('<rights><object><name>Catalog.OtherFileNoise</name></object></rights>'),
      },
    ];

    const result = scanExtensionXmlDependencies(artifacts);

    assert.deepStrictEqual(result.errors, []);
    assert.deepStrictEqual(result.references, [{
      artifactPath: 'Roles/Ext_Role/Ext/Rights.xml',
      qualifiedName: 'Catalog.Missing',
      metadataType: 'Catalog',
      objectName: 'Missing',
    }]);
  });

  test('recognizes Configuration only in direct Role Rights/Object/Name structure', () => {
    const artifacts = [
      {
        relativePath: 'Roles/Ext_Role/Ext/Rights.xml',
        content: Buffer.from('<rights><object><name>Configuration.TargetConfig</name><synonym><name>Configuration.NestedNoise</name></synonym></object><!-- Configuration.CommentNoise --></rights>'),
      },
      {
        relativePath: 'Roles/Ext_Role/Ext/Other.xml',
        content: Buffer.from('<Metadata><Name>Configuration.OtherFileNoise</Name></Metadata>'),
      },
    ];

    const result = scanExtensionXmlDependencies(artifacts);

    assert.deepStrictEqual(result.errors, []);
    assert.deepStrictEqual(result.references, [{
      artifactPath: 'Roles/Ext_Role/Ext/Rights.xml',
      qualifiedName: 'Configuration.TargetConfig',
      metadataType: 'Configuration',
      objectName: 'TargetConfig',
    }]);
  });

  test('reports malformed direct Rights/Object/Name references instead of silently ignoring them', () => {
    const result = scanExtensionXmlDependencies([{
      relativePath: 'Roles/Ext_Role/Ext/Rights.xml',
      content: Buffer.from('<rights><object><name>UnqualifiedName</name></object></rights>'),
    }]);

    assert.deepStrictEqual(result.references, []);
    assert.strictEqual(result.errors.length, 1);
    assert.strictEqual(result.errors[0]?.artifactPath, 'Roles/Ext_Role/Ext/Rights.xml');
    assert.ok(result.errors[0]?.message.includes('UnqualifiedName'));
  });

  test('fails closed when a direct Rights/object lacks one unambiguous text name', () => {
    const cases = [
      {
        relativePath: 'Roles/MissingName/Ext/Rights.xml',
        xml: '<rights><object><synonym><name>Catalog.NestedNoise</name></synonym></object></rights>',
      },
      {
        relativePath: 'Roles/DuplicateName/Ext/Rights.xml',
        xml: '<rights><object><name>Catalog.First</name><name>Catalog.Second</name></object></rights>',
      },
      {
        relativePath: 'Roles/StructuredName/Ext/Rights.xml',
        xml: '<rights><object><name><reference>Catalog.Nested</reference></name></object></rights>',
      },
    ];

    for (const item of cases) {
      const result = scanExtensionXmlDependencies([{ relativePath: item.relativePath, content: Buffer.from(item.xml) }]);
      assert.deepStrictEqual(result.references, [], item.relativePath);
      assert.strictEqual(result.errors.length, 1, item.relativePath);
      assert.strictEqual(result.errors[0]?.artifactPath, item.relativePath);
    }
  });
});
