import type { ContainerMatrixReport } from './containerMatrixRunner';

export interface InstrumentMatrixOutcome {
  fatal: boolean;
  reason?: 'matrix-steps' | 'ibcmd';
}

/**
 * Matrix CRUD failures are always fatal. `INSTRUMENT_IBCMD_NONFATAL` only
 * relaxes the external ibcmd import/check gate and must never hide product
 * operation failures recorded in `stepSummary`.
 */
export function evaluateInstrumentMatrixOutcome(
  report: Pick<ContainerMatrixReport, 'stepSummary' | 'ibcmd' | 'ibcmdCheck'>,
  ibcmdNonfatal: boolean
): InstrumentMatrixOutcome {
  if (report.stepSummary.failed > 0) {
    return { fatal: true, reason: 'matrix-steps' };
  }
  const ibcmdFailed = report.ibcmd.status === 'failed' || report.ibcmdCheck.status === 'failed';
  if (ibcmdFailed && !ibcmdNonfatal) {
    return { fatal: true, reason: 'ibcmd' };
  }
  return { fatal: false };
}
