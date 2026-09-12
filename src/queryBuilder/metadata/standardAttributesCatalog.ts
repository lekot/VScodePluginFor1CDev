import { QueryMetadataNode } from './queryMetadataTypes';

export interface StandardAttributeOptions {
  isHierarchical?: boolean;
  hasOwner?: boolean;
  isPeriodic?: boolean;
  parentId?: string;
  parentFullName?: string;
}

const ATTRIBUTE_DATA_TYPES: Record<string, string> = {
  Ссылка: 'Ref',
  Порядок: 'Number',
  ПометкаУдаления: 'Boolean',
  Предопределенный: 'Boolean',
  Код: 'String',
  Наименование: 'String',
  Родитель: 'Ref',
  Владелец: 'Ref',
  ЭтоГруппа: 'Boolean',
  Дата: 'Date',
  Номер: 'String',
  Проведен: 'Boolean',
  Вид: 'Ref',
  Период: 'Date',
  Регистратор: 'Ref',
  НомерСтроки: 'Number',
  Активность: 'Boolean',
  ВидДвижения: 'AccumulationRecordType',
  СчетДт: 'Ref',
  СчетКт: 'Ref',
};

function normalizeMetadataType(type: string): string {
  const clean = type.trim().toLowerCase();
  switch (clean) {
    case 'catalog':
    case 'catalogs':
    case 'справочник':
    case 'справочники':
      return 'Catalog';

    case 'document':
    case 'documents':
    case 'документ':
    case 'документы':
      return 'Document';

    case 'chartofcharacteristictypes':
    case 'chartsofcharacteristictypes':
    case 'планвидовхарактеристик':
    case 'планывидовхарактеристик':
      return 'ChartOfCharacteristicTypes';

    case 'chartofaccounts':
    case 'chartsofaccounts':
    case 'плансчетов':
    case 'планысчетов':
      return 'ChartOfAccounts';

    case 'informationregister':
    case 'informationregisters':
    case 'регистрсведений':
    case 'регистрысведений':
      return 'InformationRegister';

    case 'accumulationregister':
    case 'accumulationregisters':
    case 'регирнакопления':
    case 'регистрнакопления':
    case 'регистрынакопления':
      return 'AccumulationRegister';

    case 'accountingregister':
    case 'accountingregisters':
    case 'регистрбухгалтерии':
    case 'регистрыбухгалтерии':
      return 'AccountingRegister';

    case 'enum':
    case 'enums':
    case 'перечисление':
    case 'перечисления':
      return 'Enum';

    case 'tabularsection':
    case 'tabularsections':
    case 'табличнаячасть':
    case 'табличныечасти':
      return 'TabularSection';

    default:
      return type;
  }
}

export function getStandardAttributes(
  metadataType: string,
  options?: StandardAttributeOptions
): QueryMetadataNode[] {
  const normalized = normalizeMetadataType(metadataType);
  const isHierarchical = options?.isHierarchical ?? true;
  const hasOwner = options?.hasOwner ?? true;
  const isPeriodic = options?.isPeriodic ?? true;

  let attributeNames: string[] = [];

  switch (normalized) {
    case 'Catalog':
      attributeNames = [
        'Ссылка',
        'ПометкаУдаления',
        'Предопределенный',
        'Код',
        'Наименование',
        ...(isHierarchical ? ['Родитель'] : []),
        ...(hasOwner ? ['Владелец'] : []),
        ...(isHierarchical ? ['ЭтоГруппа'] : []),
      ];
      break;

    case 'Document':
      attributeNames = ['Ссылка', 'ПометкаУдаления', 'Дата', 'Номер', 'Проведен'];
      break;

    case 'ChartOfCharacteristicTypes':
      attributeNames = [
        'Ссылка',
        'ПометкаУдаления',
        'Предопределенный',
        'Код',
        'Наименование',
        ...(isHierarchical ? ['Родитель'] : []),
        ...(isHierarchical ? ['ЭтоГруппа'] : []),
      ];
      break;

    case 'ChartOfAccounts':
      attributeNames = [
        'Ссылка',
        'ПометкаУдаления',
        'Код',
        'Наименование',
        ...(isHierarchical ? ['Родитель'] : []),
        'Вид',
      ];
      break;

    case 'InformationRegister':
      if (isPeriodic) {
        attributeNames = ['Период', 'Регистратор', 'НомерСтроки', 'Активность'];
      } else {
        attributeNames = [];
      }
      break;

    case 'AccumulationRegister':
      attributeNames = ['Период', 'Регистратор', 'НомерСтроки', 'Активность', 'ВидДвижения'];
      break;

    case 'AccountingRegister':
      attributeNames = ['Период', 'Регистратор', 'НомерСтроки', 'Активность', 'СчетДт', 'СчетКт'];
      break;

    case 'Enum':
      attributeNames = ['Ссылка', 'Порядок'];
      break;

    case 'TabularSection':
      attributeNames = ['НомерСтроки', 'Ссылка'];
      break;

    default:
      attributeNames = [];
      break;
  }

  return attributeNames.map((name) => {
    const id = options?.parentId ? `${options.parentId}.${name}` : `${normalized}.${name}`;
    const fullName = options?.parentFullName ? `${options.parentFullName}.${name}` : name;
    return {
      id,
      name,
      fullName,
      label: name,
      nodeType: 'field',
      dataType: ATTRIBUTE_DATA_TYPES[name] ?? 'String',
      isVirtual: false,
    };
  });
}
