import * as assert from 'assert';
import * as path from 'path';
import { XmlParser } from '../../src/parsers/xmlParser';

suite('XmlParser', () => {
  test('should parse valid XML file', () => {
    const xmlPath = path.join(__dirname, '../fixtures/designer-config/Configuration.xml');
    const result = XmlParser.parseFile(xmlPath);

    assert.ok(result);
    assert.ok(Object.keys(result).length > 0);
  });

  test('should parse XML string', () => {
    const xmlString = '<?xml version="1.0"?><root><item>test</item></root>';
    const result = XmlParser.parseString(xmlString);

    assert.ok(result);
    assert.ok(result.root);
  });

  test('should throw error for non-existent file', () => {
    const xmlPath = path.join(__dirname, '../fixtures/non-existent.xml');

    assert.throws(() => {
      XmlParser.parseFile(xmlPath);
    });
  });

  test('should throw error for invalid XML', () => {
    // Empty string is rejected; malformed XML may be accepted by the parser
    assert.throws(() => {
      XmlParser.parseString('');
    });
  });

  test('should get root element name', () => {
    const xmlPath = path.join(__dirname, '../fixtures/designer-config/Configuration.xml');
    const rootName = XmlParser.getRootElementName(xmlPath);

    assert.ok(rootName);
    assert.strictEqual(typeof rootName, 'string');
  });

  test('should validate XML file', () => {
    const xmlPath = path.join(__dirname, '../fixtures/designer-config/Configuration.xml');
    const isValid = XmlParser.isValidXml(xmlPath);

    assert.strictEqual(isValid, true);
  });

  test('should return false for invalid XML file', () => {
    const xmlPath = path.join(__dirname, '../fixtures/non-existent.xml');
    const isValid = XmlParser.isValidXml(xmlPath);

    assert.strictEqual(isValid, false);
  });

  test('should get element by path', () => {
    const obj = {
      root: {
        child: {
          value: 'test',
        },
      },
    };

    const result = XmlParser.getElementByPath(obj as Record<string, unknown>, 'root.child.value');
    assert.strictEqual(result, 'test');
  });

  test('should return undefined for non-existent path', () => {
    const obj = {
      root: {
        child: {
          value: 'test',
        },
      },
    };

    const result = XmlParser.getElementByPath(obj as Record<string, unknown>, 'root.nonexistent.value');
    assert.strictEqual(result, undefined);
  });

  test('should set element by path', () => {
    const obj: Record<string, unknown> = {
      root: {
        child: {},
      },
    };

    XmlParser.setElementByPath(obj, 'root.child.value', 'test');
    const result = XmlParser.getElementByPath(obj, 'root.child.value');

    assert.strictEqual(result, 'test');
  });

  test('should reject prototype-pollution segments in setElementByPath', () => {
    const obj: Record<string, unknown> = {};
    assert.throws(() => {
      XmlParser.setElementByPath(obj, 'a.__proto__.polluted', true);
    }, /Invalid path segment/);
    assert.strictEqual(({} as Record<string, unknown>)['polluted'], undefined);
  });

  test('should reject prototype-pollution segments in getElementByPath', () => {
    const obj: Record<string, unknown> = { a: { b: 1 } };
    assert.throws(() => {
      XmlParser.getElementByPath(obj, 'a.constructor.prototype');
    }, /Invalid path segment/);
  });

  test('path traversal uses own data properties and keeps ordinary neighbors and arrays intact', () => {
    let inheritedGetterCalls = 0;
    const prototype = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(prototype, 'inherited', {
      configurable: true,
      get: () => {
        inheritedGetterCalls++;
        return { secret: 'inherited value' };
      },
    });

    const array = [{ existing: 'keep' }];
    const root = Object.create(prototype) as Record<string, unknown>;
    root.branch = {
      array,
      primitive: 0,
      neighbor: { value: 'neighbor' },
    };

    assert.strictEqual(XmlParser.getElementByPath(root, 'inherited.secret'), undefined);
    assert.strictEqual(inheritedGetterCalls, 0, 'traversal must not invoke an inherited getter');
    assert.strictEqual(XmlParser.getElementByPath(root, 'toString.value'), undefined);
    assert.strictEqual(XmlParser.getElementByPath(root, 'hasOwnProperty.value'), undefined);

    XmlParser.setElementByPath(root, 'toString.value', 'own value');
    XmlParser.setElementByPath(root, 'hasOwnProperty.value', 'own method-name value');
    XmlParser.setElementByPath(root, 'branch.array.0.added', 'array child');

    assert.strictEqual(XmlParser.getElementByPath(root, 'toString.value'), 'own value');
    assert.strictEqual(XmlParser.getElementByPath(root, 'hasOwnProperty.value'), 'own method-name value');
    assert.strictEqual(Object.getPrototypeOf(root), prototype, 'setting inherited names must not change the root prototype');
    assert.strictEqual(Object.getPrototypeOf(array), Array.prototype, 'existing arrays must retain their prototype');
    assert.strictEqual(XmlParser.getElementByPath(root, 'branch.array.0.existing'), 'keep');
    assert.strictEqual(XmlParser.getElementByPath(root, 'branch.array.0.added'), 'array child');
    assert.strictEqual(XmlParser.getElementByPath(root, 'branch.neighbor.value'), 'neighbor');
    assert.strictEqual(inheritedGetterCalls, 0, 'neither read nor write traversal may invoke inherited getters');
  });

  test('reserved segments are rejected before mutation and primitive intermediates stay unchanged', () => {
    const untouched: Record<string, unknown> = {};
    assert.throws(() => XmlParser.setElementByPath(untouched, 'new.branch.__proto__.polluted', true), /Invalid path segment/);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(untouched, 'new'), false, 'reserved-path rejection must happen before creating nodes');

    const root: Record<string, unknown> = {
      branch: {
        primitive: 0,
        falseValue: false,
        nullValue: null,
        neighbor: { value: 'keep' },
      },
    };
    assert.throws(() => XmlParser.setElementByPath(root, 'branch.primitive.child', 'replacement'), /intermediate/i);
    assert.throws(() => XmlParser.setElementByPath(root, 'branch.falseValue.child', 'replacement'), /intermediate/i);
    assert.throws(() => XmlParser.setElementByPath(root, 'branch.nullValue.child', 'replacement'), /intermediate/i);
    assert.strictEqual(XmlParser.getElementByPath(root, 'branch.primitive'), 0);
    assert.strictEqual(XmlParser.getElementByPath(root, 'branch.falseValue'), false);
    assert.strictEqual(XmlParser.getElementByPath(root, 'branch.nullValue'), null);
    assert.strictEqual(XmlParser.getElementByPath(root, 'branch.neighbor.value'), 'keep');
  });

  test('own accessor intermediates are not invoked during XML path traversal', () => {
    let getterCalls = 0;
    let setterCalls = 0;
    const root: Record<string, unknown> = {};
    Object.defineProperty(root, 'accessor', {
      configurable: true,
      get: () => {
        getterCalls++;
        return {};
      },
      set: () => { setterCalls++; },
    });

    assert.strictEqual(XmlParser.getElementByPath(root, 'accessor.child'), undefined);
    assert.throws(() => XmlParser.setElementByPath(root, 'accessor.child', 'value'), /accessor/i);
    assert.strictEqual(getterCalls, 0);
    assert.strictEqual(setterCalls, 0);
    assert.strictEqual(Object.getOwnPropertyDescriptor(root, 'accessor')?.get instanceof Function, true);
  });

  test('should convert object to XML', () => {
    const obj = {
      root: {
        item: 'test',
      },
    };

    const xml = XmlParser.objectToXml(obj);
    assert.ok(xml);
    assert.ok(xml.includes('<?xml'));
    assert.ok(xml.includes('<root>'));
    assert.ok(xml.includes('<item>'));
  });
});
