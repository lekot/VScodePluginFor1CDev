import * as assert from 'assert';
import { parseXdtoPackage } from '../../src/parsers/xdtoPackageParser';
import {
  applyXdtoPackageMerge,
  buildXdtoPackageCompareTree,
  parseXdtoComparableSource,
} from '../../src/xdtoPackageCompare/xdtoPackageCompareModel';

suite('XdtoPackageCompareModel', () => {
  test('builds a compare tree down to object property fields', () => {
    const left = parseXdtoPackage(`\uFEFF<package xmlns="http://v8.1c.ru/8.1/xdto" targetNamespace="urn:left">
  <objectType name="Order">
    <property name="Number" type="xs:string" lowerBound="1"/>
  </objectType>
</package>`);
    const right = parseXdtoPackage(`\uFEFF<package xmlns="http://v8.1c.ru/8.1/xdto" targetNamespace="urn:right">
  <objectType name="Order">
    <property name="Number" type="xs:integer" lowerBound="0" upperBound="1"/>
    <property name="Posted" type="xs:boolean"/>
  </objectType>
</package>`);

    const tree = buildXdtoPackageCompareTree(left, right);
    const objectType = tree.root.children.find((node) => node.id === 'objectTypes')?.children
      .find((node) => node.id === 'objectTypes:Order');
    assert.ok(objectType, 'object type node must be present');

    const propertiesGroup = objectType.children.find((node) => node.id === 'objectTypes:Order:properties');
    assert.ok(propertiesGroup, 'object properties group must be present');

    const numberProperty = propertiesGroup.children.find(
      (node) => node.id === 'objectTypes:Order:properties:Number'
    );
    assert.ok(numberProperty, 'changed property node must be present');
    assert.strictEqual(numberProperty.status, 'changed');
    assert.ok(
      numberProperty.children.some((node) => node.id === 'objectTypes:Order:properties:Number:type'),
      'property type field diff must be present'
    );

    const postedProperty = propertiesGroup.children.find(
      (node) => node.id === 'objectTypes:Order:properties:Posted'
    );
    assert.ok(postedProperty, 'right-only property node must be present');
    assert.strictEqual(postedProperty.status, 'rightOnly');
    assert.strictEqual(tree.stats.different, 4);
  });

  test('does not report QName differences when only namespace prefixes differ', () => {
    const left = parseXdtoPackage(`\uFEFF<package xmlns="http://v8.1c.ru/8.1/xdto" xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:local">
  <import namespace="urn:common"/>
  <valueType name="DocumentRef" base="d2p1:Ref"/>
  <objectType name="Order" base="LocalBase">
    <property name="Owner" type="d2p1:CatalogRef"/>
    <property name="Local" type="LocalBase"/>
    <property name="Nested" type="d3p1:Order.Line" lowerBound="1" upperBound="1" nillable="false"/>
  </objectType>
  <objectType name="LocalBase"/>
  <objectType name="Order.Line"/>
</package>`);
    const right = parseXdtoPackage(`\uFEFF<package xmlns="http://v8.1c.ru/8.1/xdto" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:ns1="urn:common" xmlns:tns="urn:local" targetNamespace="urn:local">
  <import namespace="urn:common"/>
  <valueType name="DocumentRef" base="ns1:Ref"/>
  <objectType name="Order" base="tns:LocalBase">
    <property name="Owner" type="ns1:CatalogRef"/>
    <property name="Local" type="tns:LocalBase"/>
    <property name="Nested" type="tns:Order.Line"/>
  </objectType>
  <objectType name="LocalBase"/>
  <objectType name="Order.Line"/>
</package>`);

    const tree = buildXdtoPackageCompareTree(left, right);

    assert.strictEqual(tree.stats.different, 0);
    assert.strictEqual(tree.stats.mergeable, 0);
  });

  test('reports value type facet differences', () => {
    const left = parseXdtoPackage(`\uFEFF<package xmlns="http://v8.1c.ru/8.1/xdto">
  <valueType name="Code" base="xs:string" maxLength="13"/>
</package>`);
    const right = parseXdtoPackage(`\uFEFF<package xmlns="http://v8.1c.ru/8.1/xdto">
  <valueType name="Code" base="xs:string" maxLength="20"/>
</package>`);

    const tree = buildXdtoPackageCompareTree(left, right);
    const valueType = tree.root.children.find((node) => node.id === 'valueTypes')?.children
      .find((node) => node.id === 'valueTypes:Code');
    const facets = valueType?.children.find((node) => node.id === 'valueTypes:Code:facets');

    assert.ok(facets, 'value type facets group must be present');
    assert.strictEqual(facets.status, 'changed');
    assert.ok(facets.children.some((node) => node.leftValue === '13' && node.rightValue === '20'));
  });

  test('merges selected value type facet changes', () => {
    const left = parseXdtoPackage(`\uFEFF<package xmlns="http://v8.1c.ru/8.1/xdto">
  <valueType name="Code" base="xs:string" maxLength="13"/>
</package>`);
    const right = parseXdtoPackage(`\uFEFF<package xmlns="http://v8.1c.ru/8.1/xdto">
  <valueType name="Code" base="xs:string" maxLength="20"/>
</package>`);

    const merged = applyXdtoPackageMerge(left, right, ['valueTypes:Code:facets:maxLength:0']);
    const code = merged.valueTypes.find((type) => type.name === 'Code');

    assert.strictEqual(code?.facets.find((facet) => facet.name === 'maxLength')?.value, '20');
  });

  test('merges selected right-side object property changes without deleting left-only nodes', () => {
    const left = parseXdtoPackage(`\uFEFF<package xmlns="http://v8.1c.ru/8.1/xdto">
  <objectType name="Order">
    <property name="Number" type="xs:string" lowerBound="1"/>
    <property name="Legacy" type="xs:string"/>
  </objectType>
</package>`);
    const right = parseXdtoPackage(`\uFEFF<package xmlns="http://v8.1c.ru/8.1/xdto">
  <objectType name="Order">
    <property name="Number" type="xs:integer" lowerBound="0"/>
    <property name="Posted" type="xs:boolean"/>
  </objectType>
</package>`);

    const merged = applyXdtoPackageMerge(left, right, [
      'objectTypes:Order:properties:Number:type',
      'objectTypes:Order:properties:Posted',
    ]);
    const order = merged.objectTypes.find((type) => type.name === 'Order');
    assert.ok(order, 'merged object type must be present');

    assert.strictEqual(order.properties.find((property) => property.name === 'Number')?.type, 'xs:integer');
    assert.strictEqual(order.properties.find((property) => property.name === 'Number')?.lowerBound, '1');
    assert.strictEqual(order.properties.find((property) => property.name === 'Posted')?.type, 'xs:boolean');
    assert.strictEqual(order.properties.find((property) => property.name === 'Legacy')?.type, 'xs:string');
  });

  test('normalizes external xsd/xml/bin/xdto sources to comparable XDTO packages', () => {
    const xsdModel = parseXdtoComparableSource(
      'schema.xsd',
      '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:complexType name="External"/></xs:schema>'
    );
    const binModel = parseXdtoComparableSource(
      'Package.bin',
      '\uFEFF<package xmlns="http://v8.1c.ru/8.1/xdto"><objectType name="Internal"/></package>'
    );

    assert.strictEqual(xsdModel.objectTypes[0]?.name, 'External');
    assert.strictEqual(binModel.objectTypes[0]?.name, 'Internal');
  });
});
