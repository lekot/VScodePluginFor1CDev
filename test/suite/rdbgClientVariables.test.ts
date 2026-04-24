import * as assert from 'assert';

import { RdbgClient } from '../../src/debug/rdbg/rdbgClient';
import { RdbgTransport } from '../../src/debug/rdbg/rdbgTransport';

suite('RdbgClient — variables', () => {
  test('top-level locals do not issue any RDBG evaluation request', async () => {
    const calls: { command: string; body: string }[] = [];
    const transport = {
      async send(command: string, body: string): Promise<string> {
        calls.push({ command, body });
        throw new Error(`${command} must not be called for top-level locals`);
      },
    } as unknown as RdbgTransport;

    const client = new RdbgClient(transport, 'aaaaaaaa-0000-0000-0000-000000000001');
    (client as unknown as { _state: string })._state = 'attached';

    const variables = await client.evalLocalVariables('bbbbbbbb-0000-0000-0000-000000000001', 0);

    assert.deepStrictEqual(variables, []);
    assert.deepStrictEqual(calls, []);
  });
});
