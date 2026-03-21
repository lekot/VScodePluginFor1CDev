import * as fs from 'fs';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import { Logger } from './logger';
import {
  getDefaultPropertiesForRootTag,
  getDefaultPropertiesForNestedElement,
} from '../constants/metadataDefaultValues';
import { MetadataType } from '../models/treeNode';
import { injectInternalInfoIntoMetadataXml } from '../services/internalInfoGenerator';
import { normalizeMetaDataObjectRoot } from '../services/metaDataObjectRootNormalizer';
import { TypeParser } from '../parsers/typeParser';
import { TypeFormatter } from './typeFormatter';
import { buildTabularSectionInternalInfoObject } from '../services/internalInfoGenerator';

/** Top-level metadata types that have their own XML file in Designer. */
const TOP_LEVEL_TYPES = new Set<MetadataType>([
  MetadataType.Catalog,
  MetadataType.Document,
  MetadataType.Enum,
  MetadataType.Report,
  MetadataType.DataProcessor,
  MetadataType.ChartOfCharacteristicTypes,
  MetadataType.ChartOfAccounts,
  MetadataType.ChartOfCalculationTypes,
  MetadataType.InformationRegister,
  MetadataType.AccumulationRegister,
  MetadataType.AccountingRegister,
  MetadataType.CalculationRegister,
  MetadataType.BusinessProcess,
  MetadataType.Task,
  MetadataType.ExternalDataSource,
  MetadataType.Constant,
]);

/**
 * XML Writer options for preserving formatting and structure
 */
const XML_WRITER_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  format: true,
  indentBy: '  ',
  suppressEmptyNode: true,
  preserveOrder: false,
  commentPropName: '#comment',
  cdataTagName: '__cdata',
  processEntities: true,
  suppressBooleanAttributes: false,
  suppressUnpairedNode: false,
  unpairedTags: [],
  enableToString: true,
};

/**
 * XMLWriter utility class for reading and writing XML files
 * while preserving structure and formatting
 */
export class XMLWriter {
  private static parser = new XMLParser(XML_WRITER_OPTIONS);
  private static builder = new XMLBuilder(XML_WRITER_OPTIONS);

  /**
   * Read properties from XML file
   * @param filePath Path to XML file
   * @returns Properties object extracted from XML
   * @throws Error if file cannot be read or parsed
   */
  static async readProperties(filePath: string): Promise<Record<string, unknown>> {
    try {
      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }

      let xmlContent: string;
      try {
        xmlContent = await fs.promises.readFile(filePath, 'utf-8');
      } catch (readError) {
        throw new Error(
          `Failed to read properties. Unable to read file. ${readError instanceof Error ? readError.message : String(readError)}`
        );
      }

      if (!xmlContent || xmlContent.trim() === '') {
        throw new Error('Failed to read properties. File is empty or invalid.');
      }

      let parsed: unknown;
      try {
        parsed = this.parser.parse(xmlContent);
      } catch (parseError) {
        const errorMsg = parseError instanceof Error ? parseError.message : String(parseError);
        Logger.error(`XML parsing failed for ${filePath}`, parseError);
        throw new Error(
          `Failed to read properties. Invalid XML structure in file. The file may be corrupted or not a valid XML document. ${errorMsg}`
        );
      }

      if (!parsed || typeof parsed !== 'object' || (Object.keys(parsed as object).length === 0 && xmlContent.trim().length > 0)) {
        throw new Error('Failed to read properties. Invalid XML structure in file.');
      }

      const properties = this.extractProperties(parsed);
      Logger.info(`Successfully read properties from ${filePath}`);
      return properties;
    } catch (error) {
      Logger.error(`Error reading properties from ${filePath}`, error);
      
      if (error instanceof Error && error.message.includes('Invalid XML structure')) {
        throw error;
      }
      
      throw new Error(
        `Failed to read properties from XML file: ${filePath}. ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Write properties to XML file
   * Preserves XML structure and formatting
   * @param filePath Path to XML file
   * @param properties Properties object to write
   * @throws Error if file cannot be written
   */
  static async writeProperties(
    filePath: string,
    properties: Record<string, unknown>
  ): Promise<void> {
    try {
      let xmlContent: string;
      try {
        xmlContent = await fs.promises.readFile(filePath, 'utf-8');
      } catch (readError) {
        Logger.error(`Failed to read file for writing: ${filePath}`, readError);
        throw new Error(
          `Failed to write properties. Unable to read file for updating. ${readError instanceof Error ? readError.message : String(readError)}`
        );
      }

      let parsed: unknown;
      try {
        parsed = this.parser.parse(xmlContent);
      } catch (parseError) {
        const errorMsg = parseError instanceof Error ? parseError.message : String(parseError);
        Logger.error(`XML parsing failed for ${filePath}`, parseError);
        throw new Error(
          `Invalid XML structure in file. Cannot update properties in a corrupted XML file. ${errorMsg}`
        );
      }

      const updated = this.updatePropertiesInStructure(parsed, properties);

      let xmlString: string;
      try {
        xmlString = this.builder.build(updated);
      } catch (buildError) {
        Logger.error(`Failed to build XML for ${filePath}`, buildError);
        throw new Error(
          `Failed to generate XML content. ${buildError instanceof Error ? buildError.message : String(buildError)}`
        );
      }

      const backupPath = `${filePath}.bak`;
      try {
        await fs.promises.writeFile(backupPath, xmlContent, 'utf-8');
      } catch (backupErr) {
        Logger.warn(`Failed to create backup ${backupPath}`, backupErr);
      }

      try {
        await fs.promises.writeFile(filePath, xmlString, 'utf-8');
      } catch (writeError) {
        Logger.error(`Failed to write file: ${filePath}`, writeError);
        try {
          if (fs.existsSync(backupPath)) {
            const restored = await fs.promises.readFile(backupPath, 'utf-8');
            await fs.promises.writeFile(filePath, restored, 'utf-8');
            await fs.promises.unlink(backupPath);
            Logger.info(`Rolled back ${filePath} from backup`);
          }
        } catch (rollbackErr) {
          Logger.error(`Rollback failed for ${filePath}`, rollbackErr);
        }
        throw new Error(
          `Unable to write to file. Check file permissions and disk space. ${
            writeError instanceof Error ? writeError.message : String(writeError)
          }`
        );
      }

      try {
        if (fs.existsSync(backupPath)) {
          await fs.promises.unlink(backupPath);
        }
      } catch {
        Logger.debug(`Could not remove backup ${backupPath}`);
      }
      Logger.info(`Successfully wrote properties to ${filePath}`);
    } catch (error) {
      Logger.error(`Error writing properties to ${filePath}`, error);
      
      if (error instanceof Error && 
          (error.message.includes('Invalid XML structure') || 
           error.message.includes('Unable to'))) {
        throw error;
      }
      
      throw new Error(
        `Failed to write properties to XML file: ${filePath}. ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Add a nested element (Attribute or TabularSection) to ChildObjects in the XML file.
   * @param filePath Path to XML file
   * @param elementType 'Attribute' or 'TabularSection'
   * @param elementName Name of the new element
   * @param minimalProperties Optional minimal properties (Name is always set)
   * @throws Error if file cannot be read or written
   */
  static async addNestedElement(
    filePath: string,
    elementType: string,
    elementName: string,
    minimalProperties?: Record<string, unknown>,
    parentRootType?: MetadataType,
    parentObjectName?: string
  ): Promise<void> {
    const xmlContent = await fs.promises.readFile(filePath, 'utf-8');
    const parsed = this.parser.parse(xmlContent);
    const updated = this.addNestedElementInStructure(
      parsed,
      elementType,
      elementName,
      minimalProperties ?? {},
      parentRootType,
      parentObjectName
    );
    const xmlString = this.builder.build(updated);

    const backupPath = `${filePath}.bak`;
    try {
      await fs.promises.writeFile(backupPath, xmlContent, 'utf-8');
    } catch (backupErr) {
      Logger.warn(`Failed to create backup ${backupPath}`, backupErr);
    }

    try {
      await fs.promises.writeFile(filePath, xmlString, 'utf-8');
    } catch (writeError) {
      Logger.error(`Failed to write file: ${filePath}`, writeError);
      try {
        if (fs.existsSync(backupPath)) {
          const restored = await fs.promises.readFile(backupPath, 'utf-8');
          await fs.promises.writeFile(filePath, restored, 'utf-8');
          await fs.promises.unlink(backupPath);
          Logger.info(`Rolled back ${filePath} from backup`);
        }
      } catch (rollbackErr) {
        Logger.error(`Rollback failed for ${filePath}`, rollbackErr);
      }
      throw new Error(
        `Unable to write to file. Check file permissions and disk space. ${
          writeError instanceof Error ? writeError.message : String(writeError)
        }`
      );
    }

    try {
      if (fs.existsSync(backupPath)) {
        await fs.promises.unlink(backupPath);
      }
    } catch {
      Logger.debug(`Could not remove backup ${backupPath}`);
    }
    Logger.info(`Added ${elementType} '${elementName}' to ${filePath}`);
  }

  /**
   * Remove a nested element from ChildObjects in the XML file.
   * @param filePath Path to XML file
   * @param elementType 'Attribute' or 'TabularSection'
   * @param elementName Name of the element to remove
   * @throws Error if file cannot be read or written
   */
  static async removeNestedElement(
    filePath: string,
    elementType: string,
    elementName: string
  ): Promise<void> {
    const xmlContent = await fs.promises.readFile(filePath, 'utf-8');
    const parsed = this.parser.parse(xmlContent);
    const updated = this.removeNestedElementInStructure(parsed, elementType, elementName);
    const xmlString = this.builder.build(updated);

    const backupPath = `${filePath}.bak`;
    try {
      await fs.promises.writeFile(backupPath, xmlContent, 'utf-8');
    } catch (backupErr) {
      Logger.warn(`Failed to create backup ${backupPath}`, backupErr);
    }

    try {
      await fs.promises.writeFile(filePath, xmlString, 'utf-8');
    } catch (writeError) {
      Logger.error(`Failed to write file: ${filePath}`, writeError);
      try {
        if (fs.existsSync(backupPath)) {
          const restored = await fs.promises.readFile(backupPath, 'utf-8');
          await fs.promises.writeFile(filePath, restored, 'utf-8');
          await fs.promises.unlink(backupPath);
          Logger.info(`Rolled back ${filePath} from backup`);
        }
      } catch (rollbackErr) {
        Logger.error(`Rollback failed for ${filePath}`, rollbackErr);
      }
      throw new Error(
        `Unable to write to file. Check file permissions and disk space. ${
          writeError instanceof Error ? writeError.message : String(writeError)
        }`
      );
    }

    try {
      if (fs.existsSync(backupPath)) {
        await fs.promises.unlink(backupPath);
      }
    } catch {
      Logger.debug(`Could not remove backup ${backupPath}`);
    }
    Logger.info(`Removed ${elementType} '${elementName}' from ${filePath}`);
  }

  /**
   * Create a new XML file with minimal Designer structure for a metadata element.
   * @param filePath Path for the new file
   * @param rootTag Root element tag (e.g. 'Catalog', 'Document', 'Enum')
   * @param elementName Name of the element
   * @throws Error if file cannot be written
   */
  static async createMinimalElementFile(
    filePath: string,
    rootTag: string,
    elementName: string
  ): Promise<void> {
    const uuid = this.generateSimpleUuid();
    const defaultProps = getDefaultPropertiesForRootTag(rootTag);
    const defaultPropsLines = this.formatDefaultPropertiesAsXml(defaultProps);
    let content = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
\t<${rootTag} uuid="${uuid}">
\t\t<Properties>
\t\t\t<Name>${this.escapeXml(elementName)}</Name>
\t\t\t<Synonym>
\t\t\t\t<v8:item>
\t\t\t\t\t<v8:lang>ru</v8:lang>
\t\t\t\t\t<v8:content>${this.escapeXml(elementName)}</v8:content>
\t\t\t\t</v8:item>
\t\t\t</Synonym>
\t\t\t<Comment/>
${defaultPropsLines}\t\t</Properties>
${rootTag === 'CommonModule' || rootTag === 'Role' ? '' : '\t\t<ChildObjects/>\n'}\t</${rootTag}>
</MetaDataObject>
`;
    content = injectInternalInfoIntoMetadataXml(content, rootTag, elementName);
    content = normalizeMetaDataObjectRoot(content);
    await fs.promises.writeFile(filePath, content, 'utf-8');
    Logger.info(`Created minimal ${rootTag} file ${filePath}`);
  }

  private static formatDefaultPropertiesAsXml(props: Record<string, unknown>): string {
    if (Object.keys(props).length === 0) {return '';}
    return Object.entries(props)
      .map(([key, value]) => `\t\t\t<${key}>${this.escapeXml(String(value))}</${key}>`)
      .join('\n') + '\n';
  }

  /**
   * Generate a simple UUID v4 for new metadata objects (e.g. in templates).
   * Public for use by elementOperations when creating from designer templates.
   */
  static generateSimpleUuid(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  private static escapeXml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  private static addNestedElementInStructure(
    parsed: unknown,
    elementType: string,
    elementName: string,
    minimalProperties: Record<string, unknown>,
    parentRootType?: MetadataType,
    parentObjectName?: string
  ): unknown {
    const isChildObjectElement = elementType === 'Attribute' || elementType === 'TabularSection';
    const containerName = isChildObjectElement ? 'ChildObjects' : elementType + 's';
    const newBlock = this.buildMinimalNestedElement(
      elementType,
      elementName,
      minimalProperties,
      parentRootType,
      parentObjectName
    );

    // Special handling for ChildObjects elements: only add to the root metadata object's ChildObjects,
    // not nested ChildObjects. This avoids writing into InternalInfo/GeneratedType branches.
    if (isChildObjectElement) {
      return this.addNestedElementInRootStructure(
        parsed,
        containerName,
        elementType,
        newBlock
      );
    }

    return this.mutateChildObjectsArray(parsed, containerName, elementType, (arr) => {
      arr.push(newBlock);
    });
  }

  private static removeNestedElementInStructure(
    parsed: unknown,
    elementType: string,
    elementName: string
  ): unknown {
    const isChildObjectElement = elementType === 'Attribute' || elementType === 'TabularSection';
    const containerName = isChildObjectElement ? 'ChildObjects' : elementType + 's';
    if (isChildObjectElement) {
      return this.removeNestedElementInRootStructure(parsed, containerName, elementType, elementName);
    }
    return this.mutateChildObjectsArray(parsed, containerName, elementType, (arr) => {
      for (let i = arr.length - 1; i >= 0; i--) {
        const item = arr[i];
        if (item && typeof item === 'object' && elementType in (item as object)) {
          const inner = (item as Record<string, unknown>)[elementType];
          if (Array.isArray(inner)) {
            const name = this.extractNameFromElementArray(inner);
            if (name === elementName) {
              arr.splice(i, 1);
              return;
            }
          }
        }
      }
    });
  }

  /**
   * Add nested element only to Root-level structure (Catalog/Document/etc), avoiding nested structures
   * Prevents adding attributes to wrong ChildObjects (inside InternalInfo/GeneratedType and other nested structures)
   */
  private static addNestedElementInRootStructure(
    parsed: unknown,
    containerName: string,
    elementType: string,
    newBlock: Record<string, unknown>
  ): unknown {
    if (!parsed || typeof parsed !== 'object') {return parsed;}
    
    if (Array.isArray(parsed)) {
      return parsed.map(item => this.addNestedElementInRootStructure(item, containerName, elementType, newBlock));
    }
    
    const obj = parsed as Record<string, unknown>;
    const result: Record<string, unknown> = { ...obj };
    
    // Find and add to ChildObjects of any TOP_LEVEL_TYPES element (Catalog, Document, etc)
    for (const typeName of TOP_LEVEL_TYPES) {
      if (typeName in obj) {
        const elementContent = obj[typeName as string];
        if (elementContent && typeof elementContent === 'object' && !Array.isArray(elementContent)) {
          const elemObj = elementContent as Record<string, unknown>;
          if ('ChildObjects' in elemObj) {
            const childObjects = elemObj.ChildObjects;
            let innerObj: Record<string, unknown>;
            let arr: unknown[];

            if (childObjects && typeof childObjects === 'object' && !Array.isArray(childObjects)) {
              // preserveOrder:false normal form: { Attribute: { @_uuid, Properties } } or
              // { Attribute: [ { @_uuid, Properties }, ... ] }
              innerObj = childObjects as Record<string, unknown>;
            } else if (Array.isArray(childObjects)) {
              // Broken array form (from previous bug): [ { Attribute: {...} }, ... ]
              // Reconstruct to object form: { Attribute: [ { @_uuid, Properties }, ... ] }
              innerObj = {};
              for (const item of childObjects) {
                if (item && typeof item === 'object') {
                  for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
                    if (!innerObj[k]) {
                      innerObj[k] = [];
                    }
                    (innerObj[k] as unknown[]).push(v);
                  }
                }
              }
            } else {
              // Empty string, null, undefined
              innerObj = {};
            }

            const existing = innerObj[elementType];
            if (Array.isArray(existing)) {
              arr = existing;
            } else if (existing !== null && existing !== undefined) {
              arr = [existing];
            } else {
              arr = [];
            }

            // newBlock is { Attribute: { @_uuid, Properties } } — extract inner content
            const unwrapped = (newBlock as Record<string, unknown>)[elementType];
            arr.push(unwrapped);
            innerObj[elementType] = arr;
            result[typeName as string] = { ...elemObj, ChildObjects: { ...innerObj } };
            return result;
          }
        }
      }
    }
    
    // Recurse into other properties
    for (const [key, value] of Object.entries(obj)) {
      if (Array.isArray(value)) {
        result[key] = this.addNestedElementInRootStructure(value, containerName, elementType, newBlock) as unknown[];
      } else if (value && typeof value === 'object') {
        result[key] = this.addNestedElementInRootStructure(value, containerName, elementType, newBlock);
      }
    }
    
    return result;
  }

  private static removeNestedElementInRootStructure(
    parsed: unknown,
    containerName: string,
    elementType: string,
    elementName: string
  ): unknown {
    if (!parsed || typeof parsed !== 'object') {return parsed;}
    
    if (Array.isArray(parsed)) {
      return parsed.map(item => this.removeNestedElementInRootStructure(item, containerName, elementType, elementName));
    }
    
    const obj = parsed as Record<string, unknown>;
    const result: Record<string, unknown> = { ...obj };
    
    // Remove from ChildObjects of any TOP_LEVEL_TYPES element
    for (const typeName of TOP_LEVEL_TYPES) {
      if (typeName in obj) {
        const elementContent = obj[typeName as string];
        if (elementContent && typeof elementContent === 'object' && !Array.isArray(elementContent)) {
          const elemObj = elementContent as Record<string, unknown>;
          if ('ChildObjects' in elemObj) {
            const childObjects = elemObj.ChildObjects;
            if (Array.isArray(childObjects)) {
              for (let i = childObjects.length - 1; i >= 0; i--) {
                const item = childObjects[i];
                if (item && typeof item === 'object' && elementType in (item as object)) {
                  const inner = (item as Record<string, unknown>)[elementType];
                  if (Array.isArray(inner)) {
                    const name = this.extractNameFromElementArray(inner);
                    if (name === elementName) {
                      childObjects.splice(i, 1);
                      result[typeName as string] = { ...elemObj, ChildObjects: childObjects };
                      return result; // Return early after removal
                    }
                  }
                }
              }
            } else if (childObjects && typeof childObjects === 'object') {
              // preserveOrder:false object form: { Attribute: {...} | [...], TabularSection: {...} | [...] }
              const childObj = childObjects as Record<string, unknown>;
              if (elementType in childObj) {
                const inner = childObj[elementType];
                const items = Array.isArray(inner) ? inner : inner != null ? [inner] : [];
                const filtered = items.filter((item) => this.extractNameFromNestedElement(item) !== elementName);
                if (filtered.length !== items.length) {
                  const nextChildObj = { ...childObj };
                  if (filtered.length === 0) {
                    delete nextChildObj[elementType];
                  } else {
                    nextChildObj[elementType] = filtered;
                  }
                  result[typeName as string] = { ...elemObj, ChildObjects: nextChildObj };
                  return result;
                }
              }
            }
          }
        }
        break; // Only process once
      }
    }
    
    // Recurse
    for (const [key, value] of Object.entries(obj)) {
      if (value && typeof value === 'object') {
        result[key] = this.removeNestedElementInRootStructure(value, containerName, elementType, elementName);
      }
    }
    
    return result;
  }

  private static extractNameFromElementArray(elementArray: unknown[]): string {
    for (const it of elementArray) {
      if (!it || typeof it !== 'object') {continue;}
      const o = it as Record<string, unknown>;
      if ('Name' in o && Array.isArray(o.Name) && o.Name.length > 0) {
        const first = o.Name[0];
        if (first && typeof first === 'object' && '#text' in (first as object)) {
          return String((first as Record<string, unknown>)['#text']);
        }
      }
      if ('Properties' in o && Array.isArray(o.Properties)) {
        const inner = this.extractNameFromElementArray(o.Properties as unknown[]);
        if (inner) {return inner;}
      }
    }
    return '';
  }

  private static extractNameFromNestedElement(element: unknown): string {
    if (!element || typeof element !== 'object') {
      return '';
    }
    const elementObj = element as Record<string, unknown>;
    const props = elementObj.Properties;
    if (!props) {
      return '';
    }
    if (Array.isArray(props)) {
      return this.extractNameFromElementArray(props);
    }
    if (typeof props === 'object' && props !== null) {
      const propsObj = props as Record<string, unknown>;
      const rawName = propsObj.Name;
      if (typeof rawName === 'string') {
        return rawName;
      }
      if (Array.isArray(rawName) && rawName.length > 0) {
        const first = rawName[0];
        if (first && typeof first === 'object' && '#text' in (first as object)) {
          return String((first as Record<string, unknown>)['#text']);
        }
      }
    }
    return '';
  }

  private static buildMinimalNestedElement(
    elementType: string,
    elementName: string,
    minimalProperties: Record<string, unknown>,
    parentRootType?: MetadataType,
    parentObjectName?: string
  ): Record<string, unknown> {
    const uuid = this.generateSimpleUuid();
    const defaults =
      elementType === 'Attribute' || elementType === 'TabularSection'
        ? getDefaultPropertiesForNestedElement(
            elementType as 'Attribute' | 'TabularSection',
            parentRootType
          )
        : {};
    const merged = { ...defaults, ...minimalProperties, Name: elementName };

    // Build the Properties object (representation of the Properties element)
    const propertiesObject: Record<string, unknown> = {};

    // Add Name property
    propertiesObject.Name = [{ '#text': elementName }];

    // Add Synonym property
    propertiesObject.Synonym = [
      {
        'v8:item': [
          {
            'v8:lang': [{ '#text': 'ru' }],
            'v8:content': [{ '#text': elementName }],
          },
        ],
      },
    ];

    // Add Type property if elementType is Attribute
    if (elementType === 'Attribute') {
      propertiesObject.Type = [
        {
          'v8:Type': [{ '#text': 'xs:string' }],
          'v8:StringQualifiers': [
            {
              'v8:Length': [{ '#text': '50' }],
              'v8:AllowedLength': [{ '#text': 'Variable' }],
            },
          ],
        },
      ];
    }

    // Add other properties
    for (const [key, value] of Object.entries(merged)) {
      if (key === 'Name' || key === 'Synonym' || key === 'Type') {continue;}
      // Handle special case for ToolTip object
      if (key === 'ToolTip' && typeof value === 'object' && value !== null) {
        // Build ToolTip with empty content if not provided
        const tooltipContent = value['#text'] || '';
        propertiesObject[key] = [
          {
            'v8:item': [
              {
                'v8:lang': [{ '#text': 'ru' }],
                'v8:content': [{ '#text': tooltipContent }],
              },
            ],
          },
        ];
      } else {
        // Handle null values for properties that should be xsi:nil="true"
        if (value === null) {
          const xsiNilProperties = ['MinValue', 'MaxValue', 'FillValue'];
          if (xsiNilProperties.includes(key)) {
            // For xsi:nil=true, represent as an object with the attribute
            // This will produce <key xsi:nil="true"/>
            propertiesObject[key] = { '@_xsi:nil': 'true' };
          }
          // For other null values, we skip them (don't add to properties)
        } else if (value !== undefined) {
          // For all other properties, include them even if they are empty strings
          // Represent as an element with text content
          propertiesObject[key] = [{ '#text': String(value) }];
        }
      }
    }

    // Return the element representation: element with uuid attribute and Properties child
    if (elementType === 'TabularSection') {
      return {
        [elementType]: {
          '@_uuid': uuid,
          ...(parentRootType && parentObjectName
            ? {
                InternalInfo: buildTabularSectionInternalInfoObject(
                  String(parentRootType),
                  parentObjectName,
                  elementName
                ),
              }
            : {}),
          Properties: propertiesObject,
          ChildObjects: {},
        },
      };
    }

    return {
      [elementType]: {
        '@_uuid': uuid,
        Properties: propertiesObject,
      },
    };
  }

  private static mutateChildObjectsArray(
    parsed: unknown,
    containerName: string,
    _elementType: string,
    mutate: (arr: unknown[]) => void
  ): unknown {
    if (!parsed || typeof parsed !== 'object') {return parsed;}
    if (Array.isArray(parsed)) {
      return parsed.map(item => this.mutateChildObjectsArray(item, containerName, _elementType, mutate));
    }
    // Handle object (non-array)
    const obj = parsed as Record<string, unknown>;
    const result = { ...obj }; // Shallow copy
    // Check if containerName property exists
    if (containerName in obj) {
      const value = obj[containerName];
      if (Array.isArray(value)) {
        // It's an array, mutate it
        mutate(value);
        result[containerName] = value;
      } else if (value === '' || value === null || value === undefined) {
        // Convert empty string/null/undefined to empty array and mutate
        const arr: unknown[] = [];
        mutate(arr);
        result[containerName] = arr;
      } else if (typeof value === 'object') {
        // With preserveOrder:false, parser gives ChildObjects as { Attribute: [...] } or { Attribute: {...} }.
        // Get or create the element array and mutate it instead of recursing (recursion would look for
        // containerName inside this object and wipe existing elements).
        const inner = value as Record<string, unknown>;
        const key = _elementType;
        let arr: unknown[];
        if (key in inner) {
          const existing = inner[key];
          if (Array.isArray(existing)) {
            arr = existing;
          } else if (existing !== null && existing !== undefined && typeof existing === 'object') {
            arr = [existing];
            inner[key] = arr;
          } else {
            arr = [];
            inner[key] = arr;
          }
        } else {
          arr = [];
          inner[key] = arr;
        }
        // Normalize: parser may give unwrapped items (no elementType key). Ensure same shape so mutate pushes consistent form.
        if (arr.length > 0) {
          const first = arr[0];
          const isWrapped =
            first &&
            typeof first === 'object' &&
            _elementType in (first as Record<string, unknown>);
          if (!isWrapped) {
            inner[key] = arr.map((item) =>
              item && typeof item === 'object' && !(_elementType in (item as Record<string, unknown>))
                ? { [_elementType]: item }
                : item
            );
            arr = inner[key] as unknown[];
          }
        }
        mutate(arr);
        result[containerName] = value;
      }
      // For other values (string, number, boolean, etc.), leave as-is
    } else {
      // Property doesn't exist, create it as an empty array and mutate
      const arr: unknown[] = [];
      mutate(arr);
      result[containerName] = arr;
    }
    // Now recurse into all other properties (excluding containerName since we've handled it)
    for (const [key, value] of Object.entries(obj)) {
      if (key === containerName) {
        // Skip containerName as we've already handled it
        continue;
      }
      if (Array.isArray(value)) {
        result[key] = this.mutateChildObjectsArray(value, containerName, _elementType, mutate) as unknown[];
      } else if (value && typeof value === 'object') {
        result[key] = this.mutateChildObjectsArray(value, containerName, _elementType, mutate);
      }
      // For primitive values, copy as-is (already done by the spread above)
    }
    return result;
  }

  /**
   * Update specific property in XML file
   * Only modifies the target property node
   * @param filePath Path to XML file
   * @param propertyName Name of property to update
   * @param value New value for the property
   * @throws Error if file cannot be read or written
   */
  static async updateProperty(
    filePath: string,
    propertyName: string,
    value: unknown
  ): Promise<void> {
    try {
      const properties = await this.readProperties(filePath);
      properties[propertyName] = value;
      await this.writeProperties(filePath, properties);
      Logger.info(`Successfully updated property '${propertyName}' in ${filePath}`);
    } catch (error) {
      Logger.error(`Error updating property '${propertyName}' in ${filePath}`, error);
      throw new Error(
        `Failed to update property '${propertyName}' in XML file: ${filePath}. ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Parse XML string, update nested element properties in structure, and build back to XML.
   * Used by tests and by writeNestedElementProperties.
   */
  static buildUpdatedNestedXml(
    xmlContent: string,
    elementType: string,
    elementName: string,
    properties: Record<string, unknown>,
    changedKeys?: string[]
  ): string {
    const parsed = this.parser.parse(xmlContent);
    let updated = this.updateNestedElementInStructure(parsed, elementType, elementName, properties, changedKeys);
    // Parser may return root as array of one element; builder expects single object
    if (Array.isArray(updated) && updated.length === 1) {
      updated = updated[0];
    }
    return this.builder.build(updated);
  }

  /**
   * Write properties for a nested element (Attribute, TabularSection, etc.)
   * Updates only the specific nested element, not the entire file
   * @param filePath Path to XML file
   * @param elementType Type of nested element (e.g., 'Attribute', 'TabularSection')
   * @param elementName Name of the nested element to update
   * @param properties Properties object to write
   * @throws Error if file cannot be written
   */
  static async writeNestedElementProperties(
      filePath: string,
      elementType: string,
      elementName: string,
      properties: Record<string, unknown>,
      changedKeys?: string[]
    ): Promise<void> {
      try {
        let xmlContent: string;
        try {
          xmlContent = await fs.promises.readFile(filePath, 'utf-8');
        } catch (readError) {
          Logger.error(`Failed to read file for writing: ${filePath}`, readError);
          throw new Error(
            `Unable to read file for updating. ${readError instanceof Error ? readError.message : String(readError)}`
          );
        }


        let xmlString: string;
        try {
          xmlString = this.buildUpdatedNestedXml(xmlContent, elementType, elementName, properties, changedKeys);
        } catch (buildError) {
          Logger.error(`Failed to build XML for ${filePath}`, buildError);
          throw new Error(
            `Failed to generate XML content. ${buildError instanceof Error ? buildError.message : String(buildError)}`
          );
        }

        const backupPath = `${filePath}.bak`;
        try {
          await fs.promises.writeFile(backupPath, xmlContent, 'utf-8');
        } catch (backupErr) {
          Logger.warn(`Failed to create backup ${backupPath}`, backupErr);
        }

        try {
          await fs.promises.writeFile(filePath, xmlString, 'utf-8');
        } catch (writeError) {
          Logger.error(`Failed to write file: ${filePath}`, writeError);
          try {
            if (fs.existsSync(backupPath)) {
              const restored = await fs.promises.readFile(backupPath, 'utf-8');
              await fs.promises.writeFile(filePath, restored, 'utf-8');
              await fs.promises.unlink(backupPath);
              Logger.info(`Rolled back ${filePath} from backup`);
            }
          } catch (rollbackErr) {
            Logger.error(`Rollback failed for ${filePath}`, rollbackErr);
          }
          throw new Error(
            `Unable to write to file. Check file permissions and disk space. ${
              writeError instanceof Error ? writeError.message : String(writeError)
            }`
          );
        }

        try {
          if (fs.existsSync(backupPath)) {
            await fs.promises.unlink(backupPath);
          }
        } catch {
          Logger.debug(`Could not remove backup ${backupPath}`);
        }
        Logger.info(`Successfully wrote properties for ${elementType} '${elementName}' to ${filePath}`);
      } catch (error) {
        Logger.error(`Error writing nested element properties to ${filePath}`, error);

        if (error instanceof Error && 
            (error.message.includes('Invalid XML structure') || 
             error.message.includes('Unable to'))) {
          throw error;
        }

        throw new Error(
          `Failed to write nested element properties to XML file: ${filePath}. ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }


  /**
   * Convert string boolean values to actual boolean primitives
   * @param properties Properties object that may contain string "false"/"true" values
   * @returns Properties object with string booleans converted to primitives
   */
  private static convertStringBooleans(properties: Record<string, unknown>): Record<string, unknown> {
    const converted: Record<string, unknown> = {};
    
    for (const [key, value] of Object.entries(properties)) {
      if (value === 'false') {
        converted[key] = false;
      } else if (value === 'true') {
        converted[key] = true;
      } else {
        converted[key] = value;
      }
    }
    
    return converted;
  }

  private static extractProperties(parsed: unknown): Record<string, unknown> {
    const properties: Record<string, unknown> = {};

    if (!parsed || typeof parsed !== 'object') {
      return properties;
    }

    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item && typeof item === 'object') {
          for (const [key, value] of Object.entries(item)) {
            if (key === ':@' || key.startsWith('?')) {
              continue;
            }

            if (key === 'Properties' && Array.isArray(value)) {
              const flattened = this.flattenPropertiesArray(value);
              return this.convertStringBooleans(this.postProcessProperties(flattened));
            }

            if (Array.isArray(value)) {
              const nested = this.extractProperties(value);
              if (Object.keys(nested).length > 0) {
                return nested;
              }
            }
          }
        }
      }
      return properties;
    }

    const obj = parsed as Record<string, unknown>;
    if (obj.Properties && typeof obj.Properties === 'object') {
      const flattened = this.flattenProperties(obj.Properties as Record<string, unknown>);
      return this.convertStringBooleans(this.postProcessProperties(flattened));
    }

    // Recurse into nested structure (e.g. MetaDataObject → Configuration → Properties)
    for (const [k, value] of Object.entries(obj)) {
      if (value === null || value === undefined) {continue;}
      if (k === ':@' || (typeof k === 'string' && k.startsWith('?'))) {continue;}
      const nested = this.extractProperties(value);
      if (Object.keys(nested).length > 0) {
        return nested;
      }
    }

    return properties;
  }

  /**
   * Post-process properties to format Type arrays
   */
  private static postProcessProperties(properties: Record<string, unknown>): Record<string, unknown> {
    // Check if Type property is an array that needs formatting
    if (properties.Type && Array.isArray(properties.Type)) {
      try {
        // Merge all type-related elements into a single object
        const typeObject: Record<string, unknown> = {};
        const v8Types: unknown[] = [];
        
        for (const typeItem of properties.Type) {
          if (typeItem && typeof typeItem === 'object') {
            for (const [typeKey, typeValue] of Object.entries(typeItem)) {
              if (typeKey === 'v8:Type') {
                // Collect all v8:Type elements
                if (Array.isArray(typeValue)) {
                  v8Types.push(...typeValue);
                } else {
                  v8Types.push(typeValue);
                }
              } else if (typeKey.startsWith('v8:')) {
                // Collect qualifiers (v8:StringQualifiers, v8:NumberQualifiers, etc.)
                typeObject[typeKey] = typeValue;
              }
            }
          }
        }
        
        // Add collected v8:Type elements to typeObject
        if (v8Types.length > 0) {
          typeObject['v8:Type'] = v8Types;
        }
        
        const typeDef = TypeParser.parseFromObject(typeObject);
        properties.Type = TypeFormatter.formatTypeDisplay(typeDef);
      } catch (error) {
        // If parsing fails, leave as-is
        Logger.error('Failed to format Type property in postProcessProperties', error);
      }
    }
    
    return properties;
  }

  private static flattenPropertiesArray(propertiesArray: unknown[]): Record<string, unknown> {
    const flattened: Record<string, unknown> = {};

    for (const item of propertiesArray) {
      if (!item || typeof item !== 'object') {
        continue;
      }

      for (const [key, value] of Object.entries(item)) {
        if (key === ':@') {
          continue;
        }

        if (key === 'Type' && Array.isArray(value) && value.length > 0) {
          // Handle Type element - collect all v8:Type, qualifiers, etc. from array
          try {
            // Merge all type-related elements into a single object
            const typeObject: Record<string, unknown> = {};
            const v8Types: unknown[] = [];
            
            for (const typeItem of value) {
              if (typeItem && typeof typeItem === 'object') {
                for (const [typeKey, typeValue] of Object.entries(typeItem)) {
                  if (typeKey === 'v8:Type') {
                    // Collect all v8:Type elements
                    if (Array.isArray(typeValue)) {
                      v8Types.push(...typeValue);
                    } else {
                      v8Types.push(typeValue);
                    }
                  } else if (typeKey.startsWith('v8:')) {
                    // Collect qualifiers (v8:StringQualifiers, v8:NumberQualifiers, etc.)
                    typeObject[typeKey] = typeValue;
                  }
                }
              }
            }
            
            // Add collected v8:Type elements to typeObject
            if (v8Types.length > 0) {
              typeObject['v8:Type'] = v8Types;
            }
            
            const typeDef = TypeParser.parseFromObject(typeObject);
            flattened[key] = TypeFormatter.formatTypeDisplay(typeDef);
          } catch (error) {
            // If parsing fails, fall back to raw value
            Logger.error('Failed to parse type in XMLWriter.flattenPropertiesArray', error);
            flattened[key] = value;
          }
        } else if (Array.isArray(value) && value.length > 0) {
          const firstChild = value[0];
          if (firstChild && typeof firstChild === 'object' && '#text' in firstChild) {
            const rec = firstChild as Record<string, unknown>;
            flattened[key] = rec['#text'];
          } else {
            flattened[key] = value;
          }
        } else if (key === 'Type' && value && typeof value === 'object' && 'v8:Type' in value) {
          // Handle Type element when it's a single object (not array)
          try {
            const typeDef = TypeParser.parseFromObject(value as Record<string, unknown>);
            flattened[key] = TypeFormatter.formatTypeDisplay(typeDef);
          } catch (error) {
            Logger.error('Failed to parse type in XMLWriter.flattenPropertiesArray', error);
            const valueRec = value as Record<string, unknown>;
            const typeValue = valueRec['v8:Type'];
            flattened[key] = Array.isArray(typeValue) ? typeValue[0] : typeValue;
          }
        } else {
          flattened[key] = value;
        }
      }
    }

    return flattened;
  }

  private static flattenProperties(properties: Record<string, unknown>): Record<string, unknown> {
    const flattened: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(properties)) {
      if (key.startsWith('@_') || key.startsWith('#')) {
        continue;
      }

      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const obj = value as Record<string, unknown>;
        if ('#text' in obj) {
          flattened[key] = obj['#text'];
        } else if ('v8:Type' in obj) {
          // Handle Type element with v8:Type child
          // Parse and format the type for display
          try {
            const typeDef = TypeParser.parseFromObject(obj);
            flattened[key] = TypeFormatter.formatTypeDisplay(typeDef);
          } catch (error) {
            // If parsing fails, fall back to raw v8:Type value
            Logger.error('Failed to parse type in XMLWriter.flattenProperties', error);
            flattened[key] = obj['v8:Type'];
          }
        } else {
          flattened[key] = value;
        }
      } else {
        flattened[key] = value;
      }
    }

    return flattened;
  }

  private static updatePropertiesInStructure(
    parsed: unknown,
    properties: Record<string, unknown>
  ): unknown {
    if (!parsed || typeof parsed !== 'object') {
      return parsed;
    }

    if (Array.isArray(parsed)) {
      return parsed.map((item) => {
        if (!item || typeof item !== 'object') {
          return item;
        }

        const result: Record<string, unknown> = {};
        
        for (const [key, value] of Object.entries(item)) {
          if (key === ':@') {
            result[key] = value;
            continue;
          }

          if (key === 'Properties' && Array.isArray(value)) {
            result[key] = this.updatePropertiesArray(value, properties);
          } else if (key === 'Properties' && value && typeof value === 'object') {
            result[key] = this.updatePropertiesObject(value as Record<string, unknown>, properties);
          } else if (Array.isArray(value)) {
            result[key] = this.updatePropertiesInStructure(value, properties);
          } else if (value !== null && value !== undefined && typeof value === 'object') {
            result[key] = this.updatePropertiesInStructure(value, properties);
          } else {
            result[key] = value;
          }
        }

        return result;
      });
    }

    // Root or nested object (e.g. MetaDataObject → Catalog → Properties): recurse into values
    const obj = parsed as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key === ':@' || (typeof key === 'string' && key.startsWith('?'))) {
        result[key] = value;
        continue;
      }
      if (key === 'Properties') {
        if (Array.isArray(value)) {
          result[key] = this.updatePropertiesArray(value, properties);
        } else if (value && typeof value === 'object') {
          result[key] = this.updatePropertiesObject(value as Record<string, unknown>, properties);
        } else {
          result[key] = value;
        }
      } else if (value !== null && value !== undefined && typeof value === 'object') {
        result[key] = this.updatePropertiesInStructure(value, properties);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  /** Updates Properties when parsed as object (key -> array or single value per property). */
  private static updatePropertiesObject(
    propertiesObj: Record<string, unknown>,
    newProperties: Record<string, unknown>
  ): Record<string, unknown> {
    const result = { ...propertiesObj };
    for (const [key, newVal] of Object.entries(newProperties)) {
      const textVal = typeof newVal === 'boolean' || typeof newVal === 'number'
        ? newVal
        : String(newVal);
      const existing = result[key];
      if (Array.isArray(existing) && existing.length > 0) {
        const first = existing[0];
        if (first && typeof first === 'object' && '#text' in (first as object)) {
          result[key] = [{ ...(first as Record<string, unknown>), '#text': textVal }];
        } else {
          result[key] = [{ '#text': textVal }];
        }
      } else if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
        const rec = existing as Record<string, unknown>;
        if ('#text' in rec) {
          result[key] = { ...rec, '#text': textVal };
        } else {
          result[key] = existing;
        }
      } else {
        result[key] = [{ '#text': textVal }];
      }
    }
    return result;
  }

  private static updatePropertiesArray(
    propertiesArray: unknown[],
    properties: Record<string, unknown>
  ): unknown[] {
    return propertiesArray.map((item) => {
      if (!item || typeof item !== 'object') {
        return item;
      }

      const result: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(item)) {
        if (key === ':@') {
          result[key] = value;
          continue;
        }

        if (key in properties) {
          const newValue = properties[key];
          
          if (Array.isArray(value) && value.length > 0) {
            const firstChild = value[0];
            if (firstChild && typeof firstChild === 'object' && '#text' in firstChild) {
              const textValue = typeof newValue === 'boolean' || typeof newValue === 'number' 
                ? newValue 
                : String(newValue);
              result[key] = [{ ...firstChild, '#text': textValue }];
            } else {
              const textValue = typeof newValue === 'boolean' || typeof newValue === 'number'
                ? newValue
                : String(newValue);
              result[key] = [{ '#text': textValue }];
            }
          } else {
            const textValue = typeof newValue === 'boolean' || typeof newValue === 'number'
              ? newValue
              : String(newValue);
            result[key] = [{ '#text': textValue }];
          }
        } else {
          result[key] = value;
        }
      }

      return result;
    });
  }

  private static updateNestedElementInStructure(
    parsed: unknown,
    elementType: string,
    elementName: string,
    properties: Record<string, unknown>,
    changedKeys?: string[]
  ): unknown {
    if (!parsed || typeof parsed !== 'object') {
      return parsed;
    }

    const containerName =
      elementType === 'Attribute' || elementType === 'TabularSection'
        ? 'ChildObjects'
        : elementType + 's';
    const matchesContainer = (k: string) => k === containerName || k.endsWith(':' + containerName);
    const innerHasElementType = (v: Record<string, unknown>) =>
      elementType in v || Object.keys(v).some((k) => k === elementType || k.endsWith(':' + elementType));

    if (Array.isArray(parsed)) {
      return parsed.map((item) => {
        if (!item || typeof item !== 'object') {
          return item;
        }

        const result: Record<string, unknown> = {};
        
        for (const [key, value] of Object.entries(item)) {
          if (key === ':@') {
            result[key] = value;
            continue;
          }

          if (matchesContainer(key)) {
            if (Array.isArray(value)) {
              result[key] = this.updateNestedElementArray(value, elementType, elementName, properties, changedKeys);
            } else if (value && typeof value === 'object' && innerHasElementType(value as Record<string, unknown>)) {
              const inner = value as Record<string, unknown>;
              const elementKey = elementType in inner ? elementType : Object.keys(inner).find((k) => k === elementType || k.endsWith(':' + elementType))!;
              const raw = inner[elementKey];
              const innerArr = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
              const elementsArray = innerArr.map((x: unknown) => ({ [elementKey]: [x] }));
              const updated = this.updateNestedElementArray(elementsArray, elementType, elementName, properties, changedKeys);
              result[key] = { [elementKey]: updated.flatMap((it) => ((it as Record<string, unknown>)[elementKey] as unknown[]) || []) };
            } else {
              result[key] = value;
            }
          } else if (Array.isArray(value)) {
            result[key] = this.updateNestedElementInStructure(value, elementType, elementName, properties, changedKeys);
          } else if (value !== null && value !== undefined && typeof value === 'object') {
            result[key] = this.updateNestedElementInStructure(value, elementType, elementName, properties, changedKeys);
          } else {
            result[key] = value;
          }
        }

        return result;
      });
    }

    // Root or nested object: recurse into values to find containerName
    const obj = parsed as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key === ':@' || (typeof key === 'string' && key.startsWith('?'))) {
        result[key] = value;
        continue;
      }
      if (matchesContainer(key)) {
        if (Array.isArray(value)) {
          result[key] = this.updateNestedElementArray(value, elementType, elementName, properties, changedKeys);
        } else if (value && typeof value === 'object' && innerHasElementType(value as Record<string, unknown>)) {
          const inner = value as Record<string, unknown>;
          const elementKey = elementType in inner ? elementType : Object.keys(inner).find((k) => k === elementType || k.endsWith(':' + elementType))!;
          const raw = inner[elementKey];
          const innerArr = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
          const elementsArray = innerArr.map((x: unknown) => ({ [elementKey]: [x] }));
          // Apply selective write: recursively pass changedKeys to nested updater
          const updated = this.updateNestedElementArray(elementsArray, elementType, elementName, properties, changedKeys);
          result[key] = { [elementKey]: updated.flatMap((it) => ((it as Record<string, unknown>)[elementKey] as unknown[]) || []) };
        } else {
          result[key] = value;
        }
      } else if (value !== null && value !== undefined && typeof value === 'object') {
        result[key] = this.updateNestedElementInStructure(value, elementType, elementName, properties, changedKeys);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  private static updateNestedElementArray(
    elementsArray: unknown[],
    elementType: string,
    elementName: string,
    properties: Record<string, unknown>,
    changedKeys?: string[]
  ): unknown[] {
    const matchesElementType = (k: string) => k === elementType || k.endsWith(':' + elementType);
    return elementsArray.map((item) => {
      if (!item || typeof item !== 'object') {
        return item;
      }

      const result: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(item)) {
        if (key === ':@') {
          result[key] = value;
          continue;
        }

        if (matchesElementType(key) && Array.isArray(value)) {
          const elementData = this.extractNestedElementData(value);
          if (elementData.name === elementName) {
            result[key] = this.updateNestedElementProperties(value, properties, changedKeys);
          } else {
            result[key] = value;
          }
        } else {
          result[key] = value;
        }
      }

      return result;
    });
  }

  private static extractNestedElementData(elementArray: unknown[]): { name: string } {
    const textFrom = (val: unknown): string => {
      if (typeof val === 'string') {return val;}
      if (Array.isArray(val) && val.length > 0 && val[0] && typeof val[0] === 'object' && '#text' in (val[0] as object)) {
        return String((val[0] as Record<string, unknown>)['#text']);
      }
      if (val && typeof val === 'object' && '#text' in (val as object)) {
        return String((val as Record<string, unknown>)['#text']);
      }
      return '';
    };
    const extractNameFrom = (arr: unknown): string => {
      if (arr && typeof arr === 'object' && !Array.isArray(arr)) {
        const obj = arr as Record<string, unknown>;
        const nameKey = 'Name' in obj ? 'Name' : Object.keys(obj).find((k) => k === 'Name' || k.endsWith(':Name'));
        if (nameKey) {
          const n = textFrom(obj[nameKey]);
          if (n) {return n;}
        }
        if ('Properties' in obj) {
          const inner = extractNameFrom(obj.Properties);
          if (inner) {return inner;}
        }
        return '';
      }
      if (!Array.isArray(arr)) {return '';}
      for (const it of arr) {
        if (!it || typeof it !== 'object') {continue;}
        const o = it as Record<string, unknown>;
        if ('Name' in o && Array.isArray(o.Name)) {
          const nameArr = o.Name as unknown[];
          if (nameArr.length > 0 && nameArr[0] && typeof nameArr[0] === 'object') {
            const nameObj = nameArr[0] as Record<string, unknown>;
            if ('#text' in nameObj) {return String(nameObj['#text']);}
          }
        }
        if ('Properties' in o) {
          const inner = extractNameFrom(o.Properties);
          if (inner) {return inner;}
        }
      }
      return '';
    };
    const name = extractNameFrom(elementArray);
    return { name };
  }

  /** Extract Type element content from parser output (handles preserveOrder root array) */
  private static extractTypeContentFromParsed(parsed: unknown): unknown[] | unknown | null {
    if (!parsed || typeof parsed !== 'object') {return null;}
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item && typeof item === 'object' && 'Type' in (item as Record<string, unknown>)) {
          const inner = (item as Record<string, unknown>).Type;
          return inner != null ? inner : null;
        }
      }
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    return 'Type' in obj ? obj.Type ?? null : null;
  }

  /** Updates Properties when in object form (key -> array or value per property). */
  private static updateNestedElementPropertiesObject(
    propertiesObj: Record<string, unknown>,
    newProperties: Record<string, unknown>,
    changedKeys?: string[]
  ): Record<string, unknown> {
    const result = { ...propertiesObj };
    for (const [key, newVal] of Object.entries(newProperties)) {
      // Apply selective write if changedKeys provided and key not in changedKeys
      if (changedKeys && !changedKeys.includes(key)) {
        // Keep existing property as-is; do not write derived/tool properties
        if (!key.startsWith('_')) {
          result[key] = propertiesObj[key];
        }
        continue;
      }

      const existing = result[key];

      // Do not write raw objects; preserve existing structured content for non-user keys
      if (typeof newVal === 'object' && newVal !== null && !Array.isArray(newVal)) {
        // Only overwrite if we have a structured Type object parse from XML
        if (key === 'Type' && !Array.isArray(existing) && existing && typeof existing === 'object') {
          // Keep existing Type object (structured v8:Type/v8:Qualifiers), do not flatten
          result[key] = existing; // already set by spread
        } else {
          result[key] = existing; // keep existing for other object props
        }
        continue;
      }

      // Compute text value for simple props
      const textVal = typeof newVal === 'boolean' || typeof newVal === 'number' ? newVal : String(newVal);

      // Handle Type as structured XML (from type editor)
      if (key === 'Type' && typeof newVal === 'string' && newVal.trim().includes('<')) {
        try {
          const typeParsed = this.parser.parse(newVal.trim());
          const inner = this.extractTypeContentFromParsed(typeParsed);
          result[key] = inner != null ? (Array.isArray(inner) ? inner : [inner]) : [{ '#text': newVal }];
        } catch {
          // On parse error, write as text node only if not already structured
          if (!Array.isArray(existing)) {
            result[key] = [{ '#text': newVal }];
          } else {
            result[key] = existing;
          }
        }
      } else if (Array.isArray(existing) && existing.length > 0) {
        // Update existing array-form props
        const first = existing[0];
        if (first && typeof first === 'object' && '#text' in first) {
          result[key] = [{ ...first, '#text': textVal }];
        } else {
          const arr: unknown[] = Array.isArray(existing) ? [...existing] : [];
          if (arr.length === 0) {arr.push({});}
          const base = arr[0] && typeof arr[0] === 'object' ? (arr[0] as Record<string, unknown>) : {};
          result[key] = [{ ...base, '#text': textVal }];
        }
      } else if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
        const rec = existing as Record<string, unknown>;
        if ('#text' in rec) {
          result[key] = { ...rec, '#text': textVal };
        } else {
          result[key] = [{ '#text': textVal }];
        }
      } else {
        result[key] = [{ '#text': textVal }];
      }
    }
    return result;
  }

  private static updateNestedElementProperties(
    elementArray: unknown[],
    properties: Record<string, unknown>,
    changedKeys?: string[]
  ): unknown[] {
    // если changedKeys не передан, по умолчанию обновлять все пропсы из properties
    const targets = changedKeys && changedKeys.length ? changedKeys : Object.keys(properties || {});
    return elementArray.map((item) => {
      if (!item || typeof item !== 'object') {
        return item;
      }

      const result: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(item)) {
        if (key === ':@') {
          result[key] = value;
          continue;
        }

        // Designer format: Attribute props (Type, Name, etc.) live inside Properties
        if (key === 'Properties') {
          const val = value;
          if (Array.isArray(val)) {
            result[key] = this.updateNestedElementProperties(val, properties, changedKeys);
          } else if (val && typeof val === 'object') {
            result[key] = this.updateNestedElementPropertiesObject(val as Record<string, unknown>, properties, changedKeys);
          } else {
            result[key] = val;
          }
          continue;
        }

        // Обновляем только если ключ в списке целевых ключей для selective write
        const shouldUpdateThisKey = targets.includes(key);

        if (shouldUpdateThisKey) {
          const newValue = properties[key];
          const textValue = typeof newValue === 'boolean' || typeof newValue === 'number'
            ? newValue
            : String(newValue ?? '');

          // Keep raw object references as-is (except for Type structured handling below)
          if (typeof newValue === 'object' && newValue !== null && !Array.isArray(newValue)) {
            if (key === 'Type' && value && typeof value === 'object') {
              // preserve existing structured Type element (v8:Type and qualifiers)
              result[key] = value; // keeps existing child object structure
            } else {
              // skip corruption for other raw object props
              result[key] = value;
            }
            continue;
          }

          // Type from type editor is sent as XML string; write as structured content, not #text
          if (key === 'Type' && typeof newValue === 'string' && newValue.trim().includes('<')) {
            try {
              const typeParsed = this.parser.parse(newValue.trim());
              const inner = this.extractTypeContentFromParsed(typeParsed);
              result[key] = inner != null ? (Array.isArray(inner) ? inner : [inner]) : [{ '#text': textValue }];
            } catch (parseErr) {
              Logger.error('Failed to parse Type XML in updateNestedElementProperties', parseErr);
              result[key] = [{ '#text': textValue }];
            }
          } else {
            // Handle flat property updates
            if (Array.isArray(value) && value.length > 0) {
              const firstChild = value[0];
              if (firstChild && typeof firstChild === 'object' && '@_xsi:nil' in firstChild) {
                result[key] = value; // Keep original xsi:nil
              } else if (firstChild && typeof firstChild === 'object' && '#text' in firstChild) {
                result[key] = [{ ...firstChild, '#text': textValue }];
              } else {
                result[key] = [{ '#text': textValue }];
              }
            } else {
              result[key] = [{ '#text': textValue }];
            }
          }
        } else {
          // preserve existing property when not updating
          result[key] = value;
        }
      }

      return result;
    });
  }
}
