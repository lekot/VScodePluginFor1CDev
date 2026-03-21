/**
 * Metadata object model for the Roles and Rights Editor
 */

import { MetadataType } from '../../models/treeNode';

/**
 * Represents a metadata object that can have rights assigned
 */
export interface MetadataObject {
  /**
   * Full name in format: {MetadataType}.{ObjectName}
   * Example: "Catalog.Products"
   * Attribute-level rights: "Catalog.Products.Attribute.Code"
   * Configuration root: "Configuration"
   */
  fullName: string;

  /**
   * Type of metadata object (Catalog, Document, etc.)
   */
  type: MetadataType;

  /**
   * Internal name of the object
   */
  name: string;

  /**
   * Display name (synonym) for UI presentation
   */
  displayName: string;

  /**
   * Whether this object has any rights assigned in the current role
   */
  hasRights: boolean;

  /**
   * Distinguishes root configuration row and attribute rows in the rights table.
   */
  rowKind?: 'object' | 'configurationRoot' | 'attribute';

  /**
   * For attribute rows: human-readable parent object (e.g. "Products (Catalog)").
   */
  parentLabel?: string;
}
