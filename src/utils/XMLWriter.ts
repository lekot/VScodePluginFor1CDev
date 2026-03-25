import * as fs from 'fs';
import { Logger } from './logger';
import { xmlParser } from './xml/xmlCore';
import { buildXmlString, writeUtf8FileWithBackup } from './xml/xmlFileIo';
import { generateSimpleUuid as xmlGenerateSimpleUuid } from './xml/xmlHelpers';
import { extractProperties, updatePropertiesInStructure } from './xml/xmlPropertiesService';
import {
  getDefaultPropertiesForRootTag,
  getDefaultPropertiesForNestedElement,
} from '../constants/metadataDefaultValues';
import { MetadataType } from '../models/treeNode';
import { injectInternalInfoIntoMetadataXml } from '../services/internalInfoGenerator';
import { normalizeMetaDataObjectRoot } from '../services/metaDataObjectRootNormalizer';
import { buildTabularSectionInternalInfoObject } from '../services/internalInfoGenerator';

/**
 * Root metadata object tags in a single-object Designer XML (same coverage as elementOperations TOP_LEVEL_TYPES)
 * so ChildObjects / Properties mutations hit the correct node.
 */
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
  MetadataType.SessionParameter,
  MetadataType.FilterCriterion,
  MetadataType.ScheduledJob,
  MetadataType.FunctionalOption,
  MetadataType.FunctionalOptionsParameter,
  MetadataType.SettingsStorage,
  MetadataType.EventSubscription,
  MetadataType.CommonModule,
  MetadataType.CommandGroup,
  MetadataType.Role,
  MetadataType.Interface,
  MetadataType.Style,
  MetadataType.WebService,
  MetadataType.HTTPService,
  MetadataType.IntegrationService,
  MetadataType.Subsystem,
  MetadataType.ExchangePlan,
  MetadataType.DocumentJournal,
  MetadataType.DefinedType,
  MetadataType.CommonAttribute,
  MetadataType.CommonCommand,
  MetadataType.CommonForm,
  MetadataType.CommonPicture,
  MetadataType.CommonTemplate,
  MetadataType.DocumentNumerator,
  MetadataType.Language,
  MetadataType.WSReference,
  MetadataType.XDTOPackage,
  MetadataType.StyleItem,
]);

/**
 * Root metadata tags that omit ChildObjects in Designer XML (docs/1c-config-objects-spec.md).
 * Не подставлять искусственно ChildObjects при добавлении вложенных элементов — иначе ibcmd / конфигуратор отвергнут файл.
 */
export const ROOT_TAGS_WITHOUT_CHILDOBJECTS = new Set<string>([
  'CommonModule',
  'Role',
  'SessionParameter',
  'FunctionalOption',
  'FunctionalOptionsParameter',
  'CommandGroup',
  'Interface',
  // Стиль оформления: в ibcmd при пустом ChildObjects — «ожидаемое Style»; в выгрузке нет контейнера ChildObjects.
  'Style',
  'EventSubscription',
  'DefinedType',
  'Language',
  'CommonPicture',
  'CommonAttribute',
  'CommonForm',
  /** Встроенная форма объекта: в ibcmd ожидается последовательность без пустого ChildObjects (см. docs/1c-config-objects-spec.md §6.3). */
  'Form',
  'WSReference',
  'StyleItem',
  'XDTOPackage',
  // Только Properties, без ChildObjects (spec; иначе ibcmd config import падает).
  'DocumentNumerator',
  'ScheduledJob',
  'Constant',
]);

/**
 * Options for {@link XMLWriter.writeNestedElementProperties}.
 * When `scopedTabularSectionName` is set with `elementType === 'Attribute'`, name-based updates apply only
 * to columns under that tabular section (not top-level attributes or other sections).
 */
export type WriteNestedElementOptions = {
  scopedTabularSectionName?: string;
};

/** Internal: Attribute nested write scoped to one tabular section by `<Name>`. */
type NestedAttributeScopeState = {
  scopedTabularSectionName: string;
  insideMatchingTabularSection: boolean;
};

/** Properties that may store a reference like `Catalog.MyCat.Form.MyForm`. */
const DEFAULT_FORM_REF_PROPERTY_KEYS = [
  'DefaultObjectForm',
  'DefaultFolderForm',
  'DefaultListForm',
  'DefaultChoiceForm',
  'DefaultFolderChoiceForm',
  'AuxiliaryObjectForm',
  'AuxiliaryFolderForm',
  'AuxiliaryListForm',
  'AuxiliaryChoiceForm',
  'AuxiliaryFolderChoiceForm',
] as const;

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
    const xmlContent = await fs.promises.readFile(filePath, 'utf-8');
    const parsed = xmlParser.parse(xmlContent);
    const updated = this.addNestedElementInStructure(
      parsed,
      elementType,
      elementName,
      minimalProperties ?? {},
      parentRootType,
      parentObjectName
    );
    const xmlString = buildXmlString(updated);
    await writeUtf8FileWithBackup(filePath, xmlContent, xmlString);
    Logger.info(`Added ${elementType} '${elementName}' to ${filePath}`);
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
    const xmlContent = await fs.promises.readFile(filePath, 'utf-8');
    const parsed = xmlParser.parse(xmlContent);
    const updated = this.addAttributeToTabularSectionInParsed(
      parsed,
      tabularSectionName,
      columnName,
      parentRootType,
      parentObjectName
    );
    const xmlString = buildXmlString(updated);
    await writeUtf8FileWithBackup(filePath, xmlContent, xmlString);
    Logger.info(`Added column '${columnName}' to tabular section '${tabularSectionName}' in ${filePath}`);
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
    const xmlContent = await fs.promises.readFile(filePath, 'utf-8');
    const parsed = xmlParser.parse(xmlContent);
    const updated = this.removeAttributeFromTabularSectionInParsed(parsed, tabularSectionName, columnName);
    const xmlString = buildXmlString(updated);
    await writeUtf8FileWithBackup(filePath, xmlContent, xmlString);
    Logger.info(`Removed column '${columnName}' from tabular section '${tabularSectionName}' in ${filePath}`);
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
    const xmlContent = await fs.promises.readFile(filePath, 'utf-8');
    const parsed = xmlParser.parse(xmlContent);
    const updated = this.duplicateAttributeInTabularSectionInParsed(
      parsed,
      tabularSectionName,
      sourceColumnName,
      newColumnName
    );
    const xmlString = buildXmlString(updated);
    await writeUtf8FileWithBackup(filePath, xmlContent, xmlString);
    Logger.info(
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
    const xmlContent = await fs.promises.readFile(filePath, 'utf-8');
    const parsed = xmlParser.parse(xmlContent);
    const updated = this.removeNestedElementInStructure(parsed, elementType, elementName);
    const xmlString = buildXmlString(updated);
    await writeUtf8FileWithBackup(filePath, xmlContent, xmlString);
    Logger.info(`Removed ${elementType} '${elementName}' from ${filePath}`);
  }

  /**
   * Adds `<Form>formName</Form>` to the owner metadata object's ChildObjects (Designer).
   */
  static async addDesignerFormReferenceToOwnerMetadata(filePath: string, formName: string): Promise<void> {
    const xmlContent = await fs.promises.readFile(filePath, 'utf-8');
    const parsed = xmlParser.parse(xmlContent);
    const state = { changed: false };
    const updated = this.addDesignerFormReferenceInOwnerParsed(parsed, formName, state);
    if (!state.changed) {
      return;
    }
    await this.persistParsedXmlMutation(filePath, xmlContent, updated);
    Logger.info(`Registered form '${formName}' in ChildObjects of ${filePath}`);
  }

  /**
   * Removes the form from ChildObjects and clears Default*Form / Auxiliary*Form properties
   * whose value ends with `.Form.<formName>`.
   */
  static async removeDesignerFormFromOwnerMetadata(filePath: string, formName: string): Promise<void> {
    const xmlContent = await fs.promises.readFile(filePath, 'utf-8');
    const parsed = xmlParser.parse(xmlContent);
    const state = { changed: false };
    const updated = this.removeDesignerFormFromOwnerParsed(parsed, formName, state);
    if (!state.changed) {
      return;
    }
    await this.persistParsedXmlMutation(filePath, xmlContent, updated);
    Logger.info(`Removed form '${formName}' references from ${filePath}`);
  }

  private static async persistParsedXmlMutation(
    filePath: string,
    originalXml: string,
    updatedParsed: unknown
  ): Promise<void> {
    await writeUtf8FileWithBackup(filePath, originalXml, buildXmlString(updatedParsed));
  }

  private static extractScalarXmlText(value: unknown): string {
    if (typeof value === 'string') {
      return value;
    }
    if (value && typeof value === 'object' && !Array.isArray(value) && '#text' in value) {
      return String((value as Record<string, unknown>)['#text']);
    }
    if (Array.isArray(value) && value.length > 0) {
      const first = value[0];
      if (typeof first === 'string') {
        return first;
      }
      if (first && typeof first === 'object' && '#text' in first) {
        return String((first as Record<string, unknown>)['#text']);
      }
    }
    return '';
  }

  private static formNamesFromChildObjectsFormField(raw: unknown): string[] {
    if (raw === undefined || raw === null || raw === '') {
      return [];
    }
    if (typeof raw === 'string') {
      return [raw];
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && '#text' in raw) {
      return [String((raw as Record<string, unknown>)['#text'])];
    }
    if (Array.isArray(raw)) {
      const res: string[] = [];
      for (const x of raw) {
        if (typeof x === 'string') {
          res.push(x);
        } else if (x && typeof x === 'object' && '#text' in x) {
          res.push(String((x as Record<string, unknown>)['#text']));
        }
      }
      return res;
    }
    return [];
  }

  private static appendFormToChildObjectsInner(
    innerObj: Record<string, unknown>,
    formName: string
  ): { inner: Record<string, unknown>; changed: boolean } {
    const names = this.formNamesFromChildObjectsFormField(innerObj.Form);
    if (names.includes(formName)) {
      return { inner: innerObj, changed: false };
    }
    const next = { ...innerObj };
    names.push(formName);
    next.Form = names.length === 1 ? names[0] : names;
    return { inner: next, changed: true };
  }

  private static stripFormEntryFromChildObjectsInner(
    innerObj: Record<string, unknown>,
    formName: string
  ): { inner: Record<string, unknown>; changed: boolean } {
    if (!('Form' in innerObj)) {
      return { inner: innerObj, changed: false };
    }
    const names = this.formNamesFromChildObjectsFormField(innerObj.Form);
    const filtered = names.filter((n) => n !== formName);
    if (filtered.length === names.length) {
      return { inner: innerObj, changed: false };
    }
    const next = { ...innerObj };
    if (filtered.length === 0) {
      delete next.Form;
    } else if (filtered.length === 1) {
      next.Form = filtered[0];
    } else {
      next.Form = filtered;
    }
    return { inner: next, changed: true };
  }

  private static childObjectsArrayToRecord(childObjects: unknown[]): Record<string, unknown> {
    const innerObj: Record<string, unknown> = {};
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
    return innerObj;
  }

  private static normalizeOwnerChildObjectsRecord(elemObj: Record<string, unknown>): Record<string, unknown> {
    if (!('ChildObjects' in elemObj) || elemObj.ChildObjects === '' || elemObj.ChildObjects === undefined) {
      return {};
    }
    const co = elemObj.ChildObjects;
    if (Array.isArray(co)) {
      return this.childObjectsArrayToRecord(co);
    }
    if (typeof co === 'object') {
      return { ...(co as Record<string, unknown>) };
    }
    return {};
  }

  private static clearDefaultFormPropertyRefs(
    properties: unknown,
    formName: string,
    state: { changed: boolean }
  ): unknown {
    const suffix = `.Form.${formName}`;
    const clearObj = (o: Record<string, unknown>): Record<string, unknown> => {
      const out = { ...o };
      for (const key of DEFAULT_FORM_REF_PROPERTY_KEYS) {
        if (!(key in out)) {
          continue;
        }
        const text = this.extractScalarXmlText(out[key]);
        if (text && text.endsWith(suffix)) {
          out[key] = '';
          state.changed = true;
        }
      }
      return out;
    };
    if (!properties || typeof properties !== 'object') {
      return properties;
    }
    if (Array.isArray(properties)) {
      return properties.map((p) =>
        p && typeof p === 'object' ? clearObj(p as Record<string, unknown>) : p
      );
    }
    return clearObj(properties as Record<string, unknown>);
  }

  private static addDesignerFormReferenceInOwnerParsed(
    parsed: unknown,
    formName: string,
    state: { changed: boolean }
  ): unknown {
    if (!parsed || typeof parsed !== 'object') {
      return parsed;
    }
    if (Array.isArray(parsed)) {
      return parsed.map((item) => this.addDesignerFormReferenceInOwnerParsed(item, formName, state));
    }
    const obj = parsed as Record<string, unknown>;
    const result: Record<string, unknown> = { ...obj };

    for (const typeName of TOP_LEVEL_TYPES) {
      if (typeName in obj) {
        const elementContent = obj[typeName as string];
        if (elementContent && typeof elementContent === 'object' && !Array.isArray(elementContent)) {
          const elemObj = elementContent as Record<string, unknown>;
          const next: Record<string, unknown> = { ...elemObj };
          const innerObj = this.normalizeOwnerChildObjectsRecord(elemObj);
          const { inner, changed } = this.appendFormToChildObjectsInner(innerObj, formName);
          if (changed) {
            state.changed = true;
          }
          next.ChildObjects = inner;
          result[typeName as string] = next;
          return result;
        }
      }
    }

    for (const [key, value] of Object.entries(obj)) {
      if (Array.isArray(value)) {
        result[key] = value.map((v) => this.addDesignerFormReferenceInOwnerParsed(v, formName, state));
      } else if (value && typeof value === 'object') {
        result[key] = this.addDesignerFormReferenceInOwnerParsed(value, formName, state);
      }
    }
    return result;
  }

  private static removeDesignerFormFromOwnerParsed(
    parsed: unknown,
    formName: string,
    state: { changed: boolean }
  ): unknown {
    if (!parsed || typeof parsed !== 'object') {
      return parsed;
    }
    if (Array.isArray(parsed)) {
      return parsed.map((item) => this.removeDesignerFormFromOwnerParsed(item, formName, state));
    }
    const obj = parsed as Record<string, unknown>;
    const result: Record<string, unknown> = { ...obj };

    for (const typeName of TOP_LEVEL_TYPES) {
      if (typeName in obj) {
        const elementContent = obj[typeName as string];
        if (elementContent && typeof elementContent === 'object' && !Array.isArray(elementContent)) {
          const elemObj = elementContent as Record<string, unknown>;
          const next: Record<string, unknown> = { ...elemObj };

          if ('Properties' in elemObj) {
            next.Properties = this.clearDefaultFormPropertyRefs(elemObj.Properties, formName, state);
          }

          if ('ChildObjects' in elemObj && elemObj.ChildObjects !== '' && elemObj.ChildObjects !== undefined) {
            const innerObj = this.normalizeOwnerChildObjectsRecord(elemObj);
            const { inner, changed } = this.stripFormEntryFromChildObjectsInner(innerObj, formName);
            if (changed) {
              state.changed = true;
            }
            next.ChildObjects = inner;
          }

          result[typeName as string] = next;
          return result;
        }
      }
    }

    for (const [key, value] of Object.entries(obj)) {
      if (Array.isArray(value)) {
        result[key] = value.map((v) => this.removeDesignerFormFromOwnerParsed(v, formName, state));
      } else if (value && typeof value === 'object') {
        result[key] = this.removeDesignerFormFromOwnerParsed(value, formName, state);
      }
    }
    return result;
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
          // Только типы, у которых в выгрузке бывает ChildObjects (Catalog, Document, …). Не Role/CommonModule/…
          if (!ROOT_TAGS_WITHOUT_CHILDOBJECTS.has(String(typeName))) {
            const unwrapped = (newBlock as Record<string, unknown>)[elementType];
            if (unwrapped !== undefined && unwrapped !== null) {
              const innerObj: Record<string, unknown> = {
                [elementType]: [unwrapped],
              };
              result[typeName as string] = { ...elemObj, ChildObjects: innerObj };
              return result;
            }
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

  private static unwrapSingleTabularSection(mo: Record<string, unknown>): Record<string, unknown> | null {
    const ts = mo.TabularSection;
    if (ts == null) {
      return null;
    }
    if (Array.isArray(ts)) {
      return ts[0] as Record<string, unknown>;
    }
    return ts as Record<string, unknown>;
  }

  private static tabularSectionNameFromBlock(ts: Record<string, unknown>): string {
    const props = ts.Properties;
    if (props && !Array.isArray(props) && typeof props === 'object') {
      const n = (props as Record<string, unknown>).Name;
      if (typeof n === 'string') {
        return n;
      }
    }
    if (Array.isArray(props)) {
      const n = this.extractNameFromElementArray(props as unknown[]);
      if (n) {
        return n;
      }
    }
    return '';
  }

  private static insertAttributeIntoTabularSectionBlock(
    tsElem: Record<string, unknown>,
    attributeInnerContent: unknown
  ): void {
    const co = tsElem.ChildObjects;
    if (
      co == null ||
      co === '' ||
      (typeof co === 'object' && !Array.isArray(co) && Object.keys(co as object).length === 0)
    ) {
      tsElem.ChildObjects = { Attribute: [attributeInnerContent] };
      return;
    }
    if (typeof co !== 'object' || Array.isArray(co)) {
      tsElem.ChildObjects = { Attribute: [attributeInnerContent] };
      return;
    }
    const childObj = { ...(co as Record<string, unknown>) };
    const existing = childObj.Attribute;
    const arr = Array.isArray(existing) ? [...existing] : existing !== undefined && existing !== null ? [existing] : [];
    arr.push(attributeInnerContent);
    childObj.Attribute = arr;
    tsElem.ChildObjects = childObj;
  }

  private static removeAttributeFromTabularSectionBlock(tsElem: Record<string, unknown>, columnName: string): boolean {
    const co = tsElem.ChildObjects;
    if (!co || typeof co !== 'object' || Array.isArray(co)) {
      return false;
    }
    const childObj = co as Record<string, unknown>;
    if (!('Attribute' in childObj)) {
      return false;
    }
    const inner = childObj.Attribute;
    const items = Array.isArray(inner) ? inner : inner != null ? [inner] : [];
    const filtered = items.filter((item) => this.extractNameFromNestedElement(item) !== columnName);
    if (filtered.length === items.length) {
      return false;
    }
    const next = { ...childObj };
    if (filtered.length === 0) {
      delete next.Attribute;
    } else {
      next.Attribute = filtered;
    }
    tsElem.ChildObjects = Object.keys(next).length === 0 ? {} : next;
    return true;
  }

  private static addAttributeToTabularSectionInParsed(
    parsed: unknown,
    tabularSectionName: string,
    columnName: string,
    parentRootType: MetadataType,
    parentObjectName: string
  ): unknown {
    const newBlock = this.buildMinimalNestedElement(
      'Attribute',
      columnName,
      {},
      parentRootType,
      parentObjectName
    );
    const unwrapped = (newBlock as Record<string, unknown>).Attribute;

    if (!parsed || typeof parsed !== 'object') {
      return parsed;
    }
    const root = { ...(parsed as Record<string, unknown>) };
    const moKey = 'MetaDataObject' in root ? 'MetaDataObject' : null;
    const mo = (moKey ? (root.MetaDataObject as Record<string, unknown>) : root) as Record<string, unknown>;
    if (!mo || typeof mo !== 'object') {
      return parsed;
    }

    const moCopy = { ...mo };
    const dedicatedTs = this.unwrapSingleTabularSection(moCopy);
    if (dedicatedTs) {
      const tsName = this.tabularSectionNameFromBlock(dedicatedTs);
      if (!tsName || tsName === tabularSectionName) {
        const tsMut = { ...dedicatedTs };
        this.insertAttributeIntoTabularSectionBlock(tsMut, unwrapped);
        if (moKey) {
          const inner = {
            ...moCopy,
            TabularSection: Array.isArray(moCopy.TabularSection) ? [tsMut] : tsMut,
          };
          return { ...root, MetaDataObject: inner };
        }
        return { ...root, TabularSection: tsMut };
      }
    }

    for (const typeName of TOP_LEVEL_TYPES) {
      if (!(typeName in moCopy)) {
        continue;
      }
      const elem = moCopy[typeName as string] as Record<string, unknown>;
      if (!elem || typeof elem !== 'object' || Array.isArray(elem)) {
        continue;
      }
      const childObjects = elem.ChildObjects;
      if (!childObjects || typeof childObjects !== 'object' || Array.isArray(childObjects)) {
        continue;
      }
      const co = { ...(childObjects as Record<string, unknown>) };
      if (!co.TabularSection) {
        continue;
      }

      const tsRaw = co.TabularSection;
      const tsList = Array.isArray(tsRaw) ? [...tsRaw] : [tsRaw];
      let hit = false;
      const updated = tsList.map((ts) => {
        if (!ts || typeof ts !== 'object') {
          return ts;
        }
        const tsRec = ts as Record<string, unknown>;
        if (this.tabularSectionNameFromBlock(tsRec) !== tabularSectionName) {
          return tsRec;
        }
        hit = true;
        const tsMut = { ...tsRec };
        this.insertAttributeIntoTabularSectionBlock(tsMut, unwrapped);
        return tsMut;
      });
      if (!hit) {
        continue;
      }

      co.TabularSection = updated.length === 1 && !Array.isArray(tsRaw) ? updated[0] : updated;
      const newElem = { ...elem, ChildObjects: co };
      const newMo = { ...moCopy, [typeName as string]: newElem };
      if (moKey) {
        return { ...root, MetaDataObject: newMo };
      }
      return { ...root, ...newMo };
    }

    throw new Error(`Табличная часть «${tabularSectionName}» не найдена в XML.`);
  }

  private static duplicateAttributeInTabularSectionInParsed(
    parsed: unknown,
    tabularSectionName: string,
    sourceColumnName: string,
    newColumnName: string
  ): unknown {
    if (!parsed || typeof parsed !== 'object') {
      return parsed;
    }
    const root = { ...(parsed as Record<string, unknown>) };
    const moKey = 'MetaDataObject' in root ? 'MetaDataObject' : null;
    const mo = (moKey ? (root.MetaDataObject as Record<string, unknown>) : root) as Record<string, unknown>;
    if (!mo || typeof mo !== 'object') {
      return parsed;
    }

    const moCopy = { ...mo };
    const dedicatedTs = this.unwrapSingleTabularSection(moCopy);
    if (dedicatedTs) {
      const tsName = this.tabularSectionNameFromBlock(dedicatedTs);
      if (!tsName || tsName === tabularSectionName) {
        const tsMut = { ...dedicatedTs };
        this.insertDuplicatedTabularColumnIntoBlock(tsMut, sourceColumnName, newColumnName);
        if (moKey) {
          const inner = {
            ...moCopy,
            TabularSection: Array.isArray(moCopy.TabularSection) ? [tsMut] : tsMut,
          };
          return { ...root, MetaDataObject: inner };
        }
        return { ...root, TabularSection: tsMut };
      }
    }

    for (const typeName of TOP_LEVEL_TYPES) {
      if (!(typeName in moCopy)) {
        continue;
      }
      const elem = moCopy[typeName as string] as Record<string, unknown>;
      if (!elem || typeof elem !== 'object' || Array.isArray(elem)) {
        continue;
      }
      const childObjects = elem.ChildObjects;
      if (!childObjects || typeof childObjects !== 'object' || Array.isArray(childObjects)) {
        continue;
      }
      const co = { ...(childObjects as Record<string, unknown>) };
      if (!co.TabularSection) {
        continue;
      }

      const tsRaw = co.TabularSection;
      const tsList = Array.isArray(tsRaw) ? [...tsRaw] : [tsRaw];
      let hit = false;
      const updated = tsList.map((ts) => {
        if (!ts || typeof ts !== 'object') {
          return ts;
        }
        const tsRec = ts as Record<string, unknown>;
        if (this.tabularSectionNameFromBlock(tsRec) !== tabularSectionName) {
          return tsRec;
        }
        hit = true;
        const tsMut = { ...tsRec };
        this.insertDuplicatedTabularColumnIntoBlock(tsMut, sourceColumnName, newColumnName);
        return tsMut;
      });
      if (!hit) {
        continue;
      }

      co.TabularSection = updated.length === 1 && !Array.isArray(tsRaw) ? updated[0] : updated;
      const newElem = { ...elem, ChildObjects: co };
      const newMo = { ...moCopy, [typeName as string]: newElem };
      if (moKey) {
        return { ...root, MetaDataObject: newMo };
      }
      return { ...root, ...newMo };
    }

    throw new Error(`Табличная часть «${tabularSectionName}» не найдена в XML.`);
  }

  private static getAttributeItemsFromTsBlock(tsElem: Record<string, unknown>): Record<string, unknown>[] {
    const co = tsElem.ChildObjects;
    if (!co || typeof co !== 'object' || Array.isArray(co)) {
      return [];
    }
    const childObj = co as Record<string, unknown>;
    if (!('Attribute' in childObj)) {
      return [];
    }
    const inner = childObj.Attribute;
    const items = Array.isArray(inner) ? inner : inner != null ? [inner] : [];
    return items.filter(
      (x): x is Record<string, unknown> => x != null && typeof x === 'object' && !Array.isArray(x)
    );
  }

  private static findAttributeItemInTsBlock(
    tsElem: Record<string, unknown>,
    columnName: string
  ): Record<string, unknown> | null {
    for (const item of this.getAttributeItemsFromTsBlock(tsElem)) {
      if (this.extractNameFromNestedElement(item) === columnName) {
        return item;
      }
    }
    return null;
  }

  private static tsBlockHasColumnName(tsElem: Record<string, unknown>, name: string): boolean {
    return this.getAttributeItemsFromTsBlock(tsElem).some(
      (item) => this.extractNameFromNestedElement(item) === name
    );
  }

  private static cloneTabularColumnAttributeForDuplicate(
    sourceItem: Record<string, unknown>,
    sourceColumnName: string,
    newColumnName: string
  ): Record<string, unknown> {
    const cloned = JSON.parse(JSON.stringify(sourceItem)) as Record<string, unknown>;
    cloned['@_uuid'] = this.generateSimpleUuid();
    const props = cloned.Properties;
    if (props && typeof props === 'object' && !Array.isArray(props)) {
      const po = props as Record<string, unknown>;
      po.Name = [{ '#text': newColumnName }];
      this.tryAlignSynonymWithNewColumnName(po, sourceColumnName, newColumnName);
    }
    return cloned;
  }

  /**
   * If the parsed synonym text still matches the old column name, set it to the new name (Designer-like duplicate).
   * Custom synonyms that differ from the technical name are left unchanged.
   */
  private static tryAlignSynonymWithNewColumnName(
    props: Record<string, unknown>,
    previousColumnName: string,
    newName: string
  ): void {
    const syn = props.Synonym;
    if (syn == null) {
      return;
    }
    if (typeof syn === 'string' && syn.trim() === '') {
      return;
    }
    if (!Array.isArray(syn) || syn.length === 0) {
      return;
    }
    const first = syn[0];
    if (!first || typeof first !== 'object' || Array.isArray(first)) {
      return;
    }
    const v8item = (first as Record<string, unknown>)['v8:item'];
    if (!Array.isArray(v8item) || v8item.length === 0) {
      return;
    }
    const row = v8item[0];
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      return;
    }
    const content = (row as Record<string, unknown>)['v8:content'];
    if (!Array.isArray(content) || content.length === 0) {
      return;
    }
    const cell = content[0];
    if (cell && typeof cell === 'object' && !Array.isArray(cell) && '#text' in cell) {
      const cur = String((cell as Record<string, unknown>)['#text'] ?? '');
      if (cur === previousColumnName) {
        (cell as Record<string, unknown>)['#text'] = newName;
      }
    }
  }

  private static insertDuplicatedTabularColumnIntoBlock(
    tsMut: Record<string, unknown>,
    sourceColumnName: string,
    newColumnName: string
  ): void {
    const sourceItem = this.findAttributeItemInTsBlock(tsMut, sourceColumnName);
    if (!sourceItem) {
      throw new Error(`Колонка «${sourceColumnName}» не найдена в табличной части.`);
    }
    if (this.tsBlockHasColumnName(tsMut, newColumnName)) {
      throw new Error(`Колонка «${newColumnName}» уже существует.`);
    }
    const cloned = this.cloneTabularColumnAttributeForDuplicate(sourceItem, sourceColumnName, newColumnName);
    this.insertAttributeIntoTabularSectionBlock(tsMut, cloned);
  }

  private static removeAttributeFromTabularSectionInParsed(
    parsed: unknown,
    tabularSectionName: string,
    columnName: string
  ): unknown {
    if (!parsed || typeof parsed !== 'object') {
      return parsed;
    }
    const root = { ...(parsed as Record<string, unknown>) };
    const moKey = 'MetaDataObject' in root ? 'MetaDataObject' : null;
    const mo = (moKey ? (root.MetaDataObject as Record<string, unknown>) : root) as Record<string, unknown>;
    if (!mo || typeof mo !== 'object') {
      return parsed;
    }

    const moCopy = { ...mo };
    const dedicatedTs = this.unwrapSingleTabularSection(moCopy);
    if (dedicatedTs) {
      const tsName = this.tabularSectionNameFromBlock(dedicatedTs);
      if (!tsName || tsName === tabularSectionName) {
        const tsMut = { ...dedicatedTs };
        const ok = this.removeAttributeFromTabularSectionBlock(tsMut, columnName);
        if (ok) {
          if (moKey) {
            const inner = {
              ...moCopy,
              TabularSection: Array.isArray(moCopy.TabularSection) ? [tsMut] : tsMut,
            };
            return { ...root, MetaDataObject: inner };
          }
          return { ...root, TabularSection: tsMut };
        }
      }
    }

    for (const typeName of TOP_LEVEL_TYPES) {
      if (!(typeName in moCopy)) {
        continue;
      }
      const elem = moCopy[typeName as string] as Record<string, unknown>;
      if (!elem || typeof elem !== 'object' || Array.isArray(elem)) {
        continue;
      }
      const childObjects = elem.ChildObjects;
      if (!childObjects || typeof childObjects !== 'object' || Array.isArray(childObjects)) {
        continue;
      }
      const co = { ...(childObjects as Record<string, unknown>) };
      if (!co.TabularSection) {
        continue;
      }
      const tsRaw = co.TabularSection;
      const tsList = Array.isArray(tsRaw) ? [...tsRaw] : [tsRaw];
      let hit = false;
      const updated = tsList.map((ts) => {
        if (!ts || typeof ts !== 'object') {
          return ts;
        }
        const tsRec = ts as Record<string, unknown>;
        if (this.tabularSectionNameFromBlock(tsRec) !== tabularSectionName) {
          return tsRec;
        }
        hit = true;
        const tsMut = { ...tsRec };
        this.removeAttributeFromTabularSectionBlock(tsMut, columnName);
        return tsMut;
      });
      if (!hit) {
        continue;
      }
      co.TabularSection = updated.length === 1 && !Array.isArray(tsRaw) ? updated[0] : updated;
      const newElem = { ...elem, ChildObjects: co };
      const newMo = { ...moCopy, [typeName as string]: newElem };
      if (moKey) {
        return { ...root, MetaDataObject: newMo };
      }
      return { ...root, ...newMo };
    }

    throw new Error(`Колонка «${columnName}» в табличной части «${tabularSectionName}» не найдена в XML.`);
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
    changedKeys?: string[],
    options?: WriteNestedElementOptions
  ): string {
    const parsed = xmlParser.parse(xmlContent);
    const scopeState = this.buildNestedAttributeScopeState(elementType, options);
    let updated = this.updateNestedElementInStructure(
      parsed,
      elementType,
      elementName,
      properties,
      changedKeys,
      scopeState
    );
    // Parser may return root as array of one element; builder expects single object
    if (Array.isArray(updated) && updated.length === 1) {
      updated = updated[0];
    }
    return buildXmlString(updated);
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
          xmlString = this.buildUpdatedNestedXml(
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

  private static buildNestedAttributeScopeState(
    elementType: string,
    options?: WriteNestedElementOptions
  ): NestedAttributeScopeState | undefined {
    const n = options?.scopedTabularSectionName?.trim();
    if (!n || elementType !== 'Attribute') {
      return undefined;
    }
    return { scopedTabularSectionName: n, insideMatchingTabularSection: false };
  }

  private static matchesTabularSectionXmlKey(key: string): boolean {
    return key === 'TabularSection' || key.endsWith(':TabularSection');
  }

  private static matchesNestedMetadataElementKey(key: string, elementType: string): boolean {
    return key === elementType || key.endsWith(':' + elementType);
  }

  /**
   * Designer sometimes stores `Attribute` / `TabularSection` directly under a parent object (not only under ChildObjects).
   * Normalize to the wrapped shape expected by {@link updateNestedElementArray}.
   */
  private static applyDirectNestedElementKeyUpdate(
    key: string,
    value: unknown,
    elementType: string,
    elementName: string,
    properties: Record<string, unknown>,
    changedKeys: string[] | undefined,
    scopeState?: NestedAttributeScopeState
  ): unknown {
    const wasArray = Array.isArray(value);
    const raw = wasArray ? value : value != null ? [value] : [];
    const elementsArray = raw.map((x: unknown) => ({ [key]: [x] }));
    const updated = this.updateNestedElementArray(
      elementsArray,
      elementType,
      elementName,
      properties,
      changedKeys,
      scopeState
    );
    const flat = updated.flatMap((it) => ((it as Record<string, unknown>)[key] as unknown[]) || []);
    return wasArray ? flat : flat[0] ?? flat;
  }

  private static isScopedTabularAttributeMode(
    elementType: string,
    scopeState: NestedAttributeScopeState | undefined
  ): scopeState is NestedAttributeScopeState {
    return elementType === 'Attribute' && scopeState !== undefined;
  }

  private static extractPlainTextFromXmlScalar(val: unknown): string {
    if (typeof val === 'string') {
      return val;
    }
    if (Array.isArray(val) && val.length > 0) {
      const first = val[0];
      if (first && typeof first === 'object' && '#text' in first) {
        return String((first as Record<string, unknown>)['#text']);
      }
    }
    if (val && typeof val === 'object' && '#text' in (val as object)) {
      return String((val as Record<string, unknown>)['#text']);
    }
    return '';
  }

  private static extractNameFromMetadataPropertiesItem(item: unknown): string {
    if (!item || typeof item !== 'object') {
      return '';
    }
    const o = item as Record<string, unknown>;
    const nameKey = 'Name' in o ? 'Name' : Object.keys(o).find((k) => k === 'Name' || k.endsWith(':Name'));
    if (!nameKey) {
      return '';
    }
    return this.extractPlainTextFromXmlScalar(o[nameKey]);
  }

  private static extractTabularSectionNameFromSectionObject(sectionObj: Record<string, unknown>): string {
    const props = sectionObj.Properties;
    if (props === undefined || props === null) {
      return '';
    }
    if (Array.isArray(props)) {
      for (const p of props) {
        const n = this.extractNameFromMetadataPropertiesItem(p);
        if (n) {
          return n;
        }
      }
      return '';
    }
    if (typeof props === 'object') {
      return this.extractNameFromMetadataPropertiesItem(props);
    }
    return '';
  }

  /** TabularSection node(s) under ChildObjects: parser may use a single object or an array. */
  private static mapTabularSectionValueForScopedAttribute(
    value: unknown,
    elementType: string,
    elementName: string,
    properties: Record<string, unknown>,
    changedKeys: string[] | undefined,
    scopeState: NestedAttributeScopeState
  ): unknown {
    if (Array.isArray(value)) {
      return value.map((sectionEl) =>
        this.updateTabularSectionNodeForScopedAttribute(
          sectionEl,
          elementType,
          elementName,
          properties,
          changedKeys,
          scopeState
        )
      );
    }
    if (value && typeof value === 'object') {
      return this.updateTabularSectionNodeForScopedAttribute(
        value,
        elementType,
        elementName,
        properties,
        changedKeys,
        scopeState
      );
    }
    return value;
  }

  /**
   * Apply nested element updates to a ChildObjects value (array or compressed object form from fast-xml-parser).
   */
  private static updateChildObjectsNestedValue(
    value: unknown,
    elementType: string,
    elementName: string,
    properties: Record<string, unknown>,
    changedKeys: string[] | undefined,
    scopeState?: NestedAttributeScopeState
  ): unknown {
    const innerHasElementType = (v: Record<string, unknown>) =>
      elementType in v || Object.keys(v).some((k) => k === elementType || k.endsWith(':' + elementType));

    if (Array.isArray(value)) {
      return this.updateNestedElementArray(
        value,
        elementType,
        elementName,
        properties,
        changedKeys,
        scopeState
      );
    }
    if (value && typeof value === 'object' && innerHasElementType(value as Record<string, unknown>)) {
      const inner = value as Record<string, unknown>;
      const metaKeys = Object.keys(inner).filter((k) => k !== ':@');
      const elementKey =
        elementType in inner
          ? elementType
          : Object.keys(inner).find((k) => k === elementType || k.endsWith(':' + elementType));
      if (!elementKey) {
        return this.updateNestedElementInStructure(
          value,
          elementType,
          elementName,
          properties,
          changedKeys,
          scopeState
        );
      }
      const onlyThisElementTypeMetadata =
        metaKeys.length === 1 &&
        (metaKeys[0] === elementKey || metaKeys[0].endsWith(':' + elementType));
      if (!onlyThisElementTypeMetadata) {
        return this.updateNestedElementInStructure(
          value,
          elementType,
          elementName,
          properties,
          changedKeys,
          scopeState
        );
      }
      const raw = inner[elementKey];
      const innerArr = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
      const elementsArray = innerArr.map((x: unknown) => ({ [elementKey]: [x] }));
      const updated = this.updateNestedElementArray(
        elementsArray,
        elementType,
        elementName,
        properties,
        changedKeys,
        scopeState
      );
      return {
        [elementKey]: updated.flatMap((it) => ((it as Record<string, unknown>)[elementKey] as unknown[]) || []),
      };
    }
    if (value !== null && value !== undefined && typeof value === 'object') {
      return this.updateNestedElementInStructure(
        value,
        elementType,
        elementName,
        properties,
        changedKeys,
        scopeState
      );
    }
    return value;
  }

  private static updateTabularSectionNodeForScopedAttribute(
    sectionEl: unknown,
    elementType: string,
    elementName: string,
    properties: Record<string, unknown>,
    changedKeys: string[] | undefined,
    scopeState: NestedAttributeScopeState
  ): unknown {
    if (!sectionEl || typeof sectionEl !== 'object') {
      return sectionEl;
    }
    const obj = sectionEl as Record<string, unknown>;
    const sectionName = this.extractTabularSectionNameFromSectionObject(obj);
    const childMatching = sectionName === scopeState.scopedTabularSectionName;
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key === ':@') {
        result[key] = value;
        continue;
      }
      if (key === 'ChildObjects' || key.endsWith(':ChildObjects')) {
        const next: NestedAttributeScopeState = {
          ...scopeState,
          insideMatchingTabularSection: childMatching,
        };
        result[key] = this.updateChildObjectsNestedValue(
          value,
          elementType,
          elementName,
          properties,
          changedKeys,
          next
        );
      } else {
        result[key] = this.updateNestedElementInStructure(
          value,
          elementType,
          elementName,
          properties,
          changedKeys,
          { ...scopeState, insideMatchingTabularSection: false }
        );
      }
    }
    return result;
  }

  private static updateNestedElementInStructure(
    parsed: unknown,
    elementType: string,
    elementName: string,
    properties: Record<string, unknown>,
    changedKeys?: string[],
    scopeState?: NestedAttributeScopeState
  ): unknown {
    if (!parsed || typeof parsed !== 'object') {
      return parsed;
    }

    const containerName =
      elementType === 'Attribute' || elementType === 'TabularSection'
        ? 'ChildObjects'
        : elementType + 's';
    const matchesContainer = (k: string) => k === containerName || k.endsWith(':' + containerName);

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

          if (
            this.matchesTabularSectionXmlKey(key) &&
            this.isScopedTabularAttributeMode(elementType, scopeState) &&
            value !== null &&
            value !== undefined &&
            (Array.isArray(value) || typeof value === 'object')
          ) {
            result[key] = this.mapTabularSectionValueForScopedAttribute(
              value,
              elementType,
              elementName,
              properties,
              changedKeys,
              scopeState
            );
            continue;
          }

          if (
            this.matchesNestedMetadataElementKey(key, elementType) &&
            value !== null &&
            value !== undefined &&
            (Array.isArray(value) || typeof value === 'object')
          ) {
            result[key] = this.applyDirectNestedElementKeyUpdate(
              key,
              value,
              elementType,
              elementName,
              properties,
              changedKeys,
              scopeState
            );
            continue;
          }

          if (matchesContainer(key)) {
            result[key] = this.updateChildObjectsNestedValue(
              value,
              elementType,
              elementName,
              properties,
              changedKeys,
              scopeState
            );
          } else if (Array.isArray(value)) {
            result[key] = this.updateNestedElementInStructure(
              value,
              elementType,
              elementName,
              properties,
              changedKeys,
              scopeState
            );
          } else if (value !== null && value !== undefined && typeof value === 'object') {
            result[key] = this.updateNestedElementInStructure(
              value,
              elementType,
              elementName,
              properties,
              changedKeys,
              scopeState
            );
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

      if (
        this.matchesTabularSectionXmlKey(key) &&
        this.isScopedTabularAttributeMode(elementType, scopeState) &&
        value !== null &&
        value !== undefined &&
        (Array.isArray(value) || typeof value === 'object')
      ) {
        result[key] = this.mapTabularSectionValueForScopedAttribute(
          value,
          elementType,
          elementName,
          properties,
          changedKeys,
          scopeState
        );
        continue;
      }

      if (
        this.matchesNestedMetadataElementKey(key, elementType) &&
        value !== null &&
        value !== undefined &&
        (Array.isArray(value) || typeof value === 'object')
      ) {
        result[key] = this.applyDirectNestedElementKeyUpdate(
          key,
          value,
          elementType,
          elementName,
          properties,
          changedKeys,
          scopeState
        );
        continue;
      }

      if (matchesContainer(key)) {
        result[key] = this.updateChildObjectsNestedValue(
          value,
          elementType,
          elementName,
          properties,
          changedKeys,
          scopeState
        );
      } else if (value !== null && value !== undefined && typeof value === 'object') {
        result[key] = this.updateNestedElementInStructure(
          value,
          elementType,
          elementName,
          properties,
          changedKeys,
          scopeState
        );
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
    changedKeys?: string[],
    scopeState?: NestedAttributeScopeState
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

        if (
          this.matchesTabularSectionXmlKey(key) &&
          this.isScopedTabularAttributeMode(elementType, scopeState) &&
          value !== null &&
          value !== undefined &&
          (Array.isArray(value) || typeof value === 'object')
        ) {
          result[key] = this.mapTabularSectionValueForScopedAttribute(
            value,
            elementType,
            elementName,
            properties,
            changedKeys,
            scopeState
          );
          continue;
        }

        if (matchesElementType(key) && Array.isArray(value)) {
          const elementData = this.extractNestedElementData(value);
          if (elementData.name === elementName) {
            if (this.isScopedTabularAttributeMode(elementType, scopeState) && !scopeState.insideMatchingTabularSection) {
              result[key] = value;
            } else {
              result[key] = this.updateNestedElementProperties(value, properties, changedKeys);
            }
          } else {
            result[key] = value;
          }
        } else if (typeof key === 'string' && key.startsWith('?')) {
          result[key] = value;
        } else if (value !== null && value !== undefined && typeof value === 'object') {
          result[key] = this.updateNestedElementInStructure(
            value,
            elementType,
            elementName,
            properties,
            changedKeys,
            scopeState
          );
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
          const typeParsed = xmlParser.parse(newVal.trim());
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
              const typeParsed = xmlParser.parse(newValue.trim());
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
