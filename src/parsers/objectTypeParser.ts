import { XmlParser } from './xmlParser';
import type { ObjectTypeDefinition, ObjectTypeInfo, ObjectKind } from '../types/objectTypeDefinitions';
import { OBJECT_KINDS_WITHOUT_NAME } from '../types/objectTypeDefinitions';
import { Logger } from '../utils/logger';
import { validateElementName } from '../utils/elementNameValidator';

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

function parseV8Types(raw: unknown, strict = false): ObjectTypeInfo[] {
  if (!raw) {
    if (strict) {
      throw new Error('Type Source не может быть пустым.');
    }
    return [];
  }
  const values = Array.isArray(raw) ? raw : [raw];
  const result: ObjectTypeInfo[] = [];

  for (const item of values) {
    const typeStr = typeof item === 'string' ? item : (item as Record<string, unknown>)['#text'];
    if (!typeStr || typeof typeStr !== 'string') {
      if (strict) {
        throw new Error('Каждый тип Source должен быть строкой.');
      }
      continue;
    }

    // Try format with name: cfg:Kind.ObjectName
    const matchWithName = typeStr.match(/^cfg:(\w+)\.(.+)$/);
    if (matchWithName) {
      const kind = matchWithName[1];
      const objectName = matchWithName[2];

      if (!VALID_OBJECT_KINDS.has(kind)) {
        if (strict) {
          throw new Error(`Недопустимый ObjectKind "${kind}" в типе Source: "${typeStr}".`);
        }
        Logger.warn(`ObjectTypeParser: invalid object kind "${kind}", skipping: ${typeStr}`);
        continue;
      }

      if (OBJECT_KINDS_WITHOUT_NAME.has(kind as ObjectKind)) {
        if (strict) {
          throw new Error(`Manager ObjectKind "${kind}" не должен иметь имя: "${typeStr}".`);
        }
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
        if (strict) {
          throw new Error(`Недопустимый ObjectKind "${kind}" в типе Source: "${typeStr}".`);
        }
        Logger.warn(`ObjectTypeParser: invalid object kind "${kind}", skipping: ${typeStr}`);
        continue;
      }

      if (!OBJECT_KINDS_WITHOUT_NAME.has(kind as ObjectKind)) {
        if (strict) {
          throw new Error(`ObjectKind "${kind}" требует имя объекта: "${typeStr}".`);
        }
        Logger.warn(`ObjectTypeParser: non-Manager kind "${kind}" requires a name, skipping: ${typeStr}`);
        continue;
      }

      result.push({ objectKind: kind as ObjectKind, objectName: '' });
      continue;
    }

    if (strict) {
      throw new Error(`Некорректный формат типа Source: "${typeStr}".`);
    }
    Logger.warn(`ObjectTypeParser: unrecognized type format, skipping: ${typeStr}`);
  }

  return result;
}

export class ObjectTypeParser {
  /** Parses exactly one canonical Source type and rejects values the lenient XML reader would skip. */
  static parseSingleType(typeString: string): ObjectTypeInfo {
    const parsed = parseV8Types(typeString, true);
    if (parsed.length !== 1) {
      throw new Error(`Некорректный тип Source: "${typeString}". Ожидается cfg:ObjectKind или cfg:ObjectKind.Name.`);
    }

    const type = parsed[0];
    if (type.objectName) {
      const nameError = validateElementName(type.objectName, []);
      if (nameError) {
        throw new Error(`Некорректное имя объекта в типе Source "${typeString}": ${nameError}`);
      }
    }

    const canonical = type.objectName
      ? `cfg:${type.objectKind}.${type.objectName}`
      : `cfg:${type.objectKind}`;
    if (canonical !== typeString) {
      throw new Error(`Некорректная форма типа Source: "${typeString}".`);
    }
    return type;
  }

  /** Parses Source XML without dropping malformed or unsupported v8:Type entries. */
  static parseStrict(xmlContent: string): ObjectTypeDefinition {
    if (typeof xmlContent !== 'string') {
      throw new Error('Source XML must be a string.');
    }
    if (xmlContent.trim() === '') {
      return { types: [] };
    }

    const trimmed = xmlContent.trim();
    const wrapped = trimmed.startsWith('<Source') ? trimmed : `<Source>${trimmed}</Source>`;
    let parsed: Record<string, unknown>;
    try {
      parsed = XmlParser.parseString(wrapped);
    } catch (error) {
      throw new Error(`Некорректный XML Source: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!('Source' in parsed)) {
      throw new Error('В XML отсутствует элемент Source.');
    }
    return this.parseStrictFromObject({ Source: parsed['Source'] });
  }

  /** Parses an already-parsed Source value while rejecting unknown structure and entries. */
  static parseStrictFromObject(value: unknown): ObjectTypeDefinition {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Source должен быть XML-объектом.');
    }

    const input = value as Record<string, unknown>;
    const source = 'Source' in input ? input['Source'] : input;
    if (source === '') {
      return { types: [] };
    }
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw new Error('Source имеет неожиданное значение.');
    }

    const sourceRecord = source as Record<string, unknown>;
    const unexpectedKeys = Object.keys(sourceRecord).filter((key) => key !== 'v8:Type' && !key.startsWith('@_'));
    if (unexpectedKeys.length > 0) {
      throw new Error(`Source содержит неожиданные XML-элементы: ${unexpectedKeys.join(', ')}.`);
    }

    const rawTypes = sourceRecord['v8:Type'];
    if (rawTypes === undefined) {
      return { types: [] };
    }

    const values = Array.isArray(rawTypes) ? rawTypes : [rawTypes];
    const types = values.map((entry) => {
      let typeString: unknown = entry;
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const record = entry as Record<string, unknown>;
        const unexpectedEntryKeys = Object.keys(record).filter((key) => key !== '#text' && !key.startsWith('@_'));
        if (unexpectedEntryKeys.length > 0) {
          throw new Error(`v8:Type содержит неожиданные XML-элементы: ${unexpectedEntryKeys.join(', ')}.`);
        }
        typeString = record['#text'];
      }
      if (typeof typeString !== 'string') {
        throw new Error('Каждый v8:Type в Source должен содержать строку.');
      }
      return this.parseSingleType(typeString);
    });
    return { types };
  }

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
