/**
 * Parser for 1C Role.xml files
 * Extracts rights assignments for metadata objects from Role.xml
 */

import * as fs from 'fs';
import * as path from 'path';
import { XMLParser } from 'fast-xml-parser';
import { Logger } from '../utils/logger';
import {
  RoleModel,
  RightsMap,
  ObjectRights,
  RoleMetadata,
  ConfigFormat,
  createEmptyObjectRights
} from './models/roleModel';

/**
 * XML parsing options for Role.xml files
 */
const ROLE_XML_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  trimValues: true,
  ignoreNameSpace: false,
  removeNSPrefix: false,
};

/**
 * Mapping from XML element names to ObjectRights property names
 * 1C uses these element names in Role.xml
 */
const XML_TO_RIGHTS_MAP: Record<string, keyof ObjectRights> = {
  'Read': 'read',
  'Insert': 'insert',
  'Update': 'update',
  'Delete': 'delete',
  'View': 'view',
  'Edit': 'edit',
  'InteractiveInsert': 'interactiveInsert',
  'InteractiveDelete': 'interactiveDelete',
  'InteractiveClear': 'interactiveClear',
  'InteractiveDeleteMarked': 'interactiveDeleteMarked',
  'InteractiveUndeleteMarked': 'interactiveUndeleteMarked',
  'InteractiveDeletePredefinedData': 'interactiveDeletePredefinedData',
  'InteractiveSetDeletionMark': 'interactiveSetDeletionMark',
  'InteractiveClearDeletionMark': 'interactiveClearDeletionMark',
  'InteractiveDeleteMarkedPredefinedData': 'interactiveDeleteMarkedPredefinedData'
};

/**
 * Parser for 1C Role.xml files
 */
export class RoleXmlParser {
  private static parser = new XMLParser(ROLE_XML_OPTIONS);

  /**
   * Parse Role.xml file and extract rights assignments
   * @param filePath Path to Role.xml file
   * @returns RoleModel with all rights assignments
   */
  static async parseRoleXml(filePath: string): Promise<RoleModel> {
    try {
      // Validate file exists
      await fs.promises.access(filePath);
    } catch (err) {
      const error = new Error(`Role.xml file not found: ${filePath}`);
      Logger.error('Role.xml file not found', err);
      throw error;
    }

    // Read file content
    let xmlContent: string;
    try {
      xmlContent = await fs.promises.readFile(filePath, 'utf-8');
    } catch (err) {
      const error = new Error(`Failed to read Role.xml file: ${filePath}`);
      Logger.error('Failed to read Role.xml', err);
      throw error;
    }

    // Validate content is not empty
    if (!xmlContent || xmlContent.trim() === '') {
      throw new Error('Role.xml file is empty');
    }

    // Parse XML
    let parsed: Record<string, unknown>;
    try {
      parsed = this.parser.parse(xmlContent) as Record<string, unknown>;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      Logger.error(`Failed to parse Role.xml: ${filePath}`, err);
      throw new Error(`Malformed XML in Role.xml: ${message}`);
    }

    // Extract role name from file path
    const roleName = path.basename(path.dirname(filePath));

    // Extract rights from parsed XML
    const rights = this.extractRights(parsed);

    // Detect configuration format
    const format = this.detectFormat(filePath);

    // Get file stats for metadata
    const stats = await fs.promises.stat(filePath);

    // Build role metadata
    const metadata: RoleMetadata = {
      format,
      version: '1.0', // Could be extracted from XML if present
      lastModified: stats.mtime
    };

    // Build and return role model
    const roleModel: RoleModel = {
      name: roleName,
      filePath,
      rights,
      metadata
    };

    Logger.debug(`Parsed Role.xml: ${roleName}, objects: ${Object.keys(rights).length}`);
    return roleModel;
  }

  /**
   * Extract rights assignments from parsed XML
   * @param parsed Parsed XML object
   * @returns RightsMap with all object rights
   */
  static extractRights(parsed: Record<string, unknown>): RightsMap {
    const rights: RightsMap = {};

    // Find the root Role element
    const roleElement = this.findRoleElement(parsed);
    if (!roleElement) {
      Logger.warn('No Role element found in XML');
      return rights;
    }

    // Look for object rights section
    // In 1C Role.xml, rights are typically under Role/Rights or Role/ObjectRights
    const rightsSection = this.findRightsSection(roleElement);
    if (!rightsSection) {
      Logger.debug('No rights section found in Role element');
      return rights;
    }

    // Parse each object's rights
    // Rights section typically contains elements for each metadata type
    // e.g., <Catalog>, <Document>, <InformationRegister>, etc.
    for (const [key, value] of Object.entries(rightsSection)) {
      if (key.startsWith('@_') || key === '#text') {
        continue; // Skip attributes and text nodes
      }

      // Each metadata type element contains object elements
      this.parseMetadataTypeRights(key, value, rights);
    }

    return rights;
  }

  /**
   * Parse rights for a specific metadata type
   * @param metadataType Metadata type name (e.g., 'Catalog', 'Document')
   * @param value XML value for this metadata type
   * @param rights RightsMap to populate
   */
  private static parseMetadataTypeRights(
    metadataType: string,
    value: unknown,
    rights: RightsMap
  ): void {
    if (!value || typeof value !== 'object') {
      return;
    }

    const typeObj = value as Record<string, unknown>;

    // Handle both array and single object cases
    const objects = Array.isArray(typeObj) ? typeObj : [typeObj];

    for (const obj of objects) {
      if (!obj || typeof obj !== 'object') {
        continue;
      }

      const objectElement = obj as Record<string, unknown>;

      // Extract object name from @_name attribute or nested structure
      const objectName = this.extractObjectName(objectElement);
      if (!objectName) {
        continue;
      }

      // Build full object name: MetadataType.ObjectName
      const fullName = `${metadataType}.${objectName}`;

      // Extract rights for this object
      const objectRights = this.extractObjectRights(objectElement);

      // Only add to map if at least one right is true
      if (this.hasAnyRights(objectRights)) {
        rights[fullName] = objectRights;
      }
    }
  }

  /**
   * Extract rights from an individual object XML node
   * @param objectNode XML node for a single object
   * @returns ObjectRights with all rights set
   */
  static extractObjectRights(objectNode: Record<string, unknown>): ObjectRights {
    const rights = createEmptyObjectRights();

    // Iterate through all properties in the object node
    for (const [key, value] of Object.entries(objectNode)) {
      if (key.startsWith('@_') || key === '#text') {
        continue; // Skip attributes and text nodes
      }

      // Check if this key maps to a known right
      const rightKey = XML_TO_RIGHTS_MAP[key];
      if (rightKey) {
        // Parse boolean value
        // In 1C XML, rights are typically represented as 'true'/'false' strings or boolean values
        rights[rightKey] = this.parseBoolean(value);
      }
    }

    return rights;
  }

  /**
   * Find the root Role element in parsed XML
   * @param parsed Parsed XML object
   * @returns Role element or null
   */
  private static findRoleElement(parsed: Record<string, unknown>): Record<string, unknown> | null {
    // Try direct Role key
    if (parsed['Role']) {
      return parsed['Role'] as Record<string, unknown>;
    }

    // Try with namespace prefix (e.g., 'v8:Role')
    for (const [key, value] of Object.entries(parsed)) {
      if (key.endsWith(':Role') || key === 'Role') {
        return value as Record<string, unknown>;
      }
    }

    return null;
  }

  /**
   * Find the rights section within Role element
   * @param roleElement Role element from XML
   * @returns Rights section or null
   */
  private static findRightsSection(roleElement: Record<string, unknown>): Record<string, unknown> | null {
    // Try common section names
    const possibleKeys = ['Rights', 'ObjectRights', 'rights', 'objectRights'];

    for (const key of possibleKeys) {
      if (roleElement[key]) {
        return roleElement[key] as Record<string, unknown>;
      }
    }

    // Try with namespace prefixes
    for (const [key, value] of Object.entries(roleElement)) {
      const localName = key.includes(':') ? key.split(':').pop()! : key;
      if (possibleKeys.includes(localName)) {
        return value as Record<string, unknown>;
      }
    }

    // If no explicit rights section, the role element itself might contain the rights
    // Check if roleElement has metadata type keys (Catalog, Document, etc.)
    const hasMetadataTypes = Object.keys(roleElement).some(key => 
      !key.startsWith('@_') && 
      !key.startsWith('#') &&
      !key.includes(':') &&
      key !== 'Rights' &&
      key !== 'ObjectRights'
    );

    if (hasMetadataTypes) {
      return roleElement;
    }

    return null;
  }

  /**
   * Extract object name from object XML node
   * @param objectNode XML node for an object
   * @returns Object name or null
   */
  private static extractObjectName(objectNode: Record<string, unknown>): string | null {
    // Try @_name attribute
    if (objectNode['@_name']) {
      return String(objectNode['@_name']);
    }

    // Try nested Name element
    if (objectNode['Name']) {
      return String(objectNode['Name']);
    }

    // Try with namespace prefix
    for (const [key, value] of Object.entries(objectNode)) {
      const localName = key.includes(':') ? key.split(':').pop()! : key;
      if (localName === 'name' || localName === 'Name') {
        return String(value);
      }
    }

    return null;
  }

  /**
   * Parse a boolean value from XML
   * @param value Value from XML (can be string, boolean, or object)
   * @returns Boolean value
   */
  private static parseBoolean(value: unknown): boolean {
    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'string') {
      const lower = value.toLowerCase().trim();
      return lower === 'true' || lower === '1' || lower === 'yes';
    }

    if (typeof value === 'number') {
      return value !== 0;
    }

    // For objects, check if there's a text node
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (obj['#text']) {
        return this.parseBoolean(obj['#text']);
      }
    }

    return false;
  }

  /**
   * Check if ObjectRights has any rights set to true
   * @param rights ObjectRights to check
   * @returns true if at least one right is true
   */
  private static hasAnyRights(rights: ObjectRights): boolean {
    return Object.values(rights).some(value => value === true);
  }

  /**
   * Detect configuration format (Designer or EDT) from file path
   * @param filePath Path to Role.xml file
   * @returns ConfigFormat
   */
  private static detectFormat(filePath: string): ConfigFormat {
    // EDT format typically has 'src' in the path
    // Designer format typically has 'Roles' directly under configuration root
    const normalizedPath = filePath.replace(/\\/g, '/');

    if (normalizedPath.includes('/src/')) {
      return ConfigFormat.EDT;
    }

    return ConfigFormat.Designer;
  }
}
