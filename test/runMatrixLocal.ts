/**
 * Local runner: container matrix on an existing Designer tree (your fixture path).
 * Requires compiled output: tsc -p tsconfig.test.json
 *
 * **Mutates the directory** (create/delete on disk). Use a **copy** of your export, not the only original.
 *
 * Env:
 *   MATRIX_WORK_DIR  — required, absolute or relative path to configuration root (Configuration.xml)
 *   MATRIX_FULL=1    — optional, full target set (default: slice / MATRIX_SLICE_LIMIT)
 *   MATRIX_SLICE_LIMIT — optional, when MATRIX_FULL unset
 *   MATRIX_REPORT_PATH — optional JSON report path
 *   MATRIX_VERBOSE=1 — optional, include error stacks in report
 *   IBCMD_PATH            — optional path to ibcmd.exe
 *   IBCMD_INFOBASE_CONFIG — optional YAML for target IB (required together with IBCMD_PATH for import)
 *   IBCMD_USER / IBCMD_PASSWORD / IBCMD_TIMEOUT_MS — optional (see docs/design/e2e-container-matrix-ibcmd.md §6.5)
 *   IBMATRIX_SKIP_CONFIG_CHECK=1 — optional; skip `ibcmd infobase config check` after successful import (see design §6.6)
 *
 * Nested matrix pass (second DFS) also targets R6 folders under Matrix_* objects: EnumValues, Dimensions, Resources,
 * PredefinedData (Catalog / ChartOfCharacteristicTypes) so `ibcmd` import validates GH-77 create paths when MATRIX_NESTED=1 or full matrix.
 */
import './helpers/vscodeStubRegister';
import { runContainerMatrix } from './matrix/containerMatrixRunner';

async function main(): Promise<void> {
  const workDir = process.env.MATRIX_WORK_DIR?.trim();
  if (!workDir) {
    console.error(
      'Set MATRIX_WORK_DIR to the Designer configuration root (directory containing Configuration.xml).'
    );
    process.exit(2);
  }

  const matrixFull = process.env.MATRIX_FULL === '1';
  const reportPath = process.env.MATRIX_REPORT_PATH?.trim() || undefined;

  const { report, reportFile } = await runContainerMatrix({
    workDir,
    matrixFull,
    reportPath,
  });

  console.log(
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

  const ibcmdFailed = report.ibcmd.status === 'failed' || report.ibcmdCheck.status === 'failed';
  const stepsFailed = report.stepSummary.failed > 0;
  if (stepsFailed || ibcmdFailed) {
    process.exit(1);
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
