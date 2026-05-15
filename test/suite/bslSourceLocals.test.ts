import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DebugProtocol } from '@vscode/debugprotocol';

import { BslDebugSession, VariableRef } from '../../src/debug/bslDebugSession';
import { extractLocalCandidatesFromBsl } from '../../src/debug/bslSourceLocals';
import { RdbgEvalOptions, RdbgEvalResult } from '../../src/debug/rdbg/rdbgTypes';
import { ReferencesTable } from '../../src/debug/referencesTable';

class TestBslDebugSession extends BslDebugSession {
  public readonly variableResponses: DebugProtocol.VariablesResponse[] = [];

  public variablesForTest(variablesReference: number): Promise<void> {
    const response = {
      seq: 0,
      type: 'response',
      request_seq: 1,
      command: 'variables',
      success: true,
    } as DebugProtocol.VariablesResponse;
    return this.variablesRequest(response, { variablesReference });
  }

  public sendResponse(response: DebugProtocol.Response): void {
    if (response.command === 'variables') {
      this.variableResponses.push(response as DebugProtocol.VariablesResponse);
    }
  }
}

suite('bslSourceLocals', () => {
  test('extracts parameters, module variables and assignments visible at the current line', () => {
    const source = [
      'Перем ModuleVar;',
      '',
      'Процедура Обработать(Знач Отказ, Параметр2 = Неопределено)',
      '  Сумма = 1;',
      '  Для Каждого Строка Из Таблица Цикл',
      '    Текущий = Строка;',
      '  КонецЦикла;',
      'КонецПроцедуры',
    ].join('\n');

    const candidates = extractLocalCandidatesFromBsl(source, 7);

    assert.deepStrictEqual(
      candidates.map((candidate) => candidate.name),
      ['Отказ', 'Параметр2', 'ModuleVar', 'Сумма', 'Строка', 'Текущий']
    );
  });

  test('extracts English locals without leaking names from strings, comments or other routines', () => {
    const source = [
      'Var ModuleA, ModuleB;',
      'Var For, ModuleA, Valid2;',
      '',
      'Function First()',
      '  Hidden = 1;',
      'EndFunction',
      '',
      'Function Second(ByVal ParamOne, ParamTwo = 42)',
      '  Text = "Fake = 1 // ignored"; // Commented = 2',
      '  For Each Row In Rows Do',
      '    For Index = 1 To 2 Do',
      '      Value = Row;',
      '    EndDo;',
      'EndFunction',
    ].join('\n');

    const candidates = extractLocalCandidatesFromBsl(source, 12);

    assert.deepStrictEqual(
      candidates.map((candidate) => candidate.name),
      ['ParamOne', 'ParamTwo', 'ModuleA', 'ModuleB', 'Valid2', 'Text', 'Row', 'Index', 'Value']
    );
  });

  test('handles empty parameter lists and out-of-range lines', () => {
    const source = [
      'Var ModuleOnly;',
      '',
      'Procedure Empty()',
      'EndProcedure',
    ].join('\n');

    assert.deepStrictEqual(extractLocalCandidatesFromBsl('', 100), []);
    assert.deepStrictEqual(
      extractLocalCandidatesFromBsl(source, 100).map((candidate) => candidate.name),
      ['ModuleOnly']
    );
    assert.deepStrictEqual(
      extractLocalCandidatesFromBsl(source, 0).map((candidate) => candidate.name),
      ['ModuleOnly']
    );
  });

  test('variablesRequest uses source-derived locals without unsafe top-level RDBG locals', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), '1cviewer-debug-locals-'));
    const filePath = path.join(dir, 'ObjectModule.bsl');
    fs.writeFileSync(filePath, [
      'Процедура Обработать(Отказ)',
      '  Сумма = 1;',
      'КонецПроцедуры',
    ].join('\n'), 'utf8');

    const session = new TestBslDebugSession();
    const fakeClient = {
      async evalLocalVariables(): Promise<never> {
        throw new Error('unsafe locals must not be called');
      },
      async evaluate(): Promise<RdbgEvalResult> {
        throw new Error('bulk evaluate must not be called');
      },
    };
    const internals = session as unknown as {
      _client: unknown;
      _threadMap: Map<number, string>;
      _variableRefs: ReferencesTable<VariableRef>;
    };
    internals._client = fakeClient;
    internals._threadMap.set(1, 'target-1');
    const variablesReference = internals._variableRefs.add({
      threadId: 1,
      frameLevel: 0,
      path: [],
      view: 'context',
      sourcePath: filePath,
      sourceLine: 2,
    } as VariableRef);

    await session.variablesForTest(variablesReference);

    const variables = session.variableResponses[0].body?.variables ?? [];
    assert.deepStrictEqual(variables.map((variable) => variable.name), ['Отказ', 'Сумма']);
    assert.ok(variables.every((variable) => variable.value === 'не вычислено'));
    assert.ok(variables.every((variable) => variable.variablesReference === 0));
  });
  test('variablesRequest evaluates source-derived locals with short per-expression eval', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), '1cviewer-debug-local-values-'));
    const filePath = path.join(dir, 'ObjectModule.bsl');
    fs.writeFileSync(filePath, [
      'Procedure Handle(Refusal)',
      '  a = 0;',
      'EndProcedure',
    ].join('\n'), 'utf8');

    const calls: Array<{ expression: string; options: RdbgEvalOptions | undefined }> = [];
    const session = new TestBslDebugSession();
    const fakeClient = {
      async evalLocalVariables(): Promise<never> {
        throw new Error('unsafe locals must not be called');
      },
      async evaluate(
        _targetId: string,
        expression: string,
        _frameLevel: number,
        options?: RdbgEvalOptions
      ): Promise<RdbgEvalResult> {
        calls.push({ expression, options });
        return {
          value: expression === 'a' ? '0' : 'False',
          typeName: expression === 'a' ? 'Number' : 'Boolean',
          isExpandable: false,
        };
      },
    };
    const internals = session as unknown as {
      _client: unknown;
      _threadMap: Map<number, string>;
      _variableRefs: ReferencesTable<VariableRef>;
    };
    internals._client = fakeClient;
    internals._threadMap.set(1, 'target-1');
    const variablesReference = internals._variableRefs.add({
      threadId: 1,
      frameLevel: 0,
      path: [],
      view: 'context',
      sourcePath: filePath,
      sourceLine: 2,
    } as VariableRef);

    await session.variablesForTest(variablesReference);

    const variables = session.variableResponses[0].body?.variables ?? [];
    assert.deepStrictEqual(variables.map((variable) => [variable.name, variable.value]), [
      ['Refusal', 'False'],
      ['a', '0'],
    ]);
    assert.deepStrictEqual(calls.map((call) => call.expression), ['Refusal', 'a']);
    assert.ok(calls.every((call) => call.options?.purpose === 'variables'));
    assert.ok(calls.every((call) => call.options?.calcWaitingTimeMs === 500));
  });

  test('variablesRequest limits eager local evaluation to the fast budget', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), '1cviewer-debug-local-limit-'));
    const filePath = path.join(dir, 'ObjectModule.bsl');
    fs.writeFileSync(filePath, [
      'Procedure Handle()',
      '  v01 = 1;',
      '  v02 = 2;',
      '  v03 = 3;',
      '  v04 = 4;',
      '  v05 = 5;',
      '  v06 = 6;',
      '  v07 = 7;',
      '  v08 = 8;',
      '  v09 = 9;',
      '  v10 = 10;',
      '  v11 = 11;',
      '  v12 = 12;',
      '  v13 = 13;',
      '  v14 = 14;',
      '  v15 = 15;',
      'EndProcedure',
    ].join('\n'), 'utf8');

    const calls: string[] = [];
    const session = new TestBslDebugSession();
    const fakeClient = {
      async evalLocalVariables(): Promise<never> {
        throw new Error('unsafe locals must not be called');
      },
      async evaluate(
        _targetId: string,
        expression: string,
        _frameLevel: number,
        options?: RdbgEvalOptions
      ): Promise<RdbgEvalResult> {
        assert.strictEqual(options?.purpose, 'variables');
        assert.strictEqual(options?.calcWaitingTimeMs, 500);
        calls.push(expression);
        return {
          value: expression.toUpperCase(),
          typeName: 'String',
          isExpandable: false,
        };
      },
    };
    const internals = session as unknown as {
      _client: unknown;
      _threadMap: Map<number, string>;
      _variableRefs: ReferencesTable<VariableRef>;
    };
    internals._client = fakeClient;
    internals._threadMap.set(1, 'target-1');
    const variablesReference = internals._variableRefs.add({
      threadId: 1,
      frameLevel: 0,
      path: [],
      view: 'context',
      sourcePath: filePath,
      sourceLine: 16,
    } as VariableRef);

    await session.variablesForTest(variablesReference);

    const variables = session.variableResponses[0].body?.variables ?? [];
    assert.strictEqual(calls.length, 12);
    assert.deepStrictEqual(calls, ['v01', 'v02', 'v03', 'v04', 'v05', 'v06', 'v07', 'v08', 'v09', 'v10', 'v11', 'v12']);
    assert.deepStrictEqual(variables.slice(0, 12).map((variable) => variable.value), calls.map((name) => name.toUpperCase()));
    assert.deepStrictEqual(variables.slice(12).map((variable) => variable.value), ['не вычислено', 'не вычислено', 'не вычислено']);
  });
});
