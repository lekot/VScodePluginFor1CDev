import * as assert from 'assert';
import { parseXdtoPackage } from '../../src/parsers/xdtoPackageParser';

suite('XdtoPackageParser', () => {
  test('parses XSD simple and complex types with attributes and elements', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:demo">
  <xs:import namespace="urn:common" schemaLocation="common.xsd"/>
  <xs:simpleType name="Code">
    <xs:restriction base="xs:string"/>
  </xs:simpleType>
  <xs:complexType name="Customer">
    <xs:sequence>
      <xs:element name="Name" type="xs:string" minOccurs="0" maxOccurs="1"/>
      <xs:element name="Code" type="Code"/>
    </xs:sequence>
    <xs:attribute name="Active" type="xs:boolean" use="optional"/>
  </xs:complexType>
  <xs:element name="RootCustomer" type="Customer"/>
</xs:schema>`;

    const model = parseXdtoPackage(xml);

    assert.strictEqual(model.targetNamespace, 'urn:demo');
    assert.deepStrictEqual(model.imports, [
      { namespace: 'urn:common', schemaLocation: 'common.xsd', raw: model.imports[0].raw },
    ]);
    assert.strictEqual(model.valueTypes.length, 1);
    assert.strictEqual(model.valueTypes[0].name, 'Code');
    assert.strictEqual(model.valueTypes[0].baseType, 'xs:string');
    assert.strictEqual(model.objectTypes.length, 1);
    assert.strictEqual(model.objectTypes[0].name, 'Customer');
    assert.deepStrictEqual(
      model.objectTypes[0].properties.map((property) => ({
        name: property.name,
        type: property.type,
        minOccurs: property.minOccurs,
        maxOccurs: property.maxOccurs,
      })),
      [
        { name: 'Name', type: 'xs:string', minOccurs: '0', maxOccurs: '1' },
        { name: 'Code', type: 'Code', minOccurs: undefined, maxOccurs: undefined },
      ]
    );
    assert.deepStrictEqual(
      model.objectTypes[0].attributes.map((attribute) => ({
        name: attribute.name,
        type: attribute.type,
        use: attribute.use,
      })),
      [{ name: 'Active', type: 'xs:boolean', use: 'optional' }]
    );
    assert.deepStrictEqual(
      model.rootProperties.map((property) => ({ name: property.name, type: property.type })),
      [{ name: 'RootCustomer', type: 'Customer' }]
    );
    assert.deepStrictEqual(model.diagnostics, []);
  });

  test('parses 1C-ish valueType objectType and property tags without namespace coupling', () => {
    const xml = `<xdto:package xmlns:xdto="http://v8.1c.ru/8.1/xdto" targetNamespace="urn:demo">
  <xdto:valueType name="Amount" base="xs:decimal">
    <xdto:unknownFacet value="kept"/>
  </xdto:valueType>
  <xdto:objectType name="Order">
    <xdto:property name="Number" type="xs:string"/>
    <xdto:property name="Amount" type="Amount"/>
  </xdto:objectType>
  <xdto:property name="RootOrder" type="Order"/>
  <vendorExtension enabled="true"/>
</xdto:package>`;

    const model = parseXdtoPackage(xml);

    assert.strictEqual(model.targetNamespace, 'urn:demo');
    assert.strictEqual(model.valueTypes.length, 1);
    assert.strictEqual(model.valueTypes[0].name, 'Amount');
    assert.strictEqual(model.valueTypes[0].baseType, 'xs:decimal');
    assert.deepStrictEqual(
      model.valueTypes[0].unknownNodes.map((node) => node.localName),
      ['unknownFacet']
    );
    assert.strictEqual(model.objectTypes.length, 1);
    assert.strictEqual(model.objectTypes[0].name, 'Order');
    assert.deepStrictEqual(
      model.objectTypes[0].properties.map((property) => ({ name: property.name, type: property.type })),
      [
        { name: 'Number', type: 'xs:string' },
        { name: 'Amount', type: 'Amount' },
      ]
    );
    assert.deepStrictEqual(
      model.rootProperties.map((property) => ({ name: property.name, type: property.type })),
      [{ name: 'RootOrder', type: 'Order' }]
    );
    assert.deepStrictEqual(
      model.unknownNodes.map((node) => node.localName),
      ['vendorExtension']
    );
    assert.deepStrictEqual(model.diagnostics, []);
  });

  test('parses XDTO package under 1C Model envelope', () => {
    const xml = `<Model>
  <xdto:package xmlns:xdto="http://v8.1c.ru/8.1/xdto" targetNamespace="urn:wrapped">
    <xdto:objectType name="Wrapped">
      <xdto:property name="Title" type="xs:string"/>
    </xdto:objectType>
  </xdto:package>
</Model>`;

    const model = parseXdtoPackage(xml);

    assert.strictEqual(model.targetNamespace, 'urn:wrapped');
    assert.deepStrictEqual(
      model.objectTypes.map((type) => ({
        name: type.name,
        properties: type.properties.map((property) => ({ name: property.name, type: property.type })),
      })),
      [
        {
          name: 'Wrapped',
          properties: [{ name: 'Title', type: 'xs:string' }],
        },
      ]
    );
    assert.deepStrictEqual(model.diagnostics, []);
  });

  test('parses inherited XSD members under complexContent extension', () => {
    const xml = `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:complexType name="Child">
    <xs:complexContent>
      <xs:extension base="Base">
        <xs:sequence>
          <xs:element name="Extra" type="xs:string"/>
        </xs:sequence>
        <xs:attribute name="Flag" type="xs:boolean"/>
      </xs:extension>
    </xs:complexContent>
  </xs:complexType>
</xs:schema>`;

    const model = parseXdtoPackage(xml);

    assert.strictEqual(model.objectTypes[0].baseType, 'Base');
    assert.deepStrictEqual(
      model.objectTypes[0].properties.map((property) => ({ name: property.name, type: property.type })),
      [{ name: 'Extra', type: 'xs:string' }]
    );
    assert.deepStrictEqual(
      model.objectTypes[0].attributes.map((attribute) => ({ name: attribute.name, type: attribute.type })),
      [{ name: 'Flag', type: 'xs:boolean' }]
    );
  });

  test('parses Designer Package.bin XML with 1C lowerBound and attribute form', () => {
    const xml = `\uFEFF<package xmlns="http://v8.1c.ru/8.1/xdto" xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:rates">
  <objectType name="Rate">
    <property name="Code" type="xs:string" lowerBound="1" form="Attribute"/>
    <property name="Value" type="xs:decimal" lowerBound="0"/>
  </objectType>
</package>`;

    const model = parseXdtoPackage(xml);

    assert.strictEqual(model.targetNamespace, 'urn:rates');
    assert.deepStrictEqual(
      model.objectTypes[0].attributes.map((property) => ({
        name: property.name,
        type: property.type,
        lowerBound: property.lowerBound,
        form: property.form,
      })),
      [{ name: 'Code', type: 'xs:string', lowerBound: '1', form: 'Attribute' }]
    );
    assert.deepStrictEqual(
      model.objectTypes[0].properties.map((property) => ({
        name: property.name,
        type: property.type,
        lowerBound: property.lowerBound,
      })),
      [{ name: 'Value', type: 'xs:decimal', lowerBound: '0' }]
    );
  });

  test('malformed XML returns diagnostic instead of throwing', () => {
    const model = parseXdtoPackage('<xs:schema><xs:complexType name="Broken"></xs:schema>');

    assert.strictEqual(model.targetNamespace, undefined);
    assert.deepStrictEqual(model.imports, []);
    assert.deepStrictEqual(model.valueTypes, []);
    assert.deepStrictEqual(model.objectTypes, []);
    assert.deepStrictEqual(model.rootProperties, []);
    assert.strictEqual(model.diagnostics.length, 1);
    assert.strictEqual(model.diagnostics[0].severity, 'error');
    assert.strictEqual(model.diagnostics[0].code, 'MALFORMED_XML');
  });
});
