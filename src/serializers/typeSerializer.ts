import {
  TypeDefinition,
  TypeEntry,
  StringQualifiers,
  NumberQualifiers,
  DateQualifiers,
  ReferenceTypeInfo,
} from '../types/typeDefinitions';
import { xmlParser } from '../utils/xml/xmlCore';

const STRUCTURED_TYPE_PROPERTY_VALUE = '1cviewer.structuredTypePropertyValue' as const;

export interface StructuredTypePropertyValue {
  readonly kind: typeof STRUCTURED_TYPE_PROPERTY_VALUE;
  readonly content: Record<string, unknown>;
}

export function isStructuredTypePropertyValue(value: unknown): value is StructuredTypePropertyValue {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<StructuredTypePropertyValue>;
  return candidate.kind === STRUCTURED_TYPE_PROPERTY_VALUE
    && !!candidate.content
    && typeof candidate.content === 'object'
    && !Array.isArray(candidate.content);
}

/**
 * Serializer for TypeDefinition to XML structure
 */
export class TypeSerializer {
  /** Build native Designer <Type> property content for XML writers. */
  static serializePropertyValue(definition: TypeDefinition): StructuredTypePropertyValue {
    const xml = this.serialize(definition);
    if (!xml) {
      return { kind: STRUCTURED_TYPE_PROPERTY_VALUE, content: {} };
    }

    const parsed = xmlParser.parse(xml) as Record<string, unknown>;
    const content = parsed.Type;
    if (!content || typeof content !== 'object' || Array.isArray(content)) {
      throw new Error('Failed to serialize native Type property content.');
    }

    return {
      kind: STRUCTURED_TYPE_PROPERTY_VALUE,
      content: content as Record<string, unknown>,
    };
  }

  /**
   * Serialize TypeDefinition to XML structure
   * @param definition Type definition to serialize
   * @returns XML string
   */
  static serialize(definition: TypeDefinition): string {
    const typeEntries = definition.types.map(entry => this.serializeTypeEntry(entry)).join('\n');
    
    if (typeEntries.trim() === '') {
      return '';
    }

    return `<Type>\n${typeEntries}\n</Type>`;
  }

  /**
   * Generate XML elements for type entry
   * @param entry Type entry to serialize
   * @returns XML element string
   */
  private static serializeTypeEntry(entry: TypeEntry): string {
    const indent = '  ';
    
    switch (entry.kind) {
      case 'string':
        return this.serializeStringType(entry.qualifiers as StringQualifiers | undefined, indent);
      
      case 'number':
        return this.serializeNumberType(entry.qualifiers as NumberQualifiers | undefined, indent);
      
      case 'boolean':
        return `${indent}<v8:Type>xs:boolean</v8:Type>`;
      
      case 'date':
        return this.serializeDateType(entry.qualifiers as DateQualifiers | undefined, indent);
      
      case 'reference':
        return this.serializeReferenceType(entry.referenceType, indent);
      
      default:
        return '';
    }
  }

  /**
   * Generate XML for string type
   * @param qualifiers String qualifiers
   * @param indent Indentation string
   * @returns XML string
   */
  private static serializeStringType(qualifiers: StringQualifiers | undefined, indent: string): string {
    let xml = `${indent}<v8:Type>xs:string</v8:Type>`;
    
    if (qualifiers) {
      xml += `\n${indent}<v8:StringQualifiers>`;
      xml += `\n${indent}  <v8:Length>${qualifiers.length}</v8:Length>`;
      xml += `\n${indent}  <v8:AllowedLength>${qualifiers.allowedLength}</v8:AllowedLength>`;
      xml += `\n${indent}</v8:StringQualifiers>`;
    }
    
    return xml;
  }

  /**
   * Generate XML for number type
   * @param qualifiers Number qualifiers
   * @param indent Indentation string
   * @returns XML string
   */
  private static serializeNumberType(qualifiers: NumberQualifiers | undefined, indent: string): string {
    let xml = `${indent}<v8:Type>xs:decimal</v8:Type>`;
    
    if (qualifiers) {
      xml += `\n${indent}<v8:NumberQualifiers>`;
      xml += `\n${indent}  <v8:Digits>${qualifiers.digits}</v8:Digits>`;
      xml += `\n${indent}  <v8:FractionDigits>${qualifiers.fractionDigits}</v8:FractionDigits>`;
      xml += `\n${indent}  <v8:AllowedSign>${qualifiers.allowedSign}</v8:AllowedSign>`;
      xml += `\n${indent}</v8:NumberQualifiers>`;
    }
    
    return xml;
  }

  /**
   * Generate XML for date type
   * @param qualifiers Date qualifiers
   * @param indent Indentation string
   * @returns XML string
   */
  private static serializeDateType(qualifiers: DateQualifiers | undefined, indent: string): string {
    // Designer stores every 1C Date variant as xs:dateTime. The actual
    // Date/DateTime/Time semantics live in v8:DateQualifiers.
    let xml = `${indent}<v8:Type>xs:dateTime</v8:Type>`;
    
    if (qualifiers) {
      xml += `\n${indent}<v8:DateQualifiers>`;
      xml += `\n${indent}  <v8:DateFractions>${qualifiers.dateFractions}</v8:DateFractions>`;
      xml += `\n${indent}</v8:DateQualifiers>`;
    }
    
    return xml;
  }

  /**
   * Generate XML for reference type
   * @param referenceType Reference type info
   * @param indent Indentation string
   * @returns XML string
   */
  private static serializeReferenceType(referenceType: ReferenceTypeInfo | undefined, indent: string): string {
    if (!referenceType) {
      return '';
    }
    
    return `${indent}<v8:Type>cfg:${referenceType.referenceKind}.${referenceType.objectName}</v8:Type>`;
  }
}
