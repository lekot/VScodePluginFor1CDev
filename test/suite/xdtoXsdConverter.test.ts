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

  test('exports 1C value type restrictions as XSD facets', () => {
    const source = `\uFEFF<package xmlns="http://v8.1c.ru/8.1/xdto" xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <valueType name="Code13" base="xs:string" maxLength="13"/>
  <valueType name="Money" base="xs:decimal" totalDigits="15" fractionDigits="2"/>
  <valueType name="DateText" base="xs:string" variety="Atomic">
    <pattern>[0-9]{2}\\.[0-9]{2}\\.[0-9]{4}</pattern>
  </valueType>
  <valueType name="Status" base="xs:string" variety="Atomic">
    <enumeration xsi:type="xs:string">New</enumeration>
    <enumeration xsi:type="xs:string">Done</enumeration>
  </valueType>
</package>`;

    const xsd = convert1cPackageToXsd(source);

    assert.ok(xsd.includes('<xs:maxLength value="13"/>'));
    assert.ok(xsd.includes('<xs:totalDigits value="15"/>'));
    assert.ok(xsd.includes('<xs:fractionDigits value="2"/>'));
    assert.ok(xsd.includes('<xs:pattern value="[0-9]{2}\\.[0-9]{2}\\.[0-9]{4}"/>'));
    assert.ok(xsd.includes('<xs:enumeration value="New"/>'));
    assert.ok(xsd.includes('<xs:enumeration value="Done"/>'));
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

  test('exports imported 1C prefixes with platform-style ns aliases', () => {
    const source = `\uFEFF<package xmlns="http://v8.1c.ru/8.1/xdto" targetNamespace="urn:local">
  <import namespace="urn:common"/>
  <valueType xmlns:d2p1="urn:common" name="ExternalRef" base="d2p1:Ref"/>
</package>`;

    const xsd = convert1cPackageToXsd(source);

    assert.ok(xsd.startsWith('\uFEFF<xs:schema xmlns:ns1="urn:common" xmlns:tns="urn:local" xmlns:xs="http://www.w3.org/2001/XMLSchema"'));
    assert.ok(xsd.includes('<xs:restriction base="ns1:Ref"/>'));
  });

  test('exports inline 1C property type definitions as anonymous XSD types', () => {
    const source = `\uFEFF<package xmlns="http://v8.1c.ru/8.1/xdto" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" targetNamespace="urn:local">
  <objectType name="AnyRef">
    <property name="Choice">
      <typeDef xsi:type="ObjectType" ordered="false">
        <property xmlns:d5p1="urn:local" name="CatalogRef" type="d5p1:Catalog.Ref" lowerBound="0"/>
      </typeDef>
    </property>
    <property name="Sequence">
      <typeDef xsi:type="ObjectType">
        <property xmlns:d5p1="urn:local" name="CatalogRef" type="d5p1:Catalog.Ref" lowerBound="0"/>
      </typeDef>
    </property>
    <property name="Amount" lowerBound="0" nillable="true">
      <typeDef xsi:type="ValueType" base="xs:decimal" totalDigits="18" fractionDigits="6"/>
    </property>
    <property name="DateOrZero" lowerBound="0">
      <typeDef xsi:type="ValueType" variety="Union" memberTypes="{urn:local}DateText {urn:local}Zero"/>
    </property>
    <property name="PeriodKind">
      <typeDef xsi:type="ValueType" base="xs:string" variety="Atomic">
        <enumeration>Day</enumeration>
        <enumeration>Month</enumeration>
      </typeDef>
    </property>
  </objectType>
  <valueType name="DateText" base="xs:string"/>
  <valueType name="Zero" base="xs:string"/>
</package>`;

    const xsd = convert1cPackageToXsd(source);

    assert.ok(xsd.includes('<xs:element name="Choice">'));
    assert.ok(xsd.includes('<xs:complexType>'));
    assert.ok(xsd.includes('<xs:choice>'));
    assert.ok(xsd.includes('<xs:sequence>'));
    assert.ok(xsd.includes('<xs:element name="CatalogRef" type="tns:Catalog.Ref" minOccurs="0"/>'));
    assert.ok(xsd.includes('<xs:element name="Amount" nillable="true" minOccurs="0">'));
    assert.ok(xsd.includes('<xs:simpleType>'));
    assert.ok(xsd.includes('<xs:totalDigits value="18"/>'));
    assert.ok(xsd.includes('<xs:fractionDigits value="6"/>'));
    assert.ok(xsd.includes('<xs:union memberTypes="tns:DateText tns:Zero"/>'));
    assert.ok(xsd.includes('<xs:enumeration value="Day"/>'));
    assert.ok(xsd.includes('<xs:enumeration value="Month"/>'));
  });

  test('exports open 1C object types as XSD wildcard extension points', () => {
    const source = `\uFEFF<package xmlns="http://v8.1c.ru/8.1/xdto">
  <objectType name="ExtensionPoint" open="true" sequenced="true">
    <property name="Known" type="xs:string"/>
  </objectType>
</package>`;

    const xsd = convert1cPackageToXsd(source);

    assert.ok(xsd.includes('<xs:element name="Known" type="xs:string"/>'));
    assert.ok(xsd.includes('<xs:any namespace="##any" processContents="lax" minOccurs="0" maxOccurs="unbounded"/>'));
    assert.ok(xsd.includes('<xs:anyAttribute namespace="##any" processContents="lax"/>'));
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
      <xs:element name="Value" type="xs:decimal" minOccurs="0" maxOccurs="unbounded" nillable="true" default="0"/>
    </xs:sequence>
    <xs:attribute name="Code" type="xs:string" use="required" fixed="A"/>
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
        fixed: property.fixed,
      })),
      [{ name: 'Code', type: 'xs:string', form: 'Attribute', lowerBound: '1', fixed: 'A' }]
    );
    assert.deepStrictEqual(
      model.objectTypes[0].properties.map((property) => ({
        name: property.name,
        type: property.type,
        lowerBound: property.lowerBound,
        upperBound: property.upperBound,
        nillable: property.nillable,
        defaultValue: property.defaultValue,
      })),
      [{ name: 'Value', type: 'xs:decimal', lowerBound: '0', upperBound: '-1', nillable: 'true', defaultValue: '0' }]
    );
  });

  test('imports XSD value type facets to 1C package restrictions', () => {
    const xsd = `<?xml version="1.0" encoding="UTF-8"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:simpleType name="Code13">
    <xs:restriction base="xs:string">
      <xs:maxLength value="13"/>
    </xs:restriction>
  </xs:simpleType>
  <xs:simpleType name="Status">
    <xs:restriction base="xs:string">
      <xs:enumeration value="New"/>
      <xs:enumeration value="Done"/>
    </xs:restriction>
  </xs:simpleType>
</xs:schema>`;

    const packageXml = convertXsdTo1cPackage(xsd);
    const model = parseXdtoPackage(packageXml);

    assert.strictEqual(model.valueTypes.find((type) => type.name === 'Code13')?.facets[0]?.value, '13');
    assert.deepStrictEqual(
      model.valueTypes.find((type) => type.name === 'Status')?.facets.map((facet) => [facet.name, facet.value]),
      [['enumeration', 'New'], ['enumeration', 'Done']]
    );
    assert.ok(packageXml.includes('<valueType name="Code13" base="xs:string" maxLength="13"/>'));
    assert.ok(packageXml.includes('<enumeration>New</enumeration>'));
    assert.ok(packageXml.includes('<enumeration>Done</enumeration>'));
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
