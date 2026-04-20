// src/types/predefinedCharacteristic.ts
// Public contract for parsed predefined characteristic entries (PlanOfCharacteristicKind).

export interface PredefinedCharacteristicEntry {
  readonly id: string;
  readonly name: string;
  readonly code: string;
  readonly description: string;
  readonly isFolder: boolean;
  /** Type strings, e.g. ['cfg:CatalogRef.Номенклатура', 'xs:string'] */
  readonly type: readonly string[];
}
