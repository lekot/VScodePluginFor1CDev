/**
 * Endgame для `scripts/instrument-smoke.bat`: контейнерная матрица на свежей копии `FormatSamples/empty_conf`
 * (или на `MATRIX_WORK_DIR`) и опциональная проверка **ibcmd** (`IBCMD_PATH` + `IBCMD_INFOBASE_CONFIG`).
 *
 * Переменные: как у `runMatrixLocal.ts` / design §6.5. Без `MATRIX_WORK_DIR` создаётся temp-копия и удаляется после прогона.
 */
import * as fs from 'fs';
import * as path from 'path';
import './helpers/vscodeStubRegister';
import { copyEmptyConfFixtureToTemp } from './helpers/matrixTreeWalker';
import { runContainerMatrix } from './matrix/containerMatrixRunner';

async function main(): Promise<void> {
  let workDir = process.env.MATRIX_WORK_DIR?.trim();
  let ownsTemp = false;
  if (!workDir) {
    workDir = copyEmptyConfFixtureToTemp();
    ownsTemp = true;
  } else {
    workDir = path.resolve(workDir);
  }

  const matrixFull = process.env.MATRIX_FULL === '1';
  const reportPath =
    process.env.MATRIX_REPORT_PATH?.trim() ||
    path.join(process.cwd(), 'suite-reports', 'instrument-matrix.json');

  try {
    if (fs.existsSync(reportPath)) {
      fs.unlinkSync(reportPath);
    }

    const { report, reportFile } = await runContainerMatrix({
      workDir,
      matrixFull,
      reportPath,
    });

    console.log(
      '[instrument-smoke:matrix]',
      JSON.stringify(
        {
          reportFile,
          stepSummary: report.stepSummary,
          ibcmd: report.ibcmd,
          ibcmdCheck: report.ibcmdCheck,
          stepsTotal: report.steps.length,
        },
        null,
        2
      )
    );

    const ibcmdFailed =
      report.ibcmd.status === 'failed' || report.ibcmdCheck.status === 'failed';
    if (ibcmdFailed) {
      if (process.env.INSTRUMENT_IBCMD_NONFATAL === '1') {
        console.warn(
          '[instrument-smoke:matrix] ibcmd import/check failed (see report JSON `ibcmd` / `ibcmdCheck`) — INSTRUMENT_IBCMD_NONFATAL=1, continuing to VS Code smoke.'
        );
      } else {
        process.exit(1);
      }
    }
    if (report.stepSummary.failed > 0) {
      console.warn(
        '[instrument-smoke:matrix] stepSummary has failures (see report JSON) — exit 0; fix product or fixture, or use MATRIX_SLICE_LIMIT / MATRIX_FULL.'
      );
    }
  } finally {
    if (ownsTemp && workDir) {
      const parent = path.dirname(workDir);
      if (fs.existsSync(parent)) {
        try {
          fs.rmSync(parent, { recursive: true, force: true });
        } catch {
          /* ignore cleanup errors */
        }
      }
    }
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
