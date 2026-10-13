import * as assert from 'assert';
import {
  interpretIbcmdInfobaseOutcome,
  isIbcmdForceParameterRejectedLog,
} from '../../src/services/ibcmd/ibcmdInfobaseOperationResult';
import type { IbcmdStreamingRawOutcome } from '../../src/services/ibcmd/IbcmdStreamingRunner';

function baseRaw(over: Partial<IbcmdStreamingRawOutcome> = {}): IbcmdStreamingRawOutcome {
  return {
    started: false,
    effectPossible: false,
    exitCode: 0,
    signal: null,
    combinedLog: '',
    logTruncated: false,
    cancelled: false,
    timedOut: false,
    ...over,
  };
}

suite('ibcmdInfobaseOperationResult', () => {
  test('success when exit 0', () => {
    const r = interpretIbcmdInfobaseOutcome('check', baseRaw({ exitCode: 0 }));
    assert.strictEqual(r.status, 'success');
    assert.strictEqual(r.exitCode, 0);
    assert.ok(r.userMessage.length > 0);
  });

  test('import exit 2 → locked message', () => {
    const r = interpretIbcmdInfobaseOutcome('import', baseRaw({ exitCode: 2 }));
    assert.strictEqual(r.status, 'error');
    assert.strictEqual(r.exitCode, 2);
    assert.ok(r.userMessage.includes('заблокирована'));
  });

  test('import exit 2 + force-flag parse log → not locked (CLI parse)', () => {
    const r = interpretIbcmdInfobaseOutcome(
      'import',
      baseRaw({
        exitCode: 2,
        combinedLog: 'Ошибка разбора параметра: --force\n',
      }),
    );
    assert.strictEqual(r.status, 'error');
    assert.strictEqual(r.exitCode, 2);
    assert.ok(!r.userMessage.includes('заблокирована'));
    assert.ok(r.userMessage.includes('разборе командной строки'));
  });

  test('import exit 1 + English Invalid parameter --force → CLI parse message', () => {
    const r = interpretIbcmdInfobaseOutcome(
      'import',
      baseRaw({
        exitCode: 1,
        combinedLog: 'Invalid parameter: --force',
      }),
    );
    assert.strictEqual(r.exitCode, 1);
    assert.ok(!r.userMessage.includes('заблокирована'));
    assert.ok(r.userMessage.includes('разборе командной строки'));
  });

  test('isIbcmdForceParameterRejectedLog: RU + --force', () => {
    assert.strictEqual(
      isIbcmdForceParameterRejectedLog('Ошибка разбора параметра: --force'),
      true,
    );
  });

  test('isIbcmdForceParameterRejectedLog: RU + -F (как в части сборок ibcmd)', () => {
    assert.strictEqual(isIbcmdForceParameterRejectedLog('Ошибка разбора параметра: -F'), true);
  });

  test('import exit 1 + RU parse -F → CLI parse message (не «база заблокирована»)', () => {
    const r = interpretIbcmdInfobaseOutcome(
      'import',
      baseRaw({
        exitCode: 1,
        combinedLog: 'Ошибка разбора параметра: -F\n',
      }),
    );
    assert.strictEqual(r.exitCode, 1);
    assert.ok(!r.userMessage.includes('заблокирована'));
    assert.ok(r.userMessage.includes('разборе командной строки'));
  });

  test('isIbcmdForceParameterRejectedLog: EN Parameter parsing + -F', () => {
    assert.strictEqual(isIbcmdForceParameterRejectedLog('Parameter parsing failed: -F'), true);
  });

  test('isIbcmdForceParameterRejectedLog: exit-2 lock text without parse → false', () => {
    assert.strictEqual(isIbcmdForceParameterRejectedLog('База занята другим процессом'), false);
  });

  test('import exit 3 → connection message', () => {
    const r = interpretIbcmdInfobaseOutcome('import', baseRaw({ exitCode: 3 }));
    assert.strictEqual(r.status, 'error');
    assert.ok(r.userMessage.includes('подключ'));
  });

  test('import exit 99 → generic', () => {
    const r = interpretIbcmdInfobaseOutcome('import', baseRaw({ exitCode: 99 }));
    assert.strictEqual(r.status, 'error');
    assert.ok(r.userMessage.includes('Ошибка'));
  });

  test('export/check nonzero → generic message (no import-specific map)', () => {
    const e = interpretIbcmdInfobaseOutcome('export', baseRaw({ exitCode: 2 }));
    assert.strictEqual(e.status, 'error');
    assert.ok(!e.userMessage.includes('заблокирована'));
    const c = interpretIbcmdInfobaseOutcome('check', baseRaw({ exitCode: 3 }));
    assert.strictEqual(c.status, 'error');
    assert.ok(!c.userMessage.includes('подключ'));
  });

  test('cancelled', () => {
    const r = interpretIbcmdInfobaseOutcome('import', baseRaw({ cancelled: true, exitCode: null }));
    assert.strictEqual(r.status, 'cancelled');
    assert.strictEqual(
      (r as unknown as { effectPossible?: boolean }).effectPossible,
      false,
      'pre-spawn cancellation must preserve the receipt that no effect was possible',
    );
  });

  test('child handle before spawn event is inDoubt when the runner says effects are possible', () => {
    const r = interpretIbcmdInfobaseOutcome('import', baseRaw({
      started: false,
      effectPossible: true,
      exitCode: null,
      cancelled: true,
    }));
    assert.strictEqual(r.status as string, 'inDoubt');
    assert.strictEqual((r as unknown as { effectPossible?: boolean }).effectPossible, true);
  });

  test('failed process-tree termination is inDoubt even without cancel or timeout flags', () => {
    const termination = {
      terminated: false,
      hardKillUsed: true,
      survivingPids: [9002],
      errors: ['termination confirmation unavailable'],
    };
    const r = interpretIbcmdInfobaseOutcome('apply', baseRaw({
      started: false,
      effectPossible: true,
      exitCode: null,
      spawnErrorCode: 'PROCESS_TREE_TERMINATION_FAILED',
      termination,
    }));
    assert.strictEqual(r.status as string, 'inDoubt');
    assert.strictEqual((r as unknown as { effectPossible?: boolean }).effectPossible, true);
    assert.deepStrictEqual((r as unknown as { termination?: unknown }).termination, termination);
  });

  test('timedOut', () => {
    const r = interpretIbcmdInfobaseOutcome('export', baseRaw({ timedOut: true, exitCode: null }));
    assert.strictEqual(r.status, 'error');
    assert.ok(r.userMessage.includes('таймаут') || r.userMessage.includes('ожидания'));
  });

  test('post-spawn import cancellation is inDoubt and preserves effect and termination', () => {
    const termination = {
      terminated: true,
      hardKillUsed: false,
      survivingPids: [],
      errors: [],
    };
    const r = interpretIbcmdInfobaseOutcome('import', baseRaw({
      started: true,
      effectPossible: true,
      exitCode: null,
      signal: 'SIGTERM',
      cancelled: true,
      termination,
    }));
    const receipt = r as unknown as { status: string; effectPossible?: boolean; termination?: unknown };
    assert.strictEqual(receipt.status, 'inDoubt');
    assert.strictEqual(receipt.effectPossible, true);
    assert.deepStrictEqual(receipt.termination, termination);
    assert.ok(r.userMessage.toLowerCase().includes('неопредел'));
  });

  test('post-spawn cancellation of every mutating operation is inDoubt', () => {
    for (const op of ['import', 'apply', 'export'] as const) {
      const r = interpretIbcmdInfobaseOutcome(op, baseRaw({
        started: true,
        effectPossible: true,
        exitCode: null,
        cancelled: true,
      }));
      assert.strictEqual(r.status as string, 'inDoubt', `${op} cancellation after spawn`);
      assert.strictEqual((r as unknown as { effectPossible?: boolean }).effectPossible, true);
    }
  });

  test('post-spawn timeout is inDoubt even when process-tree termination leaves survivors', () => {
    const termination = {
      terminated: false,
      hardKillUsed: true,
      survivingPids: [7124],
      errors: ['taskkill did not confirm exit'],
    };
    const r = interpretIbcmdInfobaseOutcome('apply', baseRaw({
      started: true,
      effectPossible: true,
      exitCode: null,
      signal: 'SIGTERM',
      timedOut: true,
      termination,
    }));
    const receipt = r as unknown as { status: string; effectPossible?: boolean; termination?: unknown };
    assert.strictEqual(receipt.status, 'inDoubt');
    assert.strictEqual(receipt.effectPossible, true);
    assert.deepStrictEqual(receipt.termination, termination);
  });

  test('an unconfirmed process-tree stop is inDoubt for a started mutating export', () => {
    const termination = {
      terminated: false,
      hardKillUsed: true,
      survivingPids: [9001],
      errors: ['kill failed'],
    };
    const r = interpretIbcmdInfobaseOutcome('export', baseRaw({
      started: true,
      effectPossible: true,
      exitCode: 1,
      termination,
    }));
    assert.strictEqual(r.status as string, 'inDoubt');
    assert.deepStrictEqual(
      (r as unknown as { termination?: unknown }).termination,
      termination,
    );
  });

  test('read-only check cancellation stays cancelled and preserves process lifecycle details', () => {
    const termination = {
      terminated: true,
      hardKillUsed: false,
      survivingPids: [],
      errors: [],
    };
    const r = interpretIbcmdInfobaseOutcome('check', baseRaw({
      started: true,
      effectPossible: true,
      exitCode: null,
      cancelled: true,
      termination,
    }));
    assert.strictEqual(r.status, 'cancelled');
    assert.strictEqual((r as unknown as { effectPossible?: boolean }).effectPossible, true);
    assert.deepStrictEqual((r as unknown as { termination?: unknown }).termination, termination);
  });

  test('confirmed nonzero exit remains an ordinary error even though the process started', () => {
    const r = interpretIbcmdInfobaseOutcome('import', baseRaw({
      started: true,
      effectPossible: true,
      exitCode: 2,
    }));
    assert.strictEqual(r.status, 'error');
    assert.strictEqual(r.exitCode, 2);
  });

  test('ENOENT spawn', () => {
    const r = interpretIbcmdInfobaseOutcome('check', baseRaw({ spawnErrorCode: 'ENOENT' }));
    assert.strictEqual(r.status, 'error');
    assert.ok(r.userMessage.includes('ibcmd'));
  });

  test('ENOTDIR spawn → same hint as ENOENT', () => {
    const r = interpretIbcmdInfobaseOutcome('import', baseRaw({ spawnErrorCode: 'ENOTDIR' }));
    assert.strictEqual(r.status, 'error');
    assert.ok(r.userMessage.includes('не найден'));
  });

  test('import exit 1 → generic import error text', () => {
    const r = interpretIbcmdInfobaseOutcome('import', baseRaw({ exitCode: 1 }));
    assert.strictEqual(r.status, 'error');
    assert.strictEqual(r.exitCode, 1);
    assert.ok(r.userMessage.includes('Ошибка'));
  });

  test('spawn error code without message uses code in text', () => {
    const r = interpretIbcmdInfobaseOutcome('export', baseRaw({ spawnErrorCode: 'UNKNOWN' }));
    assert.strictEqual(r.status, 'error');
    assert.ok(r.userMessage.includes('UNKNOWN'));
  });

  test('other spawn error', () => {
    const r = interpretIbcmdInfobaseOutcome('check', baseRaw({ spawnErrorCode: 'EACCES', spawnErrorMessage: 'nope' }));
    assert.strictEqual(r.status, 'error');
    assert.ok(r.userMessage.includes('nope'));
  });

  test('preserves log excerpt and truncation flag', () => {
    const r = interpretIbcmdInfobaseOutcome('check', baseRaw({ exitCode: 0, combinedLog: 'ok', logTruncated: true }));
    assert.strictEqual(r.logExcerpt, 'ok');
    assert.strictEqual(r.logTruncated, true);
  });
});
