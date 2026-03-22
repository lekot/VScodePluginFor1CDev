import './helpers/vscodeStubRegister';
import * as path from 'path';
import Mocha from 'mocha';
import { coreSuiteFiles } from './suite/coreSuites';
import {
  resolveMissingMandatorySuites,
  writeSuiteExecutionReport,
} from './suite/suiteExecutionReport';

async function main(): Promise<void> {
  const mocha = new Mocha({
    ui: 'tdd',
    color: true,
  });

  const testsRoot = path.resolve(__dirname);
  const discoveredSuites = coreSuiteFiles.map((suiteFile) => suiteFile.replace(/\\/g, '/'));
  discoveredSuites.forEach((suiteFile) => mocha.addFile(path.resolve(testsRoot, suiteFile)));

  const executedSuitesSet = new Set<string>();
  const mandatoryRaw = process.env.MANDATORY_SUITES_CORE;

  await new Promise<void>((resolve, reject) => {
    try {
      const runner = mocha.run((failures: number) => {
        const executedSuites = Array.from(executedSuitesSet).sort();
        const missingMandatorySuites = resolveMissingMandatorySuites(executedSuites, mandatoryRaw);

        writeSuiteExecutionReport(process.env.SUITE_REPORT_PATH_CORE, {
          job: 'core',
          discoveredSuites,
          executedSuites,
          mandatorySuites: mandatoryRaw ? mandatoryRaw.split(',').map((entry) => entry.trim()).filter(Boolean) : [],
          missingMandatorySuites,
          testStats: {
            passes: runner.stats?.passes ?? 0,
            failures: runner.stats?.failures ?? failures,
            pending: runner.stats?.pending ?? 0,
            total: runner.stats?.tests ?? 0,
          },
        });

        if (missingMandatorySuites.length > 0) {
          reject(
            new Error(
              `Mandatory core suite(s) did not execute: ${missingMandatorySuites.join(', ')}`
            )
          );
          return;
        }

        if (failures > 0) {
          reject(new Error(`${failures} core test(s) failed.`));
          return;
        }
        resolve();
      });

      runner.on('pass', (test) => {
        if (test.file) {
          executedSuitesSet.add(path.relative(testsRoot, test.file).replace(/\\/g, '/'));
        }
      });
      runner.on('fail', (test) => {
        if (test.file) {
          executedSuitesSet.add(path.relative(testsRoot, test.file).replace(/\\/g, '/'));
        }
      });
      runner.on('pending', (test) => {
        if (test.file) {
          executedSuitesSet.add(path.relative(testsRoot, test.file).replace(/\\/g, '/'));
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}

main().catch((err) => {
  console.error('Core test run failed');
  console.error(err);
  process.exit(1);
});
