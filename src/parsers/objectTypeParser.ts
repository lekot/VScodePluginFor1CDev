import { XmlParser } from './xmlParser';
import type { ObjectTypeDefinition, ObjectTypeInfo, ObjectKind } from '../types/objectTypeDefinitions';
import { Logger } from '../utils/logger';

const VALID_OBJECT_KINDS = new Set<string>([
  'CatalogObject',
  'DocumentObject',
  'BusinessProcessObject',
  'TaskObject',
  'ChartOfCharacteristicTypesObject',
  'ChartOfAccountsObject',
  'ChartOfCalculationTypesObject',
  'ExchangePlanObject',
  'InformationRegisterRecordSet',
  'AccumulationRegisterRecordSet',
  'AccountingRegisterRecordSet',
  'CalculationRegisterRecordSet',
]);

function parseV8Types(raw: unknown): ObjectTypeInfo[] {
  if (!raw) {
    return [];
  }
  const values = Array.isArray(raw) ? raw : [raw];
  const result: ObjectTypeInfo[] = [];

  for (const item of values) {
    const typeStr = typeof item === 'string' ? item : (item as Record<string, unknown>)['#text'];
    if (!typeStr || typeof typeStr !== 'string') {
      continue;
    }

    const match = typeStr.match(/^cfg:(\w+)\.(.+)$/);
    if (!match) {
      Logger.warn(`ObjectTypeParser: unrecognized type format, skipping: ${typeStr}`);
      continue;
    }

    const kind = match[1];
    const objectName = match[2];

    if (!VALID_OBJECT_KINDS.has(kind)) {
      Logger.warn(`ObjectTypeParser: invalid object kind "${kind}", skipping: ${typeStr}`);
      continue;
    }

    result.push({ objectKind: kind as ObjectKind, objectName });
  }

  return result;
}

export class ObjectTypeParser {
  /**
   * Parses an XML string containing a <Source> element with <v8:Type> children.
   * Invalid kinds are logged as warnings and skipped.
   */
  static parse(xmlContent: string): ObjectTypeDefinition {
    if (!xmlContent || xmlContent.trim() === '') {
      return { types: [] };
    }

    const wrapped = xmlContent.trim().startsWith('<Source') ? xmlContent : `<Source>${xmlContent}</Source>`;

    let parsed: Record<string, unknown>;
    try {
      parsed = XmlParser.parseString(wrapped);
    } catch (e) {
      Logger.warn(`ObjectTypeParser: failed to parse XML, returning empty: ${e instanceof Error ? e.message : String(e)}`);
      return { types: [] };
    }

    const source = parsed['Source'] as Record<string, unknown> | undefined;
    if (!source) {
      return { types: [] };
    }

    return { types: parseV8Types(source['v8:Type']) };
  }

  /**
   * Parses an already-parsed XML object (result of XmlParser) representing
   * a <Source> element or its content.
   */
  static parseFromObject(obj: Record<string, unknown>): ObjectTypeDefinition {
    if (!obj) {
      return { types: [] };
    }

    // Accept both {Source: {...}} and direct element with v8:Type
    const source = ('Source' in obj ? obj['Source'] : obj) as Record<string, unknown> | undefined;
    if (!source) {
      return { types: [] };
    }

    return { types: parseV8Types(source['v8:Type']) };
  }
}
