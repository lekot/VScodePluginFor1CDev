import * as assert from 'assert';
import { parseXdtoPackage } from '../../src/parsers/xdtoPackageParser';
import { serializeXdtoPackageModel } from '../../src/xdtoPackageEditor/xdtoPackageSerializer';
import type { XdtoPackageModel, XdtoProperty, XdtoRawNode, XdtoTypeDefinition } from '../../src/types/xdtoPackage';

function property(fields: Partial<XdtoProperty> & Pick<XdtoProperty, 'name'>): XdtoProperty {
  return {
    type: fields.type,
    ref: fields.ref,
    namespaceURI: fields.namespaceURI,
    localName: fields.localName,
    qualified: fields.qualified,
    nillable: fields.nillable,
    fixed: fields.fixed,
    defaultValue: fields.defaultValue,
    minOccurs: fields.minOccurs,
    maxOccurs: fields.maxOccurs,
    lowerBound: fields.lowerBound,
    upperBound: fields.upperBound,
    form: fields.form,
    use: fields.use,
    name: fields.name,
    raw: {},
    unknownNodes: [],
  };
}

function typeDefinition(fields: Partial<XdtoTypeDefinition> & Pick<XdtoTypeDefinition, 'name'>): XdtoTypeDefinition {
  return {
    name: fields.name,
    baseType: fields.baseType,
    properties: fields.properties ?? [],
    attributes: fields.attributes ?? [],
    raw: {},
    unknownNodes: [],
  };
}

function model(fields: Partial<XdtoPackageModel> = {}): XdtoPackageModel {
  return {
    targetNamespace: fields.targetNamespace,
    imports: fields.imports ?? [],
    valueTypes: fields.valueTypes ?? [],
    objectTypes: fields.objectTypes ?? [],
    rootProperties: fields.rootProperties ?? [],
    diagnostics: [],
    rawRoot: fields.rawRoot,
    unknownNodes: [],
  };
}

suite('XdtoPackageSerializer', () => {
  test('writes UTF-8 BOM package root without empty targetNamespace', () => {
    const xml = serializeXdtoPackageModel(model());

    assert.strictEqual(xml.charCodeAt(0), 0xFEFF);
    assert.match(xml, /^﻿<package xmlns="http:\/\/v8\.1c\.ru\/8\.1\/xdto"/);
    assert.match(xml, /xmlns:xs="http:\/\/www\.w3\.org\/2001\/XMLSchema"/);
    assert.match(xml, /xmlns:xsi="http:\/\/www\.w3\.org\/2001\/XMLSchema-instance"/);
    assert.doesNotMatch(xml, /targetNamespace=""/);
  });

  test('serializes imports and preserves prefixed namespace declarations from rawRoot', () => {
    const xml = serializeXdtoPackageModel(model({
      rawRoot: {
        '@_xmlns:common': 'urn:common',
        '@_xmlns:xs': 'custom-should-not-win',
        '@_xmlns:xsi': 'custom-should-not-win',
      } as XdtoRawNode,
      imports: [
        { namespace: 'urn:common', schemaLocation: 'common.xsd', raw: {} },
      ],
      rootProperties: [
        property({ name: 'RootCustomer', ref: 'common:Customer' }),
      ],
    }));

    assert.match(xml, /xmlns:common="urn:common"/);
    assert.match(xml, /<import namespace="urn:common" schemaLocation="common\.xsd"\/>/);
    assert.match(xml, /<property name="RootCustomer" ref="common:Customer"\/>/);
    assert.doesNotMatch(xml, /xmlns:xs="custom-should-not-win"/);
    assert.doesNotMatch(xml, /xmlns:xsi="custom-should-not-win"/);
  });

  test('round-trips object elements and Attribute form properties', () => {
    const source = model({
      targetNamespace: 'urn:orders',
      objectTypes: [
        typeDefinition({
          name: 'Order',
          properties: [
            property({ name: 'Number', type: 'xs:string', lowerBound: '1', upperBound: '1' }),
          ],
          attributes: [
            property({ name: 'Code', type: 'xs:string', form: 'Attribute', use: 'required' }),
          ],
        }),
      ],
      rootProperties: [
        property({ name: 'RootOrder', type: 'Order' }),
      ],
    });

    const parsed = parseXdtoPackage(serializeXdtoPackageModel(source));

    assert.deepStrictEqual(
      parsed.objectTypes[0].properties.map((item) => ({
        name: item.name,
        type: item.type,
        lowerBound: item.lowerBound,
        upperBound: item.upperBound,
        form: item.form,
      })),
      [{ name: 'Number', type: 'xs:string', lowerBound: '1', upperBound: '1', form: undefined }]
    );
    assert.deepStrictEqual(
      parsed.objectTypes[0].attributes.map((item) => ({
        name: item.name,
        type: item.type,
        form: item.form,
        use: item.use,
      })),
      [{ name: 'Code', type: 'xs:string', form: 'Attribute', use: 'required' }]
    );
    assert.deepStrictEqual(
      parsed.rootProperties.map((item) => ({ name: item.name, type: item.type })),
      [{ name: 'RootOrder', type: 'Order' }]
    );
  });

  test('serializes and parses editable property fields', () => {
    const xml = serializeXdtoPackageModel(model({
      objectTypes: [
        typeDefinition({
          name: 'Contract',
          properties: [
            property({
              name: 'Owner',
              ref: 'common:Owner',
              namespaceURI: 'urn:common',
              localName: 'owner',
              qualified: 'true',
              nillable: 'true',
              fixed: 'fixed-owner',
              defaultValue: 'guest',
              minOccurs: '0',
              maxOccurs: '1',
            }),
          ],
        }),
      ],
    }));

    assert.match(xml, /default="guest"/);
    const parsed = parseXdtoPackage(xml);
    const [owner] = parsed.objectTypes[0].properties;

    assert.deepStrictEqual(
      {
        ref: owner.ref,
        namespaceURI: owner.namespaceURI,
        localName: owner.localName,
        qualified: owner.qualified,
        nillable: owner.nillable,
        fixed: owner.fixed,
        defaultValue: owner.defaultValue,
        minOccurs: owner.minOccurs,
        maxOccurs: owner.maxOccurs,
      },
      {
        ref: 'common:Owner',
        namespaceURI: 'urn:common',
        localName: 'owner',
        qualified: 'true',
        nillable: 'true',
        fixed: 'fixed-owner',
        defaultValue: 'guest',
        minOccurs: '0',
        maxOccurs: '1',
      }
    );
  });

  test('serializes boolean values from webview checkboxes as XML attribute strings', () => {
    const checkboxProperty = property({ name: 'Flag', type: 'xs:boolean' }) as any;
    checkboxProperty.nillable = true;
    checkboxProperty.qualified = false;

    const xml = serializeXdtoPackageModel(model({
      objectTypes: [
        typeDefinition({
          name: 'Options',
          properties: [checkboxProperty],
        }),
      ],
    }));

    assert.match(xml, /nillable="true"/);
    assert.match(xml, /qualified="false"/);
  });
});
