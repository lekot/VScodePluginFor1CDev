import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { formXmlExists, getFormPaths } from '../../src/formEditor/formPaths';

suite('formPaths', () => {
  test('getFormPaths: Ext/Form.xml → formDirectory is Ext, module under Form/', () => {
    const formXml = path.join('proj', 'Catalogs', 'Goods', 'Forms', 'ФормаСписка', 'Ext', 'Form.xml');
    const r = getFormPaths(formXml);
    assert.strictEqual(r.formXmlPath, formXml);
    assert.strictEqual(r.formDirectory, path.join('proj', 'Catalogs', 'Goods', 'Forms', 'ФормаСписка', 'Ext'));
    assert.strictEqual(r.modulePath, path.join(r.formDirectory, 'Form', 'Module.bsl'));
  });

  test('getFormPaths: Forms/{Name}.xml (Designer) → Ext/Form.xml next to stem folder', () => {
    const metaXml = path.join('conf', 'Forms', 'ФормаЭлемента.xml');
    const r = getFormPaths(metaXml);
    const extRoot = path.join('conf', 'Forms', 'ФормаЭлемента');
    assert.strictEqual(r.formDirectory, extRoot);
    assert.strictEqual(r.formXmlPath, path.join(extRoot, 'Ext', 'Form.xml'));
    assert.strictEqual(r.modulePath, path.join(extRoot, 'Ext', 'Form', 'Module.bsl'));
  });

  test('getFormPaths: .XML extension is treated as metadata xml', () => {
    const metaXml = path.join('conf', 'Forms', 'MyForm.XML');
    const r = getFormPaths(metaXml);
    const extRoot = path.join('conf', 'Forms', 'MyForm');
    assert.strictEqual(r.formDirectory, extRoot);
    assert.strictEqual(r.formXmlPath, path.join(extRoot, 'Ext', 'Form.xml'));
  });

  test('getFormPaths: directory path (legacy layout) → Ext/Form.xml under directory', () => {
    const dir = path.join('conf', 'Forms', 'ФормаЭлемента');
    const r = getFormPaths(dir);
    assert.strictEqual(r.formDirectory, dir);
    assert.strictEqual(r.formXmlPath, path.join(dir, 'Ext', 'Form.xml'));
    assert.strictEqual(r.modulePath, path.join(dir, 'Ext', 'Form', 'Module.bsl'));
  });

  test('formXmlExists: true when Ext/Form.xml is present', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formpaths-'));
    const extDir = path.join(root, 'Ext');
    fs.mkdirSync(path.join(extDir, 'Form'), { recursive: true });
    const formXml = path.join(extDir, 'Form.xml');
    fs.writeFileSync(formXml, '<Form/>', 'utf8');
    assert.strictEqual(formXmlExists(formXml), true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('formXmlExists: false when structure missing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formpaths-'));
    assert.strictEqual(formXmlExists(path.join(root, 'Ext', 'Form.xml')), false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('formXmlExists: true when opened via Forms/Name.xml and Ext/Form.xml exists', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formpaths-'));
    const formsDir = path.join(root, 'Forms');
    const stem = path.join(formsDir, 'TestForm');
    const extForm = path.join(stem, 'Ext', 'Form.xml');
    fs.mkdirSync(path.dirname(extForm), { recursive: true });
    fs.writeFileSync(extForm, '<Form/>', 'utf8');
    const metaXml = path.join(formsDir, 'TestForm.xml');
    assert.strictEqual(formXmlExists(metaXml), true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
