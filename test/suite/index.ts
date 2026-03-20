import * as path from 'path';
import Mocha from 'mocha';
import * as glob from 'glob';

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
  });

  const testsRoot = path.resolve(__dirname, '..');

  return new Promise((c, e) => {
    const testFiles = glob.sync('**/**.test.js', { cwd: testsRoot });

    testFiles.forEach((file) => mocha.addFile(path.resolve(testsRoot, file)));

    try {
      mocha.run((failures: number) => {
        if (failures > 0) {
          e(new Error(`${failures} tests failed.`));
        } else {
          c();
        }
      });
    } catch (err) {
      console.error(err);
      e(err);
    }
  });
}
