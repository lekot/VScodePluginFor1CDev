import * as assert from 'assert';
import { convert1cPackageToXsd, convertXsdTo1cPackage } from '../../src/xdtoPackageEditor/xdtoXsdConverter';
import { parseXdtoPackage } from '../../src/parsers/xdtoPackageParser';

suite('XdtoXsdConverter', () => {
  test('exports 1C Package.bin XML to XSD schema', () => {
    const source = `\uFEFF<package xmlns="http://v8.1c.ru/8.1/xdto" xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:rates">
  <objectType name="Rate">
    <property name="Code" type="xs:string" lowerBound="1" form="Attribute"/>
    <property name="Value" type="xs:decimal" lowerBound="0"/>
  </objectType>
</package>`;

    const xsd = convert1cPackageToXsd(source);

    assert.ok(xsd.includes('<xs:schema'));
    assert.ok(xsd.includes('targetNamespace="urn:rates"'));
    assert.ok(xsd.includes('<xs:attribute name="Code" type="xs:string" use="required"/>'));
    assert.ok(xsd.includes('<xs:element name="Value" type="xs:decimal" minOccurs="0"/>'));
  });

  test('exports local unprefixed 1C references as tns-qualified XSD references', () => {
    const source = `\uFEFF<package xmlns="http://v8.1c.ru/8.1/xdto" xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:rates">
  <valueType name="Amount" base="xs:decimal"/>
  <valueType name="Money" base="Amount"/>
  <objectType name="BaseDocument"/>
  <objectType name="Invoice" base="BaseDocument">
    <property name="Amount" type="Amount"/>
    <property name="Title" type="xs:string"/>
    <property name="External" type="erp:Counterparty"/>
    <property name="Code" type="Amount" form="Attribute"/>
  </objectType>
</package>`;

    const xsd = convert1cPackageToXsd(source);

    assert.ok(xsd.includes('xmlns:tns="urn:rates"'));
    assert.ok(xsd.includes('<xs:restriction base="tns:Amount"/>'));
    assert.ok(xsd.includes('<xs:extension base="tns:BaseDocument">'));
    assert.ok(xsd.includes('<xs:element name="Amount" type="tns:Amount"/>'));
    assert.ok(xsd.includes('<xs:attribute name="Code" type="tns:Amount"/>'));
    assert.ok(xsd.includes('<xs:element name="Title" type="xs:string"/>'));
  assert.ok(xsd.includes('<xs:element name="External" type="erp:Counterparty"/>'));
  });

  test('does not treat root element names as local type definitions on export', () => {
    const source = `\uFEFF<package xmlns="http://v8.1c.ru/8.1/xdto" xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:rates">
  <property name="Rate" type="xs:string"/>
  <objectType name="Wrapper">
    <property name="Value" type="Rate"/>
  </objectType>
</package>`;

    const xsd = convert1cPackageToXsd(source);

    assert.ok(xsd.includes('<xs:element name="Value" type="Rate"/>'));
    assert.ok(xsd.includes('<xs:element name="Rate" type="xs:string"/>'));
  });

  test('imports XSD schema to 1C package XML', () => {
    const xsd = `<?xml version="1.0" encoding="UTF-8"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:rates">
  <xs:complexType name="Rate">
    <xs:sequence>
      <xs:element name="Value" type="xs:decimal" minOccurs="0" maxOccurs="unbounded"/>
    </xs:sequence>
    <xs:attribute name="Code" type="xs:string" use="required"/>
  </xs:complexType>
</xs:schema>`;

    const packageXml = convertXsdTo1cPackage(xsd);
    const model = parseXdtoPackage(packageXml);

    assert.strictEqual(model.targetNamespace, 'urn:rates');
    assert.deepStrictEqual(
      model.objectTypes[0].attributes.map((property) => ({
        name: property.name,
        type: property.type,
        form: property.form,
        lowerBound: property.lowerBound,
      })),
      [{ name: 'Code', type: 'xs:string', form: 'Attribute', lowerBound: '1' }]
    );
    assert.deepStrictEqual(
      model.objectTypes[0].properties.map((property) => ({
        name: property.name,
        type: property.type,
        lowerBound: property.lowerBound,
        upperBound: property.upperBound,
      })),
      [{ name: 'Value', type: 'xs:decimal', lowerBound: '0', upperBound: '-1' }]
    );
  });

  test('imports XSD namespace prefix declarations to 1C package XML', () => {
    const xsd = `<?xml version="1.0" encoding="UTF-8"?>
<xs:schema xmlns="urn:default" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:tns="urn:rates" xmlns:erp="urn:erp">
  <xs:complexType name="Rate">
    <xs:sequence>
      <xs:element name="Value" type="tns:Rate"/>
      <xs:element name="Owner" type="erp:Counterparty"/>
    </xs:sequence>
  </xs:complexType>
</xs:schema>`;

    const packageXml = convertXsdTo1cPackage(xsd);

    assert.ok(packageXml.includes('<package xmlns="http://v8.1c.ru/8.1/xdto"'));
    assert.ok(packageXml.includes(' xmlns:tns="urn:rates"'));
    assert.ok(packageXml.includes(' xmlns:erp="urn:erp"'));
    assert.ok(!packageXml.includes('targetNamespace=""'));
    assert.ok(!packageXml.includes('xmlns="urn:default"'));
    assert.ok(packageXml.includes('<property name="Value" type="tns:Rate"'));
    assert.ok(packageXml.includes('<property name="Owner" type="erp:Counterparty"'));
  });
});
