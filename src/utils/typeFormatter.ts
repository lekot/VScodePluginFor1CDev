import {
  TypeDefinition,
  TypeEntry,
  StringQualifiers,
  NumberQualifiers,
  DateQualifiers,
  ReferenceTypeInfo,
} from '../types/typeDefinitions';

/**
 * Utility for formatting TypeDefinition into human-readable strings
 */
export class TypeFormatter {
  /**
   * Format a type definition into a human-readable string
   * @param definition Type definition to format
   * @returns Human-readable type string
   */
  static formatTypeDisplay(definition: TypeDefinition): string {
    if (!definition || !definition.types || definition.types.length === 0) {
      return 'Not set';
    }

    const typeStrings = definition.types.map(type => this.formatTypeEntry(type));
    return typeStrings.join(' | ');
  }

  /**
   * Format a single type entry
   * @param entry Type entry to format
   * @returns Human-readable type string
   */
  private static formatTypeEntry(entry: TypeEntry): string {
    switch (entry.kind) {
      case 'string':
        return this.formatStringType(entry.qualifiers as StringQualifiers | undefined);
      
      case 'number':
        return this.formatNumberType(entry.qualifiers as NumberQualifiers | undefined);
      
      case 'boolean':
        return 'Boolean';
      
      case 'date':
        return this.formatDateType(entry.qualifiers as DateQualifiers | undefined);
      
      case 'reference':
        return this.formatReferenceType(entry.referenceType);
      
      default:
        return 'Unknown';
    }
  }

  /**
   * Format string type with qualifiers
   * @param qualifiers String qualifiers
   * @returns Formatted string type
   */
  private static formatStringType(qualifiers: StringQualifiers | undefined): string {
    if (!qualifiers) {
      return 'String';
    }
    return `String(${qualifiers.length})`;
  }

  /**
   * Format number type with qualifiers
   * @param qualifiers Number qualifiers
   * @returns Formatted number type
   */
  private static formatNumberType(qualifiers: NumberQualifiers | undefined): string {
    if (!qualifiers) {
      return 'Number';
    }
    return `Number(${qualifiers.digits},${qualifiers.fractionDigits})`;
  }

  /**
   * Format date type with qualifiers
   * @param qualifiers Date qualifiers
   * @returns Formatted date type
   */
  private static formatDateType(qualifiers: DateQualifiers | undefined): string {
    if (!qualifiers) {
      return 'Date';
    }
    return qualifiers.dateFractions;
  }

  /**
   * Format reference type
   * @param referenceType Reference type info
   * @returns Formatted reference type
   */
  private static formatReferenceType(referenceType: ReferenceTypeInfo | undefined): string {
    if (!referenceType) {
      return 'Reference';
    }
    return `${referenceType.referenceKind}.${referenceType.objectName}`;
  }
}
