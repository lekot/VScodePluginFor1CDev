import * as fs from 'fs';
import { Logger } from './logger';
import { xmlParser } from './xml/xmlCore';
import { buildXmlString, writeUtf8FileWithBackup } from './xml/xmlFileIo';
import { generateSimpleUuid as xmlGenerateSimpleUuid } from './xml/xmlHelpers';
import { extractProperties, updatePropertiesInStructure } from './xml/xmlPropertiesService';
import {
  ROOT_TAGS_WITHOUT_CHILDOBJECTS,
  addNestedElementInStructure,
  removeNestedElementInStructure,
  buildUpdatedNestedXml as buildUpdatedNestedXmlImpl,
  type WriteNestedElementOptions,
} from './xml/xmlChildObjectsService';
import {
  addAttributeToTabularSectionInParsed,
  duplicateAttributeInTabularSectionInParsed,
  removeAttributeFromTabularSectionInParsed,
} from './xml/xmlTabularSectionService';
import {
  addDesignerFormReferenceInParsed,
  removeDesignerFormFromOwnerInParsed,
} from './xml/xmlFormReferenceService';
import { getDefaultPropertiesForRootTag } from '../constants/metadataDefaultValues';
import { MetadataType } from '../models/treeNode';
import { injectInternalInfoIntoMetadataXml } from '../services/internalInfoGenerator';
import { normalizeMetaDataObjectRoot } from '../services/metaDataObjectRootNormalizer';

export type { WriteNestedElementOptions };
export { ROOT_TAGS_WITHOUT_CHILDOBJECTS } from './xml/xmlChildObjectsService';

/**
 * XMLWriter utility class for reading and writing XML files
 * while preserving structure and formatting
 */
export class XMLWriter {
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

      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) {
        throw new Error(`Not a file: ${filePath}`);
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
        parsed = xmlParser.parse(xmlContent);
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

      const properties = extractProperties(parsed);
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
        parsed = xmlParser.parse(xmlContent);
      } catch (parseError) {
        const errorMsg = parseError instanceof Error ? parseError.message : String(parseError);
        Logger.error(`XML parsing failed for ${filePath}`, parseError);
        throw new Error(
          `Invalid XML structure in file. Cannot update properties in a corrupted XML file. ${errorMsg}`
        );
      }

      const updated = updatePropertiesInStructure(parsed, properties);

      let xmlString: string;
      try {
        xmlString = buildXmlString(updated);
      } catch (buildError) {
        Logger.error(`Failed to build XML for ${filePath}`, buildError);
        throw new Error(
          `Failed to generate XML content. ${buildError instanceof Error ? buildError.message : String(buildError)}`
        );
      }

      await writeUtf8FileWithBackup(filePath, xmlContent, xmlString);
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
    const { xmlContent, parsed } = await this.readUtf8AndParse(filePath);
    const updated = addNestedElementInStructure(
      parsed,
      elementType,
      elementName,
      minimalProperties ?? {},
      parentRootType,
      parentObjectName
    );
    await this.saveParsedWithBackup(filePath, xmlContent, updated, `Added ${elementType} '${elementName}' to ${filePath}`);
  }

  /**
   * Add an Attribute (column) into a TabularSection's ChildObjects — either a dedicated
   * `TabularSections/Name/Name.xml` file or a TabularSection inside an object's ChildObjects.
   */
  static async addAttributeToTabularSection(
    filePath: string,
    tabularSectionName: string,
    columnName: string,
    parentRootType: MetadataType,
    parentObjectName: string
  ): Promise<void> {
    const { xmlContent, parsed } = await this.readUtf8AndParse(filePath);
    const updated = addAttributeToTabularSectionInParsed(
      parsed,
      tabularSectionName,
      columnName,
      parentRootType,
      parentObjectName
    );
    await this.saveParsedWithBackup(
      filePath,
      xmlContent,
      updated,
      `Added column '${columnName}' to tabular section '${tabularSectionName}' in ${filePath}`
    );
  }

  /**
   * Remove a column (Attribute) from a TabularSection's ChildObjects in the same layouts as
   * {@link addAttributeToTabularSection}.
   */
  static async removeAttributeFromTabularSection(
    filePath: string,
    tabularSectionName: string,
    columnName: string
  ): Promise<void> {
    const { xmlContent, parsed } = await this.readUtf8AndParse(filePath);
    const updated = removeAttributeFromTabularSectionInParsed(parsed, tabularSectionName, columnName);
    await this.saveParsedWithBackup(
      filePath,
      xmlContent,
      updated,
      `Removed column '${columnName}' from tabular section '${tabularSectionName}' in ${filePath}`
    );
  }

  /**
   * Duplicate a tabular section column by deep-cloning its XML block (Type, qualifiers, etc.),
   * assigning a new uuid and {@link MetadataType.Attribute} name.
   */
  static async duplicateAttributeInTabularSection(
    filePath: string,
    tabularSectionName: string,
    sourceColumnName: string,
    newColumnName: string
  ): Promise<void> {
    const { xmlContent, parsed } = await this.readUtf8AndParse(filePath);
    const updated = duplicateAttributeInTabularSectionInParsed(
      parsed,
      tabularSectionName,
      sourceColumnName,
      newColumnName
    );
    await this.saveParsedWithBackup(
      filePath,
      xmlContent,
      updated,
      `Duplicated column '${sourceColumnName}' -> '${newColumnName}' in tabular section '${tabularSectionName}' in ${filePath}`
    );
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
    const { xmlContent, parsed } = await this.readUtf8AndParse(filePath);
    const updated = removeNestedElementInStructure(parsed, elementType, elementName);
    await this.saveParsedWithBackup(
      filePath,
      xmlContent,
      updated,
      `Removed ${elementType} '${elementName}' from ${filePath}`
    );
  }

  /**
   * Adds `<Form>formName</Form>` to the owner metadata object's ChildObjects (Designer).
   */
  static async addDesignerFormReferenceToOwnerMetadata(filePath: string, formName: string): Promise<void> {
    const { xmlContent, parsed } = await this.readUtf8AndParse(filePath);
    const state = { changed: false };
    const updated = addDesignerFormReferenceInParsed(parsed, formName, state);
    if (!state.changed) {
      return;
    }
    await this.saveParsedWithBackup(
      filePath,
      xmlContent,
      updated,
      `Registered form '${formName}' in ChildObjects of ${filePath}`
    );
  }

  /**
   * Removes the form from ChildObjects and clears Default*Form / Auxiliary*Form properties
   * whose value ends with `.Form.<formName>`.
   */
  static async removeDesignerFormFromOwnerMetadata(filePath: string, formName: string): Promise<void> {
    const { xmlContent, parsed } = await this.readUtf8AndParse(filePath);
    const state = { changed: false };
    const updated = removeDesignerFormFromOwnerInParsed(parsed, formName, state);
    if (!state.changed) {
      return;
    }
    await this.saveParsedWithBackup(
      filePath,
      xmlContent,
      updated,
      `Removed form '${formName}' references from ${filePath}`
    );
  }

  /**
   * Read UTF-8 XML and parse with the same error semantics as {@link readProperties} / {@link writeProperties}
   * (missing file, empty content, invalid XML).
   */
  private static async readUtf8AndParse(filePath: string): Promise<{ xmlContent: string; parsed: unknown }> {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    let xmlContent: string;
    try {
      xmlContent = await fs.promises.readFile(filePath, 'utf-8');
    } catch (readError) {
      throw new Error(
        `Unable to read XML file. ${readError instanceof Error ? readError.message : String(readError)}`
      );
    }
    if (!xmlContent || xmlContent.trim() === '') {
      throw new Error(`XML file is empty or invalid: ${filePath}`);
    }
    let parsed: unknown;
    try {
      parsed = xmlParser.parse(xmlContent);
    } catch (parseError) {
      const errorMsg = parseError instanceof Error ? parseError.message : String(parseError);
      Logger.error(`XML parsing failed for ${filePath}`, parseError);
      throw new Error(
        `Invalid XML structure in file. The file may be corrupted or not a valid XML document. ${errorMsg}`
      );
    }
    return { xmlContent, parsed };
  }

  private static async saveParsedWithBackup(
    filePath: string,
    xmlContent: string,
    updatedParsed: unknown,
    logMessage: string
  ): Promise<void> {
    let xmlString: string;
    try {
      xmlString = buildXmlString(updatedParsed);
    } catch (buildError) {
      Logger.error(`Failed to build XML for ${filePath}`, buildError);
      throw new Error(
        `Failed to generate XML content. ${buildError instanceof Error ? buildError.message : String(buildError)}`
      );
    }
    await writeUtf8FileWithBackup(filePath, xmlContent, xmlString);
    Logger.info(logMessage);
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
${ROOT_TAGS_WITHOUT_CHILDOBJECTS.has(rootTag) ? '' : '\t\t<ChildObjects/>\n'}\t</${rootTag}>
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
    return xmlGenerateSimpleUuid();
  }

  private static escapeXml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
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
    changedKeys?: string[],
    options?: WriteNestedElementOptions
  ): string {
    return buildUpdatedNestedXmlImpl(
      xmlContent,
      elementType,
      elementName,
      properties,
      changedKeys,
      options
    );
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
      changedKeys?: string[],
      options?: WriteNestedElementOptions
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
          xmlString = buildUpdatedNestedXmlImpl(
            xmlContent,
            elementType,
            elementName,
            properties,
            changedKeys,
            options
          );
        } catch (buildError) {
          Logger.error(`Failed to build XML for ${filePath}`, buildError);
          throw new Error(
            `Failed to generate XML content. ${buildError instanceof Error ? buildError.message : String(buildError)}`
          );
        }

        await writeUtf8FileWithBackup(filePath, xmlContent, xmlString);
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

}
