import type { QueryPackage, SelectStatement, SelectedField, ExpressionNode, FromClause } from './sdblAst';
import { formatExpression, normalizeUnionColumns } from './sdblFormatter';
import { getAllTablesFromClauses, hasRuntimeColumns } from './sdblAstVisitor';

// The queries of a union have as many fields each. A field written into one
// of them gets NULL in the others, as in the Designer, at its own place: the
// place is read from the previous package (which field was added or removed),
// else from the field names the queries share; when neither tells it, the
// missing fields go to the end.

function nullField(): SelectedField {
  return { expression: { type: 'Literal', valueType: 'null', value: null, raw: 'NULL' } as ExpressionNode };
}

function expressionText(field: SelectedField): string {
  const expression = field.expression;
  return (typeof expression === 'string' ? expression : formatExpression(expression as ExpressionNode))
    .replace(/\s+/g, ' ').trim();
}

// The name a field gets without an alias: the field path without its table.
function defaultName(field: SelectedField, branch: SelectStatement): string {
  if (field.alias) {return field.alias;}
  const text = expressionText(field);
  if (!/^[\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*$/u.test(text)) {return '';}
  const parts = text.split('.');
  const owner = parts[0].toLowerCase();
  if (parts.length > 1 && getAllTablesFromClauses(branch.from).some(t =>
      String(t.alias || (t.source && 'name' in t.source ? String(t.source.name).split('.').pop() : '')).toLowerCase() === owner))
    {parts.shift();}
  return parts.join('');
}

function matchedPairs(a: string[], b: string[]): Array<[number, number]> {
  const table: number[][] = [];
  for (let i = 0; i <= a.length; i++) {table.push(new Array(b.length + 1).fill(0));}
  for (let i = a.length - 1; i >= 0; i--) {for (let j = b.length - 1; j >= 0; j--)
    {table[i][j] = a[i] && a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);}}
  const pairs: Array<[number, number]> = [];
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] && a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) {i++;}
    else {j++;}
  }
  return pairs;
}

// Places of the longer list that the shorter one lacks, when every item of
// the shorter list is found in it in order.
function missingPlaces(shorter: string[], longer: string[]): number[] | null {
  const pairs = matchedPairs(shorter, longer);
  if (pairs.length !== shorter.length) {return null;}
  const matched = new Set(pairs.map(pair => pair[1]));
  const places: number[] = [];
  for (let i = 0; i < longer.length; i++) {if (!matched.has(i)) {places.push(i);}}
  return places;
}

const expressionKeys = (branch: SelectStatement) => (branch.fields || []).map(f => expressionText(f).toLowerCase());
const nameKeys = (branch: SelectStatement) => (branch.fields || []).map(f => defaultName(f, branch).toLowerCase());
const branchesOf = (stmt: SelectStatement) =>
  [stmt].concat((stmt.unions || []).map(u => u.statement)).filter(Boolean) as SelectStatement[];

function alignStatement(owner: SelectStatement, previous: SelectStatement | null): void {
  if (!owner.unions || !owner.unions.length) {return;}
  if (hasRuntimeColumns(owner) || owner.unions.some(u => hasRuntimeColumns(u.statement))) {return;}
  const branches = branchesOf(owner);
  branches.forEach(b => { if (!b.fields) {b.fields = [];} });
  const width = Math.max(...branches.map(b => b.fields.length));
  if (branches.every(b => b.fields.length === width)) {return;}
  const before = previous && (previous.unions || []).length === owner.unions.length ? branchesOf(previous) : null;
  const widest = branches.filter(b => b.fields.length === width);
  // The widest query that changed since the previous text is the one written into.
  const reference = widest.find(b => {
    const old = before && before[branches.indexOf(b)];
    return old && (old.fields || []).length !== width;
  }) || widest[0];
  const oldReference = before && before[branches.indexOf(reference)];
  branches.forEach((branch, index) => {
    const count = branch.fields.length;
    if (count === width) {return;}
    const old = before && before[index];
    let places: number[] | null = null;
    // A field removed from this query leaves NULL where it was.
    if (old && (old.fields || []).length === width) {places = missingPlaces(expressionKeys(branch), expressionKeys(old));}
    if (!places && oldReference && (oldReference.fields || []).length === count)
      {places = missingPlaces(expressionKeys(oldReference), expressionKeys(reference));}
    if (!places) {places = missingPlaces(nameKeys(branch), nameKeys(reference));}
    if (!places || places.length !== width - count) {return;}
    for (const place of places) {
      const empty = nullField();
      // The output name belongs to the first query.
      if (branch === owner) {empty.alias = defaultName(reference.fields[place], reference) || undefined;}
      branch.fields.splice(place, 0, empty);
    }
  });
  normalizeUnionColumns(owner);
}

function nestedQueries(stmt: SelectStatement): SelectStatement[] {
  const result: SelectStatement[] = [];
  const walk = (clauses?: FromClause[]) => (clauses || []).forEach(clause => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- clauses and joins share only .source
    [clause, ...(clause.joins || [])].forEach((item: any) => {
      const source = item && item.source;
      if (!source) {return;}
      if (source.type === 'Subquery' && source.query) {result.push(source.query);}
      else if (source.type === 'JoinedTable') {walk(source.clauses);}
    });
  });
  branchesOf(stmt).forEach(branch => walk(branch.from));
  return result;
}

export function alignUnionColumns(pkg: QueryPackage, previous?: QueryPackage | null): void {
  (pkg && pkg.queries || []).forEach((query, index) => {
    if (query.type !== 'Select') {return;}
    const old = previous && previous.queries && previous.queries[index];
    const visit = (stmt: SelectStatement, before: SelectStatement | null) => {
      alignStatement(stmt, before);
      const oldChildren = before ? nestedQueries(before) : [];
      nestedQueries(stmt).forEach((child, childIndex) => visit(child, oldChildren[childIndex] || null));
    };
    visit(query as SelectStatement, old && old.type === 'Select' ? old as SelectStatement : null);
  });
}
