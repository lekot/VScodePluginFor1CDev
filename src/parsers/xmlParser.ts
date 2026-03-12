import * as fs from 'fs';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import { Logger } from '../utils/logger';

/**
 * XML parsing options for fast-xml-parser
 */
const XML_PARSER_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  trimValues: true,
  cdataTagName: '__cdata',
  cdataPositionChar: '\\\\',
  parseTrueNumberOnly: false,
  numParseOptions: {
    hex: false,
    leadingZeros: false,
    skipLike: /^$/,
  },
  arrayMode: false,
  attrNodeName: '@_',
  ignoreNameSpace: false,
  removeNSPrefix: false,
};

/**
 * XML Parser for 1C metadata files
 */
export class XmlParser {
  private static parser = new XMLParser(XML_PARSER_OPTIONS);
  private static builder = new XMLBuilder(XML_PARSER_OPTIONS);

  /**
   * Parse XML file and return parsed object
   * @param filePath Path to XML file
   * @returns Parsed XML object
   */
  static parseFile(filePath: string): Record<string, unknown> {
    try {
      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }

      const xmlContent = fs.readFileSync(filePath, 'utf-8');
      return this.parseString(xmlContent);
    } catch (error) {
      Logger.error(`Error parsing XML file: ${filePath}`, error);
      throw new Error(`Failed to parse XML file: ${filePath}. ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Parse XML string and return parsed object
   * @param xmlString XML content as string
   * @returns Parsed XML object
   */
  static parseString(xmlString: string): Record<string, unknown> {
    if (typeof xmlString !== 'string' || xmlString.trim() === '') {
      throw new Error('Invalid XML: empty or not a string');
    }
    try {
      const parsed = this.parser.parse(xmlString);
      return parsed as Record<string, unknown>;
    } catch (error) {
      Logger.error('Error parsing XML string', error);
      throw new Error(`Failed to parse XML: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Convert object to XML string
   * @param obj Object to convert
   * @returns XML string
   */
  static objectToXml(obj: Record<string, unknown>): string {
    try {
      const body = this.builder.build(obj) as string;
      return body ? `<?xml version="1.0" encoding="UTF-8"?>\n${body}` : '';
    } catch (error) {
      Logger.error('Error converting object to XML', error);
      throw new Error(`Failed to convert object to XML: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get root element name from XML file
   * @param filePath Path to XML file
   * @returns Root element name
   */
  static getRootElementName(filePath: string): string {
    try {
      const parsed = this.parseFile(filePath);
      const keys = Object.keys(parsed);
      return keys[0] || 'Unknown';
    } catch (error) {
      Logger.error(`Error getting root element name from ${filePath}`, error);
      throw error;
    }
  }

  /**
   * Get element by path from parsed XML
   * @param obj Parsed XML object
   * @param path Path to element (e.g., 'Configuration.Properties.Name')
   * @returns Element value or undefined
   */
  static getElementByPath(obj: Record<string, unknown>, elementPath: string): unknown {
    const parts = elementPath.split('.');
    let current: unknown = obj;

    for (const part of parts) {
      if (current && typeof current === 'object') {
        current = (current as Record<string, unknown>)[part];
      } else {
        return undefined;
      }
    }

    return current;
  }

  /**
   * Set element by path in parsed XML
   * @param obj Parsed XML object
   * @param elementPath Path to element
   * @param value Value to set
   */
  static setElementByPath(obj: Record<string, unknown>, elementPath: string, value: unknown): void {
    const parts = elementPath.split('.');
    let current: Record<string, unknown> = obj;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!current[part]) {
        current[part] = {};
      }
      current = current[part] as Record<string, unknown>;
    }

    current[parts[parts.length - 1]] = value;
  }

  /**
   * Validate XML structure
   * @param filePath Path to XML file
   * @returns true if valid XML
   */
  static isValidXml(filePath: string): boolean {
    try {
      this.parseFile(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
