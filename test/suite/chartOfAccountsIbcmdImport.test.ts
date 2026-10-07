import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { getIbcmdService } from '../../src/services/ibcmd/ibcmdServiceSingleton';
import { planCreateChartOfAccounts } from '../../src/services/chartOfAccountsWizardService';
import { MutationPlanExecutor } from '../../src/services/configurationSession/mutationPlan';

async function copyDirectoryRecursive(src: string, dest: string): Promise<void> {
  await fs.promises.mkdir(dest, { recursive: true });
  const entries = await fs.promises.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirectoryRecursive(srcPath, destPath);
    } else {
      await fs.promises.copyFile(srcPath, destPath);
    }
  }
}

suite('ChartOfAccounts ibcmd Platform Integration Suite', function () {
  this.timeout(180_000);

  let tmpRoot: string | undefined;

  teardown(async () => {
    if (tmpRoot) {
      try {
        await fs.promises.rm(tmpRoot, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
      tmpRoot = undefined;
    }
  });

  test('ibcmd imports basic ChartOfAccounts and passes config check with zero warnings', async function () {
    const ibcmd = getIbcmdService();
    const resolved = await ibcmd.resolveExecutablePathAsync();
    if (resolved.kind !== 'resolved') {
      this.skip();
      return;
    }

    const repoRoot = path.resolve(__dirname, '../../..');
    const fixtureDir = path.join(repoRoot, 'FormatSamples/empty_conf');
    if (!fs.existsSync(fixtureDir)) {
      this.skip();
      return;
    }

    tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'coa-ibcmd-basic-'));
    const configDir = path.join(tmpRoot, 'conf');
    const dbDir = path.join(tmpRoot, 'db');
    const dataDir = path.join(tmpRoot, 'data');
    await fs.promises.mkdir(dbDir, { recursive: true });
    await fs.promises.mkdir(dataDir, { recursive: true });

    await copyDirectoryRecursive(fixtureDir, configDir);

    const plan = await planCreateChartOfAccounts({
      configPath: configDir,
      params: {
        name: 'ПланСчетовПростой',
        synonym: 'Простой план счетов',
        comment: 'Создано мастером для ibcmd проверки',
        codeMask: '@@@.@@.@',
        codeLength: 8,
        descriptionLength: 120,
        orderLength: 5,
        predefinedAccounts: [
          {
            name: 'Вспомогательный',
            code: '000',
            description: 'Вспомогательный счет',
            accountType: 'ActivePassive',
            offBalance: false,
          },
          {
            name: 'Касса',
            code: '50',
            description: 'Касса организации',
            accountType: 'Active',
            offBalance: false,
          },
        ],
      },
    });

    const executor = new MutationPlanExecutor(configDir);
    const planResult = await executor.execute(plan);
    assert.strictEqual(planResult.success, true, planResult.error);

    // Create empty infobase
    const createResult = await ibcmd.run(['infobase', 'create', `--db-path=${dbDir}`, `--data=${dataDir}`]);
    assert.ok(
      createResult.stdout.includes('Создание информационной базы успешно завершено'),
      `Create stdout: ${createResult.stdout}`
    );

    // Import configuration
    const importResult = await ibcmd.run([
      'infobase',
      'config',
      'import',
      `--db-path=${dbDir}`,
      `--data=${dataDir}`,
      configDir,
    ]);
    const fullImportLog = `${importResult.stdout}\n${importResult.stderr}`;

    assert.ok(
      !fullImportLog.includes('[WARN] Неверное свойство объекта метаданных'),
      `Import log contains metadata property warnings: ${fullImportLog}`
    );
    assert.ok(
      fullImportLog.includes('Импорт конфигурации из XML успешно завершен'),
      `Import must succeed: ${fullImportLog}`
    );

    // Check configuration
    const checkResult = await ibcmd.run(['infobase', 'config', 'check', `--db-path=${dbDir}`, `--data=${dataDir}`]);
    const fullCheckLog = `${checkResult.stdout}\n${checkResult.stderr}`;
    assert.ok(
      fullCheckLog.includes('Проверка корректности метаданных успешно завершена'),
      `Check must succeed: ${fullCheckLog}`
    );
  });

  test('ibcmd imports complex ChartOfAccounts with subconto and accounting flags with zero warnings', async function () {
    const ibcmd = getIbcmdService();
    const resolved = await ibcmd.resolveExecutablePathAsync();
    if (resolved.kind !== 'resolved') {
      this.skip();
      return;
    }

    const repoRoot = path.resolve(__dirname, '../../..');
    const fixtureDir = path.join(repoRoot, 'FormatSamples/empty_conf');
    if (!fs.existsSync(fixtureDir)) {
      this.skip();
      return;
    }

    tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'coa-ibcmd-complex-'));
    const configDir = path.join(tmpRoot, 'conf');
    const dbDir = path.join(tmpRoot, 'db');
    const dataDir = path.join(tmpRoot, 'data');
    await fs.promises.mkdir(dbDir, { recursive: true });
    await fs.promises.mkdir(dataDir, { recursive: true });

    await copyDirectoryRecursive(fixtureDir, configDir);

    const plan = await planCreateChartOfAccounts({
      configPath: configDir,
      params: {
        name: 'ПланСчетовХозрасчетный',
        synonym: 'Хозрасчетный план счетов с субконто',
        comment: 'С субконто и признаками учета',
        codeMask: '@@@.@@.@',
        codeLength: 8,
        descriptionLength: 120,
        orderLength: 5,
        extDimensionTypes: 'ChartOfCharacteristicTypes.ПланВидовХарактеристик1',
        maxExtDimensionCount: 3,
        accountingFlags: [
          { name: 'Валютный', synonym: 'Валютный учет' },
          { name: 'Количественный', synonym: 'Количественный учет' },
        ],
        extDimensionAccountingFlags: [
          { name: 'Суммовой', synonym: 'Суммовой учет субконто' },
        ],
        predefinedAccounts: [
          {
            name: 'РасчетыСПоставщиками',
            code: '60',
            description: 'Расчеты с поставщиками и подрядчиками',
            accountType: 'ActivePassive',
            offBalance: false,
          },
          {
            name: 'РасчетыСПокупателями',
            code: '62',
            description: 'Расчеты с покупателями и заказчиками',
            accountType: 'ActivePassive',
            offBalance: false,
          },
        ],
      },
    });

    const executor = new MutationPlanExecutor(configDir);
    const planResult = await executor.execute(plan);
    assert.strictEqual(planResult.success, true, planResult.error);

    // Create empty infobase
    const createResult = await ibcmd.run(['infobase', 'create', `--db-path=${dbDir}`, `--data=${dataDir}`]);
    assert.ok(
      createResult.stdout.includes('Создание информационной базы успешно завершено'),
      `Create stdout: ${createResult.stdout}`
    );

    // Import configuration
    const importResult = await ibcmd.run([
      'infobase',
      'config',
      'import',
      `--db-path=${dbDir}`,
      `--data=${dataDir}`,
      configDir,
    ]);
    const fullImportLog = `${importResult.stdout}\n${importResult.stderr}`;

    assert.ok(
      !fullImportLog.includes('[WARN] Неверное свойство объекта метаданных'),
      `Import log contains metadata property warnings: ${fullImportLog}`
    );
    assert.ok(
      fullImportLog.includes('Импорт конфигурации из XML успешно завершен'),
      `Import must succeed: ${fullImportLog}`
    );

    // Check configuration
    const checkResult = await ibcmd.run(['infobase', 'config', 'check', `--db-path=${dbDir}`, `--data=${dataDir}`]);
    const fullCheckLog = `${checkResult.stdout}\n${checkResult.stderr}`;
    assert.ok(
      fullCheckLog.includes('Проверка корректности метаданных успешно завершена'),
      `Check must succeed: ${fullCheckLog}`
    );
  });
});
