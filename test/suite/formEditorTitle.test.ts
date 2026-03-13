import * as assert from 'assert';
import * as path from 'path';
import { getFormEditorTitle } from '../../src/formEditor/formEditorTitle';

suite('formEditorTitle', () => {
  test('returns "ТипОбъекта ИмяОбъекта: ИмяФормы" for typical Catalogs path', () => {
    const formXmlPath = path.join('root', 'Catalogs', 'ТелеграмНаборУсловий', 'Forms', 'ФормаЭлемента', 'Ext', 'Form.xml');
    assert.strictEqual(getFormEditorTitle(formXmlPath), 'Справочник ТелеграмНаборУсловий: ФормаЭлемента');
  });

  test('returns correct title for Documents path', () => {
    const formXmlPath = path.join('c:', 'reps', '1c', 'Documents', 'ПриходТовара', 'Forms', 'ФормаДокумента', 'Ext', 'Form.xml');
    assert.strictEqual(getFormEditorTitle(formXmlPath), 'Документ ПриходТовара: ФормаДокумента');
  });

  test('returns correct title for Enums and DataProcessors', () => {
    assert.strictEqual(
      getFormEditorTitle(path.join('proj', 'Enums', 'СтатусЗаказа', 'Forms', 'ФормаВыбора', 'Ext', 'Form.xml')),
      'Перечисление СтатусЗаказа: ФормаВыбора'
    );
    assert.strictEqual(
      getFormEditorTitle(path.join('proj', 'DataProcessors', 'УниверсальнаяОбработка', 'Forms', 'Форма', 'Ext', 'Form.xml')),
      'Обработка УниверсальнаяОбработка: Форма'
    );
  });

  test('returns fallback for path not ending with Ext/Form.xml', () => {
    assert.strictEqual(getFormEditorTitle(path.join('root', 'Catalogs', 'X', 'Forms', 'Y', 'Form.xml')), 'Форма');
    assert.strictEqual(getFormEditorTitle(path.join('root', 'Form.xml')), 'Форма');
  });

  test('returns fallback when Forms segment is missing', () => {
    const formXmlPath = path.join('root', 'Catalogs', 'X', 'NotForms', 'ФормаЭлемента', 'Ext', 'Form.xml');
    assert.strictEqual(getFormEditorTitle(formXmlPath), 'Форма');
  });

  test('uses type folder as label when not in Russian map', () => {
    const formXmlPath = path.join('root', 'UnknownType', 'Obj', 'Forms', 'FormName', 'Ext', 'Form.xml');
    assert.strictEqual(getFormEditorTitle(formXmlPath), 'UnknownType Obj: FormName');
  });
});
