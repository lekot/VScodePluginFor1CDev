import * as assert from 'assert';
import { evaluateInstrumentMatrixOutcome } from '../matrix/instrumentMatrixOutcome';

function report(
  failed: number,
  ibcmd: 'executed' | 'skipped' | 'failed' = 'executed',
  ibcmdCheck: 'executed' | 'skipped' | 'failed' = 'executed'
) {
  return {
    stepSummary: { passed: 1, failed, skipped: 0 },
    ibcmd: { status: ibcmd, exitCode: ibcmd === 'failed' ? 1 : 0, logSnippet: '' },
    ibcmdCheck: { status: ibcmdCheck, exitCode: ibcmdCheck === 'failed' ? 1 : 0, logSnippet: '' },
  };
}

suite('Instrument matrix outcome', () => {
  test('matrix step failures are fatal even when ibcmd is nonfatal', () => {
    assert.deepStrictEqual(
      evaluateInstrumentMatrixOutcome(report(1), true),
      { fatal: true, reason: 'matrix-steps' }
    );
  });

  test('ibcmd failure can be explicitly nonfatal', () => {
    assert.deepStrictEqual(evaluateInstrumentMatrixOutcome(report(0, 'failed'), true), { fatal: false });
  });

  test('ibcmd failure is fatal by default', () => {
    assert.deepStrictEqual(
      evaluateInstrumentMatrixOutcome(report(0, 'executed', 'failed'), false),
      { fatal: true, reason: 'ibcmd' }
    );
  });
});
