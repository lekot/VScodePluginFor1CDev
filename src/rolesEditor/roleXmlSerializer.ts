/**
 * Serializer for 1C Role.xml files
 * Converts RoleModel back to XML format
 */

import { XMLBuilder } from 'fast-xml-parser';
import { Logger } from '../utils/logger';
import {
  RoleModel,
  ObjectRights,
  allRightsFalse
} from './models/roleModel';

/**
 * XML building options for Role.xml files
 * Matches the format used by 1C
 */
const ROLE_XML_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  format: true,
  indentBy: '\t',
  suppressEmptyNode: false,
  suppressBooleanAttributes: false,
};

/**
 * Mapping from ObjectRights property names to XML element names
 * Inverse of the parser's XML_TO_RIGHTS_MAP
 */
const RIGHTS_TO_XML_MAP: Record<keyof ObjectRights, string> = {
  'read': 'Read',
  'insert': 'Insert',
  'update': 'Update',
  'delete': 'Delete',
  'view': 'View',
  'edit': 'Edit',
  'interactiveInsert': 'InteractiveInsert',
  'interactiveDelete': 'InteractiveDelete',
  'interactiveClear': 'InteractiveClear',
  'interactiveDeleteMarked': 'InteractiveDeleteMarked',
  'interactiveUndeleteMarked': 'InteractiveUndeleteMarked',
  'interactiveDeletePredefinedData': 'InteractiveDeletePredefinedData',
  'interactiveSetDeletionMark': 'InteractiveSetDeletionMark',
  'interactiveClearDeletionMark': 'InteractiveClearDeletionMark',
  'interactiveDeleteMarkedPredefinedData': 'InteractiveDeleteMarkedPredefinedData'
};

/**
 * Standard 1C Role.xml namespaces
 */
const ROLE_NAMESPACES = {
  '@_xmlns': 'http://v8.1c.ru/8.3/MDClasses',
  '@_xmlns:app': 'http://v8.1c.ru/8.2/managed-application/core',
  '@_xmlns:cfg': 'http://v8.1c.ru/8.1/data/enterprise/current-config',
  '@_xmlns:cmi': 'http://v8.1c.ru/8.2/managed-application/cmi',
  '@_xmlns:ent': 'http://v8.1c.ru/8.1/data/enterprise',
  '@_xmlns:lf': 'http://v8.1c.ru/8.2/managed-application/logform',
  '@_xmlns:style': 'http://v8.1c.ru/8.1/data/ui/style',
  '@_xmlns:sys': 'http://v8.1c.ru/8.1/data/ui/fonts/system',
  '@_xmlns:v8': 'http://v8.1c.ru/8.1/data/core',
  '@_xmlns:v8ui': 'http://v8.1c.ru/8.1/data/ui',
  '@_xmlns:web': 'http://v8.1c.ru/8.1/data/ui/colors/web',
  '@_xmlns:win': 'http://v8.1c.ru/8.1/data/ui/colors/windows',
  '@_xmlns:xen': 'http://v8.1c.ru/8.3/xcf/enums',
  '@_xmlns:xpr': 'http://v8.1c.ru/8.3/xcf/predef',
  '@_xmlns:xr': 'http://v8.1c.ru/8.3/xcf/readable',
  '@_xmlns:xs': 'http://www.w3.org/2001/XMLSchema',
  '@_xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
  '@_version': '2.13'
};

/**
 * Serializer for 1C Role.xml files
 */
export class RoleXmlSerializer {
  private static builder = new XMLBuilder(ROLE_XML_OPTIONS);

  /**
   * Serialize RoleModel to XML string
   * @param roleModel RoleModel to serialize
   * @returns XML string in 1C Role.xml format
   */
  static serializeToXml(roleModel: RoleModel): string {
    try {
      // Build XML structure
      const xmlStructure = this.buildXmlStructure(roleModel);

      // Generate XML string
      let xmlString = this.builder.build(xmlStructure) as string;

      // Add XML declaration if not present
      if (!xmlString.startsWith('<?xml')) {
        xmlString = '<?xml version="1.0" encoding="UTF-8"?>\n' + xmlString;
      }

      // Format XML to match 1C conventions
      xmlString = this.formatXml(xmlString);

      Logger.debug(`Serialized Role.xml: ${roleModel.name}, objects: ${Object.keys(roleModel.rights).length}`);
      return xmlString;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      Logger.error(`Failed to serialize Role.xml: ${roleModel.name}`, err);
      throw new Error(`Failed to serialize Role.xml: ${message}`);
    }
  }

  /**
   * Build XML structure from RoleModel
   * @param roleModel RoleModel to convert
   * @returns XML structure object
   */
  private static buildXmlStructure(roleModel: RoleModel): Record<string, unknown> {
    // Group objects by metadata type
    const objectsByType = this.groupObjectsByType(roleModel);

    // Build Rights section
    const rightsSection: Record<string, unknown> = {};

    for (const [metadataType, objects] of Object.entries(objectsByType)) {
      const objectNodes = objects.map(({ objectName, rights }) => 
        this.buildObjectNode(objectName, rights)
      );

      // If only one object, don't use array
      rightsSection[metadataType] = objectNodes.length === 1 ? objectNodes[0] : objectNodes;
    }

    // Build Role element
    const roleElement: Record<string, unknown> = {
      ...ROLE_NAMESPACES,
      Rights: rightsSection
    };

    // Return complete XML structure
    return {
      Role: roleElement
    };
  }

  /**
   * Group objects by metadata type
   * @param roleModel RoleModel with rights
   * @returns Map of metadata type to array of objects with rights
   */
  private static groupObjectsByType(roleModel: RoleModel): Record<string, Array<{ objectName: string; rights: ObjectRights }>> {
    const grouped: Record<string, Array<{ objectName: string; rights: ObjectRights }>> = {};

    for (const [fullName, rights] of Object.entries(roleModel.rights)) {
      // Skip objects with no rights
      if (allRightsFalse(rights)) {
        continue;
      }

      // Parse full name: MetadataType.ObjectName
      const dotIndex = fullName.indexOf('.');
      if (dotIndex === -1) {
        Logger.warn(`Invalid object name format: ${fullName}`);
        continue;
      }

      const metadataType = fullName.substring(0, dotIndex);
      const objectName = fullName.substring(dotIndex + 1);

      // Initialize array for this type if needed
      if (!grouped[metadataType]) {
        grouped[metadataType] = [];
      }

      // Add object to group
      grouped[metadataType].push({ objectName, rights });
    }

    // Sort objects within each type by name
    for (const objects of Object.values(grouped)) {
      objects.sort((a, b) => a.objectName.localeCompare(b.objectName));
    }

    return grouped;
  }

  /**
   * Build XML node for a single object
   * @param objectName Name of the object (without metadata type prefix)
   * @param rights ObjectRights for this object
   * @returns XML node structure
   */
  static buildObjectNode(objectName: string, rights: ObjectRights): Record<string, unknown> {
    const node: Record<string, unknown> = {
      Name: objectName
    };

    // Add rights in a consistent order
    // Only include rights that are set to true
    const rightKeys: Array<keyof ObjectRights> = [
      'read', 'insert', 'update', 'delete', 'view', 'edit',
      'interactiveInsert', 'interactiveDelete', 'interactiveClear',
      'interactiveDeleteMarked', 'interactiveUndeleteMarked',
      'interactiveDeletePredefinedData', 'interactiveSetDeletionMark',
      'interactiveClearDeletionMark', 'interactiveDeleteMarkedPredefinedData'
    ];

    for (const rightKey of rightKeys) {
      if (rights[rightKey]) {
        const xmlElementName = RIGHTS_TO_XML_MAP[rightKey];
        node[xmlElementName] = 'true';
      }
    }

    return {
      Object: node
    };
  }

  /**
   * Format XML string to match 1C conventions
   * @param xmlString Raw XML string
   * @returns Formatted XML string
   */
  static formatXml(xmlString: string): string {
    // Ensure proper line endings (LF for consistency)
    let formatted = xmlString.replace(/\r\n/g, '\n');

    // Ensure file ends with newline
    if (!formatted.endsWith('\n')) {
      formatted += '\n';
    }

    return formatted;
  }
}
