import * as assert from 'assert';
import { getWebviewHtml } from '../../src/formEditor/formWebviewHtml';
import { createSerializedExecutor } from '../../src/formEditor/formMessageHandler';

suite('form editor message handling regressions', () => {
  test('webview property change uses dataset key for regular props', () => {
    const html = getWebviewHtml({} as any);
    assert.ok(
      html.includes("const key = inp.dataset.key ? inp.dataset.key : (inp.id ? inp.id.replace('prop-', '') : null);"),
      'property key extraction should prioritize data-key with correct precedence'
    );
    assert.ok(
      !html.includes("const key = inp.dataset.key || inp.id ? inp.id.replace('prop-', '') : null;"),
      'buggy operator-precedence expression must be removed'
    );
    assert.ok(
      html.includes('selectedAttributeId = attr.id || attr.name;'),
      'attribute selection should prefer stable id'
    );
    assert.ok(
      html.includes('selectedCommandId = cmd.id || cmd.name;'),
      'command selection should prefer stable id'
    );
  });

  test('serialized executor preserves in-flight operation ordering', async () => {
    const events: string[] = [];
    const run = createSerializedExecutor(async (payload: { name: string; delayMs: number }) => {
      events.push(`start:${payload.name}`);
      await new Promise((resolve) => setTimeout(resolve, payload.delayMs));
      events.push(`end:${payload.name}`);
    });

    const first = run({ name: 'first', delayMs: 25 });
    const second = run({ name: 'second', delayMs: 0 });
    await Promise.all([first, second]);

    assert.deepStrictEqual(events, [
      'start:first',
      'end:first',
      'start:second',
      'end:second',
    ]);
  });
});
