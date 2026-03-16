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

    // Try to find and parse Rights.xml file (EDT format)
    const rights = await this.parseRightsXml(filePath);
    
    // If Rights.xml not found or has no rights, try parsing Role.xml as fallback (Designer format)
    if (Object.keys(rights).length === 0) {
      Logger.debug('No rights found in Rights.xml, trying Role.xml as fallback');
      const roleRights = this.extractRights(parsed);
      Object.assign(rights, roleRights);
    }

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

    const rightsCount = Object.keys(rights).length;
    Logger.debug(`Parsed Role.xml: ${roleName}, objects with rights: ${rightsCount}`);
    if (rightsCount === 0) {
      Logger.warn('Role.xml produced no rights; check XML structure (Rights/Catalog/Object/Name, or Ext/Rights.xml for EDT)');
    }
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

    // 1C Role.xml structure: <Catalog><Object><Name>...</Name><Read>...</Read></Object>...</Catalog>
    // typeObj is { Object: [ { Name, Read, ... }, ... ] } or { Object: { Name, Read, ... } }
    const rawObjects: unknown =
      typeObj['Object'] ??
      Object.entries(typeObj).find(
        ([k]) => !k.startsWith('@_') && k !== '#text' && k.split(':').pop() === 'Object'
      )?.[1];

    const objects: unknown[] = rawObjects !== undefined
      ? Array.isArray(rawObjects)
        ? rawObjects
        : [rawObjects]
      : Array.isArray(typeObj)
        ? typeObj
        : [typeObj];

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

      // Use local name for type so "v8:Catalog" -> "Catalog" and matches allObjects (Catalog.Products)
      const typeLocalName = metadataType.includes(':') ? metadataType.split(':').pop()! : metadataType;
      const fullName = `${typeLocalName}.${objectName}`;

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

      // Use local name so "v8:Read" -> "Read" when XML has namespace
      const localKey = key.includes(':') ? key.split(':').pop()! : key;
      const rightKey = XML_TO_RIGHTS_MAP[key] ?? XML_TO_RIGHTS_MAP[localKey];
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
    const nameVal = objectNode['Name'];
    if (nameVal !== undefined && nameVal !== null) {
      const s = this.nameValueToString(nameVal);
      if (s) return s;
    }

    // Try with namespace prefix
    for (const [key, value] of Object.entries(objectNode)) {
      const localName = key.includes(':') ? key.split(':').pop()! : key;
      if (localName === 'name' || localName === 'Name') {
        const s = this.nameValueToString(value);
        if (s) return s;
      }
    }

    return null;
  }

  /** Get string from Name element (may be string or { '#text': '...' }) */
  private static nameValueToString(value: unknown): string | null {
    if (typeof value === 'string') return value.trim() || null;
    if (value && typeof value === 'object' && '#text' in (value as object)) {
      const t = (value as Record<string, unknown>)['#text'];
      return t != null ? String(t).trim() || null : null;
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

  /**
   * Parse Rights.xml file and extract rights assignments (EDT format)
   * @param roleXmlPath Path to Role.xml file
   * @returns RightsMap with all object rights
   */
  private static async parseRightsXml(roleXmlPath: string): Promise<RightsMap> {
    const rights: RightsMap = {};
    
    try {
      const roleDir = path.dirname(roleXmlPath);
      const baseName = path.basename(roleXmlPath, path.extname(roleXmlPath));

      // EDT: Roles/ИмяРоли.xml → Rights in Roles/ИмяРоли/Ext/Rights.xml
      // Designer: Roles/ИмяРоли/Role.xml → Rights in Roles/ИмяРоли/Ext/Rights.xml (same roleDir/Ext)
      const candidates =
        baseName.toLowerCase() !== 'role'
          ? [path.join(roleDir, baseName, 'Ext', 'Rights.xml'), path.join(roleDir, 'Ext', 'Rights.xml')]
          : [path.join(roleDir, 'Ext', 'Rights.xml')];

      let rightsXmlPath: string | null = null;
      for (const candidate of candidates) {
        try {
          await fs.promises.access(candidate);
          rightsXmlPath = candidate;
          break;
        } catch {
          continue;
        }
      }
      if (!rightsXmlPath) {
        Logger.debug(`Rights.xml not found (tried: ${candidates.join(', ')})`);
        return rights;
      }
      Logger.debug(`Using Rights.xml at: ${rightsXmlPath}`);
      
      // Read Rights.xml content
      const xmlContent = await fs.promises.readFile(rightsXmlPath, 'utf-8');
      
      if (!xmlContent || xmlContent.trim() === '') {
        Logger.debug('Rights.xml is empty');
        return rights;
      }
      
      // Parse XML
      const parsed = this.parser.parse(xmlContent) as Record<string, unknown>;
      
      // Rights.xml has a different structure than Role.xml
      // It contains <object> elements with <name> and <right> children
      const rightsElement = parsed['Rights'] || parsed['v8:Rights'];
      
      if (!rightsElement) {
        Logger.debug('No Rights element found in Rights.xml');
        return rights;
      }
      
      const rightsObj = rightsElement as Record<string, unknown>;
      
      // Get all object elements
      const objectElements = rightsObj['object'] || rightsObj['v8:object'];
      
      if (!objectElements) {
        Logger.debug('No object elements found in Rights.xml');
        return rights;
      }
      
      // Handle both array and single object cases
      const objects = Array.isArray(objectElements) ? objectElements : [objectElements];
      
      for (const obj of objects) {
        if (!obj || typeof obj !== 'object') {
          continue;
        }
        
        const objectElement = obj as Record<string, unknown>;
        
        // Extract object name from <name> element
        const nameElement = objectElement['name'] || objectElement['v8:name'];
        if (!nameElement) {
          continue;
        }
        
        const objectName = String(nameElement);
        
        // Extract rights for this object
        const objectRights = this.extractRightsFromRightsXml(objectElement);
        
        // Only add to map if at least one right is true
        if (this.hasAnyRights(objectRights)) {
          rights[objectName] = objectRights;
        }
      }
      
      Logger.info(`Parsed Rights.xml: ${Object.keys(rights).length} objects with rights`);
      return rights;
      
    } catch (error) {
      Logger.error('Error parsing Rights.xml', error);
      return rights;
    }
  }

  /**
   * Extract rights from Rights.xml object element
   * @param objectElement XML node for an object from Rights.xml
   * @returns ObjectRights with all rights set
   */
  private static extractRightsFromRightsXml(objectElement: Record<string, unknown>): ObjectRights {
    const rights = createEmptyObjectRights();
    
    // Rights.xml has <right> elements with <name> and <value> children
    const rightElements = objectElement['right'] || objectElement['v8:right'];
    
    if (!rightElements) {
      return rights;
    }
    
    // Handle both array and single object cases
    const rightArray = Array.isArray(rightElements) ? rightElements : [rightElements];
    
    for (const rightElem of rightArray) {
      if (!rightElem || typeof rightElem !== 'object') {
        continue;
      }
      
      const rightElement = rightElem as Record<string, unknown>;
      
      // Extract right name from <name> element
      const nameElement = rightElement['name'] || rightElement['v8:name'];
      if (!nameElement) {
        continue;
      }
      
      const rightName = String(nameElement);
      
      // Extract right value from <value> element
      const valueElement = rightElement['value'] || rightElement['v8:value'];
      if (valueElement === undefined) {
        continue;
      }
      
      // Parse boolean value
      const rightValue = this.parseBoolean(valueElement);
      
      // Map XML right name to ObjectRights property
      const rightKey = XML_TO_RIGHTS_MAP[rightName];
      if (rightKey) {
        rights[rightKey] = rightValue;
      }
    }
    
    return rights;
  }
}
