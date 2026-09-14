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
  TableSource,
  SubquerySource,
  JoinClause,
  UnionClause,
  OrderItem,
  TotalsClause,
  TotalsField,
  TotalsGroupItem,
  ExpressionNode,
} from './sdblAst';
import { normalizeFromClauses } from './sdblAstVisitor';

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

  const parser = new SdblParser(tokens);
  return parser.parsePackage();
}

class SdblParser {
  private pos = 0;

  constructor(private readonly tokens: SdblToken[]) {}

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

      if (this.matchKeyword(SdblKeyword.Drop)) {
        queries.push(this.parseDropTable());
      } else if (this.matchKeyword(SdblKeyword.Select)) {
        queries.push(this.parseSelectStatement(true));
      } else {
        const tok = this.peek();
        throw new Error(
          `Unexpected token '${tok?.raw || ''}' at line ${tok?.line || 0}, col ${tok?.column || 0}. Expected SELECT or DROP statement.`
        );
      }

      // Optional semicolon delimiter between statements
      this.matchSymbol(';');
    }

    return { queries };
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
    let top: number | undefined = undefined;
    let forUpdate: boolean | undefined = undefined;
    let forUpdateTables: string[] | undefined = undefined;
    let autoOrder: boolean | undefined = undefined;
    let into: string | undefined = undefined;
    let indexBy: string[] | undefined = undefined;

    // Modifiers right after SELECT
    while (!this.isAtEnd()) {
      if (this.matchKeyword(SdblKeyword.Distinct)) {
        distinct = true;
      } else if (this.matchKeyword(SdblKeyword.Allowed)) {
        allowed = true;
      } else if (this.matchKeyword(SdblKeyword.Top)) {
        const topTok = this.consume(
          TokenType.NumberLiteral,
          'Expected integer count after TOP / ПЕРВЫЕ'
        );
        top = parseInt(topTok.value, 10);
      } else {
        break;
      }
    }

    // Fields list
    const fields: SelectedField[] = [];
    do {
      fields.push(this.parseSelectedField());
    } while (this.matchSymbol(','));

    // Optional INTO / ПОМЕСТИТЬ before FROM
    if (this.matchKeyword(SdblKeyword.Into)) {
      into = this.consumeIdentifierOrKeyword();
      if (this.matchKeyword(SdblKeyword.Index)) {
        this.matchOnOrBy();
        indexBy = this.parseIndexFields();
      }
    }

    // FROM / ИЗ
    let from: FromClause[] | undefined = undefined;
    if (this.matchKeyword(SdblKeyword.From)) {
      from = this.parseFromClauseList();
    }

    // Optional INTO / ПОМЕСТИТЬ after FROM
    if (!into && this.matchKeyword(SdblKeyword.Into)) {
      into = this.consumeIdentifierOrKeyword();
      if (this.matchKeyword(SdblKeyword.Index)) {
        this.matchOnOrBy();
        indexBy = this.parseIndexFields();
      }
    }

    // WHERE / ГДЕ
    let where: ExpressionNode | undefined = undefined;
    if (this.matchKeyword(SdblKeyword.Where)) {
      where = this.parseExpression();
    }

    // GROUP BY / СГРУППИРОВАТЬ ПО
    let groupBy: ExpressionNode[] | undefined = undefined;
    if (this.matchKeyword(SdblKeyword.Group)) {
      this.matchOnOrBy();
      groupBy = [];
      do {
        groupBy.push(this.parseExpression());
      } while (this.matchSymbol(','));
    }

    // HAVING / ИМЕЮЩИЕ
    let having: ExpressionNode | undefined = undefined;
    if (this.matchKeyword(SdblKeyword.Having)) {
      having = this.parseExpression();
    }

    // INDEX BY / ИНДЕКСИРОВАТЬ ПО (canonical position: after FROM, WHERE, GROUP BY, HAVING)
    if (!indexBy && this.matchKeyword(SdblKeyword.Index)) {
      this.matchOnOrBy();
      indexBy = this.parseIndexFields();
    }

    // UNIONS / ОБЪЕДИНИТЬ [ВСЕ]
    let unions: UnionClause[] | undefined = undefined;
    if (allowUnions) {
      while (this.checkKeyword(SdblKeyword.Union)) {
        this.advance(); // consume UNION
        let unionType: 'Union' | 'UnionAll' = 'Union';
        if (this.matchKeyword(SdblKeyword.All)) {
          unionType = 'UnionAll';
        }
        this.consumeKeyword(SdblKeyword.Select, 'Expected SELECT after UNION');
        const statement = this.parseSelectStatement(false);
        if (!unions) {
          unions = [];
        }
        unions.push({ unionType, statement });
      }
    }

    // ORDER BY / УПОРЯДОЧИТЬ ПО
    let orderBy: OrderItem[] | undefined = undefined;
    if (this.matchKeyword(SdblKeyword.Order)) {
      this.matchOnOrBy();
      orderBy = [];
      do {
        if (this.matchKeyword(SdblKeyword.Autoorder)) {
          autoOrder = true;
          break;
        }
        const expr = this.parseExpression();
        let direction: 'Asc' | 'Desc' | undefined = undefined;
        if (this.matchKeyword(SdblKeyword.Asc)) {
          direction = 'Asc';
        } else if (this.matchKeyword(SdblKeyword.Desc)) {
          direction = 'Desc';
        }
        orderBy.push({ expression: expr, direction });

        if (this.matchKeyword(SdblKeyword.Autoorder)) {
          autoOrder = true;
        }
      } while (this.matchSymbol(','));
    }

    // TOTALS / ИТОГИ
    let totals: TotalsClause | undefined = undefined;
    if (this.matchKeyword(SdblKeyword.Totals)) {
      totals = this.parseTotalsClause();
    }

    // Trailing AUTOORDER
    if (this.matchKeyword(SdblKeyword.Autoorder)) {
      autoOrder = true;
    }

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

    const selectStmt: SelectStatement = {
      type: 'Select',
      fields,
    };
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
    if (from !== undefined) {selectStmt.from = from;}
    if (where !== undefined) {selectStmt.where = where;}
    if (groupBy !== undefined) {selectStmt.groupBy = groupBy;}
    if (having !== undefined) {selectStmt.having = having;}
    if (unions !== undefined) {selectStmt.unions = unions;}
    if (orderBy !== undefined) {selectStmt.orderBy = orderBy;}
    if (totals !== undefined) {selectStmt.totals = totals;}

    return selectStmt;
  }

  private parseIndexFields(): string[] {
    const fields: string[] = [];
    do {
      fields.push(this.consumeIdentifierOrKeyword());
    } while (this.matchSymbol(','));
    return fields;
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
    if (this.matchKeyword(SdblKeyword.As)) {
      alias = this.consumeIdentifierOrKeyword();
    } else if (this.isPotentialAlias()) {
      alias = this.consumeIdentifierOrKeyword();
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
        alias = this.consumeIdentifierOrKeyword();
      } else if (this.isPotentialFromAlias()) {
        alias = this.consumeIdentifierOrKeyword();
      }

      const joins: JoinClause[] = [];
      while (this.isJoinStart()) {
        joins.push(this.parseJoinClause());
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

  private parseTableOrSubquery(): TableSource | SubquerySource {
    if (this.matchSymbol('(')) {
      if (this.checkKeyword(SdblKeyword.Select)) {
        this.advance(); // consume SELECT
        const query = this.parseSelectStatement(true);
        this.consumeSymbol(')', "Expected ')' after subquery in FROM");
        return {
          type: 'Subquery',
          query,
        };
      }
      throw new Error("Expected SELECT inside '(' in FROM clause");
    }

    const name = this.parseCompoundName();
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

    this.consumeSymbol(')', "Expected ')' after virtual table parameters");
    return params;
  }

  private isJoinStart(): boolean {
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

  private parseJoinClause(): JoinClause {
    let joinType: 'Left' | 'Right' | 'Full' | 'Inner' = 'Inner';

    if (this.matchKeyword(SdblKeyword.Left)) {
      joinType = 'Left';
      this.matchKeyword(SdblKeyword.Outer);
      this.consumeKeyword(SdblKeyword.Join, 'Expected JOIN / СОЕДИНЕНИЕ after LEFT');
    } else if (this.matchKeyword(SdblKeyword.Right)) {
      joinType = 'Right';
      this.matchKeyword(SdblKeyword.Outer);
      this.consumeKeyword(SdblKeyword.Join, 'Expected JOIN / СОЕДИНЕНИЕ after RIGHT');
    } else if (this.matchKeyword(SdblKeyword.Full)) {
      joinType = 'Full';
      this.matchKeyword(SdblKeyword.Outer);
      this.consumeKeyword(SdblKeyword.Join, 'Expected JOIN / СОЕДИНЕНИЕ after FULL');
    } else if (this.matchKeyword(SdblKeyword.Inner)) {
      joinType = 'Inner';
      this.consumeKeyword(SdblKeyword.Join, 'Expected JOIN / СОЕДИНЕНИЕ after INNER');
    } else if (this.matchKeyword(SdblKeyword.Join)) {
      joinType = 'Inner';
    }

    const source = this.parseTableOrSubquery();
    let alias: string | undefined = undefined;
    if (this.matchKeyword(SdblKeyword.As)) {
      alias = this.consumeIdentifierOrKeyword();
    } else if (this.isPotentialFromAlias()) {
      alias = this.consumeIdentifierOrKeyword();
    }

    this.matchOnOrBy();
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
          alias = this.consumeIdentifierOrKeyword();
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

              this.consumeSymbol(')', "Expected ')' after PERIODS parameters");
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

      by.push({
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
        this.consumeKeyword(SdblKeyword.And, 'Expected AND / И in BETWEEN expression');
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
        this.consumeSymbol('(', "Expected '(' after IN");
        if (this.checkKeyword(SdblKeyword.Select)) {
          this.advance(); // consume SELECT
          const subquery = this.parseSelectStatement(true);
          this.consumeSymbol(')', "Expected ')' after subquery in IN");
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
          this.consumeSymbol(')', "Expected ')' after IN values list");
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
        this.consumeKeyword(SdblKeyword.Null, 'Expected NULL after IS / ЕСТЬ');
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
    return this.parsePrimary();
  }

  private parsePrimary(): ExpressionNode {
    const tok = this.peek();
    if (!tok) {
      throw new Error('Unexpected end of input while parsing expression');
    }

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
      this.advance();
      return {
        type: 'Parameter',
        name: tok.value,
      };
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
      this.consumeSymbol('(', "Expected '(' after aggregate function");
      const distinct = this.matchKeyword(SdblKeyword.Distinct);
      let innerExpr: ExpressionNode;
      if (kw === SdblKeyword.Count && this.matchSymbol('*')) {
        innerExpr = { type: 'Identifier', name: '*' };
      } else {
        innerExpr = this.parseExpression();
      }
      this.consumeSymbol(')', "Expected ')' after aggregate argument");
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
      while (this.matchKeyword(SdblKeyword.When)) {
        const when = this.parseExpression();
        this.consumeKeyword(SdblKeyword.Then, 'Expected THEN / ТОГДА in CASE expression');
        const then = this.parseExpression();
        cases.push({ when, then });
      }
      let elseExpr: ExpressionNode | undefined = undefined;
      if (this.matchKeyword(SdblKeyword.Else)) {
        elseExpr = this.parseExpression();
      }
      this.consumeKeyword(SdblKeyword.End, 'Expected END / КОНЕЦ in CASE expression');
      return {
        type: 'CaseWhen',
        cases,
        else: elseExpr,
      };
    }

    // Parentheses: ( Expression )
    if (this.matchSymbol('(')) {
      const expr = this.parseExpression();
      this.consumeSymbol(')', "Expected ')' to close expression");
      return expr;
    }

    // Function call or Identifier / CompoundIdentifier
    if (tok.type === TokenType.Identifier || tok.type === TokenType.Keyword) {
      // Check if it's CAST / ВЫРАЗИТЬ: ВЫРАЗИТЬ '(' expr КАК type ')'
      if (this.checkKeyword(SdblKeyword.Cast) && this.peek(1)?.value === '(') {
        const castTok = this.advance();
        this.consumeSymbol('(');
        const expr = this.parseExpression();
        this.consumeKeyword(
          SdblKeyword.As,
          'Expected AS / КАК in CAST / ВЫРАЗИТЬ'
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

    throw new Error(
      `Unexpected token '${tok.raw}' at line ${tok.line}, col ${tok.column} while parsing expression`
    );
  }

  private parseIdentifierOrCompound(): ExpressionNode {
    const parts: string[] = [this.consumeIdentifierOrKeyword()];
    while (this.matchSymbol('.')) {
      if (this.matchSymbol('*')) {
        parts.push('*');
        break;
      }
      parts.push(this.consumeIdentifierOrKeyword());
    }
    if (parts.length === 1) {
      return { type: 'Identifier', name: parts[0] };
    }
    return { type: 'CompoundIdentifier', parts };
  }

  private parseCompoundName(): string {
    const parts: string[] = [this.consumeIdentifierOrKeyword()];
    while (this.matchSymbol('.')) {
      parts.push(this.consumeIdentifierOrKeyword());
    }
    return parts.join('.');
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

  private consumeKeyword(kw: SdblKeyword, errorMsg: string): SdblToken {
    if (this.checkKeyword(kw)) {
      return this.advance();
    }
    const tok = this.peek();
    throw new Error(`${errorMsg}. Got '${tok?.raw || ''}' at line ${tok?.line}, col ${tok?.column}`);
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

  private consumeSymbol(sym: string, errorMsg = `Expected '${sym}'`): SdblToken {
    if (this.checkSymbol(sym)) {
      return this.advance();
    }
    const tok = this.peek();
    throw new Error(`${errorMsg}. Got '${tok?.raw || ''}' at line ${tok?.line}, col ${tok?.column}`);
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
    throw new Error(
      `Expected identifier. Got '${tok?.raw || ''}' at line ${tok?.line}, col ${tok?.column}`
    );
  }

  private consume(type: TokenType, errorMsg: string): SdblToken {
    if (this.check(type)) {
      return this.advance();
    }
    const tok = this.peek();
    throw new Error(`${errorMsg}. Got '${tok?.raw || ''}' at line ${tok?.line}, col ${tok?.column}`);
  }
}
