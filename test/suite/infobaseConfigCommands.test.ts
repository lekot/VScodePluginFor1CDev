import * as assert from 'assert';
import { serializeInfobaseConfigIbcmdOp } from '../../src/infobases/infobaseConfigCommands';

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

suite('infobaseConfigCommands serializeInfobaseConfigIbcmdOp', () => {
  test('serializes concurrent callers: second runs after first completes', async () => {
    const order: string[] = [];
    const p1 = serializeInfobaseConfigIbcmdOp(async () => {
      order.push('1-start');
      await delay(25);
      order.push('1-end');
    });
    const p2 = serializeInfobaseConfigIbcmdOp(async () => {
      order.push('2');
    });
    await Promise.all([p1, p2]);
    assert.deepStrictEqual(order, ['1-start', '1-end', '2']);
  });

  test('rejected op is swallowed on chain but caller still rejects; next op runs', async () => {
    const order: string[] = [];
    const e1 = await serializeInfobaseConfigIbcmdOp(async () => {
      order.push('a');
      throw new Error('planned');
    }).catch((e) => e as Error);
    assert.ok(e1 instanceof Error);
    assert.strictEqual(e1.message, 'planned');

    await serializeInfobaseConfigIbcmdOp(async () => {
      order.push('b');
    });
    assert.deepStrictEqual(order, ['a', 'b']);
  });

  test('returns resolved value to caller', async () => {
    const v = await serializeInfobaseConfigIbcmdOp(async () => 42);
    assert.strictEqual(v, 42);
  });
});
