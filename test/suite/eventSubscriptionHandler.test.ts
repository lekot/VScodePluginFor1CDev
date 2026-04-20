import * as assert from 'assert';
import {
  parseHandlerString,
  type HandlerParts,
} from '../../src/providers/propertiesMessageHandler';

// ---------------------------------------------------------------------------
// parseHandlerString — unit tests
// ---------------------------------------------------------------------------

suite('EventSubscription Handler — parseHandlerString', () => {
  test('CommonModule handler returns correct parts', () => {
    const result = parseHandlerString(
      'CommonModule.ОрганизационнаяСтруктураСобытия.ОбновитьЭлементСтруктурыПредприятия'
    ) as HandlerParts;
    assert.ok(result, 'Should parse CommonModule handler');
    assert.strictEqual(result.objectType, 'CommonModule');
    assert.strictEqual(result.objectName, 'ОрганизационнаяСтруктураСобытия');
    assert.strictEqual(result.moduleName, '');
    assert.strictEqual(result.procedureName, 'ОбновитьЭлементСтруктурыПредприятия');
  });

  test('Catalog ObjectManagerModule handler returns correct parts', () => {
    const result = parseHandlerString(
      'Catalogs.Nomenclature.ObjectManagerModule.BeforeWrite'
    ) as HandlerParts;
    assert.ok(result, 'Should parse Catalog handler');
    assert.strictEqual(result.objectType, 'Catalogs');
    assert.strictEqual(result.objectName, 'Nomenclature');
    assert.strictEqual(result.moduleName, 'ObjectManagerModule');
    assert.strictEqual(result.procedureName, 'BeforeWrite');
  });

  test('Document ObjectModule handler returns correct parts', () => {
    const result = parseHandlerString(
      'Documents.X.ObjectModule.OnWrite'
    ) as HandlerParts;
    assert.ok(result, 'Should parse Document handler');
    assert.strictEqual(result.objectType, 'Documents');
    assert.strictEqual(result.objectName, 'X');
    assert.strictEqual(result.moduleName, 'ObjectModule');
    assert.strictEqual(result.procedureName, 'OnWrite');
  });

  test('InformationRegisters RecordSetModule handler returns correct parts', () => {
    const result = parseHandlerString(
      'InformationRegisters.PriceList.RecordSetModule.AfterWrite'
    ) as HandlerParts;
    assert.ok(result, 'Should parse InformationRegisters handler');
    assert.strictEqual(result.objectType, 'InformationRegisters');
    assert.strictEqual(result.objectName, 'PriceList');
    assert.strictEqual(result.moduleName, 'RecordSetModule');
    assert.strictEqual(result.procedureName, 'AfterWrite');
  });

  test('null returned for empty string', () => {
    assert.strictEqual(parseHandlerString(''), null);
  });

  test('null returned for too few parts', () => {
    assert.strictEqual(parseHandlerString('CommonModule.OnlyTwoParts'), null);
  });

  test('null returned for unknown object type', () => {
    assert.strictEqual(parseHandlerString('UnknownType.ObjName.Module.Proc'), null);
  });

  test('procedure name with dots preserved (CommonModule)', () => {
    const result = parseHandlerString(
      'CommonModule.SomeModule.SomeProc.SubProc'
    ) as HandlerParts;
    assert.ok(result, 'Should parse handler with dot in procedure name');
    assert.strictEqual(result.procedureName, 'SomeProc.SubProc');
  });

  test('ОбщийМодуль alias treated as CommonModule', () => {
    const result = parseHandlerString(
      'ОбщийМодуль.МойМодуль.МояПроцедура'
    ) as HandlerParts;
    assert.ok(result, 'Should parse Russian alias for CommonModule');
    assert.strictEqual(result.objectType, 'CommonModule');
    assert.strictEqual(result.objectName, 'МойМодуль');
    assert.strictEqual(result.procedureName, 'МояПроцедура');
  });
});
