/* eslint-disable @typescript-eslint/no-explicit-any -- walks AST nodes of every shape as plain JSON */

/** Canonical semantics, excluding editor state and literal spelling. */
export function semanticAst(value: any): any {
  if (Array.isArray(value)) {return value.map(semanticAst);}
  if (!value || typeof value !== 'object') {return value;}
  if (value.type === 'Literal') {
    return { type: 'Literal', valueType: value.valueType,
      value: value.valueType === 'null' && /^(UNDEFINED|НЕОПРЕДЕЛЕНО)$/i.test(value.raw || '')
        ? { undefined: true } : value.value ?? null,
      omitted: value.raw === '' ? true : undefined };
  }
  const result: any = {};
  for (const key of Object.keys(value).sort()) {
    if (key.startsWith('_') || ['whereConditions', 'havingConditions', 't1', 'isCustom', 'isVirtual'].includes(key)
        || key === 'raw' && (value.type === 'Literal' || !value.type && 'expression' in value)) {continue;}
    if (Array.isArray(value[key]) && !value[key].length
        && ['from', 'joins', 'groupBy', 'unions', 'orderBy', 'indexBy', 'forUpdateTables', 'extensions'].includes(key)) {continue;}
    if (value[key] === false && ['allowed', 'distinct', 'forUpdate', 'autoOrder', 'optional', 'optionalEnd', 'inHierarchy'].includes(key)) {continue;}
    if (value[key] !== undefined) {result[key] = semanticAst(value[key]);}
  }
  if (result.type === 'FunctionCall' && /^(CAST|ВЫРАЗИТЬ)$/i.test(result.name)) {result.name = 'CAST';}
  if (['In', 'Between', 'Like'].includes(result.type)) {
    const negative = result.not; delete result.not;
    if (negative) {return { type: 'UnaryOp', operator: 'NOT', operand: result };}
  }
  if (result.type === 'BinaryOp' && result.operator === 'IS NOT NULL') {
    return { type: 'UnaryOp', operator: 'NOT', operand: { ...result, operator: 'IS NULL' } };
  }
  if (result.type === 'BinaryOp' && ['AND', 'OR'].includes(result.operator)) {
    return { type: 'BooleanChain', operator: result.operator,
      operands: [result.left, result.right].flatMap(x =>
        x?.type === 'BooleanChain' && x.operator === result.operator ? x.operands : [x]) };
  }
  return result;
}

export function semanticallyEqual(left: any, right: any): boolean {
  return semanticKey(left) === semanticKey(right);
}

export function semanticKey(value: any): string {
  return JSON.stringify(semanticAst(value), (_, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}
