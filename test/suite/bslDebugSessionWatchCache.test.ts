import * as assert from 'assert';
import { DebugProtocol } from '@vscode/debugprotocol';

import { BslDebugSession } from '../../src/debug/bslDebugSession';
import { RdbgEvalResult } from '../../src/debug/rdbg/rdbgTypes';

class TestBslDebugSession extends BslDebugSession {
  public readonly responses: DebugProtocol.EvaluateResponse[] = [];

  public evaluateForTest(args: DebugProtocol.EvaluateArguments): Promise<void> {
    const response = {
      seq: 0,
      type: 'response',
      request_seq: 1,
      command: 'evaluate',
      success: true,
    } as DebugProtocol.EvaluateResponse;
    return this.evaluateRequest(response, args);
  }

  public sendResponse(response: DebugProtocol.Response): void {
    this.responses.push(response as DebugProtocol.EvaluateResponse);
  }
}

suite('BslDebugSession - watch evaluate cache', () => {
  test('repeated watch expression at same pause reuses cached result', async () => {
    const session = new TestBslDebugSession();
    let evaluateCalls = 0;
    const fakeClient = {
      async evaluate(_targetId: string, expression: string, _frameLevel: number): Promise<RdbgEvalResult> {
        evaluateCalls++;
        return {
          value: `${expression}:${evaluateCalls}`,
          typeName: 'Число',
          isExpandable: false,
        };
      },
    };

    const internals = session as unknown as {
      _client: unknown;
      _pausedThreadId: number;
      _threadMap: Map<number, string>;
    };
    internals._client = fakeClient;
    internals._pausedThreadId = 1;
    internals._threadMap.set(1, 'target-1');

    await session.evaluateForTest({ expression: 'Сумма', context: 'watch' });
    await session.evaluateForTest({ expression: 'Сумма', context: 'watch' });

    assert.strictEqual(evaluateCalls, 1);
    assert.strictEqual(session.responses.length, 2);
    assert.strictEqual(session.responses[0].body?.result, 'Сумма:1');
    assert.strictEqual(session.responses[1].body?.result, 'Сумма:1');
  });

  test('non-watch evaluate is not cached', async () => {
    const session = new TestBslDebugSession();
    let evaluateCalls = 0;
    const fakeClient = {
      async evaluate(_targetId: string, expression: string, _frameLevel: number): Promise<RdbgEvalResult> {
        evaluateCalls++;
        return {
          value: `${expression}:${evaluateCalls}`,
          typeName: 'Число',
          isExpandable: false,
        };
      },
    };

    const internals = session as unknown as {
      _client: unknown;
      _pausedThreadId: number;
      _threadMap: Map<number, string>;
    };
    internals._client = fakeClient;
    internals._pausedThreadId = 1;
    internals._threadMap.set(1, 'target-1');

    await session.evaluateForTest({ expression: 'Сумма', context: 'repl' });
    await session.evaluateForTest({ expression: 'Сумма', context: 'repl' });

    assert.strictEqual(evaluateCalls, 2);
    assert.strictEqual(session.responses[0].body?.result, 'Сумма:1');
    assert.strictEqual(session.responses[1].body?.result, 'Сумма:2');
  });
});
