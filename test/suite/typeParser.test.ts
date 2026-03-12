import * as assert from 'assert';
import { TypeParser } from '../../src/parsers/typeParser';
import {
  TypeDefinition,
  TypeEntry,
  StringQualifiers,
  NumberQualifiers,
  DateQualifiers,
} from '../../src/types/typeDefinitions';

suite('TypeParser', () => {
  suite('parse simple string type', () => {
    test('should parse string type with qualifiers', () => {
      const xml = `<Type>
        <v8:Type>xs:string</v8:Type>
        <v8:StringQualifiers>
          <v8:Length>50</v8:Length>
          <v8:AllowedLength>Variable</v8:AllowedLength>
        </v8:StringQualifiers>
      </Type>`;

      const result = TypeParser.parse(xml);

      assert.strictEqual(result.category, 'primitive');
      assert.strictEqual(result.types.length, 1);
      assert.strictEqual(result.types[0].kind, 'string');
      assert.ok(result.types[0].qualifiers);
      const qualifiers = result.types[0].qualifiers as StringQualifiers;
      assert.strictEqual(qualifiers.length, 50);
      assert.strictEqual(qualifiers.allowedLength, 'Variable');
    });

    test('should parse string type with fixed length', () => {
      const xml = `<Type>
        <v8:Type>xs:string</v8:Type>
        <v8:StringQualifiers>
          <v8:Length>100</v8:Length>
          <v8:AllowedLength>Fixed</v8:AllowedLength>
        </v8:StringQualifiers>
      </Type>`;

      const result = TypeParser.parse(xml);

      assert.strictEqual(result.types[0].kind, 'string');
      const qualifiers = result.types[0].qualifiers as StringQualifiers;
      assert.strictEqual(qualifiers.length, 100);
      assert.strictEqual(qualifiers.allowedLength, 'Fixed');
    });

    test('should parse string type without qualifiers', () => {
      const xml = `<Type>
        <v8:Type>xs:string</v8:Type>
      </Type>`;

      const result = TypeParser.parse(xml);

      assert.strictEqual(result.category, 'primitive');
      assert.strictEqual(result.types[0].kind, 'string');
      assert.strictEqual(result.types[0].qualifiers, undefined);
    });
  });

  suite('parse number type', () => {
    test('should parse number type with precision and scale', () => {
      const xml = `<Type>
        <v8:Type>xs:decimal</v8:Type>
        <v8:NumberQualifiers>
          <v8:Digits>10</v8:Digits>
          <v8:FractionDigits>2</v8:FractionDigits>
          <v8:AllowedSign>Any</v8:AllowedSign>
        </v8:NumberQualifiers>
      </Type>`;

      const result = TypeParser.parse(xml);

      assert.strictEqual(result.category, 'primitive');
      assert.strictEqual(result.types[0].kind, 'number');
      const qualifiers = result.types[0].qualifiers as NumberQualifiers;
      assert.strictEqual(qualifiers.digits, 10);
      assert.strictEqual(qualifiers.fractionDigits, 2);
      assert.strictEqual(qualifiers.allowedSign, 'Any');
    });

    test('should parse number type with nonnegative sign', () => {
      const xml = `<Type>
        <v8:Type>xs:decimal</v8:Type>
        <v8:NumberQualifiers>
          <v8:Digits>15</v8:Digits>
          <v8:FractionDigits>3</v8:FractionDigits>
          <v8:AllowedSign>Nonnegative</v8:AllowedSign>
        </v8:NumberQualifiers>
      </Type>`;

      const result = TypeParser.parse(xml);

      const qualifiers = result.types[0].qualifiers as NumberQualifiers;
      assert.strictEqual(qualifiers.allowedSign, 'Nonnegative');
    });

    test('should parse number type without qualifiers', () => {
      const xml = `<Type>
        <v8:Type>xs:decimal</v8:Type>
      </Type>`;

      const result = TypeParser.parse(xml);

      assert.strictEqual(result.types[0].kind, 'number');
      assert.strictEqual(result.types[0].qualifiers, undefined);
    });
  });

  suite('parse date type', () => {
    test('should parse date type', () => {
      const xml = `<Type>
        <v8:Type>xs:date</v8:Type>
        <v8:DateQualifiers>
          <v8:DateFractions>Date</v8:DateFractions>
        </v8:DateQualifiers>
      </Type>`;

      const result = TypeParser.parse(xml);

      assert.strictEqual(result.category, 'primitive');
      assert.strictEqual(result.types[0].kind, 'date');
      const qualifiers = result.types[0].qualifiers as DateQualifiers;
      assert.strictEqual(qualifiers.dateFractions, 'Date');
    });

    test('should parse datetime type', () => {
      const xml = `<Type>
        <v8:Type>xs:dateTime</v8:Type>
        <v8:DateQualifiers>
          <v8:DateFractions>DateTime</v8:DateFractions>
        </v8:DateQualifiers>
      </Type>`;

      const result = TypeParser.parse(xml);

      assert.strictEqual(result.types[0].kind, 'date');
      const qualifiers = result.types[0].qualifiers as DateQualifiers;
      assert.strictEqual(qualifiers.dateFractions, 'DateTime');
    });

    test('should parse time type', () => {
      const xml = `<Type>
        <v8:Type>xs:time</v8:Type>
        <v8:DateQualifiers>
          <v8:DateFractions>Time</v8:DateFractions>
        </v8:DateQualifiers>
      </Type>`;

      const result = TypeParser.parse(xml);

      assert.strictEqual(result.types[0].kind, 'date');
      const qualifiers = result.types[0].qualifiers as DateQualifiers;
      assert.strictEqual(qualifiers.dateFractions, 'Time');
    });

    test('should infer datetime from xs:dateTime without qualifiers', () => {
      const xml = `<Type>
        <v8:Type>xs:dateTime</v8:Type>
      </Type>`;

      const result = TypeParser.parse(xml);

      const qualifiers = result.types[0].qualifiers as DateQualifiers;
      assert.strictEqual(qualifiers.dateFractions, 'DateTime');
    });

    test('should infer time from xs:time without qualifiers', () => {
      const xml = `<Type>
        <v8:Type>xs:time</v8:Type>
      </Type>`;

      const result = TypeParser.parse(xml);

      const qualifiers = result.types[0].qualifiers as DateQualifiers;
      assert.strictEqual(qualifiers.dateFractions, 'Time');
    });
  });

  suite('parse boolean type', () => {
    test('should parse boolean type', () => {
      const xml = `<Type>
        <v8:Type>xs:boolean</v8:Type>
      </Type>`;

      const result = TypeParser.parse(xml);

      assert.strictEqual(result.category, 'primitive');
      assert.strictEqual(result.types[0].kind, 'boolean');
      assert.strictEqual(result.types[0].qualifiers, undefined);
    });
  });

  suite('parse reference types', () => {
    test('should parse CatalogRef type', () => {
      const xml = `<Type>
        <v8:Type>cfg:CatalogRef.Products</v8:Type>
      </Type>`;

      const result = TypeParser.parse(xml);

      assert.strictEqual(result.category, 'reference');
      assert.strictEqual(result.types[0].kind, 'reference');
      assert.ok(result.types[0].referenceType);
      assert.strictEqual(result.types[0].referenceType?.referenceKind, 'CatalogRef');
      assert.strictEqual(result.types[0].referenceType?.objectName, 'Products');
    });

    test('should parse DocumentRef type', () => {
      const xml = `<Type>
        <v8:Type>cfg:DocumentRef.Orders</v8:Type>
      </Type>`;

      const result = TypeParser.parse(xml);

      assert.strictEqual(result.types[0].kind, 'reference');
      assert.strictEqual(result.types[0].referenceType?.referenceKind, 'DocumentRef');
      assert.strictEqual(result.types[0].referenceType?.objectName, 'Orders');
    });

    test('should parse EnumRef type', () => {
      const xml = `<Type>
        <v8:Type>cfg:EnumRef.Status</v8:Type>
      </Type>`;

      const result = TypeParser.parse(xml);

      assert.strictEqual(result.types[0].referenceType?.referenceKind, 'EnumRef');
      assert.strictEqual(result.types[0].referenceType?.objectName, 'Status');
    });

    test('should parse ChartOfCharacteristicTypesRef type', () => {
      const xml = `<Type>
        <v8:Type>cfg:ChartOfCharacteristicTypesRef.Characteristics</v8:Type>
      </Type>`;

      const result = TypeParser.parse(xml);

      assert.strictEqual(result.types[0].referenceType?.referenceKind, 'ChartOfCharacteristicTypesRef');
      assert.strictEqual(result.types[0].referenceType?.objectName, 'Characteristics');
    });

    test('should parse ChartOfAccountsRef type', () => {
      const xml = `<Type>
        <v8:Type>cfg:ChartOfAccountsRef.Accounts</v8:Type>
      </Type>`;

      const result = TypeParser.parse(xml);

      assert.strictEqual(result.types[0].referenceType?.referenceKind, 'ChartOfAccountsRef');
      assert.strictEqual(result.types[0].referenceType?.objectName, 'Accounts');
    });

    test('should parse ChartOfCalculationTypesRef type', () => {
      const xml = `<Type>
        <v8:Type>cfg:ChartOfCalculationTypesRef.Calculations</v8:Type>
      </Type>`;

      const result = TypeParser.parse(xml);

      assert.strictEqual(result.types[0].referenceType?.referenceKind, 'ChartOfCalculationTypesRef');
      assert.strictEqual(result.types[0].referenceType?.objectName, 'Calculations');
    });

    test('should handle reference type with Cyrillic object name', () => {
      const xml = `<Type>
        <v8:Type>cfg:CatalogRef.Пользователи</v8:Type>
      </Type>`;

      const result = TypeParser.parse(xml);

      assert.strictEqual(result.types[0].referenceType?.objectName, 'Пользователи');
    });
  });

  suite('parse composite types', () => {
    test('should parse composite type with string and number', () => {
      const xml = `<Type>
        <v8:Type>xs:string</v8:Type>
        <v8:Type>xs:decimal</v8:Type>
        <v8:StringQualifiers>
          <v8:Length>50</v8:Length>
          <v8:AllowedLength>Variable</v8:AllowedLength>
        </v8:StringQualifiers>
        <v8:NumberQualifiers>
          <v8:Digits>10</v8:Digits>
          <v8:FractionDigits>2</v8:FractionDigits>
          <v8:AllowedSign>Any</v8:AllowedSign>
        </v8:NumberQualifiers>
      </Type>`;

      const result = TypeParser.parse(xml);

      assert.strictEqual(result.category, 'composite');
      assert.strictEqual(result.types.length, 2);
      assert.strictEqual(result.types[0].kind, 'string');
      assert.strictEqual(result.types[1].kind, 'number');
    });

    test('should parse composite type with string, number, and reference', () => {
      const xml = `<Type>
        <v8:Type>xs:string</v8:Type>
        <v8:Type>xs:decimal</v8:Type>
        <v8:Type>cfg:CatalogRef.Products</v8:Type>
        <v8:StringQualifiers>
          <v8:Length>100</v8:Length>
          <v8:AllowedLength>Variable</v8:AllowedLength>
        </v8:StringQualifiers>
        <v8:NumberQualifiers>
          <v8:Digits>10</v8:Digits>
          <v8:FractionDigits>2</v8:FractionDigits>
          <v8:AllowedSign>Any</v8:AllowedSign>
        </v8:NumberQualifiers>
      </Type>`;

      const result = TypeParser.parse(xml);

      assert.strictEqual(result.category, 'composite');
      assert.strictEqual(result.types.length, 3);
      assert.strictEqual(result.types[0].kind, 'string');
      assert.strictEqual(result.types[1].kind, 'number');
      assert.strictEqual(result.types[2].kind, 'reference');
    });

    test('should parse composite type with multiple references', () => {
      const xml = `<Type>
        <v8:Type>cfg:CatalogRef.Products</v8:Type>
        <v8:Type>cfg:DocumentRef.Orders</v8:Type>
      </Type>`;

      const result = TypeParser.parse(xml);

      assert.strictEqual(result.category, 'composite');
      assert.strictEqual(result.types.length, 2);
      assert.strictEqual(result.types[0].referenceType?.referenceKind, 'CatalogRef');
      assert.strictEqual(result.types[1].referenceType?.referenceKind, 'DocumentRef');
    });
  });

  suite('error handling', () => {
    test('should throw error for invalid reference type format', () => {
      const xml = `<Type>
        <v8:Type>cfg:InvalidFormat</v8:Type>
      </Type>`;

      assert.throws(() => {
        TypeParser.parse(xml);
      });
    });

    test('should throw error for invalid reference kind', () => {
      const xml = `<Type>
        <v8:Type>cfg:InvalidRef.ObjectName</v8:Type>
      </Type>`;

      assert.throws(() => {
        TypeParser.parse(xml);
      });
    });

    test('should throw error when wrapping fails', () => {
      const xml = `not valid xml at all`;

      assert.throws(() => {
        TypeParser.parse(xml);
      });
    });
  });

  suite('edge cases', () => {
    test('should handle type with only qualifiers and no type definition', () => {
      const xml = `<Type>
        <v8:StringQualifiers>
          <v8:Length>50</v8:Length>
          <v8:AllowedLength>Variable</v8:AllowedLength>
        </v8:StringQualifiers>
      </Type>`;

      const result = TypeParser.parse(xml);

      assert.strictEqual(result.types.length, 0);
    });

    test('should handle numeric values as strings in XML', () => {
      const xml = `<Type>
        <v8:Type>xs:string</v8:Type>
        <v8:StringQualifiers>
          <v8:Length>75</v8:Length>
          <v8:AllowedLength>Variable</v8:AllowedLength>
        </v8:StringQualifiers>
      </Type>`;

      const result = TypeParser.parse(xml);

      const qualifiers = result.types[0].qualifiers as StringQualifiers;
      assert.strictEqual(qualifiers.length, 75);
    });

    test('should handle missing optional qualifiers', () => {
      const xml = `<Type>
        <v8:Type>xs:decimal</v8:Type>
        <v8:NumberQualifiers>
          <v8:Digits>10</v8:Digits>
          <v8:FractionDigits>2</v8:FractionDigits>
        </v8:NumberQualifiers>
      </Type>`;

      const result = TypeParser.parse(xml);

      const qualifiers = result.types[0].qualifiers as NumberQualifiers;
      assert.strictEqual(qualifiers.allowedSign, 'Any');
    });

    test('should handle whitespace in XML', () => {
      const xml = `
        <Type>
          <v8:Type>xs:string</v8:Type>
          <v8:StringQualifiers>
            <v8:Length>50</v8:Length>
            <v8:AllowedLength>Variable</v8:AllowedLength>
          </v8:StringQualifiers>
        </Type>
      `;

      const result = TypeParser.parse(xml);

      assert.strictEqual(result.types[0].kind, 'string');
    });

    test('should handle type with no v8:Type elements', () => {
      const xml = `<Type>
        <v8:StringQualifiers>
          <v8:Length>50</v8:Length>
          <v8:AllowedLength>Variable</v8:AllowedLength>
        </v8:StringQualifiers>
      </Type>`;

      const result = TypeParser.parse(xml);

      assert.strictEqual(result.category, 'primitive');
      assert.strictEqual(result.types.length, 0);
    });
  });
});
