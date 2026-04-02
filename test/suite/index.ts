import * as path from 'path';
import Mocha from 'mocha';
import * as glob from 'glob';
import {
  resolveMissingMandatorySuites,
  writeSuiteExecutionReport,
} from './suiteExecutionReport';

/**
 * In Electron's extension host, `global` (Node CJS) and `globalThis` can differ.
 * Mocha's built-in loadFiles() emits pre-require on Node `global`, but when
 * require() executes a test file, unqualified identifiers like `suite` and `test`
 * are resolved from the module scope chain, which uses `globalThis` in Electron.
 * This patch replaces loadFiles so that pre-require events fire on `globalThis`,
 * ensuring TDD globals are visible inside every loaded test module.
 */
(Mocha.prototype as any).loadFiles = function (fn?: () => void) {
  const self = this;
  const suite = (this as any).suite;
  const EVENT_FILE_PRE_REQUIRE = require('mocha/lib/suite').constants.EVENT_FILE_PRE_REQUIRE;
  const EVENT_FILE_REQUIRE = require('mocha/lib/suite').constants.EVENT_FILE_REQUIRE;
  const EVENT_FILE_POST_REQUIRE = require('mocha/lib/suite').constants.EVENT_FILE_POST_REQUIRE;

  this.files.forEach((file: string) => {
    file = path.resolve(file);
    suite.emit(EVENT_FILE_PRE_REQUIRE, globalThis, file, self);
    suite.emit(EVENT_FILE_REQUIRE, require(file), file, self);
    suite.emit(EVENT_FILE_POST_REQUIRE, globalThis, file, self);
  });
  fn && fn();
};

export function run(): Promise<void> {
  const mocha = new Mocha({
    ui: 'tdd',
    color: true,
    timeout: 10000,
  });

  const testsRoot = path.resolve(__dirname, '..');

  // Core-only tests use vscode module stub and hang in real VS Code host.
  // Exclude them — they run via runCore.ts instead.
  // Keep mandatory VSCode suites even if they appear in coreSuites.
  const { coreSuiteFiles } = require('./coreSuites');
  const mandatoryRaw = process.env.MANDATORY_SUITES_VSCODE ?? '';
  const mandatory = new Set<string>(mandatoryRaw.split(',').map((s: string) => s.trim()).filter(Boolean));
  const coreOnly = new Set<string>(
    (coreSuiteFiles as string[])
      .map((f: string) => f.replace(/\\/g, '/'))
      .filter((f: string) => !mandatory.has(f)),
  );

  return new Promise((c, e) => {
    const testFiles = glob.sync('**/**.test.js', {
      cwd: testsRoot,
      ignore: ['suite/smoke/**', '**/smoke/**'],
    }).filter((f) => !coreOnly.has(f.replace(/\\/g, '/')));

    testFiles.forEach((file) => mocha.addFile(path.resolve(testsRoot, file)));
    const discoveredSuites = testFiles.map((file) => file.replace(/\\/g, '/')).sort();
    const executedSuitesSet = new Set<string>();
    const mandatoryRaw = process.env.MANDATORY_SUITES_VSCODE;

    try {
      const runner = mocha.run((failures: number) => {
        const executedSuites = Array.from(executedSuitesSet).sort();
        const missingMandatorySuites = resolveMissingMandatorySuites(executedSuites, mandatoryRaw);

        writeSuiteExecutionReport(process.env.SUITE_REPORT_PATH_VSCODE, {
          job: 'vscode',
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
          e(new Error(`Mandatory VSCode suite(s) did not execute: ${missingMandatorySuites.join(', ')}`));
          return;
        }
        if (failures > 0) {
          e(new Error(`${failures} tests failed.`));
        } else {
          c();
        }
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
      console.error(err);
      e(err);
    }
  });
}
