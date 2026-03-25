import * as fs from 'fs';
import { Logger } from './logger';
import { xmlParser } from './xml/xmlCore';
import { buildXmlString, writeUtf8FileWithBackup } from './xml/xmlFileIo';
import { generateSimpleUuid as xmlGenerateSimpleUuid } from './xml/xmlHelpers';
import { extractProperties, updatePropertiesInStructure } from './xml/xmlPropertiesService';
import {
  TOP_LEVEL_TYPES,
  ROOT_TAGS_WITHOUT_CHILDOBJECTS,
  addNestedElementInStructure,
  removeNestedElementInStructure,
  buildMinimalNestedElement,
  buildUpdatedNestedXml as buildUpdatedNestedXmlImpl,
  extractNameFromElementArray,
  extractNameFromNestedElement,
  type WriteNestedElementOptions,
} from './xml/xmlChildObjectsService';
import { getDefaultPropertiesForRootTag } from '../constants/metadataDefaultValues';
import { MetadataType } from '../models/treeNode';
import { injectInternalInfoIntoMetadataXml } from '../services/internalInfoGenerator';
import { normalizeMetaDataObjectRoot } from '../services/metaDataObjectRootNormalizer';

export type { WriteNestedElementOptions };
export { ROOT_TAGS_WITHOUT_CHILDOBJECTS } from './xml/xmlChildObjectsService';

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
    const updated = addNestedElementInStructure(
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
    const updated = removeNestedElementInStructure(parsed, elementType, elementName);
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
      const n = extractNameFromElementArray(props as unknown[]);
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
    const filtered = items.filter((item) => extractNameFromNestedElement(item) !== columnName);
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
    const newBlock = buildMinimalNestedElement(
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
      if (extractNameFromNestedElement(item) === columnName) {
        return item;
      }
    }
    return null;
  }

  private static tsBlockHasColumnName(tsElem: Record<string, unknown>, name: string): boolean {
    return this.getAttributeItemsFromTsBlock(tsElem).some(
      (item) => extractNameFromNestedElement(item) === name
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
