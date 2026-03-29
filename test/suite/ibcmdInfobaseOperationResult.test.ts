import * as assert from 'assert';
import {
  interpretIbcmdInfobaseOutcome,
  isIbcmdForceParameterRejectedLog,
} from '../../src/services/ibcmd/ibcmdInfobaseOperationResult';
import type { IbcmdStreamingRawOutcome } from '../../src/services/ibcmd/IbcmdStreamingRunner';

function baseRaw(over: Partial<IbcmdStreamingRawOutcome> = {}): IbcmdStreamingRawOutcome {
  return {
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
  });

  test('timedOut', () => {
    const r = interpretIbcmdInfobaseOutcome('export', baseRaw({ timedOut: true, exitCode: null }));
    assert.strictEqual(r.status, 'error');
    assert.ok(r.userMessage.includes('таймаут') || r.userMessage.includes('ожидания'));
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
