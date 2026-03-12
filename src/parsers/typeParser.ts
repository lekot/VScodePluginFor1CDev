import { XmlParser } from './xmlParser';
import {
  TypeDefinition,
  TypeEntry,
  StringQualifiers,
  NumberQualifiers,
  DateQualifiers,
  ReferenceTypeInfo,
} from '../types/typeDefinitions';
import { Logger } from '../utils/logger';

/**
 * Parser for XML type structures
 */
export class TypeParser {
  /**
   * Parse already-parsed XML object into TypeDefinition
   * @param typeObject Already parsed Type element object
   * @returns Parsed type definition
   */
  static parseFromObject(typeObject: Record<string, unknown>): TypeDefinition {
    try {
      const typeEntries = this.extractTypeEntries(typeObject);
      
      // Determine category based on number of types
      let category: 'primitive' | 'reference' | 'composite';
      if (typeEntries.length === 0) {
        category = 'primitive';
      } else if (typeEntries.length === 1) {
        category = typeEntries[0].kind === 'reference' ? 'reference' : 'primitive';
      } else {
        category = 'composite';
      }

      return {
        category,
        types: typeEntries,
      };
    } catch (error) {
      Logger.error('Error parsing type object', error);
      throw new Error(`Failed to parse type object: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Parse XML type structure into TypeDefinition
   * @param xmlContent Raw XML content from Type element
   * @returns Parsed type definition
   */
  static parse(xmlContent: string): TypeDefinition {
    try {
      // Wrap content in a root element if needed
      const wrappedXml = xmlContent.includes('<Type') ? xmlContent : `<Type>${xmlContent}</Type>`;
      const parsed = XmlParser.parseString(wrappedXml);
      
      // Extract the Type element
      const typeElement = (parsed as Record<string, unknown>).Type as Record<string, unknown>;
      if (!typeElement) {
        throw new Error('Invalid type XML structure: missing Type element');
      }

      const typeEntries = this.extractTypeEntries(typeElement);
      
      // Determine category based on number of types
      let category: 'primitive' | 'reference' | 'composite';
      if (typeEntries.length === 0) {
        category = 'primitive';
      } else if (typeEntries.length === 1) {
        category = typeEntries[0].kind === 'reference' ? 'reference' : 'primitive';
      } else {
        category = 'composite';
      }

      return {
        category,
        types: typeEntries,
      };
    } catch (error) {
      Logger.error('Error parsing type XML', error);
      throw new Error(`Failed to parse type XML: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Extract type entries from parsed XML
   * @param typeElement Parsed Type XML element
   * @returns Array of type entries
   */
  private static extractTypeEntries(typeElement: Record<string, unknown>): TypeEntry[] {
    const entries: TypeEntry[] = [];
    
    // Get all v8:Type elements (or v8:TypeSet for DefinedTypes)
    const v8Types = typeElement['v8:Type'] || typeElement['v8:TypeSet'];
    if (!v8Types) {
      return entries;
    }

    // Handle both single type and array of types
    const typeValues = Array.isArray(v8Types) ? v8Types : [v8Types];

    for (const typeValue of typeValues) {
      const typeStr = typeof typeValue === 'string' ? typeValue : (typeValue as Record<string, unknown>)['#text'];
      if (!typeStr) {
        continue;
      }

      const entry = this.parseTypeValue(typeStr as string, typeElement);
      if (entry) {
        entries.push(entry);
      }
    }

    return entries;
  }

  /**
   * Parse a single type value and extract qualifiers
   * @param typeValue Type value string (e.g., 'xs:string', 'cfg:CatalogRef.Products')
   * @param typeElement Full type element for qualifier extraction
   * @returns Type entry or null if invalid
   */
  private static parseTypeValue(typeValue: string, typeElement: Record<string, unknown>): TypeEntry | null {
    // Handle reference types (cfg:CatalogRef.ObjectName, etc.)
    if (typeValue.includes('cfg:')) {
      return this.parseReferenceType(typeValue);
    }

    // Handle primitive types
    if (typeValue.startsWith('xs:')) {
      return this.parsePrimitiveType(typeValue, typeElement);
    }

    return null;
  }

  /**
   * Parse a primitive type and extract qualifiers
   * @param typeValue Type value (e.g., 'xs:string', 'xs:decimal')
   * @param typeElement Full type element for qualifier extraction
   * @returns Type entry
   */
  private static parsePrimitiveType(typeValue: string, typeElement: Record<string, unknown>): TypeEntry {
    let kind: 'string' | 'number' | 'boolean' | 'date';
    let qualifiers: StringQualifiers | NumberQualifiers | DateQualifiers | undefined;

    if (typeValue === 'xs:string') {
      kind = 'string';
      qualifiers = this.extractStringQualifiers(typeElement);
    } else if (typeValue === 'xs:decimal') {
      kind = 'number';
      qualifiers = this.extractNumberQualifiers(typeElement);
    } else if (typeValue === 'xs:boolean') {
      kind = 'boolean';
    } else if (typeValue === 'xs:date' || typeValue === 'xs:dateTime' || typeValue === 'xs:time') {
      kind = 'date';
      qualifiers = this.extractDateQualifiers(typeElement, typeValue);
    } else {
      kind = 'string'; // Default to string
    }

    return {
      kind,
      qualifiers,
    };
  }

  /**
   * Parse a reference type
   * @param typeValue Type value (e.g., 'cfg:CatalogRef.Products')
   * @returns Type entry
   */
  private static parseReferenceType(typeValue: string): TypeEntry {
    // Extract reference kind and object name
    // Format: cfg:CatalogRef.ObjectName or cfg:DocumentRef.ObjectName, etc.
    const match = typeValue.match(/cfg:(\w+)\.(.+)/);
    if (!match) {
      throw new Error(`Invalid reference type format: ${typeValue}`);
    }

    const referenceKind = match[1] as any;
    const objectName = match[2];

    const validKinds = [
      'CatalogRef',
      'DocumentRef',
      'EnumRef',
      'ChartOfCharacteristicTypesRef',
      'ChartOfAccountsRef',
      'ChartOfCalculationTypesRef',
      'DefinedType',
    ];

    if (!validKinds.includes(referenceKind)) {
      throw new Error(`Invalid reference kind: ${referenceKind}`);
    }

    return {
      kind: 'reference',
      referenceType: {
        referenceKind: referenceKind as ReferenceTypeInfo['referenceKind'],
        objectName,
      },
    };
  }

  /**
   * Extract StringQualifiers from type element
   * @param typeElement Type element
   * @returns StringQualifiers or undefined
   */
  private static extractStringQualifiers(typeElement: Record<string, unknown>): StringQualifiers | undefined {
    const qualifiers = typeElement['v8:StringQualifiers'] as Record<string, unknown>;
    if (!qualifiers) {
      return undefined;
    }

    const length = this.extractNumericValue(qualifiers['v8:Length']);
    const allowedLength = this.extractStringValue(qualifiers['v8:AllowedLength']) as 'Fixed' | 'Variable' | undefined;

    if (length === undefined) {
      return undefined;
    }

    return {
      length,
      allowedLength: allowedLength || 'Variable',
    };
  }

  /**
   * Extract NumberQualifiers from type element
   * @param typeElement Type element
   * @returns NumberQualifiers or undefined
   */
  private static extractNumberQualifiers(typeElement: Record<string, unknown>): NumberQualifiers | undefined {
    const qualifiers = typeElement['v8:NumberQualifiers'] as Record<string, unknown>;
    if (!qualifiers) {
      return undefined;
    }

    const digits = this.extractNumericValue(qualifiers['v8:Digits']);
    const fractionDigits = this.extractNumericValue(qualifiers['v8:FractionDigits']);
    const allowedSign = this.extractStringValue(qualifiers['v8:AllowedSign']) as 'Any' | 'Nonnegative' | undefined;

    if (digits === undefined || fractionDigits === undefined) {
      return undefined;
    }

    return {
      digits,
      fractionDigits,
      allowedSign: allowedSign || 'Any',
    };
  }

  /**
   * Extract DateQualifiers from type element
   * @param typeElement Type element
   * @param typeValue Type value to determine default fractions
   * @returns DateQualifiers or undefined
   */
  private static extractDateQualifiers(typeElement: Record<string, unknown>, typeValue: string): DateQualifiers | undefined {
    const qualifiers = typeElement['v8:DateQualifiers'] as Record<string, unknown>;
    
    let dateFractions: 'Date' | 'DateTime' | 'Time' = 'Date';
    
    if (qualifiers) {
      const extracted = this.extractStringValue(qualifiers['v8:DateFractions']);
      if (extracted === 'DateTime' || extracted === 'Time') {
        dateFractions = extracted;
      }
    } else {
      // Infer from type value if no qualifiers
      if (typeValue === 'xs:dateTime') {
        dateFractions = 'DateTime';
      } else if (typeValue === 'xs:time') {
        dateFractions = 'Time';
      }
    }

    return { dateFractions };
  }

  /**
   * Extract numeric value from XML element
   * @param element XML element
   * @returns Numeric value or undefined
   */
  private static extractNumericValue(element: unknown): number | undefined {
    if (typeof element === 'number') {
      return element;
    }
    if (typeof element === 'string') {
      const num = parseInt(element, 10);
      return isNaN(num) ? undefined : num;
    }
    if (element && typeof element === 'object') {
      const textValue = (element as Record<string, unknown>)['#text'];
      if (typeof textValue === 'string') {
        const num = parseInt(textValue, 10);
        return isNaN(num) ? undefined : num;
      }
    }
    return undefined;
  }

  /**
   * Extract string value from XML element
   * @param element XML element
   * @returns String value or undefined
   */
  private static extractStringValue(element: unknown): string | undefined {
    if (typeof element === 'string') {
      return element;
    }
    if (element && typeof element === 'object') {
      const textValue = (element as Record<string, unknown>)['#text'];
      return typeof textValue === 'string' ? textValue : undefined;
    }
    return undefined;
  }
}
