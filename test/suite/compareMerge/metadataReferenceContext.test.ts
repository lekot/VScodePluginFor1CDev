import * as assert from 'assert';
import { createHash } from 'crypto';

import { buildMetadataReferenceContext } from '../../../src/compareMerge/adapters/metadataReferenceContext';
import type { ConfigurationInventory } from '../../../src/compareMerge/adapters/mergeAdapter';

suite('Metadata semantic reference context', () => {
  test('advertises only root-registered names backed by one captured descriptor and witnesses raw root bytes', async () => {
    const source = '\uFEFF<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses">\r\n<Configuration><Properties><Name>Config</Name></Properties><ChildObjects><Catalog>Товары</Catalog><Document>БезДескриптора</Document></ChildObjects></Configuration>\r\n</MetaDataObject>';
    const inventory: ConfigurationInventory = {
      rootPath: '/target',
      objects: [
        { objectId: 'catalog', qualifiedName: 'Catalog.Товары', metadataType: 'Catalog', descriptorPath: '/target/Catalogs/Товары.xml', containerPath: '/target/Catalogs/Товары' },
        { objectId: 'orphan', qualifiedName: 'Catalog.Сирота', metadataType: 'Catalog', descriptorPath: '/target/Catalogs/Сирота.xml', containerPath: '/target/Catalogs/Сирота' },
        { objectId: 'missing', qualifiedName: 'Document.БезДескриптора', metadataType: 'Document', descriptorPath: '/target/Documents/БезДескриптора.xml', containerPath: '/target/Documents/БезДескриптора' },
      ],
      artifactsByObjectId: new Map([
        ['catalog', [{ artifactId: 'catalog:descriptor', ownerObjectId: 'catalog', kind: 'metadataXml', relativePath: 'Catalogs/Товары.xml', filePath: '/target/Catalogs/Товары.xml', contentHash: 'sha256:' + 'a'.repeat(64), mergeMode: 'xmlPatch' }]],
        ['orphan', [{ artifactId: 'orphan:descriptor', ownerObjectId: 'orphan', kind: 'metadataXml', relativePath: 'Catalogs/Сирота.xml', filePath: '/target/Catalogs/Сирота.xml', contentHash: 'sha256:' + 'b'.repeat(64), mergeMode: 'xmlPatch' }]],
        ['missing', []],
      ]),
    };

    const result = await buildMetadataReferenceContext({
      inventory,
      sourceId: 'left-source',
      readTextFile: async () => source,
    });

    assert.deepStrictEqual(result.availableMetadataReferences, ['Catalog.Товары']);
    assert.strictEqual(result.configurationName, 'Config');
    assert.deepStrictEqual(result.witnesses, [{
      sourceId: 'left-source',
      relativePath: 'Configuration.xml',
      expectedHash: createHash('sha256').update(Buffer.from(source, 'utf8')).digest('hex'),
      kind: 'file',
    }]);
  });

  test('leaves registration context unavailable when Configuration.xml cannot be captured', async () => {
    const result = await buildMetadataReferenceContext({
      inventory: { rootPath: '/target', objects: [], artifactsByObjectId: new Map() },
      sourceId: 'left-source',
      readTextFile: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    });

    assert.strictEqual(result.availableMetadataReferences, undefined);
    assert.deepStrictEqual(result.witnesses, []);
  });

  test('does not derive Configuration capabilities from a foreign namespace lookalike', async () => {
    const source = '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses"><Configuration xmlns="urn:foreign"><Properties><Name>Fake</Name></Properties><ChildObjects><Catalog>Товары</Catalog></ChildObjects></Configuration></MetaDataObject>';
    const inventory: ConfigurationInventory = {
      rootPath: '/target',
      objects: [
        { objectId: 'catalog', qualifiedName: 'Catalog.Товары', metadataType: 'Catalog', descriptorPath: '/target/Catalogs/Товары.xml', containerPath: '/target/Catalogs/Товары' },
      ],
      artifactsByObjectId: new Map([
        ['catalog', [{ artifactId: 'catalog:descriptor', ownerObjectId: 'catalog', kind: 'metadataXml', relativePath: 'Catalogs/Товары.xml', filePath: '/target/Catalogs/Товары.xml', contentHash: 'sha256:' + 'a'.repeat(64), mergeMode: 'xmlPatch' }]],
      ]),
    };

    const result = await buildMetadataReferenceContext({
      inventory,
      sourceId: 'left-source',
      readTextFile: async () => source,
    });

    assert.strictEqual(result.configurationName, undefined);
    assert.strictEqual(result.availableMetadataReferences, undefined);
    assert.deepStrictEqual(result.witnesses, []);
  });
});
