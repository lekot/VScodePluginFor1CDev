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
    const invalidXml = '<?xml version="1.0"?><root><item>test</root>';

    assert.throws(() => {
      XmlParser.parseString(invalidXml);
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
