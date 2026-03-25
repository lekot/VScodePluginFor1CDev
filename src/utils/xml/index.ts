/** Barrel: low-level I/O/helpers + pure `*InParsed` transforms for Designer XML. */
export { XML_WRITER_OPTIONS, xmlParser, xmlBuilder } from './xmlCore';
export { buildXmlString, writeUtf8FileWithBackup } from './xmlFileIo';
export { generateSimpleUuid } from './xmlHelpers';
export { extractProperties, updatePropertiesInStructure } from './xmlPropertiesService';
export {
  TOP_LEVEL_TYPES,
  ROOT_TAGS_WITHOUT_CHILDOBJECTS,
  addNestedElementInStructure,
  removeNestedElementInStructure,
  buildMinimalNestedElement,
  buildUpdatedNestedXml,
  extractNameFromElementArray,
  extractNameFromNestedElement,
  type WriteNestedElementOptions,
} from './xmlChildObjectsService';
export {
  addAttributeToTabularSectionInParsed,
  duplicateAttributeInTabularSectionInParsed,
  removeAttributeFromTabularSectionInParsed,
} from './xmlTabularSectionService';
export {
  addDesignerFormReferenceInParsed,
  removeDesignerFormFromOwnerInParsed,
} from './xmlFormReferenceService';
