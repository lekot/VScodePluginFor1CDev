import { MetadataType } from '../models/treeNode';
import {
  getMetadataTypeDescriptorByFolder,
  getMetadataTypeDescriptorByType,
  METADATA_TYPE_DESCRIPTORS,
} from '../constants/metadataTypeDescriptors';

/**
 * Utility class for mapping metadata type strings to MetadataType enum
 * Centralizes the type mapping logic used by both Designer and EDT parsers
 */
export class MetadataTypeMapper {
  /**
   * Map string type to MetadataType enum
   * @param typeString Type string from directory name
   * @returns MetadataType enum value
   */
  static map(typeString: string): MetadataType {
    return getMetadataTypeDescriptorByFolder(typeString)?.type ?? MetadataType.Unknown;
  }

  /**
   * Get list of all metadata type directory names
   * @returns Array of metadata type names
   */
  static getMetadataTypes(): string[] {
    return METADATA_TYPE_DESCRIPTORS.map((item) => item.designerFolder);
  }

  /**
   * Check if type string is valid metadata type
   * @param typeString Type string to check
   * @returns true if valid
   */
  static isValidType(typeString: string): boolean {
    return getMetadataTypeDescriptorByFolder(typeString) !== undefined;
  }

  /**
   * Designer configuration folder id (e.g. `CommonModules`, `Roles`) for a metadata type.
   * Reverse of {@link map}: each folder name maps to one `MetadataType`; values are unique in the internal map.
   */
  static getDesignerFolderIdForMetadataType(type: MetadataType): string | undefined {
    return getMetadataTypeDescriptorByType(type)?.designerFolder;
  }
}
