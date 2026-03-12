/**
 * Type definitions for the Attribute Type Editor
 */

/**
 * String type qualifiers
 */
export interface StringQualifiers {
  length: number;
  allowedLength: 'Fixed' | 'Variable';
}

/**
 * Number type qualifiers
 */
export interface NumberQualifiers {
  digits: number;
  fractionDigits: number;
  allowedSign: 'Any' | 'Nonnegative';
}

/**
 * Date type qualifiers
 */
export interface DateQualifiers {
  dateFractions: 'Date' | 'DateTime' | 'Time';
}

/**
 * Group of referenceable metadata objects for the type editor (e.g. catalogs under CatalogRef).
 */
export interface ReferenceableGroup {
  referenceKind: string;
  objectNames: string[];
}

/**
 * Reference type information
 */
export interface ReferenceTypeInfo {
  referenceKind: 'CatalogRef' | 'DocumentRef' | 'EnumRef' | 
                 'ChartOfCharacteristicTypesRef' | 'ChartOfAccountsRef' | 
                 'ChartOfCalculationTypesRef' | 'DefinedType';
  objectName: string;
}

/**
 * Represents a single type entry (for composite types)
 */
export interface TypeEntry {
  kind: 'string' | 'number' | 'boolean' | 'date' | 'reference';
  qualifiers?: StringQualifiers | NumberQualifiers | DateQualifiers;
  referenceType?: ReferenceTypeInfo;
}

/**
 * Represents a complete type definition
 */
export interface TypeDefinition {
  category: 'primitive' | 'reference' | 'composite';
  types: TypeEntry[];
}
