import {
  QueryMetadataNode,
  VirtualTableParamDefinition,
} from './queryMetadataTypes';

interface NormalizedRegisterInfo {
  canonicalType: 'InformationRegister' | 'AccumulationRegister' | 'AccountingRegister';
  russianPrefix: string;
}

function resolveRegisterType(registerType: string): NormalizedRegisterInfo | null {
  const clean = registerType.trim().toLowerCase();
  if (
    clean === 'informationregister' ||
    clean === 'informationregisters' ||
    clean === 'регистрсведений' ||
    clean === 'регистрысведений'
  ) {
    return {
      canonicalType: 'InformationRegister',
      russianPrefix: 'РегистрСведений',
    };
  }

  if (
    clean === 'accumulationregister' ||
    clean === 'accumulationregisters' ||
    clean === 'регистрнакопления' ||
    clean === 'регистрынакопления'
  ) {
    return {
      canonicalType: 'AccumulationRegister',
      russianPrefix: 'РегистрНакопления',
    };
  }

  if (
    clean === 'accountingregister' ||
    clean === 'accountingregisters' ||
    clean === 'регистрбухгалтерии' ||
    clean === 'регистрыбухгалтерии'
  ) {
    return {
      canonicalType: 'AccountingRegister',
      russianPrefix: 'РегистрБухгалтерии',
    };
  }

  return null;
}

function makeFieldNode(
  parentVtId: string,
  parentVtFullName: string,
  name: string,
  dataType = 'String',
  label = name
): QueryMetadataNode {
  return {
    id: `${parentVtId}.${name}`,
    name,
    fullName: `${parentVtFullName}.${name}`,
    label,
    nodeType: 'field',
    dataType,
    isVirtual: true,
  };
}

function cloneFieldsWithParent(
  fields: QueryMetadataNode[],
  parentVtId: string,
  parentVtFullName: string,
  suffix = ''
): QueryMetadataNode[] {
  return fields.map((f) => {
    const fieldName = `${f.name}${suffix}`;
    return {
      id: `${parentVtId}.${fieldName}`,
      name: fieldName,
      fullName: `${parentVtFullName}.${fieldName}`,
      label: `${f.label || f.name}${suffix}`,
      nodeType: 'field',
      dataType: f.dataType ?? 'String',
      isVirtual: true,
    };
  });
}

export function getVirtualTables(
  registerType: string,
  registerName: string,
  dimensions: QueryMetadataNode[] = [],
  resources: QueryMetadataNode[] = [],
  attributes: QueryMetadataNode[] = []
): QueryMetadataNode[] {
  const regInfo = resolveRegisterType(registerType);
  if (!regInfo) {
    return [];
  }

  const { canonicalType, russianPrefix } = regInfo;
  const result: QueryMetadataNode[] = [];

  function createVt(
    vtShortName: string,
    params: VirtualTableParamDefinition[],
    buildFields: (vtId: string, vtFullName: string) => QueryMetadataNode[]
  ): QueryMetadataNode {
    const id = `${canonicalType}.${registerName}.${vtShortName}`;
    const fullName = `${russianPrefix}.${registerName}.${vtShortName}`;
    const name = `${registerName}.${vtShortName}`;
    const label = vtShortName;

    const fields = buildFields(id, fullName);

    return {
      id,
      name,
      fullName,
      label,
      nodeType: 'virtualTable',
      isVirtual: true,
      params,
      children: fields,
      hasChildren: fields.length > 0,
    };
  }

  if (canonicalType === 'InformationRegister') {
    const sliceParams: VirtualTableParamDefinition[] = [
      { name: 'Период', description: 'Момент времени на который получается срез' },
      { name: 'Условие', description: 'Условие отбора записей' },
    ];

    const makeSliceFields = (vtId: string, vtFullName: string): QueryMetadataNode[] => [
      ...cloneFieldsWithParent(dimensions, vtId, vtFullName),
      ...cloneFieldsWithParent(resources, vtId, vtFullName),
      ...cloneFieldsWithParent(attributes, vtId, vtFullName),
      makeFieldNode(vtId, vtFullName, 'Период', 'Date'),
    ];

    result.push(
      createVt('СрезПервых', sliceParams, makeSliceFields),
      createVt('СрезПоследних', sliceParams, makeSliceFields)
    );
  } else if (canonicalType === 'AccumulationRegister') {
    // 1. Остатки
    const balancesParams: VirtualTableParamDefinition[] = [
      { name: 'Период', description: 'Момент времени на который рассчитываются остатки' },
      { name: 'Условие', description: 'Условие отбора записей' },
    ];
    result.push(
      createVt('Остатки', balancesParams, (vtId, vtFullName) => [
        ...cloneFieldsWithParent(dimensions, vtId, vtFullName),
        ...cloneFieldsWithParent(resources, vtId, vtFullName, 'Остаток'),
      ])
    );

    // 2. Обороты
    const turnoversParams: VirtualTableParamDefinition[] = [
      { name: 'НачалоПериода', description: 'Начало периода формирования оборотов' },
      { name: 'КонецПериода', description: 'Конец периода формирования оборотов' },
      { name: 'Периодичность', description: 'Периодичность группировки (Запись, День, Месяц и т.д.)' },
      { name: 'Условие', description: 'Условие отбора записей' },
    ];
    result.push(
      createVt('Обороты', turnoversParams, (vtId, vtFullName) => [
        ...cloneFieldsWithParent(dimensions, vtId, vtFullName),
        ...cloneFieldsWithParent(resources, vtId, vtFullName, 'Оборот'),
        makeFieldNode(vtId, vtFullName, 'Период', 'Date'),
        makeFieldNode(vtId, vtFullName, 'Регистратор', 'Ref'),
        makeFieldNode(vtId, vtFullName, 'НомерСтроки', 'Number'),
      ])
    );

    // 3. ОстаткиИОбороты
    const boParams: VirtualTableParamDefinition[] = [
      { name: 'НачалоПериода', description: 'Начало периода формирования' },
      { name: 'КонецПериода', description: 'Конец периода формирования' },
      { name: 'Периодичность', description: 'Периодичность группировки' },
      { name: 'МетодДополнения', description: 'Метод дополнения периодов' },
      { name: 'Условие', description: 'Условие отбора записей' },
    ];
    result.push(
      createVt('ОстаткиИОбороты', boParams, (vtId, vtFullName) => {
        const resourceFields: QueryMetadataNode[] = [];
        for (const res of resources) {
          resourceFields.push(
            makeFieldNode(vtId, vtFullName, `${res.name}НачальныйОстаток`, res.dataType ?? 'Number'),
            makeFieldNode(vtId, vtFullName, `${res.name}КонечныйОстаток`, res.dataType ?? 'Number'),
            makeFieldNode(vtId, vtFullName, `${res.name}Приход`, res.dataType ?? 'Number'),
            makeFieldNode(vtId, vtFullName, `${res.name}Расход`, res.dataType ?? 'Number'),
            makeFieldNode(vtId, vtFullName, `${res.name}Оборот`, res.dataType ?? 'Number')
          );
        }
        return [
          ...cloneFieldsWithParent(dimensions, vtId, vtFullName),
          ...resourceFields,
          makeFieldNode(vtId, vtFullName, 'Период', 'Date'),
          makeFieldNode(vtId, vtFullName, 'Регистратор', 'Ref'),
          makeFieldNode(vtId, vtFullName, 'НомерСтроки', 'Number'),
        ];
      })
    );
  } else if (canonicalType === 'AccountingRegister') {
    // 1. Остатки
    const acctBalancesParams: VirtualTableParamDefinition[] = [
      { name: 'Период', description: 'Момент времени расчета остатков' },
      { name: 'УсловиеСчета', description: 'Условие отбора счетов' },
      { name: 'Субконто', description: 'Список субконто' },
      { name: 'Условие', description: 'Условие отбора записей' },
    ];
    result.push(
      createVt('Остатки', acctBalancesParams, (vtId, vtFullName) => {
        const resFields: QueryMetadataNode[] = [];
        for (const res of resources) {
          resFields.push(
            makeFieldNode(vtId, vtFullName, `${res.name}Остаток`, res.dataType ?? 'Number'),
            makeFieldNode(vtId, vtFullName, `${res.name}ОстатокДт`, res.dataType ?? 'Number'),
            makeFieldNode(vtId, vtFullName, `${res.name}ОстатокКт`, res.dataType ?? 'Number')
          );
        }
        return [
          makeFieldNode(vtId, vtFullName, 'Счет', 'Ref'),
          ...cloneFieldsWithParent(dimensions, vtId, vtFullName),
          makeFieldNode(vtId, vtFullName, 'Субконто1', 'Ref'),
          makeFieldNode(vtId, vtFullName, 'Субконто2', 'Ref'),
          makeFieldNode(vtId, vtFullName, 'Субконто3', 'Ref'),
          ...resFields,
        ];
      })
    );

    // 2. Обороты
    const acctTurnoversParams: VirtualTableParamDefinition[] = [
      { name: 'НачалоПериода', description: 'Начало периода' },
      { name: 'КонецПериода', description: 'Конец периода' },
      { name: 'Периодичность', description: 'Периодичность группировки' },
      { name: 'УсловиеСчета', description: 'Условие счета' },
      { name: 'Субконто', description: 'Субконто' },
      { name: 'Условие', description: 'Условие отбора' },
      { name: 'УсловиеКорСчета', description: 'Условие корреспондирующего счета' },
      { name: 'КорСубконто', description: 'Корреспондирующее субконто' },
    ];
    result.push(
      createVt('Обороты', acctTurnoversParams, (vtId, vtFullName) => {
        const resFields: QueryMetadataNode[] = [];
        for (const res of resources) {
          resFields.push(
            makeFieldNode(vtId, vtFullName, `${res.name}Оборот`, res.dataType ?? 'Number'),
            makeFieldNode(vtId, vtFullName, `${res.name}ОборотДт`, res.dataType ?? 'Number'),
            makeFieldNode(vtId, vtFullName, `${res.name}ОборотКт`, res.dataType ?? 'Number')
          );
        }
        return [
          makeFieldNode(vtId, vtFullName, 'Счет', 'Ref'),
          makeFieldNode(vtId, vtFullName, 'КорСчет', 'Ref'),
          ...cloneFieldsWithParent(dimensions, vtId, vtFullName),
          makeFieldNode(vtId, vtFullName, 'Субконто1', 'Ref'),
          makeFieldNode(vtId, vtFullName, 'Субконто2', 'Ref'),
          makeFieldNode(vtId, vtFullName, 'Субконто3', 'Ref'),
          makeFieldNode(vtId, vtFullName, 'КорСубконто1', 'Ref'),
          makeFieldNode(vtId, vtFullName, 'КорСубконто2', 'Ref'),
          makeFieldNode(vtId, vtFullName, 'КорСубконто3', 'Ref'),
          ...resFields,
          makeFieldNode(vtId, vtFullName, 'Период', 'Date'),
          makeFieldNode(vtId, vtFullName, 'Регистратор', 'Ref'),
          makeFieldNode(vtId, vtFullName, 'НомерСтроки', 'Number'),
        ];
      })
    );

    // 3. ОстаткиИОбороты
    const acctBoParams: VirtualTableParamDefinition[] = [
      { name: 'НачалоПериода', description: 'Начало периода' },
      { name: 'КонецПериода', description: 'Конец периода' },
      { name: 'Периодичность', description: 'Периодичность группировки' },
      { name: 'МетодДополнения', description: 'Метод дополнения периодов' },
      { name: 'УсловиеСчета', description: 'Условие счета' },
      { name: 'Субконто', description: 'Субконто' },
      { name: 'Условие', description: 'Условие отбора' },
    ];
    result.push(
      createVt('ОстаткиИОбороты', acctBoParams, (vtId, vtFullName) => {
        const resFields: QueryMetadataNode[] = [];
        for (const res of resources) {
          resFields.push(
            makeFieldNode(vtId, vtFullName, `${res.name}НачальныйОстаток`, res.dataType ?? 'Number'),
            makeFieldNode(vtId, vtFullName, `${res.name}НачальныйОстатокДт`, res.dataType ?? 'Number'),
            makeFieldNode(vtId, vtFullName, `${res.name}НачальныйОстатокКт`, res.dataType ?? 'Number'),
            makeFieldNode(vtId, vtFullName, `${res.name}КонечныйОстаток`, res.dataType ?? 'Number'),
            makeFieldNode(vtId, vtFullName, `${res.name}КонечныйОстатокДт`, res.dataType ?? 'Number'),
            makeFieldNode(vtId, vtFullName, `${res.name}КонечныйОстатокКт`, res.dataType ?? 'Number'),
            makeFieldNode(vtId, vtFullName, `${res.name}Оборот`, res.dataType ?? 'Number'),
            makeFieldNode(vtId, vtFullName, `${res.name}ОборотДт`, res.dataType ?? 'Number'),
            makeFieldNode(vtId, vtFullName, `${res.name}ОборотКт`, res.dataType ?? 'Number')
          );
        }
        return [
          makeFieldNode(vtId, vtFullName, 'Счет', 'Ref'),
          ...cloneFieldsWithParent(dimensions, vtId, vtFullName),
          makeFieldNode(vtId, vtFullName, 'Субконто1', 'Ref'),
          makeFieldNode(vtId, vtFullName, 'Субконто2', 'Ref'),
          makeFieldNode(vtId, vtFullName, 'Субконто3', 'Ref'),
          ...resFields,
          makeFieldNode(vtId, vtFullName, 'Период', 'Date'),
          makeFieldNode(vtId, vtFullName, 'Регистратор', 'Ref'),
          makeFieldNode(vtId, vtFullName, 'НомерСтроки', 'Number'),
        ];
      })
    );

    // 4. ДвиженияССубконто
    const acctSubcontoParams: VirtualTableParamDefinition[] = [
      { name: 'НачалоПериода', description: 'Начало периода' },
      { name: 'КонецПериода', description: 'Конец периода' },
      { name: 'Условие', description: 'Условие отбора' },
      { name: 'Периодичность', description: 'Периодичность группировки' },
    ];
    result.push(
      createVt('ДвиженияССубконто', acctSubcontoParams, (vtId, vtFullName) => [
        makeFieldNode(vtId, vtFullName, 'Счет', 'Ref'),
        makeFieldNode(vtId, vtFullName, 'КорСчет', 'Ref'),
        ...cloneFieldsWithParent(dimensions, vtId, vtFullName),
        makeFieldNode(vtId, vtFullName, 'Субконто1', 'Ref'),
        makeFieldNode(vtId, vtFullName, 'Субконто2', 'Ref'),
        makeFieldNode(vtId, vtFullName, 'Субконто3', 'Ref'),
        makeFieldNode(vtId, vtFullName, 'КорСубконто1', 'Ref'),
        makeFieldNode(vtId, vtFullName, 'КорСубконто2', 'Ref'),
        makeFieldNode(vtId, vtFullName, 'КорСубконто3', 'Ref'),
        ...cloneFieldsWithParent(attributes, vtId, vtFullName),
        ...cloneFieldsWithParent(resources, vtId, vtFullName),
        makeFieldNode(vtId, vtFullName, 'Период', 'Date'),
        makeFieldNode(vtId, vtFullName, 'Регистратор', 'Ref'),
        makeFieldNode(vtId, vtFullName, 'НомерСтроки', 'Number'),
        makeFieldNode(vtId, vtFullName, 'Активность', 'Boolean'),
        makeFieldNode(vtId, vtFullName, 'ВидДвижения', 'String'),
      ])
    );

    // 5. ОборотыДтКт
    const dtKtParams: VirtualTableParamDefinition[] = [
      { name: 'НачалоПериода', description: 'Начало периода' },
      { name: 'КонецПериода', description: 'Конец периода' },
      { name: 'Периодичность', description: 'Периодичность' },
      { name: 'УсловиеСчетаДт', description: 'Условие счета Дт' },
      { name: 'СубконтоДт', description: 'Субконто Дт' },
      { name: 'УсловиеСчетаКт', description: 'Условие счета Кт' },
      { name: 'СубконтоКт', description: 'Субконто Кт' },
      { name: 'Условие', description: 'Условие отбора' },
    ];
    result.push(
      createVt('ОборотыДтКт', dtKtParams, (vtId, vtFullName) => [
        makeFieldNode(vtId, vtFullName, 'СчетДт', 'Ref'),
        makeFieldNode(vtId, vtFullName, 'СчетКт', 'Ref'),
        ...cloneFieldsWithParent(dimensions, vtId, vtFullName),
        makeFieldNode(vtId, vtFullName, 'СубконтоДт1', 'Ref'),
        makeFieldNode(vtId, vtFullName, 'СубконтоДт2', 'Ref'),
        makeFieldNode(vtId, vtFullName, 'СубконтоДт3', 'Ref'),
        makeFieldNode(vtId, vtFullName, 'СубконтоКт1', 'Ref'),
        makeFieldNode(vtId, vtFullName, 'СубконтоКт2', 'Ref'),
        makeFieldNode(vtId, vtFullName, 'СубконтоКт3', 'Ref'),
        ...cloneFieldsWithParent(resources, vtId, vtFullName, 'Оборот'),
        makeFieldNode(vtId, vtFullName, 'Период', 'Date'),
        makeFieldNode(vtId, vtFullName, 'Регистратор', 'Ref'),
        makeFieldNode(vtId, vtFullName, 'НомерСтроки', 'Number'),
      ])
    );
  }

  return result;
}
