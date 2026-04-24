import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import { RdbgClient } from '../../src/debug/rdbg/rdbgClient';
import { RdbgTransport } from '../../src/debug/rdbg/rdbgTransport';

function readRdbgFixture(name: string): string {
  return fs.readFileSync(path.resolve(__dirname, '../../..', 'test/fixtures/rdbg', name), 'utf8');
}

suite('RdbgClient — variables', () => {
  test('top-level locals use evalExpr instead of evalLocalVariables to avoid dbgs crash', async () => {
    const calls: { command: string; body: string }[] = [];
    const transport = {
      async send(command: string, body: string): Promise<string> {
        calls.push({ command, body });
        if (command === 'evalLocalVariables') {
          throw new Error('evalLocalVariables must not be called for top-level locals');
        }
        return readRdbgFixture('evalExpr-response-context-properties.xml');
      },
    } as unknown as RdbgTransport;

    const client = new RdbgClient(transport, 'aaaaaaaa-0000-0000-0000-000000000001');
    (client as unknown as { _state: string })._state = 'attached';

    const variables = await client.evalLocalVariables('bbbbbbbb-0000-0000-0000-000000000001', 0);

    assert.deepStrictEqual(calls.map((c) => c.command), ['evalExpr']);
    assert.strictEqual(variables.length, 2);
    assert.ok(calls[0].body.includes('<debugCalculations:stackLevel>0</debugCalculations:stackLevel>'));
    assert.ok(!calls[0].body.includes('<debugCalculations:calcItem>'));
  });
});
