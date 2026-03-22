import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MetadataType, TreeNode } from '../../src/models/treeNode';
import { ConfigFormat } from '../../src/parsers/formatDetector';
import { clearDesignerTemplateRepositoryForTests } from '../../src/services/designerTemplateRepository';
import { ContainerMatrixReport, runContainerMatrixOnFreshFixture } from '../matrix/containerMatrixRunner';
import { isMatrixTarget } from '../matrix/matrixTargetPredicate';

function assertReportShape(report: ContainerMatrixReport): void {
  assert.strictEqual(typeof report.runId, 'string', 'report.runId');
  assert.ok(report.runId.length > 0, 'report.runId non-empty');
  assert.strictEqual(typeof report.timestamp, 'string', 'report.timestamp');
  assert.ok(report.timestamp.length > 0, 'report.timestamp non-empty');
  assert.strictEqual(typeof report.fixturePath, 'string', 'report.fixturePath');
  assert.strictEqual(typeof report.workDir, 'string', 'report.workDir');
  assert.strictEqual(report.configFormat, ConfigFormat.Designer, 'report.configFormat');
  assert.ok(Array.isArray(report.steps), 'report.steps is array');
  assert.ok(report.stepSummary, 'report.stepSummary');
  assert.strictEqual(typeof report.stepSummary.passed, 'number', 'stepSummary.passed');
  assert.strictEqual(typeof report.stepSummary.failed, 'number', 'stepSummary.failed');
  assert.strictEqual(typeof report.stepSummary.skipped, 'number', 'stepSummary.skipped');
  assert.ok(report.ibcmd, 'report.ibcmd');
  assert.ok(
    report.ibcmd.status === 'executed' || report.ibcmd.status === 'skipped' || report.ibcmd.status === 'failed',
    'ibcmd.status'
  );
  assert.ok(
    report.ibcmd.exitCode === null || typeof report.ibcmd.exitCode === 'number',
    'ibcmd.exitCode'
  );
  assert.strictEqual(typeof report.ibcmd.logSnippet, 'string', 'ibcmd.logSnippet');
}

suite('Container matrix e2e', () => {
  let savedIbcmdPath: string | undefined;
  let savedMatrixReportPath: string | undefined;
  let matrixReportFile: string;
  let lastWorkDir: string | undefined;

  suiteSetup(() => {
    clearDesignerTemplateRepositoryForTests();
    savedIbcmdPath = process.env.IBCMD_PATH;
    delete process.env.IBCMD_PATH;

    savedMatrixReportPath = process.env.MATRIX_REPORT_PATH;
    matrixReportFile = path.join(
      os.tmpdir(),
      `1cviewer-container-matrix-e2e-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.json`
    );
    process.env.MATRIX_REPORT_PATH = matrixReportFile;
  });

  suiteTeardown(() => {
    if (savedIbcmdPath !== undefined) {
      process.env.IBCMD_PATH = savedIbcmdPath;
    } else {
      delete process.env.IBCMD_PATH;
    }
    if (savedMatrixReportPath !== undefined) {
      process.env.MATRIX_REPORT_PATH = savedMatrixReportPath;
    } else {
      delete process.env.MATRIX_REPORT_PATH;
    }
    if (lastWorkDir) {
      const tempParent = path.dirname(lastWorkDir);
      if (fs.existsSync(tempParent)) {
        fs.rmSync(tempParent, { recursive: true, force: true });
      }
    }
    if (matrixReportFile && fs.existsSync(matrixReportFile)) {
      fs.unlinkSync(matrixReportFile);
    }
    clearDesignerTemplateRepositoryForTests();
  });

  test('runContainerMatrixOnFreshFixture JSON report shape and file match', async () => {
    const { report, reportFile, workDir } = await runContainerMatrixOnFreshFixture({
      matrixFull: false,
    });
    lastWorkDir = workDir;

    assertReportShape(report);
    assert.strictEqual(
      report.ibcmd.status,
      'skipped',
      'without IBCMD_PATH (and no IBCMD_INFOBASE_CONFIG) ibcmd step must be skipped (design §6.5 / ADR-003)'
    );
    assert.strictEqual(report.ibcmd.exitCode, null, 'skipped ibcmd has null exitCode');

    const resolvedExpected = path.resolve(matrixReportFile);
    assert.strictEqual(reportFile, resolvedExpected, 'reportFile follows MATRIX_REPORT_PATH');

    assert.ok(fs.existsSync(reportFile), 'report file exists');
    const raw = fs.readFileSync(reportFile, 'utf-8');
    const parsed = JSON.parse(raw) as ContainerMatrixReport;
    assert.strictEqual(parsed.runId, report.runId);
    assert.strictEqual(parsed.timestamp, report.timestamp);
    assert.strictEqual(parsed.fixturePath, report.fixturePath);
    assert.strictEqual(parsed.workDir, report.workDir);
    assert.strictEqual(parsed.configFormat, report.configFormat);
    assert.deepStrictEqual(parsed.stepSummary, report.stepSummary);
    assert.deepStrictEqual(parsed.ibcmd, report.ibcmd);
    assert.strictEqual(parsed.steps.length, report.steps.length);
  });

  test('isMatrixTarget: Configuration false, Forms folder true', () => {
    const configuration: TreeNode = {
      id: 'cfg',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
    };
    assert.strictEqual(isMatrixTarget(configuration), false);

    const formsFolder: TreeNode = {
      id: 'Forms',
      name: 'Forms',
      type: MetadataType.Form,
      properties: {},
    };
    assert.strictEqual(isMatrixTarget(formsFolder), true);
  });

  test('isMatrixTarget: Attributes under Catalog true, under Subsystem false', () => {
    const catalogsFolder: TreeNode = {
      id: 'Catalogs',
      name: 'Справочники',
      type: MetadataType.Catalog,
      properties: {},
    };
    const catalogObject: TreeNode = {
      id: 'Catalogs.TestCat',
      name: 'TestCat',
      type: MetadataType.Catalog,
      properties: {},
      parent: catalogsFolder,
    };
    const attrsUnderCatalog: TreeNode = {
      id: 'Attributes',
      name: 'Реквизиты',
      type: MetadataType.Attribute,
      properties: {},
      parent: catalogObject,
    };
    assert.strictEqual(isMatrixTarget(attrsUnderCatalog), true);

    const subsystemsFolder: TreeNode = {
      id: 'Subsystems',
      name: 'Подсистемы',
      type: MetadataType.Subsystem,
      properties: {},
    };
    const subsystemObject: TreeNode = {
      id: 'Subsystems.S1',
      name: 'S1',
      type: MetadataType.Subsystem,
      properties: {},
      parent: subsystemsFolder,
    };
    const attrsUnderSubsystem: TreeNode = {
      id: 'Attributes',
      name: 'Реквизиты',
      type: MetadataType.Attribute,
      properties: {},
      parent: subsystemObject,
    };
    assert.strictEqual(isMatrixTarget(attrsUnderSubsystem), false);
  });
});
