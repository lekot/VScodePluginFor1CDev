import { XmlParser } from './xmlParser';
import type { ObjectTypeDefinition, ObjectTypeInfo, ObjectKind } from '../types/objectTypeDefinitions';
import { OBJECT_KINDS_WITHOUT_NAME } from '../types/objectTypeDefinitions';
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
  'CatalogManager',
  'DocumentManager',
  'BusinessProcessManager',
  'TaskManager',
  'ChartOfCharacteristicTypesManager',
  'ChartOfAccountsManager',
  'ChartOfCalculationTypesManager',
  'ExchangePlanManager',
  'InformationRegisterManager',
  'AccumulationRegisterManager',
  'AccountingRegisterManager',
  'CalculationRegisterManager',
  'ConstantValueManager',
  'DataProcessorManager',
  'ReportManager',
  'DocumentJournalManager',
  'DefinedType',
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

    // Try format with name: cfg:Kind.ObjectName
    const matchWithName = typeStr.match(/^cfg:(\w+)\.(.+)$/);
    if (matchWithName) {
      const kind = matchWithName[1];
      const objectName = matchWithName[2];

      if (!VALID_OBJECT_KINDS.has(kind)) {
        Logger.warn(`ObjectTypeParser: invalid object kind "${kind}", skipping: ${typeStr}`);
        continue;
      }

      if (OBJECT_KINDS_WITHOUT_NAME.has(kind as ObjectKind)) {
        Logger.warn(`ObjectTypeParser: Manager kind "${kind}" should not have a name, skipping: ${typeStr}`);
        continue;
      }

      result.push({ objectKind: kind as ObjectKind, objectName });
      continue;
    }

    // Try format without name: cfg:Kind
    const matchWithoutName = typeStr.match(/^cfg:(\w+)$/);
    if (matchWithoutName) {
      const kind = matchWithoutName[1];

      if (!VALID_OBJECT_KINDS.has(kind)) {
        Logger.warn(`ObjectTypeParser: invalid object kind "${kind}", skipping: ${typeStr}`);
        continue;
      }

      if (!OBJECT_KINDS_WITHOUT_NAME.has(kind as ObjectKind)) {
        Logger.warn(`ObjectTypeParser: non-Manager kind "${kind}" requires a name, skipping: ${typeStr}`);
        continue;
      }

      result.push({ objectKind: kind as ObjectKind, objectName: '' });
      continue;
    }

    Logger.warn(`ObjectTypeParser: unrecognized type format, skipping: ${typeStr}`);
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
