import {
  SdblToken,
  TokenType,
  SdblKeyword,
} from './sdblTokens';
import { tokenizeSdbl } from './sdblTokenizer';
import {
  QueryPackage,
  QueryStatement,
  SelectStatement,
  DropTableStatement,
  SelectedField,
  FromClause,
  JoinClause,
  UnionClause,
  OrderItem,
  TotalsClause,
  TotalsField,
  TotalsGroupItem,
  ExpressionNode,
  TableOrSubquery,
} from './sdblAst';
import { normalizeFromClauses } from './sdblAstVisitor';
import { captureComments } from './sdblComments';

/**
 * Recursive descent parser for SDBL (1C:Enterprise Query Language).
 */
export function parseSdbl(input: string | SdblToken[]): QueryPackage {
  const tokens: SdblToken[] =
    typeof input === 'string'
      ? tokenizeSdbl(input, { includeComments: false, includeEof: true })
      : input.filter((t) => t.type !== TokenType.Comment);

  // Ensure there is an EOF token at the end
  if (tokens.length === 0 || tokens[tokens.length - 1].type !== TokenType.EOF) {
    tokens.push({
      type: TokenType.EOF,
      value: '',
      raw: '',
      line: 0,
      column: 0,
      offset: 0,
    });
  }

  const parser = new SdblParser(tokens, typeof input === 'string' ? input : undefined);
  let pkg: QueryPackage;
  try {
    pkg = parser.parsePackage();
  } catch (error) {
    // Every error names the place the parser stopped at.
    if (error instanceof Error && !(error as SdblParseError).sdblParse) {parser.fail(error.message);}
    throw error;
  }
  if (typeof input === 'string') {captureComments(input, pkg, parser.opaqueRanges);}
  return pkg;
}

/** A parse error with the place of the token the parser stopped at (1-based). */
export interface SdblParseError extends Error {
  sdblParse?: true;
  sdblLine?: number;
  sdblColumn?: number;
  sdblLength?: number;
}

// Words that start or join clauses and conditions are never a name or an
// operand: «ЛЕВОЕ СОЕДИНЕНИЕ И Справочник.Х» is an error at «И», not a table «И»,
// and «ГДЕ А = 1 И СГРУППИРОВАТЬ» is an error at СГРУППИРОВАТЬ, not a field.
// Short operators such as В and the words of ВЫБОР (КОНЕЦ, КОГДА…) stay
// possible names: configurations use them as aliases («Период КАК Конец»).
const RESERVED_KEYWORDS = new Set<string>([
  SdblKeyword.Select, SdblKeyword.From, SdblKeyword.Where, SdblKeyword.And, SdblKeyword.Or,
  SdblKeyword.Not, SdblKeyword.As, SdblKeyword.Left, SdblKeyword.Right, SdblKeyword.Full,
  SdblKeyword.Inner, SdblKeyword.Outer, SdblKeyword.Join, SdblKeyword.On, SdblKeyword.By,
  SdblKeyword.Group, SdblKeyword.Order, SdblKeyword.Union, SdblKeyword.Having, SdblKeyword.Into,
  SdblKeyword.Drop,
]);

// After a dot comes a metadata name, and English ones may coincide with
// keywords (Document.Order): only words that cannot end a path are refused.
const NOT_AFTER_DOT_KEYWORDS = new Set<string>([
  SdblKeyword.As, SdblKeyword.Select, SdblKeyword.From, SdblKeyword.Where, SdblKeyword.Union,
  SdblKeyword.Into, SdblKeyword.Drop, SdblKeyword.Having, SdblKeyword.And, SdblKeyword.Or,
]);

class SdblParser {
  private pos = 0;
  private runtimeTemplate = false;

  public opaqueRanges: Array<[number, number]> = [];
  constructor(private readonly tokens: SdblToken[], private readonly input?: string) {}

  private parseBrace(): string {
    const first = this.peek()!; this.consumeSymbol('{'); let depth = 1; const consumed = [first];
    while (depth && !this.isAtEnd()) {
      const token = this.advance(); consumed.push(token);
      if (token.value === '{') {depth++;}
      else if (token.value === '}') {depth--;}
    }
    if (depth) {this.fail('Незакрытая директива СКД', first);}
    const end = consumed[consumed.length - 1];
    this.opaqueRanges.push([first.offset, end.offset + end.raw.length]);
    return this.input !== undefined ? this.input.slice(first.offset, end.offset + end.raw.length)
      : consumed.map(x => x.raw).join(' ');
  }

  private isBraceClause(): boolean {
    return this.checkSymbol('{') && /^(SELECT|FROM|WHERE|GROUP|ORDER|TOTALS|HAVING|LEFT|RIGHT|INNER|FULL|JOIN|ХАРАКТЕРИСТИКИ)$/i.test(this.peek(1)?.value || '');
  }

  public parsePackage(): QueryPackage {
    const queries: QueryStatement[] = [];

    while (!this.isAtEnd()) {
      // Skip empty semicolons
      if (this.matchSymbol(';')) {
        continue;
      }
      if (this.isAtEnd()) {
        break;
      }

      // Text substituted before a statement (%ТекстЗапроса%ВЫБРАТЬ …).
      const leading: string[] = [];
      while (this.isTemplateFragment() && !this.isAtEnd()) { this.runtimeTemplate = true; leading.push(this.consumeFragment()); }
      if (this.matchKeyword(SdblKeyword.Drop)) {
        queries.push(this.parseDropTable());
      } else if (this.matchKeyword(SdblKeyword.Select)) {
        const statement = this.parseSelectStatement(true);
        if (leading.length) {statement.extensions = leading.map(raw => ({ after: 'beforeSelect', raw }))
          .concat(statement.extensions || []);}
        queries.push(statement);
      } else {
        this.fail('Ожидается ВЫБРАТЬ или УНИЧТОЖИТЬ');
      }

      // Statements are separated by «;»; anything else here is left over.
      if (!this.matchSymbol(';') && !this.isAtEnd()) {
        const tok = this.peek();
        if (this.checkKeyword(SdblKeyword.Select) || this.checkKeyword(SdblKeyword.Drop))
          {this.fail('Между запросами пакета ожидается «;»', tok);}
        if (this.checkSymbol(')')) {this.fail('Лишняя закрывающая скобка', tok);}
        this.fail('Синтаксическая ошибка', tok);
      }
    }

    return { queries, ...(this.runtimeTemplate ? { _runtimeTemplate: true } : {}) };
  }

  // --- DROP TABLE ---

  private parseDropTable(): DropTableStatement {
    // Optional 'TABLE' keyword in English syntax
    if (
      this.checkKeyword(SdblKeyword.Select) === false &&
      this.peek()?.raw.toUpperCase() === 'TABLE'
    ) {
      this.advance();
    }
    const tableName = this.parseCompoundName();
    return {
      type: 'DropTable',
      tableName,
    };
  }

  // --- SELECT STATEMENT ---

  private parseSelectStatement(allowUnions = true): SelectStatement {
    let distinct: boolean | undefined = undefined;
    let allowed: boolean | undefined = undefined;
    let top: number | string | undefined = undefined;
    let forUpdate: boolean | undefined = undefined;
    let forUpdateTables: string[] | undefined = undefined;
    let autoOrder: boolean | undefined = undefined;
    let into: string | undefined = undefined;
    let indexBy: string[] | undefined = undefined;
    let indexSets: string[][] | undefined;

    const extensions: Array<{ after: string; raw: string }> = [];
    // DCS blocks {…} and text substituted at run time (%Отбор%, &ТекстУсловия)
    // stand between sections; both are kept verbatim at their place.
    const extras = (after: string) => {
      for (;;) {
        if (this.checkSymbol('{') && this.isBraceClause()) {extensions.push({ after, raw: this.parseBrace() });}
        else if (this.isTemplateFragment()) { this.runtimeTemplate = true; extensions.push({ after, raw: this.consumeFragment() }); }
        else {break;}
      }
    };

    // Modifiers right after SELECT
    while (!this.isAtEnd()) {
      if (this.matchKeyword(SdblKeyword.Distinct)) {
        distinct = true;
      } else if (this.matchKeyword(SdblKeyword.Allowed)) {
        allowed = true;
      } else if (this.matchKeyword(SdblKeyword.Top)) {
        if (this.peek()?.type === TokenType.Parameter) {top = '&' + this.advance().value;}
        else if (this.checkSymbol('%')) {top = this.consumeTemplateName();}
        else {
          const topTok = this.consume(TokenType.NumberLiteral, 'После ПЕРВЫЕ ожидается целое число');
          if (!/^\d+$/.test(topTok.value)) {this.fail('После ПЕРВЫЕ ожидается целое число', topTok);}
          top = Number(topTok.value);
        }
      } else {
        break;
      }
    }

    // Fields list
    const fields: SelectedField[] = [];
    do {
      fields.push(this.parseSelectedField());
    } while (this.matchSymbol(','));
    {
      const next = this.peek();
      if (next && (next.type === TokenType.Identifier || next.type === TokenType.NumberLiteral
          || next.type === TokenType.StringLiteral
          || next.type === TokenType.Keyword && !this.isReserved(next) && !this.isSectionKeyword(next)
            && [SdblKeyword.Sum, SdblKeyword.Count, SdblKeyword.Max, SdblKeyword.Min, SdblKeyword.Avg,
              SdblKeyword.Case, SdblKeyword.Cast, SdblKeyword.Null, SdblKeyword.True, SdblKeyword.False,
              SdblKeyword.Undefined].includes(next.value as SdblKeyword)))
        {this.fail('Ожидается запятая между полями или ИЗ', next);}
    }

    extras('afterFields');

    // Optional INTO / ПОМЕСТИТЬ before FROM
    if (this.matchKeyword(SdblKeyword.Into)) {
      this.expectName('Ожидается имя временной таблицы'); into = this.consumeTemplateName();
      if (this.matchKeyword(SdblKeyword.Index)) {
        if (!this.matchOnOrBy()) {this.fail('После ИНДЕКСИРОВАТЬ ожидается ПО');}
        { const index = this.parseIndexFields(); indexBy = index.fields; indexSets = index.sets; }
      }
    }

    extras('afterInto');

    // FROM / ИЗ
    let from: FromClause[] | undefined = undefined;
    if (this.matchKeyword(SdblKeyword.From)) {
      from = this.parseFromClauseList();
    }

    extras('afterFrom');

    // Optional INTO / ПОМЕСТИТЬ after FROM
    if (!into && this.matchKeyword(SdblKeyword.Into)) {
      this.expectName('Ожидается имя временной таблицы'); into = this.consumeTemplateName();
      if (this.matchKeyword(SdblKeyword.Index)) {
        if (!this.matchOnOrBy()) {this.fail('После ИНДЕКСИРОВАТЬ ожидается ПО');}
        { const index = this.parseIndexFields(); indexBy = index.fields; indexSets = index.sets; }
      }
    }

    // WHERE / ГДЕ
    let where: ExpressionNode | undefined = undefined;
    if (this.matchKeyword(SdblKeyword.Where)) {
      where = this.parseExpression();
    }

    extras('afterWhere');

    // GROUP BY / СГРУППИРОВАТЬ ПО
    let groupBy: ExpressionNode[] | undefined = undefined;
    if (this.matchKeyword(SdblKeyword.Group)) {
      if (!this.matchOnOrBy()) {this.fail('После СГРУППИРОВАТЬ ожидается ПО');}
      groupBy = [];
      do {
        groupBy.push(this.parseExpression());
      } while (this.matchSymbol(','));
    }

    extras('afterGroupBy');

    // HAVING / ИМЕЮЩИЕ
    let having: ExpressionNode | undefined = undefined;
    if (this.matchKeyword(SdblKeyword.Having)) {
      having = this.parseExpression();
    }

    extras('afterHaving');

    // INDEX BY / ИНДЕКСИРОВАТЬ ПО (canonical position: after FROM, WHERE, GROUP BY, HAVING)
    if (!indexBy && !indexSets && this.matchKeyword(SdblKeyword.Index)) {
      if (!this.matchOnOrBy()) {this.fail('После ИНДЕКСИРОВАТЬ ожидается ПО');}
      { const index = this.parseIndexFields(); indexBy = index.fields; indexSets = index.sets; }
    }

    extras('afterIndex');

    // UNIONS / ОБЪЕДИНИТЬ [ВСЕ]
    let unions: UnionClause[] | undefined = undefined;
    if (allowUnions) {
      while (this.checkKeyword(SdblKeyword.Union)) {
        this.advance(); // consume UNION
        let unionType: 'Union' | 'UnionAll' = 'Union';
        if (this.matchKeyword(SdblKeyword.All)) {
          unionType = 'UnionAll';
        }
        this.consumeKeyword(SdblKeyword.Select, 'После ОБЪЕДИНИТЬ ожидается ВЫБРАТЬ');
        const statement = this.parseSelectStatement(false);
        if (!unions) {
          unions = [];
        }
        unions.push({ unionType, statement });
      }
    }

    extras('afterUnions');

    // ORDER BY / УПОРЯДОЧИТЬ ПО
    let orderBy: OrderItem[] | undefined = undefined;
    if (this.matchKeyword(SdblKeyword.Order)) {
      if (!this.matchOnOrBy()) {this.fail('После УПОРЯДОЧИТЬ ожидается ПО');}
      orderBy = [];
      do {
        if (this.matchKeyword(SdblKeyword.Autoorder)) {
          autoOrder = true;
          break;
        }
        const expr = this.parseExpression();
        let direction: 'Asc' | 'Desc' | undefined = undefined;
        const hierarchy = this.matchKeyword(SdblKeyword.Hierarchy) || undefined;
        if (this.matchKeyword(SdblKeyword.Asc)) {
          direction = 'Asc';
        } else if (this.matchKeyword(SdblKeyword.Desc)) {
          direction = 'Desc';
        }
        orderBy.push(hierarchy ? { expression: expr, direction, hierarchy } : { expression: expr, direction });

        if (this.matchKeyword(SdblKeyword.Autoorder)) {
          autoOrder = true;
        }
      } while (this.matchSymbol(','));
    }

    extras('afterOrderBy');

    // TOTALS / ИТОГИ; АВТОУПОРЯДОЧИВАНИЕ may stand before them without ORDER BY.
    if (this.matchKeyword(SdblKeyword.Autoorder)) {
      autoOrder = true;
    }
    let totals: TotalsClause | undefined = undefined;
    if (this.matchKeyword(SdblKeyword.Totals)) {
      totals = this.parseTotalsClause();
    }

    // Trailing AUTOORDER
    if (this.matchKeyword(SdblKeyword.Autoorder)) {
      autoOrder = true;
    }

    extras('afterTotals');

    // Trailing FOR UPDATE / ДЛЯ ИЗМЕНЕНИЯ
    if (this.matchKeyword(SdblKeyword.ForUpdate)) {
      forUpdate = true;
      if (this.isTableIdentifierStart()) {
        const tableNames: string[] = [];
        do {
          tableNames.push(this.parseCompoundName());
        } while (this.matchSymbol(','));
        if (tableNames.length > 0) {
          forUpdateTables = tableNames;
        }
      }
    }

    // Trailing AUTOORDER (if after FOR UPDATE)
    if (this.matchKeyword(SdblKeyword.Autoorder)) {
      autoOrder = true;
    }

    if (!indexBy && !indexSets && this.matchKeyword(SdblKeyword.Index)) {
      if (!this.matchOnOrBy()) {this.fail('После ИНДЕКСИРОВАТЬ ожидается ПО');} const index = this.parseIndexFields(); indexBy = index.fields; indexSets = index.sets;
    }
    extras('end');
    const selectStmt: SelectStatement = {
      type: 'Select',
      fields,
    };
    if (extensions.length) {selectStmt.extensions = extensions;}
    if (distinct !== undefined) {selectStmt.distinct = distinct;}
    if (allowed !== undefined) {selectStmt.allowed = allowed;}
    if (top !== undefined) {selectStmt.top = top;}
    if (forUpdate !== undefined) {selectStmt.forUpdate = forUpdate;}
    if (forUpdateTables !== undefined && forUpdateTables.length > 0) {
      selectStmt.forUpdateTables = forUpdateTables;
    }
    if (autoOrder !== undefined) {selectStmt.autoOrder = autoOrder;}
    if (into !== undefined) {selectStmt.into = into;}
    if (indexBy !== undefined) {selectStmt.indexBy = indexBy;}
    if (indexSets) {selectStmt.indexSets = indexSets;}
    if (from !== undefined) {selectStmt.from = from;}
    if (where !== undefined) {selectStmt.where = where;}
    if (groupBy !== undefined) {selectStmt.groupBy = groupBy;}
    if (having !== undefined) {selectStmt.having = having;}
    if (unions !== undefined) {selectStmt.unions = unions;}
    if (orderBy !== undefined) {selectStmt.orderBy = orderBy;}
    if (totals !== undefined) {selectStmt.totals = totals;}

    return selectStmt;
  }

  private parseIndexFields(): { fields?: string[]; sets?: string[][] } {
    if (/^(НАБОРАМ|SETS)$/i.test(this.peek()?.raw || '')) {
      this.advance(); this.consumeSymbol('('); const sets: string[][] = [];
      do {
        this.consumeSymbol('('); const fields: string[] = [];
        do { fields.push(this.parseCompoundName()); } while (this.matchSymbol(','));
        this.consumeSymbol(')'); sets.push(fields);
      } while (this.matchSymbol(','));
      this.consumeSymbol(')'); return { sets };
    }
    const fields: string[] = [];
    do {
      fields.push(this.parseCompoundName());
    } while (this.matchSymbol(','));
    return { fields };
  }

  // --- FIELDS ---

  private parseSelectedField(): SelectedField {
    let expression: ExpressionNode;
    if (this.matchSymbol('*')) {
      expression = { type: 'Identifier', name: '*' };
    } else {
      expression = this.parseExpression();
    }

    let alias: string | undefined = undefined;
    // An alias may be substituted at run time too: КАК %Псевдоним%.
    if (this.matchKeyword(SdblKeyword.As)) {
      this.expectName('Ожидается псевдоним после КАК'); alias = this.consumeTemplateName();
    } else if (this.isPotentialAlias()) {
      alias = this.consumeTemplateName();
    }

    return { expression, alias };
  }

  private isNonAliasKeyword(tok: SdblToken): boolean {
    if (tok.type === TokenType.Keyword) {
      const kw = tok.value as SdblKeyword;
      return (
        kw === SdblKeyword.On ||
        kw === SdblKeyword.By ||
        kw === SdblKeyword.Join ||
        kw === SdblKeyword.Left ||
        kw === SdblKeyword.Right ||
        kw === SdblKeyword.Full ||
        kw === SdblKeyword.Inner ||
        kw === SdblKeyword.Outer ||
        kw === SdblKeyword.As
      );
    }
    const rawUpper = tok.raw.toUpperCase();
    return rawUpper === 'ПО' || rawUpper === 'ON' || rawUpper === 'BY';
  }

  private isPotentialAlias(): boolean {
    const tok = this.peek();
    if (!tok) {return false;}
    if (tok.type !== TokenType.Identifier && tok.type !== TokenType.Keyword) {
      return false;
    }
    if (this.isSectionKeyword(tok) || this.isJoinStart() || this.isNonAliasKeyword(tok)) {
      return false;
    }
    return true;
  }

  // --- FROM AND JOINS ---

  private parseFromClauseList(): FromClause[] {
    const list: FromClause[] = [];
    do {
      const source = this.parseTableOrSubquery();
      let alias: string | undefined = undefined;
      if (this.matchKeyword(SdblKeyword.As)) {
        this.expectName('Ожидается псевдоним после КАК'); alias = this.consumeTemplateName();
      } else if (this.isPotentialFromAlias()) {
        alias = this.consumeTemplateName();
      }

      const joins: JoinClause[] = [];
      while (this.isJoinStart()) {
        joins.push(...this.parseJoinSequence());
      }

      // The platform takes a comma before a join as nothing: «А КАК А, ЛЕВОЕ
      // СОЕДИНЕНИЕ Б …» joins Б to А, and typical configurations write so.
      while (this.checkSymbol(',')) {
        this.advance();
        if (!this.isJoinStart()) { this.pos--; break; }
        while (this.isJoinStart()) {joins.push(...this.parseJoinSequence());}
      }

      list.push({
        source,
        alias,
        joins: joins.length > 0 ? joins : undefined,
      });
    } while (this.matchSymbol(','));

    return normalizeFromClauses(list);
  }

  private isPotentialFromAlias(): boolean {
    const tok = this.peek();
    if (!tok) {return false;}
    if (tok.type !== TokenType.Identifier && tok.type !== TokenType.Keyword) {
      return false;
    }
    if (this.isJoinStart() || this.isSectionKeyword(tok) || this.isNonAliasKeyword(tok)) {
      return false;
    }
    return true;
  }

  private parseTableOrSubquery(): TableOrSubquery {
    const first = this.peek();
    if (!first || first.type === TokenType.EOF
        || this.isReserved(first))
      {this.fail('Ожидается имя таблицы', first);}
    if (this.matchSymbol('(')) {
      if (this.checkKeyword(SdblKeyword.Select)) {
        this.advance(); // consume SELECT
        const query = this.parseSelectStatement(true);
        this.consumeSymbol(')', 'Ожидается «)» после вложенного запроса');
        return {
          type: 'Subquery',
          query,
        };
      }
      const clauses = this.parseFromClauseList();
      this.consumeSymbol(')', 'Ожидается «)» после соединяемых таблиц');
      return { type: 'JoinedTable', clauses };
    }

    const name = this.peek()?.type === TokenType.Parameter
      ? '&' + this.advance().value : this.parseCompoundName();
    let params: ExpressionNode[] | undefined = undefined;
    if (this.checkSymbol('(')) {
      params = this.parseVirtualTableParams();
    }

    return {
      type: 'Table',
      name,
      params,
    };
  }

  private parseVirtualTableParams(): ExpressionNode[] {
    this.consumeSymbol('(');
    const params: ExpressionNode[] = [];

    if (this.checkSymbol(')')) {
      this.consumeSymbol(')');
      return params;
    }

    while (!this.isAtEnd()) {
      if (this.checkSymbol(',')) {
        // Omitted / empty parameter before comma
        params.push({
          type: 'Literal',
          valueType: 'null',
          value: null,
          raw: '',
        });
        this.advance(); // consume ','
        if (this.checkSymbol(')')) {
          // Trailing empty parameter
          params.push({
            type: 'Literal',
            valueType: 'null',
            value: null,
            raw: '',
          });
          break;
        }
      } else if (this.checkSymbol(')')) {
        break;
      } else {
        params.push(this.parseExpression());
        if (this.matchSymbol(',')) {
          if (this.checkSymbol(')')) {
            // Trailing empty parameter
            params.push({
              type: 'Literal',
              valueType: 'null',
              value: null,
              raw: '',
            });
            break;
          }
        } else {
          break;
        }
      }
    }

    this.consumeSymbol(')', 'Ожидается «)» после параметров виртуальной таблицы');
    return params;
  }

  private isJoinStart(): boolean {
    if (this.checkSymbol('{') && /^(LEFT|RIGHT|FULL|INNER|JOIN)$/.test(this.peek(1)?.value || '')) {return true;}
    const tok = this.peek();
    if (!tok || tok.type !== TokenType.Keyword) {return false;}
    const kw = tok.value as SdblKeyword;
    return (
      kw === SdblKeyword.Left ||
      kw === SdblKeyword.Right ||
      kw === SdblKeyword.Full ||
      kw === SdblKeyword.Inner ||
      kw === SdblKeyword.Join
    );
  }

  private parseJoinSequence(): JoinClause[] {
    if (!this.matchSymbol('{')) {return [this.parseJoinClause()];}
    const joins: JoinClause[] = [];
    do { joins.push(this.parseJoinClause()); } while (this.isJoinStart());
    this.consumeSymbol('}', 'Ожидается «}» после необязательных соединений');
    joins[0].optional = true; joins[joins.length - 1].optionalEnd = true;
    return joins;
  }

  private parseJoinClause(): JoinClause {
    let joinType: 'Left' | 'Right' | 'Full' | 'Inner' = 'Inner';

    if (this.matchKeyword(SdblKeyword.Left)) {
      joinType = 'Left';
      this.matchKeyword(SdblKeyword.Outer);
      this.consumeKeyword(SdblKeyword.Join, 'После ЛЕВОЕ ожидается СОЕДИНЕНИЕ');
    } else if (this.matchKeyword(SdblKeyword.Right)) {
      joinType = 'Right';
      this.matchKeyword(SdblKeyword.Outer);
      this.consumeKeyword(SdblKeyword.Join, 'После ПРАВОЕ ожидается СОЕДИНЕНИЕ');
    } else if (this.matchKeyword(SdblKeyword.Full)) {
      joinType = 'Full';
      this.matchKeyword(SdblKeyword.Outer);
      this.consumeKeyword(SdblKeyword.Join, 'После ПОЛНОЕ ожидается СОЕДИНЕНИЕ');
    } else if (this.matchKeyword(SdblKeyword.Inner)) {
      joinType = 'Inner';
      this.consumeKeyword(SdblKeyword.Join, 'После ВНУТРЕННЕЕ ожидается СОЕДИНЕНИЕ');
    } else if (this.matchKeyword(SdblKeyword.Join)) {
      joinType = 'Inner';
    }

    let source = this.parseTableOrSubquery();
    let alias: string | undefined = undefined;
    if (this.matchKeyword(SdblKeyword.As)) {
      this.expectName('Ожидается псевдоним после КАК'); alias = this.consumeIdentifierOrKeyword();
    } else if (this.isPotentialFromAlias()) {
      alias = this.consumeIdentifierOrKeyword();
    }

    const nested: JoinClause[] = [];
    while (this.isJoinStart()) {nested.push(...this.parseJoinSequence());}
    if (nested.length) {
      source = { type: 'JoinedTable', clauses: [{ source, alias, joins: nested }] };
      alias = undefined;
    }
    if (!this.matchOnOrBy()) {this.fail('Ожидается ПО с условием соединения');}
    const on = this.parseExpression();

    return {
      joinType,
      source,
      alias,
      on,
    };
  }

  // --- TOTALS ---

  private parseTotalsClause(): TotalsClause {
    const fields: TotalsField[] = [];

    // Check if there are aggregate fields before ПО / BY
    if (!this.checkOnOrBy()) {
      do {
        const expr = this.parseExpression();
        let alias: string | undefined = undefined;
        if (this.matchKeyword(SdblKeyword.As)) {
          this.expectName('Ожидается псевдоним после КАК'); alias = this.consumeIdentifierOrKeyword();
        } else if (this.isPotentialAlias()) {
          alias = this.consumeIdentifierOrKeyword();
        }
        fields.push({ expression: expr, alias });
      } while (this.matchSymbol(',') && !this.checkOnOrBy());
    }

    if (this.checkOnOrBy()) {
      this.matchOnOrBy();
    }

    const by: TotalsGroupItem[] = [];
    let overall: boolean | undefined = undefined;

    do {
      const tok = this.peek();
      const rawUpper = tok?.raw.toUpperCase() || '';
      if (rawUpper === 'ОБЩИЕ' || rawUpper === 'OVERALL') {
        overall = true;
        this.advance();
        continue;
      }

      const expr = this.parseExpression();
      let hierarchy: boolean | undefined = undefined;
      let hierarchyType: 'All' | 'OnlyHierarchy' | undefined = undefined;
      let period: boolean | undefined = undefined;
      let periods: boolean | undefined = undefined;
      let periodDefinition:
        | {
            periodType?: string;
            from?: ExpressionNode;
            to?: ExpressionNode;
          }
        | undefined = undefined;

      while (!this.isAtEnd()) {
        if (this.matchKeyword(SdblKeyword.Only)) {
          if (this.matchKeyword(SdblKeyword.Hierarchy)) {
            hierarchy = true;
            hierarchyType = 'OnlyHierarchy';
          }
        } else if (this.matchKeyword(SdblKeyword.Hierarchy)) {
          hierarchy = true;
          hierarchyType = 'All';
        } else {
          const nextRaw = this.peek()?.raw.toUpperCase();
          if (nextRaw === 'ПЕРИОДАМИ' || nextRaw === 'PERIODS') {
            this.advance();
            period = true;
            periods = true;
            if (this.matchSymbol('(')) {
              let periodType: string | undefined = undefined;
              let from: ExpressionNode | undefined = undefined;
              let to: ExpressionNode | undefined = undefined;

              if (!this.checkSymbol(',') && !this.checkSymbol(')')) {
                periodType = this.consumeIdentifierOrKeyword();
              }

              if (this.matchSymbol(',')) {
                if (!this.checkSymbol(',') && !this.checkSymbol(')')) {
                  from = this.parseExpression();
                }

                if (this.matchSymbol(',')) {
                  if (!this.checkSymbol(')')) {
                    to = this.parseExpression();
                  }
                }
              }

              this.consumeSymbol(')', 'Ожидается «)» после параметров ПЕРИОДАМИ');
              periodDefinition = {
                periodType,
                from,
                to,
              };
            }
          } else {
            break;
          }
        }
      }
      let byAlias: string | undefined = undefined;
      if (this.matchKeyword(SdblKeyword.As)) {
        this.expectName('Ожидается псевдоним после КАК'); byAlias = this.consumeIdentifierOrKeyword();
      }

      by.push({
        ...(byAlias ? { alias: byAlias } : {}),
        expression: expr,
        hierarchy,
        hierarchyType,
        period,
        periods,
        periodDefinition,
      });
    } while (this.matchSymbol(','));

    return {
      fields: fields.length > 0 ? fields : undefined,
      by,
      overall,
    };
  }

  // --- EXPRESSIONS ---

  public parseExpression(): ExpressionNode {
    return this.parseOr();
  }

  private parseOr(): ExpressionNode {
    let left = this.parseAnd();
    while (this.matchKeyword(SdblKeyword.Or)) {
      const right = this.parseAnd();
      left = {
        type: 'BinaryOp',
        operator: 'OR',
        left,
        right,
      };
    }
    return left;
  }

  private parseAnd(): ExpressionNode {
    let left = this.parseNot();
    while (this.matchKeyword(SdblKeyword.And)) {
      const right = this.parseNot();
      left = {
        type: 'BinaryOp',
        operator: 'AND',
        left,
        right,
      };
    }
    return left;
  }

  private parseNot(): ExpressionNode {
    // Check for leading standalone NOT (e.g. NOT A = B)
    if (this.checkKeyword(SdblKeyword.Not)) {
      const next = this.peek(1);
      const isNextInBetweenLike =
        next &&
        next.type === TokenType.Keyword &&
        (next.value === SdblKeyword.In ||
          next.value === SdblKeyword.Between ||
          next.value === SdblKeyword.Like);
      if (!isNextInBetweenLike) {
        this.advance(); // consume NOT
        const operand = this.parseNot();
        return {
          type: 'UnaryOp',
          operator: 'NOT',
          operand,
        };
      }
    }
    return this.parseComparison();
  }

  private parseComparison(): ExpressionNode {
    let expr = this.parseAdditive();

    while (!this.isAtEnd()) {
      // Lookahead for NOT IN / NOT BETWEEN / NOT LIKE
      let notFlag = false;
      if (this.checkKeyword(SdblKeyword.Not)) {
        const next = this.peek(1);
        if (
          next &&
          next.type === TokenType.Keyword &&
          (next.value === SdblKeyword.In ||
            next.value === SdblKeyword.Between ||
            next.value === SdblKeyword.Like)
        ) {
          this.advance(); // consume NOT
          notFlag = true;
        }
      }

      // Comparison operators: =, <>, <, >, <=, >=
      const tok = this.peek();
      if (
        tok &&
        tok.type === TokenType.Operator &&
        (tok.value === '=' ||
          tok.value === '<>' ||
          tok.value === '<' ||
          tok.value === '>' ||
          tok.value === '<=' ||
          tok.value === '>=')
      ) {
        this.advance();
        const right = this.parseAdditive();
        expr = {
          type: 'BinaryOp',
          operator: tok.value,
          left: expr,
          right,
        };
        continue;
      }

      // BETWEEN / МЕЖДУ
      if (this.matchKeyword(SdblKeyword.Between)) {
        const from = this.parseAdditive();
        this.consumeKeyword(SdblKeyword.And, 'В условии МЕЖДУ ожидается И');
        const to = this.parseAdditive();
        expr = {
          type: 'Between',
          expression: expr,
          from,
          to,
          not: notFlag || undefined,
        };
        continue;
      }

      // LIKE / ПОДОБНО
      if (this.matchKeyword(SdblKeyword.Like)) {
        const pattern = this.parseAdditive();
        let escape: ExpressionNode | undefined = undefined;
        if (this.matchKeyword(SdblKeyword.Escape)) {
          escape = this.parseAdditive();
        }
        expr = {
          type: 'Like',
          expression: expr,
          pattern,
          escape,
          not: notFlag || undefined,
        };
        continue;
      }

      // IN / В [ИЕРАРХИИ]
      if (this.matchKeyword(SdblKeyword.In)) {
        let inHierarchy: boolean | undefined = undefined;
        if (this.matchKeyword(SdblKeyword.Hierarchy)) {
          inHierarchy = true;
        }
        this.consumeSymbol('(', 'После В ожидается «(»');
        if (this.checkKeyword(SdblKeyword.Select)) {
          this.advance(); // consume SELECT
          const subquery = this.parseSelectStatement(true);
          this.consumeSymbol(')', 'Ожидается «)» после вложенного запроса');
          expr = {
            type: 'In',
            expression: expr,
            values: subquery,
            not: notFlag || undefined,
            inHierarchy,
          };
        } else {
          const values: ExpressionNode[] = [];
          do {
            values.push(this.parseExpression());
          } while (this.matchSymbol(','));
          this.consumeSymbol(')', 'Ожидается «)» после списка значений');
          expr = {
            type: 'In',
            expression: expr,
            values,
            not: notFlag || undefined,
            inHierarchy,
          };
        }
        continue;
      }

      // IS NULL / ЕСТЬ NULL and IS NOT NULL / ЕСТЬ НЕ NULL
      if (this.matchKeyword(SdblKeyword.Is)) {
        let isNot = false;
        if (this.matchKeyword(SdblKeyword.Not)) {
          isNot = true;
        }
        this.consumeKeyword(SdblKeyword.Null, 'После ЕСТЬ ожидается NULL');
        expr = {
          type: 'BinaryOp',
          operator: isNot ? 'IS NOT NULL' : 'IS NULL',
          left: expr,
          right: {
            type: 'Literal',
            valueType: 'null',
            value: null,
            raw: 'NULL',
          },
        };
        continue;
      }

      // REFS / ССЫЛКА
      if (this.matchKeyword(SdblKeyword.Refs)) {
        const target = this.parseIdentifierOrCompound();
        expr = {
          type: 'BinaryOp',
          operator: 'REFS',
          left: expr,
          right: target,
        };
        continue;
      }

      break;
    }

    while (this.checkSymbol('{') && !this.isBraceClause())
      {expr = { type: 'AnnotatedExpression', expression: expr, annotation: this.parseBrace() };}
    return expr;
  }

  private parseAdditive(): ExpressionNode {
    let left = this.parseMultiplicative();
    while (this.checkSymbol('+') || this.checkSymbol('-')) {
      const op = this.advance().value;
      const right = this.parseMultiplicative();
      left = {
        type: 'BinaryOp',
        operator: op,
        left,
        right,
      };
    }
    return left;
  }

  private parseMultiplicative(): ExpressionNode {
    let left = this.parseUnary();
    while (this.checkSymbol('*') || this.checkSymbol('/')) {
      const op = this.advance().value;
      const right = this.parseUnary();
      left = {
        type: 'BinaryOp',
        operator: op,
        left,
        right,
      };
    }
    return left;
  }

  private parseUnary(): ExpressionNode {
    if (this.matchSymbol('+')) {
      return this.parseUnary();
    }
    if (this.matchSymbol('-')) {
      const operand = this.parseUnary();
      return {
        type: 'UnaryOp',
        operator: '-',
        operand,
      };
    }
    let expression = this.parsePrimary();
    for (;;) {
      if (this.matchSymbol('.')) {
        if (this.matchSymbol('(')) {
          const fields: SelectedField[] = [];
          do { fields.push(this.parseSelectedField()); } while (this.matchSymbol(','));
          this.consumeSymbol(')', 'Ожидается «)» после списка полей');
          expression = { type: 'TableProjection', expression, fields };
        } else {expression = { type: 'MemberAccess', expression, member: this.consumeIdentifierOrKeyword() };}
      } else {break;}
    }
    return expression;
  }

  private parsePrimary(): ExpressionNode {
    const tok = this.peek();
    if (!tok) {
      this.fail('Ожидается выражение');
    }

    // A substituted table or field name may start a path: %Таблица%.Ссылка.
    if (this.checkSymbol('%')) {
      return this.peek(2)?.value === '.' || this.peek(3)?.value === '.'
        ? this.parseIdentifierOrCompound() : { type: 'RawExpression', raw: this.consumeTemplateName() };
    }
    if (this.checkSymbol('#')) {return this.parseIdentifierOrCompound();}
    if (this.checkSymbol('{')) {return { type: 'RawExpression', raw: this.parseBrace() };}

    // Number literal
    if (tok.type === TokenType.NumberLiteral) {
      this.advance();
      return {
        type: 'Literal',
        valueType: 'number',
        value: Number(tok.value),
        raw: tok.raw,
      };
    }

    // String literal
    if (tok.type === TokenType.StringLiteral) {
      this.advance();
      return {
        type: 'Literal',
        valueType: 'string',
        value: tok.value,
        raw: tok.raw,
      };
    }

    // Parameter
    if (tok.type === TokenType.Parameter) {
      this.advance(); let name = tok.value;
      while (this.checkSymbol('%')) {
        name += this.consumeTemplateName();
        const next = this.peek(), previous = this.previous();
        if (next?.type === TokenType.Identifier && next.offset === previous.offset + previous.raw.length)
          {name += this.advance().raw;}
      }
      return { type: 'Parameter', name };
    }

    // Booleans and NULL
    if (this.matchKeyword(SdblKeyword.True)) {
      return {
        type: 'Literal',
        valueType: 'boolean',
        value: true,
        raw: this.previous().raw,
      };
    }
    if (this.matchKeyword(SdblKeyword.False)) {
      return {
        type: 'Literal',
        valueType: 'boolean',
        value: false,
        raw: this.previous().raw,
      };
    }
    if (this.matchKeyword(SdblKeyword.Null)) {
      return {
        type: 'Literal',
        valueType: 'null',
        value: null,
        raw: this.previous().raw,
      };
    }
    if (this.matchKeyword(SdblKeyword.Undefined)) {
      return {
        type: 'Literal',
        valueType: 'null',
        value: undefined,
        raw: this.previous().raw,
      };
    }

    // Aggregate functions: SUM, COUNT, AVG, MIN, MAX (only when followed by '(')
    if (
      (this.checkKeyword(SdblKeyword.Sum) ||
        this.checkKeyword(SdblKeyword.Count) ||
        this.checkKeyword(SdblKeyword.Avg) ||
        this.checkKeyword(SdblKeyword.Min) ||
        this.checkKeyword(SdblKeyword.Max)) &&
      this.peek(1)?.value === '('
    ) {
      const aggTok = this.advance();
      const kw = aggTok.value as SdblKeyword;
      this.consumeSymbol('(', 'После агрегатной функции ожидается «(»');
      const distinct = this.matchKeyword(SdblKeyword.Distinct);
      let innerExpr: ExpressionNode;
      if (kw === SdblKeyword.Count && this.matchSymbol('*')) {
        innerExpr = { type: 'Identifier', name: '*' };
      } else {
        innerExpr = this.parseExpression();
      }
      this.consumeSymbol(')', 'Ожидается «)» после аргумента агрегатной функции');
      const aggregateType =
        kw === SdblKeyword.Sum
          ? 'Sum'
          : kw === SdblKeyword.Count
          ? 'Count'
          : kw === SdblKeyword.Avg
          ? 'Avg'
          : kw === SdblKeyword.Min
          ? 'Min'
          : 'Max';
      return {
        type: 'Aggregate',
        aggregateType,
        distinct: distinct || undefined,
        expression: innerExpr,
      };
    }

    // CASE WHEN ... THEN ... ELSE ... END / ВЫБОР КОГДА ... ТОГДА ... ИНАЧЕ ... КОНЕЦ
    if (this.matchKeyword(SdblKeyword.Case)) {
      const cases: Array<{ when: ExpressionNode; then: ExpressionNode }> = [];
      const operand = this.checkKeyword(SdblKeyword.When) ? undefined : this.parseExpression();
      while (this.matchKeyword(SdblKeyword.When)) {
        const value = this.parseExpression();
        const when: ExpressionNode = operand
          ? { type: 'BinaryOp', operator: '=', left: operand, right: value }
          : value;
        this.consumeKeyword(SdblKeyword.Then, 'В ВЫБОР ожидается ТОГДА');
        const then = this.parseExpression();
        cases.push({ when, then });
      }
      let elseExpr: ExpressionNode | undefined = undefined;
      if (this.matchKeyword(SdblKeyword.Else)) {
        elseExpr = this.parseExpression();
      }
      this.consumeKeyword(SdblKeyword.End, 'Ожидается КОНЕЦ выражения ВЫБОР');
      return {
        type: 'CaseWhen',
        cases,
        else: elseExpr,
      };
    }

    // Parentheses: ( Expression )
    if (this.matchSymbol('(')) {
      const expr = this.parseExpression();
      if (this.matchSymbol(',')) {
        const items = [expr];
        do { items.push(this.parseExpression()); } while (this.matchSymbol(','));
        this.consumeSymbol(')', 'Ожидается «)» после списка');
        return { type: 'Tuple', items };
      }
      this.consumeSymbol(')', 'Ожидается «)»');
      return expr;
    }

    if (this.isReserved(tok)) {this.fail('Ожидается выражение', tok);}

    // Function call or Identifier / CompoundIdentifier
    if (tok.type === TokenType.Identifier || tok.type === TokenType.Keyword) {
      // Check if it's CAST / ВЫРАЗИТЬ: ВЫРАЗИТЬ '(' expr КАК type ')'
      if (this.checkKeyword(SdblKeyword.Cast) && this.peek(1)?.value === '(') {
        const castTok = this.advance();
        this.consumeSymbol('(');
        const expr = this.parseExpression();
        this.consumeKeyword(
          SdblKeyword.As,
          'В ВЫРАЗИТЬ ожидается КАК'
        );
        const typeExpr = this.parseExpression();
        this.consumeSymbol(')');
        return {
          type: 'FunctionCall',
          name: castTok.raw.toUpperCase() === 'CAST' ? 'CAST' : 'ВЫРАЗИТЬ',
          args: [expr, typeExpr],
        };
      }

      // Check if it's a function call: Name '('
      if (this.peek(1)?.value === '(') {
        const funcName = this.advance().raw;
        this.consumeSymbol('(');
        const args: ExpressionNode[] = [];
        if (!this.checkSymbol(')')) {
          do {
            args.push(this.parseExpression());
          } while (this.matchSymbol(','));
        }
        this.consumeSymbol(')');
        return {
          type: 'FunctionCall',
          name: funcName,
          args,
        };
      }

      // Identifier or CompoundIdentifier: a.b.c
      return this.parseIdentifierOrCompound();
    }

    this.fail('Ожидается выражение');
  }

  private parseIdentifierOrCompound(): ExpressionNode {
    const parts: string[] = [this.consumeTemplateName()];
    while (this.checkSymbol('.') && this.peek(1)?.value !== '(') {
      this.advance();
      if (this.matchSymbol('*')) {
        parts.push('*');
        break;
      }
      this.expectName('После точки ожидается имя', true);
      parts.push(this.consumeTemplateName());
    }
    if (parts.length === 1) {
      return { type: 'Identifier', name: parts[0] };
    }
    return { type: 'CompoundIdentifier', parts };
  }

  private parseCompoundName(): string {
    const parts: string[] = [this.consumeTemplateName()];
    while (this.matchSymbol('.')) {
      this.expectName('После точки ожидается имя', true);
      parts.push(this.consumeTemplateName());
    }
    return parts.join('.');
  }

  /**
   * A name, possibly assembled from pieces written without spaces:
   * Префикс%Имя%, %ИмяТаблицы%%Суффикс%, ВТ#Номер. Pieces are glued only
   * when they touch, so the text is reproduced exactly.
   */
  private consumeTemplateName(): string {
    let name = this.consumeNamePiece();
    for (;;) {
      const previous = this.previous(), next = this.peek(), after = this.peek(1);
      if (!next || !previous || next.offset !== previous.offset + previous.raw.length) {break;}
      const nameToken = (token?: SdblToken) => !!token
        && [TokenType.Identifier, TokenType.Keyword, TokenType.NumberLiteral].includes(token.type);
      const template = (next.value === '%' || next.value === '#') && next.type !== TokenType.StringLiteral && nameToken(after);
      const tail = (next.type === TokenType.Identifier || next.type === TokenType.NumberLiteral) && /[%#]/.test(name);
      if (!template && !tail) {break;}
      name += this.consumeNamePiece();
    }
    if (/[%#]/.test(name)) {this.runtimeTemplate = true;}
    return name;
  }

  /** A standalone substitution where a clause may end: %Отбор%, &ТекстУсловия. */
  private isTemplateFragment(): boolean {
    const token = this.peek();
    if (!token) {return false;}
    if (token.type === TokenType.Parameter) {return true;}
    return this.checkSymbol('%') && !!this.peek(1)
      && [TokenType.Identifier, TokenType.Keyword, TokenType.NumberLiteral].includes(this.peek(1)!.type);
  }

  private consumeFragment(): string {
    if (this.peek()?.type === TokenType.Parameter) {
      let raw = '&' + this.advance().value;
      while (this.checkSymbol('%')) {raw += this.consumeTemplateName();}
      return raw;
    }
    return this.consumeTemplateName();
  }

  private consumeNamePiece(): string {
    if (this.peek()?.type === TokenType.Parameter) { this.runtimeTemplate = true; return '&' + this.advance().value; }
    if (this.matchSymbol('#')) { this.runtimeTemplate = true; return '#' + this.consumeIdentifierOrKeyword(); }
    if (this.matchSymbol('%')) {
      this.runtimeTemplate = true;
      const token = this.peek();
      if (!token || ![TokenType.NumberLiteral, TokenType.Identifier, TokenType.Keyword].includes(token.type))
        {this.fail('После % требуется номер или имя подстановки');}
      if (token.type === TokenType.NumberLiteral && !/^\d+$/.test(token.value))
        {this.fail('Номер подстановки должен быть целым');}
      this.advance();
      return '%' + token.raw + (this.matchSymbol('%') ? '%' : '');
    }
    return this.consumeIdentifierOrKeyword();
  }

  // --- HELPER UTILITIES ---

  private isSectionKeyword(tok: SdblToken | undefined): boolean {
    if (!tok || tok.type !== TokenType.Keyword) {return false;}
    const kw = tok.value as SdblKeyword;
    return (
      kw === SdblKeyword.From ||
      kw === SdblKeyword.Into ||
      kw === SdblKeyword.Index ||
      kw === SdblKeyword.Where ||
      kw === SdblKeyword.Group ||
      kw === SdblKeyword.Having ||
      kw === SdblKeyword.Union ||
      kw === SdblKeyword.Order ||
      kw === SdblKeyword.Totals ||
      kw === SdblKeyword.Autoorder ||
      kw === SdblKeyword.ForUpdate ||
      kw === SdblKeyword.Select ||
      kw === SdblKeyword.Drop
    );
  }

  private isTableIdentifierStart(): boolean {
    const tok = this.peek();
    if (!tok) {
      return false;
    }
    if (tok.type === TokenType.Identifier) {
      return true;
    }
    if (tok.type === TokenType.Keyword && !this.isSectionKeyword(tok)) {
      return true;
    }
    return false;
  }

  private matchOnOrBy(): boolean {
    return this.matchKeyword(SdblKeyword.On) || this.matchKeyword(SdblKeyword.By);
  }

  private checkOnOrBy(): boolean {
    return this.checkKeyword(SdblKeyword.On) || this.checkKeyword(SdblKeyword.By);
  }

  private isAtEnd(): boolean {
    const tok = this.peek();
    return !tok || tok.type === TokenType.EOF;
  }

  private peek(n = 0): SdblToken | undefined {
    return this.tokens[this.pos + n];
  }

  private previous(): SdblToken {
    return this.tokens[this.pos - 1];
  }

  private advance(): SdblToken {
    if (!this.isAtEnd()) {
      this.pos++;
    }
    return this.previous();
  }

  private check(type: TokenType, value?: string): boolean {
    const tok = this.peek();
    if (!tok || tok.type !== type) {return false;}
    if (value !== undefined) {return tok.value === value;}
    return true;
  }

  private checkKeyword(kw: SdblKeyword): boolean {
    const tok = this.peek();
    return Boolean(tok && tok.type === TokenType.Keyword && tok.value === kw);
  }

  private matchKeyword(kw: SdblKeyword): boolean {
    if (this.checkKeyword(kw)) {
      this.advance();
      return true;
    }
    return false;
  }

  private isReserved(tok: SdblToken | undefined): boolean {
    return !!tok && tok.type === TokenType.Keyword && RESERVED_KEYWORDS.has(tok.value);
  }

  /** A name (alias, temporary table, path part) cannot be a reserved word. */
  private expectName(message = 'Ожидается имя', afterDot = false): void {
    const tok = this.peek();
    const name = !!tok && (tok.type === TokenType.Identifier || tok.type === TokenType.Keyword
      || tok.type === TokenType.Parameter || tok.value === '%' || tok.value === '#');
    if (!name || (afterDot ? tok.type === TokenType.Keyword && NOT_AFTER_DOT_KEYWORDS.has(tok.value)
        : this.isReserved(tok))) {this.fail(message, tok);}
  }

  // The unclosed bracket a missing «)» belongs to.
  private openBracketBefore(): SdblToken | undefined {
    let depth = 0;
    for (let i = this.pos - 1; i >= 0; i--) {
      const tok = this.tokens[i];
      if (tok.type !== TokenType.Symbol && tok.type !== TokenType.Operator) {continue;}
      if (tok.value === ')') {depth++;}
      else if (tok.value === '(') {
        if (!depth) {return tok;}
        depth--;
      }
    }
    return undefined;
  }

  /** Throws the message with the token the parser stopped at: «Х», строка N, колонка M. */
  public fail(message: string, tok: SdblToken | undefined = this.peek(), label = 'Получено'): never {
    const located = tok && tok.line > 0;
    const got = !tok || tok.type === TokenType.EOF ? 'конец текста' : `«${tok.raw}»`;
    const error = new Error(located
      ? `${message}. ${label} ${got}, строка ${tok.line}, колонка ${tok.column}`
      : `${message}. ${label} ${got}`) as SdblParseError;
    error.sdblParse = true;
    if (located) {
      error.sdblLine = tok.line;
      error.sdblColumn = tok.column;
      error.sdblLength = tok.type === TokenType.EOF ? 0 : tok.raw.length;
    }
    throw error;
  }

  private consumeKeyword(kw: SdblKeyword, errorMsg: string): SdblToken {
    if (this.checkKeyword(kw)) {
      return this.advance();
    }
    const tok = this.peek();
    this.fail(errorMsg, tok);
  }

  private checkSymbol(sym: string): boolean {
    const tok = this.peek();
    if (!tok) {return false;}
    return (
      (tok.type === TokenType.Symbol || tok.type === TokenType.Operator) &&
      tok.value === sym
    );
  }

  private matchSymbol(sym: string): boolean {
    if (this.checkSymbol(sym)) {
      this.advance();
      return true;
    }
    return false;
  }

  private consumeSymbol(sym: string, errorMsg = `Ожидается «${sym}»`): SdblToken {
    if (this.checkSymbol(sym)) {
      return this.advance();
    }
    const tok = this.peek();
    const open = sym === ')' ? this.openBracketBefore() : undefined;
    if (open && (!tok || tok.type === TokenType.EOF))
      {this.fail(`Не закрыта скобка: ${errorMsg[0].toLowerCase()}${errorMsg.slice(1)}`, open, 'Открыта');}
    if (open) {this.fail(`${errorMsg} (скобка открыта в строке ${open.line}, колонке ${open.column})`, tok);}
    this.fail(errorMsg, tok);
  }

  private consumeIdentifierOrKeyword(): string {
    const tok = this.peek();
    if (
      tok &&
      (tok.type === TokenType.Identifier || tok.type === TokenType.Keyword)
    ) {
      this.advance();
      return tok.raw;
    }
    this.fail('Ожидается имя', tok);
  }

  private consume(type: TokenType, errorMsg: string): SdblToken {
    if (this.check(type)) {
      return this.advance();
    }
    const tok = this.peek();
    this.fail(errorMsg, tok);
  }
}
