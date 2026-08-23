import { getValueByLocalName, localName } from '../../parsers/xmlNavHelpers';
import { XmlParser } from '../../parsers/xmlParser';
import { validateElementName } from '../../utils/elementNameValidator';
import { CfeProjectError, type CfeProjectContext, type CfeProjectErrorCode } from './types';

export type CfeObjectOwnership = 'own' | 'adopted';
export type CfeGenericMutationOperation = 'create' | 'update' | 'delete' | 'rename' | 'duplicate';

/** Immutable identity derived from one Designer metadata object XML document. */
export interface CfeObjectIdentity {
  readonly ownership: CfeObjectOwnership;
  readonly type: string;
  readonly name: string;
  readonly uuid: string;
  readonly path: string;
  readonly sourceUuid?: string;
}

export type CfeOwnershipErrorCode = Extract<
  CfeProjectErrorCode,
  'CFE_OWNERSHIP_INVALID' | 'CFE_ADOPTED_OPERATION_REQUIRED'
>;

/** Error for an invalid ownership declaration or an unsupported generic mutation. */
export class CfeOwnershipError extends CfeProjectError {
  constructor(code: CfeOwnershipErrorCode, message: string) {
    super(code, message);
    this.name = 'CfeOwnershipError';
  }
}

/**
 * Parses an object identity from an actual Designer XML document.
 *
 * This is intentionally a pure parser: callers supply the project-relative path,
 * and this module does not access the filesystem.
 */
export function parseCfeObjectIdentity(xmlText: string, objectPath: string): CfeObjectIdentity {
  let parsed: Record<string, unknown>;
  try {
    parsed = XmlParser.parseString(xmlText);
  } catch (error) {
    throw ownershipInvalid(`Не удалось разобрать XML объекта CFE: ${message(error)}`);
  }

  const metaDataObject = singularObject(
    getValueByLocalName(parsed, 'MetaDataObject'),
    'Корневой элемент MetaDataObject отсутствует или некорректен.',
  );
  const [type, object] = extractMetadataObject(metaDataObject);
  const uuid = requiredUuid(readAttribute(object, 'uuid'), 'Локальный UUID объекта отсутствует или некорректен.');
  const properties = singularObject(
    getValueByLocalName(object, 'Properties'),
    'Раздел Properties объекта отсутствует или некорректен.',
  );
  const name = requiredElementName(singularText(getValueByLocalName(properties, 'Name')), 'Имя объекта отсутствует или некорректно.');
  const belonging = singularText(getValueByLocalName(properties, 'ObjectBelonging'));
  const sourceUuid = singularText(getValueByLocalName(properties, 'ExtendedConfigurationObject'));

  if (belonging === undefined && sourceUuid === undefined) {
    return { ownership: 'own', type, name, uuid, path: objectPath };
  }
  if (belonging === 'Adopted' && sourceUuid !== undefined) {
    return {
      ownership: 'adopted',
      type,
      name,
      uuid,
      path: objectPath,
      sourceUuid: requiredUuid(sourceUuid, 'UUID исходного объекта отсутствует, нулевой или некорректен.'),
    };
  }

  throw ownershipInvalid('Признаки принадлежности объекта CFE должны описывать только собственный или заимствованный объект.');
}

/** Stateless policy guard shared by generic CFE mutation paths. */
export class CfeOwnershipGuard {
  assertGenericMutationAllowed(
    identity: CfeObjectIdentity,
    operation: CfeGenericMutationOperation,
  ): void {
    if (identity.ownership === 'adopted') {
      throw new CfeOwnershipError(
        'CFE_ADOPTED_OPERATION_REQUIRED',
        `Операция «${operation}» для заимствованного объекта «${identity.type}.${identity.name}» должна выполняться отдельной CFE-командой.`,
      );
    }
  }

  assertOwnCreateName(name: string, context: Pick<CfeProjectContext, 'namePrefix'>): void {
    const trimmedName = typeof name === 'string' ? name.trim() : '';
    const prefix = typeof context?.namePrefix === 'string' ? context.namePrefix.trim() : '';
    const nameError = validateElementName(trimmedName, []);
    const prefixError = prefix === '' ? null : validateElementName(prefix, []);
    if (nameError !== null || prefixError !== null || !trimmedName.startsWith(prefix)) {
      throw new CfeOwnershipError(
        'CFE_OWNERSHIP_INVALID',
        'Имя собственного объекта должно быть корректным 1С-идентификатором и начинаться с NamePrefix CFE.',
      );
    }
  }
}

function extractMetadataObject(metaDataObject: Record<string, unknown>): [string, Record<string, unknown>] {
  const candidates = Object.entries(metaDataObject).filter(([key, value]) => (
    !isAttributeKey(key) && value !== undefined && value !== null
  ));
  if (candidates.length !== 1) {
    throw ownershipInvalid('MetaDataObject должен содержать ровно один объект метаданных.');
  }
  const [rawType, rawObject] = candidates[0]!;
  const type = localName(rawType);
  if (validateElementName(type, []) !== null) {
    throw ownershipInvalid('Тип объекта метаданных некорректен.');
  }
  return [type, singularObject(rawObject, 'Объект метаданных некорректен.')];
}

function singularObject(value: unknown, errorMessage: string): Record<string, unknown> {
  const singleValue = unwrapSingular(value);
  if (!singleValue || typeof singleValue !== 'object' || Array.isArray(singleValue)) {
    throw ownershipInvalid(errorMessage);
  }
  return singleValue as Record<string, unknown>;
}

function singularText(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const singleValue = unwrapSingular(value);
  if (typeof singleValue === 'string') {
    return singleValue.trim();
  }
  if (singleValue && typeof singleValue === 'object' && !Array.isArray(singleValue)) {
    const text = (singleValue as Record<string, unknown>)['#text'];
    if (typeof text === 'string' && Object.keys(singleValue as Record<string, unknown>).every((key) => key === '#text' || isAttributeKey(key))) {
      return text.trim();
    }
  }
  throw ownershipInvalid('Текстовое значение XML-элемента некорректно.');
}

function unwrapSingular(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  if (value.length !== 1) {
    throw ownershipInvalid('Повторяющийся XML-элемент недопустим для идентичности объекта CFE.');
  }
  return value[0];
}

function readAttribute(object: Record<string, unknown>, name: string): unknown {
  const direct = object[`@_${name}`];
  if (direct !== undefined) {
    return direct;
  }
  const attributes = object['@_'];
  if (attributes && typeof attributes === 'object' && !Array.isArray(attributes)) {
    return (attributes as Record<string, unknown>)[name];
  }
  return undefined;
}

function requiredElementName(value: string | undefined, errorMessage: string): string {
  if (!value || validateElementName(value, []) !== null) {
    throw ownershipInvalid(errorMessage);
  }
  return value;
}

function requiredUuid(value: unknown, errorMessage: string): string {
  if (typeof value !== 'string' || !isNonZeroUuid(value.trim())) {
    throw ownershipInvalid(errorMessage);
  }
  return value.trim();
}

function isNonZeroUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
    && value.toLowerCase() !== '00000000-0000-0000-0000-000000000000';
}

function isAttributeKey(key: string): boolean {
  return key === '@_' || key === ':@' || key.startsWith('@_') || key.startsWith('#') || key.startsWith('?');
}

function ownershipInvalid(messageText: string): CfeOwnershipError {
  return new CfeOwnershipError('CFE_OWNERSHIP_INVALID', messageText);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
