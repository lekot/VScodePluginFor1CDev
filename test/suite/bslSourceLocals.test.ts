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
});
