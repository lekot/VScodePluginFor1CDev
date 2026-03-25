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
  assert.ok(report.ibcmdCheck, 'report.ibcmdCheck');
  assert.ok(
    report.ibcmdCheck.status === 'executed' || report.ibcmdCheck.status === 'skipped' || report.ibcmdCheck.status === 'failed',
    'ibcmdCheck.status'
  );
  assert.ok(
    report.ibcmdCheck.exitCode === null || typeof report.ibcmdCheck.exitCode === 'number',
    'ibcmdCheck.exitCode'
  );
  assert.strictEqual(typeof report.ibcmdCheck.logSnippet, 'string', 'ibcmdCheck.logSnippet');
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

  test('runContainerMatrixOnFreshFixture JSON report shape and file match', async function () {
    this.timeout(30_000);
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
    assert.strictEqual(report.ibcmdCheck.status, 'skipped', 'ibcmdCheck skipped when import skipped');
    assert.strictEqual(report.ibcmdCheck.exitCode, null, 'skipped ibcmdCheck has null exitCode');
    assert.ok(
      report.ibcmdCheck.logSnippet.includes('import skipped'),
      'ibcmdCheck should explain import was skipped'
    );

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
    assert.deepStrictEqual(parsed.ibcmdCheck, report.ibcmdCheck);
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

  test('isMatrixTarget: FilterCriteria type folder false (ibcmd needs non-empty Content/Type refs)', () => {
    const configuration: TreeNode = {
      id: 'cfg',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
    };
    const common: TreeNode = {
      id: 'Common',
      name: 'Общие',
      type: MetadataType.Unknown,
      properties: {},
      parent: configuration,
    };
    const filterCriteriaFolder: TreeNode = {
      id: 'FilterCriteria',
      name: 'Критерии отбора',
      type: MetadataType.FilterCriterion,
      properties: {},
      parent: common,
    };
    assert.strictEqual(isMatrixTarget(filterCriteriaFolder), false);
  });

  test('isMatrixTarget: ExternalDataSources type folder false (ibcmd needs table/schema content)', () => {
    const configuration: TreeNode = {
      id: 'cfg',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
    };
    const common: TreeNode = {
      id: 'Common',
      name: 'Общие',
      type: MetadataType.Unknown,
      properties: {},
      parent: configuration,
    };
    const externalDataSourcesFolder: TreeNode = {
      id: 'ExternalDataSources',
      name: 'Внешние источники данных',
      type: MetadataType.ExternalDataSource,
      properties: {},
      parent: common,
    };
    assert.strictEqual(isMatrixTarget(externalDataSourcesFolder), false);
  });

  test('isMatrixTarget: ChartsOfAccounts type folder false (ibcmd needs full CoA model)', () => {
    const configuration: TreeNode = {
      id: 'cfg',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
    };
    const chartsOfAccountsFolder: TreeNode = {
      id: 'ChartsOfAccounts',
      name: 'Планы счетов',
      type: MetadataType.ChartOfAccounts,
      properties: {},
      parent: configuration,
    };
    assert.strictEqual(isMatrixTarget(chartsOfAccountsFolder), false);
  });

  test('isMatrixTarget: ibcmd-fragile type folders false (web service, subscriptions, registers, FO, …)', () => {
    const configuration: TreeNode = {
      id: 'cfg',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
    };
    const cases: { id: string; type: MetadataType }[] = [
      { id: 'WebServices', type: MetadataType.WebService },
      { id: 'EventSubscriptions', type: MetadataType.EventSubscription },
      { id: 'ScheduledJobs', type: MetadataType.ScheduledJob },
      { id: 'FunctionalOptions', type: MetadataType.FunctionalOption },
      { id: 'FunctionalOptionsParameters', type: MetadataType.FunctionalOptionsParameter },
      { id: 'CommonCommands', type: MetadataType.CommonCommand },
      { id: 'AccountingRegisters', type: MetadataType.AccountingRegister },
      { id: 'CalculationRegisters', type: MetadataType.CalculationRegister },
    ];
    for (const { id, type } of cases) {
      const folder: TreeNode = {
        id,
        name: id,
        type,
        properties: {},
        parent: configuration,
      };
      assert.strictEqual(isMatrixTarget(folder), false, id);
    }
  });

  test('isMatrixTarget: Roles type folder true, Role instance false', () => {
    const configuration: TreeNode = {
      id: 'cfg',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      children: [],
    };
    const common: TreeNode = {
      id: 'Common',
      name: 'Общие',
      type: MetadataType.Unknown,
      properties: {},
      parent: configuration,
      children: [],
    };
    configuration.children = [common];
    const rolesFolder: TreeNode = {
      id: 'Roles',
      name: 'Роли',
      type: MetadataType.Role,
      properties: {},
      parent: common,
      children: [],
    };
    common.children = [rolesFolder];
    assert.strictEqual(isMatrixTarget(rolesFolder), true);

    const roleInstance: TreeNode = {
      id: 'Roles.R1',
      name: 'R1',
      type: MetadataType.Role,
      properties: {},
      parent: rolesFolder,
    };
    assert.strictEqual(isMatrixTarget(roleInstance), false);

    const attrsUnderRole: TreeNode = {
      id: 'Attributes',
      name: 'Реквизиты',
      type: MetadataType.Attribute,
      properties: {},
      parent: roleInstance,
    };
    assert.strictEqual(
      isMatrixTarget(attrsUnderRole),
      false,
      'Attributes under Role: Role has no ChildObjects per spec / ROOT_TAGS_WITHOUT_CHILDOBJECTS'
    );
  });
});
