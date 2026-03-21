import * as path from 'path';
import * as vscode from 'vscode';
import Mocha from 'mocha';
import * as glob from 'glob';
import { writeArtifacts } from './smokeArtifacts';
import {
  resolveMissingMandatorySuites,
  writeSuiteExecutionReport,
} from '../suiteExecutionReport';

export function run(): Promise<void> {
  const mocha = new Mocha({
    ui: 'tdd',
    color: true,
  });

  const testsRoot = path.resolve(__dirname, '.');

  return new Promise((resolve, reject) => {
    const testFiles = glob.sync('**/*.test.js', { cwd: testsRoot });
    testFiles.forEach((file) => mocha.addFile(path.resolve(testsRoot, file)));
    const discoveredSuites = testFiles.map((file) => `suite/smoke/${file.replace(/\\/g, '/')}`).sort();
    const executedSuitesSet = new Set<string>();
    const mandatoryRaw = process.env.MANDATORY_SUITES_SMOKE;

    try {
      const runner = mocha.run((failures: number) => {
        writeArtifacts()
          .then(() => {
            const executedSuites = Array.from(executedSuitesSet).sort();
            const missingMandatorySuites = resolveMissingMandatorySuites(executedSuites, mandatoryRaw);

            writeSuiteExecutionReport(process.env.SUITE_REPORT_PATH_SMOKE, {
              job: 'smoke',
              discoveredSuites,
              executedSuites,
              mandatorySuites: mandatoryRaw
                ? mandatoryRaw.split(',').map((entry) => entry.trim()).filter(Boolean)
                : [],
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
                  `Mandatory smoke suite(s) did not execute: ${missingMandatorySuites.join(', ')}`
                )
              );
              return;
            }
            if (failures > 0) {
              reject(new Error(`${failures} smoke test(s) failed.`));
              return;
            }
            if (process.env.SMOKE_AWAIT_USER_CLOSE === '1') {
              void vscode.window.showInformationMessage(
                'Smoke finished. Close this window when done (e.g. to inspect or trigger errors).'
              );
              return;
            }
            resolve();
          })
          .catch((err) => {
            console.error('Failed to write smoke artifacts', err);
            if (failures > 0) reject(new Error(`${failures} smoke test(s) failed.`));
            else reject(err);
          });
      });
      runner.on('pass', (test) => {
        if (test.file) {
          const relative = path.relative(path.resolve(__dirname, '..', '..'), test.file).replace(/\\/g, '/');
          executedSuitesSet.add(relative);
        }
      });
      runner.on('fail', (test) => {
        if (test.file) {
          const relative = path.relative(path.resolve(__dirname, '..', '..'), test.file).replace(/\\/g, '/');
          executedSuitesSet.add(relative);
        }
      });
      runner.on('pending', (test) => {
        if (test.file) {
          const relative = path.relative(path.resolve(__dirname, '..', '..'), test.file).replace(/\\/g, '/');
          executedSuitesSet.add(relative);
        }
      });
    } catch (err) {
      console.error(err);
      reject(err);
    }
  });
}
