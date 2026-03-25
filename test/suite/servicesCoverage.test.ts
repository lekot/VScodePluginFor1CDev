import * as assert from 'assert';
import {
  buildInternalInfoXml,
  injectInternalInfoIntoMetadataXml,
} from '../../src/services/internalInfoGenerator';
import { normalizeMetaDataObjectRoot } from '../../src/services/metaDataObjectRootNormalizer';
import { Logger } from '../../src/utils/logger';

suite('services coverage helpers', function () {
  this.timeout(10000);
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

    test('buildInternalInfoXml ChartOfCharacteristicTypes includes Characteristic category (§29)', () => {
      const xml = buildInternalInfoXml('ChartOfCharacteristicTypes', 'ВидыСубконто', '\t');
      assert.ok(xml.includes('category="Characteristic"'));
      assert.strictEqual((xml.match(/<xr:GeneratedType /g) || []).length, 6);
    });

    test('buildInternalInfoXml AccountingRegister includes ExtDimensions (§29)', () => {
      const xml = buildInternalInfoXml('AccountingRegister', 'Хозрасчетный', '\t');
      assert.ok(xml.includes('AccountingRegisterExtDimensions.Хозрасчетный'));
      assert.ok(xml.includes('category="ExtDimensions"'));
    });

    test('buildInternalInfoXml CalculationRegister includes Recalcs (§3.1 / §29)', () => {
      const xml = buildInternalInfoXml('CalculationRegister', 'Начисления', '\t');
      assert.ok(xml.includes('category="Recalcs"'));
      assert.strictEqual((xml.match(/<xr:GeneratedType /g) || []).length, 7);
    });

    test('buildInternalInfoXml ChartOfCalculationTypes emits Displacing/Base/Leading rows (§29)', () => {
      const xml = buildInternalInfoXml('ChartOfCalculationTypes', 'ВидыРасчета', '\t');
      assert.ok(xml.includes('category="DisplacingCalculationTypesRow"'));
      assert.strictEqual((xml.match(/<xr:GeneratedType /g) || []).length, 11);
    });

    test('buildInternalInfoXml DefinedType single GeneratedType (§29)', () => {
      const xml = buildInternalInfoXml('DefinedType', 'Сумма', '\t');
      assert.ok(xml.includes('name="DefinedType.Сумма" category="DefinedType"'));
      assert.strictEqual((xml.match(/<xr:GeneratedType /g) || []).length, 1);
    });

    test('buildInternalInfoXml ExchangePlan includes ThisNode before GeneratedType (§15.3)', () => {
      const xml = buildInternalInfoXml('ExchangePlan', 'ОбменУТ', '\t');
      const thisNode = xml.indexOf('<xr:ThisNode>');
      const gt = xml.indexOf('<xr:GeneratedType ');
      assert.ok(thisNode !== -1 && gt !== -1 && thisNode < gt);
      assert.strictEqual((xml.match(/<xr:GeneratedType /g) || []).length, 5);
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

    test('injectInternalInfoIntoMetadataXml does not inject InternalInfo for Role (Configurator/EDT shape)', () => {
      const source = [
        '<MetaDataObject>',
        '\t<Role uuid="00000000-0000-0000-0000-000000000001">',
        '\t\t<Properties>',
        '\t\t\t<Name>TestRole</Name>',
        '\t\t</Properties>',
        '\t</Role>',
        '</MetaDataObject>',
      ].join('\n');
      const result = injectInternalInfoIntoMetadataXml(source, 'Role', 'TestRole');
      assert.strictEqual(result, source);
      assert.ok(!result.includes('<InternalInfo>'));
    });

    test('injectInternalInfoIntoMetadataXml does not inject InternalInfo for CommonModule', () => {
      const source = [
        '<MetaDataObject>',
        '\t<CommonModule uuid="00000000-0000-0000-0000-000000000002">',
        '\t\t<Properties>',
        '\t\t\t<Name>TestModule</Name>',
        '\t\t</Properties>',
        '\t</CommonModule>',
        '</MetaDataObject>',
      ].join('\n');
      const result = injectInternalInfoIntoMetadataXml(source, 'CommonModule', 'TestModule');
      assert.strictEqual(result, source);
      assert.ok(!result.includes('<InternalInfo>'));
    });

    test('injectInternalInfoIntoMetadataXml does not inject InternalInfo for CommonForm (ibcmd)', () => {
      const source = [
        '<MetaDataObject>',
        '\t<CommonForm uuid="00000000-0000-0000-0000-000000000003">',
        '\t\t<Properties>',
        '\t\t\t<Name>F</Name>',
        '\t\t</Properties>',
        '\t</CommonForm>',
        '</MetaDataObject>',
      ].join('\n');
      const result = injectInternalInfoIntoMetadataXml(source, 'CommonForm', 'F');
      assert.strictEqual(result, source);
      assert.ok(!result.includes('<InternalInfo>'));
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

    test('error serializes non-Error second argument', () => {
      console.error = () => undefined;
      Logger.error('bad', 'plain string');
      const buffered = Logger.getBufferedContent();
      assert.ok(buffered.includes('[ERROR] bad'));
      assert.ok(buffered.includes('plain string'));
    });

    test('show invokes output channel when configured', () => {
      let shown = false;
      (Logger as any).outputChannel = {
        appendLine: () => undefined,
        show: () => {
          shown = true;
        },
      };
      Logger.show();
      assert.strictEqual(shown, true);
    });

    test('show is a no-op when output channel is absent', () => {
      (Logger as any).outputChannel = null;
      Logger.show();
    });
  });
});
