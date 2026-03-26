import { XMLParser, XMLBuilder } from 'fast-xml-parser';

/**
 * Options shared by {@link xmlParser} and {@link xmlBuilder} for 1C Designer XML.
 */
export const XML_WRITER_OPTIONS = {
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

export const xmlParser = new XMLParser(XML_WRITER_OPTIONS);
export const xmlBuilder = new XMLBuilder(XML_WRITER_OPTIONS);
