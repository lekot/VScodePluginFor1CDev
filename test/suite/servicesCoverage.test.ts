import * as assert from 'assert';
import {
  buildInternalInfoXml,
  injectInternalInfoIntoMetadataXml,
} from '../../src/services/internalInfoGenerator';
import { normalizeMetaDataObjectRoot } from '../../src/services/metaDataObjectRootNormalizer';
import { Logger } from '../../src/utils/logger';

suite('services coverage helpers', () => {
  suite('internalInfoGenerator', () => {
    test('buildInternalInfoXml builds catalog generated types and preserves base indentation', () => {
      const xml = buildInternalInfoXml('Catalog', 'Products', '  ');
      assert.ok(xml.startsWith('  <InternalInfo>\n'));
      assert.ok(xml.includes('CatalogObject.Products'));
      assert.ok(xml.includes('CatalogManager.Products'));
      assert.strictEqual((xml.match(/<xr:GeneratedType /g) || []).length, 5);
    });

    test('buildInternalInfoXml uses fallback spec for unknown rootTag', () => {
      const xml = buildInternalInfoXml('CustomObject', 'AnyName', '\t');
      assert.ok(xml.includes('<xr:GeneratedType name="CustomObjectManager.AnyName" category="Manager">'));
      assert.strictEqual((xml.match(/<xr:GeneratedType /g) || []).length, 1);
    });

    test('injectInternalInfoIntoMetadataXml inserts block before Properties', () => {
      const source = [
        '<Catalog>',
        '\t<Properties>',
        '\t\t<Name>Products</Name>',
        '\t</Properties>',
        '</Catalog>',
      ].join('\n');

      const result = injectInternalInfoIntoMetadataXml(source, 'Catalog', 'Products');
      const internalInfoPos = result.indexOf('<InternalInfo>');
      const propertiesPos = result.indexOf('<Properties>');

      assert.ok(internalInfoPos !== -1, 'InternalInfo should be inserted');
      assert.ok(propertiesPos !== -1, 'Properties should remain');
      assert.ok(internalInfoPos < propertiesPos, 'InternalInfo should be before Properties');
    });

    test('injectInternalInfoIntoMetadataXml returns original xml when InternalInfo already exists', () => {
      const source = '<Catalog>\n\t<InternalInfo></InternalInfo>\n\t<Properties></Properties>\n</Catalog>';
      const result = injectInternalInfoIntoMetadataXml(source, 'Catalog', 'Products');
      assert.strictEqual(result, source);
    });

    test('injectInternalInfoIntoMetadataXml returns original xml when root/properties pattern is absent', () => {
      const source = '<Catalog><Name>NoProperties</Name></Catalog>';
      const result = injectInternalInfoIntoMetadataXml(source, 'Catalog', 'NoProperties');
      assert.strictEqual(result, source);
    });
  });

  suite('metaDataObjectRootNormalizer', () => {
    test('normalizes MetaDataObject open tag to canonical one', () => {
      const source = '<MetaDataObject version="1.0"><Configuration/></MetaDataObject>';
      const normalized = normalizeMetaDataObjectRoot(source);
      assert.ok(normalized.includes('xmlns="http://v8.1c.ru/8.3/MDClasses"'));
      assert.ok(normalized.includes('version="2.20"'));
      assert.ok(normalized.endsWith('</MetaDataObject>'));
    });

    test('returns original xml when MetaDataObject tag is absent', () => {
      const source = '<Catalog><Properties/></Catalog>';
      assert.strictEqual(normalizeMetaDataObjectRoot(source), source);
    });
  });

  suite('logger', () => {
    let originalConsoleLog: typeof console.log;
    let originalConsoleError: typeof console.error;

    setup(() => {
      originalConsoleLog = console.log;
      originalConsoleError = console.error;
      Logger.setMinLevel('debug');
      Logger.setBufferingEnabled(true);
      Logger.clearBuffer();
      (Logger as any).outputChannel = null;
    });

    teardown(() => {
      console.log = originalConsoleLog;
      console.error = originalConsoleError;
      Logger.setMinLevel('info');
      Logger.setBufferingEnabled(true);
      Logger.clearBuffer();
      (Logger as any).outputChannel = null;
    });

    test('respects minimum level filter', () => {
      Logger.setMinLevel('warn');
      Logger.info('info message');
      Logger.warn('warn message');

      const buffered = Logger.getBufferedContent();
      assert.ok(buffered.includes('[WARN] warn message'));
      assert.ok(!buffered.includes('[INFO] info message'));
    });

    test('writes errors through console.error and includes message payload', () => {
      Logger.error('boom', new Error('failure'));
      const buffered = Logger.getBufferedContent();
      assert.ok(buffered.includes('[ERROR] boom'));
      assert.ok(buffered.includes('failure'));
    });

    test('disabling buffering clears stored buffer and prevents accumulation', () => {
      console.log = () => undefined;
      console.error = () => undefined;

      Logger.info('first');
      assert.ok(Logger.getBufferedContent().includes('first'));

      Logger.setBufferingEnabled(false);
      assert.strictEqual(Logger.getBufferedContent(), '');

      Logger.info('second');
      assert.strictEqual(Logger.getBufferedContent(), '');
    });

    test('buffer trimming keeps size bounded when limit is exceeded', () => {
      console.log = () => undefined;
      console.error = () => undefined;
      Logger.setMinLevel('debug');

      for (let i = 0; i < 10005; i++) {
        Logger.debug(`msg-${i}`);
      }

      const buffer = ((Logger as any).buffer || []) as string[];
      assert.ok(buffer.length <= 10000, 'Buffer should stay bounded');
      assert.ok(!buffer.some((line) => line.includes('msg-0')), 'Oldest lines should be trimmed');
      assert.ok(buffer.some((line) => line.includes('msg-10004')), 'Newest lines should remain');
    });
  });
});
