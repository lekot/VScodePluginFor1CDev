import * as assert from 'assert';
import { filterOutLockedObjectFiles } from '../../src/bindings/deployLockedObjectsFilter';
import type { LockedObjectRef } from '../../src/services/ibcmd/ibcmdLockedObjectsParser';

function locked(fullName: string): LockedObjectRef {
  const dotIdx = fullName.indexOf('.');
  const kind = dotIdx >= 0 ? fullName.slice(0, dotIdx) : '';
  const name = dotIdx >= 0 ? fullName.slice(dotIdx + 1) : fullName;
  return { kind, name, fullName };
}

suite('filterOutLockedObjectFiles', () => {
  test('CommonModule: removes descriptor XML and files in object directory', () => {
    const files = [
      'CommonModules/АвансовыйОтчетЛокализация.xml',
      'CommonModules/АвансовыйОтчетЛокализация/Ext/Module.bsl',
      'Catalogs/Товары.xml',
      'Catalogs/Товары/Forms/ФормаЭлемента.xml',
    ];
    const result = filterOutLockedObjectFiles(files, [locked('CommonModule.АвансовыйОтчетЛокализация')]);
    assert.deepStrictEqual(result.filtered, [
      'CommonModules/АвансовыйОтчетЛокализация.xml',
      'CommonModules/АвансовыйОтчетЛокализация/Ext/Module.bsl',
    ]);
    assert.deepStrictEqual(result.kept, [
      'Catalogs/Товары.xml',
      'Catalogs/Товары/Forms/ФормаЭлемента.xml',
    ]);
  });

  test('empty locked list returns all files in kept', () => {
    const files = ['CommonModules/Foo.xml', 'Catalogs/Bar.xml'];
    const result = filterOutLockedObjectFiles(files, []);
    assert.deepStrictEqual(result.kept, files);
    assert.deepStrictEqual(result.filtered, []);
  });

  test('locked not in file list: kept is entire list, filtered is empty', () => {
    const files = ['Catalogs/Bar.xml'];
    const result = filterOutLockedObjectFiles(files, [locked('CommonModule.Ghost')]);
    assert.deepStrictEqual(result.kept, files);
    assert.deepStrictEqual(result.filtered, []);
  });

  test('multiple kinds filtered simultaneously (Catalog + CommonModule)', () => {
    const files = [
      'CommonModules/Mod.xml',
      'CommonModules/Mod/Ext/Module.bsl',
      'Catalogs/Ref.xml',
      'Catalogs/Ref/Forms/Form.xml',
      'Documents/Doc.xml',
    ];
    const result = filterOutLockedObjectFiles(files, [
      locked('CommonModule.Mod'),
      locked('Catalog.Ref'),
    ]);
    assert.deepStrictEqual(result.filtered, [
      'CommonModules/Mod.xml',
      'CommonModules/Mod/Ext/Module.bsl',
      'Catalogs/Ref.xml',
      'Catalogs/Ref/Forms/Form.xml',
    ]);
    assert.deepStrictEqual(result.kept, ['Documents/Doc.xml']);
  });

  test('comparison is case-insensitive', () => {
    const files = [
      'COMMONMODULES/FOO.XML',
      'commonmodules/foo/ext/module.bsl',
    ];
    const result = filterOutLockedObjectFiles(files, [locked('CommonModule.Foo')]);
    assert.strictEqual(result.filtered.length, 2);
    assert.strictEqual(result.kept.length, 0);
  });
});
