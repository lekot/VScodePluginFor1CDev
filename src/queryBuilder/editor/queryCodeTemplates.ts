/**
 * Query Code Templates.
 * Generates BSL code snippets and full execution skeletons from SDBL queries.
 */

import { QueryPackage } from '../sdbl/sdblAst';
import {
  formatToBslLiteral,
  extractParameters,
  SdblFormatOptions,
} from '../sdbl/sdblFormatter';

export interface QueryProcessingOptions {
  variableName?: string;
  indent?: string;
}

/**
 * Returns a simple multiline BSL literal for the query package or SDBL string.
 */
export function generateBslSimpleQuery(
  pkg: QueryPackage | string,
  options?: SdblFormatOptions
): string {
  return formatToBslLiteral(pkg, options);
}

/**
 * Generates full 1C BSL boilerplate code to execute and process the query.
 */
export function generateBslQueryWithProcessing(
  pkg: QueryPackage,
  options?: QueryProcessingOptions
): string {
  const varName = options?.variableName?.trim() || 'Запрос';
  const indent = options?.indent ?? '\t';

  const parts: string[] = [];

  // 1. Creation and text assignment
  const literal = formatToBslLiteral(pkg, { indent });
  const indentedLiteral = literal
    .split('\n')
    .map((line) => `${indent}${line}`)
    .join('\n');

  parts.push(`${varName} = Новый Запрос;\n${varName}.Текст =\n${indentedLiteral};`);

  // 2. Setting parameters
  const params = extractParameters(pkg);
  if (params.length > 0) {
    const paramLines = params.map(
      (param) => `${varName}.УстановитьПараметр("${param}", ${param});`
    );
    parts.push(paramLines.join('\n'));
  }

  // 3. Execution
  parts.push(`РезультатЗапроса = ${varName}.Выполнить();`);

  // 4. Result iteration
  const queryHasTotals = pkg.queries.some(
    (q) =>
      q.type === 'Select' &&
      Boolean(
        q.totals &&
          (q.totals.overall ||
            (q.totals.fields && q.totals.fields.length > 0) ||
            (q.totals.by && q.totals.by.length > 0))
      )
  );

  if (queryHasTotals) {
    const totalsLines = [
      'ВыборкаИтоги = РезультатЗапроса.Выбрать(ОбходРезультатаЗапроса.ПоГруппировкам);',
      'Пока ВыборкаИтоги.Следующий() Цикл',
      `${indent}// Обработка итогов`,
      '',
      `${indent}ВыборкаДетали = ВыборкаИтоги.Выбрать();`,
      `${indent}Пока ВыборкаДетали.Следующий() Цикл`,
      `${indent}${indent}// Обработка детальных записей`,
      `${indent}КонецЦикла;`,
      'КонецЦикла;',
    ];
    parts.push(totalsLines.join('\n'));
  } else {
    const detailLines = [
      'ВыборкаДетальныеЗаписи = РезультатЗапроса.Выбрать();',
      'Пока ВыборкаДетальныеЗаписи.Следующий() Цикл',
      `${indent}// Обработка строки результата`,
      'КонецЦикла;',
    ];
    parts.push(detailLines.join('\n'));
  }

  return parts.join('\n\n');
}
