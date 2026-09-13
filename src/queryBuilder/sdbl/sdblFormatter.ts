import {
  QueryPackage,
  QueryStatement,
  SelectStatement,
  DropTableStatement,
  TableOrSubquery,
  TotalsClause,
  ExpressionNode,
} from './sdblAst';

export interface SdblFormatOptions {
  indent?: string;
  newline?: string;
}

const DEFAULT_INDENT = '\t';
const DEFAULT_NEWLINE = '\n';

/**
 * Formats a QueryPackage AST into pretty-printed SDBL (1C Query Language) text.
 */
export function formatSdbl(pkg: QueryPackage, options?: SdblFormatOptions): string {
  const indent = options?.indent ?? DEFAULT_INDENT;
  const newline = options?.newline ?? DEFAULT_NEWLINE;

  return pkg.queries
    .map((query) => formatStatement(query, indent, newline))
    .join(`${newline};${newline}${newline}`);
}

/**
 * Formats a single QueryStatement (SelectStatement or DropTableStatement).
 */
function formatStatement(
  stmt: QueryStatement,
  indent: string,
  newline: string
): string {
  if (stmt.type === 'DropTable') {
    return formatDropTable(stmt);
  }
  return formatSelect(stmt, indent, newline);
}

/**
 * Formats a DropTableStatement (УНИЧТОЖИТЬ).
 */
function formatDropTable(stmt: DropTableStatement): string {
  return `УНИЧТОЖИТЬ ${stmt.tableName}`;
}

/**
 * Normalizes UNION column counts across the main query and all union branches
 * to ensure positional alignment and an equal number of columns.
 */
export function normalizeUnionColumns(stmt: SelectStatement): void {
  if (!stmt.unions || stmt.unions.length === 0) {
    return;
  }
  let maxCols = stmt.fields ? stmt.fields.length : 0;
  for (const u of stmt.unions) {
    if (u.statement && u.statement.fields && u.statement.fields.length > maxCols) {
      maxCols = u.statement.fields.length;
    }
  }
  if (maxCols === 0) {
    return;
  }
  if (!stmt.fields) {
    stmt.fields = [];
  }

  const colAliases: string[] = [];
  for (let colIdx = 0; colIdx < maxCols; colIdx++) {
    let alias = '';
    if (stmt.fields[colIdx]) {
      alias =
        stmt.fields[colIdx].alias ||
        (typeof stmt.fields[colIdx].expression === 'string'
          ? (stmt.fields[colIdx].expression as string)
          : formatExpression(stmt.fields[colIdx].expression as ExpressionNode));
    }
    if (!alias || alias === 'NULL') {
      for (const u of stmt.unions) {
        const uFields = u.statement && u.statement.fields;
        if (uFields && uFields[colIdx]) {
          alias =
            uFields[colIdx].alias ||
            (typeof uFields[colIdx].expression === 'string'
              ? (uFields[colIdx].expression as string)
              : formatExpression(uFields[colIdx].expression as ExpressionNode));
          if (alias && alias !== 'NULL') {
            break;
          }
        }
      }
    }
    if (!alias || alias === 'NULL') {
      alias = `Поле${colIdx + 1}`;
    }
    colAliases.push(alias);
  }

  while (stmt.fields.length < maxCols) {
    const colIdx = stmt.fields.length;
    stmt.fields.push({
      expression: { type: 'Literal', valueType: 'null', value: null, raw: 'NULL' },
      alias: colAliases[colIdx],
    });
  }

  for (const u of stmt.unions) {
    if (!u.statement) {
      u.statement = { type: 'Select', fields: [], from: [] };
    }
    if (!u.statement.fields) {
      u.statement.fields = [];
    }
    while (u.statement.fields.length < maxCols) {
      u.statement.fields.push({
        expression: { type: 'Literal', valueType: 'null', value: null, raw: 'NULL' },
      });
    }
  }
}

/**
 * Formats a SelectStatement (ВЫБРАТЬ ...).
 */
function formatSelect(
  stmt: SelectStatement,
  indent: string,
  newline: string
): string {
  if (stmt.unions && stmt.unions.length > 0) {
    normalizeUnionColumns(stmt);
  }
  const lines: string[] = [];

  // 1. SELECT header with modifiers
  const selectParts: string[] = ['ВЫБРАТЬ'];
  if (stmt.allowed) {
    selectParts.push('РАЗРЕШЕННЫЕ');
  }
  if (stmt.distinct) {
    selectParts.push('РАЗЛИЧНЫЕ');
  }
  if (stmt.top !== undefined) {
    selectParts.push(`ПЕРВЫЕ ${stmt.top}`);
  }
  lines.push(selectParts.join(' '));

  // 2. Selected fields
  if (stmt.fields && stmt.fields.length > 0) {
    for (let i = 0; i < stmt.fields.length; i++) {
      const field = stmt.fields[i];
      const exprStr =
        typeof field.expression === 'string'
          ? field.expression
          : formatExpression(field.expression, indent, newline);
      const aliasStr = field.alias ? ` КАК ${field.alias}` : '';
      const comma = i < stmt.fields.length - 1 ? ',' : '';
      lines.push(`${indent}${exprStr}${aliasStr}${comma}`);
    }
  } else {
    lines.push(`${indent}*`);
  }

  // 3. INTO / ПОМЕСТИТЬ
  if (stmt.into) {
    lines.push(`ПОМЕСТИТЬ ${stmt.into}`);
  }

  // 4. FROM / ИЗ and JOINS
  if (stmt.from && stmt.from.length > 0) {
    lines.push('ИЗ');
    for (let i = 0; i < stmt.from.length; i++) {
      const fromClause = stmt.from[i];
      const srcStr = formatTableOrSubquery(fromClause.source, indent, newline);
      const aliasStr = fromClause.alias ? ` КАК ${fromClause.alias}` : '';
      const hasJoins = Boolean(fromClause.joins && fromClause.joins.length > 0);
      const fromComma =
        i < stmt.from.length - 1 && !hasJoins ? ',' : '';

      lines.push(`${indent}${srcStr}${aliasStr}${fromComma}`);

      if (fromClause.joins && fromClause.joins.length > 0) {
        interface GroupedJoin {
          joinKw: string;
          joinSrc: string;
          joinAlias: string;
          conditions: { str: string; expr?: ExpressionNode }[];
        }
        const groupedJoins: GroupedJoin[] = [];

        for (const join of fromClause.joins) {
          const joinKw = getJoinKeyword(join.joinType);
          const joinSrc = formatTableOrSubquery(join.source, indent, newline);
          const joinAlias = join.alias ? ` КАК ${join.alias}` : '';
          const condStr = formatExpression(join.on, indent, newline);

          const existing = groupedJoins.find(
            (g) =>
              g.joinKw === joinKw &&
              g.joinSrc === joinSrc &&
              g.joinAlias === joinAlias
          );
          if (existing) {
            existing.conditions.push({ str: condStr, expr: join.on });
          } else {
            groupedJoins.push({
              joinKw,
              joinSrc,
              joinAlias,
              conditions: [{ str: condStr, expr: join.on }],
            });
          }
        }

        for (let j = 0; j < groupedJoins.length; j++) {
          const g = groupedJoins[j];
          const isLastJoin = j === groupedJoins.length - 1;
          const joinComma =
            isLastJoin && i < stmt.from.length - 1 ? ',' : '';

          const combinedConditions =
            g.conditions.length > 1
              ? g.conditions.map(wrapConditionIfOr).join(' И ')
              : g.conditions[0].str;

          lines.push(`${indent}${indent}${g.joinKw} ${g.joinSrc}${g.joinAlias}`);
          lines.push(
            `${indent}${indent}ПО ${combinedConditions}${joinComma}`
          );
        }
      }
    }
  }

  // 5. WHERE / ГДЕ
  if (stmt.where) {
    lines.push('ГДЕ');
    const conditions = flattenConditions(stmt.where);
    const isAndChain = conditions.some((c) => c.op === 'И');
    for (const cond of conditions) {
      let condExprStr = formatExpression(cond.expr, indent, newline);
      if (
        isAndChain &&
        cond.expr.type === 'BinaryOp' &&
        isOrOp(cond.expr.operator)
      ) {
        condExprStr = `(${condExprStr})`;
      }
      if (cond.op) {
        lines.push(`${indent}${cond.op} ${condExprStr}`);
      } else {
        lines.push(`${indent}${condExprStr}`);
      }
    }
  }

  // 6. GROUP BY / СГРУППИРОВАТЬ ПО
  if (stmt.groupBy && stmt.groupBy.length > 0) {
    lines.push('СГРУППИРОВАТЬ ПО');
    for (let i = 0; i < stmt.groupBy.length; i++) {
      const comma = i < stmt.groupBy.length - 1 ? ',' : '';
      lines.push(
        `${indent}${formatExpression(stmt.groupBy[i], indent, newline)}${comma}`
      );
    }
  }

  // 7. HAVING / ИМЕЮЩИЕ
  if (stmt.having) {
    lines.push('ИМЕЮЩИЕ');
    const conditions = flattenConditions(stmt.having);
    const isAndChain = conditions.some((c) => c.op === 'И');
    for (const cond of conditions) {
      let condExprStr = formatExpression(cond.expr, indent, newline);
      if (
        isAndChain &&
        cond.expr.type === 'BinaryOp' &&
        isOrOp(cond.expr.operator)
      ) {
        condExprStr = `(${condExprStr})`;
      }
      if (cond.op) {
        lines.push(`${indent}${cond.op} ${condExprStr}`);
      } else {
        lines.push(`${indent}${condExprStr}`);
      }
    }
  }

  // INDEX BY / ИНДЕКСИРОВАТЬ ПО (after FROM, WHERE, GROUP BY, HAVING)
  if (stmt.indexBy && stmt.indexBy.length > 0) {
    lines.push('ИНДЕКСИРОВАТЬ ПО');
    for (let i = 0; i < stmt.indexBy.length; i++) {
      const comma = i < stmt.indexBy.length - 1 ? ',' : '';
      lines.push(`${indent}${stmt.indexBy[i]}${comma}`);
    }
  }

  // 8. UNIONS / ОБЪЕДИНИТЬ [ВСЕ]
  if (stmt.unions && stmt.unions.length > 0) {
    for (const union of stmt.unions) {
      lines.push('');
      lines.push(
        union.unionType === 'UnionAll' ? 'ОБЪЕДИНИТЬ ВСЕ' : 'ОБЪЕДИНИТЬ'
      );
      lines.push('');
      lines.push(formatSelect(union.statement, indent, newline));
    }
  }

  // 9. ORDER BY / УПОРЯДОЧИТЬ ПО
  if (stmt.orderBy && stmt.orderBy.length > 0) {
    lines.push('УПОРЯДОЧИТЬ ПО');
    for (let i = 0; i < stmt.orderBy.length; i++) {
      const orderItem = stmt.orderBy[i];
      let itemStr = formatExpression(orderItem.expression, indent, newline);
      if (orderItem.direction === 'Asc') {
        itemStr += ' ВОЗР';
      } else if (orderItem.direction === 'Desc') {
        itemStr += ' УБЫВ';
      }
      const comma = i < stmt.orderBy.length - 1 ? ',' : '';
      lines.push(`${indent}${itemStr}${comma}`);
    }
  }

  // 10. AUTOORDER / АВТОУПОРЯДОЧИВАНИЕ
  if (stmt.autoOrder) {
    lines.push('АВТОУПОРЯДОЧИВАНИЕ');
  }

  // 11. TOTALS / ИТОГИ
  if (
    !stmt.into &&
    stmt.totals &&
    (stmt.totals.overall ||
      (stmt.totals.fields && stmt.totals.fields.length > 0) ||
      (stmt.totals.by && stmt.totals.by.length > 0))
  ) {
    lines.push(...formatTotals(stmt.totals, indent, newline));
  }

  // 12. FOR UPDATE / ДЛЯ ИЗМЕНЕНИЯ
  if (stmt.forUpdate) {
    if (stmt.forUpdateTables && stmt.forUpdateTables.length > 0) {
      lines.push(`ДЛЯ ИЗМЕНЕНИЯ ${stmt.forUpdateTables.join(', ')}`);
    } else {
      lines.push('ДЛЯ ИЗМЕНЕНИЯ');
    }
  }

  return lines.join(newline);
}

/**
 * Formats TableOrSubquery for FROM and JOIN clauses.
 */
function formatTableOrSubquery(
  source: TableOrSubquery,
  indent: string,
  newline: string
): string {
  if (source.type === 'Table') {
    let name = source.name;
    if (source.params !== undefined) {
      const paramsStr = source.params
        .map((p) => formatExpression(p, indent, newline))
        .join(', ');
      name += `(${paramsStr})`;
    }
    return name;
  }

  // Subquery: (ВЫБРАТЬ ...)
  const subqueryStr = formatSelect(source.query, indent, newline);
  return `(${subqueryStr})`;
}

/**
 * Returns the localized Russian keyword for a join type.
 */
function getJoinKeyword(joinType: 'Left' | 'Right' | 'Full' | 'Inner'): string {
  switch (joinType) {
    case 'Left':
      return 'ЛЕВОЕ СОЕДИНЕНИЕ';
    case 'Right':
      return 'ПРАВОЕ СОЕДИНЕНИЕ';
    case 'Full':
      return 'ПОЛНОЕ СОЕДИНЕНИЕ';
    case 'Inner':
      return 'ВНУТРЕННЕЕ СОЕДИНЕНИЕ';
  }
}

/**
 * Formats TotalsClause (ИТОГИ ... ПО ...).
 */
function formatTotals(
  totals: TotalsClause,
  indent: string,
  newline: string
): string[] {
  const hasFields = Boolean(totals.fields && totals.fields.length > 0);
  const hasBy = Boolean(totals.by && totals.by.length > 0);
  const hasOverall = Boolean(totals.overall);
  if (!hasFields && !hasBy && !hasOverall) {
    return [];
  }

  const lines: string[] = ['ИТОГИ'];

  if (totals.fields && totals.fields.length > 0) {
    for (let i = 0; i < totals.fields.length; i++) {
      const f = totals.fields[i];
      let fStr = formatExpression(f.expression, indent, newline);
      if (f.alias) {
        fStr += ` КАК ${f.alias}`;
      }
      const comma = i < totals.fields.length - 1 ? ',' : '';
      lines.push(`${indent}${fStr}${comma}`);
    }
  }

  lines.push('ПО');

  const byItems: string[] = [];
  if (totals.overall) {
    byItems.push('ОБЩИЕ');
  }

  if (totals.by) {
    for (const item of totals.by) {
      let bStr = formatExpression(item.expression, indent, newline);
      if (item.hierarchy) {
        if (item.hierarchyType === 'OnlyHierarchy') {
          bStr += ' ТОЛЬКО ИЕРАРХИЯ';
        } else {
          bStr += ' ИЕРАРХИЯ';
        }
      }
      const hasPeriods = item.periods !== false && Boolean(item.periods || item.period);
      if (hasPeriods && item.periodDefinition) {
        const def = item.periodDefinition;
        const pType = def.periodType ?? '';
        const fromStr = def.from ? formatExpression(def.from, indent, newline) : '';
        const toStr = def.to ? formatExpression(def.to, indent, newline) : '';

        let paramsStr = pType;
        if (toStr) {
          paramsStr += `, ${fromStr ? fromStr + ', ' : ','}${toStr}`;
        } else if (fromStr) {
          paramsStr += `, ${fromStr},`;
        } else {
          paramsStr += ',,';
        }
        bStr += ` ПЕРИОДАМИ(${paramsStr})`;
      } else if (hasPeriods) {
        bStr += ' ПЕРИОДАМИ';
      }
      byItems.push(bStr);
    }
  }

  for (let i = 0; i < byItems.length; i++) {
    const comma = i < byItems.length - 1 ? ',' : '';
    lines.push(`${indent}${byItems[i]}${comma}`);
  }

  return lines;
}

/**
 * Flattens nested binary AND / OR conditions for multiline WHERE / HAVING formatting.
 */
interface FlatCondition {
  op?: 'И' | 'ИЛИ';
  expr: ExpressionNode;
}

function isOrOp(op: string): boolean {
  const u = op.toUpperCase();
  return u === 'OR' || u === 'ИЛИ';
}

function isAndOp(op: string): boolean {
  const u = op.toUpperCase();
  return u === 'AND' || u === 'И';
}

function wrapConditionIfOr(cond: { str: string; expr?: ExpressionNode }): string {
  const trimmed = cond.str.trim();
  if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
    let depth = 0;
    let balanced = true;
    for (let i = 0; i < trimmed.length - 1; i++) {
      if (trimmed[i] === '(') {
        depth++;
      } else if (trimmed[i] === ')') {
        depth--;
      }
      if (depth === 0) {
        balanced = false;
        break;
      }
    }
    if (balanced) {
      return trimmed;
    }
  }
  if (cond.expr && cond.expr.type === 'BinaryOp' && isOrOp(cond.expr.operator)) {
    return `(${trimmed})`;
  }
  let d = 0;
  let inQuote = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '"') {
      if (inQuote && i + 1 < trimmed.length && trimmed[i + 1] === '"') {
        i++;
      } else {
        inQuote = !inQuote;
      }
    } else if (!inQuote) {
      if (ch === '(') {
        d++;
      } else if (ch === ')') {
        d--;
      } else if (d === 0) {
        const rest = trimmed.substring(i);
        if (/^(?:ИЛИ|OR)(?:$|[^a-zA-Z0-9а-яА-ЯёЁ_])/i.test(rest)) {
          return `(${trimmed})`;
        }
      }
    }
  }
  return trimmed;
}

function flattenConditions(
  node: ExpressionNode,
  parentOp?: string
): FlatCondition[] {
  if (
    node.type === 'BinaryOp' &&
    (isAndOp(node.operator) || isOrOp(node.operator))
  ) {
    // Do not flatten OR if inside AND!
    if (parentOp && isAndOp(parentOp) && isOrOp(node.operator)) {
      return [{ expr: node }];
    }

    const currentOp = node.operator;
    const leftItems = flattenConditions(node.left, currentOp);
    const rightOp: 'И' | 'ИЛИ' = isAndOp(currentOp) ? 'И' : 'ИЛИ';

    if (
      node.right.type === 'BinaryOp' &&
      ((isAndOp(currentOp) && isAndOp(node.right.operator)) ||
        (isOrOp(currentOp) && isOrOp(node.right.operator)))
    ) {
      const rightItems = flattenConditions(node.right, currentOp);
      return [
        ...leftItems,
        { op: rightOp, expr: rightItems[0].expr },
        ...rightItems.slice(1),
      ];
    }

    return [...leftItems, { op: rightOp, expr: node.right }];
  }

  return [{ expr: node }];
}

/**
 * Operator precedence definitions.
 */
function getOperatorPrecedence(expr: ExpressionNode): number {
  switch (expr.type) {
    case 'Identifier':
    case 'CompoundIdentifier':
    case 'Literal':
    case 'Parameter':
    case 'FunctionCall':
    case 'Aggregate':
    case 'CaseWhen':
    case 'RawExpression':
      return 100;
    case 'UnaryOp':
      return expr.operator === 'NOT' ? 40 : 80;
    case 'BinaryOp': {
      const op = expr.operator.toUpperCase();
      if (op === '*' || op === '/') {
        return 70;
      }
      if (op === '+' || op === '-') {
        return 60;
      }
      if (
        op === '=' ||
        op === '<>' ||
        op === '<' ||
        op === '<=' ||
        op === '>' ||
        op === '>=' ||
        op === 'REFS' ||
        op === 'IS NULL' ||
        op === 'IS NOT NULL'
      ) {
        return 50;
      }
      if (op === 'AND' || op === 'И') {
        return 30;
      }
      if (op === 'OR' || op === 'ИЛИ') {
        return 20;
      }
      return 50;
    }
    case 'In':
    case 'Between':
    case 'Like':
      return 50;
    default:
      return 100;
  }
}

/**
 * Formats an expression node into a string.
 */
export function formatExpression(
  expr: ExpressionNode | string,
  indent = DEFAULT_INDENT,
  newline = DEFAULT_NEWLINE
): string {
  if (typeof expr === 'string') {
    return expr;
  }
  if (!expr || typeof expr !== 'object') {
    return '';
  }
  return formatSubExpression(expr, 0, indent, newline);
}

/**
 * Formats a sub-expression, adding parentheses if its precedence is lower than parentPrecedence.
 */
function formatSubExpression(
  expr: ExpressionNode | string,
  parentPrecedence: number,
  indent: string,
  newline: string
): string {
  if (typeof expr === 'string') {
    return expr;
  }
  if (!expr || typeof expr !== 'object') {
    return '';
  }
  const currentPrecedence = getOperatorPrecedence(expr);
  const formatted = formatExpressionCore(expr, indent, newline);

  if (currentPrecedence < parentPrecedence) {
    return `(${formatted})`;
  }
  return formatted;
}

/**
 * Core expression formatter without precedence wrapping.
 */
function formatExpressionCore(
  expr: ExpressionNode,
  indent: string,
  newline: string
): string {
  switch (expr.type) {
    case 'Identifier':
      return expr.name;

    case 'CompoundIdentifier':
      return expr.parts.join('.');

    case 'Parameter':
      return `&${expr.name}`;

    case 'Literal': {
      switch (expr.valueType) {
        case 'number':
          if (expr.raw) {
            return expr.raw;
          }
          return String(expr.value);
        case 'boolean':
          return expr.value ? 'ИСТИНА' : 'ЛОЖЬ';
        case 'null':
          if (expr.raw === '') {
            return '';
          }
          if (expr.value === undefined) {
            return 'НЕОПРЕДЕЛЕНО';
          }
          return 'NULL';
        case 'string':
          if (
            typeof expr.raw === 'string' &&
            expr.raw.startsWith('"') &&
            expr.raw.endsWith('"')
          ) {
            return expr.raw;
          }
          return `"${String(expr.value ?? '').replace(/"/g, '""')}"`;
        case 'date':
          if (expr.raw) {
            return expr.raw;
          }
          return String(expr.value);
        default:
          return expr.raw ?? String(expr.value);
      }
    }

    case 'FunctionCall': {
      const upperName = expr.name.toUpperCase();
      if (upperName === 'ВЫРАЗИТЬ' || upperName === 'CAST') {
        const valExpr = formatExpression(expr.args[0], indent, newline);
        const typeExpr = formatExpression(expr.args[1], indent, newline);
        return `ВЫРАЗИТЬ(${valExpr} КАК ${typeExpr})`;
      }
      const argsStr = expr.args
        .map((arg) => formatExpression(arg, indent, newline))
        .join(', ');
      return `${expr.name}(${argsStr})`;
    }

    case 'Aggregate': {
      let aggName: string;
      switch (expr.aggregateType) {
        case 'Sum':
          aggName = 'СУММА';
          break;
        case 'Count':
          aggName = 'КОЛИЧЕСТВО';
          break;
        case 'Avg':
          aggName = 'СРЕДНЕЕ';
          break;
        case 'Min':
          aggName = 'МИНИМУМ';
          break;
        case 'Max':
          aggName = 'МАКСИМУМ';
          break;
      }
      const distinctStr = expr.distinct ? 'РАЗЛИЧНЫЕ ' : '';
      const innerStr = formatExpression(expr.expression, indent, newline);
      return `${aggName}(${distinctStr}${innerStr})`;
    }

    case 'CaseWhen': {
      const casesStr = expr.cases
        .map((c) => {
          const whenStr = formatExpression(c.when, indent, newline);
          const thenStr = formatExpression(c.then, indent, newline);
          return `КОГДА ${whenStr} ТОГДА ${thenStr}`;
        })
        .join(' ');
      const elseStr = expr.else
        ? ` ИНАЧЕ ${formatExpression(expr.else, indent, newline)}`
        : '';
      return `ВЫБОР ${casesStr}${elseStr} КОНЕЦ`;
    }

    case 'BinaryOp': {
      const op = expr.operator.toUpperCase();
      if (op === 'IS NULL') {
        const leftStr = formatSubExpression(expr.left, 50, indent, newline);
        return `${leftStr} ЕСТЬ NULL`;
      }
      if (op === 'IS NOT NULL') {
        const leftStr = formatSubExpression(expr.left, 50, indent, newline);
        return `${leftStr} ЕСТЬ НЕ NULL`;
      }
      if (op === 'REFS') {
        const leftStr = formatSubExpression(expr.left, 50, indent, newline);
        const rightStr = formatSubExpression(expr.right, 50, indent, newline);
        return `${leftStr} ССЫЛКА ${rightStr}`;
      }
      if (op === 'AND' || op === 'И') {
        const leftStr = formatSubExpression(expr.left, 30, indent, newline);
        const rightStr = formatSubExpression(expr.right, 31, indent, newline);
        return `${leftStr} И ${rightStr}`;
      }
      if (op === 'OR' || op === 'ИЛИ') {
        const leftStr = formatSubExpression(expr.left, 20, indent, newline);
        const rightStr = formatSubExpression(expr.right, 21, indent, newline);
        return `${leftStr} ИЛИ ${rightStr}`;
      }

      let prec = 50;
      if (expr.operator === '*' || expr.operator === '/') {
        prec = 70;
      } else if (expr.operator === '+' || expr.operator === '-') {
        prec = 60;
      }

      const leftStr = formatSubExpression(expr.left, prec, indent, newline);
      const rightStr = formatSubExpression(expr.right, prec + 1, indent, newline);
      return `${leftStr} ${expr.operator} ${rightStr}`;
    }

    case 'UnaryOp': {
      const op = expr.operator.toUpperCase();
      if (op === 'NOT') {
        const operandStr = formatSubExpression(expr.operand, 40, indent, newline);
        return `НЕ ${operandStr}`;
      }
      const operandStr = formatSubExpression(expr.operand, 80, indent, newline);
      return `${expr.operator}${operandStr}`;
    }

    case 'In': {
      const leftStr = formatSubExpression(expr.expression, 50, indent, newline);
      const notStr = expr.not ? 'НЕ ' : '';
      const hierStr = expr.inHierarchy ? 'В ИЕРАРХИИ' : 'В';
      let valuesStr: string;

      if (Array.isArray(expr.values)) {
        valuesStr = expr.values
          .map((v) => formatExpression(v, indent, newline))
          .join(', ');
      } else {
        valuesStr = formatSelect(expr.values, indent, newline);
      }
      return `${leftStr} ${notStr}${hierStr} (${valuesStr})`;
    }

    case 'Between': {
      const leftStr = formatSubExpression(expr.expression, 50, indent, newline);
      const notStr = expr.not ? 'НЕ ' : '';
      const fromStr = formatExpression(expr.from, indent, newline);
      const toStr = formatExpression(expr.to, indent, newline);
      return `${leftStr} ${notStr}МЕЖДУ ${fromStr} И ${toStr}`;
    }

    case 'Like': {
      const leftStr = formatSubExpression(expr.expression, 50, indent, newline);
      const notStr = expr.not ? 'НЕ ' : '';
      const patStr = formatExpression(expr.pattern, indent, newline);
      const escStr = expr.escape
        ? ` СПЕЦСИМВОЛ ${formatExpression(expr.escape, indent, newline)}`
        : '';
      return `${leftStr} ${notStr}ПОДОБНО ${patStr}${escStr}`;
    }

    case 'RawExpression':
      return expr.raw;

    default:
      return '';
  }
}

/**
 * Formats an AST or raw SDBL string into a BSL multiline string literal.
 * E.g.
 * "ВЫБРАТЬ
 * |\tПоле КАК Поле
 * |ИЗ
 * |\tСправочник.Номенклатура КАК Номенклатура"
 */
export function formatToBslLiteral(
  pkg: QueryPackage | string,
  options?: SdblFormatOptions
): string {
  const text = typeof pkg === 'string' ? pkg : formatSdbl(pkg, options);
  const lines = text.split(/\r?\n/);
  const formatted = lines
    .map((line, idx) => {
      const escaped = line.replace(/"/g, '""');
      return idx === 0 ? `"${escaped}` : `|${escaped}`;
    })
    .join('\n');
  return `${formatted}"`;
}

/**
 * Traverses all AST nodes and extracts unique, sorted query parameter names (without '&').
 */
export function extractParameters(pkg: QueryPackage): string[] {
  const params = new Set<string>();

  function collectFromExpr(expr: ExpressionNode | string | undefined) {
    if (!expr) {return;}
    if (typeof expr === 'string') {
      const matches = expr.matchAll(/&([a-zA-Zа-яА-ЯёЁ_][a-zA-Zа-яА-ЯёЁ0-9_]*)/g);
      for (const m of matches) {
        params.add(m[1]);
      }
      return;
    }
    switch (expr.type) {
      case 'Parameter':
        params.add(expr.name);
        break;
      case 'BinaryOp':
        collectFromExpr(expr.left);
        collectFromExpr(expr.right);
        break;
      case 'UnaryOp':
        collectFromExpr(expr.operand);
        break;
      case 'FunctionCall':
        expr.args.forEach(collectFromExpr);
        break;
      case 'Aggregate':
        collectFromExpr(expr.expression);
        break;
      case 'CaseWhen':
        expr.cases.forEach((c) => {
          collectFromExpr(c.when);
          collectFromExpr(c.then);
        });
        if (expr.else) {collectFromExpr(expr.else);}
        break;
      case 'In':
        collectFromExpr(expr.expression);
        if (Array.isArray(expr.values)) {
          expr.values.forEach(collectFromExpr);
        } else {
          collectFromSelect(expr.values);
        }
        break;
      case 'Between':
        collectFromExpr(expr.expression);
        collectFromExpr(expr.from);
        collectFromExpr(expr.to);
        break;
      case 'Like':
        collectFromExpr(expr.expression);
        collectFromExpr(expr.pattern);
        if (expr.escape) {collectFromExpr(expr.escape);}
        break;
      case 'RawExpression':
        if (expr.raw) {
          collectFromExpr(expr.raw);
        }
        break;
    }
  }

  function collectFromTableSource(source: TableOrSubquery | undefined) {
    if (!source) {return;}
    if (source.type === 'Table' && source.params) {
      source.params.forEach(collectFromExpr);
    } else if (source.type === 'Subquery' && source.query) {
      collectFromSelect(source.query);
    }
  }

  function collectFromSelect(stmt: SelectStatement) {
    if (!stmt) {return;}
    stmt.fields?.forEach((f) => {
      collectFromExpr(f.expression);
    });

    stmt.from?.forEach((fc) => {
      collectFromTableSource(fc.source);
      fc.joins?.forEach((j) => {
        collectFromTableSource(j.source);
        collectFromExpr(j.on);
      });
    });

    if (stmt.where) {collectFromExpr(stmt.where);}
    stmt.groupBy?.forEach(collectFromExpr);
    if (stmt.having) {collectFromExpr(stmt.having);}
    stmt.unions?.forEach((u) => collectFromSelect(u.statement));
    stmt.orderBy?.forEach((o) => collectFromExpr(o.expression));
    if (stmt.totals) {
      stmt.totals.fields?.forEach((f) => collectFromExpr(f.expression));
      stmt.totals.by?.forEach((b) => {
        collectFromExpr(b.expression);
        if (b.periodDefinition?.from) {
          collectFromExpr(b.periodDefinition.from);
        }
        if (b.periodDefinition?.to) {
          collectFromExpr(b.periodDefinition.to);
        }
      });
    }
  }

  for (const q of pkg.queries) {
    if (q.type === 'Select') {
      collectFromSelect(q);
    }
  }

  return Array.from(params).sort((a, b) => a.localeCompare(b));
}
